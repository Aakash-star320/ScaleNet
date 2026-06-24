const { spawn, spawnSync } = require('child_process');
const path = require('path');
const axios = require('axios');

const root = __dirname;
const trafficScript = process.argv[2] || 'autoscaler-demo-traffic.js';
const children = [];
let shuttingDown = false;

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false
  });
}

function removeContainers(filters) {
  for (const filter of filters) {
    const listed = docker(['ps', '-aq', '--filter', filter], { capture: true });
    if (listed.status !== 0) continue;
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) docker(['rm', '-f', ...ids]);
  }
}

function runStep(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function startNode(script, env = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.once('exit', code => {
    if (!shuttingDown && code !== 0) shutdown(`Service ${script} exited with code ${code}`);
  });
  return child;
}

async function waitFor(url, predicate = () => true, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await axios.get(url, { timeout: 1500 });
      if (predicate(response.data)) return response.data;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function openDashboard(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const opener = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  opener.unref();
}

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Demo] Stopping: ${reason}`);
  for (const child of children.reverse()) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => {
    removeContainers(['label=scalenet.managed=true']);
    process.exit(exitCode);
  }, 1200);
}

async function main() {
  console.log('[Demo] Cleaning previous ScaleNet worker containers...');
  removeContainers(['label=scalenet.managed=true', 'ancestor=scalenet-worker']);

  console.log('[Demo] Building scalenet-worker image...');
  try {
    await runStep('docker', ['build', '-t', 'scalenet-worker', '.'], path.join(root, 'worker'));
  } catch (err) {
    console.warn('[Demo] Cached build failed; retrying once without cache...');
    await runStep('docker', ['build', '--no-cache', '-t', 'scalenet-worker', '.'], path.join(root, 'worker'));
  }

  console.log('[Demo] Starting load balancer...');
  startNode(path.join('load-balancer', 'index.js'));
  await waitFor('http://localhost:3000/health');

  console.log('[Demo] Starting worker manager and dashboard...');
  startNode(path.join('worker-manager', 'service.js'), {
    AUTOSCALER_COOLDOWN_MS: '30000'
  });
  await waitFor('http://localhost:3001/api/state', state => state.workers?.length >= 3, 90000);

  const dashboardUrl = 'http://localhost:3001';
  console.log(`[Demo] Dashboard ready: ${dashboardUrl}`);
  if (process.env.DEMO_NO_OPEN !== '1') openDashboard(dashboardUrl);

  console.log(`[Demo] Starting continuous workload: ${trafficScript}`);
  startNode(trafficScript);
  console.log('[Demo] Everything is running. Press Ctrl+C once to stop and clean up.');
}

process.on('SIGINT', () => shutdown('Ctrl+C received'));
process.on('SIGTERM', () => shutdown('termination requested'));

main().catch(err => {
  console.error('[Demo] Startup failed:', err.message);
  shutdown('startup failure', 1);
});

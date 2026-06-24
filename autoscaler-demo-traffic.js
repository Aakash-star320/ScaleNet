const axios = require('axios');

const LB_URL = process.env.LB_URL || 'http://localhost:3000';
const HIGH_LOAD_MS = Number(process.env.DEMO_HIGH_LOAD_MS) || 60000;
const IDLE_MS = Number(process.env.DEMO_IDLE_MS) || 120000;
const COMPUTE_RPS = Number(process.env.DEMO_COMPUTE_RPS) || 3;

let sequence = 0;
let sent = 0;
let completed = 0;
let failed = 0;
let phase = 'starting';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendComputeRequest() {
  const id = `autoscaler-demo-${Date.now()}-${++sequence}`;
  sent++;
  try {
    await axios.post(`${LB_URL}/task`, {
      id,
      type: 'compute',
      complexity: 10
    }, { timeout: 15000 });
    completed++;
  } catch {
    failed++;
  }
}

setInterval(() => {
  console.log(`[Traffic] phase=${phase} sent=${sent} completed=${completed} failed=${failed}`);
}, 10000);

async function run() {
  console.log('[Traffic] Continuous autoscaler test started. Press Ctrl+C to stop.');
  console.log(`[Traffic] Repeating ${HIGH_LOAD_MS / 1000}s compute burst, then ${IDLE_MS / 1000}s idle.`);

  while (true) {
    phase = 'compute-burst';
    console.log('[Traffic] HIGH LOAD: compute traffic should force new containers to spawn.');
    const interval = setInterval(sendComputeRequest, 1000 / COMPUTE_RPS);
    await sleep(HIGH_LOAD_MS);
    clearInterval(interval);

    phase = 'idle';
    console.log('[Traffic] IDLE: outstanding requests will finish, then excess containers can drain and stop.');
    await sleep(IDLE_MS);
  }
}

run().catch(err => {
  console.error('[Traffic] Fatal error:', err.message);
  process.exitCode = 1;
});


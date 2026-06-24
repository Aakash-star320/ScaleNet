const axios = require('axios');

const LB_URL = process.env.LB_URL || 'http://localhost:3000';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
const HIGH_LOAD_MS = Number(process.env.INTERACTIVE_TEST_HIGH_MS) || 60000;
const IDLE_MS = Number(process.env.INTERACTIVE_TEST_IDLE_MS) || 120000;
const REQUESTS_PER_SECOND = Number(process.env.INTERACTIVE_TEST_RPS) || 70;

let sequence = 0;
let phase = 'starting';
let sent = 0;
let completed = 0;
let failed = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendRequest() {
  sent++;
  try {
    await axios.post(`${LB_URL}/task`, {
      id: `interactive-autoscaler-${Date.now()}-${++sequence}`,
      type: 'interactive'
    }, { timeout: 5000 });
    completed++;
  } catch {
    failed++;
  }
}

async function report() {
  try {
    const { data } = await axios.get(`${DASHBOARD_URL}/api/state`, { timeout: 2000 });
    const pool = data.pools.interactive;
    console.log(`[Interactive Test] phase=${phase} workers=${pool.workerCount} utilization=${Math.round(pool.connectionUtilization * 100)}% queue=${pool.queueDepth} sent=${sent} completed=${completed} failed=${failed}`);
  } catch (err) {
    console.log(`[Interactive Test] dashboard unavailable: ${err.message}`);
  }
}

setInterval(report, 10000);

async function run() {
  console.log('[Interactive Test] Continuous interactive autoscaler test started.');
  console.log(`[Interactive Test] ${HIGH_LOAD_MS / 1000}s high load followed by ${IDLE_MS / 1000}s idle; repeats until Ctrl+C.`);

  while (true) {
    phase = 'high-load';
    console.log('[Interactive Test] HIGH LOAD: interactive workers should scale up.');
    const traffic = setInterval(sendRequest, 1000 / REQUESTS_PER_SECOND);
    await sleep(HIGH_LOAD_MS);
    clearInterval(traffic);

    phase = 'idle';
    console.log('[Interactive Test] IDLE: excess interactive workers should drain and scale down.');
    await sleep(IDLE_MS);
  }
}

run().catch(err => {
  console.error('[Interactive Test] Fatal error:', err.message);
  process.exitCode = 1;
});


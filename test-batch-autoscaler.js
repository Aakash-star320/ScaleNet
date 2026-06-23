const axios = require('axios');

const LB_URL = process.env.LB_URL || 'http://localhost:3000';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
const HIGH_LOAD_MS = Number(process.env.BATCH_TEST_HIGH_MS) || 60000;
const IDLE_MS = Number(process.env.BATCH_TEST_IDLE_MS) || 120000;
const REQUESTS_PER_SECOND = Number(process.env.BATCH_TEST_RPS) || 30;

let sequence = 0;
let phase = 'starting';
let sent = 0;
let accepted = 0;
let failed = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendRequest() {
  sent++;
  try {
    await axios.post(`${LB_URL}/task`, {
      id: `batch-autoscaler-${Date.now()}-${++sequence}`,
      type: 'batch'
    }, { timeout: 10000 });
    accepted++;
  } catch {
    failed++;
  }
}

async function report() {
  try {
    const { data } = await axios.get(`${DASHBOARD_URL}/api/state`, { timeout: 2000 });
    const pool = data.pools.batch;
    console.log(`[Batch Test] phase=${phase} workers=${pool.workerCount} schedulerQueue=${pool.queueDepth} buffered=${pool.bufferedRequests} processing=${pool.processingRequests} outstanding=${pool.totalOutstandingRequests} sent=${sent} accepted=${accepted} failed=${failed}`);
  } catch (err) {
    console.log(`[Batch Test] dashboard unavailable: ${err.message}`);
  }
}

setInterval(report, 10000);

async function run() {
  console.log('[Batch Test] Continuous batch autoscaler test started.');
  console.log(`[Batch Test] ${HIGH_LOAD_MS / 1000}s high load followed by ${IDLE_MS / 1000}s idle; repeats until Ctrl+C.`);

  while (true) {
    phase = 'high-load';
    console.log('[Batch Test] HIGH LOAD: batch workers should scale up.');
    const traffic = setInterval(sendRequest, 1000 / REQUESTS_PER_SECOND);
    await sleep(HIGH_LOAD_MS);
    clearInterval(traffic);

    phase = 'idle';
    console.log('[Batch Test] IDLE: buffered work should finish, then excess batch workers should scale down.');
    await sleep(IDLE_MS);
  }
}

run().catch(err => {
  console.error('[Batch Test] Fatal error:', err.message);
  process.exitCode = 1;
});


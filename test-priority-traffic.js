const axios = require('axios');

// ─── Traffic goes to Priority Queue Service (port 3001), NOT directly to LB ──
const PQ_URL = 'http://localhost:3001';

const TARGET_RPS  = Number(process.argv[2]) || 10;
const MAX_REQUESTS = Number(process.argv[3]) || 60;

let completed = 0;
let errors = 0;
let generated = 0;

console.log(`\n🚦 Priority Queue Traffic Generator`);
console.log(`   Target  : ${PQ_URL}`);
console.log(`   RPS     : ${TARGET_RPS}`);
console.log(`   Total   : ${MAX_REQUESTS} requests`);
console.log(`   Command : node test-priority-traffic.js [RPS] [TOTAL]\n`);

const interval = setInterval(async () => {
  if (generated >= MAX_REQUESTS) {
    clearInterval(interval);
    return;
  }

  generated++;
  const id = `pq-${generated}`;

  // Generate a realistic mix of request types
  const rand = Math.random();
  let type, urgent, complexity;

  if (rand < 0.15) {
    // 15% — urgent interactive
    type = 'interactive';
    urgent = true;
    complexity = 1;
  } else if (rand < 0.35) {
    // 20% — normal interactive
    type = 'interactive';
    urgent = false;
    complexity = 1;
  } else if (rand < 0.55) {
    // 20% — compute
    type = 'compute';
    urgent = false;
    complexity = Math.floor(Math.random() * 5) + 1;
  } else if (rand < 0.90) {
    // 35% — batch
    type = 'batch';
    urgent = false;
    complexity = Math.floor(Math.random() * 3) + 1;
  } else {
    // 10% — malformed (missing type)
    type = undefined;
    urgent = false;
    complexity = 0;
  }

  const body = { id, type, urgent, complexity };

  try {
    const res = await axios.post(`${PQ_URL}/task`, body, { timeout: 5000 });
    completed++;
    const d = res.data;
    const pLabel = `P${d.priority}`;
    const typeStr = (type || 'unknown').padEnd(11);
    console.log(`✅ ${id.padEnd(8)} | ${typeStr} | ${pLabel} | Pos: ${d.position} | ${d.reason}`);
  } catch (err) {
    errors++;
    const reason = err.response?.data?.error || err.message;
    const typeStr = (type || 'unknown').padEnd(11);
    console.log(`❌ ${id.padEnd(8)} | ${typeStr} | REJECTED: ${reason}`);
  }

  if (completed + errors >= MAX_REQUESTS) {
    console.log(`\n🏁 Done. Accepted: ${completed} | Rejected: ${errors}`);

    // Print final stats
    try {
      const stats = await axios.get(`${PQ_URL}/queue/stats`);
      console.log('\n📊 Final Queue Stats:');
      console.log(JSON.stringify(stats.data, null, 2));
    } catch (e) {}

    process.exit(0);
  }
}, 1000 / TARGET_RPS);

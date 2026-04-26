const axios = require('axios');
const readline = require('readline');

const LB_URL = 'http://localhost:3000/status';
const QUEUE_URL = 'http://localhost:3000/queue';

async function drawDashboard() {
  try {
    const [statusRes, queueRes] = await Promise.all([
      axios.get(LB_URL),
      axios.get(QUEUE_URL)
    ]);

    const status = statusRes.data;
    const workerPools = queueRes.data.workerPools || {};

    console.clear();
    console.log('═══ ScaleNet Real-Time Health Dashboard ═══');
    console.log(`Time: ${new Date().toLocaleTimeString()}\n`);

    console.log('┌─────────────┬────────┬────────┬────────┬────────┬────────┐');
    console.log('│ Pool        │ Count  │ Active │ Idle   │ Queue  │ Util % │');
    console.log('├─────────────┼────────┼────────┼────────┼────────┼────────┤');

    for (const pool of ['interactive', 'compute', 'batch']) {
      const p = status[pool] || { workerCount: 0, activeWorkers: 0, idleWorkers: 0, queueDepth: 0 };
      const util = p.workerCount === 0 ? 0 : (p.activeWorkers / p.workerCount) * 100;
      
      const name = pool.padEnd(11);
      const count = p.workerCount.toString().padStart(6);
      const active = p.activeWorkers.toString().padStart(6);
      const idle = p.idleWorkers.toString().padStart(6);
      const queue = p.queueDepth.toString().padStart(6);
      const utilStr = util.toFixed(1).padStart(5) + '%';

      console.log(`│ ${name} │ ${count} │ ${active} │ ${idle} │ ${queue} │ ${utilStr} │`);
    }
    console.log('└─────────────┴────────┴────────┴────────┴────────┴────────┘');

    console.log('\n═══ Live Worker Registry ═══');
    for (const pool in workerPools) {
      console.log(`\n[${pool.toUpperCase()}]`);
      if (workerPools[pool].length === 0) console.log('  (No workers)');
      workerPools[pool].forEach(w => {
        const health = w.healthy ? '✅' : '❌';
        console.log(`  ${health} ${w.id.substring(0, 12)}... | Active: ${w.active} | Complexity: ${w.runningTotalComplexity || 0}`);
      });
    }

    console.log('\n(Press Ctrl+C to exit. Updates every 2s)');

  } catch (err) {
    console.log('❌ Dashboard Error: Could not connect to Load Balancer.');
    console.log(`   Message: ${err.message}`);
  }
}

setInterval(drawDashboard, 2000);
drawDashboard();

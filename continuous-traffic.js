const axios = require('axios');

const PQ_URL = 'http://localhost:3001';

console.log(`\n🚦 Continuous Traffic Generator`);
console.log(`   Target  : ${PQ_URL}`);
console.log(`   RPS will fluctuate every 5 seconds to simulate real-world spikes!`);
console.log(`   Press Ctrl+C to stop.\n`);

let generated = 0;
let currentRPS = 10;
let interval;

function startTraffic() {
  if (interval) clearInterval(interval);
  
  interval = setInterval(async () => {
    generated++;
    const id = `pq-${generated}`;

    // Generate a realistic mix of request types
    const rand = Math.random();
    let type, urgent, complexity;

    if (rand < 0.15) {
      type = 'interactive'; urgent = true; complexity = 1;
    } else if (rand < 0.35) {
      type = 'interactive'; urgent = false; complexity = 1;
    } else if (rand < 0.55) {
      type = 'compute'; urgent = false; complexity = Math.floor(Math.random() * 5) + 1;
    } else if (rand < 0.90) {
      type = 'batch'; urgent = false; complexity = Math.floor(Math.random() * 3) + 1;
    } else {
      type = undefined; urgent = false; complexity = 0;
    }

    const body = { id, type, urgent, complexity };

    try {
      await axios.post(`${PQ_URL}/task`, body, { timeout: 5000 });
      process.stdout.write('.'); // Print dot for success
    } catch (err) {
      process.stdout.write('x'); // Print x for dropped/rejected
    }
  }, 1000 / currentRPS);
}

// Change RPS every 8 seconds
setInterval(() => {
  // Random RPS between 2 and 35 to show Auto-Scaler reaction
  currentRPS = Math.floor(Math.random() * 33) + 2;
  console.log(`\n📈 Traffic shift: adjusting to ${currentRPS} RPS...`);
  startTraffic();
}, 8000);

// Start initial
startTraffic();

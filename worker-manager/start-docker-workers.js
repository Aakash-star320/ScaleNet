const { spawnWorker } = require('./index');

async function startAll() {
  console.log("=== Starting Docker Containers for ScaleNet ===\n");
  try {
    const [w1, w2, w3] = await Promise.all([
      spawnWorker('interactive', 'interactive-1'),
      spawnWorker('compute', 'compute-1'),
      spawnWorker('batch', 'batch-1')
    ]);
    
    console.log("\n✅ All 3 workers are now isolated inside Docker running locally!");
    console.log("Docker assigned a free host port to each worker.");
  } catch (err) {
    console.error("Failed to start workers:", err.message);
  }
}

startAll();

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../logs');
fs.mkdirSync(logDir, { recursive: true });

const POOL_LIMITS = {
    interactive: { min: 1, max: 5 },
    compute:     { min: 1, max: 4 },
    batch:       { min: 1, max: 3 }
};

const COOLDOWN_MS = 60000;
const AUTOSCALER_INTERVAL = 10000;
const EMERGENCY_UTILIZATION = 0.90;
const NORMAL_UTILIZATION = 0.70;
const SPAWN_TIMEOUT_MS = 30000;
const DRAIN_TIMEOUT_MS = 60000;
const HEALTH_POLL_INTERVAL_MS = 500;

const previousSnapshot = {
    interactive: { queueDepth: 0 },
    compute:     { queueDepth: 0 },
    batch:       { queueDepth: 0 }
};

const lastActionTime = {
    interactive: 0,
    compute:     0,
    batch:       0
};

// Track the workers we create: workerId -> mapped host port
const activeWorkers = new Map();

// Since you already have worker-1 (4001) and worker-2 (4002) running manually,
// we will start generating from worker-3 on port 4003.
let nextPort = 4001; 

/**
 * Spawns a new Docker container, then assumes heartbeat will handle registration
 */
async function spawnWorker(type = 'batch', workerIdStr = null, forcedPort = null) {
  const port = forcedPort || nextPort++;
  const workerId = workerIdStr || `${type}-${port}`;
  
  console.log(`[WorkerManager] Spawning ${workerId} on port ${port}...`);

  // We must pass LB_URL=http://host.docker.internal:3000 so the container can heartbeat back to the host!
  const cmd = `docker run -d --name ${workerId} -p ${port}:${port} -e PORT=${port} -e WORKER_ID=${workerId} -e WORKER_TYPE=${type} -e LB_URL=http://host.docker.internal:3000 scalenet-worker`;
  
  try {
    const { stdout, stderr } = await exec(cmd);
    
    // Save to our local tracker
    activeWorkers.set(workerId, { port, poolType: type, spawnedAt: Date.now() });
    console.log(`[WorkerManager] Container ${workerId} started (ID: ${stdout.trim().substring(0, 12)})`);

    // Poll /health to ensure worker is ready before returning
    console.log(`[WorkerManager] Waiting for ${workerId} to become healthy...`);
    const startTime = Date.now();
    let isHealthy = false;
    while (Date.now() - startTime < 30000) {
      try {
        const res = await axios.get(`http://localhost:${port}/health`);
        if (res.status === 200) {
          isHealthy = true;
          break;
        }
      } catch (err) {
        // Container still starting up
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!isHealthy) {
      console.error(`[WorkerManager] Health check timeout for ${workerId}. Destroying zombie container.`);
      activeWorkers.delete(workerId);
      await exec(`docker rm -f ${workerId}`).catch(() => {});
      throw new Error(`Health check timeout for ${workerId} after 30 seconds.`);
    }

    // No need to manually post to /register anymore! Heartbeat handles it!
    console.log(`[WorkerManager] ${workerId} is healthy! Relying on Heartbeat to register...`);
    
    return { workerId, port, poolType: type, status: 'spawned' };
  } catch (err) {
    console.error(`[WorkerManager] Failed to spawn ${workerId}:`, err.message);
    throw err;
  }
}

/**
 * Kills a Docker container, then deregisters it from the Load Balancer
 */
async function stopWorker(workerId) {
  if (!activeWorkers.has(workerId)) {
    throw new Error(`${workerId} is not tracked by WorkerManager.`);
  }

  const port = activeWorkers.get(workerId).port;
  console.log(`[WorkerManager] Draining and stopping ${workerId}...`);
  
  try {
    // 1. Send drain signal
    await axios.post(`http://localhost:${port}/drain`).catch(() => {});

    // 2. Poll for 60 seconds waiting for activeConnections to drop to 0
    let drainComplete = false;
    const startDrain = Date.now();
    
    while (Date.now() - startDrain < DRAIN_TIMEOUT_MS) {
      try {
        const healthRes = await axios.get(`http://localhost:${port}/health`);
        if (healthRes.data && healthRes.data.activeConnections === 0) {
          drainComplete = true;
          break;
        }
      } catch (e) {
        // if health fails during drain, consider it dead/drained
        drainComplete = true;
        break;
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    if (!drainComplete) {
      console.warn(`[WorkerManager] Drain timeout for ${workerId} exceeded 60s. Forcefully proceeding.`);
    }

    // 3. Unregister from load balancer
    await axios.delete(`http://localhost:3000/deregister/${workerId}`).catch(() => {});
    console.log(`[WorkerManager] Deregistered ${workerId} from Load Balancer.`);

    // 4. Destroy container and clear map
    await exec(`docker rm -f ${workerId}`);
    activeWorkers.delete(workerId);
    console.log(`[WorkerManager] Container ${workerId} destroyed.`);

    return { workerId, status: 'stopped' };
  } catch (err) {
    console.error(`[WorkerManager] Failed to stop ${workerId}:`, err.message);
    throw err;
  }
}

/**
 * Simply returns the list of workers this manager has spawned
 */
function getActiveWorkers() {
  return Array.from(activeWorkers.entries()).map(([id, data]) => ({ id, ...data }));
}

function getWorkerCountByPool() {
  const counts = { interactive: 0, compute: 0, batch: 0 };
  for (const data of activeWorkers.values()) {
    if (counts[data.poolType] !== undefined) {
      counts[data.poolType]++;
    }
  }
  return counts;
}

/**
 * Find the least busy worker in a given pool by querying the LB's live state.
 * Uses GET /queue (which returns getStatus()) for per-worker activeConnections.
 * 
 * @param {string} poolType - 'interactive' | 'compute' | 'batch'
 * @returns {Promise<string|null>} workerId with the fewest active connections, or null
 */
async function getLeastBusyWorker(poolType) {
  // Workers this manager is tracking for this pool
  const managedIds = new Set(
    Array.from(activeWorkers.entries())
      .filter(([, data]) => data.poolType === poolType)
      .map(([id]) => id)
  );

  if (managedIds.size === 0) return null;

  try {
    const res = await axios.get('http://localhost:3000/queue');
    const workerList = res.data?.workerPools?.[poolType] || [];

    let leastBusyId = null;
    let lowestActive = Infinity;

    for (const w of workerList) {
      // Only consider workers this manager spawned
      if (!managedIds.has(w.id)) continue;

      // Compute pool: weight by runningTotalComplexity (a worker with 1 task at
      // complexity 9 is busier than one with 2 tasks at complexity 1 each).
      // Interactive/Batch: raw activeConnections is sufficient — requests are uniform.
      const load = poolType === 'compute'
        ? (w.runningTotalComplexity ?? w.active)
        : w.active;

      if (load < lowestActive) {
        lowestActive = load;
        leastBusyId = w.id;
      }
    }

    // Fallback: if LB doesn't know about our workers yet, return first tracked one
    return leastBusyId || [...managedIds][0];
  } catch (err) {
    console.error(`[WorkerManager] getLeastBusyWorker failed to reach LB: ${err.message}`);
    // Safe fallback — just return first worker in the pool
    return [...managedIds][0] || null;
  }
}

function logDecision(pool, action, reason, workersBefore, workersAfter, trigger) {
  const logObject = {
      timestamp: Date.now(),
      pool,
      action,
      reason,
      workersBefore,
      workersAfter,
      trigger
  };
  
  const logFile = path.join(logDir, 'scaling_decisions.jsonl');
  fs.appendFileSync(logFile, JSON.stringify(logObject) + '\n');
}

// ─── Autoscaler Loop ───────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const statusRes = await axios.get('http://localhost:3000/status');
    const aggregatedStatus = statusRes.data;
    const currentWorkerCounts = getWorkerCountByPool();

    for (const pool of ['interactive', 'compute', 'batch']) {
      const status = aggregatedStatus[pool];
      if (!status) continue;

      // Use the LB's total worker count for utilization calculation so we 
      // account for any static/pre-existing workers.
      const totalWorkers = status.workerCount;
      const utilization = totalWorkers === 0 ? 0 : status.activeWorkers / totalWorkers;
      const queueGrowing = status.queueDepth > previousSnapshot[pool].queueDepth;
      
      // ─── Floor Check ───
      // If we are below the minimum required workers, spawn one immediately.
      if (totalWorkers < POOL_LIMITS[pool].min) {
        try {
          console.log(`[Autoscaler] Floor check triggered for ${pool}: ${totalWorkers}/${POOL_LIMITS[pool].min}`);
          await spawnWorker(pool);
          lastActionTime[pool] = Date.now();
          logDecision(pool, 'scale-up', 'Floor Check: below minimum', totalWorkers, totalWorkers + 1, 'min-floor');
        } catch (err) {
          console.error(`[Autoscaler] Floor spawn failed for ${pool}:`, err.message);
        }
        previousSnapshot[pool].queueDepth = status.queueDepth;
        continue;
      }

      const managedWorkerCount = currentWorkerCounts[pool];

      // ─── Emergency Scale Up ───
      // Bypasses cooldown — act immediately when critically overloaded
      if (utilization > EMERGENCY_UTILIZATION && queueGrowing && totalWorkers < POOL_LIMITS[pool].max) {
        const workersBefore = totalWorkers;
        try {
          await spawnWorker(pool);
          lastActionTime[pool] = Date.now();
          logDecision(pool, 'scale-up', 'Emergency: utilization critical', workersBefore, workersBefore + 1, 'emergency-utilization');
        } catch (err) {
          console.error(`[Autoscaler] Emergency spawn failed for ${pool}:`, err.message);
        }
        previousSnapshot[pool].queueDepth = status.queueDepth;
        continue;
      }

      // ─── Cooldown Gate ───
      // If we acted on this pool recently, skip — the spawn hasn't had time to affect utilization yet
      if (Date.now() - lastActionTime[pool] < COOLDOWN_MS) {
        previousSnapshot[pool].queueDepth = status.queueDepth;
        continue;
      }

      // ─── Normal Scale Up ───
      if (utilization > NORMAL_UTILIZATION && queueGrowing && totalWorkers < POOL_LIMITS[pool].max) {
        const workersBefore = totalWorkers;
        try {
          await spawnWorker(pool);
          lastActionTime[pool] = Date.now();
          logDecision(pool, 'scale-up', 'Normal: utilization high', workersBefore, workersBefore + 1, 'normal-utilization');
        } catch (err) {
          console.error(`[Autoscaler] Normal spawn failed for ${pool}:`, err.message);
        }
      } 
      // ─── Normal Scale Down ───
      else if (status.queueDepth === 0 && status.idleWorkers > 1 && totalWorkers > POOL_LIMITS[pool].min) {
        const workersBefore = totalWorkers;
        try {
          const targetId = await getLeastBusyWorker(pool);
          if (targetId) {
            await stopWorker(targetId);
            lastActionTime[pool] = Date.now();
            logDecision(pool, 'scale-down', 'Normal: excess idle workers', workersBefore, workersBefore - 1, 'idle-excess');
          }
        } catch (err) {
          console.error(`[Autoscaler] Scale down failed for ${pool}:`, err.message);
        }
      }
      
      previousSnapshot[pool].queueDepth = status.queueDepth;
    }
  } catch (err) {
    console.error('[Autoscaler] Loop error:', err.message);
  }
}, AUTOSCALER_INTERVAL);

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log('🚀 ScaleNet Worker Manager & Autoscaler started.');
console.log(`[Config] Interval: ${AUTOSCALER_INTERVAL}ms, Cooldown: ${COOLDOWN_MS}ms`);
console.log('[Status] Monitoring interactive, compute, and batch pools...');

module.exports = { spawnWorker, stopWorker, getActiveWorkers, getWorkerCountByPool, getLeastBusyWorker, logDecision };

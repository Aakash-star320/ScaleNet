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

const COOLDOWN_MS = Number(process.env.AUTOSCALER_COOLDOWN_MS) || 60000;
const AUTOSCALER_INTERVAL = Number(process.env.AUTOSCALER_INTERVAL_MS) || 10000;
const EMERGENCY_UTILIZATION = 0.90;
const NORMAL_UTILIZATION = 0.70;
const SPAWN_TIMEOUT_MS = 30000;
const DRAIN_TIMEOUT_MS = 60000;
const HEALTH_POLL_INTERVAL_MS = 500;
const CONTAINER_PORT = 4001;

const previousSnapshot = {
    interactive: { workload: 0 },
    compute:     { workload: 0 },
    batch:       { workload: 0 }
};

const lastActionTime = {
    interactive: 0,
    compute:     0,
    batch:       0
};

const operationInProgress = {
    interactive: false,
    compute:     false,
    batch:       false
};

// Track the workers we create: workerId -> mapped host port
const activeWorkers = new Map();
let workerSequence = 0;

async function getPublishedPort(workerId) {
  const { stdout } = await exec(`docker port ${workerId} ${CONTAINER_PORT}/tcp`);
  const firstMapping = stdout.trim().split(/\r?\n/)[0];
  const match = firstMapping && firstMapping.match(/:(\d+)$/);
  if (!match) throw new Error(`Could not determine Docker host port for ${workerId}.`);
  return Number(match[1]);
}

/**
 * Spawns a new Docker container, then assumes heartbeat will handle registration
 */
async function spawnWorker(type = 'batch', workerIdStr = null) {
  if (operationInProgress[type]) {
    throw new Error(`A scaling operation is already running for the ${type} pool.`);
  }

  operationInProgress[type] = true;
  let port = null;
  const workerId = workerIdStr || `${type}-${Date.now()}-${++workerSequence}`;
  let containerStarted = false;

  try {
    console.log(`[WorkerManager] Spawning ${workerId} with a Docker-assigned host port...`);
    const cmd = `docker run -d --name ${workerId} --label scalenet.managed=true -p 127.0.0.1::${CONTAINER_PORT} -e PORT=${CONTAINER_PORT} -e WORKER_ID=${workerId} -e WORKER_TYPE=${type} -e MANAGED_WORKER=true -e LB_URL=http://host.docker.internal:3000 scalenet-worker`;
    const { stdout } = await exec(cmd);
    containerStarted = true;
    port = await getPublishedPort(workerId);
    
    // Save to our local tracker
    activeWorkers.set(workerId, { port, poolType: type, spawnedAt: Date.now() });
    console.log(`[WorkerManager] Container ${workerId} started (ID: ${stdout.trim().substring(0, 12)})`);

    console.log(`[WorkerManager] Docker mapped ${workerId}:${CONTAINER_PORT} to localhost:${port}`);
    console.log(`[WorkerManager] Waiting for ${workerId} to become healthy...`);
    const startTime = Date.now();
    let isHealthy = false;
    while (Date.now() - startTime < SPAWN_TIMEOUT_MS) {
      try {
        const healthRes = await axios.get(`http://localhost:${port}/health`);
        if (healthRes.status === 200) {
          isHealthy = true;
          break;
        }
      } catch (err) {
        // Container or scheduler registration is still starting up.
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    if (!isHealthy) {
      throw new Error(`Startup timeout for ${workerId} after ${SPAWN_TIMEOUT_MS}ms.`);
    }

    await axios.post('http://localhost:3000/register', {
      id: workerId,
      url: `http://localhost:${port}`,
      type,
      capacity: type === 'compute' ? 2 : 5
    });

    const schedulerRes = await axios.get('http://localhost:3000/queue');
    const registeredWorker = schedulerRes.data?.workerPools?.[type]
      ?.find(worker => worker.id === workerId && worker.healthy && !worker.draining);
    if (!registeredWorker) {
      throw new Error(`Scheduler registration failed for ${workerId}.`);
    }

    lastActionTime[type] = Date.now();
    console.log(`[WorkerManager] ${workerId} is healthy and registered.`);
    
    return { workerId, port, poolType: type, status: 'spawned' };
  } catch (err) {
    activeWorkers.delete(workerId);
    if (containerStarted) {
      await exec(`docker rm -f ${workerId}`).catch(() => {});
    }
    console.error(`[WorkerManager] Failed to spawn ${workerId}:`, err.message);
    throw err;
  } finally {
    operationInProgress[type] = false;
  }
}

/**
 * Kills a Docker container, then deregisters it from the Load Balancer
 */
async function stopWorker(workerId) {
  if (!activeWorkers.has(workerId)) {
    throw new Error(`${workerId} is not tracked by WorkerManager.`);
  }

  const workerData = activeWorkers.get(workerId);
  const { port, poolType } = workerData;
  if (operationInProgress[poolType]) {
    throw new Error(`A scaling operation is already running for the ${poolType} pool.`);
  }

  operationInProgress[poolType] = true;
  console.log(`[WorkerManager] Draining and stopping ${workerId}...`);
  
  try {
    // 1. Remove from scheduler eligibility before telling the worker to drain.
    await axios.post(`http://localhost:3000/workers/${workerId}/drain`);
    await axios.post(`http://localhost:${port}/drain`);

    // 2. Poll for 60 seconds waiting for activeConnections to drop to 0
    let drainComplete = false;
    const startDrain = Date.now();
    
    while (Date.now() - startDrain < DRAIN_TIMEOUT_MS) {
      try {
        const healthRes = await axios.get(`http://localhost:${port}/health`);
        const health = healthRes.data;
        const noActiveRequests = health && health.activeConnections === 0;
        const noBufferedBatchWork = poolType !== 'batch' || (
          health.bufferSize === 0 && health.processingCount === 0
        );
        if (noActiveRequests && noBufferedBatchWork) {
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
    lastActionTime[poolType] = Date.now();
    console.log(`[WorkerManager] Container ${workerId} destroyed.`);

    return { workerId, status: 'stopped' };
  } catch (err) {
    console.error(`[WorkerManager] Failed to stop ${workerId}:`, err.message);
    throw err;
  } finally {
    operationInProgress[poolType] = false;
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

function getAutoscalerState() {
  const now = Date.now();
  const pools = {};
  for (const pool of ['interactive', 'compute', 'batch']) {
    pools[pool] = {
      limits: POOL_LIMITS[pool],
      operationInProgress: operationInProgress[pool],
      lastActionTime: lastActionTime[pool],
      cooldownRemainingMs: Math.max(0, COOLDOWN_MS - (now - lastActionTime[pool]))
    };
  }

  return {
    intervalMs: AUTOSCALER_INTERVAL,
    cooldownMs: COOLDOWN_MS,
    normalUtilization: NORMAL_UTILIZATION,
    emergencyUtilization: EMERGENCY_UTILIZATION,
    pools
  };
}

async function getLeastBusyWorker(poolType) {
  const managedIds = new Set(
    Array.from(activeWorkers.entries())
      .filter(([, data]) => data.poolType === poolType)
      .map(([id]) => id)
  );

  if (managedIds.size === 0) return null;

  const res = await axios.get('http://localhost:3000/queue');
  const workers = res.data?.workerPools?.[poolType] || [];
  let selected = null;
  let lowestLoad = Infinity;

  for (const worker of workers) {
    if (!managedIds.has(worker.id) || !worker.healthy || worker.draining) continue;

    const load = poolType === 'compute'
      ? worker.runningTotalComplexity
      : poolType === 'batch'
        ? worker.bufferSize + worker.processingCount
        : worker.active;
    if (load < lowestLoad) {
      lowestLoad = load;
      selected = worker.id;
    }
  }

  return selected;
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

    for (const pool of ['interactive', 'compute', 'batch']) {
      const status = aggregatedStatus[pool];
      if (!status) continue;

      const workerCount = status.workerCount;
      const workload = pool === 'batch'
        ? status.totalOutstandingRequests
        : status.queueDepth;
      const utilization = pool === 'batch'
        ? (workerCount === 0 ? 0 : Math.min(1, workload / (workerCount * 50)))
        : status.connectionUtilization;
      const workloadGrowing = workload > previousSnapshot[pool].workload;
      
      // ─── Emergency Check ───

      // ─── Normal Scale Up/Down ───
      
      if (operationInProgress[pool]) {
        previousSnapshot[pool].workload = workload;
        continue;
      }

      if (workerCount < POOL_LIMITS[pool].min) {
        try {
          await spawnWorker(pool);
          logDecision(pool, 'SCALE_UP', 'Below minimum worker count', workerCount, workerCount + 1, 'min-floor');
        } catch (err) {
          console.error(`[Autoscaler] Floor spawn failed for ${pool}:`, err.message);
        }
        previousSnapshot[pool].workload = workload;
        continue;
      }

      const emergency = utilization >= EMERGENCY_UTILIZATION || (workload > 15 && workloadGrowing);
      if (emergency && workerCount < POOL_LIMITS[pool].max) {
        try {
          await spawnWorker(pool);
          logDecision(pool, 'SCALE_UP_EMERGENCY', 'Critical utilization or growing workload', workerCount, workerCount + 1, 'emergency');
        } catch (err) {
          console.error(`[Autoscaler] Emergency spawn failed for ${pool}:`, err.message);
        }
        previousSnapshot[pool].workload = workload;
        continue;
      }

      if (Date.now() - lastActionTime[pool] < COOLDOWN_MS) {
        previousSnapshot[pool].workload = workload;
        continue;
      }

      const normalScaleUp = pool === 'compute'
        ? utilization >= NORMAL_UTILIZATION && workload > 0 && workload >= previousSnapshot[pool].workload
        : utilization >= NORMAL_UTILIZATION || (workload > 0 && workloadGrowing);
      const projectedBatchUtilization = pool === 'batch' && workerCount > 1
        ? Math.min(1, workload / ((workerCount - 1) * 50))
        : 1;
      const normalScaleDown = pool === 'batch'
        ? status.queueDepth === 0 && !workloadGrowing && projectedBatchUtilization < 0.50 && workerCount > POOL_LIMITS[pool].min
        : utilization < 0.30 && workload === 0 && workerCount > POOL_LIMITS[pool].min;

      if (normalScaleUp && workerCount < POOL_LIMITS[pool].max) {
        try {
          await spawnWorker(pool);
          logDecision(pool, 'SCALE_UP', 'High utilization or growing workload', workerCount, workerCount + 1, 'normal');
        } catch (err) {
          console.error(`[Autoscaler] Normal spawn failed for ${pool}:`, err.message);
        }
      } else if (normalScaleDown) {
        try {
          const targetId = await getLeastBusyWorker(pool);
          if (targetId) {
            await stopWorker(targetId);
            const reason = pool === 'batch'
              ? `Projected utilization ${(projectedBatchUtilization * 100).toFixed(1)}% after removal`
              : 'Low utilization with no outstanding work';
            logDecision(pool, 'SCALE_DOWN', reason, workerCount, workerCount - 1, 'idle-excess');
          }
        } catch (err) {
          console.error(`[Autoscaler] Scale down failed for ${pool}:`, err.message);
        }
      }

      previousSnapshot[pool].workload = workload;
    }
  } catch (err) {
    console.error(`[Autoscaler] Skipping cycle, failed to read status: ${err.message}`);
  }
}, AUTOSCALER_INTERVAL);

module.exports = {
  spawnWorker,
  stopWorker,
  getActiveWorkers,
  getWorkerCountByPool,
  getAutoscalerState,
  getLeastBusyWorker,
  logDecision
};

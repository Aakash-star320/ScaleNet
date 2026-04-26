const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Constants & Structures ──────────────────────────────────────────
const MAX_QUEUE_SIZES = {
  interactive: 50,
  compute: 100,
  batch: 500
};
const TASK_TIMEOUT_MS = 8000;

// ─── Metrics State (5-second snapshot) ───────────────────────────────────
let intervalMetrics = {
  interactive: { receivedThisInterval: 0, droppedByAdmission: 0, rejectedByWorkers: 0, completed: 0, totalLatency: 0 },
  compute: { receivedThisInterval: 0, droppedByAdmission: 0, rejectedByWorkers: 0, completed: 0, totalLatency: 0 },
  batch: { receivedThisInterval: 0, droppedByAdmission: 0, rejectedByWorkers: 0, completed: 0, totalLatency: 0 },
  system: { totalReceivedThisInterval: 0, totalDroppedThisInterval: 0 }
};

let lifetimeMetrics = {
  totalReceived: 0,
  totalDropped: 0
};

let metricsSnapshot = { timestamp: Date.now() }; // Initialize blank

setInterval(() => {
  const iRatio = pools.interactive.queueDepth / MAX_QUEUE_SIZES.interactive;
  const cRatio = pools.compute.queueDepth / MAX_QUEUE_SIZES.compute;
  const bRatio = pools.batch.queueDepth / MAX_QUEUE_SIZES.batch;
  const weightedPressure = ((iRatio * 3) + (cRatio * 2) + (bRatio * 1)) / 6;

  const buildPoolMetrics = (type, ratio) => {
    let activeWorkers = 0;
    let idleWorkers = 0;
    for (const w of pools[type].workerMap.values()) {
       if (w.healthy) {
           activeWorkers += w.activeConnections > 0 ? 1 : 0;
           idleWorkers += w.activeConnections === 0 ? 1 : 0;
       }
    }
    const internal = intervalMetrics[type];
    const snap = {
        queueDepth: pools[type].queueDepth,
        activeWorkers,
        idleWorkers,
        receivedThisInterval: internal.receivedThisInterval,
        droppedByAdmission: internal.droppedByAdmission,
        rejectedByWorkers: internal.rejectedByWorkers,
        pressure: parseFloat(ratio.toFixed(2))
    };
    if (type !== 'batch') {
        snap.avgLatency = internal.completed > 0 ? Math.round(internal.totalLatency / internal.completed) : 0;
    }
    return snap;
  };

  metricsSnapshot = {
     timestamp: Date.now(),
     interactive: buildPoolMetrics('interactive', iRatio),
     compute: buildPoolMetrics('compute', cRatio),
     batch: buildPoolMetrics('batch', bRatio),
     system: {
        totalReceivedThisInterval: intervalMetrics.system.totalReceivedThisInterval,
        totalDroppedThisInterval: intervalMetrics.system.totalDroppedThisInterval,
        lifetimeReceived: lifetimeMetrics.totalReceived,
        lifetimeDropped: lifetimeMetrics.totalDropped,
        weightedPressure: parseFloat(weightedPressure.toFixed(2))
     }
  };

  for (const type of ['interactive', 'compute', 'batch']) {
     intervalMetrics[type] = { receivedThisInterval: 0, droppedByAdmission: 0, rejectedByWorkers: 0, completed: 0, totalLatency: 0 };
  }
  intervalMetrics.system = { totalReceivedThisInterval: 0, totalDroppedThisInterval: 0 };

  const logFile = path.join(__dirname, '../logs/metrics.jsonl');
  fs.appendFile(logFile, JSON.stringify(metricsSnapshot) + '\n', (err) => {
      if (err) console.error('[Scheduler] Failed to write metrics to disk:', err);
  });
}, 5000);

function recordMetric(poolType, metricName, value = 1) {
    if (intervalMetrics[poolType] && intervalMetrics[poolType][metricName] !== undefined) {
        intervalMetrics[poolType][metricName] += value;
    }
    if (metricName === 'receivedThisInterval') {
        intervalMetrics.system.totalReceivedThisInterval += value;
        lifetimeMetrics.totalReceived += value;
    } else if (metricName === 'droppedByAdmission') {
        intervalMetrics.system.totalDroppedThisInterval += value;
        lifetimeMetrics.totalDropped += value;
    }
}

function getMetricsSnapshot() {
    return metricsSnapshot;
}

function createPoolState() {
  return {
    workerMap: new Map(),
    eligibleArray: [],
    eligibleSet: new Set(),
    inFlight: new Map(), // Used explicitly for compute complexity tracking
    rrIndex: 0,          // Used strictly by batch pool
    queueDepth: 0        // Track requests waiting in queue
  };
}

const pools = {
  interactive: createPoolState(),
  compute: createPoolState(),
  batch: createPoolState()
};

let queues = { interactive: [], compute: [], batch: [] };
let taskCounter = 0;

// Interval to check for dead workers (every 5 seconds)
setInterval(checkDeadWorkers, 5000);

// ─── Eligible Structure Maintenance ──────────────────────────────────
function addToEligible(workerId, type) {
  const pool = pools[type];
  if (!pool || pool.eligibleSet.has(workerId)) return;

  pool.eligibleArray.push(workerId);
  pool.eligibleSet.add(workerId);
  const worker = pool.workerMap.get(workerId);
  if (worker) {
    worker.arrayIndex = pool.eligibleArray.length - 1;
  }
}

function removeFromEligible(workerId, type) {
  const pool = pools[type];
  if (!pool || !pool.eligibleSet.has(workerId)) return;

  const worker = pool.workerMap.get(workerId);
  if (!worker) return;

  const idx = worker.arrayIndex;
  const lastId = pool.eligibleArray[pool.eligibleArray.length - 1];

  // swap-tail-pop O(1)
  pool.eligibleArray[idx] = lastId;
  const lastWorker = pool.workerMap.get(lastId);
  if (lastWorker) {
    lastWorker.arrayIndex = idx;
  }
  pool.eligibleArray.pop();

  pool.eligibleSet.delete(workerId);
  worker.arrayIndex = -1;
}

// ─── Heartbeat Management ──────────────────────────────────────────
function onHeartbeat(payload) {
  const { workerId, poolType, healthy, port } = payload;
  const pool = pools[poolType];
  if (!pool) return;

  let worker = pool.workerMap.get(workerId);
  
  if (!worker) {
    // Register dynamically if not preset
    const workerPort = port || workerId.split('-')[1]; // Fallback to string split if old payload
    worker = {
      id: workerId,
      capacity: poolType === 'compute' ? 2 : 5,
      activeConnections: 0,
      runningTotalComplexity: 0,
      arrayIndex: -1,
      healthy: healthy,
      lastHeartbeat: Date.now(),
      type: poolType,
      url: `http://localhost:${workerPort}`
    };
    pool.workerMap.set(workerId, worker);
    console.log(`[Scheduler] Dynamically registered ${workerId} via heartbeat in ${poolType} pool`);
  } else {
    // Update existing (do not overwrite activeConnections / complexity!)
    worker.healthy = healthy;
    worker.lastHeartbeat = Date.now();
  }

  const shouldBeEligible =
    worker.healthy &&
    worker.activeConnections < worker.capacity &&
    (Date.now() - worker.lastHeartbeat) < 5000;

  if (shouldBeEligible) {
    addToEligible(workerId, poolType);
  } else {
    removeFromEligible(workerId, poolType);
  }
  dispatch(); // See if we can drain queues now
}

function checkDeadWorkers() {
  const now = Date.now();
  for (const [type, pool] of Object.entries(pools)) {
    for (const [id, worker] of pool.workerMap.entries()) {
      if (now - worker.lastHeartbeat > 5000) {
        if (worker.healthy) {
           console.log(`[Scheduler] Worker ${id} died (no heartbeat for 5s)`);
        }
        worker.healthy = false;
        removeFromEligible(id, type);
      }
    }
  }
}

// Legacy initial registration from LB
function addWorker(workerData) {
  // We'll insert it into workerMap now so the heartbeat finds it cleanly later,
  // preventing URL guessing. LB maps port 4001..4004 etc
  const poolType = workerData.type || 'batch';
  const pool = pools[poolType];
  
  const worker = {
    id: workerData.id,
    url: workerData.url,
    capacity: workerData.capacity || 2, // Default, will sync via heartbeat
    activeConnections: 0,
    runningTotalComplexity: 0,
    arrayIndex: -1,
    healthy: true,
    lastHeartbeat: Date.now(),
    type: poolType
  };
  pool.workerMap.set(worker.id, worker);
  addToEligible(worker.id, poolType);
}

function removeWorker(workerId) {
   for (const [type, pool] of Object.entries(pools)) {
       if (pool.workerMap.has(workerId)) {
           removeFromEligible(workerId, type);
           pool.workerMap.delete(workerId);
           pool.inFlight.delete(workerId);
           console.log(`[Scheduler] Manual deregister of ${workerId}`);
       }
   }
}

// ─── Selection Logic (P2C) ──────────────────────────────────────────
function selectInteractiveWorker() {
  const pool = pools.interactive;
  if (pool.eligibleArray.length === 0) return null;
  if (pool.eligibleArray.length === 1) return pool.workerMap.get(pool.eligibleArray[0]);

  let i = Math.floor(Math.random() * pool.eligibleArray.length);
  let j;
  do { j = Math.floor(Math.random() * pool.eligibleArray.length); } while (j === i);

  const workerA = pool.workerMap.get(pool.eligibleArray[i]);
  const workerB = pool.workerMap.get(pool.eligibleArray[j]);

  const scoreA = workerA.activeConnections / (workerA.capacity || 1);
  const scoreB = workerB.activeConnections / (workerB.capacity || 1);

  let winner = scoreA <= scoreB ? workerA : workerB;

  if (winner.activeConnections >= winner.capacity) {
      winner = null;
      for (const id of pool.eligibleArray) {
          const w = pool.workerMap.get(id);
          if (w.activeConnections < w.capacity) {
              winner = w; 
              break;
          }
      }
  }
  return winner;
}

function selectComputeWorker() {
  const pool = pools.compute;
  if (pool.eligibleArray.length === 0) return null;
  if (pool.eligibleArray.length === 1) return pool.workerMap.get(pool.eligibleArray[0]);

  let i = Math.floor(Math.random() * pool.eligibleArray.length);
  let j;
  do { j = Math.floor(Math.random() * pool.eligibleArray.length); } while (j === i);

  const workerA = pool.workerMap.get(pool.eligibleArray[i]);
  const workerB = pool.workerMap.get(pool.eligibleArray[j]);

  const scoreA = workerA.runningTotalComplexity / (workerA.capacity || 1);
  const scoreB = workerB.runningTotalComplexity / (workerB.capacity || 1);

  let winner = scoreA <= scoreB ? workerA : workerB;

  if (winner.activeConnections >= winner.capacity) {
      winner = null;
      for (const id of pool.eligibleArray) {
          const w = pool.workerMap.get(id);
          if (w.activeConnections < w.capacity) {
              winner = w; 
              break;
          }
      }
  }
  return winner;
}

function selectBatchWorker() {
  const pool = pools.batch;
  if (pool.eligibleArray.length === 0) return null;
  
  const workerId = pool.eligibleArray[pool.rrIndex % pool.eligibleArray.length];
  pool.rrIndex++;
  return pool.workerMap.get(workerId);
}

// ─── Core Dispatch ──────────────────────────────────────────────────
function dispatch() {
  // Interactive
  while (queues.interactive.length > 0) {
    const worker = selectInteractiveWorker();
    if (!worker) break;
    const task = queues.interactive.shift();
    pools.interactive.queueDepth--;
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }

  // Compute
  while (queues.compute.length > 0) {
    const worker = selectComputeWorker();
    if (!worker) break;
    const task = queues.compute.shift();
    pools.compute.queueDepth--;
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }

  // Batch
  while (queues.batch.length > 0) {
    const worker = selectBatchWorker();
    if (!worker) break;
    const task = queues.batch.shift();
    pools.batch.queueDepth--;
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }
}

async function sendRequest(worker, task) {
  worker.activeConnections++;
  let complexity = 1;
  
  if (worker.type === 'compute') {
    complexity = Math.max(1, Math.min(10, task.complexity || 1));
    worker.runningTotalComplexity += complexity;
    const pool = pools.compute;
    if (!pool.inFlight.has(worker.id)) pool.inFlight.set(worker.id, new Map());
    pool.inFlight.get(worker.id).set(task.id, complexity);
  }

  if (worker.activeConnections >= worker.capacity) {
    removeFromEligible(worker.id, worker.type);
  }

  console.log(`[Scheduler] Dispatching ${task.id} → ${worker.id} (${worker.activeConnections}/${worker.capacity} cap)`);

  const payload = {
      id: task.id,
      type: task.type,
      enqueuedAt: task.enqueuedAt,
      complexity: complexity,
      payload: task.payload || null
  };

  try {
    if (task.type === 'batch') {
        // Resolve early for batch queue as per spec (fire & forget)
        task.resolve({ status: 'accepted', message: 'Dispatched to batch worker', handledBy: worker.id });
        recordMetric('batch', 'completed');
    }

    const axTimeout = task.type === 'compute' ? 60000 : 10000;
    const response = await axios.post(`${worker.url}/task`, payload, { timeout: axTimeout });
    
    if (task.type !== 'batch') {
        task.resolve({
            ...response.data,
            handledBy: worker.id
        });
        recordMetric(task.type, 'completed');
        recordMetric(task.type, 'totalLatency', Date.now() - task.enqueuedAt);
    }
  } catch (err) {
    const errorMsg = err.response ? `HTTP ${err.response.status}` : (err.code || err.message);
    const serverDetails = err.response && err.response.data && err.response.data.error ? err.response.data.error : '';
    const finalReason = serverDetails ? `${errorMsg} - ${serverDetails}` : errorMsg;
    
    console.error(`[Scheduler] Worker ${worker.id} failed task ${task.id}: ${finalReason}`);
    if (task.type !== 'batch') {
        recordMetric(task.type, 'rejectedByWorkers');
        task.reject({ error: 'Worker failed', worker: worker.id, reason: finalReason });
    }
  } finally {
    onRequestComplete(worker.id, worker.type, task.id);
  }
}

function onRequestComplete(workerId, poolType, taskId) {
    const pool = pools[poolType];
    const worker = pool.workerMap.get(workerId);
    if (!worker) return;

    worker.activeConnections--;

    if (poolType === 'compute') {
        const workerInFlight = pool.inFlight.get(workerId);
        if (workerInFlight && workerInFlight.has(taskId)) {
            const completedComplexity = workerInFlight.get(taskId);
            worker.runningTotalComplexity -= completedComplexity;
            workerInFlight.delete(taskId);
        }
    }

    const nowEligible =
        worker.healthy &&
        worker.activeConnections < worker.capacity &&
        (Date.now() - worker.lastHeartbeat) < 5000;

    if (nowEligible) {
        addToEligible(workerId, poolType);
    }
    dispatch(); 
}

// ─── Admission Control ──────────────────────────────────────────────
function checkAdmission(poolType) {
  const iRatio = pools.interactive.queueDepth / MAX_QUEUE_SIZES.interactive;
  const cRatio = pools.compute.queueDepth / MAX_QUEUE_SIZES.compute;
  const bRatio = pools.batch.queueDepth / MAX_QUEUE_SIZES.batch;

  const weightedPressure = ((iRatio * 3) + (cRatio * 2) + (bRatio * 1)) / 6;

  let reject = false;
  const retryAfter = 30; // 30 seconds for all 3 rejection states as requested

  if (weightedPressure > 0.95) {
    reject = true;
  } else if (weightedPressure >= 0.90 && weightedPressure <= 0.95) {
    if (poolType === 'batch' || poolType === 'compute') {
      reject = true;
    }
  } else if (weightedPressure >= 0.70 && weightedPressure < 0.90) {
    if (poolType === 'batch') {
      reject = true;
    }
  }

  return reject ? { accept: false, retryAfter } : { accept: true };
}

// ─── Enqueue ─────────────────────────────────────────────────────────
function enqueue(taskData) {
  const type = taskData.type || 'batch';
  
  return new Promise((resolve, reject) => {
    if (!queues[type]) {
       return reject({ error: 'Invalid task type', type });
    }

    const maxSize = MAX_QUEUE_SIZES[type] || 100;
    if (queues[type].length >= maxSize) {
      recordMetric(type, 'rejectedByWorkers');
      return reject({ error: 'Queue full', type, queueSize: queues[type].length });
    }

    taskCounter++;
    const taskId = taskData.id || `task-${taskCounter}`;
    
    if (type === 'compute') {
       taskData.complexity = Math.max(1, Math.min(10, taskData.complexity ?? 1));
    }

    const timeoutHandle = setTimeout(() => {
      const origSize = queues[type].length;
      queues[type] = queues[type].filter(t => t.id !== taskId);
      if (queues[type].length < origSize) {
        pools[type].queueDepth--;
      }
      recordMetric(type, 'rejectedByWorkers');
      reject({ error: 'Task timed out', taskId, type });
    }, TASK_TIMEOUT_MS);

    queues[type].push({ 
      ...taskData, 
      id: taskId, 
      resolve, 
      reject, 
      timeoutHandle 
    });
    pools[type].queueDepth++; // Increment when waiting for a worker
    
    dispatch();
  });
}

function getStatus() {
  const status = {
    algorithm: 'P2C / O(1)',
    queues: {
        interactive: queues.interactive.length,
        compute: queues.compute.length,
        batch: queues.batch.length
    },
    workerPools: {}
  };

  for (const [type, pool] of Object.entries(pools)) {
    status.workerPools[type] = Array.from(pool.workerMap.values()).map(w => ({
      id: w.id,
      active: w.activeConnections,
      cap: w.capacity,
      healthy: w.healthy,
      eligible: pool.eligibleSet.has(w.id),
      runningTotalComplexity: w.runningTotalComplexity
    }));
  }

  return status;
}

function getAggregatedStatus() {
  const raw = getStatus();  
  const result = {};
  
  for (const poolType of ['interactive', 'compute', 'batch']) {
      const workers = raw.workerPools[poolType] || [];
      const queueDepth = raw.queues[poolType] || 0;
      
      const activeWorkers = workers.filter(w => w.active > 0).length;
      const idleWorkers = workers.filter(w => w.active === 0 && w.eligible).length;
      const workerCount = workers.length;
      
      result[poolType] = {
          queueDepth,
          activeWorkers,
          idleWorkers,
          workerCount
      };
  }
  
  return result;
}

function setAlgorithm() { return false; }
function getAlgorithm() { return 'P2C / O(1)'; }

module.exports = { 
    enqueue, 
    addWorker, 
    removeWorker, 
    getStatus, 
    getAggregatedStatus,
    onHeartbeat,
    setAlgorithm,
    getAlgorithm,
    checkAdmission,
    recordMetric,
    getMetricsSnapshot
};

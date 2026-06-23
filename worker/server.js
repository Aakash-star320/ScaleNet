const express = require('express');
const morgan = require('morgan');

const app = express();
app.use(express.json());

// ─── Config from environment ───────────────────────────────────────────────────
const PORT        = process.env.PORT        || 4001;
const WORKER_ID   = process.env.WORKER_ID   || 'worker-1';
const WORKER_TYPE = process.env.WORKER_TYPE || 'batch';
const CAPACITY    = process.env.CAPACITY    || (WORKER_TYPE === 'compute' ? 2 : 5);
const MANAGED_WORKER = process.env.MANAGED_WORKER === 'true';

// ─── State ─────────────────────────────────────────────────────────────────────
let activeConnections = 0;
let totalProcessed    = 0;
let isDraining        = false;
let localRunningTotalComplexity = 0;
const latencyHistory  = []; // keeps last 100 latencies

// Batch specific
let batchBuffer = [];
let batchTimer  = null;
let batchProcessingCount = 0;

function recordLatency(ms) {
  latencyHistory.push(ms);
  if (latencyHistory.length > 100) latencyHistory.shift();
}

function avgLatency() {
  if (latencyHistory.length === 0) return 0;
  const sum = latencyHistory.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencyHistory.length);
}

// ─── Helper: simulate async work ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('dev'));

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * Handle incoming tasks based on worker role
 */
app.post('/task', async (req, res) => {
  if (isDraining) {
    console.log(`[${WORKER_ID}] Rejected task ${req.body.id} because worker is draining`);
    return res.status(503).json({
      error: 'Worker is draining, not accepting new tasks',
      code: 'WORKER_DRAINING',
      retryable: true,
      workerId: WORKER_ID
    });
  }

  const { id, type, enqueuedAt, complexity = 1 } = req.body;

  // 1. Interactive Worker Behavior
  if (WORKER_TYPE === 'interactive') {
    const waitTime = Date.now() - (enqueuedAt || Date.now());
    if (waitTime > 200) {
      console.log(`[${WORKER_ID}] [Interactive] Rejected: waited ${waitTime}ms (> 200ms)`);
      return res.status(503).json({ error: 'Deadline exceeded', waitTime });
    }

    activeConnections++;
    const processingTime = randomBetween(50, 150);
    await sleep(processingTime);
    
    recordLatency(processingTime);
    totalProcessed++;
    activeConnections--;

    return res.json({ 
      workerId: WORKER_ID, 
      status: 'done', 
      latency: processingTime, 
      id 
    });
  }

  // 2. Compute Worker Behavior
  if (WORKER_TYPE === 'compute') {
    if (activeConnections >= CAPACITY) {
      console.log(`[${WORKER_ID}] [Compute] Rejected: At capacity (${activeConnections}/${CAPACITY})`);
      return res.status(503).json({ error: 'Worker at capacity', workerId: WORKER_ID });
    }

    activeConnections++;
    const comp = Math.max(1, Math.min(10, complexity || 1));
    localRunningTotalComplexity += comp;
    
    // Scale sleep: 1000 + (complexity / 10) * 3000ms
    const processingTime = Math.round(1000 + (comp / 10) * 3000);
    
    console.log(`[${WORKER_ID}] [Compute] Task ${id} | complexity ${comp} | work ${processingTime}ms`);
    
    await sleep(processingTime);
    
    recordLatency(processingTime);
    totalProcessed++;
    activeConnections--;
    localRunningTotalComplexity -= comp;

    return res.json({ 
      workerId: WORKER_ID, 
      status: 'done', 
      latency: processingTime, 
      id 
    });
  }

  // 3. Batch Worker Behavior
  if (WORKER_TYPE === 'batch') {
    batchBuffer.push({ ...req.body, bufferedAt: Date.now() });
    console.log(`[${WORKER_ID}] [Batch] Buffered task ${id} | Total: ${batchBuffer.length}/50`);

    if (batchBuffer.length >= 50) {
      drainBatch(); // Trigger immediate drain if full
    } else if (!batchTimer) {
      // Start 5s timer for the first task in the batch
      batchTimer = setTimeout(() => drainBatch(), 5000);
    }

    return res.status(202).json({ 
      workerId: WORKER_ID, 
      status: 'accepted', 
      message: 'Task added to processing buffer',
      id 
    });
  }

  // Fallback for unknown types
  return res.status(400).json({ error: 'Unknown worker type configuration' });
});

/**
 * Drains the batch buffer and processes them in bulk
 */
async function drainBatch() {
  if (batchBuffer.length === 0) return;

  const count = batchBuffer.length;
  const currentBatch = [...batchBuffer];
  batchBuffer = [];
  
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  batchProcessingCount += count;
  activeConnections = 1; // Mark as busy
  
  // Drain sleep scales by bufferSize only inside the worker
  const drainTime = count * 100; // 100ms per task
  
  console.log(`[${WORKER_ID}] [Batch] Draining ${count} tasks | processing for ${drainTime}ms`);
  
  await sleep(drainTime);
  
  totalProcessed += count;
  batchProcessingCount -= count;
  activeConnections = batchProcessingCount > 0 ? 1 : 0;
  
  console.log(`[${WORKER_ID}] [Batch] Processing complete`);
}

// GET /health — instant response, no delay
app.get('/health', (req, res) => {
  res.json({
    status:            'ok',
    workerId:          WORKER_ID,
    workerType:        WORKER_TYPE,
    activeConnections,
    totalProcessed,
    avgLatency:        avgLatency(),
    bufferSize:        WORKER_TYPE === 'batch' ? batchBuffer.length : undefined,
    processingCount:   WORKER_TYPE === 'batch' ? batchProcessingCount : undefined,
    capacity:          WORKER_TYPE === 'compute' ? CAPACITY : undefined
  });
});

// POST /drain — stop accepting new tasks gracefully
app.post('/drain', (req, res) => {
  isDraining = true;
  if (WORKER_TYPE === 'batch' && batchBuffer.length > 0) {
    drainBatch();
  }
  console.log(`[${WORKER_ID}] 🛑 DRAIN REQUESTED. Stop accepting tasks. Active connections: ${activeConnections}`);
  res.json({
    success: true,
    message: `Worker ${WORKER_ID} is now draining`,
    activeConnections
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ${WORKER_TYPE.toUpperCase()} Worker [${WORKER_ID}] listening on port ${PORT}`);
  console.log(`   POST /task   → specialized handle`);
  console.log(`   GET  /health → status + metrics\n`);
});

// ─── Heartbeat ─────────────────────────────────────────────────────────────────
const LB_URL = process.env.LB_URL || 'http://localhost:3000';

setInterval(async () => {
  try {
    await fetch(`${LB_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: WORKER_ID,
        poolType: WORKER_TYPE,
        managed: MANAGED_WORKER,
        healthy: !isDraining,
        port: PORT,
        bufferSize: WORKER_TYPE === 'batch' ? batchBuffer.length : undefined,
        processingCount: WORKER_TYPE === 'batch' ? batchProcessingCount : undefined
      })
    });
  } catch (err) {
    // Silent fail on heartbeat drop, as expected in network partitions
  }
}, 2000);

// ─── Priority Queue Manager ─────────────────────────────────────────────────────
// Manages three internal priority queues and a processor loop that drains them
// in strict priority order.
//
// Queue Structure:
//   queues = {
//     1: [],   // urgent  — forward immediately
//     2: [],   // normal  — forward after priority 1 is drained
//     3: []    // low     — forward only when system not busy
//   }
//
// Processor Logic (runs every 100ms):
//   1. Drain priority 1 completely first
//   2. Then drain priority 2
//   3. Then drain priority 3 ONLY if total queue depth is below threshold
//
// Each item in the queue looks like:
//   {
//     id: 'task-123',
//     priority: 1,
//     enqueuedAt: 1713600000000,
//     originalRequest: { type: 'interactive', urgent: true, ... },
//     resolve: fn,   // Promise resolver for the client waiting on 202
//     forwarded: false
//   }

const { config } = require('./config');
const { recordReceived, recordRejected } = require('./stats');
const { canForward, consumeToken, forwardToLoadBalancer } = require('./forwarder');

// ─── The Three Priority Queues ───────────────────────────────────────────────
const queues = {
  1: [],  // Urgent
  2: [],  // Normal
  3: []   // Low
};

let taskCounter = 0;
let processorInterval = null;

/**
 * Add a request to the appropriate priority queue.
 * 
 * @param {Object} requestBody - The original request body from the client
 * @param {number} priority    - 1, 2, or 3
 * @param {string} reason      - Why this priority was assigned (for logging)
 * @returns {{ accepted: boolean, taskId: string, position: number } | { accepted: false, error: string }}
 */
function enqueue(requestBody, priority, reason) {
  // Validate priority
  if (![1, 2, 3].includes(priority)) {
    priority = 3; // Safe fallback
  }

  // Check queue capacity
  const maxSize = config.maxQueueSizes[priority] || 100;
  if (queues[priority].length >= maxSize) {
    recordRejected(priority);
    return {
      accepted: false,
      error: `Priority ${priority} queue is full (${queues[priority].length}/${maxSize})`,
      priority,
      retryAfter: priority === 1 ? 5 : 30
    };
  }

  // Generate task ID
  taskCounter++;
  const taskId = requestBody.id || `pq-${taskCounter}-${Date.now()}`;

  // Build queue item
  const queueItem = {
    id: taskId,
    priority,
    reason,
    enqueuedAt: Date.now(),
    originalRequest: requestBody
  };

  queues[priority].push(queueItem);
  recordReceived(priority);

  return {
    accepted: true,
    taskId,
    priority,
    reason,
    position: queues[priority].length,
    queueDepths: getQueueDepths()
  };
}

/**
 * Get current depth of each queue.
 * @returns {{ 1: number, 2: number, 3: number, total: number }}
 */
function getQueueDepths() {
  return {
    1: queues[1].length,
    2: queues[2].length,
    3: queues[3].length,
    total: queues[1].length + queues[2].length + queues[3].length
  };
}

/**
 * The main processor loop — runs every 100ms.
 * Drains queues in strict priority order with rate limiting.
 */
async function processQueues() {
  // Priority 1: Drain completely first (urgent requests always go first)
  while (queues[1].length > 0 && canForward()) {
    const item = queues[1].shift();
    consumeToken();
    // Fire and forget — don't block the processor loop
    forwardToLoadBalancer(item).catch(() => {});
  }

  // Priority 2: Drain after priority 1 is empty
  while (queues[2].length > 0 && canForward()) {
    const item = queues[2].shift();
    consumeToken();
    forwardToLoadBalancer(item).catch(() => {});
  }

  // Priority 3: Only drain when system is NOT busy
  // "Not busy" = total queue depth below the low-priority threshold
  const totalDepth = queues[1].length + queues[2].length + queues[3].length;
  if (totalDepth < config.lowPriorityThreshold) {
    while (queues[3].length > 0 && canForward()) {
      const item = queues[3].shift();
      consumeToken();
      forwardToLoadBalancer(item).catch(() => {});
    }
  }
}

/**
 * Start the queue processor loop.
 * Called once when the server boots up.
 */
function startProcessor() {
  if (processorInterval) return; // Already running

  console.log(`[QueueManager] Starting processor loop (${config.processorIntervalMs}ms interval)`);
  processorInterval = setInterval(processQueues, config.processorIntervalMs);
}

/**
 * Stop the queue processor (for graceful shutdown).
 */
function stopProcessor() {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    console.log('[QueueManager] Processor loop stopped');
  }
}

/**
 * Get raw queue contents (for debugging — use with caution on large queues).
 * @param {number} priority - Which queue to peek at (1, 2, or 3)
 * @param {number} limit    - Max items to return (default 10)
 */
function peekQueue(priority, limit = 10) {
  if (!queues[priority]) return [];
  return queues[priority].slice(0, limit).map(item => ({
    id: item.id,
    priority: item.priority,
    reason: item.reason,
    waitingMs: Date.now() - item.enqueuedAt,
    type: item.originalRequest.type
  }));
}

module.exports = { enqueue, getQueueDepths, startProcessor, stopProcessor, peekQueue, queues };

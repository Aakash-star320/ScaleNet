// ─── Statistics Tracker ─────────────────────────────────────────────────────────
// Tracks per-priority metrics:
//   - Total requests processed (forwarded successfully)
//   - Total requests rejected (queue full or forwarding failed)
//   - Average wait time (time spent in queue before forwarding)
//   - Total requests received
//
// All stats are exposed via GET /queue/stats

const stats = {
  1: { received: 0, processed: 0, rejected: 0, totalWaitMs: 0 },
  2: { received: 0, processed: 0, rejected: 0, totalWaitMs: 0 },
  3: { received: 0, processed: 0, rejected: 0, totalWaitMs: 0 },
  startedAt: Date.now(),
  lastConfidence: null
};

/**
 * Record that a request was received and classified into a priority queue.
 * @param {number} priority - 1, 2, or 3
 */
function recordReceived(priority) {
  if (stats[priority]) {
    stats[priority].received++;
  }
}

/**
 * Record that a request was successfully forwarded to the Load Balancer.
 * @param {number} priority - 1, 2, or 3
 * @param {number} waitMs   - How long the request waited in queue (ms)
 */
function recordProcessed(priority, waitMs) {
  if (stats[priority]) {
    stats[priority].processed++;
    stats[priority].totalWaitMs += waitMs;
  }
}

/**
 * Record that a request was rejected (queue full or forwarding failed).
 * @param {number} priority - 1, 2, or 3
 */
function recordRejected(priority) {
  if (stats[priority]) {
    stats[priority].rejected++;
  }
}

/**
 * Get a snapshot of all statistics.
 * @returns {Object} Full stats object with averages computed
 */
function getStats() {
  const snapshot = {};
  
  for (const priority of [1, 2, 3]) {
    const s = stats[priority];
    snapshot[`priority_${priority}`] = {
      received: s.received,
      processed: s.processed,
      rejected: s.rejected,
      avgWaitMs: s.processed > 0 ? Math.round(s.totalWaitMs / s.processed) : 0
    };
  }

  const totalReceived  = stats[1].received + stats[2].received + stats[3].received;
  const totalProcessed = stats[1].processed + stats[2].processed + stats[3].processed;
  const totalRejected  = stats[1].rejected + stats[2].rejected + stats[3].rejected;
  const uptimeSeconds  = Math.round((Date.now() - stats.startedAt) / 1000);

  snapshot.totals = {
    received: totalReceived,
    processed: totalProcessed,
    rejected: totalRejected,
    uptimeSeconds,
    avgRPS: uptimeSeconds > 0 ? parseFloat((totalReceived / uptimeSeconds).toFixed(2)) : 0
  };
  
  snapshot.lastConfidence = stats.lastConfidence;

  return snapshot;
}

function recordConfidence(conf) {
  stats.lastConfidence = conf;
}

/**
 * Reset all statistics (useful when switching modes).
 */
function resetStats() {
  for (const priority of [1, 2, 3]) {
    stats[priority] = { received: 0, processed: 0, rejected: 0, totalWaitMs: 0 };
  }
  stats.startedAt = Date.now();
}

module.exports = { recordReceived, recordProcessed, recordRejected, getStats, resetStats, recordConfidence };

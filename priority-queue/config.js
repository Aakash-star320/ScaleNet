// ─── Runtime Configuration ──────────────────────────────────────────────────────
// All values here can be updated at runtime via POST /queue/config
// This lets you tune the system without restarting the service.

const config = {
  // ─── Forwarding Rate ─────────────────────────────────────────────────────────
  // How many requests per second we forward to the Load Balancer.
  // This prevents overwhelming the LB during traffic spikes.
  forwardingRatePerSecond: 50,

  // ─── Queue Size Limits ───────────────────────────────────────────────────────
  // Maximum number of requests allowed in each priority queue.
  // When a queue is full, new requests at that priority get rejected (HTTP 503).
  maxQueueSizes: {
    1: 100,   // Priority 1 (urgent) — generous limit, we never want to drop these
    2: 200,   // Priority 2 (normal) — moderate buffer
    3: 500    // Priority 3 (low)    — large buffer since batch can wait
  },

  // ─── Queue Depth Threshold ───────────────────────────────────────────────────
  // Priority 3 requests only get forwarded when total queue depth is below this.
  // This ensures low-priority batch work doesn't clog the system during busy periods.
  lowPriorityThreshold: 50,

  // ─── Processor Interval ──────────────────────────────────────────────────────
  // How often (in ms) the queue processor runs to drain queues and forward requests.
  // 100ms = 10 times per second. Fast enough for interactive SLAs.
  processorIntervalMs: 100,

  // ─── Load Balancer Target ────────────────────────────────────────────────────
  // Where to forward requests after priority processing.
  loadBalancerUrl: 'http://localhost:3000',

  // ─── ML Mode ─────────────────────────────────────────────────────────────────
  // 'rules' = simple rule-based classification (default)
  // 'ml'    = ML model-based classification (after training)
  classificationMode: 'rules',

  // ─── Dynamic Reclassification ────────────────────────────────────────────────
  // Priority 3 requests waiting longer than this (ms) get bumped to Priority 2
  escalationThresholdMs: 30000,

  // When system pressure drops below this %, treat Priority 2 as Priority 1
  pressureRelaxThreshold: 0.50
};

// ─── Config Update Function ──────────────────────────────────────────────────
// Safely merges partial updates into the config object.
// Only known keys are accepted — unknown keys are ignored.
function updateConfig(updates) {
  const allowedKeys = Object.keys(config);
  const applied = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!allowedKeys.includes(key)) continue;

    if (key === 'maxQueueSizes' && typeof value === 'object') {
      // Merge nested queue size updates
      for (const [priority, limit] of Object.entries(value)) {
        const p = Number(priority);
        if ([1, 2, 3].includes(p) && typeof limit === 'number' && limit > 0) {
          config.maxQueueSizes[p] = limit;
          applied[`maxQueueSizes.${p}`] = limit;
        }
      }
    } else if (typeof value === typeof config[key]) {
      config[key] = value;
      applied[key] = value;
    }
  }

  return applied;
}

module.exports = { config, updateConfig };

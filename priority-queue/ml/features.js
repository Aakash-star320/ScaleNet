// ─── Feature Extraction ─────────────────────────────────────────────────────────
// Extracts 7 numerical features from each incoming request.
// These features are what the ML model uses to predict priority.
//
// Features:
//   1. requestType      — encoded: interactive=0, compute=1, batch=2
//   2. payloadSize      — size of the request body in bytes
//   3. complexityScore  — from request.complexity field (0 if missing)
//   4. hourOfDay        — 0-23 based on current time
//   5. hasUrgentFlag    — 1 if request.urgent === true, else 0
//   6. recentRejectionRate — from stats module (rejected / received ratio)
//   7. currentQueueDepth   — total items across all 3 queues right now

const { getStats } = require('../stats');

// Type encoding map
const TYPE_ENCODING = {
  'interactive': 0,
  'compute': 1,
  'batch': 2
};

/**
 * Extract 7 numerical features from a request.
 * 
 * @param {Object} requestBody - The incoming request payload
 * @param {Object} queueDepths - Current queue depths { 1: n, 2: n, 3: n, total: n }
 * @returns {Object} Feature vector with named fields
 */
function extractFeatures(requestBody, queueDepths = { total: 0 }) {
  // 1. Request type encoded as number
  const normalizedType = (requestBody.type || '').toLowerCase().trim();
  const requestType = TYPE_ENCODING[normalizedType] !== undefined 
    ? TYPE_ENCODING[normalizedType] 
    : 2; // Unknown defaults to 'batch' encoding

  // 2. Payload size in bytes
  const payloadSize = JSON.stringify(requestBody).length;

  // 3. Complexity score (0 if missing)
  const complexityScore = typeof requestBody.complexity === 'number'
    ? Math.max(0, Math.min(10, requestBody.complexity))
    : 0;

  // 4. Hour of day (0-23)
  const hourOfDay = new Date().getHours();

  // 5. Has urgent flag (binary)
  const hasUrgentFlag = requestBody.urgent === true ? 1 : 0;

  // 6. Recent rejection rate (from live stats)
  let recentRejectionRate = 0;
  try {
    const currentStats = getStats();
    const totalReceived = currentStats.totals.received || 0;
    const totalRejected = currentStats.totals.rejected || 0;
    recentRejectionRate = totalReceived > 0 
      ? parseFloat((totalRejected / totalReceived).toFixed(4))
      : 0;
  } catch (err) {
    recentRejectionRate = 0;
  }

  // 7. Current total queue depth
  const currentQueueDepth = queueDepths.total || 0;

  return {
    requestType,
    payloadSize,
    complexityScore,
    hourOfDay,
    hasUrgentFlag,
    recentRejectionRate,
    currentQueueDepth
  };
}

/**
 * Convert a features object to a flat array (for the model's dot product).
 * Order matters — must match the model weights order.
 * 
 * @param {Object} features - Named feature object
 * @returns {number[]} Feature vector as array
 */
function featuresToArray(features) {
  return [
    features.requestType,
    features.payloadSize,
    features.complexityScore,
    features.hourOfDay,
    features.hasUrgentFlag,
    features.recentRejectionRate,
    features.currentQueueDepth
  ];
}

/**
 * Get the names of all features in order (for debugging/display).
 * @returns {string[]}
 */
function getFeatureNames() {
  return [
    'requestType',
    'payloadSize',
    'complexityScore',
    'hourOfDay',
    'hasUrgentFlag',
    'recentRejectionRate',
    'currentQueueDepth'
  ];
}

module.exports = { extractFeatures, featuresToArray, getFeatureNames };

// ─── Rule-Based Priority Classifier ─────────────────────────────────────────────
// Assigns priority levels 1 (urgent), 2 (normal), or 3 (low) based on fixed rules.
//
// Classification Rules:
//   if request.type === 'interactive' AND request.urgent === true  → Priority 1
//   if request.type === 'interactive'                              → Priority 2
//   if request.type === 'compute'                                  → Priority 2
//   if request.type === 'batch'                                    → Priority 3
//   if request.body is missing or malformed                        → Priority 3
//
// This is the "simple version" — no ML involved.
// The ML classifier (ml/model.js) can replace this at runtime.

/**
 * Classify a request into a priority level using fixed rules.
 * 
 * @param {Object} requestBody - The incoming request body
 * @returns {{ priority: number, reason: string }} - Priority level and explanation
 */
function classifyByRules(requestBody) {
  // Guard: missing or malformed body
  if (!requestBody || typeof requestBody !== 'object') {
    return { priority: 3, reason: 'Missing or malformed request body' };
  }

  const { type, urgent } = requestBody;

  // Guard: missing type field
  if (!type || typeof type !== 'string') {
    return { priority: 3, reason: 'Missing or invalid type field' };
  }

  const normalizedType = type.toLowerCase().trim();

  // Rule 1: Interactive + urgent flag → Priority 1 (urgent)
  if (normalizedType === 'interactive' && urgent === true) {
    return { priority: 1, reason: 'Interactive request with urgent flag' };
  }

  // Rule 2: Interactive without urgent → Priority 2 (normal)
  if (normalizedType === 'interactive') {
    return { priority: 2, reason: 'Interactive request' };
  }

  // Rule 3: Compute → Priority 2 (normal)
  if (normalizedType === 'compute') {
    return { priority: 2, reason: 'Compute request' };
  }

  // Rule 4: Batch → Priority 3 (low)
  if (normalizedType === 'batch') {
    return { priority: 3, reason: 'Batch request' };
  }

  // Fallback: unknown type → Priority 3 (low)
  return { priority: 3, reason: `Unknown request type: ${normalizedType}` };
}

module.exports = { classifyByRules };

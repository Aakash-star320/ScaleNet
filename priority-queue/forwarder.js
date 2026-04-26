// ─── Rate-Controlled Forwarder ──────────────────────────────────────────────────
// Forwards requests from the priority queue to the Load Balancer.
// Uses a token bucket algorithm to control the forwarding rate.
//
// Why rate control?
//   Without it, draining all queued requests at once would spike the LB.
//   The token bucket smooths out bursts while still allowing immediate forwarding
//   for urgent requests when tokens are available.

const axios = require('axios');
const { config } = require('./config');
const { recordProcessed, recordRejected } = require('./stats');

// ─── Token Bucket State ──────────────────────────────────────────────────────
// Tokens refill over time based on the configured forwarding rate.
// Each forwarded request consumes one token.
let tokens = 0;
let lastRefillTime = Date.now();

/**
 * Refill tokens based on elapsed time since last refill.
 * This is called before each forwarding attempt.
 */
function refillTokens() {
  const now = Date.now();
  const elapsed = now - lastRefillTime;
  
  // Calculate how many tokens to add based on elapsed time
  // forwardingRatePerSecond = 50 means we add 50 tokens per 1000ms
  const newTokens = (elapsed / 1000) * config.forwardingRatePerSecond;
  tokens = Math.min(tokens + newTokens, config.forwardingRatePerSecond); // Cap at max rate
  lastRefillTime = now;
}

/**
 * Check if we have tokens available to forward a request.
 * @returns {boolean} true if a token is available
 */
function canForward() {
  refillTokens();
  return tokens >= 1;
}

/**
 * Consume one token (call after deciding to forward).
 */
function consumeToken() {
  tokens -= 1;
}

/**
 * Forward a request to the Load Balancer.
 * 
 * The LB expects POST /task with the same body format the test traffic sends.
 * We strip our internal metadata (enqueuedAt, priority) and send the original request.
 * 
 * @param {Object} queueItem - The item from our priority queue
 * @returns {Promise<Object>} - Result from the Load Balancer
 */
async function forwardToLoadBalancer(queueItem) {
  const waitMs = Date.now() - queueItem.enqueuedAt;

  try {
    // Build the payload the Load Balancer expects
    const payload = {
      id: queueItem.id,
      type: queueItem.originalRequest.type,
      complexity: queueItem.originalRequest.complexity,
      urgent: queueItem.originalRequest.urgent,
      payload: queueItem.originalRequest.payload
    };

    // Forward to LB — use a generous timeout since compute tasks can take long
    const response = await axios.post(
      `${config.loadBalancerUrl}/task`,
      payload,
      { timeout: 60000 }
    );

    // Record successful forwarding
    recordProcessed(queueItem.priority, waitMs);

    return {
      success: true,
      priority: queueItem.priority,
      waitMs,
      lbResponse: response.data
    };
  } catch (err) {
    // Record failed forwarding
    recordRejected(queueItem.priority);

    const errorDetail = err.response 
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;

    console.error(
      `[Forwarder] Failed to forward ${queueItem.id} (P${queueItem.priority}): ${errorDetail}`
    );

    return {
      success: false,
      priority: queueItem.priority,
      waitMs,
      error: errorDetail
    };
  }
}

module.exports = { canForward, consumeToken, forwardToLoadBalancer };

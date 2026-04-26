// ─── Dynamic Reclassification ───────────────────────────────────────────────────
// Automatically adjusts request priorities based on real-time conditions:
//
// 1. ESCALATION: If a Priority 3 request has been waiting > 30 seconds,
//    bump it to Priority 2 so it gets forwarded sooner.
//
// 2. PRESSURE RELAXATION: If system pressure (from metrics.jsonl) drops
//    below 50%, temporarily treat all Priority 2 as Priority 1.
//
// These rules prevent starvation of low-priority requests during extended
// busy periods, and speed up normal requests when the system has headroom.

const { config } = require('../config');
const { queues } = require('../queue-manager');
const fs = require('fs');
const path = require('path');

const METRICS_FILE = path.join(__dirname, '../../logs/metrics.jsonl');

/**
 * Read the most recent system pressure from the Load Balancer's metrics log.
 * The LB writes metrics every 5 seconds to logs/metrics.jsonl.
 * 
 * @returns {number} Weighted pressure value (0.0 to 1.0), or -1 if unavailable
 */
function readSystemPressure() {
  try {
    if (!fs.existsSync(METRICS_FILE)) return -1;

    const content = fs.readFileSync(METRICS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    
    if (lines.length === 0) return -1;

    // Read the last line (most recent snapshot)
    const latest = JSON.parse(lines[lines.length - 1]);
    return latest.system?.weightedPressure ?? -1;
  } catch (err) {
    return -1;
  }
}

/**
 * Run the escalation check on Priority 3 queue.
 * Moves items that have been waiting too long into Priority 2.
 * 
 * @returns {number} Number of items escalated
 */
function escalateStaleRequests() {
  const now = Date.now();
  const threshold = config.escalationThresholdMs;
  let escalated = 0;

  // Scan Priority 3 queue for stale items
  const staleIndices = [];
  for (let i = 0; i < queues[3].length; i++) {
    const item = queues[3][i];
    const waitTime = now - item.enqueuedAt;
    
    if (waitTime > threshold) {
      staleIndices.push(i);
    }
  }

  // Move stale items to Priority 2 (iterate in reverse to preserve indices)
  for (let i = staleIndices.length - 1; i >= 0; i--) {
    const idx = staleIndices[i];
    const item = queues[3].splice(idx, 1)[0];
    
    // Update the item's priority
    item.priority = 2;
    item.reason = `Escalated from P3 (waited ${Math.round((now - item.enqueuedAt) / 1000)}s)`;
    
    // Add to Priority 2 queue
    queues[2].push(item);
    escalated++;
  }

  if (escalated > 0) {
    console.log(`[Dynamic] Escalated ${escalated} stale P3 → P2 requests`);
  }

  return escalated;
}

/**
 * Check if pressure is low enough to relax Priority 2 → Priority 1.
 * When system pressure drops below the threshold, move all P2 items to P1.
 * 
 * @returns {{ relaxed: boolean, pressure: number, itemsMoved: number }}
 */
function checkPressureRelaxation() {
  const pressure = readSystemPressure();
  
  if (pressure === -1) {
    return { relaxed: false, pressure: -1, itemsMoved: 0 };
  }

  if (pressure < config.pressureRelaxThreshold && queues[2].length > 0) {
    const itemsMoved = queues[2].length;
    
    // Move all P2 items to P1
    while (queues[2].length > 0) {
      const item = queues[2].shift();
      item.priority = 1;
      item.reason = `Relaxed P2→P1 (pressure=${pressure.toFixed(2)})`;
      queues[1].push(item);
    }

    console.log(`[Dynamic] Pressure relaxation: ${itemsMoved} P2→P1 (pressure=${pressure.toFixed(2)})`);
    return { relaxed: true, pressure, itemsMoved };
  }

  return { relaxed: false, pressure, itemsMoved: 0 };
}

/**
 * Run all dynamic reclassification checks.
 * This is called periodically (every second) by the main server.
 * 
 * @returns {Object} Summary of actions taken
 */
function runDynamicReclassification() {
  const escalated = escalateStaleRequests();
  const relaxation = checkPressureRelaxation();

  return {
    escalated,
    relaxation,
    timestamp: Date.now()
  };
}

module.exports = { 
  runDynamicReclassification, 
  escalateStaleRequests, 
  checkPressureRelaxation, 
  readSystemPressure 
};

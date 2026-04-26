// ─── Training Data Collector ────────────────────────────────────────────────────
// During "simple mode" (rule-based classification), every request is saved as
// a labeled training sample. After collecting enough data (30-60 minutes of
// traffic), these samples are used to train the ML model.
//
// Each line in training_data.jsonl looks like:
// {
//   "timestamp": 1713600000000,
//   "request": { "type": "interactive", "urgent": true, ... },
//   "priority": 1,
//   "features": { "requestType": 0, "payloadSize": 256, ... }
// }

const fs = require('fs');
const path = require('path');
const { extractFeatures } = require('./features');

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'training_data.jsonl');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

let sampleCount = 0;

// Count existing samples on startup
try {
  if (fs.existsSync(DATA_FILE)) {
    const content = fs.readFileSync(DATA_FILE, 'utf-8');
    sampleCount = content.trim().split('\n').filter(line => line.trim()).length;
  }
} catch (err) {
  sampleCount = 0;
}

/**
 * Save a labeled training sample to disk.
 * 
 * @param {Object} requestBody - The original request payload
 * @param {number} priority    - The priority label (1, 2, or 3) assigned by rules
 * @param {Object} queueDepths - Current queue depths at time of classification
 */
function collectSample(requestBody, priority, queueDepths) {
  try {
    const features = extractFeatures(requestBody, queueDepths);
    
    const sample = {
      timestamp: Date.now(),
      request: {
        type: requestBody.type,
        urgent: requestBody.urgent || false,
        complexity: requestBody.complexity || 0,
        payloadSize: JSON.stringify(requestBody).length,
        hasPayload: !!requestBody.payload
      },
      priority,       // The label — what the rules assigned
      features        // The numerical features for the ML model
    };

    fs.appendFileSync(DATA_FILE, JSON.stringify(sample) + '\n');
    sampleCount++;

    if (sampleCount % 100 === 0) {
      console.log(`[Collector] ${sampleCount} training samples collected`);
    }
  } catch (err) {
    console.error('[Collector] Failed to save sample:', err.message);
  }
}

/**
 * Get the number of training samples collected so far.
 * @returns {number}
 */
function getSampleCount() {
  return sampleCount;
}

/**
 * Load all training samples from disk.
 * @returns {Array<Object>} Array of sample objects
 */
function loadTrainingData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    
    const content = fs.readFileSync(DATA_FILE, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (err) {
    console.error('[Collector] Failed to load training data:', err.message);
    return [];
  }
}

/**
 * Clear all training data (for a fresh start).
 */
function clearTrainingData() {
  try {
    fs.writeFileSync(DATA_FILE, '');
    sampleCount = 0;
    console.log('[Collector] Training data cleared');
  } catch (err) {
    console.error('[Collector] Failed to clear training data:', err.message);
  }
}

module.exports = { collectSample, getSampleCount, loadTrainingData, clearTrainingData };

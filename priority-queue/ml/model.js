// ─── Logistic Regression Model (from scratch in JavaScript) ─────────────────────
// 
// This implements a One-vs-Rest (OvR) multinomial logistic regression classifier.
// It predicts priority levels (1, 2, or 3) from 7 numerical features.
//
// How it works:
//   - Three binary classifiers, one per priority class
//   - Each classifier has a weight vector (7 weights + 1 bias)
//   - Prediction = class with highest sigmoid(dot(weights, features) + bias)
//   - Training uses batch gradient descent with learning rate scheduling
//
// No external ML libraries needed — pure JavaScript math.
//
// Workflow:
//   1. Collect training data via collector.js (runs during rule-based mode)
//   2. Call train() to fit weights on the collected data
//   3. Save weights to model.json
//   4. On startup (in ML mode), load weights and use predict() for classification

const fs = require('fs');
const path = require('path');
const { featuresToArray, getFeatureNames } = require('./features');

const MODEL_FILE = path.join(__dirname, '../data/model.json');

// ─── Model State ─────────────────────────────────────────────────────────────
// Three sets of weights (one per class), each with 7 feature weights + 1 bias
let modelWeights = null;  // Will be { 1: { weights: [...], bias: 0 }, 2: {...}, 3: {...} }
let modelMetadata = null; // Training info (accuracy, samples, date)

// ─── Math Helpers ────────────────────────────────────────────────────────────

/**
 * Sigmoid activation function.
 * Maps any value to (0, 1) range — represents probability.
 */
function sigmoid(z) {
  // Clip to prevent overflow
  const clipped = Math.max(-500, Math.min(500, z));
  return 1 / (1 + Math.exp(-clipped));
}

/**
 * Dot product of two arrays.
 */
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Normalize features to [0, 1] range using min-max scaling.
 * This prevents features with large ranges (like payloadSize) from dominating.
 * 
 * @param {number[][]} dataMatrix - Array of feature vectors
 * @returns {{ normalized: number[][], mins: number[], maxes: number[] }}
 */
function normalizeFeatures(dataMatrix) {
  if (dataMatrix.length === 0) return { normalized: [], mins: [], maxes: [] };

  const numFeatures = dataMatrix[0].length;
  const mins = new Array(numFeatures).fill(Infinity);
  const maxes = new Array(numFeatures).fill(-Infinity);

  // Find min/max for each feature
  for (const row of dataMatrix) {
    for (let j = 0; j < numFeatures; j++) {
      if (row[j] < mins[j]) mins[j] = row[j];
      if (row[j] > maxes[j]) maxes[j] = row[j];
    }
  }

  // Normalize
  const normalized = dataMatrix.map(row =>
    row.map((val, j) => {
      const range = maxes[j] - mins[j];
      return range === 0 ? 0 : (val - mins[j]) / range;
    })
  );

  return { normalized, mins, maxes };
}

/**
 * Normalize a single feature vector using saved mins/maxes.
 */
function normalizeSingle(featureArray, mins, maxes) {
  return featureArray.map((val, j) => {
    const range = maxes[j] - mins[j];
    return range === 0 ? 0 : (val - mins[j]) / range;
  });
}

// ─── Training ────────────────────────────────────────────────────────────────

/**
 * Train the logistic regression model on collected data.
 * Uses One-vs-Rest strategy: trains 3 binary classifiers.
 * 
 * @param {Array<Object>} trainingData - Array of { features: {...}, priority: 1|2|3 }
 * @param {Object} options - Training hyperparameters
 * @returns {{ success: boolean, accuracy: number, details: Object }}
 */
function train(trainingData, options = {}) {
  const {
    learningRate = 0.1,
    epochs = 500,
    minSamples = 30
  } = options;

  if (trainingData.length < minSamples) {
    return {
      success: false,
      error: `Need at least ${minSamples} samples, have ${trainingData.length}`,
      sampleCount: trainingData.length
    };
  }

  console.log(`[Model] Training on ${trainingData.length} samples...`);

  // Extract feature arrays and labels
  const X_raw = trainingData.map(s => featuresToArray(s.features));
  const labels = trainingData.map(s => s.priority);

  // Normalize features
  const { normalized: X, mins, maxes } = normalizeFeatures(X_raw);
  const numFeatures = X[0].length;

  // Train one binary classifier per class
  const classes = [1, 2, 3];
  const classifiers = {};

  for (const targetClass of classes) {
    // Binary labels: 1 if this class, 0 otherwise
    const y = labels.map(l => l === targetClass ? 1 : 0);

    // Initialize weights to small random values
    const weights = new Array(numFeatures).fill(0).map(() => (Math.random() - 0.5) * 0.1);
    let bias = 0;

    // Gradient descent
    for (let epoch = 0; epoch < epochs; epoch++) {
      // Adaptive learning rate (decay over epochs)
      const lr = learningRate / (1 + epoch * 0.001);

      // Compute gradients over all samples (batch gradient descent)
      const gradWeights = new Array(numFeatures).fill(0);
      let gradBias = 0;

      for (let i = 0; i < X.length; i++) {
        const prediction = sigmoid(dot(weights, X[i]) + bias);
        const error = prediction - y[i];

        for (let j = 0; j < numFeatures; j++) {
          gradWeights[j] += error * X[i][j];
        }
        gradBias += error;
      }

      // Update weights (average gradient)
      for (let j = 0; j < numFeatures; j++) {
        weights[j] -= lr * (gradWeights[j] / X.length);
      }
      bias -= lr * (gradBias / X.length);
    }

    classifiers[targetClass] = { weights, bias };
  }

  // Evaluate training accuracy
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const predicted = predictFromNormalized(X[i], classifiers);
    if (predicted.priority === labels[i]) correct++;
  }
  const accuracy = correct / X.length;

  // Save model
  modelWeights = classifiers;
  modelMetadata = {
    accuracy: parseFloat(accuracy.toFixed(4)),
    trainingSamples: trainingData.length,
    trainedAt: new Date().toISOString(),
    featureNames: getFeatureNames(),
    normalization: { mins, maxes },
    hyperparameters: { learningRate, epochs }
  };

  // Persist to disk
  const modelData = {
    classifiers: modelWeights,
    metadata: modelMetadata
  };

  const dataDir = path.join(__dirname, '../data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(modelData, null, 2));

  console.log(`[Model] Training complete! Accuracy: ${(accuracy * 100).toFixed(1)}%`);
  console.log(`[Model] Weights saved to ${MODEL_FILE}`);

  return {
    success: true,
    accuracy,
    trainingSamples: trainingData.length,
    classWeights: Object.fromEntries(
      Object.entries(classifiers).map(([cls, { weights, bias }]) => [
        cls,
        { weights: weights.map(w => parseFloat(w.toFixed(4))), bias: parseFloat(bias.toFixed(4)) }
      ])
    )
  };
}

/**
 * Internal prediction from already-normalized features.
 */
function predictFromNormalized(normalizedFeatures, classifiers) {
  const scores = {};
  for (const [cls, { weights, bias }] of Object.entries(classifiers)) {
    scores[cls] = sigmoid(dot(weights, normalizedFeatures) + bias);
  }

  // Pick the class with the highest probability
  let bestClass = 3;
  let bestScore = -Infinity;
  for (const [cls, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestClass = Number(cls);
    }
  }

  return { priority: bestClass, confidence: parseFloat(bestScore.toFixed(4)), scores };
}

// ─── Prediction ──────────────────────────────────────────────────────────────

/**
 * Predict priority for a new request using the trained model.
 * 
 * @param {Object} features - Feature object from extractFeatures()
 * @returns {{ priority: number, confidence: number, scores: Object } | null}
 */
function predict(features) {
  if (!modelWeights || !modelMetadata) return null;

  const featureArray = featuresToArray(features);
  const { mins, maxes } = modelMetadata.normalization;
  const normalized = normalizeSingle(featureArray, mins, maxes);

  return predictFromNormalized(normalized, modelWeights);
}

/**
 * Load a previously trained model from disk.
 * @returns {boolean} true if model was loaded successfully
 */
function loadModel() {
  try {
    if (!fs.existsSync(MODEL_FILE)) {
      console.log('[Model] No saved model found at', MODEL_FILE);
      return false;
    }

    const data = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));
    modelWeights = data.classifiers;
    modelMetadata = data.metadata;

    console.log(`[Model] Loaded model trained on ${modelMetadata.trainingSamples} samples`);
    console.log(`[Model] Training accuracy: ${(modelMetadata.accuracy * 100).toFixed(1)}%`);
    console.log(`[Model] Trained at: ${modelMetadata.trainedAt}`);
    return true;
  } catch (err) {
    console.error('[Model] Failed to load model:', err.message);
    return false;
  }
}

/**
 * Check if a trained model is currently loaded.
 * @returns {boolean}
 */
function isModelLoaded() {
  return modelWeights !== null && modelMetadata !== null;
}

/**
 * Get model metadata (for the /queue/stats endpoint).
 * @returns {Object|null}
 */
function getModelInfo() {
  if (!modelMetadata || !modelWeights) return null;
  return { 
    ...modelMetadata,
    classWeights: Object.fromEntries(
      Object.entries(modelWeights).map(([cls, { weights, bias }]) => [
        cls,
        { weights: weights.map(w => parseFloat(w.toFixed(4))), bias: parseFloat(bias.toFixed(4)) }
      ])
    )
  };
}

module.exports = { train, predict, loadModel, isModelLoaded, getModelInfo };

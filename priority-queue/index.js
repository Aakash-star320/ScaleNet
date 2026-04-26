const express = require('express');
const morgan  = require('morgan');
const cors    = require('cors');

const { config, updateConfig }    = require('./config');
const { classifyByRules }         = require('./classifier');
const { enqueue, getQueueDepths, startProcessor, peekQueue } = require('./queue-manager');
const { getStats, resetStats, recordConfidence }    = require('./stats');
const { collectSample, getSampleCount, loadTrainingData, clearTrainingData } = require('./ml/collector');
const { extractFeatures }         = require('./ml/features');
const { train, predict, loadModel, isModelLoaded, getModelInfo } = require('./ml/model');
const { runDynamicReclassification, readSystemPressure }         = require('./ml/dynamic');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─── Try loading a previously trained model on startup ───────────────────────
loadModel();

// ─── Dynamic reclassification loop (every 1 second) ─────────────────────────
setInterval(() => {
  runDynamicReclassification();
}, 1000);

// ─── POST /task — Receive request, classify, enqueue, return 202 ────────────
app.post('/task', (req, res) => {
  const body = req.body;

  // Step 1: Classify
  let priority, reason, confidence = null;

  if (config.classificationMode === 'ml' && isModelLoaded()) {
    const features = extractFeatures(body, getQueueDepths());
    const prediction = predict(features);

    if (prediction) {
      priority = prediction.priority;
      reason = `ML prediction (confidence: ${prediction.confidence})`;
      confidence = prediction.confidence;
      recordConfidence(confidence);
    } else {
      // Fallback to rules if ML prediction fails
      const ruleResult = classifyByRules(body);
      priority = ruleResult.priority;
      reason = ruleResult.reason + ' (ML fallback)';
    }
  } else {
    const ruleResult = classifyByRules(body);
    priority = ruleResult.priority;
    reason = ruleResult.reason;
  }

  // Step 2: Collect training data (always, even in ML mode)
  collectSample(body, priority, getQueueDepths());

  // Step 3: Enqueue
  const result = enqueue(body, priority, reason);

  if (!result.accepted) {
    return res.status(503).json(result);
  }

  // Step 4: Return 202 Accepted immediately
  const response = {
    status: 'queued',
    taskId: result.taskId,
    priority: result.priority,
    reason: result.reason,
    position: result.position,
    queueDepths: result.queueDepths
  };

  if (confidence !== null) {
    response.mlConfidence = confidence;
  }

  return res.status(202).json(response);
});

// ─── GET /queue/status — Current depth of each queue ────────────────────────
app.get('/queue/status', (req, res) => {
  const depths = getQueueDepths();
  const pressure = readSystemPressure();

  res.json({
    queues: {
      priority_1_urgent: depths[1],
      priority_2_normal: depths[2],
      priority_3_low: depths[3],
      total: depths.total
    },
    systemPressure: pressure,
    classificationMode: config.classificationMode,
    mlModelLoaded: isModelLoaded(),
    trainingSamples: getSampleCount()
  });
});

// ─── POST /queue/config — Update forwarding rate and queue limits ────────────
app.post('/queue/config', (req, res) => {
  const applied = updateConfig(req.body);

  if (Object.keys(applied).length === 0) {
    return res.status(400).json({
      error: 'No valid config keys provided',
      validKeys: Object.keys(config)
    });
  }

  res.json({
    message: 'Configuration updated',
    applied,
    currentConfig: { ...config }
  });
});

// ─── GET /queue/stats — Processed per priority, avg wait, rejections ────────
app.get('/queue/stats', (req, res) => {
  const stats = getStats();
  const modelInfo = getModelInfo();

  const response = { ...stats };

  if (modelInfo) {
    response.mlModel = {
      accuracy: modelInfo.accuracy,
      trainingSamples: modelInfo.trainingSamples,
      trainedAt: modelInfo.trainedAt
    };
  }

  response.classificationMode = config.classificationMode;
  response.trainingSamplesCollected = getSampleCount();

  res.json(response);
});

// ─── POST /ml/train — Train the ML model on collected data ──────────────────
app.post('/ml/train', (req, res) => {
  const data = loadTrainingData();

  if (data.length < 30) {
    return res.status(400).json({
      error: `Need at least 30 training samples, have ${data.length}`,
      hint: 'Send more traffic in rules mode to collect training data'
    });
  }

  const result = train(data, req.body || {});
  res.json(result);
});

// ─── POST /ml/switch — Switch between rules and ML mode ─────────────────────
app.post('/ml/switch', (req, res) => {
  const { mode } = req.body;

  if (!['rules', 'ml'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be "rules" or "ml"' });
  }

  if (mode === 'ml' && !isModelLoaded()) {
    return res.status(400).json({
      error: 'No trained model available. Train first via POST /ml/train'
    });
  }

  config.classificationMode = mode;
  res.json({ message: `Switched to ${mode} mode`, mode });
});

// ─── POST /ml/clear — Clear training data for fresh collection ──────────────
app.post('/ml/clear', (req, res) => {
  clearTrainingData();
  resetStats();
  res.json({ message: 'Training data and stats cleared' });
});

// ─── GET /queue/peek — Peek at items in a specific queue ────────────────────
app.get('/queue/peek/:priority', (req, res) => {
  const priority = Number(req.params.priority);
  if (![1, 2, 3].includes(priority)) {
    return res.status(400).json({ error: 'Priority must be 1, 2, or 3' });
  }

  const items = peekQueue(priority, Number(req.query.limit) || 10);
  res.json({ priority, count: items.length, items });
});

// ─── GET /health — Service health check ─────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'priority-queue',
    classificationMode: config.classificationMode,
    mlModelLoaded: isModelLoaded(),
    uptime: process.uptime()
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  // Start the queue processor loop
  startProcessor();

  console.log(`\n🚦 Priority Queue Service listening on port ${PORT}`);
  console.log(`   Mode: ${config.classificationMode}`);
  console.log(`   Forwarding to: ${config.loadBalancerUrl}`);
  console.log(`\n   POST /task             → classify + enqueue (returns 202)`);
  console.log(`   GET  /queue/status      → queue depths`);
  console.log(`   POST /queue/config      → update rate limits`);
  console.log(`   GET  /queue/stats       → per-priority metrics`);
  console.log(`   POST /ml/train          → train ML model`);
  console.log(`   POST /ml/switch         → switch rules ↔ ml mode`);
  console.log(`   GET  /queue/peek/:p     → peek into a queue\n`);
});

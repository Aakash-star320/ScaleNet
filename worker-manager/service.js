const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  spawnWorker,
  getActiveWorkers,
  getAutoscalerState
} = require('./index');

const PORT = Number(process.env.AUTOSCALER_DASHBOARD_PORT) || 3001;
const sessionStartedAt = Date.now();
const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
const decisionLog = path.join(__dirname, '../logs/scaling_decisions.jsonl');

function readSessionDecisions() {
  if (!fs.existsSync(decisionLog)) return [];
  return fs.readFileSync(decisionLog, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(event => event && event.timestamp >= sessionStartedAt)
    .slice(-100)
    .reverse();
}

async function buildState() {
  const [statusRes, metricsRes] = await Promise.all([
    axios.get('http://localhost:3000/status', { timeout: 2000 }),
    axios.get('http://localhost:3000/metrics', { timeout: 2000 })
  ]);

  return {
    timestamp: Date.now(),
    sessionStartedAt,
    autoscaler: getAutoscalerState(),
    pools: statusRes.data,
    metrics: metricsRes.data,
    workers: getActiveWorkers(),
    decisions: readSessionDecisions()
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(dashboardHtml);
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.url === '/api/state') {
    try {
      const state = await buildState();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[Autoscaler Dashboard] http://localhost:${PORT}`);
});

Promise.all([
  spawnWorker('interactive'),
  spawnWorker('compute'),
  spawnWorker('batch')
]).then(workers => {
  console.log(`[WorkerManager] Initial pools ready: ${workers.map(w => w.workerId).join(', ')}`);
}).catch(err => {
  console.error('[WorkerManager] Initial pool startup failed:', err.message);
});


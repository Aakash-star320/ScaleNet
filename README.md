# ScaleNet ⚖️

ScaleNet is a high-performance distributed load management and auto-scaling system. Inspired by cloud infrastructure primitives, it simulates how incoming client requests are handled, distributed, and processed across dynamically scaling backend worker node pools.

## One-command autoscaler demo

With Docker Desktop running and root dependencies installed, launch everything with:

```bash
npm run demo
```

If Windows PowerShell blocks `npm.ps1`, use the equivalent one-command form:

```powershell
npm.cmd run demo
```

This builds the worker image and starts the load balancer, worker manager, autoscaler dashboard, three initial pools, and a continuous compute burst/idle workload. Open `http://localhost:3001` if the dashboard does not open automatically. The workload repeats until `Ctrl+C`; shutdown removes containers labelled as ScaleNet-managed.

The demo uses a 30-second cooldown so scale-up and scale-down can both be observed quickly. The normal default remains 60 seconds.

Run one pool-specific continuous autoscaler test at a time:

```powershell
npm.cmd run test:autoscaler:interactive
npm.cmd run test:autoscaler:batch
```

Each command starts the complete stack and dashboard, runs a 60-second load phase followed by a 120-second idle phase, and repeats until `Ctrl+C`. The load phase should scale that pool up; the idle phase allows buffered or active work to finish before excess containers scale down.

## 🏗 Architecture (v2 - O(1) Push Model)

Traffic flows through the following highly optimized pipeline:
`Client → Load Balancer → O(1) P2C Scheduler → Specialized Worker Pools (Docker)`

### Core Innovations & Components:
* **Load Balancer (API Gateway):** Exposes REST endpoints, ingests tasks, and proxies them to the distributed scheduler.
* **$O(1)$ Event-Driven Scheduler:** Implements a heavily optimized "Power of Two Choices" (P2C) algorithm combined with a Weighted Least Connections approach.
  * Uses a highly efficient `Swap-Tail-Pop` Array and Hashmap synchronization to guarantee $O(1)$ time complexity for enqueueing, dispatching, filtering, and deleting worker states. No full array scans.
* **Push-Based Heartbeat System:** Workers operate entirely autonomously and ping their native identity via `fetch()` heartbeats every 2 seconds. The Load Balancer natively registers instances dynamically. The `scheduler` strictly isolates connection flow metrics natively ensuring state integrity decoupled from container heartbeat lag.
* **Specialized Worker Pools:** Backends are now strictly grouped logically enforcing strict SLAs:
    1. **Interactive Pool**: Real-time SLA. Immediate execution. 200ms harsh deadline enforcement.
    2. **Compute Pool**: Heavy-duty SLA. Processes highly variated arbitrary complexity loads. Throttled based on `utilization = running_total_complexity / capacity`. Strict sleep emulation `1000 + (complexity / 10) * 3000ms`.
    3. **Batch Pool**: Deferred execution SLA. Absorbs bursts into an internal worker buffer queue.
* **Autonomous Rule-Based Autoscaler:** A decoupled worker-manager polls an aggregated-state `GET /status` gateway hook mapping pool utilization bounds every 10 seconds. Dynamically performs asynchronous spawn loops querying nested Container health `GET /health` thresholds inside local bounds, scaling precisely to match real-time system pressure spikes.
  * Batch utilization is estimated as `(scheduler queue + worker buffers + processing requests) / (workers × 50)`.
  * Batch scale-down is considered after one autoscaler check when cooldown has finished, the scheduler queue is empty, outstanding work is not growing, and projected utilization after removing one worker is below 50%.
  * The least-loaded batch worker is removed from routing, finishes its buffered and processing work, and is then removed. Pool limits remain interactive `1–5`, compute `1–4`, and batch `1–3`.
* **Graceful Exit Topology:** During container spin down, the scheduler first removes the worker from eligible routing and the worker stops accepting new work. The manager waits up to 60 seconds for active and buffered work to finish before running `docker rm -f`.
  * If an already-dispatched request reaches a worker after draining begins, the worker returns the machine-readable `WORKER_DRAINING` code. The scheduler marks that worker ineligible and requeues the same request at the front of its pool while preserving its original ID and queue deadline. Draining reroutes are capped at three attempts.
* **Distributed Admission Control**: An intelligent API-Gateway-level circuit breaker calculating aggregated real-time system pressure (`(3i + 2c + 1b)/6`). Gracefully sheds low-priority tasks with intelligent HTTP `503 Retry-After` headers during peak overload before hitting execution queues.
* **Granular Telemetry Pipeline**: Asynchronously streams 5-second interval metric snapshots natively to `logs/metrics.jsonl` tracking rolling latencies, worker limits, and gateway drop ratios.
* **Docker Orchestrator**: Programmatically spins up isolated container topologies locally and binds them back to the host via explicit Docker networking headers (`host.docker.internal`).

## 🚀 How to Run locally via Docker

### 1. Build the Docker Image
Whenever you make a change to the worker logic (`worker/server.js`), you must take a new Docker snapshot:
```bash
cd worker
docker build -t scalenet-worker .
cd ..
```

### 2. Start the Load Balancer
The gateway and scheduler run as a unified native process safely listening for heartbeats.
```bash
node load-balancer/index.js
```

### 3. Spin up the Worker Typology
Run the manager script to spin up the local worker containers and watch them instantly sync with the Load Balancer natively:
```bash
node worker-manager/start-docker-workers.js
```

### 4. Unleash the Load Generator
In a new terminal window, simulate asynchronous cascading HTTP traffic (e.g. 15 requests-per-second until 150 requests are processed):
```bash
node test-traffic.js 15 150
```

*Note: Heavy Compute tasks with excessive requests may beautifully and securely timeout out of the queue after 8000ms if concurrency limits are saturated.*

### 5. Launch the 3D Operations Dashboard
To visualize the real-time cluster state, system pressure, and active queue depths, start the premium Next.js dashboard in another terminal:
```bash
cd next-dashboard
npm run dev
```
Navigate to **http://localhost:3002** in your browser to view the interactive 3D WebGL cluster simulation and live telemetry.

## 🛠 Future Roadmap
- **Traffic Generator Simulation**: Polishing randomized traffic curves implementing ramps, peaks, and exponential regressions to test scaling elasticity natively.
- **ML Predictive Auto-Scaler**: Expanding the active Rule-Based Auto-Scaler loop by injecting an optional localized Python Reinforcement/Q-Learning AI agent for intelligent container pre-warming natively.

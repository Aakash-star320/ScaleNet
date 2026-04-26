"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Server, Zap, ShieldAlert, Cpu, BarChart3, Layers, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, Filler, Tooltip, Legend
} from 'chart.js';
import dynamic from 'next/dynamic';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend);

const NetworkGraph = dynamic(() => import('./components/NetworkGraph'), { ssr: false });

const MAX_HISTORY = 20;

// ─── DATA HOOK ─────────────────────────────────────────────────────────────────
function useScaleNet() {
  const [connected, setConnected] = useState(false);
  const [time, setTime] = useState('--:--:--');
  const [pressure, setPressure] = useState(0);
  const [rps, setRps] = useState(0);
  const [totalRx, setTotalRx] = useState(0);
  const [admission, setAdmission] = useState({ admitted: 0, dropped: 0 });
  const [pools, setPools] = useState({
    interactive: { active: 0, idle: 0, qDepth: 0, workers: [], lat: 0, received: 0, dropped: 0, rejected: 0, pressure: 0 },
    compute:     { active: 0, idle: 0, qDepth: 0, workers: [], lat: 0, received: 0, dropped: 0, rejected: 0, pressure: 0 },
    batch:       { active: 0, idle: 0, qDepth: 0, workers: [], lat: 0, received: 0, dropped: 0, rejected: 0, pressure: 0 }
  });
  const [throughputHistory, setThroughputHistory] = useState({
    labels: Array.from({ length: MAX_HISTORY }, (_, i) => `-${(MAX_HISTORY - i) * 2}s`),
    interactive: new Array(MAX_HISTORY).fill(0),
    compute:     new Array(MAX_HISTORY).fill(0),
    batch:       new Array(MAX_HISTORY).fill(0),
  });
  const [events, setEvents] = useState([]);
  const lastWorkers = useRef(new Set());

  const addEvent = useCallback((type, msg, color) => {
    const t = new Date().toTimeString().slice(0, 8);
    setEvents(prev => [{ time: t, type, msg, color }, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    const tick = () => setTime(new Date().toTimeString().slice(0, 8));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fetch_ = async () => {
      try {
        const [mRes, qRes] = await Promise.all([
          fetch('http://localhost:3000/metrics').catch(() => null),
          fetch('http://localhost:3000/queue').catch(() => null),
        ]);

        if (!mRes?.ok || !qRes?.ok) { setConnected(false); return; }
        setConnected(true);

        const m = await mRes.json();
        const q = await qRes.json();

        const sys = m.system || {};
        const wp = sys.weightedPressure ?? 0;
        setPressure(wp);
        setRps(Math.round((sys.totalReceivedThisInterval || 0) / 2));
        if (sys.lifetimeReceived != null) {
          setTotalRx(sys.lifetimeReceived);
          setAdmission({ admitted: sys.lifetimeReceived - sys.lifetimeDropped, dropped: sys.lifetimeDropped });
        }

        const types = ['interactive', 'compute', 'batch'];
        const currentWorkers = new Set();

        setPools(prev => {
          const next = { ...prev };
          for (const t of types) {
            const pm = m[t] || {};
            next[t] = {
              ...prev[t],
              qDepth:   pm.queueDepth    ?? prev[t].qDepth,
              active:   pm.activeWorkers  ?? prev[t].active,
              idle:     pm.idleWorkers    ?? prev[t].idle,
              lat:      pm.avgLatency     ?? prev[t].lat,
              received: pm.receivedThisInterval ?? prev[t].received,
              dropped:  pm.droppedByAdmission   ?? prev[t].dropped,
              rejected: pm.rejectedByWorkers     ?? prev[t].rejected,
              pressure: pm.pressure ?? prev[t].pressure,
            };
            if (q.workerPools?.[t]) {
              next[t].workers = q.workerPools[t].map(w => {
                currentWorkers.add(w.id);
                return { id: w.id, busy: w.active > 0, drain: !w.healthy, cap: w.cap, complexity: w.runningTotalComplexity };
              });
            }
          }
          return next;
        });

        // Worker up/down events
        for (const id of currentWorkers) {
          if (!lastWorkers.current.has(id)) addEvent('WORKER UP', `${id} joined cluster`, '#00e5a0');
        }
        for (const id of lastWorkers.current) {
          if (!currentWorkers.has(id)) addEvent('WORKER DOWN', `${id} left cluster`, '#ffb800');
        }
        lastWorkers.current = currentWorkers;

        const dropped = sys.totalDroppedThisInterval || 0;
        if (dropped > 0) addEvent('503 SHED', `Dropped ${dropped} req · pressure ${wp.toFixed(2)}`, '#ff4060');

        setThroughputHistory(prev => ({
          ...prev,
          interactive: [...prev.interactive.slice(1), Math.round((m.interactive?.receivedThisInterval || 0) / 2)],
          compute:     [...prev.compute.slice(1),     Math.round((m.compute?.receivedThisInterval    || 0) / 2)],
          batch:       [...prev.batch.slice(1),       Math.round((m.batch?.receivedThisInterval      || 0) / 2)],
        }));

      } catch (e) { setConnected(false); }
    };
    fetch_();
    const id = setInterval(fetch_, 2000);
    return () => clearInterval(id);
  }, [addEvent]);

  return { connected, time, pressure, rps, totalRx, admission, pools, throughputHistory, events };
}

// ─── SMALL HELPERS ─────────────────────────────────────────────────────────────
const pressureColor = p => p > 0.9 ? '#ff4060' : p > 0.7 ? '#ffb800' : '#00e5a0';
const fmt = (n, d = 0) => n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ─── WORKER NODE COMPONENT ──────────────────────────────────────────────────────
function WorkerNode({ w, color }) {
  const cls = w.drain ? 'drain' : w.busy ? 'busy' : 'idle';
  const bg = w.drain ? 'rgba(255,64,96,0.12)' : w.busy ? `${color}22` : 'rgba(255,255,255,0.04)';
  const border = w.drain ? 'rgba(255,64,96,0.4)' : w.busy ? `${color}66` : 'rgba(255,255,255,0.1)';
  const shadow = w.busy ? `0 0 10px ${color}55` : 'none';
  const dot = w.drain ? '#ff4060' : w.busy ? color : 'rgba(255,255,255,0.2)';

  return (
    <div
      className={`worker-node ${cls}`}
      title={`${w.id}${w.cap ? ` · cap ${w.cap}` : ''}${w.complexity ? ` · complexity ${w.complexity}` : ''}`}
      style={{ background: bg, borderColor: border, boxShadow: shadow }}
    >
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot,
        boxShadow: w.busy ? `0 0 6px ${color}` : 'none' }} />
    </div>
  );
}

// ─── QUEUE BAR ──────────────────────────────────────────────────────────────────
function QueueBar({ depth, max, color }) {
  const pct = Math.min(100, (depth / max) * 100);
  return (
    <div className="queue-row">
      <div className="queue-label-row">
        <span>Queue depth</span>
        <span>{depth} / {max}</span>
      </div>
      <div className="queue-track">
        <div className="queue-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ─── POOL CARD ──────────────────────────────────────────────────────────────────
function PoolCard({ title, data, color, maxQ, algo, sla }) {
  const totalN = data.workers.length;
  return (
    <div className="card">
      <div className="pool-card-inner">
        <div className="pool-header">
          <div className="pool-title">
            <div className="pool-dot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
            {title}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="pool-badge" style={{ background: `${color}18`, color, border: `1px solid ${color}33` }}>{algo}</span>
            {sla && <span className="pool-badge" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--muted)', border: '1px solid var(--border)' }}>{sla}</span>}
          </div>
        </div>

        <div className="worker-grid">
          {data.workers.length > 0
            ? data.workers.map(w => <WorkerNode key={w.id} w={w} color={color} />)
            : <span style={{ fontSize: '0.75rem', color: 'var(--muted)', alignSelf: 'center' }}>No workers registered</span>
          }
        </div>

        <QueueBar depth={data.qDepth} max={maxQ} color={color} />

        <div className="pool-stats-row">
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: '#00e5a0' }}>{data.active}</div>
            <div className="pool-stat-lbl">Active</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: 'rgba(255,255,255,0.5)' }}>{data.idle}</div>
            <div className="pool-stat-lbl">Idle</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color }}>{data.lat > 0 ? `${data.lat}ms` : '—'}</div>
            <div className="pool-stat-lbl">Avg Lat</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: 'rgba(255,255,255,0.7)' }}>{totalN}</div>
            <div className="pool-stat-lbl">Nodes</div>
          </div>
        </div>

        <div className="pool-stats-row" style={{ marginTop: -4 }}>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: 'rgba(255,255,255,0.6)', fontSize: '1rem' }}>{data.received}</div>
            <div className="pool-stat-lbl">Rx/5s</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: '#ff4060', fontSize: '1rem' }}>{data.dropped}</div>
            <div className="pool-stat-lbl">Shed</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color: '#ffb800', fontSize: '1rem' }}>{data.rejected}</div>
            <div className="pool-stat-lbl">Reject</div>
          </div>
          <div className="pool-stat">
            <div className="pool-stat-val" style={{ color, fontSize: '1rem' }}>{(data.pressure * 100).toFixed(0)}%</div>
            <div className="pool-stat-lbl">Pressure</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── THROUGHPUT CHART ────────────────────────────────────────────────────────────
function ThroughputChart({ history }) {
  const data = {
    labels: history.labels,
    datasets: [
      { label: 'Interactive', data: history.interactive, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.06)', fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 },
      { label: 'Compute',     data: history.compute,     borderColor: '#b06eff', backgroundColor: 'rgba(176,110,255,0.06)', fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 },
      { label: 'Batch',       data: history.batch,       borderColor: '#ffb800', backgroundColor: 'rgba(255,184,0,0.06)',   fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 },
    ]
  };
  const opts = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
    scales: {
      x: { display: false },
      y: { display: true, ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 10, family: 'JetBrains Mono' }, maxTicksLimit: 4 }, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false } }
    }
  };
  return <Line data={data} options={opts} />;
}

// ─── LATENCY CHART ───────────────────────────────────────────────────────────────
function LatencyChart({ pools }) {
  const data = {
    labels: ['Interactive', 'Compute', 'Batch'],
    datasets: [{
      data: [pools.interactive.lat, pools.compute.lat, pools.batch.lat],
      backgroundColor: ['rgba(0,212,255,0.5)', 'rgba(176,110,255,0.5)', 'rgba(255,184,0,0.5)'],
      borderColor:     ['#00d4ff', '#b06eff', '#ffb800'],
      borderWidth: 1, borderRadius: 6, borderSkipped: false
    }]
  };
  const opts = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw}ms` } } },
    scales: {
      x: { ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }, grid: { display: false }, border: { display: false } },
      y: { ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 10, family: 'JetBrains Mono' }, maxTicksLimit: 4, callback: v => v >= 1000 ? `${(v/1000).toFixed(1)}s` : `${v}ms` }, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false } }
    }
  };
  return <Bar data={data} options={opts} />;
}

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { connected, time, pressure, rps, totalRx, admission, pools, throughputHistory, events } = useScaleNet();
  const totalWorkers = Object.values(pools).reduce((a, p) => a + p.workers.length, 0);
  const dropRate = admission.admitted + admission.dropped > 0
    ? ((admission.dropped / (admission.admitted + admission.dropped)) * 100).toFixed(1)
    : '0.0';

  const pColor = pressureColor(pressure);

  return (
    <div className="shell">
      <NetworkGraph state={{ pressure, rps, pools }} />
      <div className="ui-layer">
        <div className="content">

          {/* ── TOPBAR ── */}
          <div className="topbar">
            <div className="logo-wrap">
              <div className="logo-gem">
                <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
                  <polygon points="21,4 38,14 38,28 21,38 4,28 4,14" fill="rgba(0,212,255,0.12)" stroke="#00d4ff" strokeWidth="1.2" />
                  <polygon points="21,10 32,17 32,27 21,34 10,27 10,17" fill="rgba(176,110,255,0.15)" stroke="#b06eff" strokeWidth="0.8" />
                  <circle cx="21" cy="21" r="4" fill="#00d4ff" opacity="0.9" />
                </svg>
              </div>
              <div>
                <div className="logo-title">ScaleNet</div>
                <div className="logo-subtitle">Operations Center</div>
              </div>
            </div>
            <div className="topbar-right">
              <div className="algo-pill">P2C / WLC / RR</div>
              <div className="time-badge">{time}</div>
              <div className={`status-pill ${connected ? 'live' : 'dead'}`}>
                <div className={`pulse ${connected ? 'green' : 'red'}`} />
                {connected ? 'Live' : 'Disconnected'}
              </div>
            </div>
          </div>

          {/* ── KPI ROW ── */}
          <div className="kpi-grid">
            {[
              { label: 'System Pressure', value: pressure.toFixed(2), sub: 'Weighted 3i+2c+b / 6', color: pColor, bar: pressure },
              { label: 'Requests / sec', value: fmt(rps), sub: 'Rolling 2s interval', color: '#00d4ff', bar: Math.min(rps / 100, 1) },
              { label: 'Active Workers', value: fmt(totalWorkers), sub: `${Object.values(pools).reduce((a,p)=>a+p.active,0)} busy · ${Object.values(pools).reduce((a,p)=>a+p.idle,0)} idle`, color: '#b06eff', bar: totalWorkers / 12 },
              { label: 'Drop Rate', value: `${dropRate}%`, sub: `${fmt(admission.dropped)} shed / ${fmt(totalRx)} total`, color: parseFloat(dropRate) > 5 ? '#ff4060' : '#00e5a0', bar: parseFloat(dropRate) / 100 },
              { label: 'Lifetime Req', value: fmt(totalRx), sub: `${fmt(admission.admitted)} admitted`, color: '#ffb800', bar: 1 },
            ].map(({ label, value, sub, color, bar }) => (
              <div key={label} className="card">
                <div className="card-label">{label}</div>
                <div className="kpi-value" style={{ color }}>{value}</div>
                <div className="kpi-sub">{sub}</div>
                <div className="kpi-bar">
                  <div className="kpi-bar-fill" style={{ width: `${Math.min(100, bar * 100)}%`, background: color }} />
                </div>
              </div>
            ))}
          </div>

          {/* ── POOL CARDS ── */}
          <div className="section-label">Worker Pools</div>
          <div className="pool-grid">
            <PoolCard title="Interactive" data={pools.interactive} color="#00d4ff" maxQ={50}  algo="P2C" sla="200ms SLA" />
            <PoolCard title="Compute"     data={pools.compute}     color="#b06eff" maxQ={100} algo="WLC + Complexity" />
            <PoolCard title="Batch"       data={pools.batch}       color="#ffb800" maxQ={500} algo="Round-Robin" sla="Deferred" />
          </div>

          {/* ── CHARTS + PQ + ADMISSION + EVENTS ── */}
          <div className="section-label">Live Telemetry</div>
          <div className="bottom-grid">

            {/* Throughput + Latency */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="card">
                <div className="card-label">
                  Throughput (req/s)
                  <span style={{ fontFamily: 'JetBrains Mono', color: '#00d4ff', fontSize: '0.78rem' }}>{rps} rps</span>
                </div>
                <div className="chart-wrap"><ThroughputChart history={throughputHistory} /></div>
                <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '0.72rem' }}>
                  {[['Interactive','#00d4ff'],['Compute','#b06eff'],['Batch','#ffb800']].map(([l, c]) => (
                    <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}>
                      <span style={{ width: 20, height: 2, background: c, display: 'inline-block', borderRadius: 1 }} />{l}
                    </span>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="card-label">
                  Avg Latency per Pool
                  <span style={{ fontFamily: 'JetBrains Mono', color: 'var(--muted)', fontSize: '0.72rem' }}>ms</span>
                </div>
                <div className="chart-wrap"><LatencyChart pools={pools} /></div>
              </div>
            </div>

            {/* Admission Control */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="card">
                <div className="card-label"><span>Admission Control</span><ShieldAlert size={14} color="#ff4060" /></div>
                <div className="adm-row">
                  <div className="adm-block">
                    <div className="adm-num" style={{ color: '#00e5a0' }}>{fmt(admission.admitted)}</div>
                    <div className="adm-lbl">Admitted</div>
                  </div>
                  <div className="adm-block">
                    <div className="adm-num" style={{ color: '#ff4060' }}>{fmt(admission.dropped)}</div>
                    <div className="adm-lbl">Shed (503)</div>
                  </div>
                </div>
                <div className="pressure-thresholds">
                  <div className="card-label" style={{ marginBottom: 0, marginTop: 12 }}>Pressure Thresholds</div>
                  {[
                    { name: 'batch', pct: 70,  label: '70% shed batch' },
                    { name: 'comp.', pct: 90,  label: '90% shed compute+batch' },
                    { name: 'all',   pct: 95,  label: '95% shed all' },
                  ].map(({ name, pct, label }) => (
                    <div className="thr-row" key={name} title={label}>
                      <span className="thr-name">{name}</span>
                      <div className="thr-track">
                        <div className="thr-fill" style={{ width: `${Math.min(100, pressure * 100)}%`, background: pColor }} />
                        <div className="thr-marker" style={{ left: `${pct}%` }} />
                      </div>
                      <span className="thr-val">{(pressure * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card" style={{ flex: 1 }}>
                <div className="card-label"><span>Pool Pressure Breakdown</span></div>
                {[['Interactive','#00d4ff',pools.interactive.pressure],['Compute','#b06eff',pools.compute.pressure],['Batch','#ffb800',pools.batch.pressure]].map(([l,c,p]) => (
                  <div key={l} style={{ marginBottom: 10 }}>
                    <div className="queue-label-row" style={{ marginBottom: 4 }}>
                      <span style={{ color: c, fontWeight: 600 }}>{l}</span>
                      <span>{(p * 100).toFixed(0)}%</span>
                    </div>
                    <div className="queue-track">
                      <div className="queue-fill" style={{ width: `${Math.min(100, p * 100)}%`, background: c }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Event Log */}
            <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-label">
                <span>System Events</span>
                <span style={{ fontFamily: 'JetBrains Mono', fontSize: '0.68rem', color: 'var(--muted)' }}>{events.length} logged</span>
              </div>
              <div className="event-log" style={{ flex: 1 }}>
                {events.length === 0 && (
                  <div style={{ color: 'var(--muted)', fontSize: '0.8rem', fontStyle: 'italic', padding: '8px 0' }}>
                    Waiting for events…
                  </div>
                )}
                {events.map((e, i) => (
                  <div key={i} className="event-item">
                    <span className="event-time">{e.time}</span>
                    <span className="event-type-badge" style={{ background: `${e.color}22`, color: e.color, border: `1px solid ${e.color}33` }}>{e.type}</span>
                    <span className="event-msg">{e.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

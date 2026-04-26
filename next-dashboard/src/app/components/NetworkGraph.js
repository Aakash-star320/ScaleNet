"use client";

import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Sparkles, Sphere, MeshDistortMaterial, Stars } from '@react-three/drei';
import * as THREE from 'three';

// ─── Orbital ring (visible track) ─────────────────────────────────────────────
function RingTrack({ radius, color }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[radius - 0.04, radius + 0.04, 128]} />
      <meshBasicMaterial color={color} transparent opacity={0.06} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ─── Single orbiting worker ────────────────────────────────────────────────────
function WorkerNode({ radius, angleOffset, speed, isBusy, isDrain, color }) {
  const ref = useRef();
  const trailRef = useRef([]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    const angle = t * speed + angleOffset;
    ref.current.position.x = radius * Math.cos(angle);
    ref.current.position.z = radius * Math.sin(angle);
    ref.current.position.y = Math.sin(t * 0.5 + angleOffset) * 0.3;
  });

  const nodeColor = isDrain ? '#ff4060' : color;
  const emissiveInt = isBusy ? 3 : 0.5;
  const scale = isDrain ? 0.25 : isBusy ? 0.55 : 0.4;

  return (
    <Sphere ref={ref} args={[scale, 24, 24]}>
      <meshStandardMaterial
        color={nodeColor}
        emissive={nodeColor}
        emissiveIntensity={emissiveInt}
        roughness={0.3}
        metalness={0.4}
        toneMapped={false}
      />
    </Sphere>
  );
}

// ─── Core LB node ─────────────────────────────────────────────────────────────
function CoreNode({ pressure }) {
  const ref = useRef();
  const color = useMemo(() => {
    const c = new THREE.Color();
    c.lerpColors(new THREE.Color('#00e5a0'), new THREE.Color('#ff4060'), Math.min(pressure, 1));
    return c;
  }, [pressure]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    const rate = 1 + pressure * 4;
    const s = 1.4 + Math.sin(t * rate) * 0.12 * (1 + pressure);
    ref.current.scale.setScalar(s);
    ref.current.rotation.y += 0.008 * rate;
    ref.current.rotation.x += 0.004 * rate;
  });

  return (
    <>
      <pointLight intensity={3 + pressure * 5} distance={20} color={color} />
      <Sphere ref={ref} args={[1, 80, 80]} position={[0, 0, 0]}>
        <MeshDistortMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.6 + pressure * 2}
          distort={0.25 + pressure * 0.35}
          speed={2.5 + pressure * 6}
          roughness={0.15}
          metalness={0.3}
          toneMapped={false}
        />
      </Sphere>
    </>
  );
}

// ─── Connection lines between core and worker rings ─────────────────────────
function ConnectionLines({ workers, radius, color, speed }) {
  const linesRef = useRef();

  useFrame(({ clock }) => {
    if (!linesRef.current) return;
    workers.forEach((w, i) => {
      const angle = clock.elapsedTime * speed + (i * (Math.PI * 2) / workers.length);
      const x = radius * Math.cos(angle);
      const z = radius * Math.sin(angle);
      const arr = linesRef.current.geometry.attributes.position.array;
      // Start (core center)
      arr[i * 6 + 0] = 0; arr[i * 6 + 1] = 0; arr[i * 6 + 2] = 0;
      // End (worker position)
      arr[i * 6 + 3] = x; arr[i * 6 + 4] = 0; arr[i * 6 + 5] = z;
      linesRef.current.geometry.attributes.position.needsUpdate = true;
    });
  });

  if (workers.length === 0) return null;

  const positions = new Float32Array(workers.length * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  return (
    <lineSegments ref={linesRef} geometry={geo}>
      <lineBasicMaterial color={color} transparent opacity={workers.some(w => w.busy) ? 0.15 : 0.05} />
    </lineSegments>
  );
}

// ─── Worker ring ──────────────────────────────────────────────────────────────
function WorkerRing({ workers, radius, color, speed }) {
  if (workers.length === 0) return null;
  const step = (Math.PI * 2) / Math.max(workers.length, 1);
  return (
    <group>
      <RingTrack radius={radius} color={color} />
      <ConnectionLines workers={workers} radius={radius} color={color} speed={speed} />
      {workers.map((w, i) => (
        <WorkerNode
          key={w.id}
          radius={radius}
          angleOffset={i * step}
          speed={speed}
          isBusy={w.busy}
          isDrain={w.drain}
          color={color}
        />
      ))}
    </group>
  );
}

// ─── Main 3D scene ────────────────────────────────────────────────────────────
function Scene({ state }) {
  const { pressure, rps, pools } = state;

  return (
    <>
      <color attach="background" args={['#03050a']} />
      <fog attach="fog" args={['#03050a', 14, 35]} />

      <ambientLight intensity={0.15} />

      {/* Deep-field stars */}
      <Stars radius={80} depth={60} count={2000} factor={3} saturation={0} fade speed={0.3} />

      {/* Ambient floating particles representing traffic */}
      <Sparkles count={Math.max(20, (rps || 0) * 8)} scale={30} size={1.5} speed={0.3} opacity={0.25} color="#ffffff" />

      {/* Hot pink sparkles on high pressure */}
      {pressure > 0.7 && (
        <Sparkles count={40} scale={8} size={3} speed={1} opacity={0.4} color="#ff4060" />
      )}

      {/* Central load balancer */}
      <CoreNode pressure={pressure} />

      {/* Pool rings */}
      <WorkerRing workers={pools.interactive.workers} radius={4.5} color="#00d4ff" speed={0.7} />
      <WorkerRing workers={pools.compute.workers}     radius={7.5} color="#b06eff" speed={0.38} />
      <WorkerRing workers={pools.batch.workers}       radius={11}  color="#ffb800" speed={0.2} />

      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={6}
        maxDistance={28}
        autoRotate
        autoRotateSpeed={0.4}
        enableDamping
        dampingFactor={0.05}
      />
    </>
  );
}

// ─── Canvas wrapper ─────────────────────────────────────────────────────────
export default function NetworkGraph({ state }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0 }}>
      <Canvas camera={{ position: [0, 9, 18], fov: 55 }} dpr={[1, 2]}>
        <Scene state={state} />
      </Canvas>
    </div>
  );
}

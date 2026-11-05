import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minus, Pause, Play, Plus } from 'lucide-react';
import type { VaultGraph } from '../../lib/vault-api';

interface SimNode {
  id: string;
  title: string;
  folder: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ring: number;
  hue: number;
  degree: number;
  fixed: boolean;
  nbrs: number[];
}

interface Props {
  graph: VaultGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  highlightedIds: ReadonlySet<string>;
  query: string;
  active: boolean;
}

const RING_GAP = 22;
const CORE_RADIUS = 34;
const CELL = 56;
const MIN_K = 0.15;
const MAX_K = 6;
const HUES = [190, 196, 202, 184, 208, 178];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNodes(graph: VaultGraph): { nodes: SimNode[]; edges: Array<[number, number]>; rings: number } {
  const order = [...graph.nodes].sort((a, b) => b.degree - a.degree);
  const n = order.length;
  const rings = Math.min(22, Math.max(6, Math.ceil(Math.sqrt(n) / 1.8)));
  const folders = new Map<string, number>();
  const nodes: SimNode[] = order.map((v, rank) => {
    const rnd = rand(hash(v.id));
    const ring = Math.min(rings - 1, Math.floor(Math.pow(rank / Math.max(n, 1), 0.75) * rings));
    const radius = CORE_RADIUS * 2 + ring * RING_GAP;
    const angle = rnd() * Math.PI * 2;
    if (!folders.has(v.folder)) folders.set(v.folder, folders.size);
    return {
      id: v.id,
      title: v.title,
      folder: v.folder,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: 1.6 + Math.sqrt(v.degree) * 0.9,
      ring,
      hue: HUES[(folders.get(v.folder) ?? 0) % HUES.length],
      degree: v.degree,
      fixed: false,
      nbrs: [],
    };
  });
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const edges: Array<[number, number]> = [];
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) continue;
    edges.push([a, b]);
    nodes[a].nbrs.push(b);
    nodes[b].nbrs.push(a);
  }
  return { nodes, edges, rings };
}

function makeSprite(hue: number, light: number, sat = 90): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `hsla(${hue}, ${sat}%, ${Math.min(96, light + 25)}%, 1)`);
  grad.addColorStop(0.18, `hsla(${hue}, ${sat}%, ${light}%, 0.95)`);
  grad.addColorStop(0.45, `hsla(${hue}, ${sat}%, ${light - 8}%, 0.28)`);
  grad.addColorStop(1, `hsla(${hue}, ${sat}%, ${light - 12}%, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function KnowledgeGraph({ graph, selectedId, onSelect, highlightedIds, query, active }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [spin, setSpin] = useState(
    () => typeof window === 'undefined' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);

  const sim = useRef({
    nodes: [] as SimNode[],
    edges: [] as Array<[number, number]>,
    index: new Map<string, number>(),
    rings: 6,
    hubs: [] as number[],
    alpha: 1,
    cam: { x: 0, y: 0, k: 1, rot: 0 },
    focusTarget: null as { x: number; y: number } | null,
    hover: -1,
    drag: null as null | { kind: 'node' | 'pan'; i: number; sx: number; sy: number; moved: number },
    dirty: true,
    size: { w: 0, h: 0, dpr: 1 },
  });
  const props = useRef({ selectedId, highlightedIds, query, active, spin, onSelect });
  props.current = { selectedId, highlightedIds, query, active, spin, onSelect };
  const sprites = useRef<{ gold: HTMLCanvasElement[]; hit: HTMLCanvasElement; sel: HTMLCanvasElement } | null>(null);
  const fromCanvas = useRef(false);

  // Rebuild the simulation whenever the vault data changes.
  useEffect(() => {
    const s = sim.current;
    const built = graph ? buildNodes(graph) : { nodes: [], edges: [], rings: 6 };
    s.nodes = built.nodes;
    s.edges = built.edges;
    s.rings = built.rings;
    s.index = new Map(built.nodes.map((node, i) => [node.id, i]));
    s.hubs = built.nodes
      .map((_, i) => i)
      .sort((a, b) => built.nodes[b].degree - built.nodes[a].degree)
      .slice(0, 25);
    s.alpha = 1;
    s.hover = -1;
    for (let i = 0; i < 60; i++) tick(s);
    s.dirty = true;
  }, [graph]);

  useEffect(() => {
    const s = sim.current;
    s.dirty = true;
    const i = selectedId ? s.index.get(selectedId) : undefined;
    if (i === undefined) {
      s.focusTarget = null;
      return;
    }
    if (fromCanvas.current) {
      fromCanvas.current = false;
      return;
    }
    s.focusTarget = { x: s.nodes[i].x, y: s.nodes[i].y };
  }, [selectedId]);

  useEffect(() => {
    sim.current.dirty = true;
  }, [highlightedIds, query, active]);

  const toWorld = useCallback((sx: number, sy: number) => {
    const { cam, size } = sim.current;
    const px = sx - size.w / 2 - cam.x;
    const py = sy - size.h / 2 - cam.y;
    const c = Math.cos(-cam.rot);
    const sn = Math.sin(-cam.rot);
    return { x: (px * c - py * sn) / cam.k, y: (px * sn + py * c) / cam.k };
  }, []);

  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    const s = sim.current;
    const p = toWorld(sx, sy);
    const k = Math.min(MAX_K, Math.max(MIN_K, s.cam.k * factor));
    const c = Math.cos(s.cam.rot);
    const sn = Math.sin(s.cam.rot);
    s.cam.x = sx - s.size.w / 2 - (p.x * c - p.y * sn) * k;
    s.cam.y = sy - s.size.h / 2 - (p.x * sn + p.y * c) * k;
    s.cam.k = k;
    s.focusTarget = null;
    s.dirty = true;
  }, [toWorld]);

  const resetView = useCallback(() => {
    const s = sim.current;
    s.cam.x = 0;
    s.cam.y = 0;
    s.cam.k = 1;
    s.focusTarget = null;
    s.dirty = true;
  }, []);

  // Canvas sizing, render loop, input handlers.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = sim.current;

    sprites.current = {
      gold: HUES.map((h) => makeSprite(h, 62)),
      hit: makeSprite(42, 62, 95),
      sel: makeSprite(190, 86, 100),
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      s.size = { w, h, dpr };
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      s.dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = props.current;
      let needs = s.dirty || s.alpha > 0.02 || p.active || p.highlightedIds.size > 0;

      const paused = s.hover >= 0 || s.drag !== null || p.selectedId !== null;
      if (p.spin && !paused) {
        s.cam.rot += dt * 0.02;
        needs = true;
      }
      if (s.alpha > 0.02) tick(s);

      if (s.focusTarget) {
        const c = Math.cos(s.cam.rot);
        const sn = Math.sin(s.cam.rot);
        const tx = -(s.focusTarget.x * c - s.focusTarget.y * sn) * s.cam.k;
        const ty = -(s.focusTarget.x * sn + s.focusTarget.y * c) * s.cam.k;
        s.cam.x += (tx - s.cam.x) * 0.16;
        s.cam.y += (ty - s.cam.y) * 0.16;
        if (Math.abs(tx - s.cam.x) + Math.abs(ty - s.cam.y) < 0.5) s.focusTarget = null;
        needs = true;
      }
      if (!needs) return;
      s.dirty = false;
      draw(ctx, s, p, sprites.current!, now);
    };
    raf = requestAnimationFrame(frame);

    const rect = () => canvas.getBoundingClientRect();
    const hit = (sx: number, sy: number) => {
      const w = toWorld(sx, sy);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i];
        const reach = Math.max(n.r * 1.8, 8 / s.cam.k);
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        if (d < reach && d < bestD) {
          best = i;
          bestD = d;
        }
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      const r = rect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const i = hit(sx, sy);
      s.drag = { kind: i >= 0 ? 'node' : 'pan', i, sx: e.clientX, sy: e.clientY, moved: 0 };
      if (i >= 0) s.nodes[i].fixed = true;
      s.focusTarget = null;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const r = rect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const d = s.drag;
      if (d) {
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        d.moved += Math.abs(dx) + Math.abs(dy);
        d.sx = e.clientX;
        d.sy = e.clientY;
        if (d.kind === 'pan') {
          s.cam.x += dx;
          s.cam.y += dy;
        } else if (d.moved > 4) {
          const w = toWorld(sx, sy);
          const n = s.nodes[d.i];
          n.x = w.x;
          n.y = w.y;
          n.vx = n.vy = 0;
          s.alpha = Math.max(s.alpha, 0.35);
        }
        s.dirty = true;
        return;
      }
      const i = hit(sx, sy);
      if (i !== s.hover) {
        s.hover = i;
        s.dirty = true;
        canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
        setTip(i >= 0 ? { id: s.nodes[i].id, x: sx, y: sy } : null);
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = s.drag;
      s.drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (!d) return;
      if (d.kind === 'node') s.nodes[d.i].fixed = false;
      if (d.moved <= 4) {
        fromCanvas.current = true;
        props.current.onSelect(d.i >= 0 ? s.nodes[d.i].id : null);
      }
      s.dirty = true;
    };
    const onLeave = () => {
      if (s.hover !== -1) {
        s.hover = -1;
        s.dirty = true;
        setTip(null);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    const onDouble = () => resetView();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDouble);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDouble);
    };
  }, [toWorld, zoomAt, resetView]);

  const tipNode = tip ? graph?.nodes.find((n) => n.id === tip.id) : undefined;
  const center = () => ({ x: sim.current.size.w / 2, y: sim.current.size.h / 2 });

  return (
    <div ref={wrapRef} className="kg-wrap">
      <canvas ref={canvasRef} className="kg-canvas" style={{ cursor: 'grab' }} />
      {tip && tipNode && (
        <div className="kg-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tipNode.title}</strong>
          <span>{tipNode.folder} · {tipNode.degree} {tipNode.degree === 1 ? 'conexão' : 'conexões'}</span>
        </div>
      )}
      <div className="kg-controls">
        <button onClick={() => zoomAt(1.25, center().x, center().y)} title="Aproximar"><Plus size={15} /></button>
        <button onClick={() => zoomAt(0.8, center().x, center().y)} title="Afastar"><Minus size={15} /></button>
        <button onClick={resetView} title="Recentralizar"><Maximize2 size={13} /></button>
        <button onClick={() => setSpin((v) => !v)} title={spin ? 'Pausar rotação' : 'Retomar rotação'}>
          {spin ? <Pause size={13} /> : <Play size={13} />}
        </button>
      </div>
    </div>
  );
}

type Sim = {
  nodes: SimNode[];
  edges: Array<[number, number]>;
  rings: number;
  alpha: number;
};

function tick(s: Sim) {
  const { nodes, edges } = s;
  const a = s.alpha;

  for (const [i, j] of edges) {
    const p = nodes[i];
    const q = nodes[j];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = ((d - 46) / d) * 0.012 * a;
    if (!p.fixed) { p.vx += dx * f; p.vy += dy * f; }
    if (!q.fixed) { q.vx -= dx * f; q.vy -= dy * f; }
  }

  const grid = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const key = Math.floor(nodes[i].x / CELL) * 73856093 ^ Math.floor(nodes[i].y / CELL) * 19349663;
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  }
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cell = grid.get((cx + ox) * 73856093 ^ (cy + oy) * 19349663);
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const q = nodes[j];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d >= CELL) continue;
          const push = (1 - d / CELL) * 1.2 * a;
          const ux = d > 0.01 ? dx / d : 1;
          const uy = d > 0.01 ? dy / d : 0;
          if (!p.fixed) { p.vx -= ux * push; p.vy -= uy * push; }
          if (!q.fixed) { q.vx += ux * push; q.vy += uy * push; }
        }
      }
    }
  }

  for (const n of nodes) {
    if (n.fixed) continue;
    const d = Math.hypot(n.x, n.y) || 1;
    const target = CORE_RADIUS * 2 + n.ring * RING_GAP;
    const f = ((target - d) / d) * 0.06;
    n.vx += n.x * f;
    n.vy += n.y * f;
    n.vx *= 0.78;
    n.vy *= 0.78;
    n.x += n.vx;
    n.y += n.vy;
  }
  s.alpha *= 0.985;
}

interface DrawProps {
  selectedId: string | null;
  highlightedIds: ReadonlySet<string>;
  query: string;
  active: boolean;
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: {
    nodes: SimNode[];
    edges: Array<[number, number]>;
    rings: number;
    hubs: number[];
    index: Map<string, number>;
    hover: number;
    cam: { x: number; y: number; k: number; rot: number };
    size: { w: number; h: number; dpr: number };
  },
  p: DrawProps,
  sp: { gold: HTMLCanvasElement[]; hit: HTMLCanvasElement; sel: HTMLCanvasElement },
  now: number,
) {
  const { w, h, dpr } = s.size;
  const { k, rot } = s.cam;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2 + s.cam.x, h / 2 + s.cam.y);
  ctx.rotate(rot);
  ctx.scale(k, k);

  const pulse = 0.5 + 0.5 * Math.sin(now / 420);

  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = 'rgba(91, 204, 242, 0.06)';
  ctx.beginPath();
  for (let r = 0; r < s.rings; r++) {
    const rad = CORE_RADIUS * 2 + r * RING_GAP;
    ctx.moveTo(rad, 0);
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
  }
  ctx.stroke();

  const glow = ctx.createRadialGradient(0, 0, CORE_RADIUS, 0, 0, CORE_RADIUS * 4.2);
  glow.addColorStop(0, `rgba(34, 211, 238, ${0.3 + (p.active ? pulse * 0.2 : 0)})`);
  glow.addColorStop(1, 'rgba(34, 211, 238, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, CORE_RADIUS * 4.2, 0, Math.PI * 2);
  ctx.fill();

  const focus = p.selectedId !== null ? s.index.get(p.selectedId) ?? -1 : s.hover;
  const focusSet = new Set<number>();
  if (focus >= 0) {
    focusSet.add(focus);
    for (const j of s.nodes[focus].nbrs) focusSet.add(j);
  }
  const q = p.query.trim().toLowerCase();
  const matches = (n: SimNode) => !q || n.title.toLowerCase().includes(q) || n.folder.toLowerCase().includes(q);

  ctx.strokeStyle = s.edges.length > 2500 ? 'rgba(91, 204, 242, 0.05)' : 'rgba(91, 204, 242, 0.12)';
  ctx.beginPath();
  for (const [i, j] of s.edges) {
    ctx.moveTo(s.nodes[i].x, s.nodes[i].y);
    ctx.lineTo(s.nodes[j].x, s.nodes[j].y);
  }
  ctx.stroke();

  if (focus >= 0) {
    ctx.strokeStyle = 'rgba(150, 236, 255, 0.85)';
    ctx.lineWidth = 1.4 / k;
    ctx.beginPath();
    const f = s.nodes[focus];
    for (const j of f.nbrs) {
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(s.nodes[j].x, s.nodes[j].y);
    }
    ctx.stroke();
  }

  const lit: SimNode[] = [];
  for (const id of p.highlightedIds) {
    const i = s.index.get(id);
    if (i !== undefined) lit.push(s.nodes[i]);
  }
  if (lit.length) {
    ctx.strokeStyle = `rgba(255, 196, 96, ${0.45 + pulse * 0.35})`;
    ctx.lineWidth = 1.2 / k;
    ctx.beginPath();
    for (const n of lit) {
      ctx.moveTo(0, 0);
      ctx.lineTo(n.x, n.y);
    }
    ctx.stroke();
  }

  for (let i = 0; i < s.nodes.length; i++) {
    const n = s.nodes[i];
    const dim = (q && !matches(n)) ? 0.12 : focus >= 0 && !focusSet.has(i) ? 0.35 : 1;
    const size = Math.max(n.r * 3, 5 / k);
    ctx.globalAlpha = dim;
    ctx.drawImage(sp.gold[HUES.indexOf(n.hue)], n.x - size, n.y - size, size * 2, size * 2);
  }
  ctx.globalAlpha = 1;

  for (const n of lit) {
    const size = Math.max(n.r * 5, 9 / k) * (1 + pulse * 0.25);
    ctx.drawImage(sp.hit, n.x - size, n.y - size, size * 2, size * 2);
  }
  if (focus >= 0) {
    const n = s.nodes[focus];
    const size = Math.max(n.r * 5, 10 / k);
    ctx.drawImage(sp.sel, n.x - size, n.y - size, size * 2, size * 2);
  }

  // Event-horizon core drawn last so lines converge into it.
  ctx.fillStyle = '#02040a';
  ctx.beginPath();
  ctx.arc(0, 0, CORE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
  ctx.lineWidth = 2 / k;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.28)';
  ctx.lineWidth = 1 / k;
  ctx.beginPath();
  ctx.arc(0, 0, CORE_RADIUS + 7 + (p.active ? pulse * 5 : 0), 0, Math.PI * 2);
  ctx.stroke();

  const labels = new Set<number>(focusSet);
  if (k > 0.9) for (const i of s.hubs) labels.add(i);
  for (const i of lit.map((n) => s.index.get(n.id)!)) labels.add(i);
  if (labels.size) {
    ctx.font = `${11 / k}px ui-monospace, "IBM Plex Mono", monospace`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const i of labels) {
      const n = s.nodes[i];
      if (q && !matches(n)) continue;
      const text = n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(-rot);
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = 'rgba(4, 8, 16, 0.9)';
      ctx.strokeText(text, n.r + 6 / k, 0);
      ctx.fillStyle = i === focus ? '#f2fcff' : '#bfeaf7';
      ctx.fillText(text, n.r + 6 / k, 0);
      ctx.restore();
    }
  }
}

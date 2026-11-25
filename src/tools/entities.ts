// Picking whole model entities for measuring, the way CAD programs do: a flat face, a hole or shaft, a straight edge,
// a round edge or a corner. Two picked entities give the distance and angle between them.
import * as THREE from 'three';
import { MeshFeatures, type Circle, type Cylinder } from './features';

export type Ent =
  | { t: 'vertex'; p: THREE.Vector3; key: string }
  | { t: 'line'; a: THREE.Vector3; b: THREE.Vector3; key: string }
  | { t: 'circle'; circle: Circle; pts: THREE.Vector3[]; full: boolean; length: number; info: string; key: string; src: unknown }
  | { t: 'plane'; p: THREE.Vector3; n: THREE.Vector3; area: number; tri: Float32Array; key: string }
  | { t: 'cyl'; cyl: Cylinder; tri: Float32Array; key: string }
  | { t: 'surface'; p: THREE.Vector3; n: THREE.Vector3 | null; key: string };

/** A value shown in the panel; lengths and areas stay numbers so a unit change reformats them. */
export type Fact = { label: string; v: number; u: 'len' | 'deg' | 'area' } | { label: string; s: string; u: 'text' };

export interface PairResult {
  a: THREE.Vector3;
  b: THREE.Vector3;
  headline: 'distance' | 'angle';
  angle: number | null;
  facts: Fact[];
  info: string;
}

// ------------------------------------------------------------------ flat faces

const COS_FLAT = Math.cos(THREE.MathUtils.degToRad(1.5));

/**
 * The flat face around triangle t0: every connected triangle in the same plane. Returns null when t0 is one facet of a
 * curved surface (the surface carries on smoothly in several directions past a tiny "face").
 */
export function planeAt(F: MeshFeatures, t0: number): { tris: number[]; n: THREE.Vector3; p: THREE.Vector3; area: number } | null {
  const T = F.topo.tri;
  const n0 = F.triNormal(t0);
  const p0 = F.v(T[3 * t0]);
  // Plane tolerance from the size of the seed triangle and the model, so float noise does not split a face.
  const box = new THREE.Box3();
  for (let k = 0; k < 3; k++) box.expandByPoint(F.v(T[3 * t0 + k]));
  const tol = Math.max(box.getSize(new THREE.Vector3()).length() * 1e-3, 1e-9);
  const tris: number[] = [t0];
  const seen = new Set([t0]);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const smoothRejectEdges = new Set<number>();
  const { triE, eFeat, eT0, eT1 } = F.topo;
  for (let i = 0; i < tris.length && tris.length < 300000; i++) {
    const t = tris[i];
    for (let k = 0; k < 3; k++) {
      const e = triE[3 * t + k];
      if (e < 0) continue;
      const o = eT0[e] === t ? eT1[e] : eT0[e];
      if (o < 0 || seen.has(o)) continue;
      F.triNormal(o, n);
      const flat = Math.abs(n.dot(n0)) > COS_FLAT || !Number.isFinite(n.x);
      let inPlane = flat;
      if (inPlane) for (let j = 0; j < 3; j++) if (Math.abs(F.v(T[3 * o + j], v).sub(p0).dot(n0)) > tol) { inPlane = false; break; }
      if (inPlane) { seen.add(o); tris.push(o); }
      else if (!eFeat[e]) smoothRejectEdges.add(e);
    }
  }
  if (tris.length <= 2 && smoothRejectEdges.size >= 2) return null;
  // Area-weighted normal and centre.
  let area = 0;
  const nSum = new THREE.Vector3(), cSum = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const t of tris) {
    F.v(T[3 * t], a); F.v(T[3 * t + 1], b); F.v(T[3 * t + 2], c);
    const cr = b.clone().sub(a).cross(c.clone().sub(a));
    const ar = cr.length() / 2;
    if (!ar) continue;
    area += ar;
    if (cr.dot(n0) < 0) cr.negate();
    nSum.add(cr);
    cSum.addScaledVector(a.clone().add(b).add(c), ar / 3);
  }
  if (!area) return null;
  return { tris, n: nSum.normalize(), p: cSum.divideScalar(area), area };
}

/** World positions of triangles, three vertices each, for drawing and distance queries. */
export function triPositions(F: MeshFeatures, tris: Iterable<number>) {
  const T = F.topo.tri;
  const list = [...tris];
  const out = new Float32Array(list.length * 9);
  const v = new THREE.Vector3();
  list.forEach((t, i) => { for (let k = 0; k < 3; k++) { F.v(T[3 * t + k], v); out.set([v.x, v.y, v.z], i * 9 + k * 3); } });
  return out;
}

// ------------------------------------------------------------------ describing one entity

export function entName(e: Ent, fmt: (v: number) => string) {
  switch (e.t) {
    case 'vertex': return 'Corner';
    case 'line': return 'Edge';
    case 'plane': return 'Face';
    case 'surface': return 'Curved surface';
    case 'circle': return e.full ? `Round edge ⌀ ${fmt(e.circle.radius * 2)}` : `Arc R ${fmt(e.circle.radius)}`;
    case 'cyl': return e.cyl.type === 'hole' ? `Hole ⌀ ${fmt(e.cyl.radius * 2)}` : e.cyl.type === 'boss' ? `Shaft ⌀ ${fmt(e.cyl.radius * 2)}` : `Fillet R ${fmt(e.cyl.radius)}`;
  }
}

const axisName = (v: THREE.Vector3) => {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const i = a.indexOf(Math.max(...a));
  if (a[i] > 0.9998) return `${v.getComponent(i) < 0 ? '−' : '+'}${'XYZ'[i]}`;
  return `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
};

/** What the panel shows for a single picked entity. */
export function entFacts(e: Ent): { title: string; facts: Fact[]; keep: boolean } {
  const xyz = (p: THREE.Vector3): Fact[] => [{ label: 'X', v: p.x, u: 'len' }, { label: 'Y', v: p.y, u: 'len' }, { label: 'Z', v: p.z, u: 'len' }];
  switch (e.t) {
    case 'vertex': return { title: 'Corner', facts: xyz(e.p), keep: false };
    case 'surface': return { title: 'Curved surface', facts: xyz(e.p), keep: false };
    case 'line': return { title: 'Straight edge', facts: [{ label: 'Length', v: e.a.distanceTo(e.b), u: 'len' }, { label: 'Direction', s: axisName(e.b.clone().sub(e.a).normalize()), u: 'text' }], keep: true };
    case 'plane': return { title: 'Flat face', facts: [{ label: 'Area', v: e.area, u: 'area' }, { label: 'Normal', s: axisName(e.n), u: 'text' }], keep: false };
    case 'circle': return {
      title: e.full ? 'Round edge' : 'Arc',
      facts: [e.full ? { label: 'Diameter', v: e.circle.radius * 2, u: 'len' } : { label: 'Radius', v: e.circle.radius, u: 'len' },
        e.full ? { label: 'Radius', v: e.circle.radius, u: 'len' } : { label: 'Diameter', v: e.circle.radius * 2, u: 'len' },
        { label: e.full ? 'Circumference' : 'Arc length', v: e.length, u: 'len' }],
      keep: true,
    };
    case 'cyl': {
      const c = e.cyl;
      const title = c.type === 'hole' ? 'Hole' : c.type === 'boss' ? 'Round shaft / boss' : `Fillet / round (${Math.round(c.sweep)}°)`;
      const facts: Fact[] = c.type === 'fillet'
        ? [{ label: 'Radius', v: c.radius, u: 'len' }]
        : [{ label: 'Diameter', v: c.radius * 2, u: 'len' }, { label: 'Radius', v: c.radius, u: 'len' }];
      if (c.depth > c.radius * 0.02) facts.push({ label: c.type === 'hole' ? 'Depth' : 'Length', v: c.depth, u: 'len' });
      facts.push({ label: 'Axis', s: axisName(c.axis), u: 'text' });
      return { title, facts, keep: true };
    }
  }
}

// ------------------------------------------------------------------ distance and angle between two entities

interface Shape { pts: THREE.Vector3[]; closest(p: THREE.Vector3): THREE.Vector3 }

function closestOnPolyline(pts: THREE.Vector3[], p: THREE.Vector3) {
  let best = pts[0].clone(), bd = Infinity;
  const l = new THREE.Line3(), q = new THREE.Vector3();
  for (let i = 0; i + 1 < pts.length; i++) {
    l.set(pts[i], pts[i + 1]).closestPointToPoint(p, true, q);
    const d = q.distanceToSquared(p);
    if (d < bd) { bd = d; best = q.clone(); }
  }
  return best;
}

function triShape(tri: Float32Array): Shape {
  const n = tri.length / 9;
  const tr = new THREE.Triangle(), q = new THREE.Vector3();
  const closestWith = (p: THREE.Vector3, step: number) => {
    let best = new THREE.Vector3(tri[0], tri[1], tri[2]), bd = Infinity;
    for (let i = 0; i < n; i += step) {
      const o = i * 9;
      tr.a.set(tri[o], tri[o + 1], tri[o + 2]); tr.b.set(tri[o + 3], tri[o + 4], tri[o + 5]); tr.c.set(tri[o + 6], tri[o + 7], tri[o + 8]);
      tr.closestPointToPoint(p, q);
      const d = q.distanceToSquared(p);
      if (d < bd) { bd = d; best = q.clone(); }
    }
    return best;
  };
  const vstep = Math.max(1, Math.ceil((n * 3) / 240));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n * 3; i += vstep) pts.push(new THREE.Vector3(tri[i * 3], tri[i * 3 + 1], tri[i * 3 + 2]));
  return { pts, closest: (p) => closestWith(p, Math.max(1, Math.ceil(n / 60000))) };
}

function shapeOf(e: Ent): Shape {
  switch (e.t) {
    case 'vertex': case 'surface': return { pts: [e.p], closest: () => e.p.clone() };
    case 'line': {
      const pts = Array.from({ length: 17 }, (_, i) => e.a.clone().lerp(e.b, i / 16));
      const l = new THREE.Line3(e.a, e.b);
      return { pts, closest: (p) => l.closestPointToPoint(p, true, new THREE.Vector3()) };
    }
    case 'circle': return { pts: e.pts.filter((_, i) => i % 4 === 0), closest: (p) => closestOnPolyline(e.pts, p) };
    case 'plane': case 'cyl': return triShape(e.tri);
  }
}

/** Closest points between two entities: coarse seeding, then alternating projection. */
function minDistance(A: Ent, B: Ent) {
  const sa = shapeOf(A), sb = shapeOf(B);
  let pa = sa.pts[0], pb = sb.closest(pa), bd = pa.distanceToSquared(pb);
  for (const p of sa.pts) { const q = sb.closest(p); const d = q.distanceToSquared(p); if (d < bd) { bd = d; pa = p; pb = q; } }
  for (const p of sb.pts) { const q = sa.closest(p); const d = q.distanceToSquared(p); if (d < bd) { bd = d; pa = q; pb = p; } }
  for (let i = 0; i < 24; i++) {
    const na = sa.closest(pb), nb = sb.closest(na);
    const d = na.distanceToSquared(nb);
    if (d >= bd - 1e-18) break;
    bd = d; pa = na; pb = nb;
  }
  return { a: pa.clone(), b: pb.clone(), d: Math.sqrt(bd) };
}

const orient = (e: Ent): { kind: 'normal' | 'dir'; v: THREE.Vector3 } | null => {
  switch (e.t) {
    case 'plane': return { kind: 'normal', v: e.n };
    case 'surface': return e.n ? { kind: 'normal', v: e.n } : null;
    case 'circle': return { kind: 'normal', v: e.circle.axis };
    case 'line': return { kind: 'dir', v: e.b.clone().sub(e.a).normalize() };
    case 'cyl': return { kind: 'dir', v: e.cyl.axis };
    default: return null;
  }
};
const pointOf = (e: Ent) => (e.t === 'vertex' || e.t === 'surface' ? e.p : e.t === 'circle' ? e.circle.center : null);
const lineOf = (e: Ent) => (e.t === 'line' ? { p: e.a.clone().lerp(e.b, 0.5), d: e.b.clone().sub(e.a).normalize() }
  : e.t === 'cyl' ? { p: e.cyl.start.clone().lerp(e.cyl.end, 0.5), d: e.cyl.axis.clone() } : null);
const planeOf = (e: Ent) => (e.t === 'plane' ? { p: e.p, n: e.n } : null);
const sizeOf = (e: Ent) => (e.t === 'line' ? e.a.distanceTo(e.b) : e.t === 'plane' ? Math.sqrt(e.area) : e.t === 'circle' ? e.circle.radius : e.t === 'cyl' ? Math.max(e.cyl.radius, e.cyl.depth) : 0);
const footOnLine = (p: THREE.Vector3, l: { p: THREE.Vector3; d: THREE.Vector3 }) => l.p.clone().addScaledVector(l.d, p.clone().sub(l.p).dot(l.d));
const footOnPlane = (p: THREE.Vector3, pl: { p: THREE.Vector3; n: THREE.Vector3 }) => p.clone().addScaledVector(pl.n, -p.clone().sub(pl.p).dot(pl.n));

/** Distance and angle between two picked entities, like the measure dialog of a CAD program. */
export function measurePair(A: Ent, B: Ent, fmt: (v: number) => string): PairResult {
  const min = minDistance(A, B);
  const scale = Math.max(sizeOf(A), sizeOf(B), min.d, 1e-9);
  const tiny = scale * 1e-5;
  // Angle: faces by their normals, edges and axes by their direction; an edge against a face is 90° minus that.
  let angle: number | null = null;
  const oA = orient(A), oB = orient(B);
  if (oA && oB) {
    let raw = THREE.MathUtils.radToDeg(oA.v.angleTo(oB.v));
    if (raw > 90) raw = 180 - raw;
    angle = oA.kind === oB.kind ? raw : 90 - raw;
    if (angle < 1e-6) angle = 0;
  }
  const parallel = angle !== null && angle < 0.5;
  // The distance a designer means for this pair, when there is one.
  let special: { label: string; a: THREE.Vector3; b: THREE.Vector3 } | null = null;
  const swap = (s: typeof special) => (s ? { label: s.label, a: s.b, b: s.a } : s);
  const pick = (X: Ent, Y: Ent): typeof special => {
    const pX = pointOf(X), pY = pointOf(Y), lX = lineOf(X), lY = lineOf(Y), plX = planeOf(X), plY = planeOf(Y);
    const circ = X.t === 'circle' || Y.t === 'circle';
    if (pX && pY) return { label: circ ? 'Centre distance' : 'Distance', a: pX.clone(), b: pY.clone() };
    if (pX && plY) return { label: X.t === 'circle' ? 'Centre to face' : 'Distance to face', a: pX.clone(), b: footOnPlane(pX, plY) };
    if (pX && lY) return { label: Y.t === 'cyl' ? (X.t === 'circle' ? 'Centre to axis' : 'Distance to axis') : 'Distance to edge line', a: pX.clone(), b: footOnLine(pX, lY) };
    if (plX && plY && parallel) { const a = plX.p.clone(); return { label: 'Gap between faces', a, b: footOnPlane(a, plY) }; }
    if (lX && plY && parallel) return { label: X.t === 'cyl' ? 'Axis to face' : 'Edge to face', a: lX.p.clone(), b: footOnPlane(lX.p, plY) };
    if (lX && lY && parallel) return { label: X.t === 'cyl' && Y.t === 'cyl' ? 'Axis distance' : 'Distance between lines', a: lX.p.clone(), b: footOnLine(lX.p, lY) };
    return null;
  };
  special = pick(A, B) ?? swap(pick(B, A));
  const facts: Fact[] = [];
  let a = min.a, b = min.b, headline: PairResult['headline'] = 'distance';
  if (special) {
    a = special.a; b = special.b;
    facts.push({ label: special.label, v: a.distanceTo(b), u: 'len' });
    if (Math.abs(min.d - a.distanceTo(b)) > tiny) facts.push({ label: 'Minimum distance', v: min.d, u: 'len' });
  } else {
    facts.push({ label: 'Minimum distance', v: min.d, u: 'len' });
    if (min.d <= tiny && angle !== null) headline = 'angle';
  }
  if (angle !== null) facts.push({ label: parallel ? 'Angle (parallel)' : 'Angle', v: angle, u: 'deg' });
  // Two circles: their axes' offset when parallel (hole pattern spacing seen along the axis).
  if (A.t === 'circle' && B.t === 'circle' && parallel) {
    const d = B.circle.center.clone().sub(A.circle.center);
    const off = d.clone().sub(A.circle.axis.clone().multiplyScalar(d.dot(A.circle.axis))).length();
    if (Math.abs(off - d.length()) > tiny) facts.push({ label: 'Axis offset', v: off, u: 'len' });
  }
  return { a, b, headline, angle, facts, info: `${entName(A, fmt)} → ${entName(B, fmt)}` };
}

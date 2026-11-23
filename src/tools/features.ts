// Geometry features for measuring: real model edges (creases and borders, not triangle edges), edge chains that
// form straight lines or arcs, and cylinders (holes, bosses, fillets) found from one triangle on their wall.
// Everything is computed from the displayed triangle mesh, so CAD values are close approximations.
import * as THREE from 'three';

/** Welded triangle mesh with edge adjacency, built once per geometry. */
export interface Topology {
  /** welded vertex positions, local space */
  pos: Float32Array;
  /** three welded vertex ids per triangle */
  tri: Uint32Array;
  /** three edge ids per triangle (-1 for a degenerate side) */
  triE: Int32Array;
  eA: Uint32Array;
  eB: Uint32Array;
  /** triangles on each side of an edge (-1 = none) */
  eT0: Int32Array;
  eT1: Int32Array;
  /** 1 = a model edge: border, non-manifold or a crease sharper than FEATURE_ANGLE */
  eFeat: Uint8Array;
  /** feature edges per vertex (CSR) */
  vfStart: Uint32Array;
  vfList: Uint32Array;
  triCount: number;
  /** spatial grid of feature edges (local space), built on first use */
  grid?: { min: THREE.Vector3; cell: number; n: number; cells: Map<number, number[]> };
}

/** Feature edges bucketed in a uniform grid, so edges near a point are found without walking the mesh. */
function edgeGrid(t: Topology) {
  if (t.grid) return t.grid;
  const { pos, eA, eB, eFeat } = t;
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pos.length; i += 3) { min.x = Math.min(min.x, pos[i]); min.y = Math.min(min.y, pos[i + 1]); min.z = Math.min(min.z, pos[i + 2]); max.x = Math.max(max.x, pos[i]); max.y = Math.max(max.y, pos[i + 1]); max.z = Math.max(max.z, pos[i + 2]); }
  const n = 96;
  const cell = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1e-9) / n;
  const cells = new Map<number, number[]>();
  const c = (x: number, m: number) => Math.max(0, Math.min(n - 1, Math.floor((x - m) / cell)));
  for (let e = 0; e < eA.length; e++) {
    if (!eFeat[e]) continue;
    const a = eA[e] * 3, b = eB[e] * 3;
    // Walk the segment in steps of half a cell and drop it in every cell it passes.
    const len = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const k = (c(pos[a] + (pos[b] - pos[a]) * f, min.x) * n + c(pos[a + 1] + (pos[b + 1] - pos[a + 1]) * f, min.y)) * n + c(pos[a + 2] + (pos[b + 2] - pos[a + 2]) * f, min.z);
      if (k === last) continue;
      last = k;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      if (l[l.length - 1] !== e) l.push(e);
    }
  }
  t.grid = { min, cell, n, cells };
  return t.grid;
}

/** Creases sharper than this are model edges. Kept above the facet angle of coarse CAD tessellation (~30°). */
const FEATURE_ANGLE = 40;
const MAX_TRIS = 4_000_000;
const cache = new WeakMap<THREE.BufferGeometry, { t: Topology | null; attr: unknown; ver: number; idx: unknown }>();

export function topology(geo: THREE.BufferGeometry): Topology | null {
  const pa = geo.attributes.position as THREE.BufferAttribute | undefined;
  const c = cache.get(geo);
  // Rebuilt when the positions or the index were replaced or edited in place.
  if (c && c.attr === pa && c.ver === (pa?.version ?? 0) && c.idx === geo.index) return c.t;
  const t = build(geo);
  cache.set(geo, { t, attr: pa, ver: pa?.version ?? 0, idx: geo.index });
  return t;
}
/** Call after a geometry is edited in place. */
export function forgetTopology(geo: THREE.BufferGeometry) { cache.delete(geo); }

function build(geo: THREE.BufferGeometry): Topology | null {
  const pa = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pa || pa.itemSize < 3) return null;
  const index = geo.index;
  const triCount = Math.floor((index ? index.count : pa.count) / 3);
  if (!triCount || triCount > MAX_TRIS) return null;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const diag = bb.min.distanceTo(bb.max) || 1;
  // Weld tolerance: boolean results leave near-duplicates (~1e-5 of the size apart) that must merge too.
  const eps = diag * 5e-5;
  // Weld coincident vertices (split normals/UVs make separate copies at every crease). Grid cells of size eps;
  // a point near a cell border is also checked against the neighbouring cells on that side.
  const remap = new Uint32Array(pa.count);
  const map = new Map<number, number>();
  const P: number[] = [];
  const K = 32768;
  const cellKey = (cx: number, cy: number, cz: number) => (cx * K + cy) * K + cz;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const fx = (x - bb.min.x) / eps, fy = (y - bb.min.y) / eps, fz = (z - bb.min.z) / eps;
    const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
    // Anything in the same cell merges (at most √3·eps apart), so every cell has exactly one vertex.
    let id = map.get(cellKey(cx, cy, cz));
    if (id === undefined) {
      const sx = fx - cx < 0.5 ? -1 : 1, sy = fy - cy < 0.5 ? -1 : 1, sz = fz - cz < 0.5 ? -1 : 1;
      for (let m = 1; m < 8 && id === undefined; m++) {
        const j = map.get(cellKey(cx + (m & 1 ? sx : 0), cy + (m & 2 ? sy : 0), cz + (m & 4 ? sz : 0)));
        if (j !== undefined && Math.hypot(P[3 * j] - x, P[3 * j + 1] - y, P[3 * j + 2] - z) <= eps) id = j;
      }
    }
    if (id === undefined) { id = P.length / 3; P.push(x, y, z); map.set(cellKey(cx, cy, cz), id); }
    remap[i] = id;
  }
  const V = P.length / 3;
  const pos = new Float32Array(P);
  const tri = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) tri[i] = remap[index ? index.getX(i) : i];
  // Face normals.
  const nrm = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = tri[3 * t] * 3, b = tri[3 * t + 1] * 3, c = tri[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    nrm[3 * t] = nx; nrm[3 * t + 1] = ny; nrm[3 * t + 2] = nz;
  }
  // Edges.
  const emap = new Map<number, number>();
  const eA: number[] = [], eB: number[] = [], eT0: number[] = [], eT1: number[] = [], bad: number[] = [];
  const triE = new Int32Array(triCount * 3).fill(-1);
  for (let t = 0; t < triCount; t++) {
    // Slivers that welding collapsed to a line or a point take no part in the topology.
    if (tri[3 * t] === tri[3 * t + 1] || tri[3 * t + 1] === tri[3 * t + 2] || tri[3 * t] === tri[3 * t + 2]) continue;
    for (let k = 0; k < 3; k++) {
      let a = tri[3 * t + k], b = tri[3 * t + ((k + 1) % 3)];
      if (a > b) [a, b] = [b, a];
      const key = a * V + b;
      let e = emap.get(key);
      if (e === undefined) { e = eA.length; emap.set(key, e); eA.push(a); eB.push(b); eT0.push(t); eT1.push(-1); bad.push(0); }
      else if (eT1[e] === -1) eT1[e] = t;
      else bad[e] = 1; // three or more triangles share it
      triE[3 * t + k] = e;
    }
  }
  const E = eA.length;
  const eFeat = new Uint8Array(E);
  const cosF = Math.cos(THREE.MathUtils.degToRad(FEATURE_ANGLE));
  for (let e = 0; e < E; e++) {
    const t0 = eT0[e], t1 = eT1[e];
    if (t1 < 0 || bad[e]) { eFeat[e] = 1; continue; }
    const d = nrm[3 * t0] * nrm[3 * t1] + nrm[3 * t0 + 1] * nrm[3 * t1 + 1] + nrm[3 * t0 + 2] * nrm[3 * t1 + 2];
    // |d|: double-sided models often have mixed winding; a flipped neighbour is not a crease.
    if (Math.abs(d) < cosF && (nrm[3 * t0] || nrm[3 * t0 + 1] || nrm[3 * t0 + 2]) && (nrm[3 * t1] || nrm[3 * t1 + 1] || nrm[3 * t1 + 2])) eFeat[e] = 1;
  }
  splitTJunctions(pos, nrm, eA, eB, eT0, eT1, bad, eFeat, emap, V, eps);
  unmarkTJunctions(pos, nrm, eA, eB, eT0, eT1, bad, eFeat, diag);
  const vfStart = new Uint32Array(V + 1);
  for (let e = 0; e < E; e++) if (eFeat[e]) { vfStart[eA[e] + 1]++; vfStart[eB[e] + 1]++; }
  for (let v = 0; v < V; v++) vfStart[v + 1] += vfStart[v];
  const fill = vfStart.slice(0, V);
  const vfList = new Uint32Array(vfStart[V]);
  for (let e = 0; e < E; e++) if (eFeat[e]) { vfList[fill[eA[e]]++] = e; vfList[fill[eB[e]]++] = e; }
  return { pos, tri, triE, eA: Uint32Array.from(eA), eB: Uint32Array.from(eB), eT0: Int32Array.from(eT0), eT1: Int32Array.from(eT1), eFeat, vfStart, vfList, triCount };
}

/**
 * Boolean (CSG) results and some exporters leave T-junctions: a vertex in the middle of a neighbour's edge. Both
 * sides then look like open borders, which would cut walls and edges into pieces. Border edges that lie on the same
 * line, overlap, and belong to triangles facing the same way are a seam, not an edge of the model.
 */
/**
 * T-junction repair: a border vertex lying on another border edge splits it; when the pieces are existing border
 * edges from the other side, facing the same way, none of them is a model edge. Handles the tiny pieces whose
 * direction welding has skewed, which the straight-line test below would miss.
 */
function splitTJunctions(pos: Float32Array, nrm: Float32Array, eA: number[], eB: number[], eT0: number[], eT1: number[], bad: number[], eFeat: Uint8Array, emap: Map<number, number>, V: number, eps: number) {
  const borderV = new Set<number>();
  const border: number[] = [];
  for (let e = 0; e < eA.length; e++) if (eT1[e] < 0 && !bad[e] && eFeat[e]) { border.push(e); borderV.add(eA[e]); borderV.add(eB[e]); }
  if (border.length < 2) return;
  // Grid of border vertices.
  let mx = Infinity, my = Infinity, mz = Infinity, Mx = -Infinity, My = -Infinity, Mz = -Infinity;
  for (const v of borderV) { const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2]; mx = Math.min(mx, x); my = Math.min(my, y); mz = Math.min(mz, z); Mx = Math.max(Mx, x); My = Math.max(My, y); Mz = Math.max(Mz, z); }
  const cell = Math.max(Mx - mx, My - my, Mz - mz, eps) / 64;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number, k: number) => (i * 128 + j) * 128 + k;
  const ci = (x: number, m: number) => Math.max(0, Math.min(127, Math.floor((x - m) / cell)));
  for (const v of borderV) { const k = key(ci(pos[3 * v], mx), ci(pos[3 * v + 1], my), ci(pos[3 * v + 2], mz)); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(v); }
  const tol = eps * 4;
  const cosF = Math.cos(THREE.MathUtils.degToRad(FEATURE_ANGLE));
  const edgeOf = (a: number, b: number) => emap.get(Math.min(a, b) * V + Math.max(a, b));
  for (const e of border) {
    const a = eA[e], b = eB[e];
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const dx = pos[3 * b] - ax, dy = pos[3 * b + 1] - ay, dz = pos[3 * b + 2] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < tol * tol * 4) continue;
    const cells = (Math.abs(ci(ax + dx, mx) - ci(ax, mx)) + 1) * (Math.abs(ci(ay + dy, my) - ci(ay, my)) + 1) * (Math.abs(ci(az + dz, mz) - ci(az, mz)) + 1);
    if (cells > 4096) continue; // very long diagonal edge: skip rather than scan half the grid
    const on: { v: number; t: number }[] = [];
    const i0 = Math.min(ci(ax, mx), ci(ax + dx, mx)), i1 = Math.max(ci(ax, mx), ci(ax + dx, mx));
    const j0 = Math.min(ci(ay, my), ci(ay + dy, my)), j1 = Math.max(ci(ay, my), ci(ay + dy, my));
    const k0 = Math.min(ci(az, mz), ci(az + dz, mz)), k1 = Math.max(ci(az, mz), ci(az + dz, mz));
    for (let i = Math.max(0, i0 - 1); i <= Math.min(127, i1 + 1); i++) for (let j = Math.max(0, j0 - 1); j <= Math.min(127, j1 + 1); j++) for (let k = Math.max(0, k0 - 1); k <= Math.min(127, k1 + 1); k++) {
      const list = grid.get(key(i, j, k));
      if (!list) continue;
      for (const v of list) {
        if (v === a || v === b) continue;
        const px = pos[3 * v] - ax, py = pos[3 * v + 1] - ay, pz = pos[3 * v + 2] - az;
        const t = (px * dx + py * dy + pz * dz) / l2;
        if (t <= 0 || t >= 1) continue;
        const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t;
        if (qx * qx + qy * qy + qz * qz <= tol * tol) on.push({ v, t });
      }
    }
    if (!on.length) continue;
    on.sort((x, y) => x.t - y.t);
    // Pieces that exist as border edges of same-facing triangles are the other side of this seam. Boolean seams
    // often match only partly (the other side has its own T-vertices), so each matching piece counts.
    const chain = [a, ...on.map((o) => o.v), b];
    const t0 = eT0[e];
    let matched = 0;
    for (let i = 1; i < chain.length; i++) {
      const p = edgeOf(chain[i - 1], chain[i]);
      if (p === undefined || p === e || eT1[p] >= 0) continue;
      const tp = eT0[p];
      if (Math.abs(nrm[3 * t0] * nrm[3 * tp] + nrm[3 * t0 + 1] * nrm[3 * tp + 1] + nrm[3 * t0 + 2] * nrm[3 * tp + 2]) >= cosF) { eFeat[p] = 0; matched++; }
    }
    if (matched) eFeat[e] = 0;
  }
}

function unmarkTJunctions(pos: Float32Array, nrm: Float32Array, eA: number[], eB: number[], eT0: number[], eT1: number[], bad: number[], eFeat: Uint8Array, diag: number) {
  // Border edges, and which border edges meet at each vertex.
  const border: number[] = [];
  const at = new Map<number, number[]>();
  for (let e = 0; e < eA.length; e++) {
    if (eT1[e] >= 0 || bad[e]) continue;
    border.push(e);
    for (const v of [eA[e], eB[e]]) { let l = at.get(v); if (!l) at.set(v, (l = [])); l.push(border.length - 1); }
  }
  if (border.length < 2) return;
  const dir = (i: number) => {
    const e = border[i], a = eA[e] * 3, b = eB[e] * 3;
    const x = pos[b] - pos[a], y = pos[b + 1] - pos[a + 1], z = pos[b + 2] - pos[a + 2], l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  // Union border edges that continue in one straight line through a shared vertex (either side of a seam).
  const parent = border.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const dirs = border.map((_, i) => dir(i));
  for (const list of at.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = dirs[list[i]], q = dirs[list[j]];
      if (Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) > 0.99995) parent[find(list[i])] = find(list[j]);
    }
  }
  const lines = new Map<number, number[]>();
  border.forEach((_, i) => { const r = find(i); let l = lines.get(r); if (!l) lines.set(r, (l = [])); l.push(i); });
  const cosF = Math.cos(THREE.MathUtils.degToRad(FEATURE_ANGLE));
  const tol = diag * 1e-6;
  for (const line of lines.values()) {
    if (line.length < 2) continue;
    const d = dirs[line[0]];
    const iv = line.map((i) => {
      const e = border[i];
      const ta = pos[eA[e] * 3] * d[0] + pos[eA[e] * 3 + 1] * d[1] + pos[eA[e] * 3 + 2] * d[2];
      const tb = pos[eB[e] * 3] * d[0] + pos[eB[e] * 3 + 1] * d[1] + pos[eB[e] * 3 + 2] * d[2];
      return { e, t0: Math.min(ta, tb), t1: Math.max(ta, tb) };
    }).sort((x, y) => x.t0 - y.t0);
    // Overlapping pieces from the two sides, on triangles facing the same way: a seam, not a model edge.
    for (let i = 0; i < iv.length; i++) {
      for (let j = i + 1; j < iv.length && iv[j].t0 < iv[i].t1 - tol; j++) {
        const ti = eT0[iv[i].e], tj = eT0[iv[j].e];
        const dd = nrm[3 * ti] * nrm[3 * tj] + nrm[3 * ti + 1] * nrm[3 * tj + 1] + nrm[3 * ti + 2] * nrm[3 * tj + 2];
        if (Math.abs(dd) >= cosF) { eFeat[iv[i].e] = 0; eFeat[iv[j].e] = 0; }
      }
    }
  }
}

// ------------------------------------------------------------------ world-space access

/** A mesh with its topology and world transform, so every result is in world units even under non-uniform scale. */
export class MeshFeatures {
  readonly topo: Topology;
  private m: THREE.Matrix4;
  private nm: THREE.Matrix3;
  private inv: THREE.Matrix4;
  constructor(readonly mesh: THREE.Mesh, topo: Topology) {
    this.topo = topo;
    this.m = mesh.matrixWorld.clone();
    this.inv = this.m.clone().invert();
    this.nm = new THREE.Matrix3().getNormalMatrix(this.m);
  }
  /** Feature edges within `radius` (world units) of a world point. */
  edgesNear(p: THREE.Vector3, radius: number) {
    const g = edgeGrid(this.topo);
    const lp = p.clone().applyMatrix4(this.inv);
    const s = new THREE.Vector3().setFromMatrixScale(this.m);
    const lr = radius / Math.max(1e-12, Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
    const c = (x: number, m: number) => Math.max(0, Math.min(g.n - 1, Math.floor((x - m) / g.cell)));
    const out = new Set<number>();
    for (let i = c(lp.x - lr, g.min.x); i <= c(lp.x + lr, g.min.x); i++)
      for (let j = c(lp.y - lr, g.min.y); j <= c(lp.y + lr, g.min.y); j++)
        for (let k = c(lp.z - lr, g.min.z); k <= c(lp.z + lr, g.min.z); k++) {
          const l = g.cells.get((i * g.n + j) * g.n + k);
          if (l) for (const e of l) out.add(e);
          if (out.size > 4000) return out;
        }
    return out;
  }
  static of(mesh: THREE.Mesh): MeshFeatures | null {
    if (!(mesh as any).isMesh || (mesh as any).isInstancedMesh || (mesh as any).isSkinnedMesh) return null;
    const t = topology(mesh.geometry);
    return t ? new MeshFeatures(mesh, t) : null;
  }
  v(i: number, out = new THREE.Vector3()) { const p = this.topo.pos; return out.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]).applyMatrix4(this.m); }
  triNormal(t: number, out = new THREE.Vector3()) {
    const T = this.topo.tri;
    const a = this.v(T[3 * t]), b = this.v(T[3 * t + 1]), c = this.v(T[3 * t + 2]);
    return out.subVectors(b, a).cross(c.sub(a)).normalize();
  }
  triArea(t: number) {
    const T = this.topo.tri;
    const a = this.v(T[3 * t]), b = this.v(T[3 * t + 1]), c = this.v(T[3 * t + 2]);
    return b.sub(a).cross(c.sub(a)).length() / 2;
  }
  /** Triangles across each side of t. */
  neighbours(t: number, smoothOnly: boolean, out: number[] = []) {
    const { triE, eT0, eT1, eFeat } = this.topo;
    out.length = 0;
    for (let k = 0; k < 3; k++) {
      const e = triE[3 * t + k];
      if (e < 0 || (smoothOnly && eFeat[e])) continue;
      const o = eT0[e] === t ? eT1[e] : eT0[e];
      if (o >= 0) out.push(o);
    }
    return out;
  }
  otherEnd(e: number, v: number) { return this.topo.eA[e] === v ? this.topo.eB[e] : this.topo.eA[e]; }
  featureEdgesAt(v: number) { const { vfStart, vfList } = this.topo; return vfList.subarray(vfStart[v], vfStart[v + 1]); }
  /** A corner of the model: where model edges meet at an angle, or a loose end. */
  isCorner(v: number) {
    const dirs = this.edgeDirs(v);
    if (dirs.length === 0) return false;
    if (dirs.length !== 2) return true;
    return -dirs[0].dot(dirs[1]) < Math.cos(THREE.MathUtils.degToRad(30));
  }
  /** Directions of the model edges leaving v; overlapping duplicates (T-junctions) count once. */
  edgeDirs(v: number) {
    const p = this.v(v);
    const out: THREE.Vector3[] = [];
    for (const e of this.featureEdgesAt(v)) {
      const d = this.v(this.otherEnd(e, v)).sub(p).normalize();
      if (!out.some((o) => o.dot(d) > 0.9986)) out.push(d);
    }
    return out;
  }
  /**
   * The model edge that continues from v when arriving along `dir`, or -1 at a junction or an end.
   * Overlapping duplicates (T-junctions) are resolved to the shortest, so the walk passes through them.
   */
  continueEdge(v: number, from: number, dir: THREE.Vector3) {
    const p = this.v(v);
    let best = -1, bestLen = Infinity, bestDir: THREE.Vector3 | null = null;
    let distinct = 0;
    const seen: THREE.Vector3[] = [];
    for (const e of this.featureEdgesAt(v)) {
      if (e === from) continue;
      const q = this.v(this.otherEnd(e, v));
      const d = q.clone().sub(p);
      const len = d.length();
      if (!len) continue;
      d.divideScalar(len);
      if (d.dot(dir) < -0.5) continue; // going back the way we came (a longer overlapping edge)
      if (!seen.some((o) => o.dot(d) > 0.9986)) { seen.push(d); distinct++; }
      if (!bestDir || (d.dot(bestDir) > 0.9986 && len < bestLen)) { if (!bestDir || d.dot(bestDir) > 0.9986) { best = e; bestLen = len; bestDir = d; } }
    }
    return distinct === 1 ? best : -1;
  }
}

// ------------------------------------------------------------------ edge chains (lines and arcs)

export interface Circle { center: THREE.Vector3; axis: THREE.Vector3; radius: number; }
export interface EdgeChain {
  pts: THREE.Vector3[];
  closed: boolean;
  kind: 'line' | 'arc' | 'segment';
  length: number;
  circle?: Circle;
  /** swept angle of an arc, degrees */
  sweep?: number;
  /** model edges the walk passed (to find the wall next to a rim) */
  edges?: number[];
}

const turnInfo = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
  const d1 = b.clone().sub(a).normalize(), d2 = c.clone().sub(b).normalize();
  const ax = d1.clone().cross(d2);
  return { angle: THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1))), axis: ax.lengthSq() > 1e-20 ? ax.normalize() : ax, d2 };
};

/**
 * Follows the model edge through `e0` both ways while it stays one straight line or one arc.
 * The walk first collects the whole smooth run of model edges, merges collinear pieces back into the facet chords
 * they were split from (boolean seams split edges unevenly), then grows an arc of similar chords around the
 * hovered one. A run that is not an arc gives the hovered straight chord.
 */
export function edgeChain(F: MeshFeatures, e0: number): EdgeChain {
  const { eA, eB } = F.topo;
  const a0 = eA[e0], b0 = eB[e0];
  const A = F.v(a0), B = F.v(b0);
  const cosSharp = Math.cos(THREE.MathUtils.degToRad(50));
  const visited = new Set([a0, b0]);
  const walked: number[] = [e0];
  const walk = (v0: number, e: number, prev: THREE.Vector3) => {
    const out: THREE.Vector3[] = [];
    let v = v0, cur = F.v(v0), closed = false;
    for (let g = 0; g < 5000; g++) {
      const dir = cur.clone().sub(prev).normalize();
      const ne = F.continueEdge(v, e, dir);
      if (ne < 0) break;
      const w = F.otherEnd(ne, v);
      const p = F.v(w);
      if (dir.dot(p.clone().sub(cur).normalize()) < cosSharp) break; // a corner
      if (w === a0) { closed = true; break; }
      if (visited.has(w)) break; // came back onto the run somewhere else: stop rather than go round again
      visited.add(w);
      walked.push(ne);
      out.push(p); prev = cur; cur = p; v = w; e = ne;
    }
    return { out, closed };
  };
  const fwd = walk(b0, e0, A);
  const closed = fwd.closed;
  const raw = closed ? [A, B, ...fwd.out] : [...walk(a0, e0, B).out.reverse(), A, B, ...fwd.out];
  const n = raw.length;
  const h0 = raw.indexOf(A); // the hovered segment runs from raw[h0] to raw[h0 + 1]
  // Chord corners: points where the run actually turns.
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { keep.push(i); continue; }
    if (turnInfo(raw[(i - 1 + n) % n], raw[i], raw[(i + 1) % n]).angle >= 0.5) keep.push(i);
  }
  const K = keep.length;
  const segment = (): EdgeChain => ({ pts: [A, B], closed: false, kind: 'segment', length: A.distanceTo(B) });
  if (K < 2) return segment();
  const chordCount = closed ? K : K - 1;
  const cv = (j: number) => raw[keep[((j % K) + K) % K]];
  // Chord holding the hovered segment.
  let hc = K - 1;
  for (let j = 0; j < K; j++) if (keep[j] <= h0 && (j === K - 1 || h0 < keep[j + 1])) { hc = j; break; }
  if (!closed && hc >= chordCount) hc = chordCount - 1;
  if (closed && h0 < keep[0]) hc = K - 1;
  const line = (): EdgeChain => { const p = cv(hc), q = cv(hc + 1); return { pts: [p, q], closed: false, kind: 'line', length: p.distanceTo(q) }; };
  if (chordCount < 3) return line();
  const len = (j: number) => cv(j).distanceTo(cv(j + 1));
  const L = len(hc);
  const interior = (j: number) => closed || (j >= 1 && j <= K - 2);
  const turnAtV = (j: number) => turnInfo(cv(j - 1), cv(j), cv(j + 1));
  const first = interior(hc + 1) ? turnAtV(hc + 1) : interior(hc) ? turnAtV(hc) : null;
  if (!first || first.angle < 0.5 || first.angle >= 50) return line();
  const refAxis = first.axis.clone();
  const okTurn = (j: number) => { if (!interior(j)) return false; const t = turnAtV(j); return t.angle >= 0.5 && t.angle < 50 && t.axis.dot(refAxis) > 0.9; };
  const okLen = (j: number) => { const l = len(j); return l > L * 0.25 && l < L * 4; };
  let lo = hc, hi = hc;
  while (hi - lo + 1 < chordCount && (closed || hi + 1 < chordCount) && okTurn(hi + 1) && okLen(hi + 1)) hi++;
  while (hi - lo + 1 < chordCount && (closed || lo - 1 >= 0) && okTurn(lo) && okLen(lo - 1)) lo--;
  const count = hi - lo + 1;
  if (count < 3) return line();
  const pts: THREE.Vector3[] = [];
  for (let j = lo; j <= hi + 1; j++) pts.push(cv(j));
  const full = closed && count === chordCount;
  const fitPts = full ? pts.slice(0, -1) : pts;
  const fit = fitCircle(fitPts, refAxis);
  if (!fit || fit.maxErr > 0.02 * fit.radius) return line();
  fit.radius = outerRadius(fitPts, fit.center, fit.axis, fit.radius, fit.radius * 0.02);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += pts[i - 1].distanceTo(pts[i]);
  let sweep = 360;
  if (!full) {
    const u = pts[0].clone().sub(fit.center).normalize(), w = fit.axis.clone().cross(u);
    let total = 0, last = 0;
    for (const p of pts) { const d = p.clone().sub(fit.center); const ang = Math.atan2(d.dot(w), d.dot(u)); let delta = ang - last; while (delta > Math.PI) delta -= 2 * Math.PI; while (delta < -Math.PI) delta += 2 * Math.PI; total += delta; last = ang; }
    sweep = Math.abs(THREE.MathUtils.radToDeg(total));
  }
  return { pts, closed: full, kind: 'arc', length, circle: { center: fit.center, axis: fit.axis, radius: fit.radius }, sweep, edges: walked };
}

// ------------------------------------------------------------------ fitting

/**
 * Tessellated round surfaces have their true vertices on the circle; any extra points (boolean cuts, T-junctions)
 * lie on the straight chords between them, inside it. So the outermost points give the radius, not the average.
 */
function outerRadius(pts: THREE.Vector3[], center: THREE.Vector3, axis: THREE.Vector3, fitR: number, tol: number) {
  const rs: number[] = [];
  for (const p of pts) {
    const d = p.clone().sub(center);
    const rr = d.sub(axis.clone().multiplyScalar(d.dot(axis))).length();
    if (rr <= fitR + tol) rs.push(rr);
  }
  if (!rs.length) return fitR;
  // Upper quartile rather than the maximum: chord points sit below it, and a few points that welding nudged
  // outwards by a hair do not decide the value.
  rs.sort((x, y) => x - y);
  return rs[Math.floor(0.75 * (rs.length - 1))];
}

/** Least-squares circle through 3D points in the plane with the given normal (or the best-fit plane). */
export function fitCircle(pts: THREE.Vector3[], normal?: THREE.Vector3) {
  if (pts.length < 3) return null;
  const o = new THREE.Vector3();
  for (const p of pts) o.add(p);
  o.divideScalar(pts.length);
  let n = normal && normal.lengthSq() > 0.5 ? normal.clone().normalize() : null;
  if (!n) {
    const C = cov(pts.map((p) => p.clone().sub(o)));
    n = eigen(C).vectors[0];
  }
  const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const w = n.clone().cross(u);
  const xy = pts.map((p) => { const d = p.clone().sub(o); return [d.dot(u), d.dot(w)]; });
  const c = fit2D(xy);
  if (!c) return null;
  const center = o.clone().addScaledVector(u, c.x).addScaledVector(w, c.y);
  let maxErr = 0, sum = 0;
  for (const [x, y] of xy) { const e = Math.abs(Math.hypot(x - c.x, y - c.y) - c.r); maxErr = Math.max(maxErr, e); sum += e * e; }
  return { center, axis: n, radius: c.r, maxErr, rms: Math.sqrt(sum / xy.length), u, w, origin: o };
}

/** Kåsa algebraic circle fit: x² + y² + Dx + Ey + F = 0. */
function fit2D(xy: number[][]) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = xy.length;
  // Centre the data for numerical stability.
  let mx = 0, my = 0;
  for (const [x, y] of xy) { mx += x; my += y; }
  mx /= n; my /= n;
  for (const [X, Y] of xy) {
    const x = X - mx, y = Y - my, z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = -[sxz syz sz]ᵀ
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const r = [-sxz, -syz, -sz];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-30) return null;
  const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
  const D = det(col(0)) / d, E = det(col(1)) / d, F = det(col(2)) / d;
  const cx = -D / 2, cy = -E / 2;
  const rr = cx * cx + cy * cy - F;
  if (!(rr > 0)) return null;
  return { x: cx + mx, y: cy + my, r: Math.sqrt(rr) };
}

function cov(vs: THREE.Vector3[], w?: number[]) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let tw = 0;
  vs.forEach((v, i) => {
    const k = w ? w[i] : 1; tw += k;
    const a = [v.x, v.y, v.z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += k * a[r] * a[c];
  });
  if (tw > 0) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] /= tw;
  return C;
}

/** Eigen decomposition of a symmetric 3×3 matrix (Jacobi), ascending eigenvalues. */
function eigen(A: number[][]) {
  const a = A.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize()) };
}

// ------------------------------------------------------------------ cylinders (holes, bosses, fillets)

export interface Cylinder extends Circle {
  /** points on the axis at the two ends of the found wall */
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** wall length along the axis */
  depth: number;
  /** degrees of the circle covered by the wall */
  sweep: number;
  type: 'hole' | 'boss' | 'fillet';
  tris: Set<number>;
}

/** Fits a cylinder to the smooth wall around triangle t0, or returns null when the surface there is not one. */
export function cylinderAt(F: MeshFeatures, t0: number): Cylinder | null {
  // 1. A small smooth patch around the seed gives the axis: wall normals all lie in the plane across the axis.
  const seed: number[] = [t0];
  const seen = new Set([t0]);
  const nb: number[] = [];
  for (let i = 0; i < seed.length && seed.length < 80; i++) {
    for (const o of F.neighbours(seed[i], true, nb)) if (!seen.has(o)) { seen.add(o); seed.push(o); }
  }
  if (seed.length < 3) return null;
  const normals = seed.map((t) => F.triNormal(t));
  const areas = seed.map((t) => F.triArea(t));
  // Mixed winding: orient normals like the seed's before averaging.
  normals.forEach((n) => { if (n.dot(normals[0]) < -0.2) n.negate(); });
  const E = eigen(cov(normals, areas));
  const [l0, l1] = E.values;
  if (l0 > 0.03 || l1 < 0.004) return null; // a plane (no spread) or a doubly curved surface
  const axis = E.vectors[0];
  const T = F.topo.tri;
  const vertsOf = (tris: Iterable<number>) => { const ids = new Set<number>(); for (const t of tris) { ids.add(T[3 * t]); ids.add(T[3 * t + 1]); ids.add(T[3 * t + 2]); } return [...ids].map((i) => F.v(i)); };
  let fit = fitCircle(vertsOf(seed), axis);
  if (!fit || fit.rms > 0.02 * fit.radius) return null;
  // 2. Grow over the whole wall: smooth neighbours whose corners lie on the same cylinder.
  const onCyl = (p: THREE.Vector3, f: NonNullable<typeof fit>, tol: number) => {
    const d = p.clone().sub(f.center);
    const r = d.sub(f.axis.clone().multiplyScalar(d.dot(f.axis))).length();
    return Math.abs(r - f.radius) <= tol;
  };
  const tris = new Set<number>();
  const queue = [t0];
  const visited = new Set([t0]);
  let tol = Math.max(fit.radius * 0.02, fit.rms * 3);
  for (let i = 0; i < queue.length && tris.size < 200000; i++) {
    const t = queue[i];
    const n = F.triNormal(t);
    if (Math.abs(n.dot(fit.axis)) > 0.25) continue;
    if (!(onCyl(F.v(T[3 * t]), fit, tol) && onCyl(F.v(T[3 * t + 1]), fit, tol) && onCyl(F.v(T[3 * t + 2]), fit, tol))) continue;
    tris.add(t);
    // Refit as the wall grows, so a long wall is not judged by a tiny first patch.
    if (tris.size === 24 || tris.size === 200 || tris.size === 2000) {
      const f2 = fitCircle(vertsOf(tris), fit.axis);
      if (f2 && f2.rms < 0.02 * f2.radius) { fit = f2; tol = Math.max(fit.radius * 0.02, fit.rms * 3); }
    }
    for (const o of F.neighbours(t, true, nb)) if (!visited.has(o)) { visited.add(o); queue.push(o); }
  }
  if (tris.size < 2) return null;
  const pts = vertsOf(tris);
  const final = fitCircle(pts, fit.axis) || fit;
  final.radius = outerRadius(pts, final.center, final.axis, final.radius, tol);
  // Axial extent and angular coverage.
  const ax = final.axis;
  let tMin = Infinity, tMax = -Infinity;
  const angles: number[] = [];
  for (const p of pts) {
    const d = p.clone().sub(final.center);
    const t = d.dot(ax);
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    angles.push(Math.atan2(d.dot(final.w), d.dot(final.u)));
  }
  angles.sort((x, y) => x - y);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const sweep = THREE.MathUtils.radToDeg(2 * Math.PI - gap);
  if (sweep < 25) return null;
  // Hole (normals face the axis) or boss (normals face away).
  let inward = 0;
  for (const t of tris) {
    const c = F.v(T[3 * t]).add(F.v(T[3 * t + 1])).add(F.v(T[3 * t + 2])).divideScalar(3);
    const radial = c.sub(final.center); radial.sub(ax.clone().multiplyScalar(radial.dot(ax)));
    inward += F.triNormal(t).dot(radial) < 0 ? 1 : -1;
  }
  const full = sweep > 300;
  // Double-sided meshes with flipped winding: a full ring is a hole when its inside is open; trust the majority.
  const type: Cylinder['type'] = !full ? 'fillet' : inward > 0 ? 'hole' : 'boss';
  return {
    center: final.center.clone(), axis: ax.clone(), radius: final.radius,
    start: final.center.clone().addScaledVector(ax, tMin), end: final.center.clone().addScaledVector(ax, tMax),
    depth: tMax - tMin, sweep, type, tris,
  };
}

// ------------------------------------------------------------------ what is under the cursor

export interface ScreenPt { x: number; y: number }
export interface NearEdge { e: number; point: THREE.Vector3; px: number }
export interface Nearby { corner?: { v: number; point: THREE.Vector3; px: number }; edge?: NearEdge }

/**
 * Model corners and edges near the cursor. `reach` is how far (world units) around the hit point to look; `ray` is
 * the camera ray through the cursor, so the point taken on an edge is the one under the cursor even in perspective.
 */
export function nearby(F: MeshFeatures, hitPoint: THREE.Vector3, reach: number, ray: THREE.Ray, cursor: ScreenPt, toScreen: (v: THREE.Vector3) => ScreenPt, edgePx: number, cornerPx: number): Nearby {
  const { eA, eB } = F.topo;
  const out: Nearby = {};
  const doneV = new Set<number>();
  const onRay = new THREE.Vector3();
  for (const e of F.edgesNear(hitPoint, reach)) {
    const A = F.v(eA[e]), B = F.v(eB[e]);
    const P = new THREE.Vector3();
    ray.distanceSqToSegment(A, B, onRay, P);
    // Must be about as near as the surface under the cursor (not an edge behind it).
    if (P.distanceTo(hitPoint) <= reach) {
      const sp = toScreen(P);
      const px = Math.hypot(sp.x - cursor.x, sp.y - cursor.y);
      if (px <= edgePx && (!out.edge || px < out.edge.px)) out.edge = { e, point: P, px };
    }
    for (const [v, Q] of [[eA[e], A], [eB[e], B]] as const) {
      if (doneV.has(v)) continue;
      doneV.add(v);
      if (Q.distanceTo(hitPoint) > reach) continue;
      const S = toScreen(Q);
      const d = Math.hypot(S.x - cursor.x, S.y - cursor.y);
      if (d <= cornerPx && (!out.corner || d < out.corner.px) && F.isCorner(v)) out.corner = { v, point: Q.clone(), px: d };
    }
  }
  return out;
}

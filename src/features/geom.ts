import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { ctx } from '../context';

/** A mesh reduced to shared positions (welded) and triangle indices, plus optional per-vertex colour. */
export interface Welded {
  pos: Float32Array;
  idx: Uint32Array;
  colors: Float32Array | null;
}

/** Welds vertices that share a position (within a tolerance relative to the mesh size). */
export function weld(mesh: THREE.Mesh, tol = 1e-6): Welded {
  const g = mesh.geometry;
  const p = g.attributes.position;
  const n = p.count;
  const box = (g.computeBoundingBox(), g.boundingBox!);
  const eps = (box.getSize(new THREE.Vector3()).length() || 1) * tol;
  // Per-vertex colour: existing vertex colours, or the colour of the material slot (keeps CAD face colours).
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const col = g.attributes.color;
  const groupColor = (v: number) => {
    const grp = g.groups.find((gr) => {
      const start = gr.start, end = gr.start + gr.count;
      return g.index ? false : v >= start && v < end;
    });
    const m: any = mats[grp?.materialIndex ?? 0];
    return m?.color ?? null;
  };
  const wantColors = !!col || mats.length > 1;
  const map = new Uint32Array(n);
  const keyToId = new Map<string, number>();
  const pos: number[] = [];
  const colors: number[] = [];
  for (let v = 0; v < n; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const k = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = keyToId.get(k);
    if (id === undefined) {
      id = pos.length / 3;
      keyToId.set(k, id);
      pos.push(x, y, z);
      if (wantColors) {
        if (col) colors.push(col.getX(v), col.getY(v), col.getZ(v));
        else { const c = groupColor(v); colors.push(c?.r ?? 1, c?.g ?? 1, c?.b ?? 1); }
      }
    }
    map[v] = id;
  }
  // Triangles (indexed geometries with material groups: colour from the group that owns the triangle).
  const tri: number[] = [];
  const idxAttr = g.index;
  const triCount = idxAttr ? idxAttr.count / 3 : n / 3;
  for (let t = 0; t < triCount; t++) {
    const a = map[idxAttr ? idxAttr.getX(t * 3) : t * 3];
    const b = map[idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1];
    const c = map[idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2];
    if (a === b || b === c || a === c) continue; // degenerate
    tri.push(a, b, c);
    if (idxAttr && mats.length > 1 && !col) {
      const grp = g.groups.find((gr) => t * 3 >= gr.start && t * 3 < gr.start + gr.count);
      const m: any = mats[grp?.materialIndex ?? 0];
      if (m?.color) for (const v of [a, b, c]) { colors[v * 3] = m.color.r; colors[v * 3 + 1] = m.color.g; colors[v * 3 + 2] = m.color.b; }
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(tri), colors: wantColors ? new Float32Array(colors) : null };
}

const edgeKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

export interface Analysis {
  triangles: number;
  vertices: number;
  openEdges: number;
  nonManifoldEdges: number;
  parts: number;
  /** triangles in the largest part */
  largestPart: number;
  degenerate: number;
  inconsistentFaces: number;
  insideOut: boolean;
  watertight: boolean;
  /** open-edge segments in the mesh's local space, for highlighting */
  openSegments: Float32Array;
}

export function analyse(mesh: THREE.Mesh): Analysis {
  const w = weld(mesh);
  const g = mesh.geometry;
  const rawTris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  const n = w.pos.length / 3;
  const counts = new Map<number, number>();
  const dirs = new Map<number, number>(); // +1/-1 per direction seen, to detect inconsistent winding
  for (let t = 0; t < w.idx.length; t += 3) {
    const v = [w.idx[t], w.idx[t + 1], w.idx[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = edgeKey(a, b, n);
      counts.set(k, (counts.get(k) || 0) + 1);
      dirs.set(k, (dirs.get(k) || 0) + (a < b ? 1 : -1));
    }
  }
  let open = 0, nonManifold = 0, inconsistent = 0;
  const seg: number[] = [];
  for (const [k, c] of counts) {
    if (c === 1) {
      open++;
      const a = Math.floor(k / n), b = k % n;
      seg.push(w.pos[a * 3], w.pos[a * 3 + 1], w.pos[a * 3 + 2], w.pos[b * 3], w.pos[b * 3 + 1], w.pos[b * 3 + 2]);
    } else if (c > 2) nonManifold++;
    else if (c === 2 && dirs.get(k) !== 0) inconsistent++;
  }
  const comps = components(w);
  let vol = 0;
  for (let t = 0; t < w.idx.length; t += 3) vol += signedTetra(w.pos, w.idx[t], w.idx[t + 1], w.idx[t + 2]);
  return {
    triangles: w.idx.length / 3, vertices: n, openEdges: open, nonManifoldEdges: nonManifold,
    parts: comps.count, largestPart: Math.max(0, ...comps.sizes), degenerate: Math.round(rawTris - w.idx.length / 3),
    inconsistentFaces: inconsistent, insideOut: open === 0 && vol < 0, watertight: open === 0 && nonManifold === 0,
    openSegments: new Float32Array(seg),
  };
}

function signedTetra(p: Float32Array, a: number, b: number, c: number) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
  const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

/** Connected parts: returns the part id of every triangle. */
export function components(w: Welded) {
  const n = w.pos.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < w.idx.length; t += 3) {
    const a = find(w.idx[t]), b = find(w.idx[t + 1]), c = find(w.idx[t + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const ids = new Map<number, number>();
  const triPart = new Int32Array(w.idx.length / 3);
  const sizes: number[] = [];
  for (let t = 0; t < triPart.length; t++) {
    const r = find(w.idx[t * 3]);
    let id = ids.get(r);
    if (id === undefined) { id = sizes.length; ids.set(r, id); sizes.push(0); }
    triPart[t] = id;
    sizes[id]++;
  }
  return { count: sizes.length, sizes, triPart };
}

/** Makes triangle winding consistent across each part, then turns inside-out parts the right way round. */
export function orient(w: Welded): Welded {
  const n = w.pos.length / 3;
  const T = w.idx.length / 3;
  const idx = w.idx.slice();
  const edgeFaces = new Map<number, number[]>();
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) {
    const k = edgeKey(idx[t * 3 + e], idx[t * 3 + (e + 1) % 3], n);
    const l = edgeFaces.get(k); if (l) l.push(t); else edgeFaces.set(k, [t]);
  }
  const hasDirected = (t: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) if (idx[t * 3 + e] === a && idx[t * 3 + (e + 1) % 3] === b) return true;
    return false;
  };
  const visited = new Uint8Array(T);
  const comp = new Int32Array(T).fill(-1);
  let compId = 0;
  for (let s = 0; s < T; s++) {
    if (visited[s]) continue;
    const queue = [s]; visited[s] = 1; comp[s] = compId;
    while (queue.length) {
      const t = queue.pop()!;
      for (let e = 0; e < 3; e++) {
        const a = idx[t * 3 + e], b = idx[t * 3 + (e + 1) % 3];
        for (const f of edgeFaces.get(edgeKey(a, b, n)) || []) {
          if (f === t || visited[f]) continue;
          // A consistent neighbour walks the shared edge the other way (b→a).
          if (hasDirected(f, a, b)) { const x = idx[f * 3 + 1]; idx[f * 3 + 1] = idx[f * 3 + 2]; idx[f * 3 + 2] = x; }
          visited[f] = 1; comp[f] = compId; queue.push(f);
        }
      }
    }
    compId++;
  }
  const vol = new Float64Array(compId);
  for (let t = 0; t < T; t++) vol[comp[t]] += signedTetra(w.pos, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  for (let t = 0; t < T; t++) if (vol[comp[t]] < 0) { const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x; }
  return { ...w, idx };
}

/** Closes boundary loops with a fan of triangles around the loop's centre. */
export function fillHoles(w: Welded): { welded: Welded; filled: number } {
  const n = w.pos.length / 3;
  const counts = new Map<number, number>();
  for (let t = 0; t < w.idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const k = edgeKey(w.idx[t + e], w.idx[t + (e + 1) % 3], n);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // Boundary edges walked opposite to their triangle, so the patch faces the same way as the surface.
  const next = new Map<number, number>();
  for (let t = 0; t < w.idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = w.idx[t + e], b = w.idx[t + (e + 1) % 3];
    if (counts.get(edgeKey(a, b, n)) === 1) next.set(b, a);
  }
  const pos = Array.from(w.pos);
  const colors = w.colors ? Array.from(w.colors) : null;
  const idx = Array.from(w.idx);
  let filled = 0;
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v = start, guard = 0;
    while (!used.has(v) && next.has(v) && guard++ < 1e6) { used.add(v); loop.push(v); v = next.get(v)!; }
    if (v !== start || loop.length < 3) continue;
    if (loop.length === 3) { idx.push(loop[0], loop[1], loop[2]); filled++; continue; }
    let cx = 0, cy = 0, cz = 0, cr = 0, cg = 0, cb = 0;
    for (const l of loop) {
      cx += w.pos[l * 3]; cy += w.pos[l * 3 + 1]; cz += w.pos[l * 3 + 2];
      if (w.colors) { cr += w.colors[l * 3]; cg += w.colors[l * 3 + 1]; cb += w.colors[l * 3 + 2]; }
    }
    const c = pos.length / 3;
    pos.push(cx / loop.length, cy / loop.length, cz / loop.length);
    if (colors) colors.push(cr / loop.length, cg / loop.length, cb / loop.length);
    for (let i = 0; i < loop.length; i++) idx.push(c, loop[i], loop[(i + 1) % loop.length]);
    filled++;
  }
  return { welded: { pos: new Float32Array(pos), idx: new Uint32Array(idx), colors: colors ? new Float32Array(colors) : null }, filled };
}

/** Drops parts smaller than `minShare` of the largest part. */
export function removeSmallParts(w: Welded, minShare: number): { welded: Welded; removed: number } {
  const c = components(w);
  const largest = Math.max(...c.sizes);
  const keep: number[] = [];
  let removed = 0;
  const removedParts = new Set<number>();
  for (let t = 0; t < c.triPart.length; t++) {
    if (c.sizes[c.triPart[t]] >= largest * minShare) keep.push(w.idx[t * 3], w.idx[t * 3 + 1], w.idx[t * 3 + 2]);
    else removedParts.add(c.triPart[t]);
  }
  removed = removedParts.size;
  return { welded: { ...w, idx: new Uint32Array(keep) }, removed };
}

/** Builds a display-ready geometry: creased normals keep sharp CAD edges crisp and curved surfaces smooth. */
export function toGeometry(w: Welded, creaseDeg = 30): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(w.pos, 3));
  if (w.colors) g.setAttribute('color', new THREE.BufferAttribute(w.colors, 3));
  g.setIndex(new THREE.BufferAttribute(w.idx, 1));
  const out = toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** A material that shows vertex colours when the new geometry carries them. */
function materialFor(mesh: THREE.Mesh, g: THREE.BufferGeometry): THREE.Material {
  const first = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as any;
  const m = first.clone();
  if (g.attributes.color && (Array.isArray(mesh.material) || !first.vertexColors)) {
    m.vertexColors = true;
    if (m.color) m.color.set(0xffffff);
  }
  return m;
}

/** Replaces mesh geometries in one undoable step. */
export function replaceGeometries(changes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[], label: string) {
  if (!changes.length) return;
  const before = changes.map(({ mesh }) => ({ mesh, geometry: mesh.geometry, material: mesh.material }));
  const after = changes.map(({ mesh, geometry }) => ({
    mesh, geometry,
    material: geometry.attributes.color || Array.isArray(mesh.material) ? materialFor(mesh, geometry) : mesh.material,
  }));
  const apply = (list: typeof before) => {
    for (const s of list) { s.mesh.geometry = s.geometry; s.mesh.material = s.material; s.mesh.userData.paintReady = false; }
    ctx.viewer.refreshMaterials();
    ctx.refresh();
  };
  ctx.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
  apply(after);
}

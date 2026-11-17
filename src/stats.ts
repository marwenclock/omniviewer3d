import * as THREE from 'three';

export const UNITS = {
  mm: { label: 'Millimetres', short: 'mm', toMeters: 0.001 },
  cm: { label: 'Centimetres', short: 'cm', toMeters: 0.01 },
  m: { label: 'Metres', short: 'm', toMeters: 1 },
  in: { label: 'Inches', short: 'in', toMeters: 0.0254 },
  ft: { label: 'Feet', short: 'ft', toMeters: 0.3048 },
  u: { label: 'Unitless', short: 'u', toMeters: 1 },
} as const;
export type Unit = keyof typeof UNITS;

export function fmtLen(v: number, unit: Unit, digits = 3): string {
  return `${fmtNum(v, digits)} ${UNITS[unit].short}`;
}

export function fmtNum(v: number, digits = 3): string {
  if (!isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.001 || a >= 1e7)) return v.toExponential(2);
  return Number(v.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export const fmtInt = (v: number) => v.toLocaleString();

export interface ModelStats {
  meshes: number;
  vertices: number;
  triangles: number;
  points: number;
  materials: number;
  textures: number;
  size: THREE.Vector3;
  center: THREE.Vector3;
  area: number;
  volume: number;
  /** true / false when checked; null when not checked yet (large meshes are checked in the background, OV-025) */
  closed: boolean | null;
  /** meshes skipped by the quick closedness check */
  unchecked: THREE.Mesh[];
  /** parts whose triangles wind inwards (inside-out); their volume is counted by its absolute size */
  invertedParts: number;
  /** hidden parts left out of these numbers (OV-026) */
  hiddenParts: number;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3();

/**
 * Counts geometry and computes world-space surface area and volume
 * (signed tetrahedron sum, valid for closed meshes).
 */
export function computeStats(root: THREE.Object3D | null, box: THREE.Box3, quickLimit = 400_000): ModelStats {
  const s: ModelStats = {
    meshes: 0, vertices: 0, triangles: 0, points: 0, materials: 0, textures: 0,
    size: box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3()),
    center: box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()),
    area: 0, volume: 0, closed: true, unchecked: [], invertedParts: 0, hiddenParts: 0,
  };
  const shown = (o: THREE.Object3D | null) => { while (o && o !== root!.parent) { if (!o.visible) return false; o = o.parent; } return true; };
  if (!root) return s;
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  root.updateWorldMatrix(true, true);
  root.traverse((o: any) => {
    if (o.userData.helper || o.userData.proxy) return;
    if (o.userData.splat) { if (o.userData.splatCount) s.points += o.userData.splatCount; return; }
    if (o.isPoints) { s.points += o.geometry.attributes.position?.count || 0; return; }
    if (!o.isMesh) return;
    if (!shown(o)) { s.hiddenParts++; return; }
    const g: THREE.BufferGeometry = o.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    if (!pos) return;
    s.meshes++;
    s.vertices += pos.count;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach((m: any) => {
      if (!m) return;
      mats.add(m);
      for (const k of Object.keys(m)) if (m[k]?.isTexture) texs.add(m[k]);
    });
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    s.triangles += Math.floor(triCount);
    const m = o.matrixWorld;
    let area = 0, vol = 0;
    // Closedness test: after welding equal positions, every edge must be shared by exactly two triangles.
    const checkClosed = triCount < quickLimit;
    const edgeCount = checkClosed ? new Map<number, number>() : null;
    let ids: Uint32Array | null = null;
    let n = 0;
    if (checkClosed) {
      g.computeBoundingBox();
      const eps = (g.boundingBox!.getSize(_a).length() || 1) * 1e-6;
      const weld = new Map<string, number>();
      ids = new Uint32Array(pos.count);
      for (let v = 0; v < pos.count; v++) {
        const k = `${Math.round(pos.getX(v) / eps)},${Math.round(pos.getY(v) / eps)},${Math.round(pos.getZ(v) / eps)}`;
        let id = weld.get(k);
        if (id === undefined) { id = weld.size; weld.set(k, id); }
        ids[v] = id;
      }
      n = weld.size;
    }
    for (let t = 0; t < Math.floor(triCount); t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      _a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      _b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      _c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      _ab.subVectors(_b, _a); _ac.subVectors(_c, _a);
      area += _ab.cross(_ac).length() / 2;
      vol += _a.dot(_ab.crossVectors(_b, _c)) / 6;
      if (edgeCount && ids) {
        const w0 = ids[i0], w1 = ids[i1], w2 = ids[i2];
        for (const [p, q] of [[w0, w1], [w1, w2], [w2, w0]]) {
          if (p === q) continue;
          const k = p < q ? p * n + q : q * n + p;
          edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
        }
      }
    }
    s.area += area;
    // Per-part absolute volume: an inside-out part no longer cancels out another part's volume (OV-026).
    if (vol < 0) s.invertedParts++;
    s.volume += Math.abs(vol);
    if (!edgeCount) { s.unchecked.push(o); if (s.closed === true) s.closed = null; }
    else for (const c of edgeCount.values()) if (c !== 2) { s.closed = false; break; }
  });
  s.materials = mats.size;
  s.textures = texs.size;
  return s;
}

// ------------------------------------------------------------------ background closedness check (OV-025, OV-088)
const WORKER_SRC = `onmessage = (e) => {
  const { pos, idx, eps } = e.data;
  const n = pos.length / 3, tri = idx ? idx.length / 3 : n / 3;
  const weld = new Map(); const ids = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const k = Math.round(pos[v*3]/eps) + ',' + Math.round(pos[v*3+1]/eps) + ',' + Math.round(pos[v*3+2]/eps);
    let id = weld.get(k); if (id === undefined) { id = weld.size; weld.set(k, id); } ids[v] = id;
  }
  const W = weld.size, edges = new Map();
  for (let t = 0; t < tri; t++) {
    const a = ids[idx ? idx[t*3] : t*3], b = ids[idx ? idx[t*3+1] : t*3+1], c = ids[idx ? idx[t*3+2] : t*3+2];
    for (const [p, q] of [[a,b],[b,c],[c,a]]) { if (p === q) continue; const k = p < q ? p * W + q : q * W + p; edges.set(k, (edges.get(k) || 0) + 1); }
  }
  for (const c of edges.values()) if (c !== 2) { postMessage(false); return; }
  postMessage(true);
};`;

/** Checks whether large meshes are closed in a Web Worker, so the page stays responsive. */
export async function checkClosedAsync(meshes: THREE.Mesh[], signal?: AbortSignal): Promise<boolean> {
  if (!meshes.length) return true;
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  try {
    for (const m of meshes) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const g = m.geometry;
      g.computeBoundingBox();
      const eps = (g.boundingBox!.getSize(new THREE.Vector3()).length() || 1) * 1e-6;
      const pos = new Float32Array((g.attributes.position as THREE.BufferAttribute).array as ArrayLike<number>);
      const idx = g.index ? new Uint32Array(g.index.array as ArrayLike<number>) : null;
      const ok = await new Promise<boolean>((resolve, reject) => {
        const w = new Worker(url);
        const stop = () => { w.terminate(); reject(new DOMException('Cancelled', 'AbortError')); };
        signal?.addEventListener('abort', stop, { once: true });
        w.onmessage = (e) => { signal?.removeEventListener('abort', stop); w.terminate(); resolve(!!e.data); };
        w.onerror = (e) => { signal?.removeEventListener('abort', stop); w.terminate(); reject(new Error(e.message)); };
        w.postMessage({ pos, idx, eps }, idx ? [pos.buffer, idx.buffer] : [pos.buffer]);
      });
      if (!ok) return false;
    }
    return true;
  } finally { URL.revokeObjectURL(url); }
}

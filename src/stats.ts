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
  /** true when every mesh looked closed (volume is meaningful) */
  closed: boolean;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3();

/**
 * Counts geometry and computes world-space surface area and volume
 * (signed tetrahedron sum, valid for closed meshes).
 */
export function computeStats(root: THREE.Object3D | null, box: THREE.Box3): ModelStats {
  const s: ModelStats = {
    meshes: 0, vertices: 0, triangles: 0, points: 0, materials: 0, textures: 0,
    size: box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3()),
    center: box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()),
    area: 0, volume: 0, closed: true,
  };
  if (!root) return s;
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  root.updateWorldMatrix(true, true);
  root.traverse((o: any) => {
    if (o.userData.helper || o.userData.proxy) return;
    if (o.userData.splat) { if (o.userData.splatCount) s.points += o.userData.splatCount; return; }
    if (o.isPoints) { s.points += o.geometry.attributes.position?.count || 0; return; }
    if (!o.isMesh) return;
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
    const checkClosed = triCount < 1_500_000;
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
    s.volume += vol;
    if (!edgeCount) s.closed = false;
    else for (const c of edgeCount.values()) if (c !== 2) { s.closed = false; break; }
  });
  s.volume = Math.abs(s.volume);
  s.materials = mats.size;
  s.textures = texs.size;
  return s;
}

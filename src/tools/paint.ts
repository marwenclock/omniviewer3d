import * as THREE from 'three';
import type { Viewer } from '../viewer';
import type { History } from '../history';
import { topology } from './features';

/**
 * brush: free strokes · area: a face region up to the model's edges (creases, like the colour boundaries a slicer
 * shows) · piece: one connected body of the mesh · object: the whole part (material colour).
 */
export type PaintMode = 'object' | 'brush' | 'area' | 'piece';

/**
 * Triangles reachable from t0 without crossing a model edge (area) or at all (piece). Uses the welded topology of
 * the measure tool, so triangle t here is triangle t of the geometry (same order for indexed and non-indexed).
 */
export function regionFrom(geo: THREE.BufferGeometry, t0: number, mode: 'area' | 'piece'): Uint32Array | null {
  const T = topology(geo);
  if (!T || t0 < 0 || t0 >= T.triCount) return null;
  const { triE, eT0, eT1, eFeat } = T;
  const seen = new Uint8Array(T.triCount);
  const out: number[] = [t0];
  seen[t0] = 1;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    for (let k = 0; k < 3; k++) {
      const e = triE[3 * t + k];
      if (e < 0 || (mode === 'area' && eFeat[e])) continue;
      const o = eT0[e] === t ? eT1[e] : eT0[e];
      if (o >= 0 && !seen[o]) { seen[o] = 1; out.push(o); }
    }
  }
  return Uint32Array.from(out);
}

interface MeshState {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  colors: Float32Array | null;
}

const snapshot = (mesh: THREE.Mesh): MeshState => ({
  mesh,
  geometry: mesh.geometry,
  material: mesh.material,
  colors: mesh.geometry.attributes.color ? (mesh.geometry.attributes.color.array as Float32Array).slice() : null,
});

const restore = (s: MeshState) => {
  s.mesh.geometry = s.geometry;
  s.mesh.material = s.material;
  if (s.colors && s.geometry.attributes.color) {
    (s.geometry.attributes.color.array as Float32Array).set(s.colors);
    s.geometry.attributes.color.needsUpdate = true;
  }
};

/**
 * Paint tool: colour a whole part ("object") or brush colour onto faces ("brush", stored as vertex colours
 * so it survives GLB / PLY export).
 */
export class PaintTool {
  active = false;
  mode: PaintMode = 'brush';
  color = new THREE.Color('#e4572e');
  /** brush radius as a fraction of the model's diagonal */
  radius = 0.03;
  private stroke: Map<THREE.Mesh, MeshState> | null = null;
  private lastHit: THREE.Vector3 | null = null;
  private lastObject: THREE.Object3D | null = null;
  private centroids = new WeakMap<THREE.BufferGeometry, Float32Array>();
  private cursor: THREE.Mesh;
  private listeners = new Set<() => void>();
  /** region under the cursor in area / piece mode, drawn as a see-through preview of the fill */
  private preview: THREE.Mesh;
  private region: { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mode: PaintMode; tris: Uint32Array; set: Set<number> } | null = null;
  onPainted: () => void = () => {};

  constructor(private viewer: Viewer, private history: History) {
    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.cursor.renderOrder = 999;
    this.cursor.userData.helper = true;
    this.cursor.visible = false;
    this.cursor.raycast = () => {};
    this.cursor.userData.noShot = true;
    viewer.overlay.add(this.cursor);
    this.preview = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    Object.assign(this.preview.userData, { helper: true, noShot: true });
    this.preview.raycast = () => {};
    this.preview.matrixAutoUpdate = false;
    this.preview.visible = false;
    this.preview.renderOrder = 998;
    viewer.overlay.add(this.preview);
  }

  get fills() { return this.mode === 'area' || this.mode === 'piece'; }

  /** The fill region around a hit triangle, cached while the cursor stays inside it. */
  private regionAt(mesh: THREE.Mesh, face: number) {
    const r = this.region;
    if (r && r.mesh === mesh && r.geo === mesh.geometry && r.mode === this.mode && r.set.has(face)) return r;
    const tris = regionFrom(mesh.geometry, face, this.mode as 'area' | 'piece');
    if (!tris) return null;
    this.region = { mesh, geo: mesh.geometry, mode: this.mode, tris, set: new Set(tris) };
    this.region.set = tris.length > 400000 ? new Set([face]) : this.region.set; // huge regions: recompute instead of a giant set
    return this.region;
  }

  private showPreview(hit: THREE.Intersection | null) {
    if (!hit || !this.fills || !(hit.object as any).isMesh || hit.faceIndex == null) { this.preview.visible = false; return; }
    const mesh = hit.object as THREE.Mesh;
    const prev = this.region;
    const r = this.regionAt(mesh, hit.faceIndex);
    if (!r) { this.preview.visible = false; return; }
    if (r !== prev || !this.preview.visible) {
      const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
      const arr = new Float32Array(r.tris.length * 9);
      r.tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const v = idx ? idx.getX(3 * t + k) : 3 * t + k;
          arr[i * 9 + k * 3] = pos.getX(v); arr[i * 9 + k * 3 + 1] = pos.getY(v); arr[i * 9 + k * 3 + 2] = pos.getZ(v);
        }
      });
      this.preview.geometry.dispose();
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      this.preview.geometry = pg;
    }
    (this.preview.material as THREE.MeshBasicMaterial).color.copy(this.color);
    this.viewer.overlay.updateMatrixWorld();
    this.preview.matrix.copy(this.viewer.overlay.matrixWorld).invert().multiply(mesh.matrixWorld);
    this.preview.matrixWorldNeedsUpdate = true;
    this.preview.visible = true;
  }

  /** Colours a whole region (area / piece) with vertex colours. */
  private paintRegion(mesh: THREE.Mesh, face: number) {
    const r = this.regionAt(mesh, face);
    if (!r) return;
    const tris = r.tris;
    this.prepareForBrush(mesh);
    const col = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    const { r: cr, g: cg, b: cb } = this.color;
    for (let i = 0; i < tris.length; i++) for (let k = 0; k < 3; k++) {
      const o = (tris[i] * 3 + k) * 3;
      arr[o] = cr; arr[o + 1] = cg; arr[o + 2] = cb;
    }
    col.needsUpdate = true;
    // prepareForBrush may have swapped in a non-indexed copy: same triangle order, so the region stays valid.
    if (this.region) { this.region.geo = mesh.geometry; }
  }

  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  setActive(on: boolean) {
    this.active = on;
    this.cursor.visible = false;
    this.preview.visible = false;
    this.region = null;
    this.viewer.controls.enabled = true;
    this.emit();
  }

  private worldRadius() {
    return this.viewer.bounds().getSize(new THREE.Vector3()).length() * this.radius;
  }

  onPointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0) return false;
    const hit = this.viewer.pick(e);
    if (!hit || !(hit.object as any).isMesh) return false;
    this.viewer.controls.enabled = false;
    this.stroke = new Map();
    this.apply(hit);
    this.lastHit = hit.point.clone();
    this.lastObject = hit.object;
    return true;
  }

  onPointerMove(e: PointerEvent) {
    if (!this.active) return;
    const hit = this.viewer.pick(e);
    this.cursor.visible = !!hit && this.mode === 'brush';
    this.showPreview(this.mode === 'object' ? null : hit);
    if (hit && hit.face) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      this.cursor.position.copy(hit.point).addScaledVector(n, this.worldRadius() * 0.02);
      this.cursor.lookAt(hit.point.clone().add(n));
      this.cursor.scale.setScalar(this.worldRadius());
    }
    if (this.stroke && hit && this.mode === 'brush') {
      // Fill the gap since the last event so fast strokes stay continuous.
      const step = this.worldRadius() * 0.5;
      const last = this.lastHit;
      if (last && hit.object === this.lastObject && step > 0) {
        const dist = last.distanceTo(hit.point);
        const n = Math.min(64, Math.floor(dist / step));
        for (let i = 1; i <= n; i++) {
          this.paintBrush(hit.object as THREE.Mesh, last.clone().lerp(hit.point, i / (n + 1)), -1);
        }
      }
      this.apply(hit);
      this.lastHit = hit.point.clone();
      this.lastObject = hit.object;
    } else if (this.stroke && hit && this.fills && hit.faceIndex != null) {
      // Dragging across several areas fills each one once.
      const r = this.region;
      if (!(r && r.mesh === hit.object && r.set.has(hit.faceIndex) && this.filled.has(r))) this.apply(hit);
    }
  }
  private filled = new WeakSet<object>();

  onPointerUp() {
    if (!this.stroke) return;
    this.viewer.controls.enabled = true;
    const before = [...this.stroke.values()];
    const after = before.map((b) => snapshot(b.mesh));
    this.stroke = null;
    if (!before.length) return;
    this.history.push({
      label: ({ brush: 'Brush paint', area: 'Fill area', piece: 'Paint piece', object: 'Paint part' } as const)[this.mode],
      undo: () => { before.forEach(restore); this.onPainted(); },
      redo: () => { after.forEach(restore); this.onPainted(); },
    });
    this.onPainted();
  }

  private apply(hit: THREE.Intersection) {
    const mesh = hit.object as THREE.Mesh;
    if (!this.stroke!.has(mesh)) this.stroke!.set(mesh, snapshot(mesh));
    if (this.mode === 'object') this.paintObject(mesh, hit.face?.materialIndex ?? 0);
    else if (this.fills) { this.paintRegion(mesh, hit.faceIndex ?? -1); if (this.region) this.filled.add(this.region); }
    else this.paintBrush(mesh, hit.point, hit.faceIndex ?? -1);
  }

  private paintObject(mesh: THREE.Mesh, materialIndex: number) {
    const color = this.color.clone();
    const recolor = (m: THREE.Material) => {
      const c: any = m.clone();
      if (c.color) c.color.copy(color);
      c.vertexColors = false;
      return c as THREE.Material;
    };
    if (Array.isArray(mesh.material)) {
      const mats = mesh.material.slice();
      mats[materialIndex] = recolor(mats[materialIndex]);
      mesh.material = mats;
    } else mesh.material = recolor(mesh.material);
    this.viewer.refreshMaterials();
  }

  /** Makes sure the mesh has its own non-indexed geometry with a colour attribute. */
  private prepareForBrush(mesh: THREE.Mesh) {
    if (mesh.userData.paintReady && mesh.geometry.attributes.color) return;
    let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const count = g.attributes.position.count;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const colors = new Float32Array(count * 3);
    const existing = g.attributes.color as THREE.BufferAttribute | undefined;
    // Start from the current look: existing vertex colours, or each material's base colour.
    for (let v = 0; v < count; v++) {
      let c = new THREE.Color(1, 1, 1);
      if (existing) c.setRGB(existing.getX(v), existing.getY(v), existing.getZ(v));
      else {
        const group = g.groups.find((gr) => v >= gr.start && v < gr.start + gr.count);
        const m: any = mats[group?.materialIndex ?? 0];
        if (m?.color && !m.map) c.copy(m.color);
      }
      colors.set([c.r, c.g, c.b], v * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.geometry = g;
    const fix = (m: any) => {
      const c = m.clone();
      c.vertexColors = true;
      if (c.color && !c.map) c.color.set(0xffffff);
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
    mesh.userData.paintReady = true;
    this.viewer.refreshMaterials();
  }

  private paintBrush(mesh: THREE.Mesh, worldPoint: THREE.Vector3, faceIndex: number) {
    this.prepareForBrush(mesh);
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = g.attributes.color as THREE.BufferAttribute;
    let cents = this.centroids.get(g);
    if (!cents) {
      cents = new Float32Array(pos.count); // one xyz per triangle = count/3*3
      for (let t = 0; t < pos.count / 3; t++) {
        for (let k = 0; k < 3; k++) {
          cents[t * 3 + k] = (pos.array[(t * 3) * 3 + k] + pos.array[(t * 3 + 1) * 3 + k] + pos.array[(t * 3 + 2) * 3 + k]) / 3;
        }
      }
      this.centroids.set(g, cents);
    }
    const local = mesh.worldToLocal(worldPoint.clone());
    const scale = mesh.matrixWorld.getMaxScaleOnAxis() || 1;
    const r = this.worldRadius() / scale;
    const r2 = r * r;
    const { r: cr, g: cg, b: cb } = this.color;
    const arr = col.array as Float32Array;
    let changed = false;
    for (let t = 0; t < pos.count / 3; t++) {
      const dx = cents[t * 3] - local.x, dy = cents[t * 3 + 1] - local.y, dz = cents[t * 3 + 2] - local.z;
      if (t !== faceIndex && dx * dx + dy * dy + dz * dz > r2) continue;
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * 3;
        arr[o] = cr; arr[o + 1] = cg; arr[o + 2] = cb;
      }
      changed = true;
    }
    if (changed) col.needsUpdate = true;
  }
}

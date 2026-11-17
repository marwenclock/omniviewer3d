import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Viewer } from '../viewer';

export interface Measurement {
  id: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  na: THREE.Vector3 | null;
  nb: THREE.Vector3 | null;
  distance: number;
  delta: THREE.Vector3;
  /** angle between the two clicked surfaces, degrees */
  angle: number | null;
  /** distance between the two surfaces when they are parallel */
  parallelDistance: number | null;
  /** distance from the second point to the plane of the first clicked face */
  planeDistance: number | null;
  kind: 'distance' | 'circle';
  /** circle measurements: radius and centre through three points */
  radius?: number;
  center?: THREE.Vector3;
  group: THREE.Group;
}

/** Point-to-point measuring with optional vertex snapping. */
export class MeasureTool {
  active = false;
  snap = true;
  mode: 'distance' | 'circle' = 'distance';
  private circlePts: { p: THREE.Vector3; marker: THREE.Object3D }[] = [];
  list: Measurement[] = [];
  private pending: { p: THREE.Vector3; n: THREE.Vector3 | null; marker: THREE.Object3D } | null = null;
  private markers = new Set<THREE.Object3D>();
  private nextId = 1;
  private hover: THREE.Mesh;
  private listeners = new Set<() => void>();
  format: (v: number) => string = (v) => v.toFixed(3);

  constructor(private viewer: Viewer) {
    this.hover = this.makeMarker(0xffffff, 0.6);
    this.hover.visible = false;
    this.hover.userData.noShot = true;
    viewer.overlay.add(this.hover);
    // Keep markers a constant size on screen.
    viewer.onFrame(() => {
      const cam = viewer.camera;
      const fit = (o: THREE.Object3D) => {
        const d = cam instanceof THREE.OrthographicCamera ? (cam.top - cam.bottom) / cam.zoom : o.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position);
        o.scale.setScalar(d * 0.008);
      };
      this.markers.forEach(fit);
      if (this.hover.visible) fit(this.hover);
    });
  }

  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  setActive(on: boolean) {
    this.active = on;
    this.hover.visible = false;
    if (!on) this.cancelPending();
    this.emit();
  }

  private makeMarker(color: number, opacity = 1) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity }),
    );
    m.renderOrder = 999;
    m.userData.helper = true;
    m.raycast = () => {};
    return m;
  }

  private hitPoint(event: PointerEvent) {
    const hit = this.viewer.pick(event);
    if (!hit) return null;
    const p = hit.point.clone();
    let n: THREE.Vector3 | null = null;
    const obj = hit.object as THREE.Mesh;
    if (hit.face) n = hit.face.normal.clone().transformDirection(obj.matrixWorld).normalize();
    if (this.snap && hit.face && obj.geometry) {
      // Snap to the nearest triangle corner if it is within ~12px on screen.
      const pos = obj.geometry.attributes.position as THREE.BufferAttribute;
      const rect = this.viewer.renderer.domElement.getBoundingClientRect();
      let best: THREE.Vector3 | null = null, bestD = 12;
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        const s = v.clone().project(this.viewer.camera);
        const sx = ((s.x + 1) / 2) * rect.width + rect.left;
        const sy = ((1 - s.y) / 2) * rect.height + rect.top;
        const d = Math.hypot(sx - event.clientX, sy - event.clientY);
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best) p.copy(best);
    }
    return { p, n };
  }

  onPointerMove(event: PointerEvent) {
    if (!this.active) return;
    const h = this.hitPoint(event);
    this.hover.visible = !!h;
    if (h) this.hover.position.copy(h.p);
  }

  /** Returns true when the click was consumed. */
  onClick(event: PointerEvent): boolean {
    if (!this.active) return false;
    const h = this.hitPoint(event);
    if (!h) return true;
    if (this.mode === 'circle') { this.addCirclePoint(h.p); return true; }
    if (!this.pending) {
      const marker = this.makeMarker(0xffffff);
      marker.position.copy(h.p);
      this.viewer.overlay.add(marker);
      this.markers.add(marker);
      this.pending = { p: h.p, n: h.n, marker };
      return true;
    }
    this.finish(this.pending, h);
    return true;
  }

  private finish(start: NonNullable<MeasureTool['pending']>, end: { p: THREE.Vector3; n: THREE.Vector3 | null }) {
    const group = new THREE.Group();
    group.userData.helper = true;
    const a = start.p, b = end.p;
    this.viewer.overlay.remove(start.marker);
    this.markers.delete(start.marker);
    const ma = this.makeMarker(0xffffff); ma.position.copy(a);
    const mb = this.makeMarker(0xffffff); mb.position.copy(b);
    this.markers.add(ma); this.markers.add(mb);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
    );
    line.renderOrder = 998;
    line.userData.helper = true;
    line.raycast = () => {};
    const distance = a.distanceTo(b);
    const delta = new THREE.Vector3(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    let angle: number | null = null, parallelDistance: number | null = null;
    if (start.n && end.n) {
      angle = THREE.MathUtils.radToDeg(start.n.angleTo(end.n));
      if (angle < 1 || angle > 179) parallelDistance = Math.abs(b.clone().sub(a).dot(start.n));
    }
    const planeDistance = start.n ? Math.abs(b.clone().sub(a).dot(start.n)) : null;
    const el = document.createElement('div');
    el.className = 'measure-label';
    const id = this.nextId++;
    el.innerHTML = `<span class="ml-id">#${id}</span> ${this.format(distance)}`;
    const label = new CSS2DObject(el);
    label.position.copy(a).add(b).multiplyScalar(0.5);
    group.add(ma, mb, line, label);
    this.viewer.overlay.add(group);
    this.pending = null;
    this.list.push({ id, a, b, na: start.n, nb: end.n, distance, delta, angle, parallelDistance, planeDistance, kind: 'distance', group });
    this.emit();
  }

  /** Three clicks on a hole or round edge give its centre, radius and diameter. */
  private addCirclePoint(p: THREE.Vector3) {
    const marker = this.makeMarker(0xffffff);
    marker.position.copy(p);
    this.viewer.overlay.add(marker);
    this.markers.add(marker);
    this.circlePts.push({ p, marker });
    if (this.circlePts.length < 3) { this.emit(); return; }
    const [A, B, C] = this.circlePts.map((c) => c.p);
    for (const c of this.circlePts) { this.viewer.overlay.remove(c.marker); this.markers.delete(c.marker); }
    this.circlePts = [];
    // Circumcircle of the triangle ABC.
    const ab = B.clone().sub(A), ac = C.clone().sub(A);
    const n = ab.clone().cross(ac);
    const n2 = n.lengthSq();
    if (n2 < 1e-20) { this.emit(); return; } // points in a line
    const center = A.clone().add(
      n.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(n).multiplyScalar(ab.lengthSq())).divideScalar(2 * n2),
    );
    const radius = center.distanceTo(A);
    const group = new THREE.Group();
    group.userData.helper = true;
    const axisN = n.normalize();
    const u = A.clone().sub(center).normalize(), v = axisN.clone().cross(u);
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; ring.push(center.clone().addScaledVector(u, Math.cos(t) * radius).addScaledVector(v, Math.sin(t) * radius)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    const dia = new THREE.Line(new THREE.BufferGeometry().setFromPoints([center.clone().addScaledVector(u, -radius), center.clone().addScaledVector(u, radius)]),
      new THREE.LineDashedMaterial({ color: 0xffffff, depthTest: false, transparent: true, dashSize: radius / 10, gapSize: radius / 14 }));
    dia.computeLineDistances();
    for (const l of [line, dia]) { l.renderOrder = 998; l.userData.helper = true; l.raycast = () => {}; }
    const cm = this.makeMarker(0xffffff, 0.8); cm.position.copy(center); this.markers.add(cm);
    const el = document.createElement('div');
    el.className = 'measure-label';
    const id = this.nextId++;
    el.innerHTML = `<span class="ml-id">#${id}</span> ⌀ ${this.format(radius * 2)}`;
    const label = new CSS2DObject(el);
    label.position.copy(center);
    group.add(line, dia, cm, label);
    this.viewer.overlay.add(group);
    this.list.push({ id, a: A, b: C, na: null, nb: null, distance: radius * 2, delta: new THREE.Vector3(), angle: null, parallelDistance: null, planeDistance: null, kind: 'circle', radius, center, group });
    this.emit();
  }

  get pendingCount() { return this.mode === 'circle' ? this.circlePts.length : this.pending ? 1 : 0; }

  private cancelPending() {
    for (const c of this.circlePts) { this.viewer.overlay.remove(c.marker); this.markers.delete(c.marker); }
    this.circlePts = [];
    if (!this.pending) return;
    this.viewer.overlay.remove(this.pending.marker);
    this.markers.delete(this.pending.marker);
    this.pending = null;
  }

  remove(id: number) {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = this.list[i];
    m.group.traverse((o) => this.markers.delete(o));
    m.group.children.forEach((c: any) => c.element?.remove());
    this.viewer.overlay.remove(m.group);
    this.list.splice(i, 1);
    this.emit();
  }

  clear() {
    [...this.list].forEach((m) => this.remove(m.id));
    this.cancelPending();
    this.emit();
  }

  /** Re-renders labels after the unit changes. */
  relabel() {
    for (const m of this.list) {
      const label = m.group.children.find((c: any) => c.isCSS2DObject) as CSS2DObject | undefined;
      if (label) label.element.innerHTML = `<span class="ml-id">#${m.id}</span> ${m.kind === 'circle' ? '⌀ ' : ''}${this.format(m.distance)}`;
    }
    this.emit();
  }
}

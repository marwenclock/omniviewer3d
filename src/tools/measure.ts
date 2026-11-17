import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Viewer } from '../viewer';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

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
  /** user-given name (OV-102) */
  name: string;
  hidden: boolean;
  color: string;
  /** set when the model was edited after measuring: the value may be out of date (OV-102) */
  stale: boolean;
  /** how the end points were snapped */
  snapA?: SnapKind;
  snapB?: SnapKind;
}

export type SnapKind = 'corner' | 'midpoint' | 'edge' | 'face centre' | 'surface';
export type SnapMode = 'auto' | 'corner' | 'edge' | 'face' | 'off';
export interface SavedMeasurement { name: string; kind: 'distance' | 'circle'; a: number[]; b: number[]; c?: number[]; na?: number[] | null; nb?: number[] | null; color: string; hidden: boolean; stale: boolean }

/** Point-to-point measuring with optional vertex snapping. */
export class MeasureTool {
  active = false;
  /** legacy on/off switch (kept for settings) */
  get snap() { return this.snapMode !== 'off'; }
  set snap(v: boolean) { this.snapMode = v ? 'auto' : 'off'; }
  snapMode: SnapMode = 'auto';
  /** snap distance on screen in CSS pixels; touch uses a larger radius (OV-065) */
  snapRadius = 12;
  /** only pick on these objects (selection filter, OV-103); null = whole model */
  pickTargets: () => THREE.Object3D[] | undefined = () => undefined;
  private snapLabel: CSS2DObject | null = null;
  private lastPointer: 'mouse' | 'touch' | 'pen' = 'mouse';
  mode: 'distance' | 'circle' = 'distance';
  private circlePts: { p: THREE.Vector3; marker: THREE.Object3D }[] = [];
  list: Measurement[] = [];
  private pending: { p: THREE.Vector3; n: THREE.Vector3 | null; marker: THREE.Object3D; kind?: SnapKind } | null = null;
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
    const el = document.createElement('div');
    el.className = 'snap-label';
    this.snapLabel = new CSS2DObject(el);
    this.snapLabel.userData.noShot = true;
    this.snapLabel.visible = false;
    viewer.overlay.add(this.snapLabel);
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
    this.lastPointer = (event.pointerType as any) || 'mouse';
    const hit = this.viewer.pick(event, this.pickTargets());
    if (!hit) return null;
    const p = hit.point.clone();
    let n: THREE.Vector3 | null = null;
    const obj = hit.object as THREE.Mesh;
    // Normals transform with the inverse-transpose of the world matrix, so non-uniform scale stays correct (OV-027).
    if (hit.face) n = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)).normalize();
    let kind: SnapKind = 'surface';
    if (this.snapMode !== 'off' && hit.face && obj.geometry) {
      const pos = obj.geometry.attributes.position as THREE.BufferAttribute;
      const rect = this.viewer.renderer.domElement.getBoundingClientRect();
      const radius = this.lastPointer === 'touch' ? Math.max(this.snapRadius, 26) : this.snapRadius;
      const screen = (v: THREE.Vector3) => { const s = v.clone().project(this.viewer.camera); return { x: ((s.x + 1) / 2) * rect.width + rect.left, y: ((1 - s.y) / 2) * rect.height + rect.top }; };
      const dist = (v: THREE.Vector3) => { const q = screen(v); return Math.hypot(q.x - event.clientX, q.y - event.clientY); };
      const tri = [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld));
      const candidates: { v: THREE.Vector3; d: number; kind: SnapKind; prio: number }[] = [];
      if (this.snapMode === 'auto' || this.snapMode === 'corner') for (const v of tri) candidates.push({ v, d: dist(v), kind: 'corner', prio: 0 });
      if (this.snapMode === 'auto' || this.snapMode === 'edge') {
        for (let k = 0; k < 3; k++) {
          const a = tri[k], b = tri[(k + 1) % 3];
          const mid = a.clone().add(b).multiplyScalar(0.5);
          candidates.push({ v: mid, d: dist(mid), kind: 'midpoint', prio: 1 });
          const onEdge = new THREE.Line3(a, b).closestPointToPoint(hit.point, true, new THREE.Vector3());
          candidates.push({ v: onEdge, d: dist(onEdge) + (this.snapMode === 'edge' ? 0 : 3), kind: 'edge', prio: 2 });
        }
      }
      if (this.snapMode === 'face' || this.snapMode === 'auto') {
        const c = tri[0].clone().add(tri[1]).add(tri[2]).divideScalar(3);
        candidates.push({ v: c, d: this.snapMode === 'face' ? 0 : dist(c) + 4, kind: 'face centre', prio: 3 });
      }
      const best = candidates.filter((c) => c.d <= radius).sort((x, y) => x.prio - y.prio || x.d - y.d)[0];
      if (best) { p.copy(best.v); kind = best.kind; }
    }
    return { p, n, kind };
  }

  onPointerMove(event: PointerEvent) {
    if (!this.active) return;
    const h = this.hitPoint(event);
    this.hover.visible = !!h;
    if (h) this.hover.position.copy(h.p);
    // Show which snap will be used, so the intended edge or corner is unambiguous (OV-103).
    if (this.snapLabel) {
      this.snapLabel.visible = !!h && h.kind !== 'surface';
      if (h) { this.snapLabel.position.copy(h.p); this.snapLabel.element.textContent = h.kind; }
    }
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
      this.pending = { p: h.p, n: h.n, marker, kind: h.kind };
      return true;
    }
    this.finish(this.pending, h);
    return true;
  }

  private finish(start: NonNullable<MeasureTool['pending']>, end: { p: THREE.Vector3; n: THREE.Vector3 | null; kind?: SnapKind }, preset?: Partial<Measurement>) {
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
    const label = new CSS2DObject(el);
    label.position.copy(a).add(b).multiplyScalar(0.5);
    group.add(ma, mb, line, label);
    this.viewer.overlay.add(group);
    this.pending = null;
    const m: Measurement = { id, a, b, na: start.n, nb: end.n, distance, delta, angle, parallelDistance, planeDistance, kind: 'distance', group, name: `#${id}`, hidden: false, color: '#ffffff', stale: false, snapA: start.kind, snapB: end.kind, ...preset };
    this.list.push(m);
    this.style(m);
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
    const label = new CSS2DObject(el);
    label.position.copy(center);
    group.add(line, dia, cm, label);
    this.viewer.overlay.add(group);
    const m: Measurement = { id, a: A, b: C, na: null, nb: null, distance: radius * 2, delta: new THREE.Vector3(), angle: null, parallelDistance: null, planeDistance: null, kind: 'circle', radius, center, group, name: `#${id}`, hidden: false, color: '#ffffff', stale: false, ...this.circlePreset };
    this.circlePreset = undefined;
    this.circleB = B;
    m.group.userData.b2 = B.toArray();
    this.list.push(m);
    this.style(m);
    this.emit();
  }

  private circlePreset?: Partial<Measurement>;
  private circleB?: THREE.Vector3;

  /** Applies name, colour, visibility and stale state to a measurement's drawing. */
  private style(m: Measurement) {
    m.group.visible = !m.hidden;
    m.group.traverse((o: any) => { if (o.material && o.material.color) o.material.color.set(m.stale ? '#e2a336' : m.color); });
    const label = m.group.children.find((c: any) => c.isCSS2DObject) as CSS2DObject | undefined;
    if (label) {
      label.element.innerHTML = `<span class="ml-id">${escapeHtml(m.name)}</span> ${m.kind === 'circle' ? '⌀ ' : ''}${this.format(m.distance)}${m.stale ? ' <span class="ml-stale" title="Measured before the model was edited">⚠</span>' : ''}`;
      label.element.style.borderColor = m.color;
    }
    this.viewer.requestRender();
  }
  rename(id: number, name: string) { const m = this.list.find((x) => x.id === id); if (m) { m.name = name.trim() || `#${id}`; this.style(m); this.emit(); } }
  setHidden(id: number, hidden: boolean) { const m = this.list.find((x) => x.id === id); if (m) { m.hidden = hidden; this.style(m); this.emit(); } }
  setColor(id: number, color: string) { const m = this.list.find((x) => x.id === id); if (m) { m.color = color; this.style(m); this.emit(); } }
  /** Called after any geometry edit: existing values may no longer be current (OV-102). */
  markStale() { let any = false; for (const m of this.list) if (!m.stale) { m.stale = true; any = true; this.style(m); } if (any) this.emit(); }
  /** Measures again between the same points (the user confirms the value is current). */
  refresh(id: number) { const m = this.list.find((x) => x.id === id); if (m) { m.stale = false; this.style(m); this.emit(); } }

  serialize(): SavedMeasurement[] {
    return this.list.map((m) => ({ name: m.name, kind: m.kind, a: m.a.toArray(), b: m.b.toArray(), c: m.kind === 'circle' ? (m.group.userData.b2 as number[]) : undefined, na: m.na?.toArray() ?? null, nb: m.nb?.toArray() ?? null, color: m.color, hidden: m.hidden, stale: m.stale }));
  }
  restore(list: SavedMeasurement[]) {
    this.clear();
    const V = (a?: number[] | null) => (a ? new THREE.Vector3().fromArray(a) : null);
    for (const s of list) {
      const preset = { name: s.name, color: s.color, hidden: s.hidden, stale: s.stale };
      if (s.kind === 'circle' && s.c) {
        this.circlePreset = preset;
        for (const p of [s.a, s.c, s.b]) this.addCirclePoint(V(p)!);
      } else {
        const marker = this.makeMarker(0xffffff); this.viewer.overlay.add(marker); this.markers.add(marker);
        this.finish({ p: V(s.a)!, n: V(s.na), marker }, { p: V(s.b)!, n: V(s.nb) }, preset);
      }
    }
  }
  /** JSON for download (OV-102). */
  toJSON(formatUnit: (v: number) => string) {
    return this.list.map((m) => ({ name: m.name, type: m.kind, value: formatUnit(m.distance), current: !m.stale, from: m.a.toArray(), to: m.b.toArray(), angleBetweenFaces: m.angle }));
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
    for (const m of this.list) this.style(m);
    this.emit();
  }
}

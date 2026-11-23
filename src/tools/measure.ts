import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Viewer } from '../viewer';
import { MeshFeatures, nearby, edgeChain, cylinderAt, type Circle, type Cylinder, type EdgeChain } from './features';

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
  /** circle measurements: radius and centre */
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
  /** what was measured, e.g. "Hole · depth 12 mm" or "Edge length" */
  info?: string;
  /** show R instead of ⌀ (fillets and partial arcs) */
  showRadius?: boolean;
}

export type SnapKind = 'corner' | 'midpoint' | 'edge' | 'hole centre' | 'face centre' | 'surface';
export type SnapMode = 'auto' | 'corner' | 'edge' | 'centre' | 'off';
/**
 * smart: hover a hole or round edge for its diameter, a straight edge for its length, click to keep;
 *        corners and faces start a distance.
 * distance: two points (snapping to corners, hole centres and model edges).
 * diameter: holes, bosses, round edges and fillets only.  edge: model edges only.
 * circle: the manual fallback, three points on a circle.
 */
export type MeasureMode = 'smart' | 'distance' | 'diameter' | 'edge' | 'circle';
export interface SavedMeasurement { name: string; kind: 'distance' | 'circle'; a: number[]; b: number[]; c?: number[]; na?: number[] | null; nb?: number[] | null; color: string; hidden: boolean; stale: boolean; info?: string; showRadius?: boolean }

type PointTarget = { kind: 'point'; p: THREE.Vector3; n: THREE.Vector3 | null; snap: SnapKind };
type CircleTarget = { kind: 'circle'; circle: Circle; info: string; showRadius: boolean; label: string; highlight: THREE.Vector3[]; key: string };
type EdgeTarget = { kind: 'edge'; a: THREE.Vector3; b: THREE.Vector3; length: number; label: string; key: string };
type Target = PointTarget | CircleTarget | EdgeTarget;

const FEATURE_COLOR = 0x3ddc97;

/** Distances, diameters and edge lengths, with snapping to the model's real corners, edges and hole centres. */
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
  mode: MeasureMode = 'smart';
  private circlePts: { p: THREE.Vector3; marker: THREE.Object3D }[] = [];
  list: Measurement[] = [];
  private pending: { p: THREE.Vector3; n: THREE.Vector3 | null; marker: THREE.Object3D; kind?: SnapKind } | null = null;
  private markers = new Set<THREE.Object3D>();
  private nextId = 1;
  private hover: THREE.Mesh;
  private preview: THREE.Group;
  private previewLine: Line2;
  private previewLabel: CSS2DObject;
  private previewKey = '';
  /** what the cursor is over right now, for the step hint */
  hoverTarget: Target | null = null;
  private listeners = new Set<() => void>();
  format: (v: number) => string = (v) => v.toFixed(3);
  // caches for the feature under the cursor
  private cylCache: { mesh: THREE.Mesh; cyl: Cylinder } | null = null;
  private noCyl = new Set<string>();
  private chainCache = new Map<string, EdgeChain>();

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
    // Live preview of a detected hole, round edge or straight edge.
    this.preview = new THREE.Group();
    this.preview.userData.helper = true;
    this.preview.userData.noShot = true;
    // A 3 px line (WebGL lines are always 1 px thin, too faint to see a detected edge).
    this.previewLine = new Line2(new LineGeometry(), new LineMaterial({ color: FEATURE_COLOR, linewidth: 3, depthTest: false, transparent: true }));
    this.previewLine.renderOrder = 999;
    this.previewLine.frustumCulled = false;
    this.previewLine.raycast = () => {};
    const pl = document.createElement('div');
    pl.className = 'measure-label measure-preview';
    this.previewLabel = new CSS2DObject(pl);
    this.preview.add(this.previewLine, this.previewLabel);
    this.preview.visible = false;
    viewer.overlay.add(this.preview);
    // Keep markers a constant size on screen.
    viewer.onFrame(() => {
      const cam = viewer.camera;
      const fit = (o: THREE.Object3D) => {
        const d = cam instanceof THREE.OrthographicCamera ? (cam.top - cam.bottom) / cam.zoom : o.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position);
        o.scale.setScalar(d * 0.008);
      };
      this.markers.forEach(fit);
      if (this.hover.visible) fit(this.hover);
      if (this.preview.visible) { const r = viewer.renderer.domElement; (this.previewLine.material as LineMaterial).resolution.set(r.clientWidth, r.clientHeight); }
    });
  }

  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  setActive(on: boolean) {
    this.active = on;
    this.hover.visible = false;
    this.hidePreview();
    if (!on) this.cancelPending();
    this.emit();
  }

  setMode(mode: MeasureMode) {
    this.cancelPending();
    this.mode = mode;
    this.hidePreview();
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

  // ---------------------------------------------------------------- what is under the cursor

  private screenOf(event: PointerEvent) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const toScreen = (v: THREE.Vector3) => { const s = v.clone().project(this.viewer.camera); return { x: ((s.x + 1) / 2) * rect.width + rect.left, y: ((1 - s.y) / 2) * rect.height + rect.top }; };
    return { toScreen, cursor: { x: event.clientX, y: event.clientY } };
  }

  private cylinder(F: MeshFeatures, t: number): Cylinder | null {
    if (this.cylCache && this.cylCache.mesh === F.mesh && this.cylCache.cyl.tris.has(t)) return this.cylCache.cyl;
    const key = `${F.mesh.uuid}:${t}`;
    if (this.noCyl.has(key)) return null;
    const cyl = cylinderAt(F, t);
    if (cyl) this.cylCache = { mesh: F.mesh, cyl };
    else { if (this.noCyl.size > 5000) this.noCyl.clear(); this.noCyl.add(key); }
    return cyl;
  }
  private chain(F: MeshFeatures, e: number) {
    const key = `${F.mesh.uuid}:${e}`;
    let c = this.chainCache.get(key);
    if (!c) { if (this.chainCache.size > 500) this.chainCache.clear(); c = edgeChain(F, e); this.chainCache.set(key, c); }
    return c;
  }
  /** Forget cached features (call after geometry edits). */
  resetCaches() { this.cylCache = null; this.noCyl.clear(); this.chainCache.clear(); }

  /** The end of a cylinder wall nearest the camera: where a hole opens. */
  private openEnd(c: Cylinder) {
    const cam = this.viewer.camera.position;
    return c.start.distanceTo(cam) <= c.end.distanceTo(cam) ? c.start : c.end;
  }

  private circleFromCylinder(c: Cylinder, where = this.openEnd(c)): CircleTarget {
    const full = c.type !== 'fillet';
    const what = c.type === 'hole' ? 'Hole' : c.type === 'boss' ? 'Round boss / shaft' : `Fillet / round (${Math.round(c.sweep)}°)`;
    const info = c.depth > c.radius * 0.02 ? `${what} · ${c.type === 'hole' ? 'depth' : 'length'} ${this.format(c.depth)}` : what;
    const circle = { center: where.clone(), axis: c.axis.clone(), radius: c.radius };
    return { kind: 'circle', circle, info, showRadius: !full, label: full ? `⌀ ${this.format(c.radius * 2)}` : `R ${this.format(c.radius)}`, highlight: ring(circle), key: `cyl:${c.radius}:${where.x},${where.y},${where.z}` };
  }

  /** A round model edge: a hole's rim, a round edge, an arc. */
  private circleFromChain(F: MeshFeatures, e: number, ch: EdgeChain, forEdge: boolean): CircleTarget {
    let c = ch.circle!;
    // The wall next to the rim tells hole from boss and gives the depth. Look along the rim, not just at the
    // hovered edge: on boolean results some rim pieces have no wall triangle attached.
    let cyl: Cylinder | null = null;
    const along = [e, ...(ch.edges ?? []).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 8)) === 0)];
    search: for (const edge of along) {
      for (const t of [F.topo.eT0[edge], F.topo.eT1[edge]]) {
        if (t < 0 || Math.abs(F.triNormal(t).dot(c.axis)) > 0.3) continue;
        const k = this.cylinder(F, t);
        if (k && Math.abs(k.radius - c.radius) < c.radius * 0.03) { cyl = k; break search; }
      }
    }
    // The wall is fitted to many more points than the rim, so its radius is the better value.
    if (cyl && cyl.type !== 'fillet') c = { center: c.center, axis: c.axis, radius: cyl.radius };
    // A rim seen as a partial arc (a seam or a junction cut the walk short) still belongs to a full hole or boss.
    const full = ch.closed || (ch.sweep ?? 0) > 300 || (!!cyl && cyl.type !== 'fillet');
    let info = full ? (cyl?.type === 'hole' ? 'Hole' : cyl?.type === 'boss' ? 'Round boss / shaft' : 'Circular edge') : `Arc ${Math.round(ch.sweep ?? 0)}°`;
    if (cyl && full && cyl.depth > c.radius * 0.02) info += ` · ${cyl.type === 'hole' ? 'depth' : 'length'} ${this.format(cyl.depth)}`;
    if (!full || forEdge) info += ` · edge length ${this.format(full ? 2 * Math.PI * c.radius : ch.length)}`;
    return {
      kind: 'circle', circle: c, info, showRadius: !full,
      label: full ? `⌀ ${this.format(c.radius * 2)}` : `R ${this.format(c.radius)}`,
      highlight: full ? ring(c) : ch.pts, key: `chain:${F.mesh.uuid}:${ch.pts[0].toArray()}:${ch.pts.length}`,
    };
  }

  private edgeTarget(F: MeshFeatures, ch: EdgeChain): EdgeTarget {
    const a = ch.pts[0], b = ch.pts[ch.pts.length - 1];
    return { kind: 'edge', a, b, length: a.distanceTo(b), label: this.format(a.distanceTo(b)), key: `edge:${F.mesh.uuid}:${a.toArray()}:${b.toArray()}` };
  }

  /** Decides what a click here would measure. */
  private analyze(event: PointerEvent): Target | null {
    this.lastPointer = (event.pointerType as any) || 'mouse';
    const hit = this.viewer.pick(event, this.pickTargets());
    if (!hit) return null;
    const obj = hit.object as THREE.Mesh;
    const n = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)).normalize() : null;
    const F = hit.faceIndex != null ? MeshFeatures.of(obj) : null;
    if (!F) return this.legacyPoint(event, hit, n);
    const t = hit.faceIndex!;
    const touch = this.lastPointer === 'touch';
    const radius = touch ? Math.max(this.snapRadius, 26) : this.snapRadius;
    const { toScreen, cursor } = this.screenOf(event);
    // World size of one screen pixel at the hit point, to turn the snap radius into a search distance.
    const cam = this.viewer.camera;
    const h = this.viewer.renderer.domElement.clientHeight || 1;
    const perPx = cam instanceof THREE.OrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / h
      : (2 * hit.point.distanceTo(cam.position) * Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov) / 2)) / h;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), cam);
    const near = nearby(F, hit.point, perPx * radius * 1.6, ray.ray, cursor, toScreen, radius * 0.8, radius);
    const surface: PointTarget = { kind: 'point', p: hit.point.clone(), n, snap: 'surface' };

    const featureMode = this.mode === 'diameter' || this.mode === 'edge' || (this.mode === 'smart' && !this.pending);
    if (featureMode) {
      // Round edges first: a rim's tessellation can look like corners, and a hole is what was meant.
      const ch = near.edge ? this.chain(F, near.edge.e) : null;
      if (ch && ch.kind === 'arc') return this.circleFromChain(F, near.edge!.e, ch, this.mode === 'edge');
      if (this.mode === 'smart' && near.corner) return { kind: 'point', p: near.corner.point, n, snap: 'corner' };
      if (ch && this.mode !== 'diameter') return this.edgeTarget(F, ch);
      if (this.mode !== 'edge') {
        const cyl = this.cylinder(F, t);
        if (cyl) return this.circleFromCylinder(cyl);
      }
      return this.mode === 'smart' ? surface : null;
    }

    // Picking a point (distance mode, or the second point in smart mode).
    const m = this.snapMode;
    if (m === 'off') return surface;
    // On a hole's rim the centre is usually what is wanted; the point on the rim is one Shift away.
    if ((m === 'auto' || m === 'centre') && near.edge && !event.shiftKey) {
      const ch = this.chain(F, near.edge.e);
      if (ch.kind === 'arc' && ch.circle) {
        const t = this.circleFromChain(F, near.edge.e, ch, false);
        if (!t.showRadius) return { kind: 'point', p: ch.circle.center.clone(), n: null, snap: 'hole centre' };
      }
    }
    if ((m === 'auto' || m === 'corner') && near.corner) return { kind: 'point', p: near.corner.point, n, snap: 'corner' };
    if ((m === 'auto' || m === 'centre') && !near.edge) {
      const cyl = this.cylinder(F, t);
      if (cyl && cyl.type !== 'fillet') return { kind: 'point', p: this.openEnd(cyl).clone(), n: null, snap: 'hole centre' };
    }
    if ((m === 'auto' || m === 'edge') && near.edge) {
      const ch = this.chain(F, near.edge.e);
      if (ch.kind === 'line') {
        const mid = ch.pts[0].clone().add(ch.pts[ch.pts.length - 1]).multiplyScalar(0.5);
        const s = toScreen(mid);
        if (Math.hypot(s.x - cursor.x, s.y - cursor.y) <= radius) return { kind: 'point', p: mid, n, snap: 'midpoint' };
      }
      return { kind: 'point', p: near.edge.point, n, snap: 'edge' };
    }
    return surface;
  }

  /** Point clouds, splats and very large meshes: snap to the clicked triangle's corners and sides. */
  private legacyPoint(event: PointerEvent, hit: THREE.Intersection, n: THREE.Vector3 | null): PointTarget | null {
    if (this.mode === 'diameter' || this.mode === 'edge') return null;
    const p = hit.point.clone();
    let kind: SnapKind = 'surface';
    const obj = hit.object as THREE.Mesh;
    if (this.snapMode !== 'off' && hit.face && obj.geometry) {
      const pos = obj.geometry.attributes.position as THREE.BufferAttribute;
      const radius = this.lastPointer === 'touch' ? Math.max(this.snapRadius, 26) : this.snapRadius;
      const { toScreen, cursor } = this.screenOf(event);
      const dist = (v: THREE.Vector3) => { const q = toScreen(v); return Math.hypot(q.x - cursor.x, q.y - cursor.y); };
      const tri = [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld));
      const cands: { v: THREE.Vector3; d: number; kind: SnapKind; prio: number }[] = [];
      if (this.snapMode === 'auto' || this.snapMode === 'corner') for (const v of tri) cands.push({ v, d: dist(v), kind: 'corner', prio: 0 });
      if (this.snapMode === 'auto' || this.snapMode === 'edge') for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const mid = a.clone().add(b).multiplyScalar(0.5);
        cands.push({ v: mid, d: dist(mid), kind: 'midpoint', prio: 1 });
        const on = new THREE.Line3(a, b).closestPointToPoint(hit.point, true, new THREE.Vector3());
        cands.push({ v: on, d: dist(on) + 3, kind: 'edge', prio: 2 });
      }
      const best = cands.filter((c) => c.d <= radius).sort((x, y) => x.prio - y.prio || x.d - y.d)[0];
      if (best) { p.copy(best.v); kind = best.kind; }
    }
    return { kind: 'point', p, n, snap: kind };
  }

  // ---------------------------------------------------------------- preview

  private hidePreview() {
    this.preview.visible = false;
    this.previewKey = '';
    this.hoverTarget = null;
    if (this.snapLabel) this.snapLabel.visible = false;
    this.viewer.requestRender();
  }

  private showPreview(t: CircleTarget | EdgeTarget) {
    if (this.previewKey !== t.key) {
      this.previewKey = t.key;
      const pts = t.kind === 'edge' ? [t.a, t.b] : t.highlight;
      this.previewLine.geometry.dispose();
      const g = new LineGeometry();
      g.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
      this.previewLine.geometry = g;
      this.previewLine.computeLineDistances();
      this.previewLabel.position.copy(t.kind === 'edge' ? t.a.clone().add(t.b).multiplyScalar(0.5) : t.circle.center);
      this.previewLabel.element.textContent = t.label;
    }
    this.preview.visible = true;
    this.viewer.requestRender();
  }

  onPointerMove(event: PointerEvent) {
    if (!this.active) return;
    let target: Target | null;
    if (this.mode === 'circle') { const hit = this.viewer.pick(event, this.pickTargets()); target = hit ? this.legacyPoint(event, hit, null) : null; }
    else target = this.analyze(event);
    const prevKind = this.hoverTarget?.kind;
    this.hoverTarget = target;
    if (target && target.kind !== 'point') {
      this.hover.visible = false;
      if (this.snapLabel) this.snapLabel.visible = false;
      this.showPreview(target);
    } else {
      this.preview.visible = false;
      this.previewKey = '';
      this.hover.visible = !!target;
      if (target) this.hover.position.copy(target.p);
      // Show which snap will be used, so the intended edge or corner is unambiguous (OV-103).
      if (this.snapLabel) {
        this.snapLabel.visible = !!target && target.snap !== 'surface';
        if (target) { this.snapLabel.position.copy(target.p); this.snapLabel.element.textContent = target.snap; }
      }
    }
    if (prevKind !== target?.kind) this.emit(); // the step hint names what a click will do
  }

  /** Returns true when the click was consumed. */
  onClick(event: PointerEvent): boolean {
    if (!this.active) return false;
    if (this.mode === 'circle') {
      const hit = this.viewer.pick(event, this.pickTargets());
      const h = hit && this.legacyPoint(event, hit, null);
      if (h) this.addCirclePoint(h.p);
      return true;
    }
    const target = this.analyze(event);
    if (!target) return true;
    if (target.kind === 'circle') { this.addDetectedCircle(target); return true; }
    if (target.kind === 'edge') { this.addEdge(target); return true; }
    if (!this.pending) {
      const marker = this.makeMarker(0xffffff);
      marker.position.copy(target.p);
      this.viewer.overlay.add(marker);
      this.markers.add(marker);
      this.pending = { p: target.p, n: target.n, marker, kind: target.snap };
      this.hidePreview();
      this.emit(); // the step hint changes to "second point"
      return true;
    }
    this.finish(this.pending, { p: target.p, n: target.n, kind: target.snap });
    return true;
  }

  private addDetectedCircle(t: CircleTarget) {
    const { center, axis, radius } = t.circle;
    const u = (Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(axis).normalize();
    const v = axis.clone().cross(u);
    const at = (deg: number) => { const r = THREE.MathUtils.degToRad(deg); return center.clone().addScaledVector(u, Math.cos(r) * radius).addScaledVector(v, Math.sin(r) * radius); };
    this.circlePreset = { info: t.info, showRadius: t.showRadius };
    this.circlePts = [];
    for (const deg of [0, 120, 240]) this.addCirclePoint(at(deg));
    this.hidePreview();
  }

  private addEdge(t: EdgeTarget) {
    const marker = this.makeMarker(0xffffff);
    this.viewer.overlay.add(marker);
    this.markers.add(marker);
    this.finish({ p: t.a, n: null, marker, kind: 'corner' }, { p: t.b, n: null, kind: 'corner' }, { info: 'Edge length' });
    this.hidePreview();
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
    // Float noise (1e-5 of a millimetre on an axis that should read 0) is shown as 0, not in exponent notation.
    const clean = (v: number) => (Math.abs(v) < Math.max(distance, 1e-9) * 1e-6 ? 0 : v);
    const delta = new THREE.Vector3(clean(Math.abs(b.x - a.x)), clean(Math.abs(b.y - a.y)), clean(Math.abs(b.z - a.z)));
    let angle: number | null = null, parallelDistance: number | null = null;
    if (start.n && end.n) {
      angle = THREE.MathUtils.radToDeg(start.n.angleTo(end.n));
      if (angle < 1 || angle > 179) parallelDistance = clean(Math.abs(b.clone().sub(a).dot(start.n)));
    }
    const planeDistance = start.n ? clean(Math.abs(b.clone().sub(a).dot(start.n))) : null;
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

  /** Three points on a circle give its centre, radius and diameter (detected circles use three points too). */
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
    if (n2 < 1e-20) { this.circlePreset = undefined; this.emit(); return; } // points in a line
    const center = A.clone().add(
      n.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(n).multiplyScalar(ab.lengthSq())).divideScalar(2 * n2),
    );
    const radius = center.distanceTo(A);
    const group = new THREE.Group();
    group.userData.helper = true;
    const axisN = n.normalize();
    const u = A.clone().sub(center).normalize();
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring({ center, axis: axisN, radius }, u)), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
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
    m.group.userData.b2 = B.toArray();
    this.list.push(m);
    this.style(m);
    this.emit();
  }

  private circlePreset?: Partial<Measurement>;

  /** Applies name, colour, visibility and stale state to a measurement's drawing. */
  private style(m: Measurement) {
    m.group.visible = !m.hidden;
    m.group.traverse((o: any) => { if (o.material && o.material.color) o.material.color.set(m.stale ? '#e2a336' : m.color); });
    const label = m.group.children.find((c: any) => c.isCSS2DObject) as CSS2DObject | undefined;
    if (label) {
      label.element.innerHTML = `<span class="ml-id">${escapeHtml(m.name)}</span> ${valueText(m, this.format)}${m.stale ? ' <span class="ml-stale" title="Measured before the model was edited">⚠</span>' : ''}`;
      label.element.style.borderColor = m.color;
    }
    this.viewer.requestRender();
  }
  rename(id: number, name: string) { const m = this.list.find((x) => x.id === id); if (m) { m.name = name.trim() || `#${id}`; this.style(m); this.emit(); } }
  setHidden(id: number, hidden: boolean) { const m = this.list.find((x) => x.id === id); if (m) { m.hidden = hidden; this.style(m); this.emit(); } }
  setColor(id: number, color: string) { const m = this.list.find((x) => x.id === id); if (m) { m.color = color; this.style(m); this.emit(); } }
  /** Called after any geometry edit: existing values may no longer be current (OV-102). */
  markStale() { this.resetCaches(); let any = false; for (const m of this.list) if (!m.stale) { m.stale = true; any = true; this.style(m); } if (any) this.emit(); }
  /** Measures again between the same points (the user confirms the value is current). */
  refresh(id: number) { const m = this.list.find((x) => x.id === id); if (m) { m.stale = false; this.style(m); this.emit(); } }

  serialize(): SavedMeasurement[] {
    return this.list.map((m) => ({ name: m.name, kind: m.kind, a: m.a.toArray(), b: m.b.toArray(), c: m.kind === 'circle' ? (m.group.userData.b2 as number[]) : undefined, na: m.na?.toArray() ?? null, nb: m.nb?.toArray() ?? null, color: m.color, hidden: m.hidden, stale: m.stale, info: m.info, showRadius: m.showRadius }));
  }
  restore(list: SavedMeasurement[]) {
    this.clear();
    const V = (a?: number[] | null) => (a ? new THREE.Vector3().fromArray(a) : null);
    for (const s of list) {
      const preset: Partial<Measurement> = { name: s.name, color: s.color, hidden: s.hidden, stale: s.stale, info: s.info, showRadius: s.showRadius };
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
    return this.list.map((m) => ({ name: m.name, type: m.kind, what: m.info, value: m.kind === 'circle' && m.showRadius ? `R ${formatUnit(m.radius!)}` : formatUnit(m.distance), current: !m.stale, from: m.a.toArray(), to: m.b.toArray(), center: m.center?.toArray(), angleBetweenFaces: m.angle }));
  }

  /** Drops a half-placed distance or circle; true when there was one. */
  cancelPoint() {
    if (!this.pendingCount) return false;
    this.cancelPending();
    this.emit();
    return true;
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
    this.previewKey = '';
    this.emit();
  }
}

/** The headline value of a measurement: ⌀ or R for circles, the length otherwise. */
export function valueText(m: Measurement, fmt: (v: number) => string) {
  if (m.kind !== 'circle') return fmt(m.distance);
  return m.showRadius ? `R ${fmt(m.radius!)}` : `⌀ ${fmt(m.distance)}`;
}

/** Points around a full circle. */
function ring(c: Circle, start?: THREE.Vector3) {
  const u = start ? start.clone() : (Math.abs(c.axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(c.axis).normalize();
  const v = c.axis.clone().cross(u);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; out.push(c.center.clone().addScaledVector(u, Math.cos(t) * c.radius).addScaledVector(v, Math.sin(t) * c.radius)); }
  return out;
}

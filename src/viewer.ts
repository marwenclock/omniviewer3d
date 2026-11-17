import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

export type DisplayMode = 'shaded' | 'wireframe' | 'xray' | 'flat';
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';
export type Axis = 'x' | 'y' | 'z';

/** Is this object something the user made/loaded (not a helper the viewer draws)? */
export const isContent = (o: THREE.Object3D) => !o.userData.helper;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  /** Rotated to switch between Y-up and Z-up. The loaded model lives inside. */
  readonly world = new THREE.Group();
  /** Overlays (grid, measurements, section plane...) that are never exported. */
  readonly overlay = new THREE.Group();
  model: THREE.Object3D | null = null;
  perspective: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  viewHelper: ViewHelper;
  grid: THREE.GridHelper | null = null;
  axes: THREE.AxesHelper | null = null;
  mixer: THREE.AnimationMixer | null = null;
  clips: THREE.AnimationClip[] = [];
  activeAction: THREE.AnimationAction | null = null;
  displayMode: DisplayMode = 'shaded';
  showEdges = false;
  showGrid = true;
  showAxes = false;
  upAxis: 'y' | 'z' = 'y';
  section: { enabled: boolean; axis: Axis; t: number; flip: boolean } = { enabled: false, axis: 'x', t: 0.5, flip: false };
  readonly clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private sectionHelper: THREE.Mesh | null = null;
  private explodeFactor = 0;
  private timer = new THREE.Timer();
  private envTexture: THREE.Texture;
  private headlight: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private listeners = new Set<() => void>();
  private frameHooks = new Set<(dt: number) => void>();
  background = '#151515';
  /** temporary visual overrides (inspector modes) that must be undone while exporting */
  readonly cleanHooks = new Set<{ off(): void; on(): void }>();

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels-layer';
    container.appendChild(this.labels.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.9;

    this.ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.scene.add(this.ambient, this.world, this.overlay);

    this.perspective = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.perspective.add(this.headlight);
    this.headlight.position.set(0.5, 1, 1);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.scene.add(this.perspective, this.ortho);
    this.camera = this.perspective;
    this.camera.position.set(3, 2, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.viewHelper = this.makeViewHelper();

    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (this.viewHelper.handleClick(e)) e.stopImmediatePropagation();
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setBackground(this.background);
    this.updateGrid(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1)));
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private makeViewHelper() {
    const vh = new ViewHelper(this.camera, this.renderer.domElement);
    vh.location.right = 12;
    vh.location.bottom = 12;
    vh.setLabels('X', 'Y', 'Z');
    vh.center = this.controls.target;
    return vh;
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((f) => f()); }
  onFrame(fn: (dt: number) => void) { this.frameHooks.add(fn); return () => this.frameHooks.delete(fn); }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.updateOrtho();
  }

  private updateOrtho() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const dist = this.perspective.position.distanceTo(this.controls?.target ?? new THREE.Vector3());
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2)) * dist;
    this.ortho.left = (-halfH * w) / h;
    this.ortho.right = (halfH * w) / h;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.viewHelper.animating) this.viewHelper.update(dt);
    this.controls.update(dt);
    this.mixer?.update(dt);
    this.frameHooks.forEach((f) => f(dt));
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.viewHelper.render(this.renderer);
    this.labels.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- model

  setModel(object: THREE.Object3D | null, clips: THREE.AnimationClip[] = []) {
    if (this.model) {
      this.world.remove(this.model);
      disposeObject(this.model);
    }
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.activeAction = null;
    this.clips = clips;
    this.explodeFactor = 0;
    this.section.enabled = false;
    if (this.sectionHelper) this.sectionHelper.visible = false;
    this.model = object;
    if (object) {
      this.world.add(object);
      object.traverse((o: any) => {
        if (o.isMesh || o.isPoints || o.isLine) o.userData.explodeBase = o.position.clone();
      });
      if (clips.length) {
        this.mixer = new THREE.AnimationMixer(object);
        this.playClip(0);
      }
    }
    this.refreshMaterials();
    this.fit();
    this.emit();
  }

  playClip(index: number) {
    if (!this.mixer) return;
    this.activeAction?.stop();
    if (index < 0) { this.activeAction = null; return; }
    this.activeAction = this.mixer.clipAction(this.clips[index]);
    this.activeAction.reset().play();
  }

  /** Re-applies display settings (clipping, wireframe, x-ray, edges) to every material. */
  refreshMaterials() {
    const planes = this.section.enabled ? [this.clipPlane] : [];
    const edgesWanted = this.showEdges;
    this.model?.traverse((o: any) => {
      if (o.userData.helper) return;
      if (o.isMesh || o.isPoints || o.isLine) {
        const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats as any[]) {
          if (!m) continue;
          if (!m.userData.orig) m.userData.orig = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, flatShading: !!m.flatShading };
          const orig = m.userData.orig;
          m.clippingPlanes = planes;
          m.clipShadows = true;
          if ('wireframe' in m) m.wireframe = this.displayMode === 'wireframe';
          if (this.displayMode === 'xray') { m.transparent = true; m.opacity = Math.min(orig.opacity, 0.22); m.depthWrite = false; }
          else { m.transparent = orig.transparent; m.opacity = orig.opacity; m.depthWrite = orig.depthWrite; }
          if ('flatShading' in m) m.flatShading = this.displayMode === 'flat' ? true : orig.flatShading;
          m.needsUpdate = true;
        }
      }
      if (o.isMesh) {
        const existing = o.children.find((c: any) => c.userData.edges);
        if (edgesWanted && !existing) {
          const lines = new THREE.LineSegments(
            new THREE.EdgesGeometry(o.geometry, 25),
            new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.55, clippingPlanes: planes }),
          );
          lines.userData = { helper: true, edges: true };
          lines.raycast = () => {};
          o.add(lines);
        } else if (existing) {
          if (!edgesWanted) { o.remove(existing); existing.geometry.dispose(); }
          else (existing.material as THREE.LineBasicMaterial).clippingPlanes = planes;
        }
      }
    });
  }

  setDisplayMode(mode: DisplayMode) { this.displayMode = mode; this.refreshMaterials(); this.emit(); }
  setEdges(on: boolean) { this.showEdges = on; this.refreshMaterials(); this.emit(); }

  /** Runs fn with display overrides removed (used before exporting). */
  async withCleanModel<T>(fn: () => Promise<T>): Promise<T> {
    const mode = this.displayMode, edges = this.showEdges, sec = this.section.enabled;
    this.displayMode = 'shaded'; this.showEdges = false; this.section.enabled = false;
    this.cleanHooks.forEach((h) => h.off());
    this.refreshMaterials();
    try { return await fn(); }
    finally {
      this.cleanHooks.forEach((h) => h.on());
      this.displayMode = mode; this.showEdges = edges; this.section.enabled = sec;
      this.refreshMaterials();
    }
  }

  // ---------------------------------------------------------------- bounds & camera

  /** World-space bounding box of the model (or of one object). */
  bounds(target: THREE.Object3D | null = this.model): THREE.Box3 {
    const box = new THREE.Box3();
    if (!target) return box;
    target.updateWorldMatrix(true, true);
    target.traverse((o: any) => {
      if (o.userData.helper || !o.visible) return;
      if (o.isMesh || o.isPoints || o.isLine) box.expandByObject(o, false);
    });
    // expandByObject recurses; children counted twice is harmless for a box.
    return box;
  }

  fit(target: THREE.Object3D | null = this.model, view?: ViewName) {
    const box = this.bounds(target);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2, 2, 2));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
    const dirs: Record<ViewName, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1),
      left: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(1, 0, 0),
      top: new THREE.Vector3(0, 1, 0.0001), bottom: new THREE.Vector3(0, -1, 0.0001),
      iso: new THREE.Vector3(1, 0.75, 1.25),
    };
    const dir = view ? dirs[view].clone().normalize()
      : this.perspective.position.clone().sub(this.controls.target).normalize();
    if (!view && dir.lengthSq() < 0.5) dir.copy(dirs.iso).normalize();
    // Fit the bounding sphere in whichever field of view is narrower (tall, narrow viewports too).
    this.resize();
    const vfov = THREE.MathUtils.degToRad(this.perspective.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.perspective.aspect);
    const dist = radius / Math.sin(Math.min(vfov, hfov) / 2);
    this.controls.target.copy(center);
    this.perspective.position.copy(center).addScaledVector(dir, dist * 1.05);
    this.perspective.near = Math.max(dist / 1000, 1e-4);
    this.perspective.far = dist * 100;
    this.perspective.updateProjectionMatrix();
    this.ortho.position.copy(this.perspective.position);
    this.ortho.near = -dist * 50; this.ortho.far = dist * 50;
    this.ortho.zoom = 1;
    this.updateOrtho();
    if (target === this.model) {
      this.updateGrid(this.bounds());
      this.updateSection();
    }
    this.controls.update();
  }

  setProjection(kind: 'perspective' | 'orthographic') {
    const next = kind === 'perspective' ? this.perspective : this.ortho;
    if (next === this.camera) return;
    if (next === this.ortho) {
      this.updateOrtho();
      this.ortho.position.copy(this.perspective.position);
      this.ortho.quaternion.copy(this.perspective.quaternion);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
    } else {
      // Keep the apparent size when going back to perspective.
      const dir = this.ortho.position.clone().sub(this.controls.target).normalize();
      const dist = this.perspective.position.distanceTo(this.controls.target) / this.ortho.zoom;
      this.perspective.position.copy(this.controls.target).addScaledVector(dir, dist);
    }
    if (next === this.ortho) this.ortho.add(this.headlight); else this.perspective.add(this.headlight);
    this.camera = next;
    this.controls.object = next;
    this.viewHelper.dispose();
    this.viewHelper = this.makeViewHelper();
    this.controls.update();
    this.emit();
  }

  setUpAxis(axis: 'y' | 'z') {
    this.upAxis = axis;
    this.world.rotation.set(axis === 'z' ? -Math.PI / 2 : 0, 0, 0);
    this.world.updateMatrixWorld(true);
    this.fit(this.model, 'iso');
    this.emit();
  }

  setAutoRotate(on: boolean) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = 1.5; }

  // ---------------------------------------------------------------- environment

  setBackground(color: string | null) {
    this.background = color ?? '';
    if (color) {
      this.scene.background = new THREE.Color(color);
      this.renderer.setClearColor(color, 1);
    } else {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    }
  }

  setLighting(preset: 'studio' | 'soft' | 'flat') {
    this.scene.environment = preset === 'flat' ? null : this.envTexture;
    this.scene.environmentIntensity = preset === 'soft' ? 0.5 : 0.9;
    this.headlight.intensity = preset === 'flat' ? 2.2 : preset === 'soft' ? 0.8 : 1.2;
    this.ambient.intensity = preset === 'flat' ? 1.4 : 0.6;
  }

  setGrid(on: boolean) { this.showGrid = on; if (this.grid) this.grid.visible = on; this.emit(); }

  setAxes(on: boolean) {
    this.showAxes = on;
    if (this.axes) this.axes.visible = on;
    this.emit();
  }

  updateGrid(box: THREE.Box3) {
    if (this.grid) { this.overlay.remove(this.grid); this.grid.dispose(); }
    if (this.axes) { this.overlay.remove(this.axes); this.axes.dispose(); }
    const size = box.isEmpty() ? new THREE.Vector3(2, 2, 2) : box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y) || 1;
    const step = Math.pow(10, Math.floor(Math.log10(span / 2)));
    const extent = Math.ceil((span * 2) / step) * step;
    const divisions = Math.min(200, Math.round(extent / step));
    this.grid = new THREE.GridHelper(extent, divisions, 0x777777, 0x3a3a3a);
    const mat = this.grid.material as THREE.Material;
    mat.transparent = true; mat.opacity = 0.5; mat.depthWrite = false;
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    this.grid.position.set(c.x, box.isEmpty() ? 0 : box.min.y, c.z);
    this.grid.visible = this.showGrid;
    this.grid.userData.helper = true;
    this.grid.raycast = () => {};
    this.axes = new THREE.AxesHelper(span * 0.6);
    this.axes.position.copy(this.grid.position);
    this.axes.visible = this.showAxes;
    this.axes.userData.helper = true;
    this.axes.raycast = () => {};
    this.overlay.add(this.grid, this.axes);
  }

  // ---------------------------------------------------------------- section plane

  setSection(patch: Partial<Viewer['section']>) {
    Object.assign(this.section, patch);
    this.updateSection();
    this.refreshMaterials();
    this.emit();
  }

  updateSection() {
    const box = this.bounds();
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2, 2, 2));
    const { axis, t, flip, enabled } = this.section;
    const n = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const pos = box.min[axis] + (box.max[axis] - box.min[axis]) * t;
    // Keep the half that is "below" the slider position unless flipped.
    const normal = flip ? n.clone() : n.clone().negate();
    this.clipPlane.setFromNormalAndCoplanarPoint(normal, n.clone().multiplyScalar(pos));
    if (!this.sectionHelper) {
      this.sectionHelper = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
      );
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      this.sectionHelper.add(border);
      this.sectionHelper.userData.helper = true;
      this.sectionHelper.raycast = () => {};
      this.overlay.add(this.sectionHelper);
    }
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(1.15);
    const c = box.getCenter(new THREE.Vector3());
    c[axis] = pos;
    this.sectionHelper.position.copy(c);
    this.sectionHelper.rotation.set(0, 0, 0);
    if (axis === 'x') { this.sectionHelper.rotation.y = Math.PI / 2; this.sectionHelper.scale.set(size.z, size.y, 1); }
    if (axis === 'y') { this.sectionHelper.rotation.x = Math.PI / 2; this.sectionHelper.scale.set(size.x, size.z, 1); }
    if (axis === 'z') { this.sectionHelper.scale.set(size.x, size.y, 1); }
    this.sectionHelper.visible = enabled;
  }

  // ---------------------------------------------------------------- explode

  setExplode(factor: number) {
    this.explodeFactor = factor;
    if (!this.model) return;
    const parts: THREE.Object3D[] = [];
    this.model.traverse((o: any) => { if ((o.isMesh || o.isPoints || o.isLine) && !o.userData.helper && o.userData.explodeBase) parts.push(o); });
    // Reset to base so the centre is measured from the assembled model.
    parts.forEach((p) => p.position.copy(p.userData.explodeBase));
    this.model.updateMatrixWorld(true);
    const box = this.bounds();
    const center = box.getCenter(new THREE.Vector3());
    const span = box.getSize(new THREE.Vector3()).length();
    if (factor === 0) { this.emit(); return; }
    for (const p of parts) {
      const pc = new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3());
      const dirWorld = pc.sub(center);
      if (dirWorld.lengthSq() < 1e-12) continue;
      const offsetWorld = dirWorld.multiplyScalar(factor * 1.2);
      if (offsetWorld.length() > span * 3 * factor) offsetWorld.setLength(span * 3 * factor);
      // Convert the world offset into the parent's local space.
      const parent = p.parent!;
      const origin = parent.worldToLocal(new THREE.Vector3(0, 0, 0).applyMatrix4(parent.matrixWorld));
      const tip = parent.worldToLocal(new THREE.Vector3().setFromMatrixPosition(parent.matrixWorld).add(offsetWorld));
      p.position.copy(p.userData.explodeBase).add(tip.sub(origin));
    }
    this.emit();
  }

  get explode() { return this.explodeFactor; }

  /** Rebases explode positions after an edit so exploding starts from the edited layout. */
  rebaseExplode() {
    this.model?.traverse((o: any) => { if (o.isMesh || o.isPoints || o.isLine) o.userData.explodeBase = o.position.clone(); });
    this.explodeFactor = 0;
  }

  // ---------------------------------------------------------------- picking

  private raycaster = new THREE.Raycaster();

  ndc(event: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
  }

  pick(event: { clientX: number; clientY: number }, objects?: THREE.Object3D[]): THREE.Intersection | null {
    if (!this.model && !objects) return null;
    this.raycaster.setFromCamera(this.ndc(event), this.camera);
    const box = this.bounds();
    this.raycaster.params.Points!.threshold = box.isEmpty() ? 0.01 : box.getSize(new THREE.Vector3()).length() / 300;
    this.raycaster.params.Line!.threshold = this.raycaster.params.Points!.threshold;
    const hits = this.raycaster.intersectObjects(objects ?? [this.model!], true);
    return hits.find((h) => {
      if (h.object.userData.helper || !isVisible(h.object)) return false;
      if (this.section.enabled && this.clipPlane.distanceToPoint(h.point) < 0) return false;
      return true;
    }) ?? null;
  }

  /** Screenshot as a PNG data URL, optionally at a multiple of the current size, with a transparent background. */
  screenshot(scale = 1, transparent = false, annotations = true): string {
    const prevBg = this.background;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    // Hide viewer chrome (grid, gizmos, selection box); keep measurements, dimensions and section caps.
    const hidden: THREE.Object3D[] = [];
    this.overlay.traverse((o) => {
      const chrome = o === this.grid || o === this.axes || o === this.sectionHelper || o.userData.noShot;
      if (o.visible && (chrome || (!annotations && o !== this.overlay && !o.userData.cap))) { hidden.push(o); o.visible = false; }
    });
    if (transparent) this.setBackground(null);
    this.renderer.setSize(w * scale, h * scale, false);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = w * scale; out.height = h * scale;
    const g = out.getContext('2d')!;
    g.drawImage(this.renderer.domElement, 0, 0);
    if (annotations) {
      // HTML labels are not part of the WebGL image, so draw them as text.
      this.overlay.traverse((o: any) => {
        if (!o.isCSS2DObject || !isVisible(o)) return;
        const p = o.getWorldPosition(new THREE.Vector3()).project(this.camera);
        if (p.z > 1) return;
        const x = ((p.x + 1) / 2) * w * scale, y = ((1 - p.y) / 2) * h * scale;
        const text = (o.element.textContent || '').trim();
        g.font = `500 ${12 * scale}px "Geist Mono", ui-monospace, monospace`;
        const tw = g.measureText(text).width, pad = 6 * scale, bh = 20 * scale;
        g.fillStyle = '#f4f4f1';
        g.beginPath(); g.roundRect(x - tw / 2 - pad, y - bh / 2, tw + pad * 2, bh, 5 * scale); g.fill();
        g.fillStyle = '#0a0a0a'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(text, x, y + scale);
      });
    }
    const url = out.toDataURL('image/png');
    this.renderer.setSize(w, h);
    hidden.forEach((o) => (o.visible = true));
    this.setBackground(prevBg || '#151515');
    return url;
  }
}

export function isVisible(o: THREE.Object3D | null): boolean {
  while (o) { if (!o.visible) return false; o = o.parent; }
  return true;
}

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o: any) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) if (m[k]?.isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

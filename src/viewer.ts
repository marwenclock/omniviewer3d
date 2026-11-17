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
  envTexture: THREE.Texture;
  headlight: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  private listeners = new Set<() => void>();
  private frameHooks = new Set<(dt: number) => void>();
  background = '#151515';
  /** true while recording a video / GIF: the corner axis gizmo is not drawn */
  recording = false;
  /** temporary visual overrides (inspector modes) that must be undone while exporting */
  readonly cleanHooks = new Set<{ off(): void; on(): void }>();
  /** compare wipe: left part of the screen shows only `left` objects, right part only `right` (null = off) */
  split: { x: number; left: THREE.Object3D[]; right: THREE.Object3D[] } | null = null;
  /** render-on-demand (OV-087): frames are drawn while something changes, then the loop idles */
  private renderUntil = 0;
  /** Frames still owed after a request: a throttled rAF can outlive the time window without drawing once. */
  private pendingFrames = 0;
  private continuous = new Set<string>();
  /** quality ladder (OV-089) */
  quality: 'auto' | 'quality' | 'performance' = 'auto';
  private slowFrames = 0;
  private autoReduced = false;
  /** true while a tool renders frames itself (turntable capture): the loop stays out of the way */
  hold = false;
  /** set when the browser drops the WebGL context (CA-23) */
  contextLost = false;
  onContextChange: (lost: boolean) => void = () => {};

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(this.targetPixelRatio());
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
    this.controls.addEventListener('change', () => this.requestRender());
    // Any user input or panel change keeps frames coming for a moment; idle scenes stop drawing.
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'input', 'change', 'touchstart', 'click'])
      window.addEventListener(ev, () => this.requestRender(), { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => this.requestRender());
    // GPU context loss (mobile GPUs under memory pressure): pause, tell the user, recover (CA-23).
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; this.onContextChange(true); });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.refreshMaterials(); this.requestRender(2000); this.onContextChange(false); });

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
  emit() { this.requestRender(); this.listeners.forEach((f) => f()); }

  /** Draws frames for the next `ms` milliseconds (render on demand). */
  requestRender(ms = 900) { this.renderUntil = Math.max(this.renderUntil, performance.now() + ms); this.pendingFrames = Math.max(this.pendingFrames, 3); }
  /** Keeps rendering every frame while `key` is set (recording, autoplaying animation, splats, turntable…). */
  setContinuous(key: string, on: boolean) { if (on) this.continuous.add(key); else this.continuous.delete(key); this.requestRender(); }

  private targetPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    if (this.quality === 'performance') return Math.min(dpr, 1);
    if (this.quality === 'quality') return Math.min(dpr, 2);
    return this.autoReduced ? Math.min(dpr, 1) : Math.min(dpr, 2);
  }
  setQuality(q: 'auto' | 'quality' | 'performance') {
    this.quality = q; this.autoReduced = false; this.slowFrames = 0;
    this.renderer.setPixelRatio(this.targetPixelRatio());
    this.resize(); this.requestRender();
  }

  /** Mouse button layout (OV-115) and zoom-to-cursor (OV-040). */
  setNavigation(preset: 'default' | 'cad' | 'blender', zoomToCursor: boolean) {
    const { ROTATE, PAN, DOLLY } = THREE.MOUSE;
    this.controls.mouseButtons = preset === 'default'
      ? { LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN }
      : { LEFT: null as any, MIDDLE: ROTATE, RIGHT: PAN };
    this.controls.zoomToCursor = zoomToCursor;
    this.navPreset = preset;
  }
  navPreset: 'default' | 'cad' | 'blender' = 'default';
  onFrame(fn: (dt: number) => void) { this.frameHooks.add(fn); return () => this.frameHooks.delete(fn); }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.updateOrtho();
    this.requestRender?.();
    // Resizing clears the canvas; draw straight away instead of waiting for a (possibly throttled) animation frame.
    if (this.scene && this.camera && !this.contextLost && !this.hold && !this.recording) this.draw();
  }

  /** One frame of the scene, gizmo and labels. */
  private draw() {
    this.renderer.clear();
    if (this.split && this.split.left.length + this.split.right.length) this.renderSplit();
    else this.renderer.render(this.scene, this.camera);
    if (!this.recording) this.viewHelper?.render(this.renderer);
    this.labels.render(this.scene, this.camera);
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
    if (this.contextLost || this.hold) return;
    const now = performance.now();
    const animating = this.viewHelper.animating || !!(this.activeAction && !this.activeAction.paused && this.activeAction.isRunning()) || this.controls.autoRotate || this.continuous.size > 0;
    if (!animating && now > this.renderUntil && this.pendingFrames <= 0) return; // idle: nothing changed, keep the GPU quiet
    if (this.pendingFrames > 0) this.pendingFrames--;
    if (this.viewHelper.animating) this.viewHelper.update(dt);
    if (this.controls.update(dt)) this.requestRender(300); // still damping
    this.mixer?.update(dt);
    this.frameHooks.forEach((f) => f(dt));
    this.draw();
    // Auto quality: drop the pixel ratio while the GPU struggles (≈ under 30 fps for 2 s), restore when it recovers.
    if (this.quality === 'auto' && dt > 0) {
      if (dt > 0.034) this.slowFrames = Math.min(120, this.slowFrames + 1); else this.slowFrames = Math.max(-240, this.slowFrames - 1);
      if (!this.autoReduced && this.slowFrames >= 60 && (window.devicePixelRatio || 1) > 1) { this.autoReduced = true; this.renderer.setPixelRatio(this.targetPixelRatio()); this.resize(); }
      else if (this.autoReduced && this.slowFrames <= -240) { this.autoReduced = false; this.renderer.setPixelRatio(this.targetPixelRatio()); this.resize(); }
    }
  }

  /** Before / after wipe: two scissored renders with complementary visibility. */
  private renderSplit() {
    const s = this.split!;
    const size = this.renderer.getSize(new THREE.Vector2());
    const x = Math.round(size.x * Math.min(1, Math.max(0, s.x)));
    const draw = (hide: THREE.Object3D[], left: number, width: number) => {
      if (width <= 0) return;
      const was = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(left, 0, width, size.y);
      this.renderer.setViewport(0, 0, size.x, size.y);
      this.renderer.render(this.scene, this.camera);
      hide.forEach((o, i) => (o.visible = was[i]));
    };
    draw(s.right, 0, x);
    draw(s.left, x, size.x - x);
    this.renderer.setScissorTest(false);
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
        this.userPlayed = false;
        this.playClip(0);
      }
    }
    this.refreshMaterials();
    this.fit();
    this.emit();
  }

  /** Swaps the displayed model WITHOUT disposing the previous one (multi-document tabs, OV-110). */
  swapModel(object: THREE.Object3D | null, clips: THREE.AnimationClip[] = [], autoplay = true) {
    if (this.model) this.world.remove(this.model);
    this.mixer?.stopAllAction();
    this.mixer = null; this.activeAction = null; this.clips = clips;
    this.model = object;
    if (object) { this.world.add(object); if (clips.length) { this.mixer = new THREE.AnimationMixer(object); if (autoplay) this.playClip(0); } }
    this.refreshMaterials();
    this.emit();
  }

  /** Autoplay preference for animations (OV-060). */
  autoplay = true;
  playClip(index: number) {
    if (!this.mixer) return;
    this.activeAction?.stop();
    if (index < 0) { this.activeAction = null; this.emit(); return; }
    this.activeAction = this.mixer.clipAction(this.clips[index]);
    this.activeAction.reset().play();
    this.activeAction.paused = !this.autoplay && !this.userPlayed;
    this.emit();
  }
  /** set once the user presses Play, so autoplay-off only affects the first open */
  userPlayed = false;
  /** Animation transport (OV-097). */
  setPaused(p: boolean) { if (this.activeAction) { this.activeAction.paused = p; if (!p) this.userPlayed = true; } this.requestRender(); this.emit(); }
  get animTime() { return this.activeAction?.time ?? 0; }
  get animDuration() { return this.activeAction?.getClip().duration ?? 0; }
  seek(t: number) { if (!this.activeAction || !this.mixer) return; this.activeAction.time = Math.max(0, Math.min(t, this.animDuration)); this.mixer.update(0); this.requestRender(); }
  setSpeed(k: number) { if (this.activeAction) this.activeAction.timeScale = k; }
  setLoop(on: boolean) { if (this.activeAction) { this.activeAction.setLoop(on ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); this.activeAction.clampWhenFinished = !on; } }
  resetPose() { this.mixer?.stopAllAction(); this.activeAction = null; this.model?.traverse((o: any) => { if (o.isSkinnedMesh) o.skeleton.pose(); }); this.requestRender(); this.emit(); }

  /** Re-applies display settings (clipping, wireframe, x-ray, edges) to every material. */
  refreshMaterials() {
    const planes = this.section.enabled ? [this.clipPlane] : [];
    const edgesWanted = this.showEdges;
    this.model?.traverse((o: any) => {
      if (o.userData.helper || o.userData.splat || o.userData.proxy) return;
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
      if (o.userData.helper || o.userData.splat || !o.visible) return;
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

  setAutoRotate(on: boolean) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = 1.5; this.requestRender(); }

  /** Temporarily renders at an exact pixel size with the framing preserved (used by turntable capture). */
  beginFixedSize(w: number, h: number) {
    const prev = { ratio: this.renderer.getPixelRatio(), fov: this.perspective.fov, aspect: this.perspective.aspect, o: { l: this.ortho.left, r: this.ortho.right, t: this.ortho.top, b: this.ortho.bottom } };
    const cw = this.container.clientWidth || 1, ch = this.container.clientHeight || 1, aspect = w / h;
    if (aspect < cw / ch) {
      const hf = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(prev.fov) / 2) * (cw / ch));
      this.perspective.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hf / 2) / aspect));
      const half = (prev.o.r - prev.o.l) / 2 / aspect; this.ortho.top = half; this.ortho.bottom = -half;
    } else { const half = ((prev.o.t - prev.o.b) / 2) * aspect; this.ortho.left = -half; this.ortho.right = half; }
    this.perspective.aspect = aspect; this.perspective.updateProjectionMatrix(); this.ortho.updateProjectionMatrix();
    this.renderer.setPixelRatio(1); this.renderer.setSize(w, h, false);
    return () => {
      this.perspective.fov = prev.fov; this.perspective.aspect = prev.aspect; this.perspective.updateProjectionMatrix();
      Object.assign(this.ortho, { left: prev.o.l, right: prev.o.r, top: prev.o.t, bottom: prev.o.b }); this.ortho.updateProjectionMatrix();
      this.renderer.setPixelRatio(prev.ratio); this.resize();
    };
  }
  /** Renders one frame now (scene only, no corner gizmo). */
  renderOnce() { this.renderer.clear(); this.renderer.render(this.scene, this.camera); }

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

  /**
   * Screenshot as a PNG data URL (OV-005, OV-095). Renders at an explicit pixel size with pixel ratio 1, so the
   * result matches the on-screen framing on every display (high-DPI screens used to come out cropped).
   */
  screenshot(scale = 1, transparent = false, annotations = true, size?: { width: number; height: number }): string {
    const prevBg = this.background;
    const cw = this.container.clientWidth || 1, ch = this.container.clientHeight || 1;
    const outW = Math.round(size?.width ?? cw * scale), outH = Math.round(size?.height ?? ch * scale);
    // Hide viewer chrome (grid, gizmos, selection box); keep measurements, dimensions and section caps.
    const hidden: THREE.Object3D[] = [];
    this.overlay.traverse((o) => {
      const chrome = o === this.grid || o === this.axes || o === this.sectionHelper || o.userData.noShot;
      if (o.visible && (chrome || (!annotations && o !== this.overlay && !o.userData.cap))) { hidden.push(o); o.visible = false; }
    });
    if (transparent) this.setBackground(null);
    const prevRatio = this.renderer.getPixelRatio();
    // Different aspect ratio: widen the camera frustum so the on-screen framing stays inside the image.
    const aspect = outW / outH, prevAspect = this.perspective.aspect;
    const prevOrtho = { l: this.ortho.left, r: this.ortho.right, t: this.ortho.top, b: this.ortho.bottom };
    const prevFov = this.perspective.fov;
    if (Math.abs(aspect - cw / ch) > 1e-3) {
      if (aspect < cw / ch) {
        // taller image: keep horizontal framing, extend vertically
        const hf = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(prevFov) / 2) * (cw / ch));
        this.perspective.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hf / 2) / aspect));
        const half = (prevOrtho.r - prevOrtho.l) / 2 / aspect;
        this.ortho.top = half; this.ortho.bottom = -half;
      } else {
        const half = (prevOrtho.t - prevOrtho.b) / 2 * aspect;
        this.ortho.left = -half; this.ortho.right = half;
      }
      this.perspective.aspect = aspect;
      this.perspective.updateProjectionMatrix(); this.ortho.updateProjectionMatrix();
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(outW, outH, false);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const g = out.getContext('2d')!;
    g.drawImage(this.renderer.domElement, 0, 0, outW, outH);
    if (annotations) {
      const k = Math.max(1, Math.min(outW / cw, outH / ch));
      // HTML labels are not part of the WebGL image, so draw them as text.
      this.overlay.traverse((o: any) => {
        if (!o.isCSS2DObject || !isVisible(o)) return;
        const p = o.getWorldPosition(new THREE.Vector3()).project(this.camera);
        if (p.z > 1) return;
        const x = ((p.x + 1) / 2) * outW, y = ((1 - p.y) / 2) * outH;
        const text = (o.element.textContent || '').trim();
        g.font = `500 ${12 * k}px "Geist Mono", ui-monospace, monospace`;
        const tw = g.measureText(text).width, pad = 6 * k, bh = 20 * k;
        g.fillStyle = '#f4f4f1';
        g.beginPath(); g.roundRect(x - tw / 2 - pad, y - bh / 2, tw + pad * 2, bh, 5 * k); g.fill();
        g.fillStyle = '#0a0a0a'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(text, x, y + k);
      });
    }
    const url = out.toDataURL('image/png');
    this.perspective.fov = prevFov; this.perspective.aspect = prevAspect; this.perspective.updateProjectionMatrix();
    Object.assign(this.ortho, { left: prevOrtho.l, right: prevOrtho.r, top: prevOrtho.t, bottom: prevOrtho.b }); this.ortho.updateProjectionMatrix();
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(cw, ch);
    hidden.forEach((o) => (o.visible = true));
    this.setBackground(transparent ? (prevBg || '#151515') : prevBg || '#151515');
    this.requestRender();
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

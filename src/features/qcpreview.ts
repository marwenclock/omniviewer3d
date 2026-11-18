import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { escHtml } from '../context';
import { icon } from '../icons';
import { t } from '../i18n';

// A light 3D preview for Quick Convert: one small canvas that shows the file being converted, so the user can check
// it is the right one before downloading. It is deliberately minimal (orbit, zoom, slow turn); the full viewer and
// editor is one button away. It shows a shallow clone (geometry and materials are shared, nothing is copied), inside
// its own pivot, so the converter's object and its transforms are never touched.

export type PreviewState =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'failed'; name: string; error: string }
  | { kind: 'ready'; name: string; obj: THREE.Object3D; up: 'y' | 'z'; caption: string; key: number };

let el: HTMLElement | null = null;
let stage: HTMLElement;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls, spin: THREE.Group, pivot: THREE.Group;
let shownKey = -1;
let spinning = false, dirty = true, raf = 0, active = false;
let onOpenFull: () => void = () => {};

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || localStorage.getItem('motion') === '"reduce"';

/** Creates the panel (once) in front of `before`. */
export function mountPreview(before: HTMLElement, openFull: () => void) {
  onOpenFull = openFull;
  if (el) return;
  el = document.createElement('section');
  el.className = 'qc-preview';
  el.hidden = true;
  el.setAttribute('aria-label', t('Preview'));
  el.innerHTML = `<div class="qcp-cap"><b></b><small></small></div>
    <div class="qcp-stage"></div>
    <div class="qcp-msg" aria-live="polite"></div>
    <div class="qcp-foot">
      <small class="qcp-hint">${t('Drag to turn · pinch or scroll to zoom')}</small>
      <button class="qcp-full btn-solid small" type="button">${icon('cube')} <span>${t('Open in full viewer & editor')}</span> ${icon('arrow')}</button>
    </div>`;
  before.before(el);
  stage = el.querySelector('.qcp-stage')!;
  el.querySelector('.qcp-full')!.addEventListener('click', () => onOpenFull());
  new ResizeObserver(() => { if (renderer && stage.clientWidth) { size(); renderer.render(scene, camera); dirty = false; } }).observe(stage);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (active) loop(); });
}

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('role', 'img');
  stage.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.5));
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(0.5, 1, 1); camera.add(key); scene.add(camera);
  // spin turns about the vertical axis through the model's centre; pivot stands Z-up files upright inside it.
  spin = new THREE.Group(); pivot = new THREE.Group(); spin.add(pivot); scene.add(spin);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12; controls.enablePan = false;
  controls.addEventListener('change', () => { dirty = true; });
  controls.addEventListener('start', () => { spinning = false; el?.classList.add('touched'); });
  size();
}

function size() {
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
  renderer!.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

function frame(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const fov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect);
  const dist = (r / Math.sin(Math.min(fov, hfov) / 2)) * 1.12;
  camera.near = dist / 200; camera.far = dist * 50; camera.updateProjectionMatrix();
  camera.position.copy(c).addScaledVector(new THREE.Vector3(1, 0.7, 1.25).normalize(), dist);
  controls.target.copy(c); controls.minDistance = dist * 0.15; controls.maxDistance = dist * 6;
  controls.update();
}

export function showPreview(s: PreviewState) {
  if (!el) return;
  el.hidden = s.kind === 'empty';
  el.dataset.state = s.kind;
  const cap = el.querySelector('.qcp-cap')!, msg = el.querySelector<HTMLElement>('.qcp-msg')!;
  cap.querySelector('b')!.textContent = s.kind === 'empty' ? '' : s.name;
  cap.querySelector('small')!.textContent = s.kind === 'ready' ? s.caption : '';
  msg.innerHTML = s.kind === 'loading' ? `<span class="spinner"></span>${escHtml(t('Reading…'))}` : s.kind === 'failed' ? escHtml(s.error) : '';
  if (s.kind !== 'ready') { clear(); return; }
  ensureRenderer();
  if (s.key !== shownKey) {
    clear();
    shownKey = s.key;
    const copy = cloneForPreview(s.obj);
    spin.rotation.set(0, 0, 0);
    pivot.position.set(0, 0, 0);
    pivot.rotation.set(s.up === 'z' ? -Math.PI / 2 : 0, 0, 0);
    pivot.add(copy);
    spin.updateMatrixWorld(true);
    pivot.position.sub(new THREE.Box3().setFromObject(spin).getCenter(new THREE.Vector3()));
    spin.updateMatrixWorld(true);
    size();
    frame(spin);
    renderer!.domElement.setAttribute('aria-label', t('3D preview of {name}', { name: s.name }));
    el.classList.remove('touched');
    spinning = !reduceMotion();
    renderer!.render(scene, camera); // first frame now, not on the next animation frame
  }
  dirty = true;
  active = true;
  loop();
}

function cloneForPreview(obj: THREE.Object3D): THREE.Object3D {
  let skinned = false;
  obj.traverse((o: any) => { if (o.isSkinnedMesh) skinned = true; });
  return skinned ? skeletonClone(obj) : obj.clone(true);
}

function clear() {
  shownKey = -1;
  if (pivot) pivot.clear(); // geometry and materials belong to the converter's object: never dispose them here
  dirty = true;
}

function loop() {
  if (raf || !renderer) return;
  const tick = () => {
    raf = 0;
    if (!active || !el || el.hidden) return;
    if (spinning) { spin.rotation.y += 0.004; dirty = true; }
    if (controls.update()) dirty = true;
    if (dirty) { renderer!.render(scene, camera); dirty = false; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

/** Stops drawing and lets go of the shown model (Quick Convert closed). */
export function pausePreview() {
  active = false;
  stop();
  clear();
  if (el) el.hidden = true;
}

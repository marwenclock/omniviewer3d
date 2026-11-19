import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { escHtml } from '../context';
import { icon } from '../icons';
import { t } from '../i18n';

// A light 3D preview of the SOURCE file for Quick Convert, so the user can check it is the right one before
// downloading. It is deliberately minimal (orbit, zoom, one slow turn); the full viewer and editor is one button away.
// It shows a shallow clone (geometry and materials are shared, nothing is copied), inside its own pivot, so the
// converter's object and its transforms are never touched.
//
// Memory (audit F28): a second WebGL context with environment lighting is what made iPhone Safari reload the page
// mid-conversion (commit a1d8805). So on touch devices the preview starts as a still image drawn with the viewer's
// own context, and the live renderer is created only when the person taps "Rotate". Lighting is plain lights, never
// a PMREM environment. The turn stops after one revolution and drawing pauses when the preview is off screen (F27).

export type PreviewState =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'failed'; name: string; error: string }
  | { kind: 'ready'; name: string; obj: THREE.Object3D; up: 'y' | 'z'; caption: string; key: number; still?: () => string | undefined };

let el: HTMLElement | null = null;
let stage: HTMLElement;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls, spin: THREE.Group, pivot: THREE.Group;
let shownKey = -1;
let spinning = false, spun = 0, dirty = true, raf = 0, active = false, onScreen = true, last = 0;
let current: Extract<PreviewState, { kind: 'ready' }> | null = null;
let live = false; // the live renderer is in use (always on desktop, after "Rotate" on touch devices)
let onOpenFull: () => void = () => {};

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || localStorage.getItem('motion') === '"reduce"';
const touchFirst = () => matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;

/** Creates the panel (once), after the converter list: the task comes first, the check second (F10). */
export function mountPreview(after: HTMLElement, openFull: () => void) {
  onOpenFull = openFull;
  if (el) return;
  el = document.createElement('section');
  el.className = 'qc-preview';
  el.hidden = true;
  el.setAttribute('aria-label', t('Source preview'));
  el.innerHTML = `<div class="qcp-cap"><span class="qcp-kicker">${t('Source preview')}</span><b></b><small></small></div>
    <div class="qcp-stage"><img class="qcp-still" alt="" hidden/><button class="qcp-rotate btn-outline small" type="button" hidden>${icon('rotate')} <span>${t('Tap to rotate')}</span></button></div>
    <div class="qcp-msg" aria-live="polite"></div>
    <div class="qcp-foot">
      <small class="qcp-hint">${t('Drag to turn · pinch or scroll to zoom')}</small>
      <button class="qcp-full btn-outline small" type="button">${icon('cube')} <span>${t('Open in full viewer & editor')}</span> ${icon('arrow')}</button>
    </div>`;
  after.after(el);
  stage = el.querySelector('.qcp-stage')!;
  el.querySelector('.qcp-full')!.addEventListener('click', () => onOpenFull());
  el.querySelector('.qcp-rotate')!.addEventListener('click', () => { live = true; if (current) { shownKey = -1; showPreview(current); } });
  new ResizeObserver(() => { if (renderer && live && stage.clientWidth) { size(); renderer.render(scene, camera); dirty = false; } }).observe(stage);
  new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); if (onScreen && active) loop(); else stop(); }).observe(el);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (active) loop(); });
}

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('role', 'img');
  stage.prepend(renderer.domElement);
  scene = new THREE.Scene();
  // Plain lights, the same recipe as the thumbnails: no PMREM environment map (memory, F28).
  scene.add(new THREE.AmbientLight(0xffffff, 0.9), new THREE.HemisphereLight(0xffffff, 0x404040, 1.4));
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.5, 1, 1); camera.add(key); scene.add(camera);
  // spin turns about the vertical axis through the model's centre; pivot stands Z-up files upright inside it.
  spin = new THREE.Group(); pivot = new THREE.Group(); spin.add(pivot); scene.add(spin);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12; controls.enablePan = false;
  controls.addEventListener('change', () => { dirty = true; loop(); });
  controls.addEventListener('start', () => { spinning = false; el?.classList.add('touched'); loop(); });
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
  const img = el.querySelector<HTMLImageElement>('.qcp-still')!, rot = el.querySelector<HTMLElement>('.qcp-rotate')!;
  cap.querySelector('b')!.textContent = s.kind === 'empty' ? '' : s.name;
  cap.querySelector('small')!.textContent = s.kind === 'ready' ? s.caption : '';
  msg.innerHTML = s.kind === 'loading' ? `<span class="spinner"></span>${escHtml(t('Reading…'))}` : s.kind === 'failed' ? escHtml(s.error) : '';
  if (s.kind !== 'ready') { current = null; img.hidden = true; rot.hidden = true; clear(); return; }
  const changed = s.key !== current?.key;
  current = s;
  if (!live && touchFirst()) {
    // Still image first on touch devices; no WebGL context of our own until asked.
    if (changed || img.hidden) { const src = s.still?.(); if (src) { img.src = src; img.alt = t('3D preview of {name}', { name: s.name }); } }
    img.hidden = false; rot.hidden = false;
    el.classList.add('is-still');
    if (renderer) renderer.domElement.hidden = true;
    active = false; stop();
    return;
  }
  live = true;
  img.hidden = true; rot.hidden = true;
  el.classList.remove('is-still');
  ensureRenderer();
  renderer!.domElement.hidden = false;
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
    spinning = !reduceMotion(); spun = 0;
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

/** Draws only while something moves: the single slow turn, damping after a drag, or a resize. */
function loop() {
  if (raf || !renderer || !active || !onScreen) return;
  last = performance.now();
  const tick = (now: number) => {
    raf = 0;
    if (!active || !el || el.hidden || !onScreen) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (spinning) { const a = dt * 0.45; spin.rotation.y += a; spun += a; dirty = true; if (spun >= Math.PI * 2) spinning = false; }
    if (controls.update()) dirty = true;
    const moving = dirty;
    if (dirty) { renderer!.render(scene, camera); dirty = false; }
    if (moving || spinning) raf = requestAnimationFrame(tick); // idle: no more frames until input (F27)
  };
  raf = requestAnimationFrame(tick);
}
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

/** Stops drawing and lets go of the shown model (Quick Convert closed). */
export function pausePreview() {
  active = false;
  current = null;
  stop();
  clear();
  if (el) el.hidden = true;
}

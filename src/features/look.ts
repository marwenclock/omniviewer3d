import * as THREE from 'three';
import { ctx, modelMeshes } from '../context';
import { registerCommand } from '../registry';

// ------------------------------------------------------------------ lighting environments
export const LOOKS: Record<string, string> = {
  studio: 'Studio', soft: 'Soft', sunset: 'Sunset', overcast: 'Overcast sky', night: 'Night', flat: 'Flat (no reflections)',
};
const envCache = new Map<string, THREE.Texture>();

/** Builds an environment map from a gradient sky with a sun, so we ship no HDR files. */
function skyEnv(top: string, horizon: string, bottom: string, sunColor: string, sunDir: THREE.Vector3, sunPower: number) {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(top) }, horizon: { value: new THREE.Color(horizon) }, bottom: { value: new THREE.Color(bottom) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.4)); gl_FragColor = vec4(c, 1.0); }',
    }),
  );
  const sun = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(sunColor).multiplyScalar(sunPower) }));
  sun.position.copy(sunDir.normalize().multiplyScalar(40));
  scene.add(sky, sun);
  const pmrem = new THREE.PMREMGenerator(ctx.viewer.renderer);
  const tex = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  return tex;
}

function envFor(name: string): THREE.Texture | null {
  if (name === 'flat') return null;
  if (name === 'studio' || name === 'soft') return ctx.viewer.envTexture;
  if (!envCache.has(name)) {
    const t = name === 'sunset' ? skyEnv('#3b5b8c', '#ffb36b', '#2a2320', '#fff1d6', new THREE.Vector3(1, 0.15, 0.6), 30)
      : name === 'overcast' ? skyEnv('#c9d2db', '#e8ebee', '#6d6f70', '#ffffff', new THREE.Vector3(0.2, 1, 0.3), 3)
      : skyEnv('#05070d', '#1a2238', '#050505', '#bcd0ff', new THREE.Vector3(-0.4, 0.8, 0.2), 8);
    envCache.set(name, t);
  }
  return envCache.get(name)!;
}

export let currentLook = 'studio';
export let envBackground = false;

export function setLook(name: string) {
  currentLook = name in LOOKS ? name : 'studio';
  const v = ctx.viewer;
  v.setLighting(currentLook === 'soft' ? 'soft' : currentLook === 'flat' ? 'flat' : 'studio');
  v.scene.environment = envFor(currentLook);
  if (currentLook === 'night') { v.headlight.intensity = 0.5; v.ambient.intensity = 0.25; }
  if (currentLook === 'sunset') { v.headlight.color.set('#ffd9b0'); } else v.headlight.color.set('#ffffff');
  applyBackground();
  try { localStorage.setItem('omniview.light', currentLook); } catch { /* private mode */ }
}

export function setEnvBackground(on: boolean) { envBackground = on; applyBackground(); }

function applyBackground() {
  const v = ctx.viewer;
  if (envBackground && v.scene.environment) {
    v.scene.background = v.scene.environment;
    v.scene.backgroundBlurriness = 0.35;
    v.scene.backgroundIntensity = 0.9;
  } else {
    v.setBackground(v.background || '#151515');
    v.scene.backgroundBlurriness = 0;
  }
}

// ------------------------------------------------------------------ backdrop presets (gradient backgrounds)
export const BACKDROPS: Record<string, [string, string] | string> = {
  'Dark': '#151515', 'Black': '#0a0a0a', 'Light': '#ebebea', 'White': '#ffffff',
  'Studio dark': ['#2c2c2e', '#0b0b0c'], 'Studio light': ['#ffffff', '#cfcfcc'], 'Blueprint': ['#1d3557', '#0b1626'], 'Warm': ['#3a2a22', '#120d0a'],
};
export function setBackdrop(name: string) {
  const b = BACKDROPS[name];
  const v = ctx.viewer;
  envBackground = false;
  if (!b) return;
  if (typeof b === 'string') { v.setBackground(b); return; }
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 512); grd.addColorStop(0, b[0]); grd.addColorStop(1, b[1]);
  g.fillStyle = grd; g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  v.background = b[1];
  v.scene.background = tex;
  v.renderer.setClearColor(b[1], 1);
}

// ------------------------------------------------------------------ ground shadow
let shadowOn = false;
let shadowLight: THREE.DirectionalLight | null = null;
let ground: THREE.Mesh | null = null;
export const shadowEnabled = () => shadowOn;

export function setShadow(on: boolean) {
  shadowOn = on;
  const v = ctx.viewer;
  v.renderer.shadowMap.enabled = on;
  v.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (!on) {
    shadowLight?.removeFromParent(); shadowLight?.target.removeFromParent(); ground?.removeFromParent();
    shadowLight = null; ground = null;
    modelMeshes(v.model).forEach((m) => (m.castShadow = false));
    return;
  }
  placeShadow();
  try { localStorage.setItem('omniview.shadow', '1'); } catch { /* */ }
}

function placeShadow() {
  const v = ctx.viewer;
  if (!shadowOn || !v.model) return;
  const box = v.bounds();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);
  if (!shadowLight) {
    shadowLight = new THREE.DirectionalLight(0xffffff, 0.0001); // casts shadows only; lighting comes from the environment
    shadowLight.castShadow = true;
    shadowLight.shadow.mapSize.set(2048, 2048);
    shadowLight.shadow.radius = 6;
    shadowLight.userData.helper = true;
    shadowLight.target.userData.helper = true;
    ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32, transparent: true }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData = { helper: true };
    ground.raycast = () => {};
    v.overlay.add(shadowLight, shadowLight.target, ground);
  }
  shadowLight.position.set(c.x + span * 0.6, box.max.y + span * 2, c.z + span * 0.4);
  shadowLight.target.position.set(c.x, box.min.y, c.z);
  const cam = shadowLight.shadow.camera;
  cam.left = cam.bottom = -span * 1.2; cam.right = cam.top = span * 1.2; cam.near = 0.01; cam.far = span * 6;
  cam.updateProjectionMatrix();
  ground!.position.set(c.x, box.min.y - span * 0.001, c.z);
  ground!.scale.setScalar(span * 4);
  modelMeshes(v.model).forEach((m) => (m.castShadow = true));
}

export function initLook() {
  try {
    setLook(localStorage.getItem('omniview.light') || 'studio');
    if (localStorage.getItem('omniview.shadow') === '1') shadowOn = true;
  } catch { /* */ }
  ctx.viewer.onChange(() => { if (shadowOn) { ctx.viewer.renderer.shadowMap.enabled = true; placeShadow(); } });
  ctx.history.onChange(() => placeShadow());
  registerCommand(
    ...Object.entries(LOOKS).map(([k, label]) => ({ id: 'look-' + k, label: `Lighting: ${label}`, group: 'View', keywords: 'environment light hdr', run: () => setLook(k) })),
    { id: 'shadow', label: 'Toggle ground shadow', group: 'View', keywords: 'shadow floor render', run: () => setShadow(!shadowOn) },
    { id: 'envbg', label: 'Toggle environment background', group: 'View', keywords: 'sky backdrop hdr', run: () => setEnvBackground(!envBackground) },
    ...Object.keys(BACKDROPS).map((k) => ({ id: 'bg-' + k, label: `Background: ${k}`, group: 'View', keywords: 'backdrop colour gradient', run: () => setBackdrop(k) })),
  );
}

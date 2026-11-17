import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ctx, escHtml } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { icon } from '../icons';

// ------------------------------------------------------------------ dimension overlay
let dims: THREE.Group | null = null;
export let dimsOn = false;

function clearDims() {
  if (!dims) return;
  dims.traverse((o: any) => { o.geometry?.dispose?.(); o.element?.remove?.(); });
  dims.removeFromParent();
  dims = null;
}

/** Width / height / depth arrows along the bounding box, with labels. */
function buildDims() {
  clearDims();
  const v = ctx.viewer;
  if (!dimsOn || !v.model) return;
  const box = v.bounds();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const off = size.length() * 0.06;
  const { min, max } = box;
  dims = new THREE.Group();
  dims.userData.helper = true;
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false });
  const seg = (pts: THREE.Vector3[]) => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
    l.renderOrder = 995; l.raycast = () => {}; l.userData.helper = true;
    dims!.add(l);
  };
  const arrow = (a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3) => {
    const dir = b.clone().sub(a).normalize(), head = off * 0.35;
    const pts = [a, b];
    for (const [p, d] of [[a, dir], [b, dir.clone().negate()]] as const) {
      pts.push(p, p.clone().addScaledVector(d, head).addScaledVector(side, head * 0.5), p, p.clone().addScaledVector(d, head).addScaledVector(side, -head * 0.5));
    }
    seg(pts);
  };
  const label = (pos: THREE.Vector3, text: string) => {
    const el = document.createElement('div');
    el.className = 'measure-label dim-label';
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    dims!.add(o);
  };
  const y0 = min.y - off * 0.02;
  // X (width) along the front-bottom edge
  const zf = max.z + off;
  seg([new THREE.Vector3(min.x, y0, max.z), new THREE.Vector3(min.x, y0, zf * 1 + off * 0.3), new THREE.Vector3(max.x, y0, max.z), new THREE.Vector3(max.x, y0, zf + off * 0.3)]);
  arrow(new THREE.Vector3(min.x, y0, zf), new THREE.Vector3(max.x, y0, zf), new THREE.Vector3(0, 0, 1));
  label(new THREE.Vector3((min.x + max.x) / 2, y0, zf), ctx.fmtLen(size.x, 2));
  // Z (depth) along the right-bottom edge
  const xr = max.x + off;
  seg([new THREE.Vector3(max.x, y0, min.z), new THREE.Vector3(xr + off * 0.3, y0, min.z), new THREE.Vector3(max.x, y0, max.z), new THREE.Vector3(xr + off * 0.3, y0, max.z)]);
  arrow(new THREE.Vector3(xr, y0, min.z), new THREE.Vector3(xr, y0, max.z), new THREE.Vector3(1, 0, 0));
  label(new THREE.Vector3(xr, y0, (min.z + max.z) / 2), ctx.fmtLen(size.z, 2));
  // Y (height) up the front-right corner
  seg([new THREE.Vector3(max.x, min.y, max.z), new THREE.Vector3(xr + off * 0.3, min.y, max.z + off), new THREE.Vector3(max.x, max.y, max.z), new THREE.Vector3(xr + off * 0.3, max.y, max.z + off)]);
  arrow(new THREE.Vector3(xr, min.y, max.z + off), new THREE.Vector3(xr, max.y, max.z + off), new THREE.Vector3(1, 0, 0));
  label(new THREE.Vector3(xr, (min.y + max.y) / 2, max.z + off), ctx.fmtLen(size.y, 2));
  v.overlay.add(dims);
}

export function setDims(on: boolean) { dimsOn = on; buildDims(); }

// ------------------------------------------------------------------ saved views
interface SavedView { name: string; cam: string }
const storeKey = () => 'omniview.views.' + ctx.modelName();
function loadViews(): SavedView[] { try { return JSON.parse(localStorage.getItem(storeKey()) || '[]'); } catch { return []; } }
function saveViews(v: SavedView[]) { try { localStorage.setItem(storeKey(), JSON.stringify(v)); } catch { /* private mode */ } }

const r4 = (n: number) => Number(n.toPrecision(5));
/** Camera position + target as a compact string (used in saved views and share links). */
export function cameraString(): string {
  const v = ctx.viewer, p = v.camera.position, t = v.controls.target;
  return [p.x, p.y, p.z, t.x, t.y, t.z].map(r4).join(',') + (v.camera === v.ortho ? ',o' : '');
}

/** Moves the camera to a saved string, smoothly. */
export function applyCamera(s: string, animate = true) {
  const parts = s.split(',');
  const n = parts.slice(0, 6).map(Number);
  if (n.length < 6 || n.some((x) => !isFinite(x))) return;
  const v = ctx.viewer;
  v.setProjection(parts[6] === 'o' ? 'orthographic' : 'perspective');
  const toPos = new THREE.Vector3(n[0], n[1], n[2]), toTgt = new THREE.Vector3(n[3], n[4], n[5]);
  const fromPos = v.camera.position.clone(), fromTgt = v.controls.target.clone();
  if (!animate) { v.camera.position.copy(toPos); v.controls.target.copy(toTgt); v.controls.update(); return; }
  const start = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / 450), e = 1 - Math.pow(1 - k, 3);
    v.camera.position.lerpVectors(fromPos, toPos, e);
    v.controls.target.lerpVectors(fromTgt, toTgt, e);
    v.controls.update();
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}

registerPanel({
  id: 'views', label: 'Saved views', icon: 'bookmark',
  hint: 'Save camera angles for this model and jump back to them',
  render() {
    const list = loadViews();
    return `<div class="row" style="margin-top:0"><input type="text" placeholder="View name" data-viewname value="View ${list.length + 1}"/><button class="chip" data-viewsave>${icon('plus')}Save</button></div>
      <div class="views-list">${list.map((s, i) => `<div class="view-row"><button class="view-go" data-viewgo="${i}">${icon('bookmark')}${escHtml(s.name)}</button><button class="node-btn" style="opacity:1" data-viewdel="${i}" title="Delete">${icon('x')}</button></div>`).join('') || '<p class="note">No saved views yet.</p>'}</div>
      <p class="note">Saved in this browser for “${escHtml(ctx.modelName())}”. Share links include the current view.</p>`;
  },
  bind(host) {
    host.querySelector('[data-viewsave]')?.addEventListener('click', () => {
      const list = loadViews();
      const name = (host.querySelector('[data-viewname]') as HTMLInputElement).value.trim() || `View ${list.length + 1}`;
      list.push({ name, cam: cameraString() });
      saveViews(list);
      ctx.renderDetails();
    });
    host.querySelectorAll<HTMLElement>('[data-viewgo]').forEach((b) => b.addEventListener('click', () => applyCamera(loadViews()[Number(b.dataset.viewgo)].cam)));
    host.querySelectorAll<HTMLElement>('[data-viewdel]').forEach((b) => b.addEventListener('click', () => { const l = loadViews(); l.splice(Number(b.dataset.viewdel), 1); saveViews(l); ctx.renderDetails(); }));
  },
});

// ------------------------------------------------------------------ inspector modes
export type InspectMode = 'none' | 'normals' | 'uv' | 'matcap' | 'faces' | 'vcolors';
export let inspectMode: InspectMode = 'none';
const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
let mats: Partial<Record<InspectMode, THREE.Material>> = {};

function canvasTexture(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function material(mode: InspectMode): THREE.Material {
  if (mats[mode]) return mats[mode]!;
  const side = THREE.DoubleSide;
  let m: THREE.Material;
  if (mode === 'normals') m = new THREE.MeshNormalMaterial({ side });
  else if (mode === 'uv') {
    const tex = canvasTexture((g, s) => {
      const n = 8, c = s / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        g.fillStyle = (x + y) % 2 ? '#1f1f1f' : '#e9e9e6'; g.fillRect(x * c, y * c, c, c);
        g.fillStyle = (x + y) % 2 ? '#bdbdbd' : '#555'; g.font = `${c * 0.32}px monospace`; g.fillText(`${String.fromCharCode(65 + x)}${y + 1}`, x * c + c * 0.12, y * c + c * 0.42);
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    m = new THREE.MeshBasicMaterial({ map: tex, side });
  } else if (mode === 'matcap') {
    const tex = canvasTexture((g, s) => {
      const grd = g.createRadialGradient(s * 0.38, s * 0.32, s * 0.02, s * 0.5, s * 0.5, s * 0.52);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.35, '#c9c9c4'); grd.addColorStop(0.8, '#55555a'); grd.addColorStop(1, '#1b1b1d');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    }, 256);
    m = new THREE.MeshMatcapMaterial({ matcap: tex, side });
  } else if (mode === 'faces') {
    m = new THREE.ShaderMaterial({
      side,
      vertexShader: 'varying vec3 vN; void main(){ vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vN; void main(){ float l = 0.55 + 0.45 * abs(normalize(vN).z); gl_FragColor = vec4((gl_FrontFacing ? vec3(0.18,0.62,1.0) : vec3(1.0,0.25,0.22)) * l, 1.0); }',
    });
  } else m = new THREE.MeshBasicMaterial({ vertexColors: true, side });
  mats[mode] = m;
  return m;
}

function restore() { for (const [mesh, m] of originals) mesh.material = m; originals.clear(); }

function apply() {
  restore();
  const v = ctx.viewer;
  if (inspectMode === 'none' || !v.model) return;
  const m = material(inspectMode);
  v.model.traverse((o: any) => {
    if (!o.isMesh || o.userData.helper) return;
    originals.set(o, o.material);
    o.material = inspectMode === 'vcolors' && !o.geometry.attributes.color ? new THREE.MeshBasicMaterial({ color: 0x777777, side: THREE.DoubleSide }) : m;
  });
  if (inspectMode === 'uv' && [...originals.keys()].every((x) => !x.geometry.attributes.uv)) ctx.toast('This model has no UV coordinates, so the checker cannot be shown.');
}

export function setInspect(mode: InspectMode) {
  inspectMode = inspectMode === mode ? 'none' : mode;
  apply();
  document.querySelectorAll<HTMLElement>('[data-inspect]').forEach((b) => b.classList.toggle('checked', b.dataset.inspect === inspectMode));
  const names: Record<InspectMode, string> = { none: 'Normal view', normals: 'Showing surface normals', uv: 'Showing UV checker', matcap: 'Clay (matcap) view', faces: 'Blue = front faces, red = back faces (flipped)', vcolors: 'Showing vertex colours only' };
  ctx.toast(names[inspectMode]);
}

// ------------------------------------------------------------------ init
export function initViews() {
  ctx.viewer.cleanHooks.add({ off: restore, on: apply });
  let lastModel = '';
  ctx.viewer.onChange(() => {
    const id = ctx.viewer.model?.uuid || '';
    if (id !== lastModel) { lastModel = id; if (inspectMode !== 'none') { originals.clear(); apply(); } }
    buildDims();
  });
  ctx.history.onChange(() => { buildDims(); if (inspectMode !== 'none') apply(); });
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-inspect],[data-dims]');
    if (!b) return;
    if (b.dataset.inspect) setInspect(b.dataset.inspect as InspectMode);
    else { setDims(!dimsOn); b.classList.toggle('checked', dimsOn); }
  });
  const has = () => !!ctx.viewer.model;
  registerCommand(
    { id: 'dims', label: 'Toggle dimension overlay', group: 'View', keywords: 'size width height depth arrows', run: () => { setDims(!dimsOn); document.querySelector('[data-dims]')?.classList.toggle('checked', dimsOn); }, enabled: has },
    { id: 'views', label: 'Saved views…', group: 'View', keywords: 'camera bookmark angle', run: () => ctx.setTool('views'), enabled: has },
    { id: 'inspect-normals', label: 'Inspect: surface normals', group: 'Inspect', keywords: 'debug', run: () => setInspect('normals'), enabled: has },
    { id: 'inspect-uv', label: 'Inspect: UV checker', group: 'Inspect', keywords: 'texture mapping', run: () => setInspect('uv'), enabled: has },
    { id: 'inspect-matcap', label: 'Inspect: clay / matcap', group: 'Inspect', keywords: 'shape form', run: () => setInspect('matcap'), enabled: has },
    { id: 'inspect-faces', label: 'Inspect: face orientation (flipped faces)', group: 'Inspect', keywords: 'normals backface red blue', run: () => setInspect('faces'), enabled: has },
    { id: 'inspect-vcolors', label: 'Inspect: vertex colours only', group: 'Inspect', keywords: 'paint color', run: () => setInspect('vcolors'), enabled: has },
  );
}

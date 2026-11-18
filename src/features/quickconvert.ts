import * as THREE from 'three';
import { zipSync } from 'fflate';
import { ctx, escHtml } from '../context';
import { registerCommand } from '../registry';
import { loadFiles, MODEL_EXTS, extOf, pathOf } from '../loaders';
import { EXPORT_FORMATS, exportObject, describeExport, exportBlocker, staysYUp, formatById, download, safeFileName, type ExportId, type UnitId } from '../exporters';
import { ProprietaryFormatError, PROPRIETARY } from '../formats-extra';
import { guessUnit, defaultUp } from '../units';
import { disposeObject } from '../viewer';
import { compareWith } from './compare';
import { icon } from '../icons';
import { t } from '../i18n';

// ---------------------------------------------------------------------------------------------
// Quick Convert: drop files, pick a target, download. No 3D workspace: models load headlessly (the same engine as
// batch convert), get a small static thumbnail, and convert on demand. "Open in viewer" is one click away.
// ---------------------------------------------------------------------------------------------

type UnitSrc = 'declared' | 'format' | 'guess' | 'user';
interface Row {
  id: number; files: File[]; name: string; ext: string; size: number;
  status: 'loading' | 'ready' | 'converting' | 'done' | 'failed';
  error?: string; help?: string;
  obj?: THREE.Object3D; clips: THREE.AnimationClip[]; tris: number; verts: number; dims?: THREE.Vector3;
  unit: UnitId; unitSrc: UnitSrc; up: 'y' | 'z';
  target: ExportId; ext2?: string; result?: { blob: Blob; name: string }; thumb?: string; picked: boolean;
}
interface Options { upright: boolean; outUnit: '' | 'mm' | 'cm' | 'm' | 'in'; scale: number; reduce: number; merge: boolean }

const PRESETS: { label: string; sub: string; to: ExportId; upright?: boolean }[] = [
  { label: '3D printing', sub: 'Bambu · Prusa · Orca', to: '3mf', upright: true },
  { label: 'Any slicer', sub: 'STL', to: 'stl', upright: true },
  { label: 'Blender', sub: 'GLB', to: 'glb' },
  { label: 'Unity · Unreal', sub: 'FBX', to: 'fbx' },
  { label: 'iPhone AR', sub: 'USDZ', to: 'usdz' },
  { label: 'CAD', sub: 'STEP', to: 'step', upright: true },
  { label: 'SketchUp', sub: 'COLLADA', to: 'dae' },
  { label: 'Web', sub: 'GLB', to: 'glb' },
];
const UNIT_LABEL: Record<string, string> = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft', u: 'units' };

const store = {
  get: (k: string, d = '') => { try { return localStorage.getItem('qc.' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('qc.' + k, v); } catch { /* private mode */ } },
};
interface HistItem { name: string; from: string; to: string; size: number; at: number }
const history = (): HistItem[] => { try { return JSON.parse(store.get('history', '[]')); } catch { return []; } };
const remember = () => store.get('remember', '1') === '1';

let rows: Row[] = [];
let nextId = 1;
let opts: Options = { upright: true, outUnit: '', scale: 100, reduce: 100, merge: false };
let allTarget: ExportId | null = null;
let instant: { to: ExportId } | null = null;
let host: HTMLElement | null = null;
let picker: { anchor: HTMLElement; onPick: (id: ExportId) => void; current: ExportId } | null = null;

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const exts = (id: ExportId) => { const f: any = formatById(id); return [f.ext, ...(f.alias ?? [])] as string[]; };

/** Rough output size before converting, from triangle and vertex counts (exact size shows after). */
function estimate(r: Row, id: ExportId): number | null {
  const t3 = r.tris, v = r.verts;
  if (!t3 && !v) return null;
  const k = opts.reduce / 100;
  const tt = t3 * k, vv = v * k;
  const table: Partial<Record<ExportId, number>> = {
    stl: 84 + 50 * tt, 'stl-ascii': 250 * tt, obj: vv * 34 + tt * 22, 'obj-zip': (vv * 34 + tt * 22) * 0.45, ply: 200 + vv * 15 + tt * 13,
    'ply-ascii': vv * 40 + tt * 18, glb: 2048 + vv * 32 + tt * 12, gltf: (2048 + vv * 32 + tt * 12) * 1.37, '3mf': (vv * 50 + tt * 45) * 0.22,
    off: vv * 30 + tt * 18, xyz: vv * 30, pcd: vv * 40, las: 227 + vv * 26, splat: vv * 32, drc: tt * 1.8 + 1024, fbx: vv * 16 + tt * 50,
    dae: vv * 33 + tt * 20, usda: vv * 36 + tt * 24, x3d: vv * 32 + tt * 20, wrl: vv * 34 + tt * 22, step: tt * 330, iges: tt * 1300,
    brep: tt * 520, ifc: vv * 36 + tt * 18 + 4096, '3dm': vv * 26 + tt * 18, vtk: vv * 30 + tt * 18, amf: vv * 100 + tt * 80,
  };
  const n = table[id];
  return n ? Math.round(n) : null;
}

/** A sensible first target for this file (never its own format), remembering what this user picked last time. */
function defaultTarget(r: Row): ExportId {
  if (instant) return instant.to;
  if (allTarget) return allTarget;
  const last = store.get('last.' + r.ext) as ExportId;
  if (last && EXPORT_FORMATS.some((f) => f.id === last)) return last;
  let pts = false, mesh = false;
  r.obj?.traverse((o: any) => { if (o.isMesh) mesh = true; if (o.isPoints) pts = true; });
  const pick: ExportId = pts && !mesh ? 'ply' : r.clips.length ? 'glb' : ['step', 'stp', 'iges', 'igs', 'brep', 'brp', '3dm', 'dxf'].includes(r.ext) ? 'stl' : r.ext === 'stl' ? '3mf' : ['3mf', 'obj', 'amf', 'off', 'ply'].includes(r.ext) ? 'stl' : 'glb';
  return exts(pick).includes(r.ext) ? 'glb' : pick;
}

// ------------------------------------------------------------------ loading
function groupFiles(files: File[]): File[][] {
  const companions = files.filter((f) => !MODEL_EXTS.has(extOf(f.name)) && !PROPRIETARY[extOf(f.name)] && /\.(mtl|bin|png|jpe?g|webp|bmp|tga|gif|ktx2|dds|tiff?)$/i.test(f.name));
  const mains = files.filter((f) => !companions.includes(f));
  const dir = (f: File) => { const p = pathOf(f); return p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''; };
  return mains.map((m) => [m, ...companions.filter((c) => dir(c) === dir(m))]);
}

export function qcAdd(files: File[]) {
  if (!files.length) return;
  crashNote = '';
  openQuickConvert();
  for (const group of groupFiles(files)) {
    const f = group[0];
    rows.push({ id: nextId++, files: group, name: f.name, ext: extOf(f.name), size: group.reduce((n, x) => n + x.size, 0), status: 'loading', clips: [], tris: 0, verts: 0, unit: 'mm', unitSrc: 'guess', up: 'y', target: 'glb', picked: false });
  }
  render();
  // Bring the first new file into view: on a phone the list sits below the drop zone and presets.
  const first = rows[rows.length - groupFiles(files).length];
  if (first) { focusId = first.id; reveal(first.id); }
  void loadPending();
}

// If the browser kills the tab while a file is being read (a phone running out of memory reloads the page),
// reopen Quick Convert after the reload and say what happened instead of silently dropping back to the home screen.
const READING = 'qc.reading';
let crashNote = '';
function mark(name: string | null) { try { name ? sessionStorage.setItem(READING, name) : sessionStorage.removeItem(READING); } catch { /* storage blocked */ } }

let focusId = 0;
// Scrolls the container rather than the row: re-rendering the list (a thumbnail arriving) would cancel a smooth
// scrollIntoView on the old row element.
const reveal = (id: number) => setTimeout(() => {
  const el = host?.querySelector<HTMLElement>(`[data-row="${id}"]`);
  const box = el?.closest<HTMLElement>('.welcome');
  if (!el || !box || box.scrollHeight <= box.clientHeight) { el?.scrollIntoView({ block: 'nearest' }); return; }
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top >= b.top && r.bottom <= b.bottom) return;
  box.scrollTo({ top: box.scrollTop + r.top - b.top - (b.height - r.height) / 2, behavior: 'smooth' });
}, 30);

let loading = false;
async function loadPending() {
  if (loading) return;
  loading = true;
  try {
    for (const r of rows) {
      if (r.status !== 'loading') continue;
      try {
        mark(r.name);
        const res = await loadFiles(r.files, () => {});
        r.obj = res.object; r.clips = res.animations;
        r.name = res.mainFiles[0] || r.name; r.ext = extOf(r.name);
        let tris = 0, verts = 0;
        r.obj.traverse((o: any) => { const g = o.geometry; if (!g?.attributes?.position) return; verts += g.attributes.position.count; if (o.isMesh) tris += (g.index ? g.index.count : g.attributes.position.count) / 3; });
        r.tris = Math.round(tris); r.verts = verts;
        r.dims = new THREE.Box3().setFromObject(r.obj).getSize(new THREE.Vector3());
        const g = guessUnit(r.ext, Math.max(r.dims.x, r.dims.y, r.dims.z), res.declaredUnit);
        r.unit = g.unit as UnitId; r.unitSrc = g.source === 'declared' ? 'declared' : g.source === 'saved' || g.source === 'user' ? 'user' : g.source === 'guess' ? 'guess' : 'format';
        r.up = defaultUp(r.ext);
        r.target = defaultTarget(r);
        if (exportBlocker(r.obj, r.target)) r.target = (['glb', 'stl', 'ply', 'xyz'] as ExportId[]).find((id) => !exportBlocker(r.obj!, id) && !exts(id).includes(r.ext)) ?? 'glb';
        r.status = 'ready';
        if (res.warnings.length) r.help = res.warnings.slice(0, 2).join(' ');
        render();
        if (r.id === focusId) { focusId = 0; reveal(r.id); } // it grew when it loaded
        void thumb(r);
        if (instant && !needsUnitConfirm(r)) await convert(r, true);
      } catch (e: any) {
        r.status = 'failed';
        if (e instanceof ProprietaryFormatError) { r.error = `${e.info.app} file: only ${e.info.app} can read it. Export it as ${e.info.exportAs[0]}, then drop that file here.`; r.help = e.info.how; }
        else r.error = (e?.message || String(e)).split('\n')[0].slice(0, 220);
      }
      render();
    }
  } finally { loading = false; mark(null); }
}

async function thumb(r: Row) {
  if (!r.obj || r.thumb) return;
  let mesh = false; r.obj.traverse((o: any) => { if (o.isMesh || o.isPoints || o.isLine) mesh = true; });
  if (!mesh) return;
  try {
    const rx = r.obj.rotation.x;
    if (r.up === 'z') r.obj.rotation.x = rx - Math.PI / 2;
    try { r.thumb = snapshot(r.obj, 128); } finally { r.obj.rotation.x = rx; }
    render();
  } catch { /* thumbnails are optional */ }
}

/** A small thumbnail drawn with the viewer's own WebGL context into an offscreen target. A second context plus
 *  environment lighting was enough for iPhone Safari to run out of memory and reload the page mid-conversion. */
function snapshot(obj: THREE.Object3D, S: number): string {
  const gl = ctx.viewer.renderer;
  const parent = obj.parent;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9), new THREE.HemisphereLight(0xffffff, 0x404040, 1.4));
  scene.add(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const cam = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
  cam.position.copy(c).addScaledVector(new THREE.Vector3(1, 0.75, 1.25).normalize(), (radius / Math.sin(THREE.MathUtils.degToRad(17.5))) * 1.05);
  cam.lookAt(c);
  const light = new THREE.DirectionalLight(0xffffff, 1.6); light.position.set(0.5, 1, 1); cam.add(light); scene.add(cam);
  const rt = new THREE.WebGLRenderTarget(S, S);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevTarget = gl.getRenderTarget(), prevColor = gl.getClearColor(new THREE.Color()), prevAlpha = gl.getClearAlpha();
  const px = new Uint8Array(S * S * 4);
  try {
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, cam);
    gl.readRenderTargetPixels(rt, 0, 0, S, S, px);
  } finally {
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevColor, prevAlpha);
    scene.remove(obj);
    if (parent) parent.add(obj);
    rt.dispose();
    ctx.viewer.requestRender();
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c2 = cv.getContext('2d')!, img = c2.createImageData(S, S);
  for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4); // GL rows are bottom-up
  c2.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

// ------------------------------------------------------------------ converting
const needsUnitConfirm = (r: Row) => r.unitSrc === 'guess' && formatById(r.target).convention !== 'unitless';

/** Applies the options (scale, reduce, merge) to a copy, so the loaded model stays untouched for other targets. */
async function prepared(r: Row): Promise<THREE.Object3D> {
  const src = r.obj!;
  if (opts.reduce >= 100 && !opts.merge) return src;
  const copy = src.clone(true);
  copy.traverse((o: any) => { if (o.isMesh) o.geometry = o.geometry.clone(); });
  if (opts.reduce < 100) {
    const { SimplifyModifier } = await import('three/addons/modifiers/SimplifyModifier.js');
    const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
    const mod = new SimplifyModifier();
    copy.traverse((o: any) => {
      if (!o.isMesh) return;
      const g = mergeVertices(o.geometry.index ? o.geometry : o.geometry, 1e-6);
      const remove = Math.floor(g.attributes.position.count * (1 - opts.reduce / 100));
      if (remove > 0) { o.geometry = mod.modify(g, remove); o.geometry.computeVertexNormals(); }
    });
  }
  if (opts.merge) {
    const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
    copy.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = []; let mat: THREE.Material | null = null;
    copy.traverse((o: any) => {
      if (!o.isMesh) return;
      mat ??= Array.isArray(o.material) ? o.material[0] : o.material;
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      geos.push(g);
    });
    if (geos.length > 1) {
      const merged = mergeGeometries(geos, false);
      if (merged) { const m = new THREE.Mesh(merged, mat ?? undefined); m.name = r.name.replace(/\.[^.]+$/, ''); const g = new THREE.Group(); g.name = m.name; g.add(m); return g; }
    }
  }
  return copy;
}

async function convert(r: Row, auto = false): Promise<boolean> {
  if (!r.obj || r.status === 'converting') return false;
  const why = exportBlocker(r.obj, r.target);
  if (why) { r.status = 'failed'; r.error = why; render(); return false; }
  r.status = 'converting'; r.result = undefined; render();
  try {
    const f = formatById(r.target);
    const src = await prepared(r);
    const s = opts.scale / 100;
    const rel = new THREE.Matrix4().makeScale(s, s, s).multiply(src.matrix);
    const blob = await exportObject(src, r.target, {
      unit: r.unit, up: r.up, scope: 'all', clips: r.clips, relMatrix: rel, perTriangleColors: true,
      zUp: opts.upright && f.convention !== 'metres-y' && !staysYUp(r.target), outUnit: f.convention === 'unitless' && opts.outUnit ? opts.outUnit : undefined,
    });
    if (src !== r.obj) disposeObject(src);
    const ext = r.ext2 && exts(r.target).includes(r.ext2) ? r.ext2 : f.ext;
    r.result = { blob, name: `${safeFileName(r.name.replace(/\.[^.]+$/, ''))}.${ext}` };
    r.status = 'done';
    store.set('last.' + r.ext, r.target);
    if (remember()) store.set('history', JSON.stringify([{ name: r.name, from: r.ext, to: ext, size: blob.size, at: Date.now() }, ...history()].slice(0, 20)));
    if (auto && instant) { download(blob, r.result.name); ctx.toast(`${t('Downloaded')} ${r.result.name} · ${fmtBytes(blob.size)}`); }
    return true;
  } catch (e: any) {
    r.status = 'failed'; r.error = (e?.message || String(e)).slice(0, 220); return false;
  } finally { render(); }
}

async function convertAll() {
  for (const r of rows) if (r.status === 'ready' || (r.status === 'failed' && r.obj)) await convert(r);
}

async function downloadAll() {
  await convertAll();
  const done = rows.filter((r) => r.result);
  if (!done.length) return;
  if (done.length === 1) { download(done[0].result!.blob, done[0].result!.name); return; }
  const files: Record<string, Uint8Array> = {};
  for (const r of done) {
    let n = r.result!.name; while (files[n]) n = n.replace(/(\.[^.]+)$/, '-copy$1');
    files[n] = new Uint8Array(await r.result!.blob.arrayBuffer());
  }
  download(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), 'converted-models.zip');
}

async function share(r: Row) {
  if (!r.result) return;
  const file = new File([r.result.blob], r.result.name, { type: r.result.blob.type || 'application/octet-stream' });
  try { await (navigator as any).share({ files: [file], title: r.result.name }); } catch { /* cancelled */ }
}
const canShareFiles = () => { try { return !!(navigator as any).canShare?.({ files: [new File(['x'], 'x.stl')] }); } catch { return false; } };

function removeRow(r: Row) {
  if (r.obj) disposeObject(r.obj);
  if (r.thumb) URL.revokeObjectURL(r.thumb);
  rows = rows.filter((x) => x !== r);
  render();
}

// ------------------------------------------------------------------ UI
const dimsText = (r: Row) => {
  if (!r.dims) return '';
  const n = (v: number) => (v >= 100 ? Math.round(v) : +v.toPrecision(3));
  return `${n(r.dims.x)} × ${n(r.dims.y)} × ${n(r.dims.z)} ${UNIT_LABEL[r.unit]}`;
};

function rowHtml(r: Row) {
  const f = formatById(r.target);
  const est = r.status === 'ready' ? estimate(r, r.target) : null;
  const rep = r.obj && r.status !== 'loading' ? describeExport(r.obj, r.target, { unit: r.unit, up: r.up, scope: 'all', clips: r.clips }) : null;
  const blocked = r.obj ? exportBlocker(r.obj, r.target) : null;
  const unitSel = r.status !== 'loading' && r.status !== 'failed' && r.obj
    ? `<label class="qc-units ${needsUnitConfirm(r) ? 'warn' : ''}" title="${t('Units of the original file')}"><select data-unit="${r.id}" aria-label="${t('File units')}">${['mm', 'cm', 'm', 'in', 'ft'].map((u) => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select><span>${r.unitSrc === 'declared' ? t('from the file') : r.unitSrc === 'user' ? t('set by you') : t('guessed')}</span></label>` : '';
  const status = r.status === 'loading' ? `<span class="qc-status">${t('Reading…')}</span>`
    : r.status === 'converting' ? `<span class="qc-status">${t('Converting…')}</span>`
    : r.status === 'failed' ? `<span class="qc-status bad">${escHtml(r.error || 'Failed')}</span>`
    : r.status === 'done' ? `<span class="qc-status ok">${icon('check')}${fmtBytes(r.result!.blob.size)}</span>`
    : blocked ? `<span class="qc-status bad">${escHtml(blocked)}</span>`
    : `<span class="qc-status">${est ? `≈ ${fmtBytes(est)}` : ''}${rep?.lost.length ? ` · ${t('loses')} ${escHtml(rep.lost.join(', '))}` : ''}</span>`;
  const extChoice = exts(r.target).length > 1 ? `<select class="qc-ext" data-ext="${r.id}" aria-label="${t('File extension')}">${exts(r.target).map((e) => `<option ${(r.ext2 || f.ext) === e ? 'selected' : ''}>${e}</option>`).join('')}</select>` : '';
  return `<li class="qc-row is-${r.status}" data-row="${r.id}">
    <label class="qc-pick" title="${t('Select for Compare')}"><input type="checkbox" data-pickrow="${r.id}" ${r.picked ? 'checked' : ''} ${r.obj ? '' : 'disabled'} aria-label="${t('Select')} ${escHtml(r.name)}"/></label>
    <div class="qc-thumb">${r.thumb ? `<img src="${r.thumb}" alt=""/>` : `<span>${escHtml(r.ext.toUpperCase().slice(0, 5))}</span>`}</div>
    <div class="qc-info">
      <b title="${escHtml(r.name)}">${escHtml(r.name)}</b>
      <small>${escHtml(r.ext.toUpperCase())} · ${fmtBytes(r.size)}${r.tris ? ` · ${r.tris.toLocaleString()} ${t('triangles')}` : ''}${r.dims ? ` · ${dimsText(r)}` : ''}</small>
      ${unitSel}
      ${status}
      ${r.help ? `<small class="qc-help">${escHtml(r.help)}</small>` : ''}
    </div>
    <div class="qc-to">
      <span class="qc-arrow" aria-hidden="true">→</span>
      <button class="qc-target" data-target="${r.id}" ${r.obj ? '' : 'disabled'} aria-haspopup="listbox">${escHtml(f.label)}<i>${icon('chev')}</i></button>${extChoice}
    </div>
    <div class="qc-actions">
      ${r.status === 'done' ? `<button class="btn-solid small" data-dl="${r.id}">${icon('download')} ${t('Download')}</button>${canShareFiles() ? `<button class="btn-outline small" data-share="${r.id}">${icon('share')}</button>` : ''}`
        : `<button class="btn-solid small" data-convert="${r.id}" ${r.obj && !blocked && r.status !== 'converting' ? '' : 'disabled'}>${needsUnitConfirm(r) && instant ? t('Confirm & download') : t('Convert')}</button>`}
      <button class="btn-outline small" data-qcview="${r.id}" ${r.obj ? '' : 'disabled'}>${icon('cube')} ${t('Open 3D view')}</button>
      <button class="qc-x" data-remove="${r.id}" aria-label="${t('Remove')} ${escHtml(r.name)}">${icon('x')}</button>
    </div>
  </li>`;
}

function render() {
  if (!host) return;
  const ready = rows.filter((r) => r.obj).length, done = rows.filter((r) => r.result).length;
  const picked = rows.filter((r) => r.picked && r.obj);
  const hist = history();
  host.innerHTML = rows.length ? `
    <div class="qc-bar">
      <div class="qc-all">
        <span>${t('Convert all to')}</span>
        <button class="qc-target" data-target="all">${allTarget ? escHtml(formatById(allTarget).label) : t('Choose…')}<i>${icon('chev')}</i></button>
        <button class="qc-gear ${optsChanged() ? 'on' : ''}" data-qcopts aria-expanded="${!!document.querySelector('.qc-opts:not(.hidden)')}" aria-label="${t('Options')}">${icon('tools')}<span>${t('Options')}</span></button>
      </div>
      <div class="qc-presets" role="group" aria-label="${t('Where is it going?')}">${PRESETS.map((p, i) => `<button class="qc-preset" data-preset="${i}"><b>${p.label}</b><small>${p.sub}</small></button>`).join('')}</div>
      <div class="qc-opts ${optsOpen ? '' : 'hidden'}">
        <label class="check"><input type="checkbox" data-opt="upright" ${opts.upright ? 'checked' : ''}/> ${t('Stand upright for printing and CAD (Z-up)')}</label>
        <label>${t('Numbers in unitless files')} <select data-opt="outUnit"><option value="">${t('Automatic (STL: mm)')}</option>${['mm', 'cm', 'm', 'in'].map((u) => `<option value="${u}" ${opts.outUnit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>${t('Scale')} <input type="number" min="1" max="100000" step="1" value="${opts.scale}" data-opt="scale"/> %</label>
        <label>${t('Keep polygons')} <input type="range" min="5" max="100" step="5" value="${opts.reduce}" data-opt="reduce"/> <output>${opts.reduce}%</output></label>
        <label class="check"><input type="checkbox" data-opt="merge" ${opts.merge ? 'checked' : ''}/> ${t('Merge all parts into one')}</label>
      </div>
    </div>
    <ul class="qc-list" role="list">${rows.map(rowHtml).join('')}</ul>
    <div class="qc-foot">
      ${picked.length === 2 ? `<button class="btn-outline" data-compare>${icon('compare')} ${t('Compare these two')}</button>` : `<span class="muted qc-hint">${t('Tick two files to compare them.')}</span>`}
      <span class="grow"></span>
      <button class="btn-outline" data-convertall ${ready ? '' : 'disabled'}>${t('Convert all')}</button>
      <button class="btn-solid" data-dlall ${ready ? '' : 'disabled'}>${icon('download')} ${done > 1 || ready > 1 ? t('Download all (ZIP)') : t('Download')}</button>
    </div>` : '';
  if (crashNote) host.insertAdjacentHTML('afterbegin', `<p class="qc-crash" role="alert">${escHtml(crashNote)}</p>`);
  host.innerHTML += `<div class="qc-history">
      ${hist.length ? `<details><summary>${t('Recent conversions on this device')} (${hist.length})</summary><ul>${hist.map((h) => `<li><b>${escHtml(h.name)}</b> <span class="muted">${escHtml(h.from.toUpperCase())} → ${escHtml(h.to.toUpperCase())} · ${fmtBytes(h.size)} · ${new Date(h.at).toLocaleDateString()}</span></li>`).join('')}</ul><button class="link-btn" data-clearhist>${t('Clear')}</button></details>` : ''}
      <label class="check small"><input type="checkbox" data-remember ${remember() ? 'checked' : ''}/> ${t('Remember conversions (names and formats only, never the files)')}</label>
    </div>`;
  if (picker) positionPicker();
}
let optsOpen = false;
const optsChanged = () => !opts.upright || !!opts.outUnit || opts.scale !== 100 || opts.reduce !== 100 || opts.merge;

function setTarget(r: Row, id: ExportId) { r.target = id; r.ext2 = undefined; r.result = undefined; if (r.status === 'done' || (r.status === 'failed' && r.obj)) r.status = 'ready'; }
const invalidate = () => rows.forEach((r) => { if (r.result || (r.status === 'failed' && r.obj)) { r.result = undefined; r.status = 'ready'; } });

// One shared, searchable format picker (popover).
function openPicker(anchor: HTMLElement, current: ExportId, onPick: (id: ExportId) => void, rowObj?: THREE.Object3D) {
  closePicker();
  picker = { anchor, onPick, current };
  const el = document.createElement('div');
  el.className = 'qc-picker';
  el.setAttribute('role', 'dialog');
  const groups: Record<string, string> = { print: '3D printing', web: 'Web, AR & games', apps: '3D apps', cad: 'CAD & drawings', data: 'Scans, points & research' };
  el.innerHTML = `<input type="search" placeholder="${t('Search formats or apps…')}" aria-label="${t('Search formats')}"/>
    <ul role="listbox">${Object.entries(groups).map(([g, label]) => `<li class="qc-pg">${t(label)}</li>` + EXPORT_FORMATS.filter((f) => f.group === g).map((f: any) => { const why = rowObj ? exportBlocker(rowObj, f.id) : null; return `<li role="option" tabindex="-1" data-pid="${f.id}" class="${f.id === current ? 'cur' : ''} ${why ? 'off' : ''}" data-s="${escHtml(`${f.label} ${[f.ext, ...(f.alias ?? [])].join(' ')} ${f.tags}`.toLowerCase())}" ${why ? `title="${escHtml(why)}"` : ''}><b>${escHtml(f.label)}</b><small>.${[f.ext, ...(f.alias ?? [])].join(' .')}</small></li>`; }).join('')).join('')}</ul>`;
  document.body.appendChild(el);
  positionPicker();
  const input = el.querySelector('input')!;
  input.oninput = () => {
    const w = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    el.querySelectorAll<HTMLElement>('[data-pid]').forEach((li) => li.classList.toggle('hidden', !w.every((x) => li.dataset.s!.includes(x))));
    el.querySelectorAll<HTMLElement>('.qc-pg').forEach((h) => { let n = h.nextElementSibling as HTMLElement | null, any = false; while (n && !n.classList.contains('qc-pg')) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling as HTMLElement | null; } h.classList.toggle('hidden', !any); });
  };
  input.onkeydown = (e) => {
    const first = [...el.querySelectorAll<HTMLElement>('[data-pid]')].find((li) => !li.classList.contains('hidden') && !li.classList.contains('off'));
    if (e.key === 'Enter' && first) { e.preventDefault(); choose(first.dataset.pid as ExportId); }
    if (e.key === 'Escape') { closePicker(); anchor.focus(); }
  };
  el.onclick = (e) => { const li = (e.target as HTMLElement).closest<HTMLElement>('[data-pid]'); if (li && !li.classList.contains('off')) choose(li.dataset.pid as ExportId); };
  setTimeout(() => input.focus(), 30);
  function choose(id: ExportId) { const cb = picker?.onPick; closePicker(); cb?.(id); render(); }
}
function positionPicker() {
  const el = document.querySelector<HTMLElement>('.qc-picker');
  if (!el || !picker) return;
  const a = document.querySelector<HTMLElement>(`[data-target="${picker.anchor.dataset.target}"]`) || picker.anchor;
  const r = a.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  el.style.width = w + 'px';
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  const below = window.innerHeight - r.bottom;
  if (below > 300 || below > r.top) { el.style.top = r.bottom + 6 + 'px'; el.style.bottom = ''; el.style.maxHeight = Math.max(200, below - 16) + 'px'; }
  else { el.style.bottom = window.innerHeight - r.top + 6 + 'px'; el.style.top = ''; el.style.maxHeight = Math.max(200, r.top - 16) + 'px'; }
}
function closePicker() { document.querySelector('.qc-picker')?.remove(); picker = null; }

function onClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  const id = (k: string) => Number(el.closest<HTMLElement>(`[data-${k}]`)?.dataset[k]);
  const row = (k: string) => rows.find((r) => r.id === id(k));
  const tgt = el.closest<HTMLElement>('[data-target]');
  if (tgt) {
    if (tgt.dataset.target === 'all') openPicker(tgt, allTarget ?? 'glb', (to) => { allTarget = to; rows.forEach((r) => { if (r.obj && !exportBlocker(r.obj, to)) setTarget(r, to); }); });
    else { const r = rows.find((x) => x.id === Number(tgt.dataset.target)); if (r) openPicker(tgt, r.target, (to) => setTarget(r, to), r.obj); }
    return;
  }
  if (el.closest('[data-qcopts]')) { optsOpen = !optsOpen; render(); return; }
  const preset = el.closest<HTMLElement>('[data-preset]');
  if (preset) {
    const p = PRESETS[Number(preset.dataset.preset)];
    allTarget = p.to; if (p.upright !== undefined) opts.upright = p.upright;
    rows.forEach((r) => { if (r.obj && !exportBlocker(r.obj, p.to)) setTarget(r, p.to); });
    render(); return;
  }
  if (el.closest('[data-convert]')) { const r = row('convert'); if (r) { if (r.unitSrc === 'guess') r.unitSrc = 'user'; void convert(r, !!instant); } return; }
  if (el.closest('[data-dl]')) { const r = row('dl'); if (r?.result) download(r.result.blob, r.result.name); return; }
  if (el.closest('[data-share]')) { const r = row('share'); if (r) void share(r); return; }
  if (el.closest('[data-remove]')) { const r = row('remove'); if (r) removeRow(r); return; }
  if (el.closest("[data-qcview]")) { const r = row("qcview"); if (r) { closeQuickConvert(); void ctx.openFiles(r.files); } return; }
  if (el.closest('[data-convertall]')) { void convertAll(); return; }
  if (el.closest('[data-dlall]')) { void downloadAll(); return; }
  if (el.closest('[data-compare]')) {
    const [a, b] = rows.filter((r) => r.picked && r.obj);
    closeQuickConvert();
    void ctx.openFiles(a.files).then(() => setTimeout(() => void compareWith(b.files), 300));
    return;
  }
  if (el.closest('[data-clearhist]')) { store.set('history', '[]'); render(); }
}
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.dataset.unit) { const r = rows.find((x) => x.id === Number(el.dataset.unit)); if (r) { r.unit = el.value as UnitId; r.unitSrc = 'user'; r.result = undefined; if (r.status === 'done') r.status = 'ready'; render(); } return; }
  if (el.dataset.ext) { const r = rows.find((x) => x.id === Number(el.dataset.ext)); if (r) { r.ext2 = el.value; if (r.result) r.result.name = r.result.name.replace(/\.[^.]+$/, '.' + el.value); render(); } return; }
  if (el.dataset.pickrow) { const r = rows.find((x) => x.id === Number(el.dataset.pickrow)); if (r) { r.picked = el.checked; render(); } return; }
  if ('remember' in el.dataset) { store.set('remember', el.checked ? '1' : '0'); if (!el.checked) store.set('history', '[]'); render(); return; }
  const o = el.dataset.opt as keyof Options | undefined;
  if (!o) return;
  if (o === 'upright' || o === 'merge') (opts as any)[o] = el.checked;
  else if (o === 'outUnit') opts.outUnit = el.value as Options['outUnit'];
  else (opts as any)[o] = Math.max(1, Number(el.value) || 100);
  invalidate(); render();
}

// ------------------------------------------------------------------ open / close
export const qcIsOpen = () => document.body.classList.contains('qc-open');

export function openQuickConvert(o: { to?: ExportId; instant?: boolean } = {}) {
  if (o.to) { instant = o.instant ? { to: o.to } : null; allTarget = o.to; }
  document.body.classList.add('qc-open');
  if (!host) {
    host = document.getElementById('qcHost');
    host?.addEventListener('click', onClick);
    host?.addEventListener('change', onChange);
    host?.addEventListener('input', (e) => { const el = e.target as HTMLInputElement; if (el.dataset.opt === 'reduce') { const out = el.parentElement?.querySelector('output'); if (out) out.textContent = el.value + '%'; } });
  }
  const dz = document.getElementById('dzTitle');
  if (dz && !o.to) dz.textContent = t('Drop files to convert');
  render();
}
export function closeQuickConvert() {
  document.body.classList.remove('qc-open');
  closePicker();
}

document.addEventListener('click', (e) => {
  if (picker && !(e.target as HTMLElement).closest('.qc-picker') && !(e.target as HTMLElement).closest('[data-target]')) closePicker();
}, true);
window.addEventListener('resize', () => positionPicker());
document.addEventListener('scroll', () => positionPicker(), true);

/** Files shared to the installed app (Android share sheet → service worker → cache): add them on load. */
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  try {
    const c = await caches.open('omni-share');
    const keys = await c.keys();
    const files: File[] = [];
    for (const k of keys) { const res = await c.match(k); if (res) files.push(new File([await res.blob()], decodeURIComponent(k.url.split('/').pop() || 'model'))); await c.delete(k); }
    if (files.length) qcAdd(files);
    history_replace();
  } catch { /* nothing shared */ }
}
const history_replace = () => { try { window.history.replaceState(null, '', location.pathname); } catch { /* ignore */ } };

export function initQuickConvert() {
  registerCommand({ id: 'quickconvert', label: 'Quick convert files (no viewer)…', group: 'File', keywords: 'convert export batch fast simple without preview', run: () => { openQuickConvert(); document.getElementById('fileInput')?.click(); } });
  void takeSharedFiles();
  let was: string | null = null;
  try { was = sessionStorage.getItem(READING); } catch { /* storage blocked */ }
  if (was) {
    mark(null);
    crashNote = t('The page reloaded while reading “{name}”: this device ran out of memory. Try again, or use a computer for very large files.').replace('{name}', was);
    if (!qcIsOpen()) openQuickConvert(); else render();
  }
}

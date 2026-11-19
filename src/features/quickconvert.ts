import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { ctx, escHtml } from '../context';
import { registerCommand } from '../registry';
import { loadFiles, MODEL_EXTS, extOf, pathOf } from '../loaders';
import { EXPORT_FORMATS, exportObject, describeExport, exportBlocker, staysYUp, formatById, download, safeFileName, outputUnit, UNIT_METRES, type ExportId, type UnitId } from '../exporters';
import { ProprietaryFormatError, PROPRIETARY } from '../formats-extra';
import { guessUnit, defaultUp } from '../units';
import { disposeObject } from '../viewer';
import { compareWith } from './compare';
import { mountPreview, showPreview, pausePreview } from './qcpreview';
import { icon } from '../icons';
import { groupFiles as groupFilesBy, needsUnitConfirm } from './qclogic';
import { t } from '../i18n';

// ---------------------------------------------------------------------------------------------
// Quick Convert: drop files, pick a target, download. Models load headlessly (the same engine as batch convert),
// get a thumbnail and a light preview, and convert on demand. The full viewer and editor is one click away and
// receives the unit the person chose here.
//
// Promises this module keeps (audit 2026-11-18):
//  - one unit gate for every path (row button, Convert all, Download all): an estimated unit is confirmed first (F02)
//  - the unit chosen here travels to the editor and to Compare (F01, F33)
//  - a named target is never swapped silently; the person picks the alternative (F14)
//  - downloads say what they contain, failures included, before saving (F06), with a receipt in every ZIP (N01)
//  - a result is labelled from the settings it was made with; stale results are discarded (F16)
// ---------------------------------------------------------------------------------------------

type UnitSrc = 'declared' | 'format' | 'saved' | 'guess' | 'user';
interface Row {
  id: number; files: File[]; name: string; ext: string; size: number;
  status: 'loading' | 'ready' | 'converting' | 'done' | 'failed';
  error?: string; help?: string;
  obj?: THREE.Object3D; clips: THREE.AnimationClip[]; tris: number; verts: number; dims?: THREE.Vector3;
  unit: UnitId; unitSrc: UnitSrc; up: 'y' | 'z';
  target: ExportId; ext2?: string; result?: { blob: Blob; name: string; key: string }; thumb?: string; picked: boolean;
  /** a target the page asked for but this model cannot be saved as, and the format we suggest instead */
  alt?: ExportId;
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
const UNITS: UnitId[] = ['mm', 'cm', 'm', 'in', 'ft'];

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
let picker: { anchor: HTMLElement; anchorKey: string; onPick: (id: ExportId) => void; current: ExportId } | null = null;
/** a one-line message in the bar ("Applied to 2 of 3 …", "Add the model that uses this texture") */
let notice: { text: string; addModel?: boolean } | null = null;
/** the action waiting for the unit confirmation bar (F02) */
let gate: 'convertall' | 'dlall' | null = null;
/** named pair pages hide the destination presets until asked (F24) */
let showPresets = false;

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const exts = (id: ExportId) => { const f: any = formatById(id); return [f.ext, ...(f.alias ?? [])] as string[]; };
const num = (v: number) => (v >= 100 ? String(Math.round(v)) : String(+v.toPrecision(3)));

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
/** The first format this model can be saved as, for a blocked request. */
const fallbackTarget = (r: Row): ExportId => (['glb', 'stl', 'ply', 'xyz'] as ExportId[]).find((id) => !exportBlocker(r.obj!, id) && !exts(id).includes(r.ext)) ?? 'glb';

// ------------------------------------------------------------------ loading
const isCompanion = (f: File) => !MODEL_EXTS.has(extOf(f.name)) && !PROPRIETARY[extOf(f.name)] && /\.(mtl|bin|png|jpe?g|webp|bmp|tga|gif|ktx2|dds|tiff?)$/i.test(f.name);
const groupFiles = (files: File[]) => groupFilesBy(files, pathOf, isCompanion);

export function qcAdd(files: File[]) {
  if (!files.length) return;
  crashNote = '';
  openQuickConvert();
  const groups = groupFiles(files);
  if (!groups.length) {
    // Only textures or material files: explain instead of doing nothing (F12).
    notice = { text: t('These are textures or material files. Add the OBJ, glTF or other model that uses them, together with them.'), addModel: true };
    render();
    return;
  }
  notice = null;
  for (const group of groups) {
    const f = group[0];
    rows.push({ id: nextId++, files: group, name: f.name, ext: extOf(f.name), size: group.reduce((n, x) => n + x.size, 0), status: 'loading', clips: [], tris: 0, verts: 0, unit: 'mm', unitSrc: 'guess', up: 'y', target: 'glb', picked: false });
  }
  render();
  // Bring the first new file into view: on a phone the list sits below the drop zone.
  const first = rows[rows.length - groups.length];
  if (first) { focusId = first.id; previewId = first.id; reveal(first.id); }
  void loadPending();
}

// If the browser kills the tab while a file is being read (a phone running out of memory reloads the page),
// reopen Quick Convert after the reload and say what happened instead of silently dropping back to the home screen.
const READING = 'qc.reading';
let crashNote = '';
function mark(name: string | null) { try { name ? sessionStorage.setItem(READING, name) : sessionStorage.removeItem(READING); } catch { /* storage blocked */ } }

let focusId = 0;
let previewId = 0; // the row shown in the 3D preview
// Scrolls the container rather than the row: re-rendering the list (a thumbnail arriving) would cancel a smooth
// scrollIntoView on the old row element.
const reveal = (id: number) => setTimeout(() => {
  const el = host?.querySelector<HTMLElement>(`[data-row="${id}"]`);
  const box = el?.closest<HTMLElement>('.welcome');
  if (!el || !box || box.scrollHeight <= box.clientHeight) { el?.scrollIntoView({ block: 'nearest' }); return; }
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top >= b.top && r.bottom <= b.bottom) return;
  box.scrollTo({ top: box.scrollTop + r.top - b.top - Math.max(16, (b.height - r.height) / 4), behavior: 'smooth' });
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
        r.unit = g.unit as UnitId;
        r.unitSrc = g.source === 'declared' ? 'declared' : g.source === 'saved' ? 'saved' : g.source === 'user' ? 'user' : g.source === 'guess' ? 'guess' : 'format';
        if (g.suggest) r.help = t(g.suggest.why);
        r.up = defaultUp(r.ext);
        r.target = defaultTarget(r);
        if (exportBlocker(r.obj, r.target)) {
          // A target the page or the person asked for stays visible with the reason and a one-tap alternative (F14).
          if (instant || allTarget) r.alt = fallbackTarget(r);
          else r.target = fallbackTarget(r);
        }
        r.status = 'ready';
        if (res.warnings.length) r.help = [r.help, ...res.warnings.slice(0, 2)].filter(Boolean).join(' ');
        render();
        if (r.id === focusId) { focusId = 0; reveal(r.id); } // it grew when it loaded
        void thumb(r);
        if (instant && !needsUnitConfirm(r) && !exportBlocker(r.obj, r.target)) await convert(r, true);
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
    r.thumb = withUpright(r, () => snapshot(r.obj!, 128));
    render();
  } catch { /* thumbnails are optional */ }
}
function withUpright<T>(r: Row, fn: () => T): T {
  const rx = r.obj!.rotation.x;
  if (r.up === 'z') r.obj!.rotation.x = rx - Math.PI / 2;
  // Restore the matrix too: the export reads obj.matrix, and a stale rotated matrix turned Z-up files upside down.
  try { return fn(); } finally { r.obj!.rotation.x = rx; r.obj!.updateMatrix(); r.obj!.updateMatrixWorld(true); }
}
/** A larger still for the phone preview, drawn with the viewer's context (no second WebGL context, F28). */
const still = (r: Row): string | undefined => { try { return r.obj ? withUpright(r, () => snapshot(r.obj!, 512)) : undefined; } catch { return undefined; } };

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

/** The settings a result was made with. A result whose key no longer matches is stale (F16). */
const jobKey = (r: Row) => JSON.stringify([r.target, r.unit, r.up, opts]);

/** Applies the options (scale, reduce, merge) to a copy, so the loaded model stays untouched for other targets. */
async function prepared(r: Row, o: Options): Promise<THREE.Object3D> {
  const src = r.obj!;
  if (o.reduce >= 100 && !o.merge) return src;
  const copy = src.clone(true);
  copy.traverse((x: any) => { if (x.isMesh) x.geometry = x.geometry.clone(); });
  if (o.reduce < 100) {
    const { SimplifyModifier } = await import('three/addons/modifiers/SimplifyModifier.js');
    const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
    const mod = new SimplifyModifier();
    copy.traverse((x: any) => {
      if (!x.isMesh) return;
      const g = mergeVertices(x.geometry, 1e-6);
      const remove = Math.floor(g.attributes.position.count * (1 - o.reduce / 100));
      if (remove > 0) { x.geometry = mod.modify(g, remove); x.geometry.computeVertexNormals(); }
    });
  }
  if (o.merge) {
    const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
    copy.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = []; let mat: THREE.Material | null = null;
    copy.traverse((x: any) => {
      if (!x.isMesh) return;
      mat ??= Array.isArray(x.material) ? x.material[0] : x.material;
      const g = (x.geometry.index ? x.geometry.toNonIndexed() : x.geometry.clone()).applyMatrix4(x.matrixWorld);
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

/** Export options for a row, shared by the conversion and the "size in file" preview so both agree (F19). */
function exportOpts(r: Row, o: Options, src: THREE.Object3D) {
  const f = formatById(r.target);
  const s = o.scale / 100;
  return {
    unit: r.unit, up: r.up, scope: 'all' as const, clips: r.clips, relMatrix: new THREE.Matrix4().makeScale(s, s, s).multiply(src.matrix), perTriangleColors: true,
    zUp: o.upright && f.convention !== 'metres-y' && !staysYUp(r.target), outUnit: f.convention === 'unitless' && o.outUnit ? o.outUnit : undefined,
  };
}

async function convert(r: Row, auto = false): Promise<boolean> {
  if (!r.obj || r.status === 'converting') return false;
  const why = exportBlocker(r.obj, r.target);
  if (why) { render(); return false; }
  // Snapshot what this job is for: a change made while it runs makes the result stale.
  const key = jobKey(r), target = r.target, o = { ...opts };
  r.status = 'converting'; r.result = undefined; render();
  try {
    const f = formatById(target);
    const src = await prepared(r, o);
    const blob = await exportObject(src, target, exportOpts({ ...r, target }, o, src));
    if (src !== r.obj) disposeObject(src);
    if (jobKey(r) !== key) { r.status = 'ready'; return false; } // settings changed meanwhile: discard
    const ext = r.ext2 && exts(target).includes(r.ext2) ? r.ext2 : f.ext;
    r.result = { blob, name: `${safeFileName(r.name.replace(/\.[^.]+$/, ''))}.${ext}`, key };
    r.status = 'done';
    store.set('last.' + r.ext, target);
    if (remember()) store.set('history', JSON.stringify([{ name: r.name, from: r.ext, to: ext, size: blob.size, at: Date.now() }, ...history()].slice(0, 20)));
    if (auto && instant) { download(blob, r.result.name); lastSaved = `${t('Downloaded')} ${r.result.name} · ${fmtBytes(blob.size)}`; }
    return true;
  } catch (e: any) {
    r.status = 'failed'; r.error = (e?.message || String(e)).slice(0, 220); return false;
  } finally { render(); }
}

/** Rows a bulk action includes: readable, not blocked. */
const convertible = () => rows.filter((r) => r.obj && !exportBlocker(r.obj, r.target));
const unresolved = () => convertible().filter(needsUnitConfirm);

async function convertAll() {
  if (unresolved().length) { gate = 'convertall'; render(); focusGate(); return; }
  for (const r of convertible()) if (r.status !== 'converting' && (!r.result || r.result.key !== jobKey(r))) await convert(r);
}

let lastSaved = '';
let bulkBusy = false;
async function downloadAll() {
  if (unresolved().length) { gate = 'dlall'; render(); focusGate(); return; }
  // Busy guard: the button stays enabled (and focused) while this runs; a second press waits for nothing.
  if (bulkBusy) return;
  bulkBusy = true;
  try { for (const r of convertible()) if (r.status !== 'converting' && (!r.result || r.result.key !== jobKey(r))) await convert(r); } finally { bulkBusy = false; }
  const done = rows.filter((r) => r.result);
  const failed = rows.filter((r) => !r.result);
  if (!done.length) { lastSaved = t('Nothing to download yet: every file failed.'); render(); return; }
  if (done.length === 1 && !failed.length) {
    download(done[0].result!.blob, done[0].result!.name);
  } else {
    const files: Record<string, Uint8Array> = {};
    for (const r of done) {
      let n = r.result!.name; while (files[n]) n = n.replace(/(\.[^.]+)$/, '-copy$1');
      files[n] = new Uint8Array(await r.result!.blob.arrayBuffer());
    }
    files['receipt.txt'] = strToU8(receipt());
    download(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), 'converted-models.zip');
  }
  lastSaved = failed.length
    ? t('Saved {n} file(s). Not included: {list}.', { n: done.length, list: failed.map((r) => r.name).join(', ') })
    : t('Saved {n} file(s).', { n: done.length });
  render();
}

/** A plain-text record of a conversion: inputs, units and where they came from, targets, results, losses (N01). */
export function receipt(list: Row[] = rows): string {
  const lines = [
    'OMNIVIEWER conversion receipt',
    `Date: ${new Date().toISOString()}`,
    `Options: scale ${opts.scale}% · keep ${opts.reduce}% of polygons · ${opts.merge ? 'parts merged' : 'parts kept'} · ${opts.upright ? 'Z-up for print/CAD' : 'axes as in file'}${opts.outUnit ? ` · unitless files in ${opts.outUnit}` : ''}`,
    'Converted on this device. Nothing was uploaded.',
    '',
  ];
  for (const r of list) {
    lines.push(`- ${r.name} (${r.ext.toUpperCase()}, ${fmtBytes(r.size)})`);
    if (r.dims) lines.push(`  source size: ${num(r.dims.x)} x ${num(r.dims.y)} x ${num(r.dims.z)} ${r.unit} (unit ${SRC_TEXT[r.unitSrc]})`);
    if (r.result) {
      const rep = r.obj ? describeExport(r.obj, r.target, exportOpts(r, opts, r.obj)) : null;
      lines.push(`  -> ${r.result.name} (${formatById(r.target).label}, ${fmtBytes(r.result.blob.size)})`);
      if (rep?.sizeUnit) lines.push(`  size in file: ${num(rep.size.x)} x ${num(rep.size.y)} x ${num(rep.size.z)} ${rep.sizeUnit}`);
      if (rep?.lost.length) lines.push(`  not kept: ${rep.lost.join(', ')}`);
    } else lines.push(`  NOT CONVERTED: ${r.error || (r.obj && exportBlocker(r.obj, r.target)) || 'not converted'}`);
  }
  return lines.join('\n') + '\n';
}

async function share(r: Row) {
  if (!r.result) return;
  const file = new File([r.result.blob], r.result.name, { type: r.result.blob.type || 'application/octet-stream' });
  try { await (navigator as any).share({ files: [file], title: r.result.name }); } catch { /* cancelled: the result stays available */ }
}
const canShareFiles = () => { try { return !!(navigator as any).canShare?.({ files: [new File(['x'], 'x.stl')] }); } catch { return false; } };

function removeRow(r: Row) {
  if (r.obj) disposeObject(r.obj);
  if (r.thumb) URL.revokeObjectURL(r.thumb);
  const i = rows.indexOf(r);
  rows = rows.filter((x) => x !== r);
  if (previewId === r.id) previewId = (rows.find((x) => x.obj) ?? rows[0])?.id ?? 0;
  if (!unresolved().length) gate = null;
  // Keep keyboard users in the list: focus the next row, or the drop zone when the list is empty (F09).
  const next = rows[i] ?? rows[i - 1];
  restoreFocus = next ? `[data-remove="${next.id}"]` : '#dropZone';
  render();
}

// ------------------------------------------------------------------ UI
const dimsText = (r: Row) => (r.dims ? `${num(r.dims.x)} × ${num(r.dims.y)} × ${num(r.dims.z)} ${UNIT_LABEL[r.unit]}` : '');
const SRC_TEXT: Record<UnitSrc, string> = { declared: 'from the file', format: 'usual for this file type', saved: 'your saved default', guess: 'estimated from the size', user: 'set by you' };
const srcLabel = (r: Row) => (r.unitSrc === 'format' ? t('usual for .{ext} files', { ext: r.ext }) : t(SRC_TEXT[r.unitSrc]));

/** The primary action's words say what happens next (F17). */
function actionLabel(r: Row): string {
  if (needsUnitConfirm(r)) return instant ? t('Confirm {u} & download', { u: r.unit }) : t('Confirm {u} & convert', { u: r.unit });
  return instant ? t('Download') : t('Convert');
}

/** Real size of the output, only when it differs from the source (scale option): the source size is shown once. */
function resizedText(r: Row, rep: { size: THREE.Vector3; sizeUnit: UnitId | null } | null): string {
  if (!rep?.sizeUnit || !r.dims || r.unit === 'u' || rep.sizeUnit === 'u' || rep.size.lengthSq() === 0) return '';
  const k = UNIT_METRES[rep.sizeUnit] / UNIT_METRES[r.unit]; // output numbers → source unit
  const out = [rep.size.x, rep.size.y, rep.size.z].map((v) => v * k).sort((a, b) => a - b);
  const src = [r.dims.x, r.dims.y, r.dims.z].sort((a, b) => a - b);
  if (out.every((v, i) => Math.abs(v - src[i]) <= Math.max(1e-6, src[i] * 0.005))) return '';
  const [x, y, z] = [rep.size.x, rep.size.y, rep.size.z].map((v) => v * k);
  return `${num(x)} × ${num(y)} × ${num(z)} ${UNIT_LABEL[r.unit]}`;
}

/** One file, read left to right like any converter: what you have → what you get, then the action (F10). */
function rowHtml(r: Row) {
  const f = formatById(r.target);
  const est = r.status === 'ready' ? estimate(r, r.target) : null;
  const blocked = r.obj ? exportBlocker(r.obj, r.target) : null;
  const rep = r.obj && r.status !== 'loading' && !blocked ? describeExport(r.obj, r.target, exportOpts(r, opts, r.obj)) : null;
  const unitSel = r.status !== 'loading' && r.obj
    ? `<label class="qc-units ${needsUnitConfirm(r) ? 'warn' : ''}"><select data-unit="${r.id}" aria-label="${t('Units of the original file')}">${UNITS.map((u) => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select><span>${escHtml(srcLabel(r))}</span></label>` : '';
  const resized = r.status !== 'failed' ? resizedText(r, rep) : '';
  // Source side: the file as it is.
  const srcState = r.status === 'loading' ? `<span class="qc-status">${t('Reading…')}</span>`
    : r.status === 'failed' && !r.obj ? `<span class="qc-status bad">${escHtml(r.error || 'Failed')}</span>` : '';
  // Output side: the file you will get.
  const dstState = r.status === 'converting' ? `<span class="qc-status">${t('Converting…')}</span>`
    : r.status === 'failed' ? `<span class="qc-status bad">${escHtml(r.error || 'Failed')}</span>`
    : r.status === 'done' ? `<span class="qc-status ok">${icon('check')}${escHtml(r.result!.name)} · ${fmtBytes(r.result!.blob.size)}</span>`
    : blocked ? `<span class="qc-status bad">${t("Can't save as {f}", { f: f.label })}: ${escHtml(blocked)}</span>`
    : est ? `<span class="qc-status">≈ ${fmtBytes(est)}</span>` : '';
  const extChoice = exts(r.target).length > 1 ? `<select class="qc-ext" data-ext="${r.id}" aria-label="${t('File extension')}">${exts(r.target).map((e) => `<option ${(r.ext2 || f.ext) === e ? 'selected' : ''}>${e}</option>`).join('')}</select>` : '';
  const canConvert = r.obj && !blocked && r.status !== 'converting';
  let actions: string;
  if (r.status === 'done') {
    actions = `<button class="btn-solid small" data-dl="${r.id}">${icon('download')} ${instant ? t('Download again') : t('Download')}</button>
      <button class="btn-outline small" data-openres="${r.id}" title="${t('Open the converted file in the viewer to check it')}">${icon('eye')} <span>${t('Open result')}</span></button>
      ${canShareFiles() ? `<button class="btn-outline small" data-share="${r.id}" aria-label="${t('Share')} ${escHtml(r.result!.name)}">${icon('share')}</button>` : ''}`;
  } else if (blocked && r.alt) {
    actions = `<button class="btn-solid small" data-usealt="${r.id}">${t('Use {f} instead', { f: formatById(r.alt).label.replace(/ \(.*\)$/, '') })}</button>`;
  } else if (r.status === 'failed' && !r.obj) {
    actions = '';
  } else {
    actions = `<button class="btn-solid small" data-convert="${r.id}" ${canConvert ? '' : 'disabled'}>${escHtml(actionLabel(r))}</button>`;
  }
  return `<li class="qc-row is-${r.status}${rows.length > 1 && r.id === previewId ? ' is-previewed' : ''}${rows.length > 1 ? ' has-pick' : ''}" data-row="${r.id}">
    ${rows.length > 1 ? `<label class="qc-pick" title="${t('Select for Compare')}"><input type="checkbox" data-pickrow="${r.id}" ${r.picked ? 'checked' : ''} ${r.obj ? '' : 'disabled'} aria-label="${t('Select for Compare')}: ${escHtml(r.name)}"/></label>` : ''}
    <div class="qc-src">
      <button class="qc-thumb" type="button" data-preview="${r.id}" aria-label="${t('Preview')} ${escHtml(r.name)}" aria-pressed="${r.id === previewId}">${r.thumb ? `<img src="${r.thumb}" alt=""/>` : `<span>${escHtml(r.ext.toUpperCase().slice(0, 5))}</span>`}</button>
      <div class="qc-info">
        <b title="${escHtml(r.name)}">${escHtml(r.name)}</b>
        <small class="qc-meta"><span>${escHtml(r.ext.toUpperCase())} · ${fmtBytes(r.size)}</span>${r.dims ? `<span class="qc-dims">${dimsText(r)}</span>` : ''}</small>
        ${unitSel}
        ${srcState}
        ${r.help && r.status !== 'done' ? `<small class="qc-help ${needsUnitConfirm(r) ? 'warn-note' : ''}">${escHtml(r.help)}</small>` : ''}
      </div>
    </div>
    ${r.obj ? `<span class="qc-arrow" aria-hidden="true">→</span>
    <div class="qc-dst">
      <div class="qc-dst-pick"><button class="qc-target" data-target="${r.id}" aria-haspopup="listbox" aria-label="${t('Output format')}: ${escHtml(f.label)}">${escHtml(f.label)}<i>${icon('chev')}</i></button>${extChoice}</div>
      ${dstState}
      ${resized ? `<small class="qc-resized">${t('Output size')}: ${resized}</small>` : ''}
      ${rep?.lost.length && r.status !== 'failed' ? `<small class="qc-lost">${t('Not kept')}: ${escHtml(rep.lost.join(', '))}</small>` : ''}
    </div>` : ''}
    <div class="qc-actions">${actions}</div>
    <button class="qc-x" data-remove="${r.id}" aria-label="${t('Remove')} ${escHtml(r.name)}">${icon('x')}</button>
  </li>`;
}

function gateHtml(): string {
  const list = unresolved();
  if (!gate || !list.length) return '';
  return `<div class="qc-gate" role="group" aria-label="${t('Confirm units')}">
    <p><b>${t('{n} file(s) have an estimated unit.', { n: list.length })}</b> ${t('The size written into the file depends on it. Check each row, or confirm all at once:')}</p>
    <div class="qc-gate-btns">
      <button class="btn-solid small" data-gateok>${t('Confirm as shown')}</button>
      ${(['mm', 'in'] as UnitId[]).map((u) => `<button class="btn-outline small" data-gateall="${u}">${t('All in {u}', { u })}</button>`).join('')}
      <button class="link-btn" data-gatecancel>${t('Cancel')}</button>
    </div></div>`;
}
const focusGate = () => setTimeout(() => host?.querySelector<HTMLElement>('[data-gateok]')?.focus(), 30);

/** The bulk button's words count what will be saved, failures included, before saving (F06). */
function bulkLabel(): string {
  const ok = convertible().length;
  const bad = rows.filter((r) => (r.status === 'failed' && !r.obj) || (r.obj && exportBlocker(r.obj, r.target))).length;
  const main = ok > 1 ? t('Download {n} files (ZIP)', { n: ok }) : t('Download 1 file');
  return bad ? `${main} · ${t('{n} failed', { n: bad })}` : main;
}

let restoreFocus: string | null = null;
const FOCUS_KEYS = ['data-qcopts', 'data-target', 'data-convert', 'data-dl', 'data-openres', 'data-usealt', 'data-remove', 'data-unit', 'data-preset', 'data-convertall', 'data-dlall', 'data-pickrow', 'data-ext', 'data-opt', 'data-remember', 'data-share', 'data-preview', 'data-presets', 'data-gateok', 'data-gateall', 'data-receipt'];
/** Which control has focus, as a selector that survives a re-render (F09). */
function focusSelector(): string | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !host?.contains(a)) return null;
  for (const k of FOCUS_KEYS) if (a.hasAttribute(k)) return `[${k}="${a.getAttribute(k)}"]`;
  return null;
}
function refocus(sel: string | null) {
  if (!sel || !host) return;
  let el = host.querySelector<HTMLElement>(sel);
  if (!el) { // a Convert button became Download (or the other way round): stay on the same row
    const m = sel.match(/^\[data-(convert|dl|usealt)="(\d+)"\]$/);
    if (m) el = host.querySelector<HTMLElement>(`[data-row="${m[2]}"] .qc-actions button`);
  }
  if (!el && sel === '#dropZone') el = document.getElementById('dropZone');
  el?.focus({ preventScroll: true });
}

function render() {
  if (!host) return;
  const keep = restoreFocus ?? focusSelector();
  restoreFocus = null;
  const ready = convertible().length, done = rows.filter((r) => r.result).length;
  const picked = rows.filter((r) => r.picked && r.obj);
  const hist = history();
  const presets = !instant || showPresets;
  host.innerHTML = rows.length || notice ? `
    ${notice ? `<p class="qc-notice" role="status">${escHtml(notice.text)}${notice.addModel ? ` <button class="btn-outline small" data-addmodel>${t('Add model')}</button>` : ''}</p>` : ''}
    ${rows.length ? `<div class="qc-bar">
      <div class="qc-all">
        ${presets ? `<span>${t('Convert all to')}</span>
        <button class="qc-target" data-target="all" aria-haspopup="listbox">${allTarget ? escHtml(formatById(allTarget).label) : t('Choose…')}<i>${icon('chev')}</i></button>` : `<button class="qc-gear" data-presets aria-expanded="false">${icon('swap')}<span>${t('Change output')}</span></button>`}
        <button class="qc-gear ${optsChanged() ? 'on' : ''}" data-qcopts aria-expanded="${optsOpen}" aria-controls="qcOpts">${icon('tools')}<span>${t('Options')}</span></button>
      </div>
      ${presets ? `<div class="qc-presets" role="group" aria-label="${t('Where is it going?')}">${PRESETS.map((p, i) => `<button class="qc-preset" data-preset="${i}"><b>${t(p.label)}</b><small>${p.sub}</small></button>`).join('')}</div>` : ''}
      <div class="qc-opts ${optsOpen ? '' : 'hidden'}" id="qcOpts">
        <label class="check"><input type="checkbox" data-opt="upright" ${opts.upright ? 'checked' : ''}/> ${t('Stand upright for printing and CAD (Z-up)')}</label>
        <label>${t('Numbers in unitless files')} <select data-opt="outUnit"><option value="">${t('Automatic (STL: mm)')}</option>${['mm', 'cm', 'm', 'in'].map((u) => `<option value="${u}" ${opts.outUnit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>${t('Scale')} <input type="number" min="1" max="100000" step="1" value="${opts.scale}" data-opt="scale"/> %</label>
        <label>${t('Keep polygons')} <input type="range" min="5" max="100" step="5" value="${opts.reduce}" data-opt="reduce"/> <output>${opts.reduce}%</output></label>
        <label class="check"><input type="checkbox" data-opt="merge" ${opts.merge ? 'checked' : ''}/> ${t('Merge all parts into one')}</label>
      </div>
    </div>` : ''}
    ${gateHtml()}
    ${rows.length ? `<ul class="qc-list" role="list">${rows.map(rowHtml).join('')}</ul>` : ''}
    ${lastSaved ? `<p class="qc-saved" role="status">${icon('check')} ${escHtml(lastSaved)}</p>` : ''}
    ${rows.length > 1 ? `<div class="qc-foot">
      ${picked.length === 2 ? `<button class="btn-outline" data-compare>${icon('compare')} ${t('Compare these two')}</button>` : `<span class="muted qc-hint">${t('Tick two files to compare them.')}</span>`}
      <span class="grow"></span>
      ${done ? `<button class="link-btn" data-receipt>${t('Save receipt')}</button>` : ''}
      <button class="btn-outline" data-convertall ${ready ? '' : 'disabled'}>${t('Convert all')}</button>
      <button class="btn-solid" data-dlall ${ready ? '' : 'disabled'}>${icon('download')} ${escHtml(bulkLabel())}</button>
    </div>` : ''}` : '';
  if (crashNote) host.insertAdjacentHTML('afterbegin', `<p class="qc-crash" role="alert">${escHtml(crashNote)}</p>`);
  host.innerHTML += `<div class="qc-history">
      ${hist.length ? `<details><summary>${t('Recent conversions on this device')} (${hist.length})</summary><ul>${hist.map((h) => `<li><b>${escHtml(h.name)}</b> <span class="muted">${escHtml(h.from.toUpperCase())} → ${escHtml(h.to.toUpperCase())} · ${fmtBytes(h.size)} · ${new Date(h.at).toLocaleDateString()}</span></li>`).join('')}</ul><button class="link-btn" data-clearhist>${t('Clear')}</button></details>` : ''}
      <label class="check small"><input type="checkbox" data-remember ${remember() ? 'checked' : ''}/> ${t('Remember conversions (names and formats only, never the files)')}</label>
    </div>`;
  document.body.classList.toggle('qc-has-rows', rows.length > 0);
  if (picker) positionPicker();
  updatePreview();
  refocus(keep);
}

function updatePreview() {
  const r = rows.find((x) => x.id === previewId) ?? rows.find((x) => x.obj);
  if (!r) { showPreview({ kind: 'empty' }); return; }
  previewId = r.id;
  if (r.obj) showPreview({ kind: 'ready', name: r.name, obj: r.obj, up: r.up, key: r.id, caption: dimsText(r), still: () => still(r) });
  else if (r.status === 'failed') showPreview({ kind: 'failed', name: r.name, error: r.error || t('This file could not be read.') });
  else showPreview({ kind: 'loading', name: r.name });
}

/** How the editor should treat a row's unit: what the person decided here carries over (F01). */
const givenUnit = (r: Row) => (r.unitSrc === 'guess' ? undefined : { unit: r.unit, unitSource: (r.unitSrc === 'declared' ? 'declared' : r.unitSrc === 'format' ? 'format' : r.unitSrc === 'saved' ? 'saved' : 'user') as 'declared' | 'format' | 'saved' | 'user', up: r.up });

function openPreviewedInEditor() {
  const r = rows.find((x) => x.id === previewId);
  if (!r) return;
  closeQuickConvert();
  void ctx.openFilesWith(r.files, givenUnit(r));
}
/** Opens the generated file itself, so the person checks what they actually got (N02). */
function openResult(r: Row) {
  if (!r.result) return;
  const file = new File([r.result.blob], r.result.name, { type: r.result.blob.type || 'application/octet-stream' });
  const f = formatById(r.target);
  // A unitless output holds numbers in a known unit; tell the editor so it doesn't guess again.
  const out = outputUnit(r.target, { unit: r.unit, outUnit: f.convention === 'unitless' && opts.outUnit ? opts.outUnit : undefined });
  closeQuickConvert();
  void ctx.openFilesWith([file], f.convention === 'unitless' && out && out !== 'u' && r.unitSrc !== 'guess' ? { unit: out, unitSource: 'user' } : undefined, 'tab');
}

let optsOpen = false;
const optsChanged = () => !opts.upright || !!opts.outUnit || opts.scale !== 100 || opts.reduce !== 100 || opts.merge;

function setTarget(r: Row, id: ExportId) {
  r.target = id; r.ext2 = undefined; r.alt = undefined;
  if (r.result && r.result.key !== jobKey(r)) r.result = undefined;
  if (r.status === 'done' && !r.result) r.status = 'ready';
  if (r.status === 'failed' && r.obj) r.status = 'ready';
}
const invalidate = () => rows.forEach((r) => { if (r.result || (r.status === 'failed' && r.obj)) { r.result = undefined; if (r.status !== 'converting') r.status = 'ready'; } });

/** Applies one target to every row that can take it and says which rows could not (F15). */
function applyAll(to: ExportId) {
  allTarget = to;
  const skipped: Row[] = [];
  let applied = 0;
  rows.forEach((r) => { if (!r.obj) return; if (exportBlocker(r.obj, to)) skipped.push(r); else { setTarget(r, to); applied++; } });
  const total = rows.filter((r) => r.obj).length;
  notice = skipped.length ? { text: t('Applied to {a} of {n}. Not possible for: {list}.', { a: applied, n: total, list: skipped.map((r) => r.name).join(', ') }) } : null;
}

// One shared, searchable format picker (popover), keyboard operable like the full exporter's list (F08, F25).
function openPicker(anchor: HTMLElement, current: ExportId, onPick: (id: ExportId) => void, rowObj?: THREE.Object3D) {
  closePicker();
  picker = { anchor, anchorKey: anchor.dataset.target || '', onPick, current };
  const el = document.createElement('div');
  el.className = 'qc-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('Choose an output format'));
  const groups: Record<string, string> = { print: '3D printing', web: 'Web, AR & games', apps: '3D apps', cad: 'CAD & drawings', data: 'Scans, points & research' };
  el.innerHTML = `<input type="search" placeholder="${t('Search formats or apps…')}" aria-label="${t('Search formats')}" aria-controls="qcPickList"/>
    <p class="qc-pick-count sr-only" aria-live="polite"></p>
    <ul role="listbox" id="qcPickList" aria-label="${t('Formats')}">${Object.entries(groups).map(([g, label]) => `<li class="qc-pg" role="presentation">${t(label)}</li>` + EXPORT_FORMATS.filter((f) => f.group === g).map((f: any) => { const why = rowObj ? exportBlocker(rowObj, f.id) : null; return `<li role="option" tabindex="-1" data-pid="${f.id}" aria-selected="${f.id === current}" ${why ? 'aria-disabled="true"' : ''} class="${f.id === current ? 'cur' : ''} ${why ? 'off' : ''}" data-s="${escHtml(`${f.label} ${[f.ext, ...(f.alias ?? [])].join(' ')} ${f.tags}`.toLowerCase())}" ${why ? `title="${escHtml(why)}"` : ''}><b>${escHtml(f.label)}</b><small>.${[f.ext, ...(f.alias ?? [])].join(' .')}${why ? ` · ${escHtml(why)}` : ''}</small></li>`; }).join('')).join('')}
    <li class="qc-none hidden" role="presentation"></li></ul>`;
  document.body.appendChild(el);
  positionPicker();
  const input = el.querySelector('input')!;
  const list = el.querySelector<HTMLElement>('[role=listbox]')!;
  const none = el.querySelector<HTMLElement>('.qc-none')!;
  const count = el.querySelector<HTMLElement>('.qc-pick-count')!;
  const visible = () => [...el.querySelectorAll<HTMLElement>('[data-pid]')].filter((li) => !li.classList.contains('hidden'));
  const usable = () => visible().filter((li) => !li.classList.contains('off'));
  let countTimer = 0;
  input.oninput = () => {
    const w = input.value.toLowerCase().replace(/^\./, '').split(/\s+/).filter(Boolean);
    el.querySelectorAll<HTMLElement>('[data-pid]').forEach((li) => li.classList.toggle('hidden', !w.every((x) => li.dataset.s!.includes(x))));
    el.querySelectorAll<HTMLElement>('.qc-pg').forEach((h) => { let n = h.nextElementSibling as HTMLElement | null, any = false; while (n && !n.classList.contains('qc-pg') && n.dataset.pid) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling as HTMLElement | null; } h.classList.toggle('hidden', !any); });
    const n = visible().length;
    none.classList.toggle('hidden', n > 0);
    none.innerHTML = n ? '' : `${escHtml(t('No formats match “{q}”.', { q: input.value }))} ${escHtml(t('Try an extension (stl, glb), a use (print, web, AR) or an app (Blender, Unity).'))} <button class="link-btn" type="button" data-pclear>${t('Clear')}</button>`;
    clearTimeout(countTimer);
    countTimer = window.setTimeout(() => { count.textContent = t('{n} formats', { n }); }, 400);
  };
  const move = (from: HTMLElement | null, d: number | 'home' | 'end') => {
    const opts2 = usable();
    if (!opts2.length) return;
    const i = from ? opts2.indexOf(from) : -1;
    const j = d === 'home' ? 0 : d === 'end' ? opts2.length - 1 : Math.max(0, Math.min(opts2.length - 1, i + d));
    if (d === -1 && i <= 0) { input.focus(); return; }
    opts2[j].focus();
  };
  input.onkeydown = (e) => {
    const first = usable()[0];
    if (e.key === 'Enter' && first) { e.preventDefault(); choose(first.dataset.pid as ExportId); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(null, 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(true); }
  };
  list.onkeydown = (e) => {
    const cur = (document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-pid]');
    if (!cur) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(cur, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(cur, -1); }
    else if (e.key === 'Home') { e.preventDefault(); move(cur, 'home'); }
    else if (e.key === 'End') { e.preventDefault(); move(cur, 'end'); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!cur.classList.contains('off')) choose(cur.dataset.pid as ExportId); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(true); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { input.focus(); } // typing goes back to the search box
  };
  el.onclick = (e) => {
    if ((e.target as HTMLElement).closest('[data-pclear]')) { input.value = ''; input.dispatchEvent(new Event('input')); input.focus(); return; }
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-pid]'); if (li && !li.classList.contains('off')) choose(li.dataset.pid as ExportId);
  };
  setTimeout(() => input.focus(), 30);
  function choose(id: ExportId) { const cb = picker?.onPick; const key = picker?.anchorKey; closePicker(); cb?.(id); restoreFocus = key ? `[data-target="${key}"]` : null; render(); }
}
function positionPicker() {
  const el = document.querySelector<HTMLElement>('.qc-picker');
  if (!el || !picker) return;
  const a = document.querySelector<HTMLElement>(`[data-target="${picker.anchorKey}"]`) || picker.anchor;
  const r = a.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  el.style.width = w + 'px';
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  const below = window.innerHeight - r.bottom;
  if (below > 300 || below > r.top) { el.style.top = r.bottom + 6 + 'px'; el.style.bottom = ''; el.style.maxHeight = Math.max(200, below - 16) + 'px'; }
  else { el.style.bottom = window.innerHeight - r.top + 6 + 'px'; el.style.top = ''; el.style.maxHeight = Math.max(200, r.top - 16) + 'px'; }
}
function closePicker(returnFocus = false) {
  const key = picker?.anchorKey;
  document.querySelector('.qc-picker')?.remove(); picker = null;
  if (returnFocus && key) host?.querySelector<HTMLElement>(`[data-target="${key}"]`)?.focus();
}

function onClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  const id = (k: string) => Number(el.closest<HTMLElement>(`[data-${k}]`)?.dataset[k]);
  const row = (k: string) => rows.find((r) => r.id === id(k));
  const tgt = el.closest<HTMLElement>('[data-target]');
  if (tgt) {
    if (tgt.dataset.target === 'all') openPicker(tgt, allTarget ?? 'glb', (to) => applyAll(to));
    else { const r = rows.find((x) => x.id === Number(tgt.dataset.target)); if (r) openPicker(tgt, r.target, (to) => setTarget(r, to), r.obj); }
    return;
  }
  if (el.closest('[data-qcopts]')) { optsOpen = !optsOpen; render(); return; }
  if (el.closest('[data-presets]')) { showPresets = true; restoreFocus = '[data-target="all"]'; render(); return; }
  if (el.closest('[data-addmodel]')) { document.getElementById('dropZone')?.click(); return; }
  const preset = el.closest<HTMLElement>('[data-preset]');
  if (preset) {
    const p = PRESETS[Number(preset.dataset.preset)];
    if (p.upright !== undefined && p.upright !== opts.upright) { opts.upright = p.upright; invalidate(); }
    applyAll(p.to);
    render(); return;
  }
  if (el.closest('[data-convert]')) {
    const r = row('convert');
    // The button said "Confirm mm & …": pressing it is the confirmation.
    if (r) { if (r.unitSrc === 'guess') r.unitSrc = 'user'; void convert(r, !!instant); }
    return;
  }
  if (el.closest('[data-usealt]')) { const r = row('usealt'); if (r?.alt) { setTarget(r, r.alt); render(); } return; }
  if (el.closest('[data-dl]')) { const r = row('dl'); if (r?.result) { download(r.result.blob, r.result.name); lastSaved = `${t('Downloaded')} ${r.result.name} · ${fmtBytes(r.result.blob.size)}`; render(); } return; }
  if (el.closest('[data-openres]')) { const r = row('openres'); if (r) openResult(r); return; }
  if (el.closest('[data-share]')) { const r = row('share'); if (r) void share(r); return; }
  if (el.closest('[data-preview]')) { const r = row('preview'); if (r) { previewId = r.id; render(); document.querySelector('.qc-preview')?.scrollIntoView({ block: 'nearest' }); } return; }
  if (el.closest('[data-remove]')) { const r = row('remove'); if (r) removeRow(r); return; }
  if (el.closest('[data-convertall]')) { void convertAll(); return; }
  if (el.closest('[data-dlall]')) { void downloadAll(); return; }
  if (el.closest('[data-receipt]')) { download(new Blob([receipt()], { type: 'text/plain' }), 'conversion-receipt.txt'); return; }
  if (el.closest('[data-gateok]') || el.closest('[data-gateall]')) {
    const all = el.closest<HTMLElement>('[data-gateall]')?.dataset.gateall as UnitId | undefined;
    for (const r of unresolved()) { if (all) r.unit = all; r.unitSrc = 'user'; r.result = undefined; if (r.status === 'done') r.status = 'ready'; }
    const next = gate; gate = null;
    restoreFocus = next === 'dlall' ? '[data-dlall]' : '[data-convertall]';
    render();
    void (next === 'dlall' ? downloadAll() : convertAll());
    return;
  }
  if (el.closest('[data-gatecancel]')) { gate = null; render(); return; }
  if (el.closest('[data-compare]')) {
    const [a, b] = rows.filter((r) => r.picked && r.obj);
    closeQuickConvert();
    // B opens once A has finished loading, with both units carried over (F33).
    void ctx.openFilesWith(a.files, givenUnit(a)).then(() => { if (ctx.viewer.model) void compareWith(b.files, givenUnit(b)?.unit); });
    return;
  }
  if (el.closest('[data-clearhist]')) { store.set('history', '[]'); render(); }
}
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.dataset.unit) {
    const r = rows.find((x) => x.id === Number(el.dataset.unit));
    if (r) { r.unit = el.value as UnitId; r.unitSrc = 'user'; r.help = undefined; if (r.result && r.result.key !== jobKey(r)) r.result = undefined; if (r.status === 'done' && !r.result) r.status = 'ready'; if (!unresolved().length) gate = null; render(); }
    return;
  }
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
  document.body.classList.toggle('qc-instant', !!instant);
  if (!host) {
    host = document.getElementById('qcHost');
    host?.addEventListener('click', onClick);
    if (host) mountPreview(host, openPreviewedInEditor);
    host?.addEventListener('change', onChange);
    host?.addEventListener('input', (e) => { const el = e.target as HTMLInputElement; if (el.dataset.opt === 'reduce') { const out = el.parentElement?.querySelector('output'); if (out) out.textContent = el.value + '%'; } });
  }
  // Instant converter pages (stl-to-obj…) keep their own wording; everywhere else the drop zone says what it does.
  if (instant) { if (pageWording) setDropZone(...pageWording); } // the page sets its own wording on load
  else setDropZone(t('Drop files to convert'), t('Choose files to convert'));
  syncModeSwitch();
  render();
}
export function closeQuickConvert() {
  document.body.classList.remove('qc-open', 'qc-has-rows');
  closePicker();
  pausePreview();
  if (instant && !pageWording) pageWording = [document.getElementById('dzTitle')?.textContent || '', document.getElementById('dzBtn')?.textContent || ''];
  setDropZone(t('Drop a model, folder or ZIP'), t('Open 3D files'));
  syncModeSwitch();
}
let pageWording: [string, string] | null = null;
function setDropZone(title: string, btn: string) {
  const ti = document.getElementById('dzTitle'), b = document.getElementById('dzBtn');
  if (ti) ti.textContent = title;
  if (b) b.textContent = btn;
}
/** The "View & edit in 3D | Convert files" switch above the drop zone. */
function syncModeSwitch() {
  const on = qcIsOpen();
  document.getElementById('modeView')?.setAttribute('aria-pressed', String(!on));
  document.getElementById('modeConvert')?.setAttribute('aria-pressed', String(on));
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
  registerCommand({ id: 'quickconvert', label: 'Quick convert files…', group: 'File', keywords: 'convert export batch fast simple download format', run: () => openQuickConvert() });
  void takeSharedFiles();
  let was: string | null = null;
  try { was = sessionStorage.getItem(READING); } catch { /* storage blocked */ }
  if (was) {
    mark(null);
    crashNote = t('The page reloaded while reading “{name}”: this device ran out of memory. Try again, or use a computer for very large files.').replace('{name}', was);
    if (!qcIsOpen()) openQuickConvert(); else render();
  }
}

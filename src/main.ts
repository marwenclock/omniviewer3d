import './style.css';
import * as THREE from 'three';
import { Viewer, type ViewName, type DisplayMode, type Axis } from './viewer';
import { loadFiles, filesFromUrls, ACCEPT, FORMATS, setSharedRenderer, extOf } from './loaders';
import { History } from './history';
import { Editor, type Primitive, type GizmoMode } from './editor';
import { MeasureTool } from './tools/measure';
import { PaintTool } from './tools/paint';
import { computeStats, UNITS, type Unit, fmtLen, fmtNum, fmtInt, type ModelStats } from './stats';
import { EXPORT_FORMATS, exportModel, download, type ExportId } from './exporters';
import { icon, hydrateIcons } from './icons';
import { CONFIG } from './config';
import { panels, commands, registerCommand } from './registry';
import { ctx } from './context';
import { MATERIALS, estimate } from './cost';
import { listRecent, addRecent, removeRecent, clearRecent, entryFiles, type RecentEntry } from './recent';
import { guessUnit, defaultUp, rememberPref } from './units';
import { initFeatures } from './features';
import { capsEnabled, setCaps } from './features/caps';
import { showBatchDialog } from './features/batch';
import { openPalette, registerContextAction } from './features/palette';
import { CAD_QUALITY, cadQuality } from './cad';

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem('omniview.' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('omniview.' + k, v); } catch { /* private mode */ } },
};

function toast(msg: string, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), error ? 6000 : 2600);
}

function setLoading(msg: string | null, progress: number | null = null) {
  $('#loading').classList.toggle('hidden', msg === null);
  if (msg) $('#loadingText').textContent = msg;
  const bar = $('#loadingBar');
  bar.classList.toggle('hidden', progress === null);
  if (progress !== null) ($('#loadingBar i') as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

const EXAMPLES = [
  { label: 'Helmet · GLB', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb' },
  { label: 'Fox · animated', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb' },
  { label: 'Assembly · STEP', url: 'https://raw.githubusercontent.com/kovacsv/occt-import-js/main/test/testfiles/cax-if/as1-oc-214.stp' },
  { label: 'House · IFC', url: 'https://raw.githubusercontent.com/ThatOpen/engine_web-ifc/main/tests/ifcfiles/public/AC20-FZK-Haus.ifc' },
  { label: 'Gears · 3MF', url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/3mf/cube_gears.3mf' },
  { label: 'Robot head · STL', url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/binary/pr2_head_pan.stl' },
  { label: 'Logo · 3DM', url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/3dm/Rhino_Logo.3dm' },
];

const PAINT_COLORS = ['#e4572e', '#f3a712', '#ffd23f', '#76b041', '#17bebb', '#2e86de', '#6c5ce7', '#e84393', '#ffffff', '#9a9a9a', '#3d3d3d', '#0a0a0a'];

// ------------------------------------------------------------------ app state
type Tool = string;
const state = {
  tool: 'none' as Tool,
  unit: store.get('unit', 'mm') as Unit,
  modelName: '',
  ext: '',
  lastFiles: null as File[] | null,
  installPrompt: null as any,
  abort: null as AbortController | null,
  sourceUrls: null as string[] | null,
  stats: null as ModelStats | null,
  expanded: new Set<string>(),
  bgCustom: store.get('bg', '') || null,
};

const viewer = new Viewer($('#viewport'));
setSharedRenderer(viewer.renderer);
const history = new History();
const editor = new Editor(viewer, history);
const measure = new MeasureTool(viewer);
const paint = new PaintTool(viewer, history);
measure.format = (v) => fmtLen(v, state.unit);

// ------------------------------------------------------------------ static UI setup
/** Set by the landing page (format viewer, converter or tool page) the visitor arrived on. */
interface PageConfig { kind?: 'viewer' | 'convert' | 'tool'; from?: string; to?: ExportId; tool?: string }
let PAGE: PageConfig = {};
try { PAGE = JSON.parse($('#page-config')?.textContent || '{}'); } catch { /* defaults */ }
($('#repoLink') as HTMLAnchorElement).href = CONFIG.repoUrl;
$('#year').textContent = String(new Date().getFullYear());
($('#fileInput') as HTMLInputElement).accept = ACCEPT;
$('#formatList').innerHTML = FORMATS.map((f) => f.ext[0] === 'zip'
  ? `<span class="fmt" title="${esc(f.name)}">.zip</span>`
  : `<a class="fmt" href="${f.ext[0]}-viewer/" title="${esc(f.name)} viewer">${f.ext.map((e) => '.' + e).join(' ')}</a>`).join('');
$('#examples').innerHTML = EXAMPLES.map((e, i) => `<button class="chip" data-example="${i}">${esc(e.label)}</button>`).join('');
hydrateIcons();

const theme = store.get('theme', 'dark');
applyTheme(theme as 'dark' | 'light');

function applyTheme(t: 'dark' | 'light') {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  const btn = $('[data-action="theme"]');
  btn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  if (!state.bgCustom) viewer.setBackground(t === 'dark' ? '#151515' : '#ebebea');
}
if (state.bgCustom) viewer.setBackground(state.bgCustom);

// ------------------------------------------------------------------ loading
async function openFiles(files: File[], urls: string[] | null = null) {
  if (!files.length) return;
  setLoading('Loading…');
  const ac = new AbortController();
  state.abort = ac;
  $('#loadingCancel').classList.remove('hidden');
  try {
    const res = await loadFiles(files, (m) => setLoading(m), ac.signal);
    setTool('none');
    measure.clear();
    editor.select(null);
    editor.setGizmo('none');
    history.clear();
    document.body.classList.add('has-model');
    viewer.setModel(res.object, res.animations);
    viewer.setExplode(0);
    state.modelName = res.mainFiles.length === 1 ? res.mainFiles[0] : `${res.mainFiles.length} files`;
    state.sourceUrls = urls;
    state.expanded = new Set([res.object.uuid]);
    // CAD and printing formats are usually Z-up and in millimetres; the size is sanity-checked.
    const ext = extOf(res.mainFiles[0]);
    state.ext = ext;
    state.lastFiles = urls ? null : files;
    viewer.setUpAxis(defaultUp(ext));
    const size = viewer.bounds().getSize(new THREE.Vector3());
    const guess = guessUnit(ext, Math.max(size.x, size.y, size.z));
    setUnit(guess.unit);
    hideUnitHint();
    if (guess.suggest) showUnitHint(guess.unit, guess.suggest.unit, guess.suggest.why);
    addRecent(state.modelName, urls ? null : files, urls).then(renderRecent);
    document.body.classList.add('has-model');
    refreshStats();
    renderAll();
    if (res.warnings.length) toast('Some files could not be loaded:\n' + res.warnings.join('\n'), true);
    else toast(`Opened ${state.modelName}`);
    applyPageIntent();
    maybeShowTips();
  } catch (err: any) {
    if (err?.name === 'AbortError') { toast('Cancelled'); return; }
    console.error(err);
    toast(err?.message || String(err), true);
  } finally {
    setLoading(null);
    $('#loadingCancel').classList.add('hidden');
    if (state.abort === ac) state.abort = null;
  }
}

async function openUrls(urls: string[]) {
  setLoading('Downloading…', 0);
  const ac = new AbortController();
  state.abort = ac;
  $('#loadingCancel').classList.remove('hidden');
  try {
    const files = await filesFromUrls(urls, (done, total) => setLoading(`Downloading… ${(done / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, total ? done / total : null), ac.signal);
    setLoading('Loading…');
    await openFiles(files, urls);
    if (!document.body.classList.contains('embed')) history_replaceHash(urls);
  } catch (err: any) {
    setLoading(null);
    $('#loadingCancel').classList.add('hidden');
    if (err?.name === 'AbortError') { toast('Cancelled'); return; }
    toast(`${err?.message || err}\nThe server may not allow downloads from other sites (CORS).`, true);
  }
}

function history_replaceHash(urls: string[]) {
  // Full path: pages in sub-folders use <base href="../">, which would otherwise rewrite the path.
  const h = '#model=' + urls.map(encodeURIComponent).join(',');
  window.history.replaceState(null, '', location.pathname + location.search + h);
}

/** After a file opens, jump straight to what this landing page is about. */
function applyPageIntent() {
  const tool = PAGE.tool;
  if (PAGE.to) { const to = PAGE.to; setTimeout(() => (store.get(autoKey(to), '') ? runExport(to) : showExportDialog(to)), 350); return; }
  if (tool === 'convert') { setTimeout(() => showExportDialog(), 350); return; }
  if (tool === 'paint' || tool === 'measure') { setTool(tool); return; }
  if (tool === 'edit') { editor.setGizmo('translate'); toast('Click a part, then drag the arrows to move it'); return; }
  if (tool === 'scale' || tool === 'units' || tool === 'volume') {
    document.body.classList.remove('no-right');
    $$('[data-rtab]').forEach((b) => b.classList.toggle('active', b.dataset.rtab === 'details'));
    $('#rtab-details').classList.remove('hidden');
    $('#rtab-settings').classList.add('hidden');
    setTimeout(() => {
      const el = document.getElementById(tool === 'volume' ? 'sec-model' : 'sec-scale');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1800);
    }, 400);
  }
}

function newScene() {
  if (viewer.model && history.canUndo && !confirm('Start a new empty scene? Unsaved changes will be lost.')) return;
  setTool('none');
  measure.clear();
  editor.select(null);
  history.clear();
  viewer.setModel(null);
  editor.ensureModel();
  viewer.setUpAxis('y');
  state.modelName = 'Untitled scene';
  state.sourceUrls = null;
  state.expanded = new Set([viewer.model!.uuid]);
  window.history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.add('has-model');
  editor.addPrimitive('box');
  if (PAGE.tool === 'edit') editor.setGizmo('translate');
  viewer.fit(viewer.model, 'iso');
  refreshStats();
  renderAll();
  toast('Empty scene ready: add shapes from the toolbar');
}

// ------------------------------------------------------------------ stats
let statsTimer = 0;
function refreshStats(delay = 0) {
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    state.stats = computeStats(viewer.model, viewer.bounds());
    renderDetails();
    updateStatus();
  }, delay);
}

function setUnit(u: Unit, remember = false) {
  state.unit = u;
  store.set('unit', u);
  if (remember && state.ext) rememberPref(state.ext, { unit: u });
  measure.relabel();
  renderDetails();
  updateStatus();
}

// ------------------------------------------------------------------ tools
function setTool(t: Tool) {
  if (state.tool === t) t = 'none';
  panels.get(state.tool)?.onDeactivate?.();
  state.tool = t;
  measure.setActive(t === 'measure');
  paint.setActive(t === 'paint');
  if (t === 'section' && !viewer.section.enabled) viewer.setSection({ enabled: true });
  if (t === 'paint' || t === 'measure') editor.setGizmo('none');
  const hints: Record<string, string> = {
    none: '',
    measure: 'Click two points to measure · snaps to corners · Esc to stop',
    paint: paint.mode === 'brush' ? 'Click and drag to brush colour onto the surface · Esc to stop' : 'Click a part to colour it · Esc to stop',
    section: 'Drag the slider in the details panel to cut through the model',
    explode: 'Use the slider in the details panel to pull parts apart',
  };
  const panel = panels.get(t);
  panel?.onActivate?.();
  const hintText = panel ? panel.hint : hints[t] || '';
  const hint = $('#toolHint');
  hint.textContent = hintText;
  hint.classList.toggle('hidden', !hintText);
  viewer.renderer.domElement.style.cursor = t === 'measure' || t === 'paint' ? 'crosshair' : '';
  if (t !== 'none') document.body.classList.remove('no-right');
  updateToolbar();
  renderDetails();
}

// ------------------------------------------------------------------ toolbar & menus
function updateToolbar() {
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  $$('[data-gizmo]').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === editor.gizmo));
  $$('[data-display]').forEach((b) => b.classList.toggle('checked', b.dataset.display === viewer.displayMode));
  $$('[data-projection]').forEach((b) => b.classList.toggle('checked', (b.dataset.projection === 'orthographic') === (viewer.camera === viewer.ortho)));
  const toggles: Record<string, boolean> = { edges: viewer.showEdges, grid: viewer.showGrid, axes: viewer.showAxes, autorotate: viewer.controls.autoRotate };
  $$('[data-toggle]').forEach((b) => b.classList.toggle('checked', !!toggles[b.dataset.toggle!]));
  ($('[data-action="undo"]') as HTMLButtonElement).disabled = !history.canUndo;
  ($('[data-action="redo"]') as HTMLButtonElement).disabled = !history.canRedo;
  $('[data-action="undo"]').dataset.tip = history.canUndo ? `Undo ${history.nextUndo} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  $('[data-action="redo"]').dataset.tip = history.canRedo ? `Redo ${history.nextRedo} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
}

function closeMenus() { $$('.menu.open').forEach((m) => m.classList.remove('open')); }

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const menuBtn = t.closest<HTMLElement>('[data-menu]');
  if (menuBtn) {
    const menu = $('#menu-' + menuBtn.dataset.menu);
    const wasOpen = menu.classList.contains('open');
    closeMenus();
    if (!wasOpen) {
      const r = menuBtn.getBoundingClientRect();
      menu.classList.add('open');
      menu.style.top = r.bottom + 6 + 'px';
      menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    }
    return;
  }
  if (!t.closest('.menu')) closeMenus();
  const el = t.closest<HTMLElement>('[data-action],[data-tool],[data-gizmo],[data-view],[data-display],[data-projection],[data-toggle],[data-add],[data-example],[data-close],[data-open],[data-tab],[data-rtab]');
  if (!el) return;
  if (el.closest('.menu')) closeMenus();
  const d = el.dataset;
  if (d.action) runAction(d.action);
  else if (d.tool) setTool(d.tool as Tool);
  else if (d.gizmo) {
    const m = d.gizmo as GizmoMode;
    editor.setGizmo(editor.gizmo === m ? 'none' : m);
    if (editor.gizmo !== 'none' && (state.tool === 'paint' || state.tool === 'measure')) setTool('none');
    if (editor.gizmo !== 'none' && !editor.selected) toast('Select an object to move, rotate or scale it');
  }
  else if (d.view) viewer.fit(viewer.model, d.view as ViewName);
  else if (d.display) viewer.setDisplayMode(d.display as DisplayMode);
  else if (d.projection) viewer.setProjection(d.projection as 'perspective' | 'orthographic');
  else if (d.toggle) {
    if (d.toggle === 'edges') viewer.setEdges(!viewer.showEdges);
    if (d.toggle === 'grid') viewer.setGrid(!viewer.showGrid);
    if (d.toggle === 'axes') viewer.setAxes(!viewer.showAxes);
    if (d.toggle === 'autorotate') viewer.setAutoRotate(!viewer.controls.autoRotate);
    renderSettings();
  }
  else if (d.add) { editor.addPrimitive(d.add as Primitive); document.body.classList.add('has-model'); if (!state.modelName) state.modelName = 'Untitled scene'; }
  else if (d.example) openUrls([EXAMPLES[Number(d.example)].url]);
  else if (d.close) document.body.classList.add('no-' + d.close);
  else if (d.open) document.body.classList.remove('no-' + d.open);
  else if (d.tab) {
    $$('[data-tab]').forEach((b) => b.classList.toggle('active', b === el));
    $('#tab-scene').classList.toggle('hidden', d.tab !== 'scene');
    $('#tab-materials').classList.toggle('hidden', d.tab !== 'materials');
    if (d.tab === 'materials') renderMaterials();
  }
  else if (d.rtab) {
    $$('[data-rtab]').forEach((b) => b.classList.toggle('active', b === el));
    $('#rtab-details').classList.toggle('hidden', d.rtab !== 'details');
    $('#rtab-settings').classList.toggle('hidden', d.rtab !== 'settings');
    if (d.rtab === 'settings') renderSettings();
  }
  updateToolbar();
});

function runAction(a: string) {
  switch (a) {
    case 'open': ($('#fileInput') as HTMLInputElement).click(); break;
    case 'url': showUrlDialog(); break;
    case 'new': newScene(); break;
    case 'fit': viewer.fit(editor.selected ?? viewer.model); break;
    case 'undo': history.undo(); break;
    case 'redo': history.redo(); break;
    case 'screenshot': showScreenshotDialog(); break;
    case 'export': showExportDialog(); break;
    case 'share': showShareDialog(); break;
    case 'support': showSupportDialog(); break;
    case 'help': showHelpDialog(); break;
    case 'batch': showBatchDialog(); break;
    case 'palette': openPalette(); break;
    case 'theme': applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); renderSettings(); break;
  }
}

// tooltips
const tip = $('#tooltip');
document.addEventListener('pointerover', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
  if (!el || e.pointerType === 'touch') { tip.classList.remove('show'); return; }
  tip.textContent = el.dataset.tip!;
  const r = el.getBoundingClientRect();
  tip.classList.add('show');
  const w = tip.offsetWidth;
  tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
  tip.style.top = r.bottom + 8 + 'px';
});
document.addEventListener('pointerout', (e) => { if ((e.target as HTMLElement).closest('[data-tip]')) tip.classList.remove('show'); });

// ------------------------------------------------------------------ file input & drag-drop
$('#fileInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  openFiles([...(input.files || [])]);
  input.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropOverlay').classList.add('show'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').classList.remove('show'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.remove('show');
  const files = await filesFromDrop(e.dataTransfer!);
  openFiles(files);
});

/** Reads dropped files, including the contents of dropped folders. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const c of batch) await walk(c);
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

// ------------------------------------------------------------------ canvas interaction
const canvas = viewer.renderer.domElement;
let downAt: { x: number; y: number } | null = null;
let paintStroke = false;

canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  if (state.tool === 'paint' && paint.onPointerDown(e)) {
    paintStroke = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (state.tool === 'measure') measure.onPointerMove(e);
  if (state.tool === 'paint') paint.onPointerMove(e);
});
canvas.addEventListener('pointerup', (e) => {
  if (paintStroke) { paint.onPointerUp(); paintStroke = false; return; }
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  downAt = null;
  if (editor.transform.dragging || (editor.transform as any).axis) return;
  if (state.tool === 'measure') { measure.onClick(e); return; }
  if (state.tool === 'paint') return;
  const hit = viewer.pick(e);
  selectObject(hit ? hit.object : null);
});
canvas.addEventListener('dblclick', (e) => {
  const hit = viewer.pick(e);
  if (hit) viewer.fit(hit.object);
});

paint.onPainted = () => { refreshStats(300); renderMaterials(); };

function selectObject(obj: THREE.Object3D | null) {
  editor.select(obj);
  if (obj) {
    // Expand the tree down to the selected object.
    let p = obj.parent;
    while (p && p !== viewer.world) { state.expanded.add(p.uuid); p = p.parent; }
  }
  renderTree();
  renderDetails();
  requestAnimationFrame(() => $('.node.selected')?.scrollIntoView({ block: 'nearest' }));
}

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ($('#modal') as HTMLDialogElement).open) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); editor.duplicateSelected(); return; }
  if (mod && k === 'o') { e.preventDefault(); runAction('open'); return; }
  if (mod) return;
  const views: Record<string, ViewName> = { '1': 'iso', '2': 'front', '3': 'back', '4': 'left', '5': 'right', '6': 'top', '7': 'bottom' };
  if (views[k] && viewer.model) { viewer.fit(viewer.model, views[k]); return; }
  switch (k) {
    case 'o': runAction('open'); break;
    case 'f': runAction('fit'); break;
    case 'm': if (viewer.model) setTool('measure'); break;
    case 'p': if (viewer.model) setTool('paint'); break;
    case 'x': if (viewer.model) setTool('section'); break;
    case 'w': editor.setGizmo(editor.gizmo === 'translate' ? 'none' : 'translate'); break;
    case 'e': editor.setGizmo(editor.gizmo === 'rotate' ? 'none' : 'rotate'); break;
    case 'r': editor.setGizmo(editor.gizmo === 'scale' ? 'none' : 'scale'); break;
    case 'h': if (editor.selected) { editor.toggleVisibility(editor.selected); } break;
    case 'delete': case 'backspace': editor.deleteSelected(); break;
    case 'escape':
      if (state.tool !== 'none') setTool('none');
      else if (editor.gizmo !== 'none') editor.setGizmo('none');
      else selectObject(null);
      break;
    case '?': runAction('help'); break;
    default: return;
  }
  updateToolbar();
});

// ------------------------------------------------------------------ change wiring
history.onChange(() => { updateToolbar(); });
editor.onEdited = () => { refreshStats(250); renderTree(); };
editor.onChange(() => { updateToolbar(); renderDetailsSoon(); });
measure.onChange(() => renderDetailsSoon());
let detailsRaf = 0;
function renderDetailsSoon() { cancelAnimationFrame(detailsRaf); detailsRaf = requestAnimationFrame(renderDetails); }
// live-update the numeric transform fields while dragging the gizmo
editor.transform.addEventListener('objectChange', () => updateTransformFields());

function renderAll() {
  renderTree();
  renderMaterials();
  renderDetails();
  renderSettings();
  updateToolbar();
  updateStatus();
}

function updateStatus() {
  const s = state.stats;
  $('#statusLeft').textContent = viewer.model ? state.modelName : 'Ready · drop a 3D file anywhere';
  $('#statusRight').textContent = s && viewer.model
    ? `${fmtInt(s.triangles)} tris · ${fmtInt(s.vertices + s.points)} verts · ${fmtLen(s.size.x, state.unit, 2)} × ${fmtLen(s.size.y, state.unit, 2)} × ${fmtLen(s.size.z, state.unit, 2)}`
    : '';
}

// ------------------------------------------------------------------ scene tree
function kindIcon(o: any) {
  if (o.isMesh) return 'mesh';
  if (o.isPoints) return 'points';
  if (o.isLine) return 'ruler';
  return 'group';
}

function renderTree() {
  const host = $('#tab-scene');
  const model = viewer.model;
  if (!model) { host.innerHTML = '<div class="empty">No model loaded.</div>'; return; }
  const LIMIT = 400;
  const build = (o: THREE.Object3D): string => {
    const kids = o.children.filter((c) => !c.userData.helper);
    const open = state.expanded.has(o.uuid);
    const name = o.name || (o as any).type;
    const row = `<div class="node ${editor.selected === o ? 'selected' : ''} ${o.visible ? '' : 'hidden-obj'}" data-uuid="${o.uuid}">
      <span class="caret ${open ? 'open' : ''}">${kids.length ? icon('caret') : ''}</span>
      <span class="kind">${icon(kindIcon(o))}</span>
      <span class="node-name" title="${esc(name)}">${esc(name)}</span>
      <button class="node-btn" data-node="fit" title="Zoom to">${icon('target')}</button>
      <button class="node-btn vis" data-node="vis" title="Show / hide">${icon(o.visible ? 'eye' : 'eyeoff')}</button>
    </div>`;
    let inner = '';
    if (kids.length && open) {
      inner = '<ul>' + kids.slice(0, LIMIT).map((k) => `<li>${build(k)}</li>`).join('') +
        (kids.length > LIMIT ? `<li class="tree-more">+ ${kids.length - LIMIT} more objects</li>` : '') + '</ul>';
    }
    return row + inner;
  };
  host.innerHTML = `<ul class="tree"><li>${build(model)}</li></ul>`;
}

const findByUuid = (uuid: string) => viewer.model?.getObjectByProperty('uuid', uuid) ?? null;

$('#tab-scene').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('.node');
  if (!row) return;
  const obj = findByUuid(row.dataset.uuid!);
  if (!obj) return;
  const btn = t.closest<HTMLElement>('[data-node]');
  if (btn?.dataset.node === 'vis') { editor.toggleVisibility(obj); renderTree(); return; }
  if (btn?.dataset.node === 'fit') { viewer.fit(obj); return; }
  if (t.closest('.caret')) {
    if (state.expanded.has(obj.uuid)) state.expanded.delete(obj.uuid); else state.expanded.add(obj.uuid);
    renderTree();
    return;
  }
  selectObject(obj);
});
$('#tab-scene').addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.node');
  const obj = row && findByUuid(row.dataset.uuid!);
  if (obj) viewer.fit(obj);
});

// ------------------------------------------------------------------ materials tab
function collectMaterials() {
  const map = new Map<THREE.Material, { mat: THREE.Material; meshes: THREE.Mesh[] }>();
  viewer.model?.traverse((o: any) => {
    if (o.userData.helper || !(o.isMesh || o.isPoints)) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => {
      if (!m) return;
      if (!map.has(m)) map.set(m, { mat: m, meshes: [] });
      map.get(m)!.meshes.push(o);
    });
  });
  return [...map.values()];
}

function renderMaterials() {
  const host = $('#tab-materials');
  if ($('#tab-materials').classList.contains('hidden')) return;
  const mats = collectMaterials();
  if (!mats.length) { host.innerHTML = '<div class="empty">No materials.</div>'; return; }
  host.innerHTML = mats.slice(0, 500).map((m, i) => {
    const c: THREE.Color | undefined = (m.mat as any).color;
    const hex = c ? '#' + c.getHexString(THREE.SRGBColorSpace) : '#888888';
    const meta = [(m.mat as any).map ? 'textured' : '', (m.mat as any).vertexColors ? 'vertex colours' : '', `${m.meshes.length} part${m.meshes.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    return `<div class="mat-row" data-mat="${i}">
      <label class="swatch" style="background:${hex}" title="Change colour for every part using this material"><input type="color" value="${hex}" data-matcolor="${i}" /></label>
      <div class="mat-name">${esc(m.mat.name || `Material ${i + 1}`)}<div class="mat-meta">${meta}</div></div>
      <button class="node-btn" style="opacity:1" data-matselect="${i}" title="Select first part">${icon('target')}</button>
    </div>`;
  }).join('');
  host.oninput = (e) => {
    const inp = e.target as HTMLInputElement;
    if (!inp.dataset.matcolor) return;
    const m: any = mats[Number(inp.dataset.matcolor)].mat;
    m.color?.set(inp.value);
    (inp.parentElement as HTMLElement).style.background = inp.value;
  };
  host.onchange = (e) => {
    const inp = e.target as HTMLInputElement;
    if (!inp.dataset.matcolor) return;
    const m: any = mats[Number(inp.dataset.matcolor)].mat;
    const before = (inp.defaultValue);
    const after = inp.value;
    inp.defaultValue = after;
    history.push({
      label: 'Material colour',
      undo: () => { m.color?.set(before); renderMaterials(); renderDetails(); },
      redo: () => { m.color?.set(after); renderMaterials(); renderDetails(); },
    });
  };
  host.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-matselect]');
    if (b) { const mesh = mats[Number(b.dataset.matselect)].meshes[0]; selectObject(mesh); viewer.fit(mesh); }
  };
}

// ------------------------------------------------------------------ details panel
const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

function dimsHtml(size: THREE.Vector3) {
  return `<div class="dims">
    <div class="dim"><b>X · WIDTH</b><span>${fmtLen(size.x, state.unit, 2)}</span></div>
    <div class="dim"><b>Y · HEIGHT</b><span>${fmtLen(size.y, state.unit, 2)}</span></div>
    <div class="dim"><b>Z · DEPTH</b><span>${fmtLen(size.z, state.unit, 2)}</span></div>
  </div>`;
}

function toolSection(): string {
  const u = UNITS[state.unit].short;
  switch (state.tool) {
    case 'measure': {
      const items = measure.list.slice().reverse().map((m) => `
        <div class="measure-item">
          <div class="mi-body">
            <div class="mi-main">#${m.id} &nbsp;${fmtLen(m.distance, state.unit)}</div>
            <div class="mi-sub">ΔX ${fmtNum(m.delta.x)} · ΔY ${fmtNum(m.delta.y)} · ΔZ ${fmtNum(m.delta.z)} ${u}</div>
            ${m.angle !== null ? `<div class="mi-sub">Angle between faces ${fmtNum(m.angle, 2)}°</div>` : ''}
            ${m.parallelDistance !== null ? `<div class="mi-sub">Parallel faces gap ${fmtLen(m.parallelDistance, state.unit)}</div>` : ''}
          </div>
          <button class="node-btn" style="opacity:1" data-mremove="${m.id}" title="Remove">${icon('x')}</button>
        </div>`).join('');
      return `<div class="section">
        <div class="section-head"><span class="section-title">Measure</span><span class="grow"></span>
          ${measure.list.length ? `<button class="chip danger" data-mclear>${icon('trash')}Clear</button>` : ''}</div>
        <p class="note" style="margin-top:0">Click a first point, then a second point on the model.</p>
        <label class="check"><input type="checkbox" data-msnap ${measure.snap ? 'checked' : ''}/> Snap to corners</label>
        ${items || ''}
      </div>`;
    }
    case 'paint': {
      const hex = '#' + paint.color.getHexString(THREE.SRGBColorSpace);
      return `<div class="section">
        <div class="section-head"><span class="section-title">Paint</span></div>
        <div class="seg"><button class="${paint.mode === 'brush' ? 'active' : ''}" data-pmode="brush">Brush</button><button class="${paint.mode === 'object' ? 'active' : ''}" data-pmode="object">Whole part</button></div>
        <div class="row"><label>Colour</label><input type="color" value="${hex}" data-pcolor /><span class="grow"></span></div>
        <div class="palette">${PAINT_COLORS.map((c) => `<button style="background:${c}" data-pswatch="${c}" class="${c === hex ? 'active' : ''}" aria-label="${c}"></button>`).join('')}</div>
        ${paint.mode === 'brush' ? `<div class="row"><label>Brush size</label><input type="range" min="0.005" max="0.2" step="0.005" value="${paint.radius}" data-pradius /></div>` : ''}
        <p class="note">Brush paint is saved as vertex colours, so it is kept when you export to GLB or PLY. Undo with Ctrl+Z.</p>
      </div>`;
    }
    case 'section': {
      const s = viewer.section;
      return `<div class="section">
        <div class="section-head"><span class="section-title">Section plane</span><span class="grow"></span>
          <label class="check" style="margin:0"><input type="checkbox" data-secon ${s.enabled ? 'checked' : ''}/> On</label></div>
        <div class="row"><label>Axis</label><div class="seg">${(['x', 'y', 'z'] as Axis[]).map((a) => `<button class="${s.axis === a ? 'active' : ''}" data-secaxis="${a}">${a.toUpperCase()}</button>`).join('')}</div></div>
        <div class="row"><label>Position</label><input type="range" min="0" max="1" step="0.001" value="${s.t}" data-secpos /></div>
        <label class="check"><input type="checkbox" data-secflip ${s.flip ? 'checked' : ''}/> Flip side</label>
        <label class="check"><input type="checkbox" data-seccaps ${capsEnabled ? 'checked' : ''}/> Solid cut faces</label>
        <div class="btn-row"><button class="chip" data-tool="cut">${icon('cut')}Cut here…</button></div>
      </div>`;
    }
    case 'explode':
      return `<div class="section">
        <div class="section-head"><span class="section-title">Explode</span></div>
        <div class="row"><label>Amount</label><input type="range" min="0" max="2" step="0.01" value="${viewer.explode}" data-explode /></div>
        <p class="note">Moves each part away from the centre. Works best on assemblies with several parts.</p>
      </div>`;
  }
  const p = panels.get(state.tool);
  if (p) return `<div class="section" data-panel="${p.id}"><div class="section-head"><span class="section-title">${esc(p.label)}</span><span class="grow"></span><button class="node-btn" style="opacity:1" data-tool="${p.id}" title="Close">${icon('x')}</button></div>${p.render()}</div>`;
  return '';
}

function selectionSection(): string {
  const o = editor.selected;
  if (!o) return `<div class="section"><div class="section-head"><span class="section-title">Selection</span></div>
    <p class="note" style="margin:0">Click a part in the viewport or the scene list to inspect, move, recolour or delete it.</p></div>`;
  const box = viewer.bounds(o);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  const mesh = (o as any).isMesh ? (o as THREE.Mesh) : null;
  const isRoot = o === viewer.model;
  let matHtml = '';
  if (mesh) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mi = Math.min(Number(store.get('matIndex', '0')), mats.length - 1);
    const m: any = mats[mi] ?? mats[0];
    const hex = m?.color ? '#' + m.color.getHexString(THREE.SRGBColorSpace) : '#cccccc';
    const g = mesh.geometry;
    matHtml = `<div class="section">
      <div class="section-head"><span class="section-title">Material</span></div>
      ${mats.length > 1 ? `<div class="row"><label>Slot</label><select data-matidx>${mats.map((mm: any, i: number) => `<option value="${i}" ${i === mi ? 'selected' : ''}>${esc(mm.name || 'Material ' + (i + 1))}</option>`).join('')}</select></div>` : ''}
      <div class="row"><label>Colour</label><input type="color" value="${hex}" data-mprop="color" ${m?.color ? '' : 'disabled'}/><span class="grow" style="font:11px var(--mono);color:var(--muted)">${esc(m?.type || '')}</span></div>
      ${'metalness' in (m || {}) ? `<div class="row"><label>Metalness</label><input type="range" min="0" max="1" step="0.01" value="${m.metalness}" data-mprop="metalness"/></div>` : ''}
      ${'roughness' in (m || {}) ? `<div class="row"><label>Roughness</label><input type="range" min="0" max="1" step="0.01" value="${m.roughness}" data-mprop="roughness"/></div>` : ''}
      <div class="row"><label>Opacity</label><input type="range" min="0.05" max="1" step="0.01" value="${m?.userData?.orig?.opacity ?? m?.opacity ?? 1}" data-mprop="opacity"/></div>
      <dl class="kv" style="margin-top:10px">
        <dt>Vertices</dt><dd>${fmtInt(g.attributes.position?.count || 0)}</dd>
        <dt>Triangles</dt><dd>${fmtInt(Math.floor((g.index ? g.index.count : g.attributes.position?.count || 0) / 3))}</dd>
        <dt>Textures</dt><dd>${Object.keys(m || {}).filter((k) => m[k]?.isTexture).join(', ') || 'none'}</dd>
      </dl>
    </div>`;
  }
  return `<div class="section">
    <div class="section-head"><span class="section-title">Selection</span><span class="grow"></span>
      <button class="node-btn" style="opacity:1" data-sel="deselect" title="Deselect">${icon('x')}</button></div>
    <div class="row" style="margin-top:0"><input type="text" value="${esc(o.name)}" placeholder="Name" data-rename /></div>
    <div style="margin-top:10px">${dimsHtml(size)}</div>
    <div class="row"><label>Position</label><div class="xyz">${xyzInputs('pos', o.position.toArray())}</div></div>
    <div class="row"><label>Rotation°</label><div class="xyz">${xyzInputs('rot', [deg(o.rotation.x), deg(o.rotation.y), deg(o.rotation.z)])}</div></div>
    <div class="row"><label>Scale</label><div class="xyz">${xyzInputs('scl', o.scale.toArray())}</div></div>
    <div class="btn-row">
      <button class="chip" data-sel="fit">${icon('target')}Zoom</button>
      <button class="chip" data-sel="hide">${icon(o.visible ? 'eyeoff' : 'eye')}${o.visible ? 'Hide' : 'Show'}</button>
      <button class="chip" data-sel="isolate">${icon('isolate')}Isolate</button>
      ${isRoot ? '' : `<button class="chip" data-sel="dup">${icon('copy')}Duplicate</button>`}
      <button class="chip" data-sel="floor">${icon('floor')}To floor</button>
      <button class="chip" data-sel="center">${icon('center')}Centre</button>
      <button class="chip" data-sel="mx">${icon('mirror')}Mirror X</button>
      <button class="chip" data-sel="my">${icon('mirror')}Y</button>
      <button class="chip" data-sel="mz">${icon('mirror')}Z</button>
      <button class="chip" data-sel="reset">${icon('reset')}Reset</button>
      ${isRoot ? '' : `<button class="chip danger" data-sel="delete">${icon('trash')}Delete</button>`}
    </div>
  </div>${matHtml}`;
}

function xyzInputs(key: string, v: number[]) {
  return v.map((n, i) => `<input type="number" step="any" data-xyz="${key}" data-i="${i}" value="${Number(n.toFixed(4))}" title="${'XYZ'[i]}" />`).join('');
}

function updateTransformFields() {
  const o = editor.selected;
  if (!o) return;
  const vals: Record<string, number[]> = {
    pos: o.position.toArray(),
    rot: [deg(o.rotation.x), deg(o.rotation.y), deg(o.rotation.z)],
    scl: o.scale.toArray(),
  };
  $$<HTMLInputElement>('[data-xyz]').forEach((inp) => {
    if (document.activeElement !== inp) inp.value = String(Number(vals[inp.dataset.xyz!][Number(inp.dataset.i)].toFixed(4)));
  });
}

function modelSection(): string {
  const s = state.stats;
  if (!viewer.model || !s) return '';
  const u = UNITS[state.unit].short;
  return `<div class="section" id="sec-model">
    <div class="section-head"><span class="section-title">Model</span><span class="grow"></span>
      <select data-unit style="width:auto;height:26px">${Object.entries(UNITS).map(([k, v]) => `<option value="${k}" ${k === state.unit ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    <div style="font-size:13px;margin:-2px 0 10px;overflow-wrap:anywhere">${esc(state.modelName)}</div>
    ${dimsHtml(s.size)}
    <dl class="kv">
      <dt>Parts</dt><dd>${fmtInt(s.meshes)}</dd>
      <dt>Vertices</dt><dd>${fmtInt(s.vertices)}</dd>
      <dt>Triangles</dt><dd>${fmtInt(s.triangles)}</dd>
      ${s.points ? `<dt>Points</dt><dd>${fmtInt(s.points)}</dd>` : ''}
      <dt>Materials</dt><dd>${fmtInt(s.materials)}</dd>
      <dt>Textures</dt><dd>${fmtInt(s.textures)}</dd>
      <dt>Surface area</dt><dd>${fmtNum(s.area, 2)} ${u}²</dd>
      <dt>Volume</dt><dd title="${s.closed ? 'Closed (watertight) mesh' : 'Mesh is not closed: volume is an estimate'}">${s.meshes ? `${fmtNum(s.volume, 2)} ${u}³${s.closed ? '' : ' ≈'}` : '–'}</dd>
      <dt>Watertight</dt><dd>${s.meshes ? (s.closed ? 'yes' : 'no') : '–'}</dd>
      <dt>Centre</dt><dd>${fmtNum(s.center.x, 2)}, ${fmtNum(s.center.y, 2)}, ${fmtNum(s.center.z, 2)}</dd>
    </dl>
    ${viewer.clips.length ? `<div class="row"><label>Animation</label><select data-anim><option value="-1">None</option>${viewer.clips.map((c, i) => `<option value="${i}" ${viewer.activeAction?.getClip() === c ? 'selected' : ''}>${esc(c.name || 'Clip ' + (i + 1))}</option>`).join('')}</select></div>` : ''}
  </div>
  <div class="section" id="sec-scale">
    <div class="section-head"><span class="section-title">Scale & size</span></div>
    <div class="row"><label>Scale by</label><input type="number" step="any" value="1" min="0" data-scalefactor style="width:90px"/><span class="grow"></span><button class="chip" data-scaleapply>Apply</button></div>
    <div class="row"><label>Set size</label>
      <select data-sizeaxis style="width:62px"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
      <input type="number" step="any" value="${Number(s.size.x.toFixed(3))}" data-sizevalue/><span style="font-size:12px;color:var(--muted)">${u}</span>
      <button class="chip" data-sizeapply>Set</button></div>
    <label class="check"><input type="checkbox" data-sizeuniform checked/> Keep proportions</label>
    <div class="row"><label>Convert</label>
      <select data-convfrom style="width:auto">${unitOptions(state.unit)}</select><span style="color:var(--muted)">→</span>
      <select data-convto style="width:auto">${unitOptions(state.unit === 'mm' ? 'in' : 'mm')}</select>
      <button class="chip" data-convapply>Go</button></div>
    <p class="note">Scales the ${editor.selected && editor.selected !== viewer.model ? 'selected part' : 'whole model'}. Convert rescales the geometry so the numbers match the new unit (e.g. inches → mm).</p>
  </div>`;
}

const unitOptions = (sel: string) => Object.entries(UNITS).filter(([k]) => k !== 'u').map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.short}</option>`).join('');

function supportBox() {
  return `<div class="support-box">
    <strong>${icon('heart', 'inline')} Free forever. No ads.</strong>
    <p>${CONFIG.appName} is free and open source. To support hosting and development, donations are welcome.</p>
    <button class="btn-outline small" data-action="support">Support the project</button>
  </div>`;
}

function renderDetails() {
  const host = $('#rtab-details');
  if (!viewer.model) {
    host.innerHTML = `<div class="empty">Open a model to see its size, parts and tools.</div>${supportBox()}`;
    hydrateIcons(host);
    return;
  }
  const scroll = host.scrollTop;
  host.innerHTML = toolSection() + selectionSection() + modelSection() + costSection() + supportBox();
  host.scrollTop = scroll;
  const p = panels.get(state.tool);
  const sec = host.querySelector<HTMLElement>('[data-panel]');
  if (p?.bind && sec) p.bind(sec);
}

// Details panel events (delegated)
const details = $('#rtab-details');
details.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-sel],[data-mremove],[data-mclear],[data-pmode],[data-pswatch],[data-secaxis],[data-scaleapply],[data-sizeapply],[data-convapply]');
  if (!el) return;
  const d = el.dataset;
  const o = editor.selected;
  if (d.sel && o) {
    switch (d.sel) {
      case 'deselect': selectObject(null); break;
      case 'fit': viewer.fit(o); break;
      case 'hide': editor.toggleVisibility(o); renderTree(); break;
      case 'isolate': isolate(o); break;
      case 'dup': editor.duplicateSelected(); break;
      case 'delete': editor.deleteSelected(); break;
      case 'floor': editor.dropToFloor(); break;
      case 'center': editor.centerOnOrigin(); break;
      case 'mx': editor.mirror('x'); break;
      case 'my': editor.mirror('y'); break;
      case 'mz': editor.mirror('z'); break;
      case 'reset': editor.resetTransform(); break;
    }
    renderDetails();
  }
  if (d.mremove) measure.remove(Number(d.mremove));
  if ('mclear' in d) measure.clear();
  if (d.pmode) { paint.mode = d.pmode as any; setTool('paint'); setTool('paint'); }
  if (d.pswatch) { paint.color.set(d.pswatch); renderDetails(); }
  if (d.secaxis) viewer.setSection({ axis: d.secaxis as Axis });
  if ('scaleapply' in d) {
    const f = Number(($('[data-scalefactor]') as HTMLInputElement).value);
    if (f > 0) { editor.scaleBy(f, f, f, editor.selected && editor.selected !== viewer.model ? editor.selected : viewer.model!); viewer.fit(); }
  }
  if ('sizeapply' in d) {
    const axis = ($('[data-sizeaxis]') as HTMLSelectElement).value as Axis;
    const target = Number(($('[data-sizevalue]') as HTMLInputElement).value);
    const obj = editor.selected && editor.selected !== viewer.model ? editor.selected : viewer.model!;
    const cur = viewer.bounds(obj).getSize(new THREE.Vector3())[axis];
    if (target > 0 && cur > 0) {
      const f = target / cur;
      const uniform = ($('[data-sizeuniform]') as HTMLInputElement).checked;
      // Scale factors are applied in local axes; map the chosen view axis for Z-up models.
      const local = viewer.upAxis === 'z' && obj === viewer.model ? ({ x: 'x', y: 'z', z: 'y' } as const)[axis] : axis;
      editor.scaleBy(uniform || local === 'x' ? f : 1, uniform || local === 'y' ? f : 1, uniform || local === 'z' ? f : 1, obj);
      viewer.fit();
    }
  }
  if ('convapply' in d) {
    const from = ($('[data-convfrom]') as HTMLSelectElement).value as Unit;
    const to = ($('[data-convto]') as HTMLSelectElement).value as Unit;
    const f = UNITS[from].toMeters / UNITS[to].toMeters;
    if (f !== 1) { editor.scaleBy(f, f, f, viewer.model!); setUnit(to); viewer.fit(); toast(`Converted ${UNITS[from].short} → ${UNITS[to].short} (×${fmtNum(f, 4)})`); }
  }
});

details.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.pcolor !== undefined) paint.color.set(t.value);
  if (d.pradius !== undefined) paint.radius = Number(t.value);
  if (d.secpos !== undefined) viewer.setSection({ t: Number(t.value) });
  if (d.explode !== undefined) viewer.setExplode(Number(t.value));
  // live material preview; committed with undo on 'change'
  if (d.mprop && editor.selected && (editor.selected as any).isMesh) {
    const mesh = editor.selected as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const m: any = mats[Math.min(Number(store.get('matIndex', '0')), mats.length - 1)];
    if (!m.userData.preview) m.userData.preview = { color: m.color?.getHex(), metalness: m.metalness, roughness: m.roughness, opacity: m.userData?.orig?.opacity ?? m.opacity };
    if (d.mprop === 'color') m.color?.set(t.value);
    else if (d.mprop === 'opacity') { m.opacity = Number(t.value); m.transparent = m.opacity < 1; }
    else m[d.mprop] = Number(t.value);
  }
});

details.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  const o = editor.selected;
  if (d.msnap !== undefined) measure.snap = t.checked;
  if (d.secon !== undefined) viewer.setSection({ enabled: t.checked });
  if (d.secflip !== undefined) viewer.setSection({ flip: t.checked });
  if (d.seccaps !== undefined) setCaps(t.checked);
  if (d.unit !== undefined) { setUnit(t.value as Unit, true); hideUnitHint(); }
  if (d.anim !== undefined) viewer.playClip(Number(t.value));
  if (d.matidx !== undefined) { store.set('matIndex', t.value); renderDetails(); }
  if (d.rename !== undefined && o) editor.rename(o, t.value);
  if (d.xyz && o) {
    const i = Number(d.i);
    const v = Number(t.value);
    if (!isFinite(v)) return;
    editor.transformObject(o, 'Edit transform', (obj) => {
      if (d.xyz === 'pos') obj.position.setComponent(i, v);
      if (d.xyz === 'scl') obj.scale.setComponent(i, v || 1e-6);
      if (d.xyz === 'rot') { const r = obj.rotation.toArray().slice(0, 3) as number[]; r[i] = rad(v); obj.rotation.set(r[0], r[1], r[2]); }
    });
    refreshStats(100);
  }
  if (d.mprop && o && (o as any).isMesh) {
    const mesh = o as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const idx = Math.min(Number(store.get('matIndex', '0')), mats.length - 1);
    const m: any = mats[idx];
    // restore the preview, then apply as an undoable change on a cloned material
    if (m.userData.preview) {
      const p = m.userData.preview;
      if (p.color !== undefined) m.color?.setHex(p.color);
      m.metalness = p.metalness; m.roughness = p.roughness; m.opacity = p.opacity; m.transparent = p.opacity < 1;
      delete m.userData.preview;
    }
    const value = d.mprop === 'color' ? t.value : Number(t.value);
    editor.setMaterial(mesh, idx, { [d.mprop]: value }, 'Edit material');
    renderMaterials();
  }
});

function isolate(obj: THREE.Object3D) {
  const keep = new Set<THREE.Object3D>();
  obj.traverse((o) => keep.add(o));
  let p: THREE.Object3D | null = obj;
  while (p) { keep.add(p); p = p.parent; }
  const allVisible = !viewer.model!.getObjectsByProperty('visible', false).length;
  viewer.model!.traverse((o) => {
    if (o.userData.helper) return;
    o.visible = allVisible ? keep.has(o) || isDescendantOfKeep(o, obj) : true;
  });
  renderTree();
  refreshStats(100);
  toast(allVisible ? 'Isolated · click Isolate again to show everything' : 'Showing everything');
}
const isDescendantOfKeep = (o: THREE.Object3D, root: THREE.Object3D) => { let p: THREE.Object3D | null = o; while (p) { if (p === root) return true; p = p.parent; } return false; };

// ------------------------------------------------------------------ settings panel
function renderSettings() {
  const host = $('#rtab-settings');
  const bg = viewer.background || '#151515';
  host.innerHTML = `<div class="section">
      <div class="section-head"><span class="section-title">View</span></div>
      <div class="row"><label>Up axis</label><div class="seg"><button class="${viewer.upAxis === 'y' ? 'active' : ''}" data-up="y">Y up</button><button class="${viewer.upAxis === 'z' ? 'active' : ''}" data-up="z">Z up</button></div></div>
      <div class="row"><label>Camera</label><div class="seg"><button class="${viewer.camera === viewer.perspective ? 'active' : ''}" data-proj="perspective">Perspective</button><button class="${viewer.camera === viewer.ortho ? 'active' : ''}" data-proj="orthographic">Ortho</button></div></div>
      <div class="row"><label>Display</label><select data-dmode>${(['shaded', 'flat', 'wireframe', 'xray'] as DisplayMode[]).map((m) => `<option value="${m}" ${viewer.displayMode === m ? 'selected' : ''}>${m === 'xray' ? 'X-ray' : m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" data-set="edges" ${viewer.showEdges ? 'checked' : ''}/> Show edges</label>
      <label class="check"><input type="checkbox" data-set="grid" ${viewer.showGrid ? 'checked' : ''}/> Show grid</label>
      <label class="check"><input type="checkbox" data-set="axes" ${viewer.showAxes ? 'checked' : ''}/> Show axes</label>
      <label class="check"><input type="checkbox" data-set="autorotate" ${viewer.controls.autoRotate ? 'checked' : ''}/> Auto-rotate</label>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Environment</span></div>
      <div class="row"><label>Lighting</label><select data-light><option value="studio">Studio</option><option value="soft">Soft</option><option value="flat">Flat (no reflections)</option></select></div>
      <div class="row"><label>Background</label><input type="color" value="${bg}" data-bg /><span class="grow"></span><button class="chip" data-bgreset>Default</button></div>
      <div class="palette">${['#151515', '#0a0a0a', '#2b2b2b', '#5a5a5a', '#ebebea', '#ffffff', '#1d2a3a', '#2a1d1d'].map((c) => `<button style="background:${c}" data-bgswatch="${c}" aria-label="${c}"></button>`).join('')}</div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Editing</span></div>
      <label class="check"><input type="checkbox" data-set="snap" ${editor.snap ? 'checked' : ''}/> Snap move / rotate / scale</label>
      <label class="check"><input type="checkbox" data-set="msnap" ${measure.snap ? 'checked' : ''}/> Snap measurements to corners</label>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Interface</span></div>
      <div class="row"><label>Theme</label><div class="seg"><button class="${document.documentElement.dataset.theme === 'dark' ? 'active' : ''}" data-themeset="dark">Dark</button><button class="${document.documentElement.dataset.theme === 'light' ? 'active' : ''}" data-themeset="light">Light</button></div></div>
      <div class="row"><label>CAD quality</label><select data-cadq>${Object.entries(CAD_QUALITY).map(([k, v]) => `<option value="${k}" ${k === cadQuality() ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="row"><label>App</label><button class="chip" data-install>${icon('download')}Install ${CONFIG.appName}</button></div>
      <p class="note">Install it to use ${CONFIG.appName} like a desktop app, also offline. Your files are processed locally in this browser. Nothing is uploaded.</p>
    </div>${supportBox()}`;
  ($('[data-light]', host) as HTMLSelectElement).value = store.get('light', 'studio');
}

const settings = $('#rtab-settings');
settings.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-install]')) { installApp(); return; }
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-up],[data-proj],[data-bgswatch],[data-bgreset],[data-themeset]');
  if (!el) return;
  const d = el.dataset;
  if (d.up) { viewer.setUpAxis(d.up as 'y' | 'z'); if (state.ext) rememberPref(state.ext, { up: d.up as 'y' | 'z' }); }
  if (d.proj) viewer.setProjection(d.proj as any);
  if (d.bgswatch) { state.bgCustom = d.bgswatch; store.set('bg', d.bgswatch); viewer.setBackground(d.bgswatch); }
  if ('bgreset' in d) { state.bgCustom = null; store.set('bg', ''); applyTheme(document.documentElement.dataset.theme as any); }
  if (d.themeset) applyTheme(d.themeset as any);
  renderSettings();
  updateToolbar();
  refreshStats(50);
});
settings.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.bg !== undefined) { state.bgCustom = t.value; store.set('bg', t.value); viewer.setBackground(t.value); }
});
settings.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.dmode) viewer.setDisplayMode(t.value as DisplayMode);
  if (d.cadq !== undefined) { try { localStorage.setItem('omniview.cadQuality', t.value); } catch { /* private mode */ } toast('CAD quality saved · applies to STEP / IGES / BREP files you open next'); }
  if (d.light) { viewer.setLighting(t.value as any); store.set('light', t.value); }
  if (d.set === 'edges') viewer.setEdges(t.checked);
  if (d.set === 'grid') viewer.setGrid(t.checked);
  if (d.set === 'axes') viewer.setAxes(t.checked);
  if (d.set === 'autorotate') viewer.setAutoRotate(t.checked);
  if (d.set === 'snap') editor.setSnap(t.checked);
  if (d.set === 'msnap') measure.snap = t.checked;
  updateToolbar();
});
viewer.setLighting(store.get('light', 'studio') as any);

// ------------------------------------------------------------------ dialogs
const modal = $('#modal') as HTMLDialogElement;
function openModal(html: string) {
  $('#modalCard').innerHTML = `<button class="modal-close" data-modal-close aria-label="Close">${icon('x')}</button>${html}`;
  if (!modal.open) modal.showModal();
}
modal.addEventListener('click', (e) => {
  if (e.target === modal || (e.target as HTMLElement).closest('[data-modal-close]')) modal.close();
});

function showUrlDialog() {
  openModal(`<h2>Open a model URL</h2>
    <p>Paste one or more direct links to model files (one per line). Add texture/.mtl/.bin links too if the model needs them.</p>
    <textarea id="urlInput" rows="4" placeholder="https://example.com/model.glb"></textarea>
    <p class="note">The site hosting the file must allow cross-origin downloads (GitHub raw links, most CDNs and cloud storage public links work).</p>
    <div class="modal-actions"><button class="btn-outline" data-modal-close>Cancel</button><button class="btn-solid" id="urlGo">Open</button></div>`);
  $('#urlGo').onclick = () => {
    const urls = ($('#urlInput') as HTMLTextAreaElement).value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    modal.close();
    openUrls(urls);
  };
  setTimeout(() => $('#urlInput').focus(), 50);
}

function baseFileName() {
  const n = state.modelName.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim();
  return n || 'model';
}

async function runExport(id: ExportId, part: THREE.Object3D | null = null, zUp = viewer.upAxis === 'y' && ['stl', 'stl-ascii', '3mf', 'obj'].includes(id)) {
  const f = EXPORT_FORMATS.find((x) => x.id === id)!;
  setLoading(`Exporting ${f.label}…`);
  try {
    const blob = await exportModel(viewer, id, part ?? undefined, { unit: state.unit, zUp });
    download(blob, `${baseFileName()}${part ? '-' + (part.name || 'part').replace(/[^\w\-]+/g, '') : ''}.${f.ext}`);
    toast(`Exported ${f.label}`);
  } catch (err: any) {
    console.error(err);
    toast(`Export failed: ${err?.message || err}`, true);
  } finally { setLoading(null); }
}

const autoKey = (id: string) => 'auto.' + id;
function showExportDialog(preferred?: ExportId, partOverride?: THREE.Object3D) {
  if (!viewer.model) return;
  const formats = preferred
    ? [...EXPORT_FORMATS].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
    : [...EXPORT_FORMATS];
  const sel = partOverride ?? (editor.selected && editor.selected !== viewer.model ? editor.selected : null);
  openModal(`<h2>Export as another format</h2>
    <p>Converts the current scene, including your edits and paint, and downloads it.</p>
    ${sel ? `<label class="check" style="margin-bottom:6px"><input type="checkbox" id="exportSel" ${partOverride ? 'checked' : ''}/> Only the selected part (${esc(sel.name || 'object')})</label>` : ''}
    ${viewer.upAxis === 'y' ? `<label class="check" style="margin-bottom:6px"><input type="checkbox" id="exportZup" checked/> Stand upright for 3D printing (Z-up) in STL, 3MF and OBJ</label>` : ''}
    ${preferred ? `<label class="check" style="margin-bottom:6px"><input type="checkbox" id="exportAuto" ${store.get(autoKey(preferred), '') ? 'checked' : ''}/> On this page, download automatically next time (skip this window)</label>` : ''}
    <div class="export-grid">${formats.map((f) => `<button class="export-opt ${f.id === preferred ? 'preferred' : ''}" data-export="${f.id}"><div><b>${f.label}</b><small>${f.id === preferred ? 'Click to download · ' : ''}${f.note}</small></div><span class="ext">.${f.ext}</span></button>`).join('')}</div>`);
  $('#modalCard').onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-export]');
    if (!b) return;
    const id = b.dataset.export as ExportId;
    const onlySel = sel && ($('#exportSel') as HTMLInputElement | null)?.checked;
    const zUp = !!($('#exportZup') as HTMLInputElement | null)?.checked && ['stl', 'stl-ascii', '3mf', 'obj'].includes(id);
    if (preferred) store.set(autoKey(preferred), ($('#exportAuto') as HTMLInputElement | null)?.checked ? '1' : '');
    modal.close();
    await runExport(id, onlySel ? sel : null, zUp);
  };
}

function showScreenshotDialog() {
  openModal(`<h2>Save an image</h2>
    <div class="row"><label>Size</label><div class="seg" id="shotScale"><button data-s="1" class="active">1×</button><button data-s="2">2×</button><button data-s="4">4×</button></div></div>
    <label class="check"><input type="checkbox" id="shotTransparent"/> Transparent background</label>
    <div class="modal-actions"><button class="btn-outline" data-modal-close>Cancel</button><button class="btn-solid" id="shotGo">${icon('camera')} Save PNG</button></div>`);
  let scale = 1;
  $('#shotScale').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
    if (!b) return;
    scale = Number(b.dataset.s);
    $$('#shotScale button').forEach((x) => x.classList.toggle('active', x === b));
  };
  $('#shotGo').onclick = () => {
    const url = viewer.screenshot(scale, ($('#shotTransparent') as HTMLInputElement).checked);
    download(url, `${baseFileName()}.png`);
    modal.close();
  };
}

function showShareDialog() {
  if (!state.sourceUrls) {
    openModal(`<h2>Share a model</h2>
      <p>This model was opened from your device, and ${CONFIG.appName} never uploads your files, so there is no link to share yet.</p>
      <p>To share: put the file somewhere public (for example GitHub, Dropbox or any web host that allows cross-origin downloads), then use <b>Open from URL</b>. The page address becomes a shareable link and you get an embed code.</p>
      <div class="modal-actions"><button class="btn-outline" data-modal-close>Close</button><button class="btn-solid" id="shareUrl">${icon('link')} Open from URL</button></div>`);
    $('#shareUrl').onclick = () => showUrlDialog();
    return;
  }
  const base = location.origin + location.pathname;
  const link = `${base}#model=${state.sourceUrls.map(encodeURIComponent).join(',')}`;
  const embed = `<iframe src="${link}&embed=1" width="640" height="480" style="border:0;border-radius:12px" allowfullscreen></iframe>`;
  openModal(`<h2>Share & embed</h2>
    <div class="field-label" style="margin:10px 0 6px">Link</div><textarea rows="2" readonly id="shareLink">${esc(link)}</textarea>
    <div class="field-label" style="margin:12px 0 6px">Embed code</div><textarea rows="3" readonly id="shareEmbed">${esc(embed)}</textarea>
    <div class="modal-actions"><button class="btn-outline" id="copyEmbed">${icon('copy')} Copy embed</button><button class="btn-solid" id="copyLink">${icon('copy')} Copy link</button></div>`);
  const copy = (txt: string) => navigator.clipboard?.writeText(txt).then(() => toast('Copied'), () => toast('Copy failed: select the text and copy it', true));
  $('#copyLink').onclick = () => copy(link);
  $('#copyEmbed').onclick = () => copy(embed);
}

function showSupportDialog() {
  const has = !!CONFIG.donateUrl;
  openModal(`<h2>Free forever. No ads.</h2>
    <p>${CONFIG.appName} by ${CONFIG.brandName} ${CONFIG.brandSup} is completely free and open source. There are no ads, no accounts, no tracking and no uploads: your models stay on your device.</p>
    <p>Running and improving it still takes time and hosting. If it helps you, a small donation keeps it going.</p>
    <div class="modal-actions">
      <a class="btn-outline" href="${CONFIG.repoUrl}" target="_blank" rel="noopener">${icon('github')} Star on GitHub</a>
      ${has ? `<a class="btn-solid" href="${CONFIG.donateUrl}" target="_blank" rel="noopener">${icon('heart')} ${esc(CONFIG.donateLabel)}</a>`
        : `<button class="btn-solid" disabled title="Donations are being set up">${icon('heart')} Donations coming soon</button>`}
    </div>`);
}

function showHelpDialog() {
  const sc: [string, string][] = [
    ['Open files', 'O'], ['Fit to window', 'F'], ['Camera views', '1 – 7'], ['Measure', 'M'], ['Paint', 'P'], ['Section plane', 'X'],
    ['Move / Rotate / Scale', 'W / E / R'], ['Hide selected', 'H'], ['Delete selected', 'Del'], ['Duplicate', 'Ctrl+D'],
    ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Cancel tool / deselect', 'Esc'], ['Zoom to part', 'Double-click'],
  ];
  openModal(`<h2>How to use ${CONFIG.appName}</h2>
    <p>Drop files (or a whole folder or .zip) anywhere on the page. For models with textures, drop the textures, .mtl or .bin files together with the model. Orbit with the left mouse button, pan with the right, zoom with the wheel.</p>
    <div class="shortcuts">${sc.map(([a, k]) => `<span>${a}</span><kbd>${k}</kbd>`).join('')}</div>
    <p class="note" style="margin-top:14px">Supported: ${FORMATS.map((f) => f.name).join(', ')}.</p>
    <p class="note">Open source under the MIT licence · <a href="${CONFIG.repoUrl}" target="_blank" rel="noopener">source code</a> · <a href="${CONFIG.brandUrl}" target="_blank" rel="noopener">bankasimedia.com</a></p>`);
}

// ------------------------------------------------------------------ boot
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const model = params.get('model');
  if (params.get('embed') === '1') {
    document.body.classList.add('embed');
    const a = document.createElement('a');
    a.className = 'embed-badge';
    a.href = location.href.replace(/&embed=1/, '');
    a.target = '_blank';
    a.innerHTML = `${CONFIG.appName} <span style="opacity:.6">by ${CONFIG.brandName} ${CONFIG.brandSup}</span>`;
    $('#stage').appendChild(a);
  }
  if (model) openUrls(model.split(',').map((u) => decodeURIComponent(u)));
}

Object.assign(ctx, {
  viewer, editor, history, toast, setLoading,
  refresh: () => { viewer.rebaseExplode(); refreshStats(50); renderTree(); renderMaterials(); },
  renderDetails,
  unit: () => state.unit,
  fmtLen: (v: number, digits = 3) => fmtLen(v, state.unit, digits),
  setTool: (id: string) => setTool(id),
  activeTool: () => state.tool,
  selectObject,
  openFiles,
  modelName: () => state.modelName,
  baseFileName,
  openModal,
  closeModal: () => modal.close(),
});
initFeatures();
registerCoreCommands();
registerMainContextActions();

if (window.innerWidth < 900) document.body.classList.add('no-left', 'no-right');
renderAll();
renderRecent();

// Offline support: cache the app after the first visit (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; renderSettings(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; toast(`${CONFIG.appName} installed`); renderSettings(); });
function installApp() {
  if (!state.installPrompt) { toast('Use your browser menu → "Install app" (or "Add to Home Screen" on iPhone)'); return; }
  state.installPrompt.prompt();
  state.installPrompt.userChoice.finally(() => { state.installPrompt = null; renderSettings(); });
}
readHash();
window.addEventListener('hashchange', readHash);

// expose for debugging in the console
(window as any).omniview = { viewer, editor, history, measure, paint };


// ------------------------------------------------------------------ unit hint
function showUnitHint(current: Unit, suggest: Unit, why: string) {
  const el = $('#unitHint');
  el.innerHTML = `<span>${esc(why)}</span>
    <button class="chip" data-unithint="${suggest}">Use ${UNITS[suggest].label.toLowerCase()}</button>
    <button class="chip" data-unithint="${current}">Keep ${UNITS[current].short}</button>`;
  el.classList.remove('hidden');
}
function hideUnitHint() { $('#unitHint').classList.add('hidden'); }
$('#unitHint').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-unithint]');
  if (!b) return;
  setUnit(b.dataset.unithint as Unit, true);
  hideUnitHint();
  toast(`Units set to ${UNITS[state.unit].label.toLowerCase()} · remembered for .${state.ext} files`);
});

// ------------------------------------------------------------------ recent files
let recentCache: RecentEntry[] = [];
async function renderRecent() {
  recentCache = await listRecent();
  const host = $('#recentList');
  host.classList.toggle('hidden', !recentCache.length);
  if (!recentCache.length) { host.innerHTML = ''; return; }
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  host.innerHTML = `<div class="recent-head"><span>Recent files</span><button class="link-btn" data-recentclear>Clear</button></div>
    <div class="recent-grid">${recentCache.map((r, i) => `<div class="recent-item" data-recent="${i}" role="button" tabindex="0">
      ${icon(r.urls ? 'link' : 'mesh')}<span class="ri-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="ri-meta">${ago(r.date)}${r.size ? ' · ' + (r.size / 1048576).toFixed(1) + ' MB' : ''}</span>
      <button class="node-btn" data-recentdel="${i}" title="Remove from list">${icon('x')}</button></div>`).join('')}</div>
    <p class="note">Kept only in this browser.</p>`;
}
$('#recentList').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-recentclear]')) { await clearRecent(); renderRecent(); return; }
  const del = t.closest<HTMLElement>('[data-recentdel]');
  if (del) { await removeRecent(recentCache[Number(del.dataset.recentdel)].id); renderRecent(); return; }
  const item = t.closest<HTMLElement>('[data-recent]');
  if (!item) return;
  const r = recentCache[Number(item.dataset.recent)];
  if (r.urls) openUrls(r.urls); else openFiles(entryFiles(r));
});

// ------------------------------------------------------------------ print estimate
const costPrefs = () => {
  const d = { material: 'pla', infill: 20, wall: 1.2, price: '', diameter: 1.75, copies: 1 };
  try { return { ...d, ...JSON.parse(store.get('cost', '{}')) }; } catch { return d; }
};
function costSection(): string {
  const s = state.stats;
  if (!viewer.model || !s || !s.meshes || s.volume <= 0) return '';
  const p = costPrefs();
  const mat = MATERIALS.find((m) => m.id === p.material) ?? MATERIALS[0];
  const price = p.price === '' ? mat.price : Number(p.price);
  const toCm = UNITS[state.unit].toMeters * 100;
  const r = estimate({
    volumeCm3: s.volume * toCm ** 3, areaCm2: s.area * toCm ** 2, material: mat,
    infill: p.infill / 100, wallMm: p.wall, pricePerKg: price, diameterMm: p.diameter, copies: p.copies,
  });
  const unitless = state.unit === 'u';
  return `<div class="section" id="sec-cost">
    <div class="section-head"><span class="section-title">Print estimate</span></div>
    ${unitless ? '<p class="note" style="margin-top:0">Pick real units above (e.g. millimetres) for a meaningful estimate.</p>' : ''}
    <div class="cost-big"><div><b>${fmtNum(r.grams, 1)} g</b><span>weight</span></div>
      ${mat.resin ? `<div><b>${fmtNum(r.grams / mat.density, 1)} ml</b><span>resin</span></div>` : `<div><b>${fmtNum(r.meters, 2)} m</b><span>filament</span></div>`}
      <div><b>${fmtNum(r.cost, 2)}</b><span>material cost</span></div></div>
    <div class="row"><label>Material</label><select data-cost="material">${MATERIALS.map((m) => `<option value="${m.id}" ${m.id === mat.id ? 'selected' : ''}>${m.name}</option>`).join('')}</select></div>
    ${mat.resin ? '' : `<div class="row"><label>Infill</label><input type="range" min="0" max="100" step="5" value="${p.infill}" data-cost="infill"/><span class="cost-val">${p.infill}%</span></div>
    <div class="row"><label>Walls</label><input type="number" step="0.1" min="0" value="${p.wall}" data-cost="wall"/><span class="cost-unit">mm</span></div>`}
    <div class="row"><label>Price / kg</label><input type="number" step="0.5" min="0" value="${price}" data-cost="price"/><span class="cost-unit">${mat.resin ? 'per kg' : ''}</span></div>
    ${mat.resin ? '' : `<div class="row"><label>Filament</label><select data-cost="diameter"><option value="1.75" ${p.diameter == 1.75 ? 'selected' : ''}>1.75 mm</option><option value="2.85" ${p.diameter == 2.85 ? 'selected' : ''}>2.85 mm</option></select></div>`}
    <div class="row"><label>Copies</label><input type="number" step="1" min="1" value="${p.copies}" data-cost="copies"/></div>
    <p class="note">Estimate from the model volume (${s.closed ? 'watertight' : 'not watertight, so less reliable'}), ${mat.resin ? 'printed solid' : 'with walls and infill'}. Solid part: ${fmtNum(r.solidGrams, 1)} g. Supports and purge are not included.</p>
  </div>`;
}
details.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const k = t.dataset.cost;
  if (!k) return;
  const p = costPrefs();
  if (k === 'material') { p.material = t.value; p.price = ''; }
  else if (k === 'price') p.price = t.value;
  else (p as any)[k] = Number(t.value);
  store.set('cost', JSON.stringify(p));
  renderDetails();
});
details.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.cost === 'infill') (t.nextElementSibling as HTMLElement).textContent = t.value + '%';
});

// ------------------------------------------------------------------ core commands (command palette)
function registerCoreCommands() {
  const has = () => !!viewer.model;
  registerCommand(
    { id: 'open', label: 'Open files…', group: 'File', shortcut: 'O', keywords: 'load import browse', run: () => runAction('open') },
    { id: 'url', label: 'Open from URL…', group: 'File', keywords: 'link web', run: () => runAction('url') },
    { id: 'new', label: 'New empty scene', group: 'File', keywords: 'blank start', run: () => runAction('new') },
    { id: 'export', label: 'Export / convert…', group: 'File', keywords: 'save download convert stl obj glb ply usdz 3mf', run: () => runAction('export'), enabled: has },
    ...EXPORT_FORMATS.map((f) => ({ id: 'export-' + f.id, label: `Export as ${f.label}`, group: 'Convert', keywords: `convert save download ${f.ext} ${f.id}`, run: () => runExport(f.id), enabled: has })),
    { id: 'screenshot', label: 'Save screenshot…', group: 'File', keywords: 'image png picture', run: () => runAction('screenshot'), enabled: has },
    { id: 'share', label: 'Share / embed…', group: 'File', keywords: 'link iframe', run: () => runAction('share'), enabled: has },
    { id: 'install', label: 'Install app (works offline)', group: 'File', keywords: 'pwa offline desktop', run: installApp },
    { id: 'fit', label: 'Fit to window', group: 'View', shortcut: 'F', keywords: 'zoom extents', run: () => runAction('fit'), enabled: has },
    ...(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as ViewName[]).map((v, i) => ({ id: 'view-' + v, label: `View: ${v[0].toUpperCase() + v.slice(1)}`, group: 'View', shortcut: String(i + 1), keywords: 'camera', run: () => viewer.fit(viewer.model, v), enabled: has })),
    { id: 'ortho', label: 'Toggle orthographic camera', group: 'View', keywords: 'perspective projection', run: () => viewer.setProjection(viewer.camera === viewer.ortho ? 'perspective' : 'orthographic'), enabled: has },
    ...(['shaded', 'flat', 'wireframe', 'xray'] as DisplayMode[]).map((m) => ({ id: 'display-' + m, label: `Display: ${m === 'xray' ? 'X-ray' : m[0].toUpperCase() + m.slice(1)}`, group: 'View', keywords: 'render mode', run: () => { viewer.setDisplayMode(m); updateToolbar(); }, enabled: has })),
    { id: 'edges', label: 'Toggle edges', group: 'View', keywords: 'outline lines', run: () => { viewer.setEdges(!viewer.showEdges); updateToolbar(); }, enabled: has },
    { id: 'grid', label: 'Toggle grid', group: 'View', run: () => { viewer.setGrid(!viewer.showGrid); updateToolbar(); } },
    { id: 'axes', label: 'Toggle axes', group: 'View', run: () => { viewer.setAxes(!viewer.showAxes); updateToolbar(); } },
    { id: 'upaxis', label: 'Switch Y-up / Z-up', group: 'View', keywords: 'orientation rotate', run: () => { viewer.setUpAxis(viewer.upAxis === 'y' ? 'z' : 'y'); if (state.ext) rememberPref(state.ext, { up: viewer.upAxis }); }, enabled: has },
    { id: 'theme', label: 'Toggle light / dark theme', group: 'View', run: () => runAction('theme') },
    { id: 'measure', label: 'Measure', group: 'Tools', shortcut: 'M', keywords: 'distance ruler angle', run: () => setTool('measure'), enabled: has },
    { id: 'paint', label: 'Paint', group: 'Tools', shortcut: 'P', keywords: 'colour color brush', run: () => setTool('paint'), enabled: has },
    { id: 'section', label: 'Section plane', group: 'Tools', shortcut: 'X', keywords: 'clip cut slice', run: () => setTool('section'), enabled: has },
    { id: 'explode', label: 'Explode view', group: 'Tools', keywords: 'assembly parts apart', run: () => setTool('explode'), enabled: has },
    { id: 'scale', label: 'Scale & resize…', group: 'Tools', keywords: 'size dimensions resize units inches mm', run: () => applyIntent('scale'), enabled: has },
    { id: 'cost', label: 'Print cost & weight estimate', group: 'Tools', keywords: 'filament price grams', run: () => scrollToSection('sec-cost'), enabled: has },
    { id: 'move', label: 'Move selected', group: 'Edit', shortcut: 'W', run: () => editor.setGizmo('translate'), enabled: has },
    { id: 'rotate', label: 'Rotate selected', group: 'Edit', shortcut: 'E', run: () => editor.setGizmo('rotate'), enabled: has },
    { id: 'scale-gizmo', label: 'Scale selected (handles)', group: 'Edit', shortcut: 'R', run: () => editor.setGizmo('scale'), enabled: has },
    { id: 'dup', label: 'Duplicate selected', group: 'Edit', shortcut: 'Ctrl+D', run: () => editor.duplicateSelected(), enabled: () => !!editor.selected },
    { id: 'del', label: 'Delete selected', group: 'Edit', shortcut: 'Del', run: () => editor.deleteSelected(), enabled: () => !!editor.selected },
    { id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', run: () => history.undo(), enabled: () => history.canUndo },
    { id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Y', run: () => history.redo(), enabled: () => history.canRedo },
    { id: 'floor', label: 'Drop to floor', group: 'Edit', run: () => editor.dropToFloor(), enabled: has },
    { id: 'center', label: 'Centre on origin', group: 'Edit', run: () => editor.centerOnOrigin(), enabled: has },
    ...(['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'icosahedron', 'plane'] as Primitive[]).map((k) => ({ id: 'add-' + k, label: `Add ${k}`, group: 'Add', keywords: 'shape primitive', run: () => { editor.addPrimitive(k); document.body.classList.add('has-model'); } })),
    { id: 'help', label: 'Help & keyboard shortcuts', group: 'Help', shortcut: '?', run: () => runAction('help') },
  );
}

function scrollToSection(id: string) {
  document.body.classList.remove('no-right');
  $$('[data-rtab]').forEach((b) => b.classList.toggle('active', b.dataset.rtab === 'details'));
  $('#rtab-details').classList.remove('hidden');
  $('#rtab-settings').classList.add('hidden');
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1800);
  });
}
function applyIntent(tool: string) { const prev = PAGE.tool; PAGE.tool = tool; const to = PAGE.to; PAGE.to = undefined; applyPageIntent(); PAGE.tool = prev; PAGE.to = to; }

$('#loadingCancel').addEventListener('click', () => { state.abort?.abort(); setLoading(null); $('#loadingCancel').classList.add('hidden'); });

// ------------------------------------------------------------------ right-click actions
function registerMainContextActions() {
  const part = (h: THREE.Intersection | null) => !!h;
  const anyHidden = () => !!viewer.model && viewer.model.getObjectsByProperty('visible', false).some((o) => !o.userData.helper);
  registerContextAction(
    { label: 'Zoom to part', icon: 'target', when: part, run: (h) => viewer.fit(h!.object) },
    { label: 'Hide', icon: 'eyeoff', when: part, run: (h) => { editor.toggleVisibility(h!.object); renderTree(); } },
    { label: 'Isolate', icon: 'isolate', when: part, run: (h) => isolate(h!.object) },
    { label: 'Show everything', icon: 'eye', when: anyHidden, run: () => { viewer.model!.traverse((o) => { if (!o.userData.helper) o.visible = true; }); renderTree(); refreshStats(50); } },
    { label: 'Recolour part', icon: 'brush', when: part, run: () => { paint.mode = 'object'; if (state.tool !== 'paint') setTool('paint'); else renderDetails(); toast('Pick a colour, then click the part'); } },
    { label: 'Duplicate', icon: 'copy', when: (h) => !!h && h.object !== viewer.model, run: () => editor.duplicateSelected() },
    { label: 'Export this part…', icon: 'download', when: part, run: (h) => showExportDialog(undefined, h!.object) },
    { label: 'Fit to window', icon: 'fit', when: (h) => !h && !!viewer.model, run: () => viewer.fit() },
    { label: 'Add a box here', icon: 'shapes', when: (h) => !h, run: () => { editor.addPrimitive('box'); document.body.classList.add('has-model'); } },
    { label: 'Save screenshot…', icon: 'camera', when: (h) => !h && !!viewer.model, run: () => showScreenshotDialog() },
    { label: 'All commands…', icon: 'search', when: () => true, run: () => openPalette() },
    { label: 'Delete', icon: 'trash', danger: true, when: (h) => !!h && h.object !== viewer.model, run: () => editor.deleteSelected() },
  );
}

// ------------------------------------------------------------------ paste a file or link to open it
window.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); openFiles(files); return; }
  const text = e.clipboardData?.getData('text')?.trim() || '';
  const urls = text.split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u));
  if (urls.length) { e.preventDefault(); openUrls(urls); }
});

// ------------------------------------------------------------------ first-visit tips
function maybeShowTips() {
  if (store.get('tips', '') || document.body.classList.contains('embed') || $('.tips')) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  const el = document.createElement('div');
  el.className = 'tips';
  el.innerHTML = `<div class="tips-head"><b>Quick tips</b><button class="node-btn" style="opacity:1" aria-label="Close tips">${icon('x')}</button></div>
    <ol>
      <li>${touch ? 'Drag with one finger to orbit, two fingers to pan and pinch to zoom.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click a part to zoom to it.'}</li>
      <li>Click a part to select it. ${touch ? 'Long-press' : 'Right-click'} for actions like hide, isolate and export.</li>
      <li>Press <kbd>Ctrl K</kbd> to search every tool: repair, reduce, cut, convert…</li>
    </ol>
    <button class="btn-outline small" data-tipsok>Got it</button>`;
  $('#stage').appendChild(el);
  const close = () => { store.set('tips', '1'); el.remove(); };
  el.querySelector('[data-tipsok]')!.addEventListener('click', close);
  el.querySelector('.node-btn')!.addEventListener('click', close);
}

// ------------------------------------------------------------------ phone toolbar
$('#mobileBar').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
  if (!b) return;
  const m = b.dataset.m!;
  if (m === 'details') document.body.classList.toggle('no-right');
  else if (m === 'scene') document.body.classList.toggle('no-left');
  else if (m === 'palette') openPalette();
  else if (m === 'measure' || m === 'paint') setTool(m);
  else runAction(m);
});

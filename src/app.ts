import * as THREE from 'three';
import { initLayoutLab, labHome } from './layoutlab';
import { Viewer, disposeObject, type ViewName, type DisplayMode, type Axis } from './viewer';
import { loadFiles, filesFromUrls, pickerAccept, FORMATS, setSharedRenderer, extOf, filePaths, MODEL_EXTS as MODEL_EXTS_APP, type ResourceInfo } from './loaders';
import { detectCapabilities, unavailableReason, type Capabilities } from './capabilities';
import { t, LANG, LANG_PREFIX, applyStaticI18n } from './i18n';
/** Alias for t() where a local variable is named t. */
const tr = (s: string) => (s ? t(s) : '');
import { History } from './history';
import { Editor, type Primitive, type GizmoMode } from './editor';
import { MeasureTool, valueText, type MeasureMode } from './tools/measure';
import { PaintTool } from './tools/paint';
import { computeStats, checkClosedAsync, UNITS, type Unit, fmtLen, fmtNum, fmtInt, type ModelStats } from './stats';
import { EXPORT_FORMATS, exportModel, exportObject, download, describeExport, exportBlocker, staysYUp, safeFileName, isUnitless, isPrintFormat, outputUnit, formatById, hasSplat, type ExportId, type ExportScope, type UnitId } from './exporters';
import { icon, hydrateIcons } from './icons';
import { CONFIG } from './config';
import { panels, commands, registerCommand } from './registry';
import { ctx } from './context';
import { MATERIALS, estimate } from './cost';
import { listRecent, addRecent, removeRecent, clearRecent, entryFiles, type RecentEntry } from './recent';
import { guessUnit, defaultUp, rememberPref, forgetPref, rememberedPref, UNIT_SOURCE_LABEL, type UnitSource, type UnitGuess } from './units';
import { initFeatures } from './features';
import { capsEnabled, setCaps } from './features/caps';
import { showBatchDialog } from './features/batch';
import { openPalette, registerContextAction } from './features/palette';
import { cameraString, applyCamera, savedViewsFor, restoreSavedViews } from './features/views';
import { LOOKS, currentLook, setLook, BACKDROPS, setBackdrop, setShadow, shadowEnabled, envBackground, setEnvBackground } from './features/look';
import { CAD_QUALITY, cadQuality } from './cad';
import { helpArticlesHtml, releaseNotesHtml } from './features/docs';
import { ProprietaryFormatError, PROPRIETARY, extractPreview, type ProprietaryInfo } from './formats-extra';
import { compareWith } from './features/compare';
import { initQuickConvert, openQuickConvert, closeQuickConvert, qcAdd, qcIsOpen } from './features/quickconvert';
import { initViewCube } from './features/viewcube';
import { initSelectionBar } from './features/selbar';
// eslint-disable-next-line no-var -- read by updateToolbar(), which runs before the bar is created
var selBar: ReturnType<typeof initSelectionBar> | undefined;

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem('omniview.' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('omniview.' + k, v); } catch { /* private mode */ } },
};

/** Viewer preferences (all local to this browser). */
const prefs = {
  get allowRemote() { return store.get('allowRemote', '') === '1'; },
  /** single-key shortcuts: on everywhere, only when the 3D view has focus, or off (OV-057) */
  get keys() { return store.get('keys', 'on') as 'on' | 'canvas' | 'off'; },
  get nav() { return store.get('nav', 'default') as 'default' | 'cad' | 'blender'; },
  get zoomToCursor() { return store.get('zoomCursor', '1') === '1'; },
  get reduceMotion() { const v = store.get('motion', 'system'); return v === 'reduce' || (v === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches); },
  get autoplay() { return store.get('autoplay', prefs.reduceMotion ? '0' : '1') === '1'; },
  get quality() { return store.get('quality', 'auto') as 'auto' | 'quality' | 'performance'; },
  get density() { return store.get('density', 'comfortable') as 'compact' | 'comfortable'; },
  get rememberRecents() { return store.get('recents', '1') === '1'; },
};

/** Short messages. Errors also go to the Problems panel, where they stay until dismissed (OV-050). */
function toast(msg: string, error = false, action?: { label: string; run: () => void }) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = t(msg);
  if (error) {
    addProblem(msg);
    const b = document.createElement('button');
    b.className = 'link-btn'; b.textContent = t('Details');
    b.onclick = () => showProblems();
    el.append(' ', b);
  }
  if (action) {
    const b = document.createElement('button');
    b.className = 'link-btn'; b.textContent = t(action.label);
    b.onclick = () => { el.remove(); action.run(); };
    el.append(' ', b);
  }
  // One message at a time: a new one replaces the last instead of stacking over the model (D06).
  // The latest result also stays in the status line, so it can still be read after the toast fades.
  $('#toasts').querySelectorAll('.toast:not(.error)').forEach((x) => x.remove());
  $('#toasts').appendChild(el);
  if (!error) { const last = document.getElementById('statusLast'); if (last) last.textContent = t(msg); }
  setTimeout(() => el.remove(), error ? 9000 : action ? 6000 : 2600);
}

// ------------------------------------------------------------------ problems panel (OV-050)
interface Problem { id: number; time: number; text: string; resources?: ResourceInfo[]; retry?: () => void }
const problems: Problem[] = [];
let problemSeq = 0;
/** Removes signed-URL tokens and query strings before details are shown or copied. */
const redact = (s: string) => s.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1?…');
function addProblem(text: string, extra: Partial<Problem> = {}) {
  problems.unshift({ id: ++problemSeq, time: Date.now(), text: redact(text), ...extra });
  problems.splice(30);
  updateProblemBadge();
}
function updateProblemBadge() {
  const b = document.getElementById('problemsBtn');
  if (!b) return;
  b.classList.toggle('hidden', !problems.length);
  b.querySelector('span')!.textContent = String(problems.length);
}
function showProblems() {
  if (!problems.length) { openModal(`<h2>${t('Problems')}</h2><p>Nothing to report.</p>`); return; }
  openModal(`<h2 id="dlgTitle">${t('Problems')}</h2>
    <div class="problems">${problems.map((p) => `<div class="problem" data-pid="${p.id}">
      <pre>${esc(p.text)}</pre>
      ${p.resources?.some((r) => r.status === 'missing') ? `<p class="note">${t('Geometry is available. Locate the missing files to restore the appearance.')}</p>` : ''}
      <div class="btn-row">
        ${p.resources?.some((r) => r.status === 'missing') ? `<button class="chip" data-plocate="${p.id}">${t('Locate files')}</button>` : ''}
        ${p.retry ? `<button class="chip" data-pretry="${p.id}">${t('Retry')}</button>` : ''}
        <button class="chip" data-pcopy="${p.id}">${t('Copy details')}</button>
        <button class="chip" data-pdismiss="${p.id}">${t('Close')}</button>
      </div></div>`).join('')}</div>
    <p class="note"><a href="#" data-help="missing">Help: missing textures</a> · <a href="#" data-help="cors">Help: links that won't open</a> · <a href="#" data-help="units">Help: wrong size</a></p>`);
  $('#modalCard').onclick = (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pcopy],[data-pretry],[data-pdismiss],[data-plocate],[data-help]');
    if (!el) return;
    const p = problems.find((x) => String(x.id) === (el.dataset.pcopy || el.dataset.pretry || el.dataset.pdismiss || el.dataset.plocate));
    if (el.dataset.help) { e.preventDefault(); showHelpCentre(el.dataset.help); return; }
    if (el.dataset.pcopy && p) navigator.clipboard?.writeText(`${p.text}\n\n${diagnostics()}`).then(() => toast(t('Copied')), () => toast('Copy failed: select the text and copy it', true));
    if (el.dataset.pretry && p) { modal.close(); p.retry!(); }
    if (el.dataset.plocate) { modal.close(); ctx.setTool('assets'); }
    if (el.dataset.pdismiss && p) { problems.splice(problems.indexOf(p), 1); updateProblemBadge(); showProblems(); }
  };
}
/** Browser and app facts for bug reports. No file contents or names beyond what the user copies (OV-118). */
function diagnostics() {
  const gl = viewer.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return [
    `App: ${CONFIG.appName} ${APP_VERSION}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    `GPU: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'}`,
    `Language: ${LANG}`,
  ].join('\n');
}
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

function setLoading(msg: string | null, progress: number | null = null) {
  $('#loading').classList.toggle('hidden', msg === null);
  if (msg) $('#loadingText').textContent = msg;
  const bar = $('#loadingBar');
  bar.classList.toggle('hidden', progress === null);
  if (progress !== null) ($('#loadingBar i') as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

/** Online samples (downloaded from their public hosts on click) with what each one is good for (OV-046). */
const EXAMPLES: { label: string; purpose: string; size: string; url: string; formats: string[]; unit?: Unit }[] = [
  { label: 'Helmet · GLB', purpose: 'materials & textures', size: '3.8 MB', formats: ['glb', 'gltf', 'usdz', 'fbx', 'obj'], url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb' },
  { label: 'Fox · animated', purpose: 'animation', size: '0.2 MB', formats: ['fbx', 'dae', 'md2', 'glb'], url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb' },
  { label: 'Assembly · STEP', purpose: 'CAD assembly', size: '0.4 MB', formats: ['step', 'stp', 'iges', 'igs', 'brep', '3dm'], url: 'https://raw.githubusercontent.com/kovacsv/occt-import-js/main/test/testfiles/cax-if/as1-oc-214.stp' },
  { label: 'House · IFC', purpose: 'BIM building', size: '2.5 MB', formats: ['ifc'], url: 'https://raw.githubusercontent.com/ThatOpen/engine_web-ifc/main/tests/ifcfiles/public/AC20-FZK-Haus.ifc' },
  { label: 'Gears · 3MF', purpose: 'print parts', size: '0.6 MB', formats: ['3mf', 'stl', 'amf', 'obj', 'ply', 'off', 'vox'], url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/3mf/cube_gears.3mf' },
  { label: 'Robot head · STL', purpose: 'mesh in metres', size: '0.05 MB', formats: ['stl'], url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/binary/pr2_head_pan.stl', unit: 'm' },
  { label: 'Logo · 3DM', purpose: 'Rhino curves & meshes', size: '0.3 MB', formats: ['3dm'], url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/3dm/Rhino_Logo.3dm' },
];

const PAINT_COLORS = ['#e4572e', '#f3a712', '#ffd23f', '#76b041', '#17bebb', '#2e86de', '#6c5ce7', '#e84393', '#ffffff', '#9a9a9a', '#3d3d3d', '#0a0a0a'];

// ------------------------------------------------------------------ app state
type Tool = string;
const state = {
  tool: 'none' as Tool,
  /** the unit the model's coordinates are in ("file units") */
  unit: 'mm' as Unit,
  unitSource: 'new' as UnitSource,
  /** unit sizes are shown in ('auto' = same as file units), a display preference only (OV-008) */
  displayUnit: store.get('displayUnit', 'auto') as Unit | 'auto',
  caps: null as Capabilities | null,
  /** id of the newest load; older loads may not replace newer work (OV-009) */
  loadJob: 0,
  resources: [] as ResourceInfo[],
  pointScale: 1,
  pointBudget: 1,
  /** show the print estimate even where it is normally hidden */
  forceCost: false,
  /** model identity for saved views / projects (name + size + triangle count) */
  identity: '',
  /** last export of this scene: label, time and whether it kept everything (save semantics, D01) */
  lastExport: null as null | { label: string; at: number; complete: boolean },
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

// Start-up runs in a few separate tasks instead of one long one (Core Web Vitals: Total Blocking Time, INP).
// Only yield where no app callbacks are registered yet: later top-level declarations must not be reachable early.
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));
await yieldToMain(); // after three.js and the other modules have been evaluated
const viewer = new Viewer($('#viewport'));
// The floating panels leave gaps onto the layout behind them: paint those in the view's own background colour so
// the cards read as floating over one continuous view (style.css, "floating panels").
{
  const setBg = viewer.setBackground.bind(viewer);
  viewer.setBackground = (color: string | null) => {
    setBg(color);
    if (color) document.documentElement.style.setProperty('--view-bg', color);
    else document.documentElement.style.removeProperty('--view-bg');
  };
}
if (import.meta.env.DEV) (window as any).__viewer = viewer; // dev console handle
await yieldToMain(); // after the WebGL context is created
setSharedRenderer(viewer.renderer);
const history = new History();
const editor = new Editor(viewer, history);
const measure = new MeasureTool(viewer);
if (import.meta.env.DEV) (window as any).__measure = measure; // dev console handle
const paint = new PaintTool(viewer, history);
// ------------------------------------------------------------------ units: file units vs display units (OV-008)
const dispUnit = (): Unit => (state.displayUnit === 'auto' ? state.unit : state.displayUnit);
/** Converts a length in file units to the display unit. */
const toDisp = (v: number) => (state.unit === 'u' || dispUnit() === 'u' ? v : (v * UNITS[state.unit].toMeters) / UNITS[dispUnit()].toMeters);
const fmtD = (v: number, digits = 3) => fmtLen(toDisp(v), dispUnit(), digits);
const fmtArea = (v: number) => `${fmtNum(v * toDisp(1) ** 2, 2)} ${UNITS[dispUnit()].short}²`;
const fmtVol = (v: number) => `${fmtNum(v * toDisp(1) ** 3, 2)} ${UNITS[dispUnit()].short}³`;
measure.format = (v) => fmtD(v);
let measureOnlySelected = false;
measure.pickTargets = () => (measureOnlySelected && editor.selected && editor.selected !== viewer.model ? [editor.selected] : undefined);
const isTouch = () => matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------------ static UI setup
/** Set by the landing page (format viewer, converter or tool page) the visitor arrived on. */
interface PageConfig { kind?: 'viewer' | 'convert' | 'tool' | 'guide'; from?: string; to?: ExportId; tool?: string; slug?: string }
let PAGE: PageConfig = {};
try { PAGE = JSON.parse($('#page-config')?.textContent || '{}'); } catch { /* defaults */ }
$('#year').textContent = String(new Date().getFullYear());
($('#fileInput') as HTMLInputElement).accept = pickerAccept();
// Format links stay in the visitor's language (OV-075); the page's <base> points at the site root.
// A named pair page (STL → GLB) lists only the format it takes, not all 44 (audit page review).
const pageFormats = PAGE.kind === 'convert' && PAGE.from ? FORMATS.filter((f) => f.ext.includes(PAGE.from!)) : FORMATS;
$('#formatList').innerHTML = (pageFormats.length ? pageFormats : FORMATS).map((f) => f.ext[0] === 'zip'
  ? `<span class="fmt" title="${esc(f.name)}">.zip</span>`
  : `<a class="fmt" href="${LANG_PREFIX}${f.ext[0]}-viewer/" title="${esc(f.name)} viewer">${f.ext.map((e) => '.' + e).join(' ')}</a>`).join('');
$<HTMLAnchorElement>('.brand-home').href = LANG_PREFIX || './';
// Samples say what they teach and how big the download is (OV-046).
$('#examples').innerHTML = EXAMPLES.map((e, i) => `<button class="example" data-example="${i}"><b>${esc(e.label)}</b><small>${esc(e.purpose)} · ${e.size}</small></button>`).join('');
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
/** Before replacing an edited scene, offer Export / Discard / Keep editing (OV-003). */
async function confirmDiscard(): Promise<boolean> {
  if (!viewer.model || !history.dirty) return true;
  return new Promise((resolve) => {
    openModal(`<h2 id="dlgTitle">${t('You have unsaved changes')}</h2>
      <p>${esc(state.modelName || 'This scene')} has changes that are not saved${state.lastExport && !state.lastExport.complete ? ` (your ${esc(state.lastExport.label)} export doesn’t keep everything)` : ''}. Opening something else will replace it. A project file (.omniproj) keeps every part, colour, measurement and view.</p>
      <div class="modal-actions">
        <button class="btn-outline" data-dc="keep">${t('Keep editing')}</button>
        <button class="btn-outline" data-dc="project">${t('Save project')}</button>
        <button class="btn-outline" data-dc="export">${t('Export a copy')}</button>
        <button class="btn-solid danger" data-dc="discard">${t('Discard changes')}</button>
      </div>`);
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; resolve(v); };
    $('#modalCard').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dc]');
      if (!b) return;
      const c = b.dataset.dc;
      if (c === 'discard') { modal.close(); finish(true); }
      else if (c === 'export') { finish(false); showExportDialog(); }
      else if (c === 'project') { modal.close(); finish(false); saveProject(); }
      else { modal.close(); finish(false); }
    };
    modal.addEventListener('close', () => finish(false), { once: true });
  });
}

/** How a new file joins the scene when one is open (CA-16): replace it, add to it, or open in a new tab. */
type OpenMode = 'replace' | 'add' | 'tab';

/** A unit decided before opening (in Quick Convert): it replaces the size-based guess, so nobody is asked twice (F01). */
interface GivenUnit { unit: Unit; unitSource: UnitSource; up?: 'y' | 'z' }

async function openFiles(files: File[], urls: string[] | null = null, mode: OpenMode = 'replace', skipConfirm = false, given?: GivenUnit) {
  if (!files.length) return;
  if (await maybeOpenProject(files)) return;
  if (mode === 'replace' && !skipConfirm && !(await confirmDiscard())) return;
  const job = ++state.loadJob;
  const owns = () => job === state.loadJob;
  setLoading(t('Loading…'));
  const ac = new AbortController();
  state.abort?.abort();
  state.abort = ac;
  $('#loadingCancel').classList.remove('hidden');
  try {
    const res = await loadFiles(files, (m) => owns() && setLoading(m), ac.signal, { baseUrl: urls?.[0], allowRemote: prefs.allowRemote });
    // A newer open started meanwhile: throw this result away instead of replacing newer work.
    if (!owns() || ac.signal.aborted) { disposeObject(res.object); return; }
    if (openingProject) res.object = unwrapProjectRoot(res.object);
    if (mode === 'add' && viewer.model) { addToScene(res); return; }
    if (mode === 'tab' && viewer.model) stashCurrentDocument();
    setTool('none');
    printRan.clear();
    measure.clear();
    editor.select(null);
    editor.setGizmo('none');
    history.clear();
    document.body.classList.add('has-model');
    viewer.autoplay = prefs.autoplay;
    if (arrangeNext) { arrangeNext = false; if (arrangeSideBySide(res.object, extOf(res.mainFiles[0]))) setTimeout(() => toast(t('Placed the models side by side')), 600); }
    viewer.setModel(res.object, res.animations);
    viewer.setExplode(0);
    state.modelName = res.mainFiles.length === 1 ? res.mainFiles[0] : `${res.mainFiles.length} files`;
    state.sourceUrls = urls;
    state.expanded = new Set([res.object.uuid]);
    state.resources = res.resources;
    const ext = extOf(res.mainFiles[0]);
    state.ext = ext;
    state.lastFiles = urls ? null : files;
    state.caps = detectCapabilities(res.object, ext, res.animations.length);
    viewer.setUpAxis(given?.up ?? defaultUp(ext));
    const size = viewer.bounds().getSize(new THREE.Vector3());
    const guess: UnitGuess = given ? { unit: given.unit, source: given.unitSource } : guessUnit(ext, Math.max(size.x, size.y, size.z), res.declaredUnit);
    setFileUnit(guess.unit, guess.source, { undoable: false });
    hideUnitHint();
    if (guess.suggest) showUnitHint(guess.unit, guess.suggest.unit, guess.suggest.why);
    if (prefs.rememberRecents) addRecent(state.modelName, urls ? null : files, urls, makeThumb()).then(renderRecent);
    refreshStats();
    state.identity = `${state.modelName}|${res.mainFiles.length}|${files.reduce((n, f) => n + f.size, 0)}`;
    // Single-part files don't need the parts list; it stays one click away (OV-032).
    if (!isPhone()) document.body.classList.toggle('no-left', countParts(res.object) <= 1);
    viewer.setContinuous('splat', !!res.object.userData.splatCount);
    renderAll();
    history.markClean();
    if (res.warnings.length) {
      addProblem(`${t('Opened with warnings')}: ${state.modelName}\n` + res.warnings.join('\n'), { resources: res.resources, retry: () => reloadOriginal() });
      toast(`${t('Opened with warnings')}: ${res.warnings.length}`, true);
    } else toast(`${t('Opened')} ${state.modelName}`);
    applyPageIntent();
    if (pendingIntent) {
      const i = pendingIntent; pendingIntent = null;
      if (i === 'convert') setTimeout(() => showExportDialog(), 300); else applyIntent(i);
    }
    if (state.tool === 'none' && state.caps.isToolpath) setTool('gcode');
    maybeShowTips();
    if (res.object.userData.splatCount) {
      // Splats re-sort only after a large camera move; force the first sort once the camera is framed.
      for (const ms of [100, 500]) setTimeout(() => { (viewer.model as any)?.viewer?.runSplatSort?.(true, true); }, ms);
      toast('Gaussian splats: view, frame and screenshot. Measuring, editing and converting need a mesh, so they are off for splats.');
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') { if (owns()) toast(t('Stopped. Your previous model is unchanged.')); return; }
    if (err instanceof ProprietaryFormatError) { pendingIntent = null; if (owns()) showProprietaryDialog(err.info, err.file); return; }
    console.error(err);
    if (owns()) toast(err?.message || String(err), true);
  } finally {
    if (owns()) {
      setLoading(null);
      $('#loadingCancel').classList.add('hidden');
      if (state.abort === ac) state.abort = null;
    }
  }
}

/** Set when the user picks "Side by side" for several dropped files. */
let arrangeNext = false;
/** Lays the files of a multi-file open out on a grid on the ground plane, so they don't sit on top of each other. */
function arrangeSideBySide(root: THREE.Object3D, ext: string): boolean {
  const kids = root.children.filter((c) => !c.userData.helper);
  if (kids.length < 2) return false;
  const zUp = defaultUp(ext) === 'z';
  root.updateMatrixWorld(true);
  const boxes = kids.map((k) => new THREE.Box3().setFromObject(k));
  const sizes = boxes.map((b) => b.getSize(new THREE.Vector3()));
  const across = (v: THREE.Vector3) => Math.max(v.x, zUp ? v.y : v.z);
  const cell = Math.max(...sizes.map(across)) * 1.2 || 1;
  const cols = Math.ceil(Math.sqrt(kids.length));
  kids.forEach((k, i) => {
    const c = boxes[i].getCenter(new THREE.Vector3());
    const tx = (i % cols) * cell, tz = Math.floor(i / cols) * cell;
    const off = zUp ? new THREE.Vector3(tx - c.x, tz - c.y, -boxes[i].min.z) : new THREE.Vector3(tx - c.x, -boxes[i].min.y, tz - c.z);
    k.position.add(off);
  });
  return true;
}

const countParts = (o: THREE.Object3D) => { let n = 0; o.traverse((c: any) => { if ((c.isMesh || c.isPoints || c.isLine) && !c.userData.helper) n++; }); return n; };

/** Adds a loaded file to the current scene as an undoable step (CA-16). */
function addToScene(res: Awaited<ReturnType<typeof loadFiles>>) {
  const root = viewer.model!;
  // Match units: scale the new part from its own unit into the scene's unit.
  const ext = extOf(res.mainFiles[0]);
  const size = new THREE.Box3().setFromObject(res.object).getSize(new THREE.Vector3());
  const g = guessUnit(ext, Math.max(size.x, size.y, size.z), res.declaredUnit);
  if (state.unit !== 'u' && g.unit !== 'u') res.object.scale.multiplyScalar(UNITS[g.unit].toMeters / UNITS[state.unit].toMeters);
  if (defaultUp(ext) !== viewer.upAxis) res.object.rotation.x = viewer.upAxis === 'z' ? Math.PI / 2 : -Math.PI / 2;
  editor.addObject(res.object, `Add ${res.mainFiles.join(', ')}`);
  state.caps = detectCapabilities(root, state.ext, viewer.clips.length);
  renderAll();
  toast(`Added ${res.mainFiles.join(', ')}${g.unit !== state.unit ? ` (converted from ${UNITS[g.unit].short})` : ''}`);
}

async function openUrls(urls: string[], mode: OpenMode = 'replace') {
  if (mode === 'replace' && !(await confirmDiscard())) return;
  const job = state.loadJob + 1;
  setLoading(t('Downloading…'), 0);
  const ac = new AbortController();
  state.abort?.abort();
  state.abort = ac;
  $('#loadingCancel').classList.remove('hidden');
  try {
    const files = await filesFromUrls(urls, (done, total) => setLoading(`${t('Downloading…')} ${(done / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, total ? done / total : null), ac.signal);
    if (ac.signal.aborted || state.loadJob >= job) { if (state.loadJob >= job && !ac.signal.aborted) return; }
    setLoading(t('Loading…'));
    await openFiles(files, urls, mode, true);
    if (!document.body.classList.contains('embed')) history_replaceHash(urls);
  } catch (err: any) {
    setLoading(null);
    $('#loadingCancel').classList.add('hidden');
    if (err?.name === 'AbortError') { toast(t('Stopped. Your previous model is unchanged.')); return; }
    const msg = `${err?.message || err}`;
    toast(/HTTP|fetch|network|Failed/i.test(msg)
      ? `${msg}\nThis server did not allow the model to be downloaded here. Download the file to your device and open it, or use a direct link from a server that allows cross-origin access.`
      : msg, true);
    addProblem(msg, { retry: () => openUrls(urls, mode) });
  }
}

/** Re-opens the original file(s) of the current model, after asking about unsaved changes (OV-042). */
async function reloadOriginal() {
  if (state.sourceUrls) return openUrls(state.sourceUrls);
  if (state.lastFiles) return openFiles(state.lastFiles);
  toast('The original file is not available to reload. Open it again.', true);
}

function history_replaceHash(urls: string[]) {
  // Full path: pages in sub-folders use <base href="../">, which would otherwise rewrite the path.
  const h = '#model=' + urls.map(encodeURIComponent).join(',');
  window.history.replaceState(null, '', location.pathname + location.search + h);
}

/** After a file opens, jump straight to what this landing page is about. */
function applyPageIntent() {
  const tool = PAGE.tool;
  // Converter pages convert in Quick Convert (no viewer); a model opened from there is for looking, not re-exporting.
  if (PAGE.to || tool === 'convert') return;
  if (tool === 'paint' || tool === 'measure') { setTool(tool); return; }
  if (tool === 'cost') { scrollToSection('sec-cost'); return; }
  if (tool && panels.has(tool)) { setTool(tool); return; }
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

async function newScene() {
  if (!(await confirmDiscard())) return;
  setTool('none');
  measure.clear();
  editor.select(null);
  history.clear();
  viewer.setModel(null);
  editor.ensureModel();
  viewer.setUpAxis('y');
  state.modelName = 'Untitled scene';
  state.sourceUrls = null;
  state.ext = '';
  state.lastFiles = null;
  setFileUnit('mm', 'new', { undoable: false });
  state.expanded = new Set([viewer.model!.uuid]);
  window.history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.add('has-model');
  editor.addPrimitive('box');
  if (PAGE.tool === 'edit') editor.setGizmo('translate');
  if (PAGE.tool && panels.get(PAGE.tool)?.needsModel === false) setTool(PAGE.tool);
  viewer.fit(viewer.model, 'iso');
  state.caps = detectCapabilities(viewer.model, '', 0);
  refreshStats();
  renderAll();
  history.markClean();
  toast('Empty scene ready: add shapes from the toolbar');
}

// ------------------------------------------------------------------ stats
let statsTimer = 0;
let closedJob: AbortController | null = null;
function refreshStats(delay = 0) {
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    const s = computeStats(viewer.model, viewer.bounds());
    state.stats = s;
    if (viewer.model) state.caps = detectCapabilities(viewer.model, state.ext, viewer.clips.length);
    renderDetails();
    updateStatus();
    updateBadges();
    // Big meshes: check closedness in a worker and show "Not checked" until it answers (OV-025, OV-088).
    closedJob?.abort();
    if (s.closed === null && s.unchecked.length) {
      const job = new AbortController(); closedJob = job;
      checkClosedAsync(s.unchecked, job.signal).then((ok) => {
        if (state.stats !== s) return;
        s.closed = ok; renderDetails();
      }).catch(() => { /* cancelled */ });
    }
  }, delay);
}

/**
 * Sets the model's file units ("this file is in inches"). This REINTERPRETS the numbers, so the real size changes;
 * it is an undoable step (OV-002, OV-008). Rescaling the numbers while keeping the real size is `rescaleToUnit`.
 */
function setFileUnit(u: Unit, source: UnitSource, opts: { undoable?: boolean; remember?: boolean } = {}) {
  const before = { unit: state.unit, source: state.unitSource };
  const apply = (v: { unit: Unit; source: UnitSource }) => {
    state.unit = v.unit; state.unitSource = v.source;
    measure.relabel(); renderDetails(); updateStatus(); updateModelBar();
  };
  if (opts.remember && state.ext) rememberPref(state.ext, { unit: u });
  if (opts.undoable && viewer.model && (before.unit !== u)) {
    history.run({ label: `File units: ${UNITS[u].short}`, redo: () => apply({ unit: u, source }), undo: () => apply(before) });
  } else apply({ unit: u, source });
}

/** Rescales the numbers into another unit, keeping the real size: geometry AND unit change in ONE undo step (OV-002). */
function rescaleToUnit(to: Unit) {
  if (!viewer.model || state.unit === to || state.unit === 'u' || to === 'u') return;
  const from = state.unit;
  const f = UNITS[from].toMeters / UNITS[to].toMeters;
  history.batch(`Rescale ${UNITS[from].short} → ${UNITS[to].short}`, () => {
    editor.scaleBy(f, f, f, viewer.model!);
    setFileUnit(to, 'user', { undoable: true });
  });
  viewer.fit();
  toast(`Rescaled ${UNITS[from].short} → ${UNITS[to].short} (×${fmtNum(f, 4)}). The real size is unchanged.`);
}

function setDisplayUnit(u: Unit | 'auto') {
  state.displayUnit = u;
  store.set('displayUnit', u);
  measure.relabel(); renderDetails(); updateStatus(); updateModelBar();
}

// ------------------------------------------------------------------ tools
let hintTimer = 0;
/** Print checks the person has run on this model, for the print-ready checklist (N04). */
const printRan = new Set<string>();
function setTool(t: Tool) {
  if (state.tool === t) t = 'none';
  if (t !== 'none') printRan.add(t);
  panels.get(state.tool)?.onDeactivate?.();
  state.tool = t;
  measure.setActive(t === 'measure');
  paint.setActive(t === 'paint');
  if (t === 'section' && !viewer.section.enabled) viewer.setSection({ enabled: true });
  if (t === 'paint' || t === 'measure') editor.setGizmo('none');
  const hints: Record<string, string> = {
    none: '',
    measure: isTouch() ? 'Tap a hole or edge, or two points for a distance' : 'Point at a hole or edge, or click a corner or face to start a distance · Esc to stop',
    paint: paint.mode === 'brush' ? (isTouch() ? 'Drag a finger to brush colour onto the surface' : 'Click and drag to brush colour onto the surface · Esc to stop') : (isTouch() ? 'Tap a part to colour it' : 'Click a part to colour it · Esc to stop'),
    section: 'Drag the slider in the details panel to cut through the model',
    explode: 'Use the slider in the details panel to pull parts apart',
  };
  const panel = panels.get(t);
  panel?.onActivate?.();
  const hintText = tr(panel ? panel.hint : hints[t] || '');
  const hint = $('#toolHint');
  hint.textContent = hintText;
  hint.classList.toggle('hidden', !hintText);
  hint.classList.remove('fade');
  clearTimeout(hintTimer);
  if (hintText && isPhone()) hintTimer = window.setTimeout(() => hint.classList.add('fade'), 5000);
  if (isPhone() && t !== 'none') {
    openSheet('right');
    document.body.classList.toggle('sheet-min', ['measure', 'paint', 'layflat'].includes(t));
    setTimeout(ensureModelVisible, 400); // the sheet must not push the model out of view (CA-09)
  }
  syncCtxBar();
  if (t !== 'none') maybeShowToolTip(t);
  viewer.renderer.domElement.style.cursor = t === 'measure' || t === 'paint' ? 'crosshair' : '';
  if (t !== 'none' && !isPhone()) document.body.classList.remove('no-right');
  updateToolbar();
  renderDetails();
}

// ------------------------------------------------------------------ toolbar & menus
/** What each toolbar control needs; unavailable controls are marked aria-disabled and explain why (OV-052). */
const NEEDS: Record<string, 'model' | 'mesh' | 'pickable' | 'export'> = {
  measure: 'pickable', paint: 'mesh', section: 'model', explode: 'model', repair: 'mesh', reduce: 'mesh', hollow: 'mesh',
  thickness: 'mesh', cut: 'mesh', boolean: 'mesh', layflat: 'mesh', overhang: 'mesh', clash: 'mesh', bed: 'model',
  compare: 'model', turntable: 'model', views: 'model', export: 'export', screenshot: 'model', share: 'model', fit: 'model',
  translate: 'model', rotate: 'model', scale: 'model', report: 'model', drawing: 'mesh', assets: 'model',
};
function controlNeed(el: HTMLElement) { const k = el.dataset.tool || el.dataset.action || el.dataset.gizmo || el.dataset.m || ''; return NEEDS[k]; }
function reasonFor(el: HTMLElement): string | null {
  const need = controlNeed(el);
  if (!need) return el.closest('.needs-model') && !viewer.model ? unavailableReason(null, 'model') : null;
  return unavailableReason(viewer.model ? state.caps : null, need);
}
function updateToolbar() {
  $$<HTMLElement>('#toolbar button, #tbStrip button, #menu-tools button, #mobileBar button, .needs-model').forEach((b) => {
    const why = reasonFor(b);
    b.toggleAttribute('aria-disabled', !!why);
    if (why) b.setAttribute('aria-disabled', 'true');
    b.classList.toggle('is-off', !!why);
    if (why) b.dataset.why = why; else delete b.dataset.why;
  });
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  $$('[data-gizmo]').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === editor.gizmo));
  // A tool that is on but sits in the overflow strip: mark the » button so it isn't forgotten.
  $('#tbOverflow').classList.toggle('has-active', !!$('#tbStrip').querySelector('.tb.active'));
  $$('[data-display]').forEach((b) => b.classList.toggle('checked', b.dataset.display === viewer.displayMode));
  $$('[data-projection]').forEach((b) => b.classList.toggle('checked', (b.dataset.projection === 'orthographic') === (viewer.camera === viewer.ortho)));
  const toggles: Record<string, boolean> = { edges: viewer.showEdges, grid: viewer.showGrid, axes: viewer.showAxes, autorotate: viewer.controls.autoRotate };
  $$('[data-toggle]').forEach((b) => b.classList.toggle('checked', !!toggles[b.dataset.toggle!]));
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  $$<HTMLButtonElement>('[data-action="undo"]').forEach((b) => { b.disabled = !history.canUndo; b.dataset.tip = history.canUndo ? `${t('Undo')}: ${history.nextUndo} (${mod}Z)` : `${t('Undo')} (${mod}Z)`; b.setAttribute('aria-label', b.dataset.tip); });
  $$<HTMLButtonElement>('[data-action="redo"]').forEach((b) => { b.disabled = !history.canRedo; b.dataset.tip = history.canRedo ? `${t('Redo')}: ${history.nextRedo} (${mod}Y)` : `${t('Redo')} (${mod}Y)`; b.setAttribute('aria-label', b.dataset.tip); });
  updateModelBar();
  updateBadges();
  selBar?.sync();
}

function closeMenus() { $$('.menu.open').forEach((m) => m.classList.remove('open')); }

document.addEventListener('click', (e) => {
  const off = (e.target as HTMLElement).closest<HTMLElement>('[aria-disabled="true"]');
  if (off && !off.closest('.modal-card')) { e.preventDefault(); e.stopPropagation(); toast(off.dataset.why || unavailableReason(null, 'model')!); return; }
}, true);

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
      // Open downwards; buttons near the bottom of the window (a bottom dock) open upwards, and buttons in a
      // vertical tool column open to their right.
      const h = menu.offsetHeight, side = !!menuBtn.closest('.lab-split .tb-group:not([data-group="view"]), .lab-split .tb-more-wrap, .lab-railnav');
      const below = r.bottom + 6 + h <= window.innerHeight - 8;
      menu.style.top = (side ? Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) : below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
      menu.style.left = (side ? r.right + 8 : Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      // The phone's view buttons sit on the right edge: open beside them, to the left.
      if (menuBtn.closest('.mview')) {
        menu.style.left = Math.max(8, r.left - menu.offsetWidth - 8) + 'px';
        menu.style.top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) + 'px';
      }
    }
    return;
  }
  if (!t.closest('.menu')) closeMenus();
  const el = t.closest<HTMLElement>('[data-action],[data-tool],[data-gizmo],[data-view],[data-display],[data-projection],[data-toggle],[data-add],[data-example],[data-close],[data-open],[data-tab],[data-rtab],[data-ctx],[data-ctxdone],[data-sheetsize],[data-lookpreset]');
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
  else if (d.example) {
    const ex = EXAMPLES[Number(d.example)];
    openUrls([ex.url]).then(() => { if (ex.unit && viewer.model) { setFileUnit(ex.unit, 'declared', { undoable: false }); hideUnitHint(); history.markClean(); } });
  }
  else if (d.ctx) setWorkspace(d.ctx);
  else if ('ctxdone' in d) { setTool('none'); editor.setGizmo('none'); }
  else if ('sheetsize' in d) { document.body.classList.toggle('sheet-min'); document.body.classList.toggle('sheet-max', !document.body.classList.contains('sheet-min')); $$('[data-sheetsize]').forEach((b) => b.setAttribute('aria-expanded', String(!document.body.classList.contains('sheet-min')))); }
  else if (d.lookpreset) applyLookPreset(d.lookpreset as 'inspect' | 'present' | 'source');
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
    if (d.rtab === 'settings') { renderSettings(); renderOfflineInfo(); }
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
    case 'units': scrollToSection('sec-model'); setTimeout(() => ($('#fileUnit') as HTMLElement)?.focus(), 300); break;
    case 'problems': showProblems(); break;
    case 'saveproj': saveProject(); break;
    case 'watch': watchFile(); break;
    case 'ar': viewInAR(); break;
    case 'recipes': showRecipes(); break;
    case 'storagehelp': showHelpCentre('storage'); break;
    case 'sample': openSample(); break;
    case 'printcheck': showPrintChecklist(); break;
    case 'unitsample': openFiles([unitPracticeFile()]); break;
    case 'comparesample': openCompareSample(); break;
    case 'convertfile': case 'modeconvert': openQuickConvert(); break;
    case 'closeqc': case 'modeview': closeQuickConvert(); break;
    case 'formats': showFormatsDialog(); break;
  }
}

/** A task picked on the welcome screen before any file is open: applied once the file has loaded. */
let pendingIntent: string | null = null;
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-intent]');
  if (!b) return;
  pendingIntent = b.dataset.intent!;
  ($('#fileInput') as HTMLInputElement).click();
});

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
  tip.style.top = (r.bottom + 90 > window.innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8) + 'px';
});
document.addEventListener('pointerout', (e) => { if ((e.target as HTMLElement).closest('[data-tip]')) tip.classList.remove('show'); });

// ------------------------------------------------------------------ workspaces (OV-033)
/** View / Inspect / Prepare / Present show the relevant tool groups; one shared scene, camera and undo stack. */
function setWorkspace(c: string) {
  document.body.dataset.ctx = c;
  store.set('ctx', c);
  $$<HTMLElement>('#ctxSwitch [data-ctx]').forEach((b) => { b.classList.toggle('active', b.dataset.ctx === c); b.setAttribute('aria-checked', String(b.dataset.ctx === c)); });
  layoutToolbar();
}

// ------------------------------------------------------------------ toolbar overflow (OV-031)
/**
 * Groups that don't fit move into a strip that drops down under the toolbar (like a slicer's overflow), opened by
 * the » button. The groups themselves move, so active states, menus and disabled states keep working. The Tools
 * menu button always stays visible.
 */
const TB_ORDER = [...document.querySelectorAll<HTMLElement>('#toolbar > .tb-group')];
function layoutToolbar() {
  const bar = $('#toolbar');
  const strip = $('#tbStrip');
  const more = $('#tbOverflow');
  const ctx = document.body.dataset.ctx || 'all';
  // Put every group back in its original place before measuring.
  for (const g of TB_ORDER) { const home = labHome.get(g); if (home) home.appendChild(g); else bar.insertBefore(g, more); g.classList.remove('overflowed'); g.hidden = false; }
  more.classList.add('hidden');
  // Workspace filter: groups tagged with other workspaces are hidden.
  for (const g of TB_ORDER) { const tags = g.dataset.ctx; if (ctx !== 'all' && tags && !tags.split(' ').includes(ctx)) g.hidden = true; }
  const fits = () => bar.scrollWidth <= bar.clientWidth;
  // First drop the text labels (icons keep their names and tooltips), then move whole groups into the strip,
  // lowest priority first. File and Undo/Redo go last, and only when nothing else is left.
  bar.classList.remove('tb-compact');
  if (!fits()) bar.classList.add('tb-compact');
  const byPrio = TB_ORDER.filter((g) => !g.hidden && !labHome.has(g)).sort((a, b) => Number(b.dataset.prio || 0) - Number(a.dataset.prio || 0) || TB_ORDER.indexOf(b) - TB_ORDER.indexOf(a));
  for (const g of byPrio) {
    if (fits()) break;
    g.classList.add('overflowed'); g.hidden = true;
    more.classList.remove('hidden'); // the » button needs room too
  }
  const moved = TB_ORDER.filter((g) => g.classList.contains('overflowed'));
  for (const g of moved) { g.hidden = false; strip.appendChild(g); }
  $('#tbOverflowCount').textContent = moved.length ? String(moved.reduce((n, g) => n + g.querySelectorAll(':scope > .tb, :scope > .dropdown > .tb').length, 0)) : '';
  if (!moved.length) closeToolStrip(); else if (!strip.classList.contains('hidden')) placeToolStrip();
}
function placeToolStrip() {
  const strip = $('#tbStrip'), r = $('#tbOverflow').getBoundingClientRect();
  strip.style.top = document.body.classList.contains('lab') ? `${r.top - strip.offsetHeight - 8}px` : `${$('#topbar').getBoundingClientRect().bottom + 6}px`;
  strip.style.left = `${Math.max(8, Math.min(r.right - strip.offsetWidth, window.innerWidth - strip.offsetWidth - 8))}px`;
}
function openToolStrip() {
  closeMenus();
  $('#tbStrip').classList.remove('hidden');
  $('#tbOverflow').setAttribute('aria-expanded', 'true');
  $('#tbOverflow').classList.add('active');
  placeToolStrip();
}
function closeToolStrip() {
  $('#tbStrip').classList.add('hidden');
  $('#tbOverflow').setAttribute('aria-expanded', 'false');
  $('#tbOverflow').classList.remove('active');
}
$('#tbOverflow').addEventListener('click', (e) => { e.stopPropagation(); if ($('#tbStrip').classList.contains('hidden')) openToolStrip(); else closeToolStrip(); });
// Close on a click outside (menus opened from the strip count as inside), after using a tool, or with Escape.
document.addEventListener('click', (e) => {
  const strip = $('#tbStrip');
  if (strip.classList.contains('hidden')) return;
  const t = e.target as HTMLElement;
  if (t.closest('#tbOverflow') || t.closest('.menu')) return;
  if (t.closest('#tbStrip')) { if (!t.closest('[data-menu]')) setTimeout(closeToolStrip, 0); return; }
  closeToolStrip();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#tbStrip').classList.contains('hidden')) { closeToolStrip(); ($('#tbOverflow') as HTMLElement).focus(); } });
window.addEventListener('resize', () => { layoutToolbar(); requestAnimationFrame(layoutToolbar); });
// Re-check whenever anything in the header changes width (model name, tabs, unit chip, fonts loading).
let toolbarRaf = 0;
const headerObserver = new ResizeObserver(() => { cancelAnimationFrame(toolbarRaf); layoutToolbar(); toolbarRaf = requestAnimationFrame(layoutToolbar); });
['#modelBar', '.brand', '.top-right', '#fileActions'].forEach((sel) => { const el = document.querySelector(sel); if (el) headerObserver.observe(el); });
document.fonts?.ready.then(() => layoutToolbar());

// ------------------------------------------------------------------ route-specific primary action (OV-044)
const TOOL_DROP: Record<string, string> = {
  scale: 'Open a model to resize it to an exact size',
  units: 'Open a model to fix or change its units',
  volume: 'Open a model to get its volume and surface area',
  paint: 'Open a model to paint it',
  edit: 'Open a model to edit it',
  reduce: 'Open a model to reduce its polygons',
  cut: 'Open a model to split or cut it',
  outline: 'Open a model, cut a section and save the outline as DXF or SVG',
  hollow: 'Open a model to hollow it',
  thickness: 'Open a model to check its wall thickness',
  boolean: 'Open the models to combine or subtract',
  turntable: 'Open a model to make a 360° turntable',
};
function applyPagePrimary() {
  const zone = $('#dropZone');
  const title = $('#dzTitle'), btn = $('#dzBtn');
  const from = PAGE.from ? PAGE.from.toUpperCase() : '';
  const set = (ti: string, bt?: string, vars?: Record<string, string>) => { title.textContent = t(ti, vars); if (bt) btn.textContent = t(bt, vars); };
  if (PAGE.kind === 'convert' && PAGE.to) set('Choose a {from} file to convert to {to}', 'Open {from} file', { from, to: PAGE.to.toUpperCase() });
  else if (PAGE.kind === 'viewer' && from) set('Drop a {from} file to view it', 'Open {from} file', { from });
  else if (PAGE.kind === 'guide' && from) set('Drop a {from} file to see its preview and export steps', 'Choose {from} file', { from });
  else if (PAGE.tool === 'text') { set('Create 3D text', 'Start typing'); zone.dataset.action = 'starttext'; }
  else if (PAGE.tool === 'svg') { set('Choose an SVG logo to extrude', 'Choose SVG'); zone.dataset.action = 'startsvg'; }
  else if (PAGE.tool === 'compare') set('Open model A, then add model B', 'Open model A');
  else if (PAGE.tool === 'batch') { set('Choose many files to convert at once', 'Choose files'); zone.dataset.action = 'batch'; }
  else if (PAGE.tool === 'measure') set('Open a model to measure it');
  else if (PAGE.tool === 'repair') set('Open an STL to check and repair it', 'Open STL');
  else if (PAGE.tool === 'cost') set('Open a model to estimate print weight and cost');
  // Every tool page names its own task instead of the home page's generic wording (audit, page review).
  else if (PAGE.tool === 'convert') set('Drop files to convert', 'Choose files to convert');
  else if (PAGE.tool && TOOL_DROP[PAGE.slug === 'stl-to-dxf' ? 'outline' : PAGE.tool]) set(TOOL_DROP[PAGE.slug === 'stl-to-dxf' ? 'outline' : PAGE.tool]);
  else title.textContent = t('Drop a model, folder or ZIP');
  // The sample matches the page's task (D01, N03).
  const sampleBtn = document.querySelector<HTMLElement>('.sample-try');
  const sampleNote = document.querySelector<HTMLElement>('.sample-note');
  if (sampleBtn && sampleNote) {
    const setSample = (action: string, label: string, note: string) => { sampleBtn.dataset.action = action; sampleBtn.textContent = t(label); sampleNote.textContent = t(note); };
    if (PAGE.tool === 'compare') setSample('comparesample', 'Try two sample revisions', 'The bracket and a revised version, ready to compare.');
    else if (PAGE.tool === 'text') setSample('starttext', 'Try with sample text', 'Editable 3D letters you can resize and export.');
    else if (PAGE.tool === 'units' || PAGE.tool === 'scale') setSample('unitsample', 'Try a box made in inches', 'A 20 × 10 × 5 box saved without units: fix its real size.');
  }
  // Converter / viewer pages: the matching sample comes first.
  const ext = PAGE.from || '';
  const match = EXAMPLES.findIndex((e) => e.formats.includes(ext));
  if (match > 0) { const host = $('#examples'); const b = host.querySelector(`[data-example="${match}"]`); if (b) host.prepend(b); }
}
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action="starttext"],[data-action="startsvg"]');
  if (!a) return;
  e.stopImmediatePropagation();
  newScene().then(() => setTool(a.dataset.action === 'starttext' ? 'text' : 'svg'));
}, true);

// ------------------------------------------------------------------ look presets (OV-072)
/** Inspection (clay + edges, flat light) vs presentation (materials, studio light, shadow); "source" undoes both. */
function applyLookPreset(k: 'inspect' | 'present' | 'source') {
  if (k === 'inspect') { setLook('flat'); viewer.setEdges(true); viewer.setDisplayMode('shaded'); setShadow(false); toast('Inspection look: edges on, even light. Materials are unchanged and exports are not affected.'); }
  if (k === 'present') { setLook('studio'); viewer.setEdges(false); viewer.setDisplayMode('shaded'); setShadow(true); toast('Presentation look: studio light and ground shadow.'); }
  if (k === 'source') { setLook('studio'); viewer.setEdges(false); viewer.setDisplayMode('shaded'); setShadow(false); toast("Showing the model's own look"); }
  $$('[data-lookpreset]').forEach((b) => b.classList.toggle('checked', b.dataset.lookpreset === k && k !== 'source'));
  updateToolbar();
}

// ------------------------------------------------------------------ built-in sample + landing preview (OV-043)
/** A mechanical bracket built from code: the opening screen shows real 3D without any download. */
function buildBracket(): THREE.Group {
  const g = new THREE.Group(); g.name = 'Sample bracket';
  const mat = () => new THREE.MeshStandardMaterial({ color: 0xc9cdd0, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide });
  const hole = (x: number, y: number, r: number) => { const h = new THREE.Path(); h.absarc(x, y, r, 0, Math.PI * 2, true); return h; };
  const plate = new THREE.Shape(); plate.moveTo(0, 0); plate.lineTo(120, 0); plate.lineTo(120, 80); plate.lineTo(0, 80); plate.closePath();
  plate.holes.push(hole(20, 20, 5), hole(100, 20, 5), hole(20, 60, 5), hole(100, 60, 5));
  const base = new THREE.Mesh(new THREE.ExtrudeGeometry(plate, { depth: 10, bevelEnabled: false, curveSegments: 32 }).rotateX(-Math.PI / 2), mat());
  base.name = 'Mounting plate';
  const up = new THREE.Shape(); up.moveTo(0, 0); up.lineTo(120, 0); up.lineTo(120, 50); up.absarc(60, 50, 60, 0, Math.PI, false); up.lineTo(0, 0);
  up.holes.push(hole(60, 55, 18));
  const arm = new THREE.Mesh(new THREE.ExtrudeGeometry(up, { depth: 10, bevelEnabled: false, curveSegments: 48 }), mat());
  arm.position.set(0, 10, -80); arm.name = 'Support arm';
  const rib = new THREE.Shape(); rib.moveTo(0, 0); rib.lineTo(50, 0); rib.lineTo(0, 45); rib.closePath();
  for (const x of [15, 95]) {
    const r = new THREE.Mesh(new THREE.ExtrudeGeometry(rib, { depth: 10, bevelEnabled: false }).rotateY(-Math.PI / 2), mat());
    r.position.set(x + 5, 10, -70); r.name = 'Rib';
    g.add(r);
  }
  for (const [x, z] of [[20, -20], [100, -20], [20, -60], [100, -60]]) {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 16, 24), new THREE.MeshStandardMaterial({ color: 0x55595d, metalness: 0.6, roughness: 0.35 }));
    bolt.position.set(x, 6, z); bolt.name = 'Fastener M8';
    g.add(bolt);
  }
  g.add(base, arm);
  return g;
}
/** A plain 20 × 10 × 5 box STL with no unit, as a file: the classic "made in inches, read as mm" case (N03). */
function unitPracticeFile(): File {
  const v = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0], [0, 0, 5], [20, 0, 5], [20, 10, 5], [0, 10, 5]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + f.length * 50), dv = new DataView(buf);
  dv.setUint32(80, f.length, true);
  f.forEach((tri, i) => { const o = 84 + i * 50 + 12; tri.forEach((k, j) => v[k].forEach((c, a) => dv.setFloat32(o + j * 12 + a * 4, c, true))); });
  return new File([buf], 'box-made-in-inches.stl', { type: 'model/stl' });
}
/** Compare landing: the sample bracket as A and a revised bracket (wider hole spacing, thicker arm) as B (D01). */
async function openCompareSample() {
  await openSample();
  if (!viewer.model) return;
  const b = buildBracket();
  b.traverse((o) => { if (o.name === 'Support arm') o.scale.z = 1.4; if (o.name === 'Fastener M8') o.position.x += o.position.x < 60 ? -3 : 3; });
  b.updateMatrixWorld(true);
  const blob = await exportObject(b, 'glb', { unit: 'mm', up: 'y', scope: 'all' });
  await compareWith([new File([blob], 'sample-bracket-rev-B.glb')]); // GLB is in metres; Compare converts it to A's mm
  toast('Model A is the bracket, B is a revision with a thicker arm and moved bolts. Try the deviation view.');
}
async function openSample() {
  if (!(await confirmDiscard())) return;
  stopLandingPreview();
  const g = buildBracket();
  setTool('none'); measure.clear(); editor.select(null); history.clear();
  document.body.classList.add('has-model');
  viewer.setModel(g); viewer.setUpAxis('y'); viewer.fit(g, 'iso');
  Object.assign(state, { modelName: 'sample-bracket', sourceUrls: null, lastFiles: null, ext: '', resources: [], identity: 'sample-bracket' });
  state.expanded = new Set([g.uuid]);
  state.caps = detectCapabilities(g, '', 0);
  setFileUnit('mm', 'declared', { undoable: false });
  refreshStats(); renderAll(); history.markClean();
  toast('Sample bracket (millimetres). Try Measure, Section or Export.');
}
let landing: { stop: () => void } | null = null;
/**
 * The opening screen shows the sample bracket as real 3D in its own small canvas (OV-043). Desktop only; it turns
 * for 30 seconds (or not at all with reduced motion) and is released as soon as a model opens.
 */
async function startLandingPreview() {
  const host = document.querySelector<HTMLElement>('.sample-stage');
  if (viewer.model || landing || !host || innerWidth < 1100 || document.body.classList.contains('embed')) return;
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  host.appendChild(r.domElement);
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.5));
  const obj = buildBracket();
  const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3());
  obj.position.sub(c);
  const pivot = new THREE.Group(); pivot.add(obj); scene.add(pivot);
  const grid = new THREE.GridHelper(260, 13, 0x666666, 0x3a3a3a);
  (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35;
  grid.position.y = box.min.y - c.y;
  scene.add(grid);
  const cam = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  cam.position.set(240, 170, 280); cam.lookAt(0, 0, 0);
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(0.5, 1, 1); cam.add(key); scene.add(cam);
  const size = () => { const w = host.clientWidth || 1, h = host.clientHeight || 1; r.setSize(w, h, false); r.domElement.style.width = '100%'; r.domElement.style.height = '100%'; cam.aspect = w / h; cam.updateProjectionMatrix(); r.render(scene, cam); };
  const ro = new ResizeObserver(size); ro.observe(host); size();
  let raf = 0, t0 = performance.now(), last = t0;
  const spin = (now: number) => {
    pivot.rotation.y += ((now - last) / 1000) * 0.3; last = now;
    r.render(scene, cam);
    if (now - t0 < 30000 && !document.hidden) raf = requestAnimationFrame(spin);
  };
  if (!prefs.reduceMotion) raf = requestAnimationFrame(spin);
  document.body.classList.add('has-preview');
  landing = { stop: () => { cancelAnimationFrame(raf); ro.disconnect(); scene.environment?.dispose(); pm.dispose(); r.dispose(); r.forceContextLoss(); r.domElement.remove(); } };
}
function stopLandingPreview() { landing?.stop(); landing = null; document.body.classList.remove('has-preview'); }
viewer.onChange(() => { if (viewer.model && landing) stopLandingPreview(); });

// ------------------------------------------------------------------ phones: contextual Undo / Done (OV-064), framing (OV-061)
function syncCtxBar() {
  const show = isPhone() && !!viewer.model && (state.tool !== 'none' || editor.gizmo !== 'none' || history.canUndo);
  $('#ctxBar').classList.toggle('hidden', !show);
  $('[data-ctxdone]').classList.toggle('hidden', state.tool === 'none' && editor.gizmo === 'none');
}
history.onChange(syncCtxBar);
editor.onChange(syncCtxBar);
/** After rotation, panel or breakpoint changes, re-frame only if the model has left the view (keeps a deliberate zoom). */
function ensureModelVisible() {
  if (!viewer.model) return;
  const box = viewer.bounds();
  if (box.isEmpty()) return;
  const cam = viewer.camera;
  cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  if (!frustum.intersectsBox(box)) viewer.fit(editor.selected ?? viewer.model);
}
let lastBreak = isPhone();
window.addEventListener('resize', () => {
  const now = isPhone();
  if (now !== lastBreak) { lastBreak = now; if (now) document.body.classList.add('no-left', 'no-right'); }
  // Tablets: one drawer at a time, so the model keeps a usable canvas (OV-062).
  if (innerWidth >= 700 && innerWidth < 1100 && !document.body.classList.contains('no-left') && !document.body.classList.contains('no-right')) document.body.classList.add('no-left');
  setTimeout(ensureModelVisible, 350);
});
window.addEventListener('orientationchange', () => setTimeout(ensureModelVisible, 500));
// Tablets: when a second drawer opens, the one that was already open closes (OV-062).
{
  const b = document.body;
  let was = { l: !b.classList.contains('no-left'), r: !b.classList.contains('no-right') };
  new MutationObserver(() => {
    const now = { l: !b.classList.contains('no-left'), r: !b.classList.contains('no-right') };
    if (innerWidth >= 700 && innerWidth < 1100 && now.l && now.r) {
      if (was.l && !was.r) b.classList.add('no-left'); else b.classList.add('no-right');
      return; // the observer fires again for the corrected state
    }
    if (now.l !== was.l || now.r !== was.r) { was = now; setTimeout(ensureModelVisible, 350); }
  }).observe(b, { attributes: true, attributeFilter: ['class'] });
}

// ------------------------------------------------------------------ file input & drag-drop
$('#fileInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const picked = [...(input.files || [])];
  input.value = '';
  if (qcIsOpen()) { pendingIntent = null; qcAdd(picked); return; }
  openFiles(picked);
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
  if (qcIsOpen()) { qcAdd(files); return; }
  const mode = await chooseOpenMode(files);
  if (mode === 'batch') { showBatchDialog(); return; }
  if (mode === 'qc') { qcAdd(files); return; }
  if (mode === 'grid') { arrangeNext = true; openFiles(files, null, 'replace'); return; }
  if (mode) openFiles(files, null, mode, mode !== 'replace');
});

/**
 * Asks how dropped files should open when it matters (CA-16, CA-17): several unrelated models (open together or
 * batch convert), or a model already open (replace, add to the scene, or open in a new tab).
 */
async function chooseOpenMode(files: File[]): Promise<OpenMode | 'batch' | 'grid' | 'qc' | null> {
  const models = files.filter((f) => MODEL_EXTS_APP.has(extOf(f.name)));
  const fromFolder = files.some((f) => (filePaths.get(f) || '').includes('/'));
  const many = models.length > 1 && !fromFolder;
  if (!many && !viewer.model) return 'replace';
  return new Promise((resolve) => {
    openModal(`<h2 id="dlgTitle">${many ? `${models.length} models` : 'Open ' + esc(models[0]?.name || 'files')}</h2>
      <p>${many ? 'How should these files open?' : 'A model is already open.'}</p>
      <div class="choice-list">
        ${viewer.model ? `<button class="choice" data-om="replace"><b>Replace the current model</b><small>${history.dirty ? 'You will be asked about unsaved changes.' : 'The current model closes.'}</small></button>` : ''}
        ${many && !viewer.model ? `<button class="choice" data-om="grid"><b>Side by side</b><small>Each model in its own spot, to look at them together.</small></button>` : ''}
        ${many && !viewer.model ? `<button class="choice" data-om="replace"><b>Open together</b><small>Keep their positions, for the parts of an assembly.</small></button>` : ''}
        ${many ? `<button class="choice" data-om="qc"><b>Just convert them</b><small>Quick Convert: pick a format and download, no viewer.</small></button>` : ''}
        ${viewer.model ? `<button class="choice" data-om="add"><b>Add to this scene</b><small>Converted to ${UNITS[state.unit].label.toLowerCase()}; one undo step.</small></button>` : ''}
        ${viewer.model ? `<button class="choice" data-om="tab"><b>Open in a new tab</b><small>Keep the current model open next to it.</small></button>` : ''}
        ${many ? `<button class="choice" data-om="batch"><b>Batch convert</b><small>Convert each file separately into one ZIP.</small></button>` : ''}
      </div>
      <div class="modal-actions"><button class="btn-outline" data-om="">${t('Cancel')}</button></div>`);
    let done = false;
    const finish = (v: OpenMode | 'batch' | 'grid' | 'qc' | null) => { if (!done) { done = true; resolve(v); } };
    $('#modalCard').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-om]');
      if (!b) return;
      const v = b.dataset.om as OpenMode | 'batch' | 'grid' | 'qc' | '';
      modal.close();
      finish(v || null);
      if (v === 'batch') setTimeout(() => (window as any).__omniBatchFiles?.(files), 50);
    };
    modal.addEventListener('close', () => finish(null), { once: true });
  });
}

/** Reads dropped files, including the contents of dropped folders (keeping their folder paths, OV-011). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      filePaths.set(f, entry.fullPath.replace(/^\//, ''));
      out.push(f);
    }
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
  const target = e.target as HTMLElement;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || ($('#modal') as HTMLDialogElement).open || document.querySelector('.palette-wrap')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); editor.duplicateSelected(); return; }
  if (mod && k === 'o') { e.preventDefault(); runAction('open'); return; }
  if (mod && k === 's') { e.preventDefault(); if (viewer.model) saveProject(); return; }
  if (mod && k === 'e') { e.preventDefault(); runAction('export'); return; }
  if (mod && k === 'g') { e.preventDefault(); if (e.shiftKey && editor.selected) editor.ungroup(editor.selected); else editor.groupSelection(); return; }
  if (mod) return;
  // Character shortcuts can clash with speech input and screen readers: they can be limited or turned off (OV-057).
  if (prefs.keys === 'off' && k !== 'escape') return;
  if (prefs.keys === 'canvas' && k !== 'escape' && !(target === document.body || target.closest('#stage'))) return;
  if (target.closest('[role="tree"],[role="listbox"],[role="menu"]') && k.length === 1) return;
  if (k === '\\') { toggleFocusMode(); return; }
  // Keyboard camera (OV-059): arrows orbit, Shift+arrows pan, + / - zoom, when the 3D view has focus.
  if (viewer.model && (target === viewer.renderer.domElement || target.id === 'viewport') && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-'].includes(k)) {
    e.preventDefault();
    keyCamera(k, e.shiftKey);
    return;
  }
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
    case 'h': if (editor.selection.length) editor.setVisibility(editor.selection, (o) => !o.visible, 'Hide / show'); renderTree(); break;
    case 'delete': case 'backspace': editor.deleteSelection(); break;
    case 'escape':
      // Measuring: Esc first drops a half-placed distance, then clears every measurement (with undo in the
      // message), and only then leaves the tool.
      if ((state.tool === 'measure' || state.tool === 'none') && measure.cancelPoint()) break;
      if ((state.tool === 'measure' || state.tool === 'none') && measure.list.length) {
        const saved = measure.serialize();
        const n = saved.length;
        measure.clear();
        toast(n === 1 ? 'Cleared 1 measurement' : `Cleared ${n} measurements`, false, { label: 'Undo', run: () => measure.restore(saved) });
        break;
      }
      if (state.tool !== 'none') setTool('none');
      else if (editor.gizmo !== 'none') editor.setGizmo('none');
      else selectObject(null);
      break;
    case '?': runAction('help'); break;
    default: return;
  }
  updateToolbar();
});

function keyCamera(k: string, pan: boolean) {
  const c = viewer.controls, cam = viewer.camera;
  const off = cam.position.clone().sub(c.target);
  const step = 0.12;
  if (k === '+' || k === '=' || k === '-') {
    const f = k === '-' ? 1.15 : 1 / 1.15;
    if (cam === viewer.ortho) { viewer.ortho.zoom /= f; viewer.ortho.updateProjectionMatrix(); } else cam.position.copy(c.target).addScaledVector(off, f);
  } else if (pan) {
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
    const d = off.length() * 0.06;
    const v = k === 'arrowleft' ? right.multiplyScalar(-d) : k === 'arrowright' ? right.multiplyScalar(d) : k === 'arrowup' ? up.multiplyScalar(d) : up.multiplyScalar(-d);
    cam.position.add(v); c.target.add(v);
  } else {
    const sph = new THREE.Spherical().setFromVector3(off);
    if (k === 'arrowleft') sph.theta -= step; if (k === 'arrowright') sph.theta += step;
    if (k === 'arrowup') sph.phi = Math.max(0.05, sph.phi - step); if (k === 'arrowdown') sph.phi = Math.min(Math.PI - 0.05, sph.phi + step);
    cam.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph));
  }
  cam.lookAt(c.target); c.update(); viewer.requestRender();
}
viewer.renderer.domElement.tabIndex = 0;
viewer.renderer.domElement.setAttribute('aria-label', '3D view. Arrow keys orbit, Shift and arrows pan, plus and minus zoom.');
viewer.renderer.domElement.setAttribute('role', 'img');

// ------------------------------------------------------------------ resizable side panels (OV-036)
function setupPanelResize() {
  for (const side of ['left', 'right'] as const) {
    const panel = $(side === 'left' ? '#leftPanel' : '#rightPanel');
    const handle = document.createElement('div');
    handle.className = `panel-resizer ${side}`;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize the ${side === 'left' ? 'parts' : 'details'} panel`);
    handle.tabIndex = 0;
    panel.appendChild(handle);
    const key = `panelW.${side}`;
    const apply = (w: number) => { const cl = Math.max(220, Math.min(560, w, innerWidth - 420)); document.documentElement.style.setProperty(`--${side}-w`, cl + 'px'); store.set(key, String(cl)); };
    const saved = Number(store.get(key, ''));
    if (saved) apply(saved);
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = panel.getBoundingClientRect().width;
      const mv = (ev: PointerEvent) => apply(side === 'left' ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0));
      const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); layoutToolbar(); };
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const w = panel.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') apply(side === 'left' ? w - 16 : w + 16);
      if (e.key === 'ArrowRight') apply(side === 'left' ? w + 16 : w - 16);
    });
    handle.addEventListener('dblclick', () => { document.documentElement.style.removeProperty(`--${side}-w`); store.set(key, ''); });
  }
}
setupPanelResize();

/** Stops every moving thing at once: animation, auto-rotate, the landing spin (OV-060). */
function pauseAllMotion() {
  viewer.setPaused(true); viewer.setAutoRotate(false); stopLandingPreview();
  viewer.setContinuous('landing', false);
  toast('All motion paused');
  updateToolbar();
}

// ------------------------------------------------------------------ change wiring
history.onChange(() => { updateToolbar(); });
editor.onEdited = () => { refreshStats(250); renderTree(); };
history.onChange(() => { renderTabs?.(); updateStatus(); });
// Geometry edits make existing measurements possibly out of date (OV-102).
let lastHistLen = 0;
history.onChange(() => { const n = history.labels.length; if (n !== lastHistLen && measure.list.length && /Scale|Repair|Reduce|Hollow|Cut|Move|Rotate|Mirror|Rescale|Combine|Subtract|Intersect|transform|Lay flat|Drop|Centre/i.test(history.nextUndo || '')) measure.markStale(); lastHistLen = n; });
editor.onChange(() => { updateToolbar(); renderDetailsSoon(); });
measure.onChange(() => { renderDetailsSoon(); measureStepHint(); });
/** While measuring, the hint names the next step and stays put, so the canvas says what to do (D03, D05). */
function measureStepHint() {
  if (state.tool !== 'measure') return;
  const tap = isTouch() ? 'Tap' : 'Click';
  const n = measure.pendingCount;
  // Says what Esc does right now: drop the half-placed point, clear the measurements, or leave the tool.
  const stop = isTouch() ? 'Done to stop' : n ? 'Esc cancels this point' : measure.list.length ? 'Esc clears all' : 'Esc to stop';
  const h = measure.hoverTarget;
  const over = h?.kind === 'circle' ? (h.showRadius ? `${tap} to keep this radius` : `${tap} to keep this diameter`) : h?.kind === 'edge' ? `${tap} to keep this edge length` : '';
  let text: string;
  if (measure.mode === 'circle') text = `${tap} point ${n + 1} of 3 around the hole · ${stop}`;
  else if (n) text = `Now ${tap.toLowerCase()} the second point · snaps to corners, hole centres and edges · ${stop}`;
  else if (over) text = `${over} · ${stop}`;
  else if (measure.mode === 'diameter') text = `Point at a hole, shaft or round edge · ${stop}`;
  else if (measure.mode === 'edge') text = `Point at an edge of the model · ${stop}`;
  else if (measure.mode === 'smart') text = `Point at a hole or edge, or ${tap.toLowerCase()} a corner or face to start a distance · ${stop}`;
  else text = `${tap} the first point · snaps to corners, hole centres and edges · ${stop}`;
  const hint = $('#toolHint');
  hint.textContent = tr(text);
  hint.classList.remove('hidden', 'fade');
  clearTimeout(hintTimer);
}
let detailsRaf = 0;
function renderDetailsSoon() { cancelAnimationFrame(detailsRaf); detailsRaf = requestAnimationFrame(renderDetails); }
// live-update the numeric transform fields while dragging the gizmo
editor.transform.addEventListener('objectChange', () => updateTransformFields());

function renderAll() {
  layoutToolbar();
  renderTree();
  renderMaterials();
  renderDetails();
  renderSettings();
  updateToolbar();
  updateStatus();
}

function updateStatus() {
  const s = state.stats;
  $('#statusLeft').textContent = viewer.model ? `${state.modelName}${history.dirty ? ' · ' + t('Unsaved changes') : ''}` : 'Ready · drop a 3D file anywhere';
  $('#statusRight').textContent = s && viewer.model
    ? `${fmtInt(s.triangles)} tris · ${fmtInt(s.vertices + s.points)} verts · ${fmtD(s.size.x, 2)} × ${fmtD(s.size.y, 2)} × ${fmtD(s.size.z, 2)}${s.hiddenParts ? ` · ${s.hiddenParts} hidden` : ''}`
    : '';
}

// ------------------------------------------------------------------ model bar & state badges (OV-035, OV-039)
function updateModelBar() {
  const bar = document.getElementById('modelBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !viewer.model);
  if (!viewer.model) return;
  const ext = state.ext ? state.ext.toUpperCase() : 'SCENE';
  $('#mbName').textContent = state.modelName || 'Untitled scene';
  $('#mbName').title = state.modelName;
  $('#mbFormat').textContent = ext;
  $('#mbDirty').classList.toggle('hidden', !history.dirty);
}
function updateBadges() {
  const host = document.getElementById('badges');
  if (!host) return;
  const b: string[] = [];
  if (viewer.model) {
    if (viewer.section.enabled) b.push(`<button class="badge" data-badge="section">${icon('section')}${t('Section on')}<span aria-hidden="true">×</span></button>`);
    const hidden = viewer.model.getObjectsByProperty('visible', false).filter((o) => !o.userData.helper && !o.userData.proxy).length;
    if (hidden) b.push(`<button class="badge" data-badge="hidden">${icon('eyeoff')}${t('Hidden parts')}: ${hidden}<span aria-hidden="true">×</span></button>`);
    if (viewer.explode > 0) b.push(`<button class="badge" data-badge="explode">${icon('explode')}${t('Exploded')}<span aria-hidden="true">×</span></button>`);
    if (viewer.displayMode !== 'shaded') b.push(`<button class="badge" data-badge="display">${icon('layers')}${viewer.displayMode}<span aria-hidden="true">×</span></button>`);
    if (viewer.camera === viewer.ortho) b.push(`<button class="badge" data-badge="ortho">Orthographic<span aria-hidden="true">×</span></button>`);
    if (editor.multi.size) b.push(`<span class="badge static">${editor.selection.length} selected</span>`);
  }
  host.innerHTML = b.join('');
}
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-badge]');
  if (!b) return;
  const k = b.dataset.badge;
  if (k === 'section') { viewer.setSection({ enabled: false }); if (state.tool === 'section') setTool('none'); }
  if (k === 'hidden') showEverything();
  if (k === 'explode') viewer.setExplode(0);
  if (k === 'display') viewer.setDisplayMode('shaded');
  if (k === 'ortho') viewer.setProjection('perspective');
  renderDetails(); updateToolbar();
});
viewer.onChange(() => updateBadges());
function showEverything() {
  if (!viewer.model) return;
  const all: THREE.Object3D[] = [];
  viewer.model.traverse((o) => { if (!o.userData.helper && !o.userData.proxy) all.push(o); });
  editor.setVisibility(all, true, 'Show everything');
  renderTree(); refreshStats(50);
}
/** Focus mode: hide both side panels for more model, one key to bring them back (OV-032). */
function toggleFocusMode() {
  const b = document.body;
  const focused = b.classList.contains('no-left') && b.classList.contains('no-right');
  b.classList.toggle('no-left', !focused ? true : false);
  b.classList.toggle('no-right', !focused ? true : false);
  if (focused) b.classList.remove('no-left', 'no-right');
  toast(focused ? 'Panels shown' : 'Focus mode · press \\ to show the panels');
}

// ------------------------------------------------------------------ scene tree
function kindIcon(o: any) {
  if (o.isMesh) return 'mesh';
  if (o.isPoints) return 'points';
  if (o.isLine) return 'ruler';
  return 'group';
}

// The tree is a real ARIA tree: arrow keys, Home/End, typeahead, Enter to select (OV-054). Large assemblies are
// paged with a "Show more" button instead of an unreachable "+N more" row, and searchable (OV-037).
const TREE_PAGE = 300;
const treeShown = new Map<string, number>();
let treeQuery = '';
function renderTree() {
  const host = $('#tab-scene');
  const model = viewer.model;
  if (!model) { host.innerHTML = '<div class="empty">No model loaded.</div>'; return; }
  const kidsOf = (o: THREE.Object3D) => (o.userData.splat ? [] : o.children.filter((c) => !c.userData.helper && !c.userData.proxy));
  const isSel = (o: THREE.Object3D) => editor.selected === o || editor.multi.has(o);
  const row = (o: THREE.Object3D, level: number, kids: number, open: boolean, path = '') => {
    const name = o.name || (o as any).type;
    return `<div class="node ${isSel(o) ? 'selected' : ''} ${o.visible ? '' : 'hidden-obj'}" data-uuid="${o.uuid}" role="treeitem" tabindex="-1"
      aria-level="${level}" aria-selected="${isSel(o)}" ${kids ? `aria-expanded="${open}"` : ''}>
      <span class="caret ${open ? 'open' : ''}" aria-hidden="true">${kids ? icon('caret') : ''}</span>
      <span class="kind" aria-hidden="true">${icon(kindIcon(o))}</span>
      <span class="node-name" title="${esc(name)}">${esc(name)}${path ? `<small class="node-path">${esc(path)}</small>` : ''}</span>
      <button class="node-btn" data-node="fit" tabindex="-1" aria-label="Zoom to ${esc(name)}" title="Zoom to">${icon('target')}</button>
      <button class="node-btn vis" data-node="vis" tabindex="-1" aria-label="${o.visible ? 'Hide' : 'Show'} ${esc(name)}" title="Show / hide">${icon(o.visible ? 'eye' : 'eyeoff')}</button>
    </div>`;
  };
  if (treeQuery) {
    const q = treeQuery.toLowerCase();
    const hits: { o: THREE.Object3D; path: string }[] = [];
    const walk = (o: THREE.Object3D, path: string[]) => {
      const name = o.name || (o as any).type;
      if (o !== model && name.toLowerCase().includes(q)) hits.push({ o, path: path.join(' / ') });
      for (const k of kidsOf(o)) walk(k, o === model ? path : [...path, name]);
    };
    walk(model, []);
    const n = treeShown.get('search') ?? TREE_PAGE;
    host.innerHTML = `<div class="tree-search-meta">${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length ? ` · <button class="link-btn" data-treeisolate>Show only these</button> · <button class="link-btn" data-treeselectall>Select all</button>` : ''}</div>
      <ul class="tree" role="tree" aria-label="Parts">${hits.slice(0, n).map((h) => `<li role="none">${row(h.o, 1, 0, false, h.path)}</li>`).join('')}
      ${hits.length > n ? `<li role="none"><button class="tree-more" data-treemore="search">Show ${Math.min(TREE_PAGE, hits.length - n)} more of ${hits.length - n}</button></li>` : ''}</ul>`;
    return;
  }
  const build = (o: THREE.Object3D, level: number): string => {
    const kids = kidsOf(o);
    const open = state.expanded.has(o.uuid);
    let inner = '';
    if (kids.length && open) {
      const n = treeShown.get(o.uuid) ?? TREE_PAGE;
      inner = '<ul role="group">' + kids.slice(0, n).map((k) => `<li role="none">${build(k, level + 1)}</li>`).join('') +
        (kids.length > n ? `<li role="none"><button class="tree-more" data-treemore="${o.uuid}">Show ${Math.min(TREE_PAGE, kids.length - n)} more of ${kids.length - n}</button></li>` : '') + '</ul>';
    }
    return row(o, level, kids.length, open) + inner;
  };
  host.innerHTML = `<ul class="tree" role="tree" aria-label="Parts" aria-multiselectable="true"><li role="none">${build(model, 1)}</li></ul>`;
  const first = host.querySelector<HTMLElement>('.node.selected') || host.querySelector<HTMLElement>('.node');
  if (first) first.tabIndex = 0;
}

const findByUuid = (uuid: string) => viewer.model?.getObjectByProperty('uuid', uuid) ?? null;

$('#treeSearch')?.addEventListener('input', (e) => { treeQuery = (e.target as HTMLInputElement).value.trim(); treeShown.delete('search'); renderTree(); });
$('#treeExpandAll')?.addEventListener('click', () => { viewer.model?.traverse((o) => { if (o.children.length && state.expanded.size < 5000) state.expanded.add(o.uuid); }); renderTree(); });
$('#treeCollapseAll')?.addEventListener('click', () => { state.expanded = new Set(viewer.model ? [viewer.model.uuid] : []); renderTree(); });

$('#tab-scene').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const more = t.closest<HTMLElement>('[data-treemore]');
  if (more) { const k = more.dataset.treemore!; treeShown.set(k, (treeShown.get(k) ?? TREE_PAGE) + TREE_PAGE); renderTree(); return; }
  if (t.closest('[data-treeisolate]') || t.closest('[data-treeselectall]')) {
    const q = treeQuery.toLowerCase();
    const hits: THREE.Object3D[] = [];
    viewer.model?.traverse((o) => { if (o !== viewer.model && !o.userData.helper && (o.name || '').toLowerCase().includes(q)) hits.push(o); });
    if (t.closest('[data-treeselectall]')) { editor.select(hits[0] ?? null); hits.slice(1).forEach((h) => editor.multi.add(h)); renderTree(); renderDetails(); return; }
    isolateMany(hits);
    return;
  }
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
    focusNode(obj.uuid);
    return;
  }
  const me = e as MouseEvent;
  if (me.ctrlKey || me.metaKey || me.shiftKey) { editor.toggleInSelection(obj); renderTree(); renderDetails(); focusNode(obj.uuid); return; }
  selectObject(obj);
  focusNode(obj.uuid);
});
$('#tab-scene').addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.node');
  const obj = row && findByUuid(row.dataset.uuid!);
  if (obj) viewer.fit(obj);
});
function focusNode(uuid: string) {
  requestAnimationFrame(() => {
    const el = $('#tab-scene').querySelector<HTMLElement>(`.node[data-uuid="${uuid}"]`);
    if (!el) return;
    $$<HTMLElement>('#tab-scene .node').forEach((n) => (n.tabIndex = -1));
    el.tabIndex = 0; el.focus();
  });
}
let typeahead = '', typeaheadTimer = 0;
$('#tab-scene').addEventListener('keydown', (e) => {
  const cur = (e.target as HTMLElement).closest<HTMLElement>('.node');
  if (!cur) return;
  const rows = $$<HTMLElement>('#tab-scene .node');
  const i = rows.indexOf(cur);
  const obj = findByUuid(cur.dataset.uuid!);
  const go = (el?: HTMLElement) => { if (el) { e.preventDefault(); focusNode(el.dataset.uuid!); } };
  switch (e.key) {
    case 'ArrowDown': go(rows[i + 1]); return;
    case 'ArrowUp': go(rows[i - 1]); return;
    case 'Home': go(rows[0]); return;
    case 'End': go(rows[rows.length - 1]); return;
    case 'ArrowRight':
      if (obj && cur.getAttribute('aria-expanded') === 'false') { e.preventDefault(); state.expanded.add(obj.uuid); renderTree(); focusNode(obj.uuid); }
      else go(rows[i + 1]);
      return;
    case 'ArrowLeft':
      if (obj && cur.getAttribute('aria-expanded') === 'true') { e.preventDefault(); state.expanded.delete(obj.uuid); renderTree(); focusNode(obj.uuid); }
      else if (obj?.parent && obj !== viewer.model) { e.preventDefault(); focusNode(obj.parent.uuid); }
      return;
    case 'Enter': if (obj) { e.preventDefault(); selectObject(obj); focusNode(obj.uuid); } return;
    case ' ': if (obj) { e.preventDefault(); editor.toggleInSelection(obj); renderTree(); renderDetails(); focusNode(obj.uuid); } return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    typeahead += e.key.toLowerCase(); clearTimeout(typeaheadTimer); typeaheadTimer = window.setTimeout(() => (typeahead = ''), 700);
    const hit = rows.slice(i + 1).concat(rows.slice(0, i + 1)).find((r) => (r.querySelector('.node-name')?.textContent || '').toLowerCase().startsWith(typeahead));
    go(hit);
  }
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
    // Texture diagnostics (OV-106): size, approximate GPU memory, missing images, UVs.
    const texKeys = Object.keys(m.mat).filter((k) => (m.mat as any)[k]?.isTexture);
    const texInfo = texKeys.map((k) => {
      const tx = (m.mat as any)[k]; const img = tx.image;
      const w = img?.width || img?.videoWidth || 0, h = img?.height || img?.videoHeight || 0;
      const missing = !w || (img?.src && /^data:,(missing|blocked)/.test(img.src));
      return { k, w, h, missing, bytes: w * h * 4 * 1.33 };
    });
    const noUv = texInfo.length && m.meshes.some((x) => !x.geometry?.attributes?.uv);
    const meta = [
      texInfo.length ? texInfo.map((x) => x.missing ? `<span class="bad">${x.k}: missing</span>` : `${x.k} ${x.w}×${x.h}`).join(', ') : '',
      texInfo.length ? `≈${(texInfo.reduce((n, x) => n + x.bytes, 0) / 1048576).toFixed(1)} MB` : '',
      noUv ? '<span class="bad">no UVs</span>' : '',
      (m.mat as any).vertexColors ? 'vertex colours' : '',
      `${m.meshes.length} part${m.meshes.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ');
    return `<div class="mat-row" data-mat="${i}">
      <label class="swatch" style="background:${hex}" title="Change colour for every part using this material"><input type="color" value="${hex}" data-matcolor="${i}" /></label>
      <div class="mat-name">${esc(m.mat.name || `Material ${i + 1}`)}<div class="mat-meta">${meta}</div></div>
      <button class="node-btn" style="opacity:1" data-matselect="${i}" aria-label="Select every part using this material" title="Select every part using this material">${icon('target')}</button>
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
    if (b) {
      const list = mats[Number(b.dataset.matselect)].meshes;
      selectObject(list[0]); list.slice(1).forEach((x) => editor.multi.add(x));
      renderTree(); renderDetails(); updateBadges();
      toast(`${list.length} part${list.length === 1 ? '' : 's'} selected`);
    }
  };
}

// ------------------------------------------------------------------ details panel
const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

function dimsHtml(size: THREE.Vector3) {
  return `<div class="dims">
    <div class="dim"><b>X · ${t('Width')}</b><span>${fmtD(size.x, 2)}</span></div>
    <div class="dim"><b>Y · ${t('Height')}</b><span>${fmtD(size.y, 2)}</span></div>
    <div class="dim"><b>Z · ${t('Depth')}</b><span>${fmtD(size.z, 2)}</span></div>
  </div>`;
}

function toolSection(): string {
  const u = UNITS[state.unit].short;
  switch (state.tool) {
    case 'measure': {
      const items = measure.list.slice().reverse().map((m) => `
        <div class="measure-item ${m.stale ? 'stale' : ''} ${m.hidden ? 'is-hidden' : ''}">
          <input type="color" value="${m.color}" data-mcolor="${m.id}" aria-label="Colour of ${esc(m.name)}" class="mi-color"/>
          <div class="mi-body">
            <input class="mi-name" value="${esc(m.name)}" data-mname="${m.id}" aria-label="Name"/>
            <div class="mi-main">${valueText(m, fmtD)}</div>
            ${m.info ? `<div class="mi-sub mi-what">${esc(m.info)}</div>` : ''}
            ${m.kind === 'circle'
              ? `<div class="mi-sub">${m.showRadius ? `Diameter ${fmtD(m.distance)}` : `Radius ${fmtD(m.radius!)}`} · circumference ${fmtD(Math.PI * m.distance)}</div>`
              : `<div class="mi-sub">ΔX ${fmtNum(toDisp(m.delta.x))} · ΔY ${fmtNum(toDisp(m.delta.y))} · ΔZ ${fmtNum(toDisp(m.delta.z))} ${UNITS[dispUnit()].short}</div>
                 ${m.angle !== null ? `<div class="mi-sub">Angle between faces ${fmtNum(m.angle, 2)}°</div>` : ''}
                 ${m.parallelDistance !== null ? `<div class="mi-sub">Parallel faces gap ${fmtD(m.parallelDistance)}</div>` : m.planeDistance !== null ? `<div class="mi-sub">To first face's plane ${fmtD(m.planeDistance)}</div>` : ''}
                 ${m.snapA || m.snapB ? `<div class="mi-sub">Snapped: ${m.snapA || 'surface'} → ${m.snapB || 'surface'}</div>` : ''}`}
            ${m.stale ? `<div class="mi-sub warn-note">Measured before the model was edited. <button class="link-btn" data-mrefresh="${m.id}">Still correct</button> or remove it.</div>` : ''}
          </div>
          <button class="node-btn" style="opacity:1" data-mcopy="${m.id}" aria-label="${t('Copy')} ${esc(valueText(m, fmtD))}" title="${t('Copy value with unit')}">${icon('copy')}</button>
          <button class="node-btn" style="opacity:1" data-mhide="${m.id}" aria-label="${m.hidden ? 'Show' : 'Hide'} ${esc(m.name)}">${icon(m.hidden ? 'eyeoff' : 'eye')}</button>
          <button class="node-btn" style="opacity:1" data-mremove="${m.id}" aria-label="Remove ${esc(m.name)}">${icon('x')}</button>
        </div>`).join('');
      return `<div class="section">
        <div class="section-head"><span class="section-title">${t('Measure')}</span><span class="grow"></span>
          ${measure.list.length ? `<button class="chip" data-mexport>${icon('download')}JSON</button><button class="chip danger" data-mclear>${icon('trash')}${t('Clear')}</button>` : ''}</div>
        <div class="seg seg-4" style="margin-bottom:8px">${([['smart', 'Smart'], ['distance', 'Distance'], ['diameter', 'Diameter'], ['edge', 'Edge']] as const).map(([k, l]) => `<button class="${measure.mode === k || (k === 'diameter' && measure.mode === 'circle') ? 'active' : ''}" data-mmode="${k}">${l}</button>`).join('')}</div>
        <p class="note" style="margin-top:0">${(() => {
          const tap = isTouch() ? 'Tap' : 'Click';
          switch (measure.mode) {
            case 'smart': return `Point at a hole or round edge to see its diameter, or at an edge to see its length, then ${tap.toLowerCase()} to keep it. ${tap} a corner or face to start a distance.`;
            case 'distance': return `${tap} two points. Snaps to corners, hole centres (point at the hole's wall or rim), edge midpoints and edges. Hold Shift on a rim for a point on the rim instead of its centre.`;
            case 'diameter': return `Point at a hole, shaft, round edge or fillet: its diameter (or radius) shows up, ${tap.toLowerCase()} to keep it. <button class="link-btn" data-mmode="circle">Use 3 points instead</button>`;
            case 'edge': return `Point at an edge of the model: straight edges give their length, round edges their radius and length.`;
            default: return `${tap} three points around a hole or round edge${measure.pendingCount ? ` (${measure.pendingCount}/3)` : ''}. <button class="link-btn" data-mmode="diameter">Find holes automatically</button>`;
          }
        })()}${isTouch() ? ' Drag with one finger to orbit between taps.' : ''}</p>
        ${measure.mode === 'distance' || measure.mode === 'smart' ? `<div class="row"><label for="mSnap">Snap to</label><select id="mSnap" data-msnapmode>
          ${([['auto', 'Corners, hole centres, edges'], ['corner', 'Corners only'], ['centre', 'Hole centres only'], ['edge', 'Edges and midpoints'], ['off', 'Nothing (free point)']] as const).map(([k, l]) => `<option value="${k}" ${measure.snapMode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
        <div class="row"><label for="mRadius">Snap distance</label><input type="range" id="mRadius" min="4" max="40" step="1" value="${measure.snapRadius}" data-msnapradius aria-label="Snap distance in pixels"/></div>
        ${editor.selected && editor.selected !== viewer.model ? `<label class="check"><input type="checkbox" data-monlysel ${measureOnlySelected ? 'checked' : ''}/> Only pick on the selected part</label>` : ''}
        <p class="note">Measurements use the displayed triangle mesh. For CAD files that is a close approximation, not the exact surface.</p>
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
  if (!o) return '';
  if (editor.multi.size) {
    const list = editor.selection;
    const box = new THREE.Box3(); list.forEach((x) => box.union(viewer.bounds(x)));
    return `<div class="section"><div class="section-head"><span class="section-title">${t('Selection')} · ${list.length} parts</span><span class="grow"></span>
      <button class="node-btn" style="opacity:1" data-sel="deselect" aria-label="Clear selection">${icon('x')}</button></div>
      ${box.isEmpty() ? '' : dimsHtml(box.getSize(new THREE.Vector3()))}
      <div class="btn-row">
        <button class="chip" data-msel="isolate">${icon('isolate')}Show only these</button>
        <button class="chip" data-msel="hide">${icon('eyeoff')}Hide</button>
        <button class="chip" data-msel="group">${icon('group')}Group</button>
        <button class="chip" data-msel="export">${icon('download')}Export selected</button>
        <button class="chip danger" data-msel="delete">${icon('trash')}Delete</button>
      </div>
      <p class="note">Ctrl / Shift-click parts to add or remove them. Move, rotate and scale act on the first part.</p></div>`;
  }
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
  const ifc = o.userData.ifc as import('./ifc').IfcInfo | undefined;
  const ifcHtml = ifc ? `<div class="section" id="sec-ifc"><div class="section-head"><span class="section-title">BIM element</span></div>
    <dl class="kv"><dt>Type</dt><dd>${esc(ifc.type)}</dd>${ifc.storey ? `<dt>Storey</dt><dd>${esc(ifc.storey)}</dd>` : ''}${ifc.objectType ? `<dt>Object type</dt><dd>${esc(ifc.objectType)}</dd>` : ''}
    ${ifc.globalId ? `<dt>GlobalId</dt><dd class="mono">${esc(ifc.globalId)}</dd>` : ''}<dt>IFC id</dt><dd class="mono">#${ifc.id}</dd></dl>
    ${ifc.psets ? Object.entries(ifc.psets).map(([set, props]) => `<details class="pset"><summary>${esc(set)}</summary><dl class="kv">${Object.entries(props).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`).join('') : ''}
    <div class="btn-row"><button class="chip" data-ifcsame="type">Select all ${esc(ifc.type)}</button>${ifc.storey ? `<button class="chip" data-ifcsame="storey">Show only this storey</button>` : ''}</div>
    <p class="note">Element data is shown here only; mesh exports (GLB, OBJ, STL…) don't keep IFC properties.</p></div>` : '';
  return `${ifcHtml}<div class="section">
    <div class="section-head"><span class="section-title">${t('Selection')}</span><span class="grow"></span>
      <button class="node-btn" style="opacity:1" data-sel="deselect" aria-label="Deselect">${icon('x')}</button></div>
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
      ${!isRoot && o.children.filter((c) => !c.userData.helper).length ? `<button class="chip" data-sel="ungroup">${icon('group')}Ungroup</button>` : ''}
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

/** Model health summary: what was checked, with Pass / Fail / Not checked / Not applicable (OV-116). */
function healthSection(): string {
  const s = state.stats, c = state.caps;
  if (!viewer.model || !s || !c) return '';
  const item = (label: string, st: 'pass' | 'fail' | 'unknown' | 'na', note: string, action = '') =>
    `<li class="hs-${st}"><span class="hs-dot" aria-hidden="true"></span><span><b>${label}</b> <span class="hs-state">${({ pass: 'Pass', fail: 'Check', unknown: 'Not checked', na: 'Not applicable' })[st]}</span><br><small>${note}</small></span>${action}</li>`;
  const missing = state.resources.filter((r) => r.status !== 'loaded').length;
  const unitsOk = state.unitSource === 'declared' || state.unitSource === 'user' || state.unitSource === 'saved';
  const items = [
    item('Units', unitsOk ? 'pass' : 'unknown', `${UNITS[state.unit].label}, ${t(UNIT_SOURCE_LABEL[state.unitSource])}`, unitsOk ? '' : '<button class="link-btn" data-focus="unit">Confirm</button>'),
    item('Files & textures', missing ? 'fail' : 'pass', missing ? `${missing} missing or blocked` : 'Everything the model asked for was found', missing ? '<button class="link-btn" data-tool="assets">Fix</button>' : ''),
    c.volume ? item('Closed surface', s.closed === null ? 'unknown' : s.closed ? 'pass' : 'fail', s.closed === null ? 'Checking in the background…' : s.closed ? 'Every edge is shared by two triangles' : 'Has holes or open edges', s.closed === false ? '<button class="link-btn" data-tool="repair">Inspect</button>' : '') : item('Closed surface', 'na', c.isSplat ? 'Splats have no surface' : 'No triangle mesh'),
    c.volume ? item('Face orientation', s.invertedParts ? 'fail' : 'pass', s.invertedParts ? `${s.invertedParts} part${s.invertedParts === 1 ? ' is' : 's are'} inside-out` : 'Faces point outwards', s.invertedParts ? '<button class="link-btn" data-tool="repair">Repair</button>' : '') : '',
    item('Hidden parts', s.hiddenParts ? 'unknown' : 'pass', s.hiddenParts ? `${s.hiddenParts} hidden: left out of size, volume and exports` : 'All parts visible', s.hiddenParts ? '<button class="link-btn" data-badge="hidden">Show all</button>' : ''),
  ].filter(Boolean);
  return `<div class="section" id="sec-health"><div class="section-head"><span class="section-title">Model health</span></div><ul class="health">${items.join('')}</ul>
    <p class="note">Mesh checks only. Wall thickness, overhangs and printer settings need their own checks. <button class="link-btn" data-action="printcheck">${t('Print-ready checklist')}</button></p></div>`;
}

/**
 * Print-ready checklist (N04): strings the existing checks together in print order. Each line says what was checked;
 * a check that hasn't been run says "Not checked". Nothing here claims a model is printable.
 */
function showPrintChecklist() {
  const s = state.stats, c = state.caps;
  if (!viewer.model || !s || !c) { toast('Open a model first (or select a part) to use this'); return; }
  const unitsOk = state.unitSource === 'declared' || state.unitSource === 'user' || state.unitSource === 'saved';
  const row = (n: number, label: string, st: 'pass' | 'fail' | 'unknown', note: string, action: string) =>
    `<li class="hs-${st}"><span class="hs-dot" aria-hidden="true"></span><span><b>${n}. ${label}</b> <span class="hs-state">${({ pass: 'Done', fail: 'Needs attention', unknown: 'Not checked' })[st]}</span><br><small>${note}</small></span>${action}</li>`;
  const ran = (id: string) => printRan.has(id);
  const items = [
    row(1, 'Real size', unitsOk ? 'pass' : 'unknown', `${fmtSize()} · ${UNITS[state.unit].label}, ${t(UNIT_SOURCE_LABEL[state.unitSource])}`, unitsOk ? '' : '<button class="btn-outline small" data-pc="unit">Confirm units</button>'),
    c.volume ? row(2, 'Closed surface', s.closed === null ? 'unknown' : s.closed ? 'pass' : 'fail', s.closed === null ? 'Checking…' : s.closed ? 'Every edge is shared by two triangles' : 'Has holes or open edges: slicers may fill them unpredictably', s.closed === false ? '<button class="btn-outline small" data-pc="repair">Repair</button>' : '') : row(2, 'Closed surface', 'fail', 'No triangle mesh to print', ''),
    c.volume ? row(3, 'Faces point outwards', s.invertedParts ? 'fail' : 'pass', s.invertedParts ? `${s.invertedParts} part(s) inside-out` : 'Faces point outwards', s.invertedParts ? '<button class="btn-outline small" data-pc="repair">Repair</button>' : '') : '',
    row(4, 'Fits the printer bed', ran('bed') ? 'pass' : 'unknown', ran('bed') ? 'Checked against the printer chosen in the bed tool' : 'Pick your printer and see the model on its bed', `<button class="btn-outline small" data-pc="bed">${ran('bed') ? 'Check again' : 'Check bed fit'}</button>`),
    row(5, 'Walls thick enough', ran('thickness') ? 'pass' : 'unknown', ran('thickness') ? 'Wall thickness map was run: review the thin areas it marked' : 'Thin walls may not print', `<button class="btn-outline small" data-pc="thickness">${ran('thickness') ? 'Check again' : 'Check walls'}</button>`),
    row(6, 'Overhangs and orientation', ran('overhang') ? 'pass' : 'unknown', ran('overhang') ? 'Overhang map was run: supports go where it is red' : 'Steep overhangs need supports or another orientation', `<button class="btn-outline small" data-pc="overhang">${ran('overhang') ? 'Check again' : 'Show overhangs'}</button>`),
  ].filter(Boolean);
  openModal(`<h2>${t('Print-ready checklist')}</h2>
    <p class="muted">Run the checks in order, then save a 3MF for your slicer (it records the unit, so the size arrives right). Only checks you have run count as done.</p>
    <ul class="health">${items.join('')}</ul>
    <div class="modal-actions"><button class="btn-solid" data-pc="export">Save 3MF for the slicer</button><button class="btn-outline" data-pc="stl">STL instead</button></div>
    <p class="note">These are mesh and geometry checks. Your slicer's own preview is the final word on supports, bridges and print time.</p>`);
  $('#modalCard').querySelectorAll<HTMLElement>('[data-pc]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.pc!;
    modal.close();
    if (k === 'unit') { openSheet('right'); syncBar(); setTimeout(() => ($('#fileUnit') as HTMLElement | null)?.focus(), 200); }
    else if (k === 'export') showExportDialog('3mf');
    else if (k === 'stl') showExportDialog('stl');
    else setTool(k as Tool);
  }));
}
/** Overall size in the display unit, for one-line summaries. */
function fmtSize(): string {
  const b = viewer.bounds().getSize(new THREE.Vector3());
  return `${fmtD(b.x)} × ${fmtD(b.y)} × ${fmtD(b.z)}`;
}

function modelSection(): string {
  const s = state.stats;
  if (!viewer.model || !s) return '';
  const c = state.caps;
  const fileOpts = Object.entries(UNITS).map(([k, v]) => `<option value="${k}" ${k === state.unit ? 'selected' : ''}>${t(v.label)}</option>`).join('');
  const dispOpts = `<option value="auto" ${state.displayUnit === 'auto' ? 'selected' : ''}>${t('Same as file')}</option>` + Object.entries(UNITS).filter(([k]) => k !== 'u').map(([k, v]) => `<option value="${k}" ${k === state.displayUnit ? 'selected' : ''}>${t(v.label)}</option>`).join('');
  const saved = state.ext && rememberedPref(state.ext).unit;
  const closedText = s.closed === null ? t('Not checked') + ' (checking…)' : s.closed ? t('yes') : t('no');
  const scopeNote = s.hiddenParts ? ` <span class="muted">(visible parts)</span>` : '';
  const anim = viewer.clips.length ? animationTransport() : '';
  return `<div class="section" id="sec-model">
    <div class="section-head"><span class="section-title">${t('Model')}</span></div>
    <div style="font-size:13px;margin:-2px 0 10px;overflow-wrap:anywhere">${esc(state.modelName)}</div>
    <div class="unit-box">
      <div class="row"><label for="fileUnit">${t('File units')}</label><select id="fileUnit" data-unit>${fileOpts}</select></div>
      <p class="unit-src" id="unitSrc">${t(UNIT_SOURCE_LABEL[state.unitSource])}${state.unitSource === 'saved' ? ` · <button class="link-btn" data-unitforget>${t('Forget')}</button>` : ''}${state.ext && !saved && state.unitSource !== 'declared' ? ` · <button class="link-btn" data-unitremember>Use for all .${esc(state.ext)} files</button>` : ''}<br><small>${t('Changes the real size')}. To keep the size and change the numbers, use Rescale below.</small></p>
      <div class="row"><label for="dispUnit">${t('Show sizes in')}</label><select id="dispUnit" data-dispunit>${dispOpts}</select></div>
    </div>
    ${dimsHtml(s.size)}
    <dl class="kv">
      <dt>${t('Parts')}</dt><dd>${fmtInt(s.meshes)}${s.hiddenParts ? ` <span class="muted">+ ${s.hiddenParts} hidden</span>` : ''}</dd>
      <dt>${t('Vertices')}</dt><dd>${fmtInt(s.vertices)}</dd>
      <dt>${t('Triangles')}</dt><dd>${fmtInt(s.triangles)}</dd>
      ${s.points ? `<dt>${t('Points')}</dt><dd>${fmtInt(s.points)}</dd>` : ''}
      <dt>${t('Materials')}</dt><dd>${fmtInt(s.materials)}</dd>
      <dt>${t('Textures')}</dt><dd>${fmtInt(s.textures)}</dd>
      ${c?.volume ? `<dt>${t('Surface area')}</dt><dd>${fmtArea(s.area)}${scopeNote}</dd>
      <dt>${t('Volume')}</dt><dd title="${s.closed ? 'Closed (watertight) mesh' : 'Not confirmed closed: volume is an estimate. Overlapping parts are counted twice.'}">${s.meshes ? `${fmtVol(s.volume)}${s.closed ? '' : ' ≈'}` : '–'}${scopeNote}</dd>
      <dt>${t('Watertight')}</dt><dd>${s.meshes ? closedText : '–'}</dd>` : ''}
      <dt>${t('Centre')}</dt><dd>${fmtNum(toDisp(s.center.x), 2)}, ${fmtNum(toDisp(s.center.y), 2)}, ${fmtNum(toDisp(s.center.z), 2)}</dd>
    </dl>
    ${s.invertedParts ? `<p class="note warn-note">${s.invertedParts} part${s.invertedParts === 1 ? ' is' : 's are'} inside-out; volume counts ${s.invertedParts === 1 ? 'its' : 'their'} absolute size.</p>` : ''}
  </div>
  ${anim}
  ${c?.hasPoints ? pointCloudSection() : ''}
  <div class="section" id="sec-scale">
    <div class="section-head"><span class="section-title">${t('Scale & size')}</span></div>
    <p class="note" style="margin-top:0">${t('Applies to')}: <b>${editor.selected && editor.selected !== viewer.model ? t('selected part') : 'whole model'}</b></p>
    <div class="row"><label>Scale by</label><input type="number" step="any" value="1" min="0" data-scalefactor style="width:90px" aria-label="Scale factor"/><span class="grow"></span><button class="chip" data-scaleapply>${t('Apply')}</button></div>
    <div class="row"><label>Set size</label>
      <select data-sizeaxis style="width:62px" aria-label="Axis"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
      <input type="number" step="any" value="${Number(toDisp(s.size.x).toFixed(3))}" data-sizevalue aria-label="Target size in ${UNITS[dispUnit()].label}"/><span style="font-size:12px;color:var(--muted)">${UNITS[dispUnit()].short}</span>
      <button class="chip" data-sizeapply>Set</button></div>
    <label class="check"><input type="checkbox" data-sizeuniform checked/> Keep proportions</label>
    <p class="note">Set size measures along the view axes (X width, Y height, Z depth). Rotated parts can only be resized proportionally.</p>
    <div class="row"><label>Rescale to</label>
      <select data-convto style="width:auto" aria-label="New file unit">${unitOptions(state.unit === 'mm' ? 'in' : 'mm')}</select>
      <button class="chip" data-convapply>Go</button></div>
    <p class="note">Rescale rewrites the numbers in another unit and keeps the real size (20 mm becomes 0.787 in). One undo step.</p>
  </div>`;
}

/** Play / pause, scrubber, speed, loop and reset pose for animated models (OV-097). */
function animationTransport(): string {
  const a = viewer.activeAction;
  const dur = viewer.animDuration;
  return `<div class="section" id="sec-anim"><div class="section-head"><span class="section-title">${t('Animation')}</span></div>
    <div class="row"><label for="animClip">Clip</label><select id="animClip" data-anim><option value="-1">None (rest pose)</option>${viewer.clips.map((c, i) => `<option value="${i}" ${a?.getClip() === c ? 'selected' : ''}>${esc(c.name || 'Clip ' + (i + 1))} · ${c.duration.toFixed(1)} s</option>`).join('')}</select></div>
    ${a ? `<div class="row anim-row">
      <button class="chip" data-animplay aria-label="${a.paused ? 'Play' : 'Pause'}">${icon(a.paused ? 'play' : 'pause')}${a.paused ? 'Play' : 'Pause'}</button>
      <input type="range" min="0" max="${dur}" step="0.01" value="${viewer.animTime.toFixed(2)}" data-animseek aria-label="Animation time"/>
      <span class="cost-val" data-animtime>${viewer.animTime.toFixed(2)} s</span></div>
    <div class="row"><label>Speed</label><select data-animspeed>${[0.25, 0.5, 1, 1.5, 2].map((k) => `<option value="${k}" ${a.timeScale === k ? 'selected' : ''}>${k}×</option>`).join('')}</select>
      <label class="check" style="margin:0 0 0 10px"><input type="checkbox" data-animloop ${a.loop !== THREE.LoopOnce ? 'checked' : ''}/> Loop</label></div>` : ''}
    <div class="btn-row"><button class="chip" data-animreset>${icon('reset')}Rest pose</button></div>
    <p class="note">Exports to GLB keep the animation clips. Other formats save the pose you see now.</p></div>`;
}

/** Point size, colour and display budget for point clouds (OV-112). */
let pointMode: 'original' | 'height' | 'single' = 'original';
function pointCloudSection(): string {
  let size = 0;
  viewer.model?.traverse((o: any) => { if (o.isPoints && !size) size = o.material.size; });
  return `<div class="section" id="sec-points"><div class="section-head"><span class="section-title">Point cloud</span></div>
    <div class="row"><label>Point size</label><input type="range" min="0.2" max="6" step="0.1" value="${state.pointScale}" data-ptsize aria-label="Point size"/></div>
    <div class="row"><label>Colour</label><div class="seg">${(['original', 'height', 'single'] as const).map((m) => `<button class="${pointMode === m ? 'active' : ''}" data-ptcolor="${m}">${m === 'original' ? 'Original' : m === 'height' ? 'By height' : 'Single'}</button>`).join('')}</div></div>
    <div class="row"><label>Show</label><select data-ptbudget>${[1, 0.5, 0.25, 0.1].map((k) => `<option value="${k}" ${state.pointBudget === k ? 'selected' : ''}>${k === 1 ? 'Every point' : Math.round(k * 100) + '% of points'}</option>`).join('')}</select></div>
    <p class="note">Point clouds have no surface, so repair, volume and STL export don't apply. Size: ${fmtD(state.stats?.size.x || 0, 2)} wide.</p></div>`;
}
function applyPointSettings() {
  viewer.model?.traverse((o: any) => {
    if (!o.isPoints) return;
    const g: THREE.BufferGeometry = o.geometry;
    if (o.userData.baseSize === undefined) o.userData.baseSize = o.material.size;
    o.material.size = o.userData.baseSize * state.pointScale;
    const n = g.attributes.position.count;
    g.setDrawRange(0, Math.max(1, Math.floor(n * state.pointBudget)));
    if (pointMode === 'original') {
      if (o.userData.origColor) { g.setAttribute('color', o.userData.origColor); delete o.userData.origColor; }
      o.material.vertexColors = !!g.attributes.color; o.material.color.set(g.attributes.color ? 0xffffff : 0xb4b8bd);
    } else if (pointMode === 'single') {
      o.material.vertexColors = false; o.material.color.set(0xd9dcde);
    } else {
      if (!o.userData.origColor && g.attributes.color) o.userData.origColor = g.attributes.color;
      g.computeBoundingBox();
      const { min, max } = g.boundingBox!;
      const up = viewer.upAxis === 'z' ? 2 : 1;
      const lo = up === 2 ? min.z : min.y, hi = up === 2 ? max.z : max.y;
      const cols = new Float32Array(n * 3), c = new THREE.Color();
      for (let i = 0; i < n; i++) { const v = (g.attributes.position.getComponent(i, up) - lo) / (hi - lo || 1); c.setHSL(0.66 - v * 0.66, 0.75, 0.5); cols.set([c.r, c.g, c.b], i * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      o.material.vertexColors = true; o.material.color.set(0xffffff);
    }
    o.material.needsUpdate = true;
  });
  viewer.requestRender();
}

const unitOptions = (sel: string) => Object.entries(UNITS).filter(([k]) => k !== 'u').map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.short}</option>`).join('');

/** One quiet support route lives in Help / About (OV-034); panels no longer repeat donation prompts. */

function renderDetails() {
  const host = $('#rtab-details');
  if (!viewer.model) {
    host.innerHTML = `<div class="empty">Open a model to see its size, parts and tools.</div>`;
    hydrateIcons(host);
    return;
  }
  const scroll = host.scrollTop;
  host.innerHTML = toolSection() + selectionSection() + modelSection() + healthSection() + costSection() + historySection();
  host.scrollTop = scroll;
  const p = panels.get(state.tool);
  const sec = host.querySelector<HTMLElement>('[data-panel]');
  if (p?.bind && sec) p.bind(sec);
}

// Details panel events (delegated)
const details = $('#rtab-details');
details.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-sel],[data-msel],[data-ifcsame],[data-mremove],[data-mcopy],[data-mhide],[data-mrefresh],[data-mexport],[data-mclear],[data-mmode],[data-pmode],[data-pswatch],[data-secaxis],[data-scaleapply],[data-sizeapply],[data-convapply],[data-unitforget],[data-unitremember],[data-animplay],[data-animreset],[data-ptcolor],[data-focus],[data-histundo],[data-reloadorig],[data-showcost]');
  if (!el) return;
  const d = el.dataset;
  const o = editor.selected;
  if (d.msel) {
    const list = editor.selection;
    if (d.msel === 'isolate') isolateMany(list);
    if (d.msel === 'hide') { editor.setVisibility(list, false, `Hide ${list.length} parts`); renderTree(); }
    if (d.msel === 'group') editor.groupSelection();
    if (d.msel === 'delete') editor.deleteSelection();
    if (d.msel === 'export') showExportDialog(undefined, undefined, 'selected');
    renderDetails(); return;
  }
  if ('unitforget' in d && state.ext) { forgetPref(state.ext, 'unit'); state.unitSource = 'user'; toast(`Forgot the saved unit for .${state.ext} files`); renderDetails(); return; }
  if ('unitremember' in d && state.ext) { rememberPref(state.ext, { unit: state.unit }); state.unitSource = 'saved'; toast(`.${state.ext} files will open in ${UNITS[state.unit].label.toLowerCase()}. You can forget this here any time.`); renderDetails(); return; }
  if ('animplay' in d) { viewer.setPaused(!viewer.activeAction?.paused); renderDetails(); return; }
  if ('animreset' in d) { viewer.resetPose(); renderDetails(); return; }
  if (d.ptcolor) { pointMode = d.ptcolor as typeof pointMode; applyPointSettings(); renderDetails(); return; }
  if (d.focus === 'unit') { ($('#fileUnit') as HTMLElement)?.focus(); return; }
  if ('histundo' in d) { const n = Number(d.histundo); for (let k = 0; k <= n; k++) history.undo(); return; }
  if ('reloadorig' in d) { reloadOriginal(); return; }
  if ('showcost' in d) { state.forceCost = true; renderDetails(); scrollToSection('sec-cost'); return; }
  if (d.ifcsame && o?.userData.ifc) {
    const info = o.userData.ifc;
    const hits: THREE.Object3D[] = [];
    viewer.model?.traverse((x) => { const i = x.userData.ifc; if (i && (d.ifcsame === 'type' ? i.type === info.type : i.storey === info.storey) && !(x.parent?.userData.ifc === i)) hits.push(x); });
    if (d.ifcsame === 'type') { selectObject(hits[0] ?? null); hits.slice(1).forEach((h) => editor.multi.add(h)); renderTree(); renderDetails(); toast(`${hits.length} × ${info.type} selected`); }
    else isolateMany(hits);
    return;
  }
  if (d.sel && o) {
    switch (d.sel) {
      case 'deselect': selectObject(null); break;
      case 'fit': viewer.fit(o); break;
      case 'hide': editor.toggleVisibility(o); renderTree(); break;
      case 'deselectall': selectObject(null); break;
      case 'isolate': isolate(o); break;
      case 'dup': editor.duplicateSelected(); break;
      case 'delete': editor.deleteSelected(); break;
      case 'floor': editor.dropToFloor(); break;
      case 'center': editor.centerOnOrigin(); break;
      case 'mx': editor.mirror('x'); break;
      case 'my': editor.mirror('y'); break;
      case 'mz': editor.mirror('z'); break;
      case 'reset': editor.resetTransform(); break;
      case 'ungroup': editor.ungroup(o); break;
    }
    renderDetails();
  }
  if (d.mremove) measure.remove(Number(d.mremove));
  if (d.mcopy) {
    // Copies exactly what the row shows, in the display unit and precision (D05).
    const m = measure.list.find((x) => x.id === Number(d.mcopy));
    if (m) { const v = valueText(m, fmtD); navigator.clipboard?.writeText(v).then(() => toast(`${tr('Copied')} ${v}`), () => toast(v)); }
    return;
  }
  if (d.mhide) { const m = measure.list.find((x) => x.id === Number(d.mhide)); if (m) measure.setHidden(m.id, !m.hidden); }
  if (d.mrefresh) measure.refresh(Number(d.mrefresh));
  if ('mexport' in d) download(new Blob([JSON.stringify({ model: state.modelName, unit: UNITS[dispUnit()].label, measurements: measure.toJSON((v) => fmtD(v)) }, null, 2)], { type: 'application/json' }), `${baseFileName()}-measurements.json`);
  if ('mclear' in d) measure.clear();
  if (d.mmode) { measure.setMode(d.mmode as MeasureMode); measure.setActive(true); renderDetails(); }
  if (d.pmode) { paint.mode = d.pmode as any; setTool('paint'); setTool('paint'); }
  if (d.pswatch) { paint.color.set(d.pswatch); renderDetails(); }
  if (d.secaxis) viewer.setSection({ axis: d.secaxis as Axis });
  if ('scaleapply' in d) {
    const f = Number(($('[data-scalefactor]') as HTMLInputElement).value);
    if (f > 0) { editor.scaleBy(f, f, f, editor.selected && editor.selected !== viewer.model ? editor.selected : viewer.model!); viewer.fit(); }
  }
  if ('sizeapply' in d) {
    const axis = ($('[data-sizeaxis]') as HTMLSelectElement).value as Axis;
    const target = Number(($('[data-sizevalue]') as HTMLInputElement).value) / toDisp(1); // display unit → file units
    const obj = editor.selected && editor.selected !== viewer.model ? editor.selected : viewer.model!;
    const cur = viewer.bounds(obj).getSize(new THREE.Vector3())[axis];
    if (target > 0 && cur > 0) {
      const f = target / cur;
      const uniform = ($('[data-sizeuniform]') as HTMLInputElement).checked;
      // A rotated part's local axes don't line up with the view axes, so a one-axis stretch would skew it (OV-030).
      if (!uniform && obj !== viewer.model) {
        const q = obj.getWorldQuaternion(new THREE.Quaternion());
        const wq = viewer.world.getWorldQuaternion(new THREE.Quaternion());
        const rel = wq.invert().multiply(q);
        const axisAligned = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].every((v) => { const r = v.clone().applyQuaternion(rel); return Math.max(Math.abs(r.x), Math.abs(r.y), Math.abs(r.z)) > 0.9999; });
        if (!axisAligned) { toast('This part is rotated, so it can only be resized proportionally. Tick “Keep proportions”, or reset its rotation first.', true); return; }
      }
      // Scale factors are applied in local axes; map the chosen view axis for Z-up models.
      const local = viewer.upAxis === 'z' && obj === viewer.model ? ({ x: 'x', y: 'z', z: 'y' } as const)[axis] : axis;
      editor.scaleBy(uniform || local === 'x' ? f : 1, uniform || local === 'y' ? f : 1, uniform || local === 'z' ? f : 1, obj);
      viewer.fit();
    }
  }
  if ('convapply' in d) rescaleToUnit(($('[data-convto]') as HTMLSelectElement).value as Unit);
});

details.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.pcolor !== undefined) paint.color.set(t.value);
  if (d.pradius !== undefined) paint.radius = Number(t.value);
  if (d.secpos !== undefined) viewer.setSection({ t: Number(t.value) });
  if (d.explode !== undefined) { viewer.setExplode(Number(t.value)); updateBadges(); }
  if (d.animseek !== undefined) { viewer.setPaused(true); viewer.seek(Number(t.value)); const lab = $('[data-animtime]'); if (lab) lab.textContent = `${Number(t.value).toFixed(2)} s`; }
  if (d.ptsize !== undefined) { state.pointScale = Number(t.value); applyPointSettings(); }
  if (d.msnapradius !== undefined) measure.snapRadius = Number(t.value);
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
  if (d.msnapmode !== undefined) measure.snapMode = t.value as any;
  if (d.mname !== undefined) measure.rename(Number(d.mname), t.value);
  if (d.mcolor !== undefined) measure.setColor(Number(d.mcolor), t.value);
  if (d.monlysel !== undefined) measureOnlySelected = t.checked;
  if (d.secon !== undefined) viewer.setSection({ enabled: t.checked });
  if (d.secflip !== undefined) viewer.setSection({ flip: t.checked });
  if (d.seccaps !== undefined) setCaps(t.checked);
  if (d.unit !== undefined) { setFileUnit(t.value as Unit, 'user', { undoable: true }); hideUnitHint(); }
  if (d.dispunit !== undefined) setDisplayUnit(t.value as Unit | 'auto');
  if (d.anim !== undefined) { viewer.playClip(Number(t.value)); renderDetails(); }
  if (d.animspeed !== undefined) viewer.setSpeed(Number(t.value));
  if (d.animloop !== undefined) viewer.setLoop(t.checked);
  if (d.ptbudget !== undefined) { state.pointBudget = Number(t.value); applyPointSettings(); }
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
  const allVisible = !viewer.model!.getObjectsByProperty('visible', false).filter((o) => !o.userData.helper).length;
  if (!allVisible) { showEverything(); toast('Showing everything'); return; }
  isolateMany([obj]);
  toast('Isolated · click Isolate again to show everything');
}
/** Shows only these parts (and what they contain), as one undo step. */
function isolateMany(list: THREE.Object3D[]) {
  if (!viewer.model || !list.length) return;
  const keep = new Set<THREE.Object3D>();
  for (const obj of list) { obj.traverse((o) => keep.add(o)); let p: THREE.Object3D | null = obj; while (p) { keep.add(p); p = p.parent; } }
  const all: THREE.Object3D[] = [];
  viewer.model.traverse((o) => { if (!o.userData.helper && !o.userData.proxy) all.push(o); });
  editor.setVisibility(all, (o) => keep.has(o), list.length === 1 ? `Isolate ${list[0].name || 'part'}` : `Show only ${list.length} parts`);
  renderTree();
  refreshStats(100);
}

/** Named undo list and "reload original" (OV-042). */
function historySection(): string {
  const labels = history.labels.slice(0, 8);
  if (!labels.length && !history.canRedo) return '';
  return `<div class="section" id="sec-history"><div class="section-head"><span class="section-title">${t('History')}</span><span class="grow"></span>
    ${state.lastFiles || state.sourceUrls ? `<button class="chip" data-reloadorig>${icon('reset')}${t('Reload original')}</button>` : ''}</div>
    <ol class="history-list">${labels.map((l, i) => `<li><button class="link-btn" data-histundo="${i}" title="Undo back to before this step">${esc(l)}</button></li>`).join('')}</ol>
    <p class="note">Undo covers edits, colours, units and showing / hiding parts. Camera moves and tool settings are not undo steps. Click a step to go back to before it.</p></div>`;
}

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
      <div class="row"><label>Lighting</label><select data-light>${Object.entries(LOOKS).map(([k, l]) => `<option value="${k}" ${k === currentLook ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row"><label>Backdrop</label><select data-backdrop><option value="">Choose…</option>${Object.keys(BACKDROPS).map((k) => `<option>${k}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" data-shadow ${shadowEnabled() ? 'checked' : ''}/> Ground shadow</label>
      <label class="check"><input type="checkbox" data-envbg ${envBackground ? 'checked' : ''}/> Show lighting environment as background</label>
      <div class="row"><label>Background</label><input type="color" value="${bg}" data-bg /><span class="grow"></span><button class="chip" data-bgreset>Default</button></div>
      <div class="palette">${['#151515', '#0a0a0a', '#2b2b2b', '#5a5a5a', '#ebebea', '#ffffff', '#1d2a3a', '#2a1d1d'].map((c) => `<button style="background:${c}" data-bgswatch="${c}" aria-label="${c}"></button>`).join('')}</div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Editing</span></div>
      <label class="check"><input type="checkbox" data-set="snap" ${editor.snap ? 'checked' : ''}/> Snap move / rotate / scale</label>
      <label class="check"><input type="checkbox" data-set="msnap" ${measure.snap ? 'checked' : ''}/> Snap measurements to corners</label>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">${t('Navigation')}</span></div>
      <div class="row"><label for="setNav">Mouse</label><select id="setNav" data-pref="nav">
        <option value="default" ${prefs.nav === 'default' ? 'selected' : ''}>Left orbit · right pan (trackpad friendly)</option>
        <option value="cad" ${prefs.nav === 'cad' ? 'selected' : ''}>CAD style: middle orbit · right pan</option>
        <option value="blender" ${prefs.nav === 'blender' ? 'selected' : ''}>Blender style: middle orbit · Shift for pan</option></select></div>
      <label class="check"><input type="checkbox" data-pref="zoomCursor" ${prefs.zoomToCursor ? 'checked' : ''}/> Zoom towards the mouse pointer</label>
      <div class="row"><label for="setKeys">${t('Keyboard shortcuts')}</label><select id="setKeys" data-pref="keys">
        <option value="on" ${prefs.keys === 'on' ? 'selected' : ''}>Single keys everywhere</option>
        <option value="canvas" ${prefs.keys === 'canvas' ? 'selected' : ''}>Single keys only over the 3D view</option>
        <option value="off" ${prefs.keys === 'off' ? 'selected' : ''}>Only with Ctrl / ⌘ (speech-input friendly)</option></select></div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">${t('Interface')}</span></div>
      <div class="row"><label>${t('Theme')}</label><div class="seg"><button class="${document.documentElement.dataset.theme === 'dark' ? 'active' : ''}" data-themeset="dark">${t('Dark')}</button><button class="${document.documentElement.dataset.theme === 'light' ? 'active' : ''}" data-themeset="light">${t('Light')}</button></div></div>
      <div class="row"><label for="setLang">${t('Language')}</label><select id="setLang" data-lang>${[['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['fr', 'Français'], ['pt', 'Português']].map(([k, n]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="row"><label for="setDensity">${t('Density')}</label><select id="setDensity" data-pref="density"><option value="comfortable" ${prefs.density === 'comfortable' ? 'selected' : ''}>${t('Comfortable')}</option><option value="compact" ${prefs.density === 'compact' ? 'selected' : ''}>${t('Compact')}</option></select></div>
      <div class="row"><label for="setMotion">Motion</label><select id="setMotion" data-pref="motion"><option value="system" ${store.get('motion', 'system') === 'system' ? 'selected' : ''}>Follow system setting</option><option value="reduce" ${store.get('motion', 'system') === 'reduce' ? 'selected' : ''}>${t('Reduce motion')}</option><option value="full" ${store.get('motion', 'system') === 'full' ? 'selected' : ''}>Full</option></select></div>
      <label class="check"><input type="checkbox" data-pref="autoplay" ${prefs.autoplay ? 'checked' : ''}/> Play animations when a model opens</label>
      <div class="row"><label for="setQuality">${t('Quality')}</label><select id="setQuality" data-pref="quality"><option value="auto" ${prefs.quality === 'auto' ? 'selected' : ''}>${t('Automatic')}</option><option value="quality" ${prefs.quality === 'quality' ? 'selected' : ''}>Sharpest</option><option value="performance" ${prefs.quality === 'performance' ? 'selected' : ''}>${t('Performance')}</option></select></div>
      <p class="note">Quality changes only the on-screen sharpness, never exported geometry.</p>
      <div class="row"><label>CAD quality</label><select data-cadq>${Object.entries(CAD_QUALITY).map(([k, v]) => `<option value="${k}" ${k === cadQuality() ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="row"><label>App</label><button class="chip" data-install>${icon('download')}Install ${CONFIG.appName}</button></div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">${t('Privacy')}</span></div>
      <label class="check"><input type="checkbox" data-pref="recents" ${prefs.rememberRecents ? 'checked' : ''}/> ${t('Remember recent files on this device')}</label>
      <p class="note">${t('Keeps a copy of each opened file in this browser (up to 250 MB) so you can reopen it. Turning this off deletes the copies. Conversion history in Quick Convert stores names and formats only.')}</p>
      <label class="check"><input type="checkbox" data-pref="allowRemote" ${prefs.allowRemote ? 'checked' : ''}/> Let files from this device load textures from other websites</label>
      <p class="note">Off by default: a model file could otherwise make your browser contact a website it names. Models opened from a URL can always load files next to them.</p>
      <div class="btn-row"><button class="chip danger" data-clearlocal>${icon('trash')}Clear all local data</button><button class="chip" data-resetprefs>${icon('reset')}Reset preferences</button></div>
      <p class="note" id="offlineInfo">Checking which engines are ready offline…</p>
    </div>`;
}

const settings = $('#rtab-settings');
settings.addEventListener('click', async (e) => {
  if ((e.target as HTMLElement).closest('[data-install]')) { installApp(); return; }
  if ((e.target as HTMLElement).closest('[data-clearlocal]')) {
    await clearRecent();
    try { Object.keys(localStorage).filter((k) => k.startsWith('omniview.')).forEach((k) => localStorage.removeItem(k)); } catch { /* private mode */ }
    renderRecent(); renderSettings(); toast('Local data cleared: recent files, saved views, defaults and preferences');
    return;
  }
  if ((e.target as HTMLElement).closest('[data-resetprefs]')) {
    for (const k of ['allowRemote', 'keys', 'nav', 'zoomCursor', 'motion', 'autoplay', 'quality', 'density', 'displayUnit']) store.set(k, '');
    try { ['keys', 'nav', 'zoomCursor', 'motion', 'autoplay', 'quality', 'density', 'displayUnit', 'allowRemote'].forEach((k) => localStorage.removeItem('omniview.' + k)); } catch { /* */ }
    applyPrefs(); renderSettings(); toast('Preferences reset');
    return;
  }
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
  if (d.pref) {
    const v = t.type === 'checkbox' ? (t.checked ? '1' : '0') : t.value;
    store.set(d.pref, v);
    if (d.pref === 'recents' && v === '0') clearRecent().then(renderRecent);
    if (d.pref === 'recents' && v === '1') renderRecent();
    applyPrefs();
    return;
  }
  if (d.lang !== undefined) { switchLanguage(t.value); return; }
  if (d.dmode) viewer.setDisplayMode(t.value as DisplayMode);
  if (d.cadq !== undefined) { try { localStorage.setItem('omniview.cadQuality', t.value); } catch { /* private mode */ } toast('CAD quality saved · applies to STEP / IGES / BREP files you open next'); }
  if (d.light) setLook(t.value);
  if (d.backdrop) { setBackdrop(t.value); state.bgCustom = null; }
  if (d.shadow !== undefined) setShadow(t.checked);
  if (d.envbg !== undefined) setEnvBackground(t.checked);
  if (d.set === 'edges') viewer.setEdges(t.checked);
  if (d.set === 'grid') viewer.setGrid(t.checked);
  if (d.set === 'axes') viewer.setAxes(t.checked);
  if (d.set === 'autorotate') viewer.setAutoRotate(t.checked);
  if (d.set === 'snap') editor.setSnap(t.checked);
  if (d.set === 'msnap') measure.snap = t.checked;
  updateToolbar();
});
viewer.setLighting(store.get('light', 'studio') as any);

/** Applies stored preferences to the viewer and the page. */
function applyPrefs() {
  viewer.setNavigation(prefs.nav, prefs.zoomToCursor);
  viewer.setQuality(prefs.quality);
  viewer.autoplay = prefs.autoplay;
  document.documentElement.classList.toggle('reduce-motion', prefs.reduceMotion);
  document.documentElement.dataset.density = prefs.density;
  (window as any).__omniReduceMotion = prefs.reduceMotion;
}
applyPrefs();
matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyPrefs);

/** Changes language and keeps the current page (and warns about unsaved work through beforeunload, OV-075). */
function switchLanguage(lang: string) {
  const path = location.pathname.replace(/^\/(es|de|fr|pt)\//, '/');
  location.href = (lang === 'en' ? '' : '/' + lang) + path + location.hash;
}

// Offline readiness: which engines are already cached on this device (OV-082).
async function renderOfflineInfo() {
  const el = document.getElementById('offlineInfo');
  if (!el) return;
  if (!('caches' in window)) { el.textContent = 'Offline use is not available in this browser.'; return; }
  try {
    const keys = await caches.keys();
    const cached = new Set<string>();
    for (const k of keys.filter((x) => x.startsWith('omniviewer-'))) for (const r of await (await caches.open(k)).keys()) cached.add(new URL(r.url).pathname);
    const has = (frag: string) => [...cached].some((p) => p.includes(frag));
    const items = [['Mesh viewer', has('/assets/')], ['STEP / IGES engine', has('occt')], ['IFC engine', has('web-ifc') || has('ifc')], ['Rhino engine', has('rhino3dm')], ['Draco / KTX2 decoders', has('draco') || has('basis')]] as const;
    el.innerHTML = `Ready offline on this device: ${items.map(([n, ok]) => `<span class="${ok ? 'ok' : 'muted'}">${ok ? '✓' : '○'} ${n}</span>`).join(' · ')}. Engines are saved the first time you open such a file.`;
  } catch { el.textContent = ''; }
}

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
  return safeFileName(state.modelName.replace(/\.[^.]+$/, ''));
}

/** What an export includes: visible parts, every part, or the current selection (OV-004). */
function exportTarget(scope: ExportScope | 'selected', part: THREE.Object3D | null): { root: THREE.Object3D | null; scope: ExportScope; tempGroup?: THREE.Object3D[] } {
  if (part) return { root: part, scope: 'visible' };
  if (scope === 'selected') {
    const sel = editor.selection.filter((o) => o !== viewer.model);
    if (sel.length === 1) return { root: sel[0], scope: 'visible' };
    if (sel.length > 1) {
      // Several parts: export the model with everything outside the selection treated as hidden.
      const keep = new Set<THREE.Object3D>();
      for (const o of sel) { o.traverse((c) => keep.add(c)); let p: THREE.Object3D | null = o; while (p) { keep.add(p); p = p.parent; } }
      const hide: THREE.Object3D[] = [];
      viewer.model!.traverse((o) => { if (!keep.has(o) && o.visible && !o.userData.helper) hide.push(o); });
      return { root: viewer.model, scope: 'visible', tempGroup: hide };
    }
  }
  return { root: viewer.model, scope: scope === 'selected' ? 'visible' : scope };
}

interface ExportChoice { id: ExportId; scope: ExportScope | 'selected'; zUp: boolean; outUnit?: UnitId; name?: string; perTriangleColors?: boolean; part?: THREE.Object3D | null; ext?: string }

async function runExport(id: ExportId, part: THREE.Object3D | null = null, zUp = viewer.upAxis === 'y' && isPrintFormat(id), choice: Partial<ExportChoice> = {}) {
  const f = formatById(id);
  const why = unavailableReason(state.caps, 'export');
  if (why) { toast(why, true); return; }
  setLoading(`Exporting ${f.label}…`);
  const tgt = exportTarget(choice.scope ?? 'visible', part);
  tgt.tempGroup?.forEach((o) => (o.visible = false));
  try {
    const blob = await exportModel(viewer, id, tgt.root ?? undefined, {
      unit: state.unit as UnitId, zUp, scope: tgt.scope, outUnit: choice.outUnit, perTriangleColors: choice.perTriangleColors,
    });
    const name = safeFileName(choice.name || `${baseFileName()}${part ? '-' + safeFileName(part.name || 'part') : ''}`);
    download(blob, `${name}.${choice.ext && [f.ext, ...((f as any).alias ?? [])].includes(choice.ext) ? choice.ext : f.ext}`);
    // Only a complete, lossless export counts as "saved". A lossy or partial one (STL drops colours and parts,
    // selected-only drops the rest) keeps the unsaved marker, so closing still offers to save a project (D01).
    const rep = describeExport(tgt.root ?? viewer.model!, id, { unit: state.unit as UnitId, up: viewer.upAxis, zUp, scope: tgt.scope, outUnit: choice.outUnit, perTriangleColors: choice.perTriangleColors });
    // Saved views and a chosen display unit live only in a project file, so an export doesn't "save" them (F32).
    const complete = !part && !tgt.tempGroup && rep.lost.length === 0 && rep.hiddenParts === 0 && measure.serialize().length === 0 && savedViewsFor(state.identity).length === 0 && state.displayUnit === 'auto';
    state.lastExport = { label: f.label, at: Date.now(), complete };
    if (complete) history.markClean();
    updateStatus();
    toast(`${t('Exported')} ${f.label}`);
  } catch (err: any) {
    console.error(err);
    toast(`${t('Export failed')}: ${err?.message || err}`, true);
  } finally { tgt.tempGroup?.forEach((o) => (o.visible = true)); setLoading(null); }
}

const autoKey = (id: string) => 'auto.' + id;
const GROUP_LABEL = { print: '3D printing', web: 'Web, AR & games', apps: '3D apps', cad: 'CAD & drawings', data: 'Scans, points & research' } as const;
/** Search text typed in the converter (kept while the dialog re-renders and between opens). */
let convQuery = '';
/** Three sensible targets for what is open now: by content (points, animation, textures) and by source format. */
function recommendedTargets(): ExportId[] {
  const c = state.caps, ext = state.ext;
  let textured = false;
  viewer.model?.traverse((o: any) => { const m = o.material; for (const x of Array.isArray(m) ? m : [m]) if (x?.map) textured = true; });
  let r: ExportId[];
  if (c?.hasPoints && !c.hasMesh) r = ['ply', 'xyz', 'glb'];
  else if (viewer.clips.length) r = ['glb', 'usdz', 'gltf'];
  else if (['step', 'stp', 'iges', 'igs', 'brep', 'brp', '3dm', 'x_t', 'dxf'].includes(ext)) r = ['stl', '3mf', 'glb'];
  else if (['stl', '3mf', 'amf', 'obj', 'off'].includes(ext)) r = [ext === 'stl' ? '3mf' : 'stl', 'glb', 'obj'];
  else if (['ifc'].includes(ext)) r = ['glb', 'obj-zip', 'usdz'];
  else if (textured) r = ['glb', 'obj-zip', 'usdz'];
  else r = ['glb', 'stl', 'obj'];
  const last = store.get('lastExport', '') as ExportId;
  if (last && EXPORT_FORMATS.some((f) => f.id === last) && !r.includes(last)) r = [last, ...r.slice(0, 2)];
  // Never suggest converting a file to its own format.
  const same = (id: ExportId) => formatById(id).ext === ext;
  const ok = (id: ExportId) => !same(id) && !(viewer.model && exportBlocker(viewer.model, id));
  return r.filter(ok).concat((['glb', 'stl', 'obj', '3mf', 'ply', 'xyz'] as ExportId[]).filter((id) => ok(id) && !r.includes(id))).slice(0, 3);
}
/**
 * Export with a preflight (OV-016): choose format, scope and units, and see what is kept and lost for THIS model
 * before downloading. Converter pages preselect their format; a remembered auto-download still stops when the new
 * file has losses or warnings (OV-077).
 */
function showExportDialog(preferred?: ExportId, partOverride?: THREE.Object3D, initialScope: ExportScope | 'selected' = 'visible') {
  if (!viewer.model) return;
  const why = unavailableReason(state.caps, 'export');
  if (why) { toast(why, true); return; }
  const hasSel = editor.selection.some((o) => o !== viewer.model);
  const ch: ExportChoice = { id: preferred ?? (store.get('lastExport', 'glb') as ExportId), scope: partOverride ? 'visible' : (hasSel && initialScope === 'selected' ? 'selected' : initialScope), zUp: viewer.upAxis === 'y', part: partOverride ?? null, name: '', perTriangleColors: true };
  if (!EXPORT_FORMATS.some((f) => f.id === ch.id)) ch.id = 'glb';
  // Converting to the same format is rarely the goal: start on the best suggestion instead.
  if (!preferred && formatById(ch.id).ext === state.ext) ch.id = recommendedTargets()[0] ?? 'glb';
  const formats = preferred ? [...EXPORT_FORMATS].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)) : [...EXPORT_FORMATS];
  const render = () => {
    const f = formatById(ch.id);
    const tgt = exportTarget(ch.scope, ch.part ?? null);
    tgt.tempGroup?.forEach((o) => (o.visible = false));
    const rep = describeExport(tgt.root!, ch.id, { unit: state.unit as UnitId, up: viewer.upAxis, zUp: ch.zUp && isPrintFormat(ch.id) || (ch.zUp && (ch.id === 'obj' || ch.id === 'obj-zip' || ch.id === 'ply')), scope: tgt.scope, clips: viewer.clips, outUnit: ch.outUnit, perTriangleColors: ch.perTriangleColors });
    tgt.tempGroup?.forEach((o) => (o.visible = true));
    const su = rep.sizeUnit;
    const conv = (v: number) => v; // the report is already in the file's unit
    const sizeTxt = su === null ? '' : `${fmtNum(conv(rep.size.x), 3)} × ${fmtNum(conv(rep.size.y), 3)} × ${fmtNum(conv(rep.size.z), 3)} ${su === 'u' ? 'units' : UNITS[su as Unit].short}`;
    const unitless = isUnitless(ch.id);
    const defaultOut = outputUnit(ch.id, { unit: state.unit as UnitId });
    const blockedWhy = (x: (typeof EXPORT_FORMATS)[number]) => (viewer.model ? exportBlocker(viewer.model, x.id) : null);
    const exts = (x: (typeof EXPORT_FORMATS)[number]) => [x.ext, ...(((x as any).alias as string[] | undefined) ?? [])];
    const opt = (x: (typeof EXPORT_FORMATS)[number], inRec = false) => { const why = blockedWhy(x); return `<button class="export-opt ${x.id === ch.id ? 'preferred' : ''} ${why ? 'is-blocked' : ''}" role="radio" aria-checked="${x.id === ch.id}" data-export="${x.id}" ${why ? `title="${esc(why)}"` : ''} ${inRec ? 'data-rec' : `data-s="${esc(`${x.label} ${exts(x).join(' ')} ${x.tags} ${x.note} ${GROUP_LABEL[x.group]}`.toLowerCase())}"`}><div><b>${x.label}</b><small>${why ? esc(why) : x.note}</small></div><span class="ext">${exts(x).map((e) => '.' + e).join(' ')}</span></button>`; };
    const blocked = blockedWhy(f);
    const extNow = ch.ext && exts(f).includes(ch.ext) ? ch.ext : f.ext;
    const recs = recommendedTargets();
    return `<h2 id="dlgTitle">${t('Convert to…')}</h2>
      <p class="conv-from">${esc(state.modelName)} <span class="muted">· ${esc((state.ext || '').toUpperCase())}${state.stats ? ` · ${fmtNum(state.stats.triangles, 0)} triangles` : ''}</span></p>
      <div class="export-layout">
        <div class="conv-pick">
          <label class="conv-search">${icon('search')}<input id="expSearch" type="search" autocomplete="off" spellcheck="false" placeholder="${t('Search formats or apps: print, Blender, iPhone…')}" aria-label="${t('Search formats')}" value="${esc(convQuery)}"/></label>
          <div class="export-grid conv-list" role="radiogroup" aria-label="Format">
            <div class="conv-sec" data-sec="rec">${t('Best for this model')}</div>
            ${recs.map((id) => opt(formatById(id), true)).join('')}
            ${(Object.keys(GROUP_LABEL) as (keyof typeof GROUP_LABEL)[]).map((g) => `<div class="conv-sec" data-sec="${g}">${t(GROUP_LABEL[g])}</div>${formats.filter((x) => x.group === g).map((x) => opt(x)).join('')}`).join('')}
            <p class="conv-none hidden">${t('No format matches. Try “print”, “web”, “AR” or a program name.')}</p>
          </div>
        </div>
        <div class="export-pre">
          <div class="field-label">${t('What to export')}</div>
          <div class="seg" role="radiogroup">
            ${ch.part ? `<button class="active" disabled>${esc(ch.part.name || 'This part')}</button>` : `
            <button class="${ch.scope === 'visible' ? 'active' : ''}" data-scope="visible">${t('Visible parts')}</button>
            <button class="${ch.scope === 'all' ? 'active' : ''}" data-scope="all">${t('All parts')}</button>
            ${hasSel ? `<button class="${ch.scope === 'selected' ? 'active' : ''}" data-scope="selected">${t('Selected')} (${editor.selection.filter((o) => o !== viewer.model).length})</button>` : ''}`}
          </div>
          <dl class="kv export-kv">
            <dt>Parts</dt><dd>${rep.parts}${rep.hiddenParts && tgt.scope === 'visible' ? ` <span class="muted">(${rep.hiddenParts} hidden left out)</span>` : ''}</dd>
            <dt>${t('Size in file')}</dt><dd>${sizeTxt || '–'}</dd>
            <dt>Axes</dt><dd>${f.convention === 'metres-y' ? 'Y up (format standard)' : (ch.zUp && viewer.upAxis === 'y') || viewer.upAxis === 'z' ? 'Z up (print standard)' : 'Y up (as the file)'}</dd>
          </dl>
          ${unitless ? `<div class="row"><label for="expUnit">${t('Numbers in the file')}</label><select id="expUnit">${(['mm', 'cm', 'm', 'in'] as UnitId[]).map((u) => `<option value="${u}" ${(ch.outUnit ?? defaultOut) === u ? 'selected' : ''}>${UNITS[u as Unit].label}</option>`).join('')}</select></div>
            <p class="note">${f.label.split(' ')[0]} files don't store units. Slicers assume millimetres.</p>` : ''}
          ${viewer.upAxis === 'y' && f.convention !== 'metres-y' && !staysYUp(ch.id) ? `<label class="check"><input type="checkbox" id="exportZup" ${ch.zUp ? 'checked' : ''}/> ${t('Stand upright for 3D printing (Z-up)')}</label>` : ''}
          ${ch.id === '3mf' && state.stats && collectHasVertexColors() ? `<label class="check"><input type="checkbox" id="expTriColors" ${ch.perTriangleColors ? 'checked' : ''}/> Keep painted colours per triangle (supported by some slicers)</label>` : ''}
          <div class="export-loss">
            <div><b>${t('Kept')}</b><ul>${rep.kept.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>
            ${rep.lost.length ? `<div class="lost"><b>${t('Lost')}</b><ul>${rep.lost.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>` : ''}
          </div>
          ${rep.warnings.map((w) => `<p class="note warn-note">${esc(w)}</p>`).join('')}
          <div class="row"><label for="expName">${t('File name')}</label><input type="text" id="expName" value="${esc(ch.name || (ch.part ? `${baseFileName()}-${safeFileName(ch.part.name || 'part')}` : baseFileName()))}"/>${exts(f).length > 1 ? `<select id="expExt" aria-label="${t('File extension')}">${exts(f).map((e) => `<option value="${e}" ${e === extNow ? 'selected' : ''}>.${e}</option>`).join('')}</select>` : `<span class="cost-unit">.${f.ext}</span>`}</div>
          ${blocked ? `<p class="note warn-note">${esc(blocked)}</p>` : ''}
          ${preferred ? `<label class="check"><input type="checkbox" id="exportAuto" ${store.get(autoKey(preferred), '') ? 'checked' : ''}/> On this page, download straight away next time (still stops if something would be lost)</label>` : ''}
          <div class="modal-actions"><button class="btn-outline" data-modal-close>${t('Cancel')}</button><button class="btn-solid" id="expGo" ${blocked ? 'disabled' : ''}>${icon('download')} ${t('Download')} .${extNow}</button></div>
        </div>
      </div>`;
  };
  const hook = () => {
    const input = $('#expSearch') as HTMLInputElement;
    const list = $('#modalCard').querySelector<HTMLElement>('.conv-list')!;
    const filter = () => {
      convQuery = input.value;
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      list.querySelectorAll<HTMLElement>('[data-s]').forEach((b) => { const hit = words.every((w) => b.dataset.s!.includes(w)); b.classList.toggle('hidden', !hit); if (hit) shown++; });
      list.querySelectorAll<HTMLElement>('[data-rec]').forEach((b) => b.classList.toggle('hidden', words.length > 0));
      list.querySelectorAll<HTMLElement>('.conv-sec').forEach((h) => {
        if (h.dataset.sec === 'rec') { h.classList.toggle('hidden', words.length > 0); return; }
        let n = h.nextElementSibling as HTMLElement | null, any = false;
        while (n && !n.classList.contains('conv-sec') && !n.classList.contains('conv-none')) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling as HTMLElement | null; }
        h.classList.toggle('hidden', !any);
      });
      const none = list.querySelector<HTMLElement>('.conv-none')!;
      none.classList.toggle('hidden', shown > 0);
      none.textContent = /laser|cnc|svg|outline|2d|cutter|router|plasma/.test(input.value.toLowerCase())
        ? t('For laser cutting and CNC, use Tools → Cut / split → Save SVG or DXF: it exports the 2D section outline at real size.')
        : t('No format matches. Try “print”, “web”, “AR” or a program name.');
    };
    input.oninput = filter;
    input.onkeydown = (e) => {
      const first = [...list.querySelectorAll<HTMLElement>('.export-opt')].find((b) => !b.classList.contains('hidden'));
      if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
      if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
    };
    list.onkeydown = (e) => {
      const opts = [...list.querySelectorAll<HTMLElement>('.export-opt')].filter((b) => !b.classList.contains('hidden'));
      const i = opts.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) input.focus(); else opts[i - 1].focus(); }
    };
    filter();
    list.scrollTop = listScroll;
  };
  let listScroll = 0;
  openModal(render());
  hook();
  setTimeout(() => ($('#expSearch') as HTMLInputElement | null)?.focus(), 60);
  const rerender = () => {
    const name = ($('#expName') as HTMLInputElement | null)?.value; if (name !== undefined) ch.name = name;
    listScroll = $('#modalCard').querySelector<HTMLElement>('.conv-list')?.scrollTop ?? 0;
    const focusId = (document.activeElement as HTMLElement | null)?.dataset?.export;
    $('#modalCard').innerHTML = `<button class="modal-close" data-modal-close aria-label="${t('Close')}">${icon('x')}</button>${render()}`;
    hook();
    if (focusId) $('#modalCard').querySelector<HTMLElement>(`.export-opt[data-export="${focusId}"]:not(.hidden)`)?.focus();
  };
  $('#modalCard').onclick = async (e) => {
    const tEl = e.target as HTMLElement;
    const fmt = tEl.closest<HTMLElement>('[data-export]');
    if (fmt) { ch.id = fmt.dataset.export as ExportId; ch.outUnit = undefined; ch.ext = undefined; rerender(); return; }
    const sc = tEl.closest<HTMLElement>('[data-scope]');
    if (sc) { ch.scope = sc.dataset.scope as ExportChoice['scope']; rerender(); return; }
    if (tEl.closest('#expGo')) {
      ch.name = ($('#expName') as HTMLInputElement).value;
      if (preferred) store.set(autoKey(preferred), ($('#exportAuto') as HTMLInputElement | null)?.checked ? '1' : '');
      store.set('lastExport', ch.id);
      modal.close();
      await runExport(ch.id, ch.part ?? null, ch.zUp && formatById(ch.id).convention !== 'metres-y' && !staysYUp(ch.id), ch);
    }
  };
  $('#modalCard').onchange = (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'expUnit') { ch.outUnit = el.value as UnitId; rerender(); }
    if (el.id === 'expExt') { ch.ext = el.value; rerender(); }
    if (el.id === 'exportZup') { ch.zUp = el.checked; rerender(); }
    if (el.id === 'expTriColors') { ch.perTriangleColors = el.checked; rerender(); }
  };
}
function collectHasVertexColors() { let v = false; viewer.model?.traverse((o: any) => { if (o.isMesh && o.geometry?.attributes?.color) v = true; }); return v; }

/** Converter pages: download straight away only when nothing would be lost (OV-077). */
function autoExport(to: ExportId) {
  const rep = describeExport(viewer.model!, to, { unit: state.unit as UnitId, up: viewer.upAxis, zUp: viewer.upAxis === 'y' && isPrintFormat(to), clips: viewer.clips });
  if (rep.needsReview || state.unitSource === 'guess') { toast('Check this export first: something would be lost or the units are a guess.'); showExportDialog(to); return; }
  runExport(to);
}

/** Screenshot with explicit size, aspect presets and annotation choice (OV-005, OV-095). */
function showScreenshotDialog() {
  const cw = viewer.container.clientWidth, ch = viewer.container.clientHeight;
  const presets: [string, number, number][] = [['View', cw, ch], ['1080p 16:9', 1920, 1080], ['Square', 1600, 1600], ['4:3', 1600, 1200], ['Portrait 4:5', 1080, 1350], ['4K', 3840, 2160]];
  let w = Math.round(cw * 2), h = Math.round(ch * 2);
  openModal(`<h2 id="dlgTitle">Save an image</h2>
    <div class="row"><label>Preset</label><select id="shotPreset">${presets.map(([n, pw, ph], i) => `<option value="${i}">${n} · ${Math.round(pw * (i === 0 ? 2 : 1))}×${Math.round(ph * (i === 0 ? 2 : 1))}</option>`).join('')}</select></div>
    <div class="row"><label>Pixels</label><input type="number" id="shotW" min="64" max="8192" value="${w}" aria-label="Width in pixels" style="width:90px"/>×<input type="number" id="shotH" min="64" max="8192" value="${h}" aria-label="Height in pixels" style="width:90px"/></div>
    <label class="check"><input type="checkbox" id="shotTransparent"/> Transparent background</label>
    <label class="check"><input type="checkbox" id="shotAnn" checked/> Include measurements and dimensions</label>
    <label class="check"><input type="checkbox" id="shotCredit"/> Add a small “OMNIVIEWER” credit (optional)</label>
    <div class="shot-preview"><img id="shotPrev" alt="Preview of the image"/></div>
    <p class="note">The whole view is kept for any shape: a different aspect ratio adds space instead of cropping. No watermark unless you add the credit.</p>
    <div class="modal-actions"><button class="btn-outline" data-modal-close>${t('Cancel')}</button><button class="btn-solid" id="shotGo">${icon('camera')} Save PNG</button></div>`);
  const W = $('#shotW') as HTMLInputElement, H = $('#shotH') as HTMLInputElement;
  const preview = () => {
    const pw = Number(W.value) || 1, ph = Number(H.value) || 1, k = 320 / Math.max(pw, ph);
    ($('#shotPrev') as HTMLImageElement).src = viewer.screenshot(1, ($('#shotTransparent') as HTMLInputElement).checked, ($('#shotAnn') as HTMLInputElement).checked, { width: Math.max(32, pw * k), height: Math.max(32, ph * k) });
  };
  ($('#shotPreset') as HTMLSelectElement).onchange = (e) => { const [, pw, ph] = presets[Number((e.target as HTMLSelectElement).value)]; const k = Number((e.target as HTMLSelectElement).value) === 0 ? 2 : 1; W.value = String(Math.round(pw * k)); H.value = String(Math.round(ph * k)); preview(); };
  [W, H, $('#shotTransparent'), $('#shotAnn')].forEach((el) => el.addEventListener('change', preview));
  preview();
  $('#shotGo').onclick = async () => {
    const pw = Math.min(8192, Math.max(64, Number(W.value) || cw)), ph = Math.min(8192, Math.max(64, Number(H.value) || ch));
    let url = viewer.screenshot(1, ($('#shotTransparent') as HTMLInputElement).checked, ($('#shotAnn') as HTMLInputElement).checked, { width: pw, height: ph });
    if (($('#shotCredit') as HTMLInputElement).checked) url = await addCredit(url, pw, ph);
    download(url, `${baseFileName()}.png`);
    modal.close();
  };
}
async function addCredit(url: string, w: number, h: number): Promise<string> {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
  const k = Math.max(1, w / 1600);
  g.font = `600 ${11 * k}px Geist, system-ui, sans-serif`; g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillStyle = 'rgba(128,128,128,.85)'; g.fillText('OMNIVIEWER · BANKASI MEDIA', w - 14 * k, h - 10 * k);
  return c.toDataURL('image/png');
}

/** Share: explains exactly what a link contains (OV-084) and builds embed codes with presets (OV-114). */
/** A link that reopens this model at this exact camera angle (models opened from a web address only). */
function copyViewLink() {
  if (!state.sourceUrls?.length) { toast(t('Files on your device have no web address to link to. Use Saved views to keep this angle, or open the model from a link first.'), true); return; }
  const link = `${location.origin}${location.pathname}#model=${state.sourceUrls.map(encodeURIComponent).join(',')}&cam=${cameraString()}`;
  navigator.clipboard?.writeText(link).then(() => toast(t('Link to this view copied')), () => toast(link));
}

function showShareDialog() {
  if (!state.sourceUrls) {
    openModal(`<h2 id="dlgTitle">Share a model</h2>
      <p>This model was opened from your device. ${CONFIG.appName} never uploads your files, so there is no link to share.</p>
      <p>To share it: put the file somewhere public that allows cross-origin downloads (for example GitHub), then use <b>Open from URL</b>. The page address becomes a link, and you get an embed code. Recipients will see the <b>original file</b>, not your local edits.</p>
      <p>To send your edited model, export it and send the file, or <button class="link-btn" data-act="saveproj">save a project file</button>.</p>
      <div class="field-label" style="margin:12px 0 6px">Or share ${CONFIG.appName} itself</div>
      ${shareButtons(location.origin + location.pathname, `${CONFIG.appName}: free online 3D viewer, converter and editor`)}
      <div class="modal-actions"><button class="btn-outline" data-modal-close>${t('Close')}</button><button class="btn-solid" id="shareUrl">${icon('link')} ${t('Open from URL')}</button></div>`);
    $('#shareUrl').onclick = () => showUrlDialog();
    $('#modalCard').querySelector('[data-act="saveproj"]')?.addEventListener('click', () => { modal.close(); saveProject(); });
    return;
  }
  const opt = { ui: 'full', spin: false, bg: '', credit: true, w: 640, h: 480 };
  const build = () => {
    const base = location.origin + location.pathname;
    const link = `${base}#model=${state.sourceUrls!.map(encodeURIComponent).join(',')}&cam=${cameraString()}`;
    const params = ['embed=1', opt.ui !== 'full' ? `ui=${opt.ui}` : '', opt.spin ? 'spin=1' : '', opt.bg ? `bg=${encodeURIComponent(opt.bg.replace('#', ''))}` : '', opt.credit ? '' : 'credit=0'].filter(Boolean).join('&');
    const embed = `<iframe src="${link}&${params}" width="${opt.w}" height="${opt.h}" style="border:0;border-radius:12px;max-width:100%;aspect-ratio:${opt.w}/${opt.h};height:auto" title="${esc(state.modelName)} in 3D" allowfullscreen loading="lazy"></iframe>`;
    return { link, embed };
  };
  const render = () => {
    const { link, embed } = build();
    return `<h2 id="dlgTitle">Share &amp; embed</h2>
      <p class="note">This link opens the <b>original file</b> from its web address and this camera view. Your local edits, paint and measurements are not included.</p>
      <div class="field-label" style="margin:10px 0 6px">Link</div><textarea rows="2" readonly id="shareLink" aria-label="Share link">${esc(link)}</textarea>
      <div class="field-label" style="margin:12px 0 6px">Embed</div>
      <div class="row"><label>Controls</label><div class="seg"><button class="${opt.ui === 'full' ? 'active' : ''}" data-ui="full">Full</button><button class="${opt.ui === 'min' ? 'active' : ''}" data-ui="min">Minimal</button><button class="${opt.ui === 'none' ? 'active' : ''}" data-ui="none">None</button></div></div>
      <div class="row"><label>Size</label><select id="embSize">${[[640, 480], [800, 450], [600, 600], [1280, 720]].map(([a, b]) => `<option value="${a}x${b}" ${opt.w === a && opt.h === b ? 'selected' : ''}>${a} × ${b}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="embSpin" ${opt.spin ? 'checked' : ''}/> Turn slowly</label>
      <label class="check"><input type="checkbox" id="embCredit" ${opt.credit ? 'checked' : ''}/> Show the small OMNIVIEWER link</label>
      <div class="row"><label>Background</label><input type="color" id="embBg" value="${opt.bg || '#151515'}"/><button class="chip" id="embBgReset">Default</button></div>
      <textarea rows="3" readonly id="shareEmbed" aria-label="Embed code">${esc(embed)}</textarea>
      <div class="field-label" style="margin:12px 0 6px">Badge for your listing (Etsy, Printables, YouTube…)</div><textarea rows="2" readonly id="shareBadge">${esc(`<a href="${link}">View in 3D on ${CONFIG.appName}</a>`)}</textarea>
      ${shareButtons(link, `${state.modelName} in 3D`)}
      <div class="modal-actions"><button class="btn-outline" id="copyEmbed">${icon('copy')} Copy embed</button><button class="btn-solid" id="copyLink">${icon('copy')} Copy link</button></div>`;
  };
  openModal(render());
  const rerender = () => { $('#modalCard').innerHTML = `<button class="modal-close" data-modal-close aria-label="${t('Close')}">${icon('x')}</button>${render()}`; };
  const copy = (txt: string) => navigator.clipboard?.writeText(txt).then(() => toast(t('Copied')), () => toast('Copy failed: select the text and copy it', true));
  $('#modalCard').onclick = (e) => {
    const el = e.target as HTMLElement;
    const ui = el.closest<HTMLElement>('[data-ui]');
    if (ui) { opt.ui = ui.dataset.ui!; rerender(); }
    if (el.closest('#embBgReset')) { opt.bg = ''; rerender(); }
    if (el.closest('#copyLink')) copy(build().link);
    if (el.closest('#copyEmbed')) copy(build().embed);
  };
  $('#modalCard').onchange = (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'embSize') { const [a, b] = el.value.split('x').map(Number); opt.w = a; opt.h = b; }
    if (el.id === 'embSpin') opt.spin = el.checked;
    if (el.id === 'embCredit') opt.credit = el.checked;
    if (el.id === 'embBg') opt.bg = el.value;
    rerender();
  };
}

/** Closed formats no browser can read (Fusion 360, SolidWorks, SketchUp...): show the preview inside, if any, and the export path. */
async function showProprietaryDialog(info: ProprietaryInfo, file: File) {
  const kindWord = { cad: 'CAD', dcc: '3D app', bim: 'BIM', drawing: 'drawing', sculpt: 'sculpting' }[info.kind];
  openModal(`<h2 id="dlgTitle">${esc(info.app)} file</h2>
    <div class="prop-layout">
      <div class="prop-preview" id="propPreview"><span class="muted">${t('Looking for a preview inside the file…')}</span></div>
      <div>
        <p><b>${esc(file.name)}</b> <span class="muted">· ${file.size >= 1048576 ? (file.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(file.size / 1024)) + ' KB'} · .${esc(info.ext)}</span></p>
        <p>${t('This is a closed {kind} format: only {app} (by {vendor}) can read its geometry. No browser tool can open it without uploading it to {vendor}, and OMNIVIEWER never uploads your files.', { kind: kindWord, app: info.app, vendor: info.vendor })}</p>
        <div class="prop-steps">
          <b>${t('Get a file that opens here')}</b>
          <ol>
            <li>${esc(info.how)}</li>
            <li>${t('Best choice')}: <b>${esc(info.exportAs[0])}</b>${info.exportAs.length > 1 ? ` · ${t('also fine')}: ${info.exportAs.slice(1).map(esc).join(', ')}` : ''}</li>
            <li>${t('Drop the exported file here. From there you can convert it to any of 44 file types.')}</li>
          </ol>
          ${info.freeRoute ? `<p class="note">${t('No {app}?', { app: esc(info.app) })} ${esc(info.freeRoute)}</p>` : ''}
        </div>
      </div>
    </div>
    <div class="modal-actions"><button class="btn-outline" data-act="formats">${t('Which files work?')}</button><button class="btn-solid" data-act="open">${icon('open')} ${t('Open the exported file')}</button></div>`);
  $('#modalCard').onclick = (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'open') { modal.close(); ($('#fileInput') as HTMLInputElement).click(); }
    if (a === 'formats') showFormatsDialog();
  };
  const url = await extractPreview(file).catch(() => null);
  const host = document.getElementById('propPreview');
  if (!host) return;
  host.innerHTML = url ? `<img src="${url}" alt="${t('Preview stored inside {name}', { name: esc(file.name) })}"/><small class="muted">${t('Preview stored in the file (an image, not the 3D model)')}</small>` : `<span class="muted">${t('No preview picture inside this file.')}</span>`;
}

/** What opens, what converts, and what needs exporting first (format capability matrix). */
function showFormatsDialog() {
  const byKind: Record<string, ProprietaryInfo[]> = {};
  for (const p of Object.values(PROPRIETARY)) (byKind[p.app] ??= []).push(p);
  const prop = Object.entries(byKind).map(([app, list]) => `<li><b>${esc(app)}</b> <span class="muted">${list.map((p) => '.' + p.ext).join(' ')}</span> → ${esc(list[0].exportAs[0])}</li>`).join('');
  openModal(`<h2 id="dlgTitle">${t('Which files work?')}</h2>
    <input type="search" id="fmtSearch" class="fmt-search" placeholder="${t('Search an extension or program: f3d, blend, step…')}" aria-label="${t('Search formats')}"/>
    <div class="fmt-cols" id="fmtCols">
      <section><h3>${t('Opens directly')} <span class="muted">(${FORMATS.reduce((n, f) => n + f.ext.length, 0) - 1})</span></h3><ul>${FORMATS.map((f) => `<li data-s="${esc((f.name + ' ' + f.ext.join(' ')).toLowerCase())}"><b>${esc(f.name)}</b> <span class="muted">${f.ext.map((e) => '.' + e).join(' ')}</span></li>`).join('')}</ul>
        <p class="note">${t('Files with a missing or wrong extension are recognised by their content.')}</p></section>
      <section><h3>${t('Converts to')} <span class="muted">(${new Set(EXPORT_FORMATS.flatMap((f: any) => [f.ext, ...(f.alias ?? [])])).size})</span></h3><ul>${EXPORT_FORMATS.map((f) => `<li data-s="${esc((f.label + ' ' + f.ext + ' ' + f.tags).toLowerCase())}"><b>${esc(f.label)}</b> <span class="muted">.${f.ext}</span></li>`).join('')}</ul></section>
      <section><h3>${t('Export these first')}</h3><p class="note">${t('Closed formats that only their own program can read. Drop one in and OMNIVIEWER shows how to export it, plus any preview picture stored inside.')}</p><ul>${prop.replace(/<li>/g, () => '<li data-s="">')}</ul></section>
    </div>`);
  const items = [...$('#fmtCols').querySelectorAll<HTMLElement>('li')];
  items.forEach((li) => { if (!li.dataset.s) li.dataset.s = li.textContent!.toLowerCase(); });
  ($('#fmtSearch') as HTMLInputElement).oninput = (e) => {
    const q = (e.target as HTMLInputElement).value.toLowerCase().replace(/^\./, '').trim();
    items.forEach((li) => li.classList.toggle('hidden', !!q && !li.dataset.s!.includes(q)));
  };
  setTimeout(() => ($('#fmtSearch') as HTMLInputElement | null)?.focus(), 60);
}

function showSupportDialog() {
  const has = !!CONFIG.donateUrl;
  openModal(`<h2 id="dlgTitle">About ${CONFIG.appName}</h2>
    <p>${CONFIG.appName} by ${CONFIG.brandName} ${CONFIG.brandSup} is free and open source. No ads, no accounts, no tracking. Models are processed in your browser and are never uploaded.</p>
    <p class="note">Version ${esc(APP_VERSION)} · <button class="link-btn" data-act="notes">What's new</button> · <button class="link-btn" data-act="help">Help centre</button> · <button class="link-btn" data-act="bug">Report a problem</button></p>
    <div class="support-box">
      <b>${icon('heart')} ${t('Keep it free')}</b>
      <p>${t('Hosting, CAD engines and new formats cost time and money. Donations keep OMNIVIEWER free, ad-free and private for everyone.')}</p>
      ${has ? `<a class="btn-solid" href="${CONFIG.donateUrl}" target="_blank" rel="noopener">${icon('heart')} ${esc(CONFIG.donateLabel)}</a>`
        : `<button class="btn-solid" disabled title="${t('Donations are being set up')}">${icon('heart')} ${t('Donations coming soon')}</button>`}
      <p class="note">${t('Other ways to help: share it with someone who needs it, star it on GitHub, or report a file that doesn’t open.')}</p>
    </div>
    <div class="modal-actions">
      ${shareButtons('https://omniviewer3d.com/', `${CONFIG.appName}: free online 3D viewer, converter and editor`, true)}
      <a class="btn-outline" href="${CONFIG.repoUrl}" target="_blank" rel="noopener">${icon('github')} Source on GitHub</a>
    </div>`);
  $('#modalCard').onclick = (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'notes') showReleaseNotes();
    if (a === 'help') showHelpCentre();
    if (a === 'bug') showBugReport();
  };
}

function showHelpDialog() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform), M = mac ? '⌘' : 'Ctrl';
  const sc: [string, string][] = [
    ['Open files', `O · ${M}+O`], ['Fit to window', 'F'], ['Camera views', '1 – 7'], ['Measure', 'M'], ['Paint', 'P'], ['Section plane', 'X'],
    ['Move / Rotate / Scale', 'W / E / R'], ['Hide / show selected', 'H'], ['Delete selected', 'Del'], ['Duplicate', `${M}+D`],
    ['Group / ungroup', `${M}+G / ${M}+Shift+G`], ['Undo / Redo', `${M}+Z / ${M}+Y`], ['Export', `${M}+E`], ['Save project', `${M}+S`],
    ['Focus mode (hide panels)', '\\'], ['Search every tool', `${M}+K`], ['Cancel tool / deselect', 'Esc'], ['Zoom to part', 'Double-click'], ['Add to selection', 'Ctrl / Shift + click'],
  ];
  openModal(`<h2 id="dlgTitle">How to use ${CONFIG.appName}</h2>
    <p>Drop files (or a whole folder or .zip) anywhere on the page. For models with textures, drop the textures, .mtl or .bin files together with the model. ${prefs.nav === 'default' ? 'Orbit with the left mouse button, pan with the right, zoom with the wheel.' : 'Orbit with the middle mouse button, pan with the right, zoom with the wheel.'}</p>
    <div class="shortcuts">${sc.map(([a, k]) => `<span>${a}</span><kbd>${k}</kbd>`).join('')}</div>
    <p class="note">Single-letter shortcuts can be limited to the 3D view or turned off in Settings.</p>
    <p class="note" style="margin-top:14px"><button class="link-btn" data-act="help">Help centre</button> · <button class="link-btn" data-act="notes">What's new</button> · <button class="link-btn" data-act="bug">Report a problem</button> · <button class="link-btn" data-act="about">About &amp; support</button></p>
    <p class="note">Supported: ${FORMATS.map((f) => f.name).join(', ')}.</p>`);
  $('#modalCard').onclick = (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'help') showHelpCentre();
    if (a === 'notes') showReleaseNotes();
    if (a === 'bug') showBugReport();
    if (a === 'about') showSupportDialog();
  };
}

// ------------------------------------------------------------------ help centre, release notes, bug reports (OV-080, OV-118)
function showHelpCentre(topic?: string) {
  openModal(`<h2 id="dlgTitle">Help centre</h2>${helpArticlesHtml(topic)}`);
  if (topic) requestAnimationFrame(() => document.getElementById('help-' + topic)?.setAttribute('open', ''));
}
function showReleaseNotes() {
  openModal(`<h2 id="dlgTitle">What's new</h2>${releaseNotesHtml(APP_VERSION)}`);
}
function showBugReport() {
  const tpl = `What I did:\n1. \n2. \n\nWhat I expected:\n\nWhat happened instead:\n\nFile type (no need to share the file): ${state.ext ? '.' + state.ext : '—'}\n\n${diagnostics()}`;
  openModal(`<h2 id="dlgTitle">Report a problem</h2>
    <p>Copy this template into a <a href="${CONFIG.repoUrl}/issues/new" target="_blank" rel="noopener">GitHub issue</a>. Nothing is sent automatically, and your model stays on your device. Only attach a model if you are happy to share it.</p>
    <textarea rows="12" id="bugTpl" aria-label="Bug report template">${esc(tpl)}</textarea>
    <div class="modal-actions"><button class="btn-solid" id="bugCopy">${icon('copy')} ${t('Copy')}</button></div>`);
  $('#bugCopy').onclick = () => navigator.clipboard?.writeText(($('#bugTpl') as HTMLTextAreaElement).value).then(() => toast(t('Copied')), () => toast('Select the text and copy it', true));
}

// ------------------------------------------------------------------ boot
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const model = params.get('model');
  if (params.get('embed') === '1' && !document.body.classList.contains('embed')) {
    document.body.classList.add('embed');
    const ui = params.get('ui');
    if (ui === 'min' || ui === 'none') document.body.classList.add('embed-' + ui);
    if (params.get('spin') === '1') viewer.setAutoRotate(true);
    const bg = params.get('bg');
    if (bg && /^[0-9a-f]{3,8}$/i.test(bg)) viewer.setBackground('#' + bg);
    if (params.get('credit') !== '0') {
      const a = document.createElement('a');
      a.className = 'embed-badge';
      a.href = location.href.replace(/&(embed|ui|spin|bg|credit)=[^&]*/g, '');
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `${CONFIG.appName} <span style="opacity:.6">by ${CONFIG.brandName} ${CONFIG.brandSup}</span>`;
      $('#stage').appendChild(a);
    }
  }
  const cam = params.get('cam');
  if (model) openUrls(model.split(',').map((u) => decodeURIComponent(u))).then(() => { if (cam) applyCamera(cam, false); });
}

Object.assign(ctx, {
  viewer, editor, history, toast, setLoading,
  refresh: () => { viewer.rebaseExplode(); refreshStats(50); renderTree(); renderMaterials(); },
  renderDetails,
  unit: () => state.unit,
  fmtLen: (v: number, digits = 3) => fmtD(v, digits),
  setTool: (id: string) => setTool(id),
  activeTool: () => state.tool,
  selectObject,
  openFiles,
  openFilesWith: (files: File[], given?: GivenUnit, mode: OpenMode = 'replace') => openFiles(files, null, mode, mode !== 'replace', given),
  modelName: () => state.modelName,
  modelId: () => state.identity || state.modelName,
  baseFileName,
  fmtDisp: (v: number, digits = 3) => fmtD(v, digits),
  toDisp,
  dispUnitShort: () => UNITS[dispUnit()].short,
  unitInfo: () => ({ unit: state.unit, source: state.unitSource, label: UNIT_SOURCE_LABEL[state.unitSource], display: dispUnit() }),
  stats: () => state.stats,
  caps: () => state.caps,
  resources: () => state.resources,
  measurements: () => measure.list,
  measure,
  upAxis: () => viewer.upAxis,
  fileExt: () => state.ext,
  diagnostics,
  appVersion: APP_VERSION,
  isPhone,
  openModal,
  closeModal: () => modal.close(),
});
initFeatures();
initQuickConvert();
initViewCube();
selBar = initSelectionBar((a) => {
  const o = editor.selected;
  if (!o) return;
  const list = editor.selection;
  switch (a) {
    case 'focus': viewer.fit(o); break;
    case 'hide': editor.setVisibility(list, false, list.length > 1 ? `Hide ${list.length} parts` : `Hide ${o.name || 'part'}`); selectObject(null); break;
    case 'isolate': if (list.length > 1) isolateMany(list); else isolate(o); break;
    case 'dup': editor.duplicateSelected(); break;
    case 'delete': editor.deleteSelection(); break;
    case 'snap': editor.setSnap(!editor.snap); break;
    case 'deselect': selectObject(null); break;
    case 'details':
      if (isPhone()) { openSheet('right'); document.body.classList.remove('sheet-min'); }
      document.body.classList.remove('no-right');
      $$<HTMLElement>('[data-rtab]').forEach((b) => b.classList.toggle('active', b.dataset.rtab === 'details'));
      $('#rtab-details').classList.remove('hidden');
      $('#rtab-settings').classList.add('hidden');
      renderDetails();
      break;
  }
  updateToolbar();
});
// Converter pages open Quick Convert: /convert/ to choose a target, /<from>-to-<to>/ converts and downloads on drop.
if (PAGE.kind === 'convert' && PAGE.to) openQuickConvert({ to: PAGE.to, instant: true });
else if (PAGE.tool === 'convert') openQuickConvert();
registerCoreCommands();
registerMainContextActions();

if (window.innerWidth < 900) document.body.classList.add('no-left', 'no-right');
applyStaticI18n();
// Menus live on <body>: the phone's floating view buttons open them while the header tool bar is hidden, and
// glass panels (backdrop-filter) would otherwise trap their fixed position.
$$<HTMLElement>('#toolbar .menu').forEach((m) => document.body.appendChild(m));
initLayoutLab();
setWorkspace('all'); // workspace filtering removed: every tool is always available
applyPagePrimary();
renderAll();
renderRecent();
requestAnimationFrame(layoutToolbar);
// The turning sample needs its own WebGL context and lighting (seconds of main-thread work on GPU-less machines):
// start it on the first sign of a person (pointer, key, wheel, touch, scroll) instead of during page load (desktop TBT).
const LANDING_START_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const startLandingOnInput = () => {
  LANDING_START_EVENTS.forEach((ev) => removeEventListener(ev, startLandingOnInput, true));
  if (!location.hash.includes('model=')) startLandingPreview();
};
LANDING_START_EVENTS.forEach((ev) => addEventListener(ev, startLandingOnInput, { capture: true, passive: true }));
// Large meshes: accelerate picking with a bounding-volume tree, built on demand (OV-091).
import('three-mesh-bvh').then(({ acceleratedRaycast, computeBoundsTree, disposeBoundsTree }) => {
  (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
  (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
  const plain = THREE.Mesh.prototype.raycast;
  THREE.Mesh.prototype.raycast = function (this: THREE.Mesh, rc: THREE.Raycaster, hits: THREE.Intersection[]) {
    const g: any = this.geometry;
    const tris = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    if (tris > 50000 && !(this as any).isSkinnedMesh && !this.morphTargetInfluences) { if (!g.boundsTree) g.computeBoundsTree(); return acceleratedRaycast.call(this, rc, hits); }
    return plain.call(this, rc, hits);
  };
}).catch(() => { /* plain picking still works */ });
if (PAGE.tool === 'batch') setTimeout(showBatchDialog, 300);

// Offline support: cache the app after the first visit (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`).catch(() => {}));
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
// Files opened with the installed app ("Open with OMNIVIEWER", OV-083).
(window as any).launchQueue?.setConsumer(async (params: any) => {
  if (!params?.files?.length) return;
  openFiles(await Promise.all(params.files.map((h: any) => h.getFile())));
});

// Leaving or reloading the page with unexported edits asks first (CA-06).
window.addEventListener('beforeunload', (e) => {
  if (viewer.model && (history.dirty || docs.some((d) => d.dirty))) { e.preventDefault(); e.returnValue = ''; }
});
viewer.onContextChange = (lost) => {
  document.body.classList.toggle('gl-lost', lost);
  if (lost) toast(t('Graphics were reset by the browser. Restoring…'), true); else toast('Graphics restored');
};

// ------------------------------------------------------------------ multi-document tabs (OV-110)
interface Doc {
  id: number; name: string; model: THREE.Object3D; clips: THREE.AnimationClip[]; unit: Unit; unitSource: UnitSource;
  up: 'y' | 'z'; ext: string; hist: ReturnType<History['snapshot']>; dirty: boolean; cam: string; sourceUrls: string[] | null;
  lastFiles: File[] | null; resources: ResourceInfo[]; expanded: Set<string>; identity: string;
}
const docs: Doc[] = [];
let docSeq = 0;
let activeDocId = 0;
/** Keeps the current model in a tab (not disposed) so another file can open next to it. */
function stashCurrentDocument() {
  if (!viewer.model) return;
  measure.clear(); setTool('none'); editor.select(null); editor.setGizmo('none');
  docs.push({
    id: activeDocId || ++docSeq, name: state.modelName, model: viewer.model, clips: viewer.clips, unit: state.unit, unitSource: state.unitSource,
    up: viewer.upAxis, ext: state.ext, hist: history.snapshot(), dirty: history.dirty, cam: cameraString(), sourceUrls: state.sourceUrls,
    lastFiles: state.lastFiles, resources: state.resources, expanded: state.expanded, identity: state.identity,
  });
  viewer.swapModel(null);
  history.restore({ done: [], undone: [], cleanId: 0, cleanReachable: true });
  activeDocId = ++docSeq;
  if (docs.length >= 4) toast(`${docs.length + 1} models are open. Each one uses memory; close tabs you no longer need.`);
  renderTabs();
}
function switchToDoc(id: number) {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const target = docs.splice(i, 1)[0];
  stashCurrentDocument();
  docs.pop(); // stash pushed the current one; re-insert it in place
  const cur = { ...(docs as any)[docs.length] };
  void cur;
  restoreDoc(target);
}
function restoreDoc(d: Doc) {
  activeDocId = d.id;
  viewer.swapModel(d.model, d.clips, false);
  viewer.setUpAxis(d.up);
  state.modelName = d.name; state.unit = d.unit; state.unitSource = d.unitSource; state.ext = d.ext;
  state.sourceUrls = d.sourceUrls; state.lastFiles = d.lastFiles; state.resources = d.resources; state.expanded = d.expanded; state.identity = d.identity;
  state.caps = detectCapabilities(d.model, d.ext, d.clips.length);
  history.restore(d.hist);
  applyCamera(d.cam, false);
  document.body.classList.add('has-model');
  refreshStats(); renderAll(); renderTabs();
}
async function closeDoc(id: number) {
  if (id === activeDocId) {
    if (history.dirty && !(await confirmDiscard())) return;
    const next = docs.pop();
    const old = viewer.model;
    viewer.swapModel(null);
    if (old) disposeObject(old);
    history.clear();
    if (next) restoreDoc(next); else { document.body.classList.remove('has-model'); state.modelName = ''; renderAll(); renderTabs(); }
    return;
  }
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  if (docs[i].dirty && !window.confirm?.(`Close ${docs[i].name}? Its changes are not exported.`)) return;
  disposeObject(docs[i].model);
  docs.splice(i, 1);
  renderTabs();
}
function renderTabs() {
  const host = document.getElementById('docTabs');
  if (!host) return;
  if (!docs.length) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  const all = [...docs.map((d) => ({ id: d.id, name: d.name, dirty: d.dirty, active: false })), { id: activeDocId, name: state.modelName, dirty: history.dirty, active: true }];
  host.innerHTML = all.map((d) => `<span class="doc-tab ${d.active ? 'active' : ''}"><button data-doc="${d.id}" ${d.active ? 'aria-current="true"' : ''}>${esc(d.name)}${d.dirty ? ' •' : ''}</button><button class="doc-x" data-docclose="${d.id}" aria-label="Close ${esc(d.name)}">×</button></span>`).join('');
}
document.addEventListener('click', (e) => {
  const tEl = e.target as HTMLElement;
  const c = tEl.closest<HTMLElement>('[data-docclose]');
  if (c) { closeDoc(Number(c.dataset.docclose)); return; }
  const d = tEl.closest<HTMLElement>('[data-doc]');
  if (d && Number(d.dataset.doc) !== activeDocId) {
    const target = docs.find((x) => x.id === Number(d.dataset.doc));
    if (!target) return;
    docs.splice(docs.indexOf(target), 1);
    // keep the current one as a tab
    measure.clear(); setTool('none'); editor.select(null);
    docs.push({ id: activeDocId, name: state.modelName, model: viewer.model!, clips: viewer.clips, unit: state.unit, unitSource: state.unitSource, up: viewer.upAxis, ext: state.ext, hist: history.snapshot(), dirty: history.dirty, cam: cameraString(), sourceUrls: state.sourceUrls, lastFiles: state.lastFiles, resources: state.resources, expanded: state.expanded, identity: state.identity });
    viewer.swapModel(null);
    restoreDoc(target);
  }
});
void switchToDoc;

// ------------------------------------------------------------------ project files (OV-085)
/** Saves the scene, units, camera, measurements and saved views into one local .omniproj file. */
async function saveProject() {
  if (!viewer.model) return;
  setLoading('Saving project…');
  try {
    const { zipSync, strToU8 } = await import('fflate');
    // Raw coordinates (no unit or axis change), every part, so reopening restores the exact scene.
    // Every node gets a stable id that travels inside the GLB (glTF extras); hidden parts are saved by id, so
    // two parts with the same name, or no name, keep their own visibility (F03). Version 2 manifest.
    let n = 0;
    const hiddenIds: number[] = [];
    viewer.model.traverse((o) => { if (o.userData.helper) return; o.userData.ovId = n++; if (!o.visible) hiddenIds.push(o.userData.ovId); });
    let glb: Blob;
    try { glb = await exportModel(viewer, 'glb', undefined, { unit: 'm', up: 'y', scope: 'all', keepIds: true }); }
    finally { viewer.model.traverse((o) => { delete o.userData.ovId; }); }
    const hidden: string[] = [];
    viewer.model.traverse((o) => { if (!o.visible && !o.userData.helper && o.name) hidden.push(o.name); });
    const manifest = {
      format: 'omniviewer-project', version: 2, hiddenIds, app: `${CONFIG.appName} ${APP_VERSION}`, saved: new Date().toISOString(),
      name: state.modelName, ext: state.ext, unit: state.unit, unitSource: state.unitSource, up: viewer.upAxis, displayUnit: state.displayUnit,
      camera: cameraString(), hidden, measurements: measure.serialize(), views: savedViewsFor(state.identity), sourceUrls: state.sourceUrls,
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(manifest, null, 2)), 'scene.glb': new Uint8Array(await glb.arrayBuffer()) });
    download(new Blob([zip as BlobPart], { type: 'application/zip' }), `${baseFileName()}.omniproj`);
    state.lastExport = null;
    history.markClean(); updateStatus();
    toast('Project saved on your device. Open the .omniproj file to continue later.');
  } catch (e: any) { toast(`Could not save the project: ${e?.message || e}`, true); }
  finally { setLoading(null); }
}
let openingProject = false;
/** A project's GLB comes back inside the loader's scene and the exporter's wrapper. Returning the original model
 *  root (marked at save time) keeps the hierarchy depth the same on every save/open cycle (F03). */
function unwrapProjectRoot(obj: THREE.Object3D): THREE.Object3D {
  let root: THREE.Object3D | null = null;
  obj.traverse((o) => { if (!root && o.userData.ovRoot) root = o; });
  const r = root as THREE.Object3D | null;
  if (!r || r === obj) return obj;
  obj.updateMatrixWorld(true);
  const m = r.matrixWorld.clone();
  r.removeFromParent();
  m.decompose(r.position, r.quaternion, r.scale);
  r.updateMatrixWorld(true);
  return r;
}

async function maybeOpenProject(files: File[]): Promise<boolean> {
  const f = files.length === 1 && /\.omniproj$/i.test(files[0].name) ? files[0] : null;
  if (!f) return false;
  if (!(await confirmDiscard())) return true;
  try {
    const { unzipSync, strFromU8 } = await import('fflate');
    const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
    const m = JSON.parse(strFromU8(z['project.json']));
    if (m.format !== 'omniviewer-project') throw new Error('This is not an OMNIVIEWER project file.');
    if (m.version > 2) throw new Error(`This project was saved by a newer version (format ${m.version}). Update the page and try again.`);
    const glb = new File([z['scene.glb'] as BlobPart], (m.name || 'scene').replace(/\.[^.]+$/, '') + '.glb');
    openingProject = true;
    try { await openFiles([glb], null, 'replace', true); } finally { openingProject = false; }
    if (!viewer.model) return true;
    if (Array.isArray(m.hiddenIds)) {
      // v2: by identity. Ids are dropped afterwards so they never reach an export.
      const ids = new Set<number>(m.hiddenIds);
      viewer.model.traverse((o) => { if (ids.has(o.userData.ovId)) o.visible = false; });
    } else {
      // v1: by name. Unnamed parts were saved as "" and must not hide every unnamed node.
      const hidden = new Set<string>((m.hidden || []).filter(Boolean));
      viewer.model.traverse((o) => { if (o.name && hidden.has(o.name)) o.visible = false; });
    }
    viewer.model.traverse((o) => { delete o.userData.ovId; delete o.userData.ovRoot; });
    state.modelName = m.name; state.ext = m.ext || state.ext;
    viewer.setUpAxis(m.up === 'z' ? 'z' : 'y');
    setFileUnit(m.unit, m.unitSource || 'user', { undoable: false });
    if (m.displayUnit) setDisplayUnit(m.displayUnit);
    if (m.camera) applyCamera(m.camera, false);
    if (Array.isArray(m.measurements)) measure.restore(m.measurements);
    if (Array.isArray(m.views) && m.views.length) restoreSavedViews(state.identity, m.views);
    state.sourceUrls = m.sourceUrls || null;
    history.markClean();
    refreshStats(); renderAll();
    toast(`Project ${m.name} restored`);
  } catch (e: any) { toast(e?.message || String(e), true); }
  return true;
}

// ------------------------------------------------------------------ watch a file for changes (Chromium: File System Access)
let watch: { handle: any; last: number; timer: number } | null = null;
async function watchFile() {
  const picker = (window as any).showOpenFilePicker;
  if (!picker) { toast('Watching a file needs Chrome or Edge on a computer. Reopen the file after you save it instead.', true); return; }
  if (!(await confirmDiscard())) return;
  try {
    const [handle] = await picker({ multiple: false });
    stopWatching();
    const file: File = await handle.getFile();
    await openFiles([file], null, 'replace', true);
    watch = { handle, last: file.lastModified, timer: 0 };
    const tick = async () => {
      if (!watch) return;
      try {
        const f: File = await watch.handle.getFile();
        if (f.lastModified !== watch.last) {
          watch.last = f.lastModified;
          const cam = cameraString(), unit = state.unit, src = state.unitSource;
          await openFiles([f], null, 'replace', true);
          applyCamera(cam, false);
          if (src === 'user' || src === 'saved') setFileUnit(unit, src, { undoable: false });
          toast(`Reloaded ${f.name} (changed on disk)`);
        }
      } catch { stopWatching(); toast('Stopped watching: the file is no longer available.', true); return; }
      watch.timer = window.setTimeout(tick, 1500);
    };
    watch.timer = window.setTimeout(tick, 1500);
    document.body.classList.add('watching');
    $('#watchBadge').classList.remove('hidden');
    $('#watchName').textContent = file.name;
    toast(`Watching ${file.name}: it reloads here whenever you save it in your modelling app.`);
  } catch (e: any) { if (e?.name !== 'AbortError') toast(e?.message || String(e), true); }
}
function stopWatching() {
  if (!watch) return;
  clearTimeout(watch.timer); watch = null;
  document.body.classList.remove('watching');
  $('#watchBadge')?.classList.add('hidden');
}
$('#watchStop')?.addEventListener('click', () => { stopWatching(); toast('Stopped watching the file'); });

// ------------------------------------------------------------------ AR Quick Look on iPhone / iPad (OV-108)
async function viewInAR() {
  const a = document.createElement('a');
  if (!(a.relList as any).supports?.('ar')) {
    toast('AR preview opens in Safari on iPhone and iPad. On other devices, export USDZ or GLB and open it in an AR app.', true);
    return;
  }
  setLoading('Preparing AR…');
  try {
    const blob = await exportModel(viewer, 'usdz', undefined, { unit: state.unit as UnitId, scope: 'visible' });
    a.rel = 'ar';
    a.href = URL.createObjectURL(blob);
    a.appendChild(document.createElement('img'));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } catch (e: any) { toast(`AR preview failed: ${e?.message || e}`, true); }
  finally { setLoading(null); }
}

// ------------------------------------------------------------------ workflow recipes (OV-109)
interface RecipeStep { id: string; label: string; destructive?: boolean; run(): void | Promise<void> }
const RECIPE_STEPS: RecipeStep[] = [
  { id: 'unit-mm', label: 'Set file units to millimetres', run: () => setFileUnit('mm', 'user', { undoable: true }) },
  { id: 'unit-in', label: 'Set file units to inches', run: () => setFileUnit('in', 'user', { undoable: true }) },
  { id: 'rescale-mm', label: 'Rescale numbers to millimetres', run: () => rescaleToUnit('mm') },
  { id: 'zup', label: 'Switch to Z-up', run: () => viewer.setUpAxis('z') },
  { id: 'center', label: 'Centre on origin and drop to floor', run: () => { editor.select(null); editor.centerOnOrigin(); } },
  { id: 'repair', label: 'Repair: fill holes and fix faces', destructive: true, run: () => runPanelAction('repair', 'repair') },
  { id: 'reduce50', label: 'Reduce polygons to 50%', destructive: true, run: () => runPanelAction('reduce', 'reduce50') },
  { id: 'export-stl', label: 'Export visible parts as STL (mm)', run: () => runExport('stl', null, viewer.upAxis === 'y') },
  { id: 'export-3mf', label: 'Export visible parts as 3MF', run: () => runExport('3mf', null, viewer.upAxis === 'y') },
  { id: 'export-glb', label: 'Export visible parts as GLB', run: () => runExport('glb') },
  { id: 'report', label: 'Download an inspection report', run: () => ctx.setTool('report') },
];
const recipeStore = { get: (): { name: string; steps: string[] }[] => { try { return JSON.parse(store.get('recipes', '[]')); } catch { return []; } }, set: (r: unknown) => store.set('recipes', JSON.stringify(r)) };
function runPanelAction(panel: string, action: string) { (window as any).__omniPanelActions?.[action]?.(); void panel; }
function showRecipes() {
  const list = recipeStore.get();
  let draft: string[] = [];
  const render = () => `<h2 id="dlgTitle">Workflow recipes</h2>
    <p>Save a sequence of steps and run it on any model. You review the steps before they run; the edits are undone together with one Ctrl+Z.</p>
    ${list.length ? `<div class="views-list">${list.map((r, i) => `<div class="view-row"><button class="view-go" data-recrun="${i}">${icon('play')}${esc(r.name)} <small class="muted">· ${r.steps.length} steps</small></button><button class="node-btn" style="opacity:1" data-recdel="${i}" aria-label="Delete ${esc(r.name)}">${icon('x')}</button></div>`).join('')}</div>` : '<p class="note">No recipes yet.</p>'}
    <div class="field-label" style="margin:14px 0 6px">New recipe</div>
    <div class="row"><select id="recStep">${RECIPE_STEPS.map((st) => `<option value="${st.id}">${esc(st.label)}${st.destructive ? ' (changes geometry)' : ''}</option>`).join('')}</select><button class="chip" id="recAdd">${icon('plus')}Add step</button></div>
    <ol class="recipe-steps">${draft.map((d) => `<li>${esc(RECIPE_STEPS.find((x) => x.id === d)!.label)}</li>`).join('')}</ol>
    <div class="row"><input type="text" id="recName" placeholder="Recipe name" aria-label="Recipe name"/><button class="btn-solid" id="recSave" ${draft.length ? '' : 'disabled'}>Save recipe</button></div>`;
  openModal(render());
  const re = () => { $('#modalCard').innerHTML = `<button class="modal-close" data-modal-close aria-label="${t('Close')}">${icon('x')}</button>${render()}`; };
  $('#modalCard').onclick = async (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('#recAdd')) { draft.push(($('#recStep') as HTMLSelectElement).value); re(); }
    if (el.closest('#recSave')) { list.push({ name: ($('#recName') as HTMLInputElement).value.trim() || `Recipe ${list.length + 1}`, steps: draft }); recipeStore.set(list); draft = []; re(); }
    const del = el.closest<HTMLElement>('[data-recdel]');
    if (del) { list.splice(Number(del.dataset.recdel), 1); recipeStore.set(list); re(); }
    const run = el.closest<HTMLElement>('[data-recrun]');
    if (run) {
      const r = list[Number(run.dataset.recrun)];
      if (!viewer.model) { toast('Open a model first.', true); return; }
      const steps = r.steps.map((id) => RECIPE_STEPS.find((x) => x.id === id)).filter(Boolean) as RecipeStep[];
      openModal(`<h2 id="dlgTitle">Run “${esc(r.name)}”?</h2><ol>${steps.map((st) => `<li>${esc(st.label)}${st.destructive ? ' <b class="bad">changes geometry</b>' : ''}</li>`).join('')}</ol>
        <p class="note">Applies to ${esc(state.modelName)}. Edits can be undone with one Ctrl+Z.</p>
        <div class="modal-actions"><button class="btn-outline" data-modal-close>${t('Cancel')}</button><button class="btn-solid" id="recGo">Run</button></div>`);
      $('#recGo').onclick = async () => {
        modal.close();
        const edits = steps.filter((st) => !st.id.startsWith('export') && st.id !== 'report');
        history.batch(`Recipe: ${r.name}`, () => { for (const st of edits) st.run(); });
        for (const st of steps.filter((x) => !edits.includes(x))) await st.run();
        toast(`Ran ${r.name}`);
      };
    }
  };
}

// expose for debugging in the console
(window as any).omniview = { viewer, editor, history, measure, paint, layoutToolbar };


// ------------------------------------------------------------------ unit hint
function showUnitHint(current: Unit, suggest: Unit, why: string) {
  if (document.body.classList.contains('embed')) return; // visitors of an embed cannot change the owner's units
  const el = $('#unitHint');
  el.innerHTML = `<span>${esc(why)}</span>
    <button class="chip" data-unithint="${suggest}">${t('Use {unit}', { unit: t(UNITS[suggest].label).toLowerCase() })}</button>
    <button class="chip" data-unithint="${current}">${t('Keep {u}', { u: UNITS[current].short })}</button>
    ${state.ext ? `<label class="check unit-remember"><input type="checkbox" id="unitRemember"/> ${t('Use for all .{ext} files', { ext: esc(state.ext) })}</label>` : ''}`;
  el.classList.remove('hidden');
}
let tipsWaiting = false;
function hideUnitHint() { $('#unitHint').classList.add('hidden'); if (tipsWaiting && viewer.model) setTimeout(maybeShowTips, 400); }
$('#unitHint').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-unithint]');
  if (!b) return;
  const remember = !!($('#unitRemember') as HTMLInputElement | null)?.checked;
  setFileUnit(b.dataset.unithint as Unit, remember ? 'saved' : 'user', { undoable: true, remember });
  hideUnitHint();
  toast(`${t('File units: {u}', { u: t(UNITS[state.unit].label).toLowerCase() })}${remember ? ` · saved for .${state.ext} files (shown in Details, where you can forget it)` : ''}`);
});

// ------------------------------------------------------------------ recent files (OV-047, OV-048, OV-053)
let recentCache: RecentEntry[] = [];
/** A small preview image for the recent-files list. */
function makeThumb(): string | undefined {
  try { return viewer.screenshot(1, false, false, { width: 160, height: 120 }); } catch { return undefined; }
}
async function renderRecent() {
  recentCache = prefs.rememberRecents ? await listRecent() : [];
  const host = $('#recentList');
  const usage = await recentUsage();
  if (!prefs.rememberRecents) {
    host.classList.remove('hidden');
    host.innerHTML = `<div class="recent-head"><span>${t('Recent files')}</span></div>
      <p class="note">Recent files are off: nothing is kept in this browser. <button class="link-btn" data-recenton>Turn on</button></p>`;
    return;
  }
  host.classList.toggle('hidden', !recentCache.length);
  if (!recentCache.length) { host.innerHTML = ''; return; }
  const ago = (tm: number) => {
    const m = Math.round((Date.now() - tm) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  host.innerHTML = `<div class="recent-head"><span>${t('Recent files')}</span><span class="grow"></span><button class="link-btn" data-recentclear>${t('Clear')}</button></div>
    <ul class="recent-grid">${recentCache.map((r, i) => `<li class="recent-item">
      <button class="recent-open" data-recent="${i}" aria-label="Open ${esc(r.name)}">
        ${r.thumb ? `<img class="ri-thumb" src="${r.thumb}" alt="" width="64" height="48"/>` : `<span class="ri-thumb">${icon(r.urls ? 'link' : 'mesh')}</span>`}
        <span class="ri-text"><span class="ri-name" title="${esc(r.name)}">${esc(r.name)}</span>
        <span class="ri-meta">${ago(r.date)}${r.size ? ' · ' + (r.size / 1048576).toFixed(1) + ' MB' : ''} · ${r.urls ? 'link' : 'original file'}</span></span>
      </button>
      <button class="node-btn" data-recentdel="${i}" aria-label="Remove ${esc(r.name)} from recent files">${icon('x')}</button></li>`).join('')}</ul>
    <p class="note">Recent files reopen the <b>original</b> file, not your edits. ${usage ? `${usage} of copies are` : 'Copies are'} kept only in this browser, never uploaded. <button class="link-btn" data-recentoff>Stop keeping recent files</button></p>`;
}
async function recentUsage(): Promise<string> {
  const total = recentCache.reduce((n, r) => n + (r.files ? r.size : 0), 0);
  return total ? `${(total / 1048576).toFixed(1)} MB` : '';
}
$('#recentList').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-recentclear]')) { await clearRecent(); renderRecent(); toast('Recent files cleared from this browser'); return; }
  if (t.closest('[data-recentoff]')) { store.set('recents', '0'); await clearRecent(); renderRecent(); toast('Recent files turned off and cleared'); return; }
  if (t.closest('[data-recenton]')) { store.set('recents', '1'); renderRecent(); return; }
  const del = t.closest<HTMLElement>('[data-recentdel]');
  if (del) { await removeRecent(recentCache[Number(del.dataset.recentdel)].id); renderRecent(); return; }
  const item = t.closest<HTMLElement>('[data-recent]');
  if (!item) return;
  const r = recentCache[Number(item.dataset.recent)];
  if (r.urls) openUrls(r.urls); else openFiles(entryFiles(r));
});

// ------------------------------------------------------------------ print estimate
/** When the default material prices were last checked (CA-13). Update together with src/cost.ts. */
const PRICES_AS_OF = 'checked November 2026';
const costPrefs = () => {
  const d = { material: 'pla', infill: 20, wall: 1.2, price: '', diameter: 1.75, copies: 1, basis: 'refill' as 'refill' | 'spool', currency: 'USD' };
  try { return { ...d, ...JSON.parse(store.get('cost', '{}')) }; } catch { return d; }
};
/** Why the print estimate is hidden for this model, or null (OV-026): it needs a real, print-sized mesh. */
function costHiddenReason(): string | null {
  const s = state.stats, c = state.caps;
  if (!s || !c) return 'No model.';
  if (!c.volume) return 'There is no triangle mesh to estimate.';
  if (c.isBIM) return 'Building models are not 3D prints.';
  if (c.animated) return 'Animated assets are usually not 3D prints.';
  if (state.unit === 'u') return 'The model has no real units yet.';
  const largest = Math.max(s.size.x, s.size.y, s.size.z) * UNITS[state.unit].toMeters;
  if (largest > 1.5) return `At ${fmtD(Math.max(s.size.x, s.size.y, s.size.z), 2)} it is larger than a typical printer.`;
  if (state.unitSource === 'guess') return 'The units are a guess. Confirm them above to see an estimate.';
  return null;
}
function costSection(): string {
  const s = state.stats;
  if (!viewer.model || !s || !s.meshes || s.volume <= 0) return '';
  const hidden = costHiddenReason();
  if (hidden && !state.forceCost) return `<div class="section" id="sec-cost"><div class="section-head"><span class="section-title">${t('Print estimate')}</span></div>
    <p class="note" style="margin:0">Hidden: ${esc(hidden)} <button class="link-btn" data-showcost>Show anyway</button></p></div>`;
  const p = costPrefs();
  const mat = MATERIALS.find((m) => m.id === p.material) ?? MATERIALS[0];
  const price = p.price === '' ? (p.basis === 'spool' ? mat.spool : mat.refill) : Number(p.price);
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
    ${mat.resin ? '' : `<div class="row"><label>Bought as</label><div class="seg"><button class="${p.basis !== 'spool' ? 'active' : ''}" data-costbasis="refill">Refill</button><button class="${p.basis === 'spool' ? 'active' : ''}" data-costbasis="spool">With spool</button></div></div>`}
    <div class="row"><label>Price / kg</label><input type="number" step="0.01" min="0" value="${price}" data-cost="price" aria-label="Price per kilogram"/><select data-cost="currency" class="cost-cur" aria-label="Currency">${['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'BRL'].map((c) => `<option ${p.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    ${mat.resin ? '' : `<div class="row"><label>Filament</label><select data-cost="diameter"><option value="1.75" ${p.diameter == 1.75 ? 'selected' : ''}>1.75 mm</option><option value="2.85" ${p.diameter == 2.85 ? 'selected' : ''}>2.85 mm</option></select></div>`}
    <div class="row"><label>Copies</label><input type="number" step="1" min="1" value="${p.copies}" data-cost="copies"/></div>
    <p class="note">Rough estimate from the ${s.hiddenParts ? 'visible parts’ ' : ''}volume (${s.closed ? 'watertight' : s.closed === null ? 'closedness not checked yet' : 'not watertight, so less reliable'}), ${mat.resin ? 'printed solid' : 'with walls and infill'}. Solid part: ${fmtNum(r.solidGrams, 1)} g. Supports, purge and failed prints are not included. ${p.price === '' ? (mat.resin ? `Default price: typical standard resin (${PRICES_AS_OF}). The amount is in your chosen currency only if you enter your own price.` : `Default prices: Bambu Lab list prices in USD, ${PRICES_AS_OF}; they change over time.`) : '<button class="link-btn" data-costreset>Reset to default price</button>'}</p>
  </div>`;
}
details.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const k = t.dataset.cost;
  if (!k) return;
  const p = costPrefs();
  if (k === 'material') { p.material = t.value; p.price = ''; }
  else if (k === 'price') p.price = t.value;
  else if (k === 'currency') p.currency = t.value;
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
    { id: 'helpcentre', label: 'Help centre: missing textures, units, links, storage…', group: 'Help', keywords: 'faq troubleshoot cors texture', run: () => showHelpCentre() },
    { id: 'notes', label: "What's new", group: 'Help', keywords: 'release notes changelog version', run: () => showReleaseNotes() },
    { id: 'bug', label: 'Report a problem', group: 'Help', keywords: 'bug issue diagnostics', run: () => showBugReport() },
    { id: 'about', label: 'About & support the project', group: 'Help', keywords: 'donate free', run: () => showSupportDialog() },
    { id: 'problems', label: 'Show problems and warnings', group: 'Help', keywords: 'errors log', run: () => showProblems() },
    { id: 'printcheck', label: 'Print-ready checklist', group: 'Prepare', keywords: 'print ready 3d printing check slicer prepare printable', run: () => showPrintChecklist(), enabled: has },
    { id: 'saveproj', label: 'Save project (.omniproj)', group: 'File', shortcut: 'Ctrl+S', keywords: 'save session continue later', run: () => saveProject(), enabled: has },
    { id: 'addfile', label: 'Add files to this scene…', group: 'File', keywords: 'import merge combine', run: () => pickFiles('add'), enabled: has },
    { id: 'newtab', label: 'Open files in a new tab…', group: 'File', keywords: 'tab multiple documents compare', run: () => pickFiles('tab'), enabled: has },
    { id: 'watch', label: 'Watch a file for changes (live reload)…', group: 'File', keywords: 'reload auto refresh cad blender', run: () => watchFile() },
    { id: 'reload', label: 'Reload original file', group: 'File', keywords: 'revert reset discard', run: () => reloadOriginal(), enabled: () => !!(state.lastFiles || state.sourceUrls) },
    { id: 'ar', label: 'View in AR (iPhone / iPad)', group: 'Present', keywords: 'augmented reality quick look usdz', run: () => viewInAR(), enabled: has },
    { id: 'recipes', label: 'Workflow recipes…', group: 'Tools', keywords: 'automate batch steps macro', run: () => showRecipes() },
    { id: 'pauseall', label: 'Pause all motion', group: 'View', keywords: 'stop animation autorotate reduce motion', run: () => pauseAllMotion() },
    { id: 'viewlink', label: 'Copy link to this view', group: 'View', keywords: 'share camera angle url bookmark', run: copyViewLink, enabled: has },
    { id: 'resetpanels', label: 'Reset panel sizes', group: 'View', run: () => { for (const s of ['left', 'right']) { document.documentElement.style.removeProperty(`--${s}-w`); store.set(`panelW.${s}`, ''); } layoutToolbar(); } },
    { id: 'focus', label: 'Focus mode (hide panels)', group: 'View', shortcut: 'Backslash', run: () => toggleFocusMode() },
    { id: 'group', label: 'Group selected parts', group: 'Edit', shortcut: 'Ctrl+G', run: () => editor.groupSelection(), enabled: () => editor.selection.length > 1 },
    { id: 'ungroup', label: 'Ungroup', group: 'Edit', shortcut: 'Ctrl+Shift+G', run: () => editor.selected && editor.ungroup(editor.selected), enabled: () => !!editor.selected },
    { id: 'showall', label: 'Show everything', group: 'View', keywords: 'unhide', run: () => showEverything(), enabled: has },
    { id: 'units', label: 'File units & display units', group: 'Tools', keywords: 'mm inch metre convert', run: () => { scrollToSection('sec-model'); ($('#fileUnit') as HTMLElement)?.focus(); }, enabled: has },
  );
}

/** File picker that adds to the scene or opens a new tab (CA-16, OV-110). */
function pickFiles(mode: OpenMode) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true; inp.accept = pickerAccept();
  inp.onchange = () => openFiles([...(inp.files || [])], null, mode, true);
  inp.click();
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
  if (files.length) { e.preventDefault(); if (qcIsOpen()) qcAdd(files); else openFiles(files); return; }
  const text = e.clipboardData?.getData('text')?.trim() || '';
  const urls = text.split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u));
  if (urls.length) { e.preventDefault(); openUrls(urls); }
});

// ------------------------------------------------------------------ first-visit tips
/** One short, device-aware tip the first time each tool is used (OV-049). Replayable from Help. */
const TOOL_TIPS: Record<string, [string, string]> = {
  measure: ['Point at a hole or round edge to see its diameter, or at an edge for its length, then click to keep it. Click a corner or face to measure a distance.', 'Tap a hole or an edge to measure it, or tap two points for a distance. Drag with one finger to orbit between taps.'],
  paint: ['Brush with the left mouse button; hold Alt (or use the right button) to orbit while painting.', 'Paint with one finger; use two fingers to orbit and zoom.'],
  section: ['Drag the slider in Details to move the cut. A badge on the view reminds you while it is on.', 'Move the slider in Details to cut through the model.'],
  repair: ['Red lines are open edges. The checks cover the mesh only, not printability.', 'Red lines are open edges. The checks cover the mesh only.'],
  thickness: ['Grey means no opposite wall was found (open surface), not "safe".', 'Grey means no opposite wall was found, not "safe".'],
};
function maybeShowToolTip(tool: string) {
  const tip = TOOL_TIPS[tool];
  if (!tip || store.get('tip.' + tool, '')) return;
  store.set('tip.' + tool, '1');
  toast(tip[isTouch() ? 1 : 0]);
}
function maybeShowTips() {
  if (store.get('tips', '') || document.body.classList.contains('embed') || $('.tips')) return;
  // A decision comes first: while the unit question is open, the tips wait (F22).
  if (!$('#unitHint').classList.contains('hidden')) { tipsWaiting = true; return; }
  tipsWaiting = false;
  const touch = matchMedia('(pointer: coarse)').matches;
  const el = document.createElement('div');
  el.className = 'tips';
  el.innerHTML = `<div class="tips-head"><b>${t('Quick tips')}</b><button class="node-btn" style="opacity:1" aria-label="${t('Close tips')}">${icon('x')}</button></div>
    <ol>
      <li>${t(touch ? 'Drag with one finger to orbit, two fingers to pan and pinch to zoom.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click a part to zoom to it.')}</li>
      <li>${t('Click a part to select it.')} ${t(touch ? 'Long-press for actions like hide, isolate and export.' : 'Right-click for actions like hide, isolate and export.')}</li>
      <li>${t('Press {k} to search every tool: repair, reduce, cut, convert…', { k: '<kbd>Ctrl K</kbd>' })}</li>
    </ol>
    <button class="btn-outline small" data-tipsok>${t('Got it')}</button>`;
  $('#stage').appendChild(el);
  document.body.classList.add('tips-open');
  const close = () => { store.set('tips', '1'); el.remove(); document.body.classList.remove('tips-open'); };
  el.querySelector('[data-tipsok]')!.addEventListener('click', close);
  el.querySelector('.node-btn')!.addEventListener('click', close);
}

// ------------------------------------------------------------------ phone toolbar
$('#mobileBar').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
  if (!b) return;
  const m = b.dataset.m!;
  if (m === 'details' || m === 'scene') toggleSheet(m === 'details' ? 'right' : 'left');
  else if (m === 'palette') openPalette();
  else if (m === 'measure' || m === 'paint') setTool(m);
  else runAction(m);
});

/** Share links for social sites (open in a new tab; nothing is sent until the user posts). */
function shareButtons(link: string, text: string, compact = false) {
  const u = encodeURIComponent(link), t = encodeURIComponent(text);
  const sites = [
    ['X', `https://twitter.com/intent/tweet?url=${u}&text=${t}`],
    ['Reddit', `https://www.reddit.com/submit?url=${u}&title=${t}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['Email', `mailto:?subject=${t}&body=${u}`],
  ];
  return `<div class="share-row ${compact ? 'compact' : ''}">${compact ? '<span class="note" style="margin:0">Tell a friend:</span>' : ''}${sites.map(([n, href]) => `<a class="chip" href="${href}" target="_blank" rel="noopener">${n}</a>`).join('')}</div>`;
}

// ------------------------------------------------------------------ phone: bottom sheets
function isPhone() { return matchMedia('(max-width: 700px)').matches; }
function syncBar() {
  $$('#mobileBar [data-m="details"]').forEach((b) => b.classList.toggle('on', !document.body.classList.contains('no-right')));
  $$('#mobileBar [data-m="scene"]').forEach((b) => b.classList.toggle('on', !document.body.classList.contains('no-left')));
}
/** On phones only one sheet is open at a time. */
function openSheet(side: 'left' | 'right') {
  if (!isPhone()) { document.body.classList.remove('no-' + side); return; }
  document.body.classList.remove('no-' + side);
  document.body.classList.add('no-' + (side === 'left' ? 'right' : 'left'));
  syncBar();
}
function toggleSheet(side: 'left' | 'right') {
  const open = !document.body.classList.contains('no-' + side);
  if (open) { document.body.classList.add('no-' + side); document.body.classList.remove('sheet-min'); }
  else { openSheet(side); document.body.classList.remove('sheet-min'); }
  syncBar();
}
// Handle: tap to shrink/expand, swipe down to close, swipe up to expand.
$$('.sheet-handle').forEach((h) => {
  let y0 = 0, moved = false;
  h.addEventListener('pointerdown', (e) => { y0 = e.clientY; moved = false; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', (e) => { if (Math.abs(e.clientY - y0) > 8) moved = true; });
  h.addEventListener('pointerup', (e) => {
    const dy = e.clientY - y0;
    const side = h.closest('.side.left') ? 'left' : 'right';
    if (!moved) document.body.classList.toggle('sheet-min');
    else if (dy > 40) {
      if (document.body.classList.contains('sheet-min')) { document.body.classList.add('no-' + side); document.body.classList.remove('sheet-min'); }
      else document.body.classList.add('sheet-min');
    } else if (dy < -40) document.body.classList.remove('sheet-min');
    syncBar();
  });
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { document.body.classList.remove('sheet-min'); setTimeout(syncBar); }));
// Selecting a part on a phone shows the docked selection bar (features/selbar.ts); its Details button opens the sheet.
window.addEventListener('resize', () => { if (!isPhone()) document.body.classList.remove('sheet-min'); syncBar(); });
syncBar();

// Keep the 3D view above whichever sheet is open (phones), and re-centre the model in the remaining space.
let lastSheetH = -1;
function measureSheet() {
  let h = 0;
  if (isPhone()) for (const id of ['#leftPanel', '#rightPanel']) {
    const el = $(id);
    if (getComputedStyle(el).display !== 'none') h = Math.max(h, el.getBoundingClientRect().height);
  }
  h = Math.round(h);
  if (h === lastSheetH) return;
  lastSheetH = h;
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
  // After the view resizes (0.25 s animation), re-frame the model in the space that is left.
  clearTimeout(refitTimer);
  if (isPhone() && viewer.model) refitTimer = window.setTimeout(() => viewer.fit(editor.selected ?? viewer.model), 320);
}
let refitTimer = 0;
const sheetObserver = new ResizeObserver(measureSheet);
sheetObserver.observe($('#leftPanel'));
sheetObserver.observe($('#rightPanel'));
new MutationObserver(measureSheet).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', measureSheet);
measureSheet();

details.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const basis = t.closest<HTMLElement>('[data-costbasis]');
  const reset = t.closest('[data-costreset]');
  if (!basis && !reset) return;
  const p = costPrefs();
  if (basis) { p.basis = basis.dataset.costbasis as 'refill' | 'spool'; p.price = ''; }
  if (reset) p.price = '';
  store.set('cost', JSON.stringify(p));
  renderDetails();
});

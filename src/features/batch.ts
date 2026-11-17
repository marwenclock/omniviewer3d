import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ctx, escHtml } from '../context';
import { registerCommand } from '../registry';
import { loadFiles, MODEL_EXTS, extOf, pickerAccept, pathOf, filePaths } from '../loaders';
import { EXPORT_FORMATS, exportObject, download, safeFileName, isPrintFormat, type ExportId, type UnitId } from '../exporters';
import { disposeObject } from '../viewer';
import { guessUnit, defaultUp } from '../units';

/**
 * Convert many files at once (OV-017, OV-018). Each job keeps its own units, axes and animations; textures go with
 * the model in the same folder; every outcome (including failures) is listed in a report inside the ZIP.
 * "PNG images" renders every model the same way for product shots.
 */
interface Job { key: string; label: string; files: File[]; status: 'waiting' | 'working' | 'done' | 'failed' | 'skipped'; message?: string; out?: string }

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** One job per model file (with companions from its folder), and one per ZIP archive. */
function buildJobs(files: File[]): Job[] {
  const jobs: Job[] = [];
  const companions = files.filter((f) => !MODEL_EXTS.has(extOf(f.name)) && extOf(f.name) !== 'zip');
  for (const f of files) {
    const ext = extOf(f.name);
    if (ext === 'zip') { jobs.push({ key: pathOf(f), label: `${f.name} (whole archive)`, files: [f], status: 'waiting' }); continue; }
    if (!MODEL_EXTS.has(ext)) continue;
    const dir = dirOf(pathOf(f));
    const own = companions.filter((c) => dirOf(pathOf(c)) === dir);
    jobs.push({ key: pathOf(f), label: pathOf(f), files: [f, ...(own.length ? own : companions.filter((c) => !dirOf(pathOf(c))))], status: 'waiting' });
  }
  return jobs;
}

// ------------------------------------------------------------------ product shots
let shotRenderer: THREE.WebGLRenderer | null = null;
async function renderShot(obj: THREE.Object3D, w: number, h: number, transparent: boolean, bg: string): Promise<Uint8Array> {
  if (!shotRenderer) {
    shotRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    shotRenderer.outputColorSpace = THREE.SRGBColorSpace;
    shotRenderer.toneMapping = THREE.NeutralToneMapping;
  }
  const r = shotRenderer;
  r.setPixelRatio(1); r.setSize(w, h, false);
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.background = transparent ? null : new THREE.Color(bg);
  r.setClearColor(bg, transparent ? 0 : 1);
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const cam = new THREE.PerspectiveCamera(35, w / h, radius / 100, radius * 100);
  const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
  const vfov = THREE.MathUtils.degToRad(35), hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
  cam.position.copy(c).addScaledVector(dir, (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05);
  cam.lookAt(c);
  cam.add(light); light.position.set(0.5, 1, 1); scene.add(cam);
  r.render(scene, cam);
  const blob: Blob = await new Promise((res) => r.domElement.toBlob((b) => res(b!), 'image/png'));
  scene.remove(obj);
  scene.environment?.dispose(); pm.dispose();
  return new Uint8Array(await blob.arrayBuffer());
}

export function showBatchDialog() {
  let jobs: Job[] = [];
  let running = false, cancel = false;
  const outputs: Record<string, Uint8Array> = {};
  ctx.openModal(`<h2 id="dlgTitle">Batch convert</h2>
    <p>Convert many files at once into one ZIP. Each model is converted separately with its own units and orientation. Put textures, .mtl or .bin files in the same folder as their model, or drop the folder.</p>
    <div class="batch-drop" id="batchDrop" tabindex="0">Drop files or folders here, or <button class="link-btn" id="batchPick">browse</button></div>
    <div class="batch-list" id="batchList" role="list"></div>
    <div class="row"><label for="batchTarget">Convert to</label><select id="batchTarget">${EXPORT_FORMATS.map((f) => `<option value="${f.id}" ${f.id === 'stl' ? 'selected' : ''}>${f.label}</option>`).join('')}<option value="png">PNG images (product shots)</option></select></div>
    <div id="batchShot" class="hidden">
      <div class="row"><label for="bsSize">Image size</label><select id="bsSize"><option value="1600x1600">1600 × 1600</option><option value="1920x1080">1920 × 1080</option><option value="1080x1350">1080 × 1350</option><option value="800x800">800 × 800</option></select></div>
      <div class="row"><label for="bsBg">Background</label><input type="color" id="bsBg" value="#f3f2ef"/><label class="check" style="margin:0 0 0 10px"><input type="checkbox" id="bsTrans"/> Transparent</label></div>
    </div>
    <label class="check"><input type="checkbox" id="batchZup" checked/> Stand Y-up models upright (Z-up) for 3D printing formats</label>
    <div class="modal-actions"><button class="btn-outline" id="batchCancel">Close</button><button class="btn-solid" id="batchGo" disabled>Convert</button></div>`);
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = pickerAccept();
  const list = document.getElementById('batchList')!;
  const go = document.getElementById('batchGo') as HTMLButtonElement;
  const target = () => (document.getElementById('batchTarget') as HTMLSelectElement).value as ExportId | 'png';
  const render = () => {
    const done = jobs.filter((j) => j.status === 'done').length, failed = jobs.filter((j) => j.status === 'failed').length;
    list.innerHTML = jobs.length
      ? `<div class="note">${jobs.length} job${jobs.length === 1 ? '' : 's'}${running ? ` · ${done} done${failed ? `, ${failed} failed` : ''}` : ''}</div>` +
        jobs.map((j) => `<div class="batch-row" role="listitem"><span title="${escHtml(j.label)}">${escHtml(j.label)}${j.files.length > 1 ? ` <small class="muted">+${j.files.length - 1} file${j.files.length === 2 ? '' : 's'}</small>` : ''}</span><span class="batch-status ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : ''}">${j.status === 'failed' ? '✕ ' + escHtml(j.message || 'failed') : j.status === 'done' ? '✓ done' : j.status === 'working' ? 'working…' : j.status}</span></div>`).join('')
      : '';
    go.disabled = running ? false : !jobs.length;
    go.textContent = running ? 'Cancel' : jobs.some((j) => j.status === 'failed') && jobs.every((j) => j.status === 'done' || j.status === 'failed') ? 'Retry failed' : 'Convert';
    document.getElementById('batchShot')!.classList.toggle('hidden', target() !== 'png');
  };
  const add = (fl: File[]) => { const known = new Set(jobs.flatMap((j) => j.files)); jobs = [...jobs, ...buildJobs(fl.filter((f) => !known.has(f)))]; render(); };
  (window as any).__omniBatchAdd = add;
  document.getElementById('batchPick')!.onclick = () => input.click();
  document.getElementById('batchTarget')!.onchange = render;
  input.onchange = () => add([...(input.files || [])]);
  const drop = document.getElementById('batchDrop')!;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
    const out: File[] = [];
    const walk = async (entry: any): Promise<void> => {
      if (entry.isFile) { const f: File = await new Promise((res, rej) => entry.file(res, rej)); filePaths.set(f, entry.fullPath.replace(/^\//, '')); out.push(f); }
      else if (entry.isDirectory) { const rd = entry.createReader(); let batch: any[]; do { batch = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const c of batch) await walk(c); } while (batch.length); }
    };
    const entries = [...(e.dataTransfer?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const en of entries) await walk(en); else out.push(...(e.dataTransfer?.files || []));
    add(out);
  });
  document.getElementById('batchCancel')!.onclick = () => { if (running) cancel = true; else ctx.closeModal(); };
  go.onclick = async () => {
    if (running) { cancel = true; return; }
    const tgt = target();
    const ext = tgt === 'png' ? 'png' : EXPORT_FORMATS.find((f) => f.id === tgt)!.ext;
    const zUp = (document.getElementById('batchZup') as HTMLInputElement).checked;
    const [sw, sh] = ((document.getElementById('bsSize') as HTMLSelectElement)?.value || '1600x1600').split('x').map(Number);
    const bg = (document.getElementById('bsBg') as HTMLInputElement)?.value || '#f3f2ef';
    const trans = (document.getElementById('bsTrans') as HTMLInputElement)?.checked;
    running = true; cancel = false;
    const todo = jobs.filter((j) => j.status !== 'done');
    for (const [i, j] of todo.entries()) {
      if (cancel) { j.status = 'skipped'; continue; }
      j.status = 'working'; render();
      ctx.setLoading(`Converting ${i + 1} of ${todo.length}: ${j.label}`, i / todo.length);
      try {
        const res = await loadFiles(j.files);
        // Units, axes and animation come from THIS file, not from whatever is open in the viewer (OV-017).
        const fext = extOf(res.mainFiles[0]);
        const size = new THREE.Box3().setFromObject(res.object).getSize(new THREE.Vector3());
        const unit = guessUnit(fext, Math.max(size.x, size.y, size.z), res.declaredUnit).unit as UnitId;
        const up = defaultUp(fext);
        let bytes: Uint8Array;
        if (tgt === 'png') {
          if (up === 'z') res.object.rotation.x = -Math.PI / 2;
          bytes = await renderShot(res.object, sw, sh, trans, bg);
        } else {
          const blob = await exportObject(res.object, tgt, { unit, up, zUp: zUp && up === 'y' && (isPrintFormat(tgt) || tgt === 'obj'), clips: res.animations, scope: 'visible' });
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        let name = safeFileName(j.label.replace(/\.[^.]+$/, '').replace(/\//g, '_')) + '.' + ext;
        while (outputs[name]) name = name.replace(/(\.\w+)$/, '-copy$1');
        outputs[name] = bytes;
        disposeObject(res.object);
        j.status = 'done'; j.out = name;
        j.message = res.warnings.length ? res.warnings.join('; ') : undefined;
      } catch (e: any) {
        j.status = 'failed'; j.message = e?.message || 'failed';
      }
      render();
    }
    ctx.setLoading(null);
    running = false;
    const ok = jobs.filter((j) => j.status === 'done');
    if (ok.length) {
      const report = ['OMNIVIEWER batch report', `Target: ${tgt === 'png' ? 'PNG images' : EXPORT_FORMATS.find((f) => f.id === tgt)!.label}`, `Date: ${new Date().toISOString()}`, '',
        ...jobs.map((j) => `${j.status.toUpperCase().padEnd(8)} ${j.label}${j.out ? ' -> ' + j.out : ''}${j.message ? ' (' + j.message + ')' : ''}`)].join('\n');
      download(new Blob([zipSync({ ...outputs, 'batch-report.txt': strToU8(report) }, { level: 0 }) as BlobPart], { type: 'application/zip' }), `converted-${ext}.zip`);
      const failed = jobs.filter((j) => j.status === 'failed').length;
      ctx.toast(`Converted ${ok.length} of ${jobs.length}${failed ? `; ${failed} failed (listed in batch-report.txt, use Retry failed)` : ''}${cancel ? '; stopped early' : ''}`, failed > 0);
    } else ctx.toast(cancel ? 'Batch stopped.' : 'None of the files could be converted.', !cancel);
    render();
  };
}

(window as any).__omniBatchFiles = (files: File[]) => { showBatchDialog(); setTimeout(() => (window as any).__omniBatchAdd?.(files), 30); };

export function initBatch() {
  registerCommand({ id: 'batch', label: 'Batch convert or render many files…', group: 'File', keywords: 'bulk multiple convert zip product shots png images', run: showBatchDialog });
}

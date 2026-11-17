import { zipSync } from 'fflate';
import { ctx, escHtml } from '../context';
import { registerCommand } from '../registry';
import { loadFiles, MODEL_EXTS, extOf, ACCEPT } from '../loaders';
import { EXPORT_FORMATS, exportModel, download, type ExportId } from '../exporters';
import { disposeObject } from '../viewer';

/** Convert many files at once; results are zipped into one download. Everything runs locally. */
export function showBatchDialog() {
  let files: File[] = [];
  ctx.openModal(`<h2>Batch convert</h2>
    <p>Convert many 3D files at once. Each model is converted separately and you get one ZIP. Include textures, .mtl or .bin files alongside the models that need them.</p>
    <div class="batch-drop" id="batchDrop" tabindex="0">Drop files here or <button class="link-btn" id="batchPick">browse</button></div>
    <div class="batch-list" id="batchList"></div>
    <div class="row"><label>Convert to</label><select id="batchTarget">${EXPORT_FORMATS.map((f) => `<option value="${f.id}" ${f.id === 'stl' ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
    <div class="modal-actions"><button class="btn-outline" data-modal-close>Cancel</button><button class="btn-solid" id="batchGo" disabled>Convert</button></div>`);
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = ACCEPT;
  const list = document.getElementById('batchList')!;
  const go = document.getElementById('batchGo') as HTMLButtonElement;
  const render = () => {
    const models = files.filter((f) => MODEL_EXTS.has(extOf(f.name)));
    list.innerHTML = files.length
      ? `<div class="note">${models.length} model${models.length === 1 ? '' : 's'}${files.length > models.length ? ` + ${files.length - models.length} companion file${files.length - models.length === 1 ? '' : 's'}` : ''}</div>` +
        models.slice(0, 50).map((f) => `<div class="batch-row" data-name="${escHtml(f.name)}"><span>${escHtml(f.name)}</span><span class="batch-status">waiting</span></div>`).join('')
      : '';
    go.disabled = !models.length;
  };
  const add = (fl: FileList | File[] | null) => { if (fl) { files = [...files, ...Array.from(fl)]; render(); } };
  document.getElementById('batchPick')!.onclick = () => input.click();
  input.onchange = () => add(input.files);
  const drop = document.getElementById('batchDrop')!;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); add(e.dataTransfer?.files ?? null); });
  go.onclick = async () => {
    const target = (document.getElementById('batchTarget') as HTMLSelectElement).value as ExportId;
    const fmt = EXPORT_FORMATS.find((f) => f.id === target)!;
    const models = files.filter((f) => MODEL_EXTS.has(extOf(f.name)));
    const companions = files.filter((f) => !MODEL_EXTS.has(extOf(f.name)));
    const out: Record<string, Uint8Array> = {};
    let ok = 0;
    go.disabled = true;
    for (const [i, f] of models.entries()) {
      const row = list.querySelector<HTMLElement>(`[data-name="${CSS.escape(f.name)}"] .batch-status`);
      if (row) row.textContent = 'converting…';
      ctx.setLoading(`Converting ${i + 1} of ${models.length}: ${f.name}`, i / models.length);
      try {
        const res = await loadFiles([f, ...companions]);
        const blob = await exportModel(ctx.viewer, target, res.object, { unit: 'mm' });
        let name = f.name.replace(/\.[^.]+$/, '') + '.' + fmt.ext;
        while (out[name]) name = name.replace(/(\.\w+)$/, '-copy$1');
        out[name] = new Uint8Array(await blob.arrayBuffer());
        disposeObject(res.object);
        ok++;
        if (row) { row.textContent = '✓ done'; row.classList.add('ok'); }
      } catch (e: any) {
        if (row) { row.textContent = '✕ ' + (e?.message || 'failed'); row.classList.add('bad'); }
      }
    }
    ctx.setLoading(null);
    if (ok) {
      download(new Blob([zipSync(out, { level: 0 }) as BlobPart], { type: 'application/zip' }), `converted-${fmt.ext}.zip`);
      ctx.toast(`Converted ${ok} of ${models.length} file${models.length === 1 ? '' : 's'} to ${fmt.label}`);
    } else ctx.toast('None of the files could be converted.', true);
    go.disabled = false;
  };
}

export function initBatch() {
  registerCommand({ id: 'batch', label: 'Batch convert many files…', group: 'File', keywords: 'bulk multiple convert zip', run: showBatchDialog });
}

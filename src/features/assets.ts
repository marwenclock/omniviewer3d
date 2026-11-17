import * as THREE from 'three';
import { ctx, escHtml } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { icon } from '../icons';

/**
 * Files & textures (OV-104, OV-106, OV-013): every file the model asked for, whether it was found, blocked or
 * missing, the textures in use with their size and memory, and a way to point at the right file without reopening.
 */
interface TexRow { tex: THREE.Texture; slot: string; mats: THREE.Material[]; meshes: THREE.Mesh[]; w: number; h: number; missing: string | null }

function textures(): TexRow[] {
  const map = new Map<THREE.Texture, TexRow>();
  ctx.viewer.model?.traverse((o: any) => {
    if (!o.isMesh || o.userData.helper) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as any[]) {
      if (!m) continue;
      for (const k of Object.keys(m)) {
        const t: THREE.Texture = m[k];
        if (!t?.isTexture) continue;
        let row = map.get(t);
        if (!row) {
          const img: any = t.image;
          const src: string = img?.src || img?.currentSrc || '';
          const miss = /^data:,(missing|blocked)-(.*)$/.exec(src);
          row = { tex: t, slot: k, mats: [], meshes: [], w: img?.width || 0, h: img?.height || 0, missing: miss ? decodeURIComponent(miss[2]) : !img || (!img.width && !img.data) ? t.name || 'unnamed image' : null };
          map.set(t, row);
        }
        if (!row.mats.includes(m)) row.mats.push(m);
        if (!row.meshes.includes(o)) row.meshes.push(o);
      }
    }
  });
  return [...map.values()];
}

const baseName = (p: string) => decodeURIComponent(p.split(/[\\/]/).pop() || p).toLowerCase();

/** Loads an image file into an existing texture (relink), as an undoable step. */
async function relink(row: TexRow, file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const before = row.tex.image;
    const apply = (image: any) => { row.tex.image = image; row.tex.needsUpdate = true; row.mats.forEach((m) => (m.needsUpdate = true)); ctx.viewer.requestRender(); };
    ctx.history.run({ label: `Relink ${file.name}`, redo: () => apply(img), undo: () => apply(before) });
    ctx.toast(`Linked ${file.name}`);
  } catch { ctx.toast(`${file.name} is not an image this browser can read.`, true); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}

/** Relinks every missing texture whose file name matches one of the chosen files (folder pick). */
async function relinkMany(files: File[]) {
  const rows = textures().filter((r) => r.missing);
  let n = 0;
  for (const r of rows) {
    const f = files.find((x) => x.name.toLowerCase() === baseName(r.missing!));
    if (f) { await relink(r, f); n++; }
  }
  ctx.toast(n ? `Linked ${n} of ${rows.length} missing texture${rows.length === 1 ? '' : 's'}` : 'None of those files match the missing names.', !n);
  ctx.renderDetails();
}

/** Loads a blocked web texture after the user agrees (OV-013). */
async function allowRemote(row: TexRow, url: string) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await relink(row, new File([await res.blob()], baseName(url)));
  } catch (e: any) { ctx.toast(`Could not load ${url}: ${e?.message || e}`, true); }
}

registerPanel({
  id: 'assets', label: 'Files & textures', icon: 'image',
  hint: 'Every file the model asked for, and the textures it uses',
  render() {
    const res = ctx.resources();
    const rows = textures();
    const missing = rows.filter((r) => r.missing);
    const mem = rows.reduce((n, r) => n + r.w * r.h * 4 * 1.33, 0);
    const status = (s: string) => ({ loaded: '<span class="ok">found</span>', missing: '<span class="bad">missing</span>', blocked: '<span class="bad">blocked</span>', failed: '<span class="bad">could not be read</span>' } as any)[s] || s;
    return `${missing.length ? `<div class="verdict warn" role="status">⚠ ${missing.length} texture${missing.length === 1 ? ' is' : 's are'} missing</div>
        <p class="note">Geometry is fine; only the look is affected. Pick the missing files (or their whole folder) to link them.</p>
        <div class="btn-row"><button class="btn-solid" data-relinkmany>${icon('open')}Choose files or folder…</button></div>` : rows.length ? '<div class="verdict ok">✓ All textures found</div>' : '<p class="note" style="margin-top:0">This model uses no textures.</p>'}
      ${rows.length ? `<div class="field-label">Textures · ≈${(mem / 1048576).toFixed(1)} MB on the graphics card</div>
      <ul class="asset-list">${rows.map((r, i) => {
        const noUv = r.meshes.some((m) => !m.geometry.attributes.uv);
        const big = Math.max(r.w, r.h) > 4096;
        return `<li class="${r.missing ? 'is-missing' : ''}">
          <span class="asset-name">${escHtml(r.missing || r.tex.name || `${r.slot} texture`)}</span>
          <span class="asset-meta">${r.slot} · ${r.missing ? '<span class="bad">missing</span>' : `${r.w}×${r.h}`} · ${r.meshes.length} part${r.meshes.length === 1 ? '' : 's'}${noUv ? ' · <span class="bad">a part has no UVs</span>' : ''}${big ? ' · <span class="bad">very large</span>' : ''}</span>
          <span class="asset-act">
            <button class="chip" data-relink="${i}">${r.missing ? 'Link file…' : 'Replace…'}</button>
            <button class="node-btn" style="opacity:1" data-texsel="${i}" aria-label="Select parts using this texture">${icon('target')}</button>
          </span></li>`;
      }).join('')}</ul>` : ''}
      ${res.length ? `<div class="field-label" style="margin-top:12px">Files the model asked for</div>
      <ul class="asset-list">${res.map((r, i) => `<li><span class="asset-name">${escHtml(baseName(r.url))}</span><span class="asset-meta">${status(r.status)}${r.resolved && r.status === 'loaded' ? ` · ${escHtml(r.resolved)}` : ''}${r.ambiguous ? ' · <span class="bad">several files share this name</span>' : ''} · needed by ${escHtml(r.owner)}</span>
        ${r.status === 'blocked' ? `<span class="asset-act"><button class="chip" data-allow="${i}">Load from web</button></span>` : ''}</li>`).join('')}</ul>
      <p class="note">Files on your device don't fetch from other websites unless you allow it, here or in Settings.</p>` : ''}`;
  },
  bind(host) {
    const rows = textures();
    const pick = (multiple: boolean, dir = false) => new Promise<File[]>((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = multiple; inp.accept = 'image/*,.ktx2,.dds,.tga';
      if (dir) (inp as any).webkitdirectory = true;
      inp.onchange = () => resolve([...(inp.files || [])]);
      inp.click();
    });
    host.querySelector('[data-relinkmany]')?.addEventListener('click', async () => { const f = await pick(true); if (f.length) relinkMany(f); });
    host.querySelectorAll<HTMLElement>('[data-relink]').forEach((b) => b.addEventListener('click', async () => { const [f] = await pick(false); if (f) { await relink(rows[Number(b.dataset.relink)], f); ctx.renderDetails(); } }));
    host.querySelectorAll<HTMLElement>('[data-texsel]').forEach((b) => b.addEventListener('click', () => {
      const list = rows[Number(b.dataset.texsel)].meshes;
      ctx.editor.select(list[0]); list.slice(1).forEach((m) => ctx.editor.multi.add(m)); ctx.renderDetails();
    }));
    host.querySelectorAll<HTMLElement>('[data-allow]').forEach((b) => b.addEventListener('click', async () => {
      const r = ctx.resources()[Number(b.dataset.allow)];
      const row = rows.find((x) => x.missing && baseName(x.missing) === baseName(r.url));
      if (row) { await allowRemote(row, r.url); r.status = 'loaded'; ctx.renderDetails(); }
      else ctx.toast('That file is not used as a texture.', true);
    }));
  },
});

export function initAssets() {
  registerCommand({ id: 'assets', label: 'Files & textures (missing textures, sizes)', group: 'Inspect', keywords: 'missing texture relink mtl images memory uv', run: () => ctx.setTool('assets'), enabled: () => !!ctx.viewer.model });
}

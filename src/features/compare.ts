import * as THREE from 'three';
import { ctx, escHtml } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { loadFiles, ACCEPT } from '../loaders';
import { disposeObject } from '../viewer';
import { computeStats, fmtInt, fmtNum, UNITS } from '../stats';

/** Load a second model next to (or on top of) the current one to compare revisions. */
let other: THREE.Object3D | null = null;
let otherName = '';
let mode: 'overlay' | 'side' = 'overlay';
let opacity = 0.45;
let showA = true, showB = true;

function ghost(root: THREE.Object3D) {
  root.userData.helper = true; // the root only: keeps B out of exports and the tree, but lets us measure it
  root.traverse((o: any) => {
    if (o.isMesh || o.isPoints || o.isLine) {
      o.raycast = () => {};
      o.material = new THREE.MeshStandardMaterial({ color: 0xff8a3d, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 });
    }
  });
}

function place() {
  const v = ctx.viewer;
  if (!other || !v.model) return;
  other.position.set(0, 0, 0);
  other.updateMatrixWorld(true);
  const a = v.bounds(), b = new THREE.Box3().setFromObject(other);
  const ca = a.getCenter(new THREE.Vector3()), cb = b.getCenter(new THREE.Vector3());
  // Overlay: match centres and floors. Side by side: put B to the right of A.
  const delta = new THREE.Vector3(ca.x - cb.x, a.min.y - b.min.y, ca.z - cb.z);
  if (mode === 'side') delta.x += a.getSize(new THREE.Vector3()).x / 2 + b.getSize(new THREE.Vector3()).x / 2 + a.getSize(new THREE.Vector3()).length() * 0.1;
  const parent = other.parent!;
  const p0 = parent.worldToLocal(new THREE.Vector3()), p1 = parent.worldToLocal(delta.clone());
  other.position.add(p1.sub(p0));
  other.visible = showB;
  v.model.visible = showA;
  other.traverse((o: any) => { if (o.material) { o.material.opacity = mode === 'side' ? 1 : opacity; o.material.transparent = mode !== 'side'; o.material.depthWrite = mode === 'side'; } });
}

function clear() {
  if (!other) return;
  other.removeFromParent();
  disposeObject(other);
  other = null;
  if (ctx.viewer.model) ctx.viewer.model.visible = true;
}

async function openOther(files: File[]) {
  ctx.setLoading('Loading comparison model…');
  try {
    const res = await loadFiles(files, (m) => ctx.setLoading(m));
    clear();
    other = res.object;
    otherName = res.mainFiles.join(', ');
    ghost(other);
    ctx.viewer.world.add(other);
    place();
    ctx.viewer.fit();
    ctx.renderDetails();
  } catch (e: any) {
    ctx.toast(e?.message || String(e), true);
  } finally { ctx.setLoading(null); }
}

function statsRow(label: string, a: number, b: number, unit = '', digits = 2) {
  const d = b - a;
  const pct = a ? (d / a) * 100 : 0;
  return `<tr><td>${label}</td><td>${fmtNum(a, digits)}${unit}</td><td>${fmtNum(b, digits)}${unit}</td><td class="${Math.abs(pct) < 0.05 ? '' : d > 0 ? 'up' : 'down'}">${Math.abs(pct) < 0.05 ? '=' : (d > 0 ? '+' : '') + fmtNum(pct, 1) + '%'}</td></tr>`;
}

registerPanel({
  id: 'compare', label: 'Compare models', icon: 'compare',
  hint: 'Orange = the comparison model (B), shown on top of or next to your model (A)',
  onDeactivate: clear,
  render() {
    if (!other) return `<p class="note" style="margin-top:0">Open a second version of the model to see what changed: shape, size, volume and triangle count.</p>
      <div class="btn-row"><button class="btn-solid" data-cmpopen>Open model B…</button></div>`;
    const u = UNITS[ctx.unit()].short;
    const v = ctx.viewer;
    const sa = computeStats(v.model, v.bounds());
    const sb = computeStats(other, new THREE.Box3().setFromObject(other));
    return `<div style="font-size:12.5px;margin-bottom:8px"><b>B:</b> ${escHtml(otherName)}</div>
      <div class="seg"><button class="${mode === 'overlay' ? 'active' : ''}" data-cmpmode="overlay">Overlay</button><button class="${mode === 'side' ? 'active' : ''}" data-cmpmode="side">Side by side</button></div>
      ${mode === 'overlay' ? `<div class="row"><label>B opacity</label><input type="range" min="0.1" max="1" step="0.05" value="${opacity}" data-cmpop/></div>` : ''}
      <label class="check"><input type="checkbox" data-cmpa ${showA ? 'checked' : ''}/> Show A (your model)</label>
      <label class="check"><input type="checkbox" data-cmpb ${showB ? 'checked' : ''}/> Show B (orange)</label>
      <table class="cmp-table"><tr><th></th><th>A</th><th>B</th><th>Δ</th></tr>
        ${statsRow('Width', sa.size.x, sb.size.x, ' ' + u)}${statsRow('Height', sa.size.y, sb.size.y, ' ' + u)}${statsRow('Depth', sa.size.z, sb.size.z, ' ' + u)}
        ${statsRow('Volume', sa.volume, sb.volume, ` ${u}³`)}${statsRow('Area', sa.area, sb.area, ` ${u}²`)}${statsRow('Triangles', sa.triangles, sb.triangles, '', 0)}
      </table>
      <div class="btn-row"><button class="chip" data-cmpopen>Open another…</button><button class="chip danger" data-cmpclear>Remove B</button></div>
      <p class="note">B is only for comparison: it is not exported or counted in the model details.</p>`;
  },
  bind(host) {
    host.querySelectorAll('[data-cmpopen]').forEach((b) => b.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = ACCEPT;
      input.onchange = () => input.files?.length && openOther([...input.files]);
      input.click();
    }));
    host.querySelectorAll<HTMLElement>('[data-cmpmode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.cmpmode as any; place(); ctx.viewer.fit(); ctx.renderDetails(); }));
    host.querySelector('[data-cmpop]')?.addEventListener('input', (e) => { opacity = Number((e.target as HTMLInputElement).value); place(); });
    host.querySelector('[data-cmpa]')?.addEventListener('change', (e) => { showA = (e.target as HTMLInputElement).checked; place(); });
    host.querySelector('[data-cmpb]')?.addEventListener('change', (e) => { showB = (e.target as HTMLInputElement).checked; place(); });
    host.querySelector('[data-cmpclear]')?.addEventListener('click', () => { clear(); ctx.renderDetails(); });
  },
});

export function initCompare() {
  registerCommand({ id: 'compare', label: 'Compare with another model…', group: 'Tools', keywords: 'diff revision version overlay', run: () => ctx.setTool('compare'), enabled: () => !!ctx.viewer.model });
  ctx.viewer.onChange(() => { if (other && !other.parent) other = null; });
}

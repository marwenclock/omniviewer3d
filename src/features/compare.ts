import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ctx, escHtml, modelMeshes } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { loadFiles, pickerAccept, extOf } from '../loaders';
import { disposeObject } from '../viewer';
import { computeStats, fmtNum, UNITS, type Unit } from '../stats';
import { guessUnit, defaultUp } from '../units';

/**
 * Compare two revisions (OV-099, OV-100). B is converted into A's units and axes first, then aligned. Views:
 * orange overlay, side by side, or a before/after wipe. The deviation map colours A by its distance to B.
 */
let other: THREE.Object3D | null = null;
let otherName = '';
let otherUnit: Unit = 'mm';
let mode: 'overlay' | 'side' | 'wipe' = 'overlay';
let align: 'centre' | 'origin' | 'manual' = 'centre';
const manual = new THREE.Vector3();
let opacity = 0.45;
let showA = true, showB = true;
let wipeX = 0.5;
let tolerance = 0.1; // display units
let dev: { stats: { max: number; mean: number; rms: number; within: number }; restore: () => void } | null = null;
let wipeHandle: HTMLElement | null = null;

function ghost(root: THREE.Object3D) {
  root.userData.helper = true; // keeps B out of exports and the parts list
  root.traverse((o: any) => {
    if (o.isMesh || o.isPoints || o.isLine) {
      o.raycast = () => {};
      o.userData.origMaterial = o.material;
      o.userData.ghostMaterial = new THREE.MeshStandardMaterial({ color: 0xff8a3d, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 });
      o.material = o.userData.ghostMaterial;
    }
  });
}

function setMaterials(useOriginal: boolean) {
  other?.traverse((o: any) => { if (o.userData.ghostMaterial) o.material = useOriginal ? o.userData.origMaterial : o.userData.ghostMaterial; });
}

function place() {
  const v = ctx.viewer;
  if (!other || !v.model) return;
  other.position.set(0, 0, 0);
  other.updateMatrixWorld(true);
  const a = v.bounds(), b = new THREE.Box3().setFromObject(other);
  const delta = new THREE.Vector3();
  if (align === 'centre' || mode === 'side') {
    const ca = a.getCenter(new THREE.Vector3()), cb = b.getCenter(new THREE.Vector3());
    delta.set(ca.x - cb.x, a.min.y - b.min.y, ca.z - cb.z);
  }
  if (align === 'manual') delta.copy(manual).divideScalar(ctx.toDisp(1) || 1);
  if (mode === 'side') delta.x += a.getSize(new THREE.Vector3()).x / 2 + b.getSize(new THREE.Vector3()).x / 2 + a.getSize(new THREE.Vector3()).length() * 0.1;
  const parent = other.parent!;
  const p0 = parent.worldToLocal(new THREE.Vector3()), p1 = parent.worldToLocal(delta.clone());
  other.position.add(p1.sub(p0));
  other.visible = showB;
  v.model.visible = showA;
  setMaterials(mode === 'wipe' || mode === 'side');
  other.traverse((o: any) => { if (o.userData.ghostMaterial) { const m = o.userData.ghostMaterial; m.opacity = opacity; } });
  v.split = mode === 'wipe' ? { x: wipeX, left: [other], right: [v.model] } : null;
  syncWipeHandle();
  v.requestRender();
}

/** Draggable divider over the canvas for the wipe view. */
function syncWipeHandle() {
  const stage = document.getElementById('stage');
  if (mode !== 'wipe' || !other) { wipeHandle?.remove(); wipeHandle = null; return; }
  if (!wipeHandle && stage) {
    wipeHandle = document.createElement('div');
    wipeHandle.className = 'wipe-handle';
    wipeHandle.setAttribute('role', 'slider');
    wipeHandle.setAttribute('aria-label', 'Before / after divider');
    wipeHandle.tabIndex = 0;
    wipeHandle.innerHTML = '<span>A</span><span>B</span>';
    stage.appendChild(wipeHandle);
    const move = (clientX: number) => {
      const r = ctx.viewer.renderer.domElement.getBoundingClientRect();
      wipeX = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      place();
    };
    wipeHandle.addEventListener('pointerdown', (e) => {
      wipeHandle!.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => move(ev.clientX);
      const up = () => { wipeHandle?.removeEventListener('pointermove', mv); wipeHandle?.removeEventListener('pointerup', up); };
      wipeHandle!.addEventListener('pointermove', mv); wipeHandle!.addEventListener('pointerup', up);
    });
    wipeHandle.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { wipeX = Math.max(0, wipeX - 0.05); place(); } if (e.key === 'ArrowRight') { wipeX = Math.min(1, wipeX + 0.05); place(); } });
  }
  if (wipeHandle) { wipeHandle.style.left = `${wipeX * 100}%`; wipeHandle.setAttribute('aria-valuenow', String(Math.round(wipeX * 100))); }
}

function clearDeviation() { dev?.restore(); dev = null; }

function clear() {
  clearDeviation();
  if (!other) return;
  ctx.viewer.split = null;
  syncWipeHandle();
  other.removeFromParent();
  disposeObject(other);
  other = null;
  if (ctx.viewer.model) ctx.viewer.model.visible = true;
  ctx.viewer.requestRender();
}

/** Frames both A and B. */
function fitBoth() {
  if (!other) return;
  other.userData.helper = false;
  ctx.viewer.fit(ctx.viewer.world);
  other.userData.helper = true;
}

async function openOther(files: File[]) {
  ctx.setLoading('Loading comparison model…');
  try {
    const res = await loadFiles(files, (m) => ctx.setLoading(m));
    clear();
    other = res.object;
    otherName = res.mainFiles.join(', ');
    // Bring B into A's physical units and axes (OV-099).
    const ext = extOf(res.mainFiles[0]);
    const size = new THREE.Box3().setFromObject(other).getSize(new THREE.Vector3());
    const g = guessUnit(ext, Math.max(size.x, size.y, size.z), res.declaredUnit);
    otherUnit = g.unit;
    const aUnit = ctx.unit();
    if (aUnit !== 'u' && g.unit !== 'u') other.scale.multiplyScalar(UNITS[g.unit].toMeters / UNITS[aUnit].toMeters);
    const bUp = defaultUp(ext), aUp = ctx.upAxis();
    if (bUp !== aUp) other.rotation.x = aUp === 'z' ? Math.PI / 2 : -Math.PI / 2;
    ghost(other);
    ctx.viewer.world.add(other);
    place();
    fitBoth();
    ctx.renderDetails();
    if (g.unit !== aUnit) ctx.toast(`B was in ${UNITS[g.unit].label.toLowerCase()} (${g.source}); converted to match A.`);
  } catch (e: any) {
    ctx.toast(e?.message || String(e), true);
  } finally { ctx.setLoading(null); }
}

/** Colours A by its distance to B's surface and summarises it against a tolerance (OV-100). */
function runDeviation() {
  clearDeviation();
  const v = ctx.viewer;
  if (!other || !v.model) return;
  // Merge B's meshes in world space into one BVH.
  const parts: THREE.BufferGeometry[] = [];
  other.updateMatrixWorld(true);
  other.traverse((o: any) => {
    if (!o.isMesh) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()) as THREE.BufferGeometry;
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.applyMatrix4(o.matrixWorld);
    parts.push(g);
  });
  if (!parts.length) { ctx.toast('Model B has no surface to compare against.', true); return; }
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  let off = 0;
  for (const g of parts) { pos.set(g.attributes.position.array as Float32Array, off); off += g.attributes.position.array.length; g.dispose(); }
  const merged = new THREE.BufferGeometry(); merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const bvh = new MeshBVH(merged);
  const tolFile = tolerance / (ctx.toDisp(1) || 1);
  const saved: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }[] = [];
  let max = 0, sum = 0, sq = 0, n = 0, within = 0;
  const p = new THREE.Vector3(), target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as any;
  const col = new THREE.Color();
  for (const mesh of modelMeshes(v.model, true)) {
    const src = mesh.geometry;
    const g = src.clone();
    const ps = g.attributes.position;
    const colors = new Float32Array(ps.count * 3);
    mesh.updateMatrixWorld(true);
    for (let i = 0; i < ps.count; i++) {
      p.fromBufferAttribute(ps, i).applyMatrix4(mesh.matrixWorld);
      const hit = bvh.closestPointToPoint(p, target);
      const d = hit ? hit.distance : Infinity;
      if (isFinite(d)) { max = Math.max(max, d); sum += d; sq += d * d; n++; if (d <= tolFile) within++; }
      // blue within tolerance → yellow at 3× → red beyond
      const k = isFinite(d) ? Math.min(1, d / (tolFile * 3 || 1)) : 1;
      col.setHSL(0.62 - k * 0.62, 0.8, 0.52);
      colors.set([col.r, col.g, col.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    saved.push({ mesh, geometry: src, material: mesh.material });
    mesh.geometry = g;
    mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  merged.dispose();
  dev = {
    stats: { max, mean: n ? sum / n : 0, rms: n ? Math.sqrt(sq / n) : 0, within: n ? within / n : 0 },
    restore: () => { for (const s of saved) { s.mesh.geometry.dispose(); s.mesh.geometry = s.geometry; s.mesh.material = s.material; } v.requestRender(); },
  };
  v.requestRender();
  ctx.renderDetails();
}

function statsRow(label: string, a: number, b: number, unit = '', digits = 2) {
  const d = b - a;
  const pct = a ? (d / a) * 100 : 0;
  return `<tr><td>${label}</td><td>${fmtNum(a, digits)}${unit}</td><td>${fmtNum(b, digits)}${unit}</td><td class="${Math.abs(pct) < 0.05 ? '' : d > 0 ? 'up' : 'down'}">${Math.abs(pct) < 0.05 ? '=' : (d > 0 ? '+' : '') + fmtNum(pct, 1) + '%'}</td></tr>`;
}

registerPanel({
  id: 'compare', label: 'Compare models', icon: 'compare',
  hint: 'B is the comparison model: orange overlay, side by side, or drag the divider in Wipe view',
  onDeactivate: clear,
  render() {
    if (!other) return `<p class="note" style="margin-top:0">Open a second version of the model to see what changed: shape, size, volume and triangle count. B is converted into A's units and axes first.</p>
      <div class="btn-row"><button class="btn-solid" data-cmpopen>Open model B…</button></div>`;
    const u = ctx.dispUnitShort();
    const D = (x: number) => ctx.toDisp(x);
    const v = ctx.viewer;
    const sa = computeStats(v.model, v.bounds());
    const sb = computeStats(other, new THREE.Box3().setFromObject(other));
    const k = D(1);
    return `<div style="font-size:12.5px;margin-bottom:8px"><b>A:</b> ${escHtml(ctx.modelName())}<br><b>B:</b> ${escHtml(otherName)} <span class="muted">(from ${UNITS[otherUnit].short})</span></div>
      <div class="seg"><button class="${mode === 'overlay' ? 'active' : ''}" data-cmpmode="overlay">Overlay</button><button class="${mode === 'side' ? 'active' : ''}" data-cmpmode="side">Side by side</button><button class="${mode === 'wipe' ? 'active' : ''}" data-cmpmode="wipe">Wipe</button></div>
      ${mode !== 'side' ? `<div class="row"><label>Align</label><select data-cmpalign><option value="centre" ${align === 'centre' ? 'selected' : ''}>Centres and floors</option><option value="origin" ${align === 'origin' ? 'selected' : ''}>As modelled (origins)</option><option value="manual" ${align === 'manual' ? 'selected' : ''}>Manual offset</option></select></div>` : ''}
      ${align === 'manual' && mode !== 'side' ? `<div class="row"><label>Offset ${u}</label><div class="xyz">${['x', 'y', 'z'].map((ax) => `<input type="number" step="any" data-cmpoff="${ax}" value="${(manual as any)[ax]}" aria-label="Offset ${ax}"/>`).join('')}</div></div>` : ''}
      ${mode === 'overlay' ? `<div class="row"><label>B opacity</label><input type="range" min="0.1" max="1" step="0.05" value="${opacity}" data-cmpop aria-label="B opacity"/></div>` : ''}
      ${mode !== 'wipe' ? `<label class="check"><input type="checkbox" data-cmpa ${showA ? 'checked' : ''}/> Show A (your model)</label>
      <label class="check"><input type="checkbox" data-cmpb ${showB ? 'checked' : ''}/> Show B</label>` : '<p class="note">Drag the divider on the view (or use the arrow keys on it): A on the right, B on the left.</p>'}
      <table class="cmp-table"><tr><th></th><th>A</th><th>B</th><th>Δ</th></tr>
        ${statsRow('Width', sa.size.x * k, sb.size.x * k, ' ' + u)}${statsRow('Height', sa.size.y * k, sb.size.y * k, ' ' + u)}${statsRow('Depth', sa.size.z * k, sb.size.z * k, ' ' + u)}
        ${statsRow('Volume', sa.volume * k ** 3, sb.volume * k ** 3, ` ${u}³`)}${statsRow('Area', sa.area * k ** 2, sb.area * k ** 2, ` ${u}²`)}${statsRow('Triangles', sa.triangles, sb.triangles, '', 0)}
      </table>
      <div class="field-label" style="margin:12px 0 4px">Surface deviation (A → B)</div>
      <div class="row"><label>Tolerance</label><input type="number" step="any" min="0" value="${tolerance}" data-cmptol aria-label="Tolerance in ${u}"/><span class="cost-unit">${u}</span><button class="chip" data-cmpdev>${dev ? 'Recalculate' : 'Show map'}</button></div>
      ${dev ? `<div class="heat-legend dev-legend"><span>within</span><i></i><span>${fmtNum(tolerance * 3, 3)} ${u}+</span></div>
        <dl class="kv"><dt>Within tolerance</dt><dd>${fmtNum(dev.stats.within * 100, 1)}%</dd><dt>Largest distance</dt><dd>${fmtNum(D(dev.stats.max), 4)} ${u}</dd><dt>Average</dt><dd>${fmtNum(D(dev.stats.mean), 4)} ${u}</dd><dt>RMS</dt><dd>${fmtNum(D(dev.stats.rms), 4)} ${u}</dd></dl>
        <p class="note">Distance from each point of A to the nearest point on B's surface, after alignment. Shape only: colours and materials are not compared. <button class="link-btn" data-cmpdevclear>Clear map</button></p>` : '<p class="note">Colours A by how far each point is from B. Align the models first.</p>'}
      <div class="btn-row"><button class="chip" data-cmpfit>Fit both</button><button class="chip" data-cmpopen>Open another…</button><button class="chip danger" data-cmpclear>Remove B</button></div>
      <p class="note">B is only for comparison: it is not exported or counted in the model details.</p>`;
  },
  bind(host) {
    host.querySelectorAll('[data-cmpopen]').forEach((b) => b.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = pickerAccept();
      input.onchange = () => input.files?.length && openOther([...input.files]);
      input.click();
    }));
    host.querySelectorAll<HTMLElement>('[data-cmpmode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.cmpmode as any; place(); fitBoth(); ctx.renderDetails(); }));
    host.querySelector('[data-cmpalign]')?.addEventListener('change', (e) => { align = (e.target as HTMLSelectElement).value as any; clearDeviation(); place(); ctx.renderDetails(); });
    host.querySelectorAll<HTMLInputElement>('[data-cmpoff]').forEach((inp) => inp.addEventListener('change', () => { (manual as any)[inp.dataset.cmpoff!] = Number(inp.value) || 0; clearDeviation(); place(); }));
    host.querySelector('[data-cmpop]')?.addEventListener('input', (e) => { opacity = Number((e.target as HTMLInputElement).value); place(); });
    host.querySelector('[data-cmpa]')?.addEventListener('change', (e) => { showA = (e.target as HTMLInputElement).checked; place(); });
    host.querySelector('[data-cmpb]')?.addEventListener('change', (e) => { showB = (e.target as HTMLInputElement).checked; place(); });
    host.querySelector('[data-cmptol]')?.addEventListener('change', (e) => { tolerance = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); });
    host.querySelector('[data-cmpdev]')?.addEventListener('click', () => { ctx.setLoading('Measuring deviation…'); setTimeout(() => { try { runDeviation(); } finally { ctx.setLoading(null); } }, 30); });
    host.querySelector('[data-cmpdevclear]')?.addEventListener('click', () => { clearDeviation(); ctx.renderDetails(); });
    host.querySelector('[data-cmpfit]')?.addEventListener('click', fitBoth);
    host.querySelector('[data-cmpclear]')?.addEventListener('click', () => { clear(); ctx.renderDetails(); });
  },
});

/** Opens the compare tool against the given files (used by Quick Convert's "Compare" for two rows). */
export async function compareWith(files: File[]) { ctx.setTool('compare'); await openOther(files); }

export function initCompare() {
  registerCommand({ id: 'compare', label: 'Compare with another model…', group: 'Inspect', keywords: 'diff revision version overlay wipe deviation', run: () => ctx.setTool('compare'), enabled: () => !!ctx.viewer.model });
  ctx.viewer.onChange(() => { if (other && !other.parent) other = null; });
  ctx.viewer.cleanHooks.add({ off: () => { if (dev) clearDeviation(); }, on: () => {} });
}

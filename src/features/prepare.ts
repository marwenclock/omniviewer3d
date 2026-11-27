import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ctx, escHtml, modelMeshes, targetMeshes } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { fmtNum, UNITS } from '../stats';
import { icon } from '../icons';

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem('omniview.' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('omniview.' + k, v); } catch { /* private mode */ } },
};
/** millimetres → the model's file units */
const mm = (v: number) => v / (UNITS[ctx.unit()].toMeters * 1000);
const toMm = (v: number) => v * UNITS[ctx.unit()].toMeters * 1000;

// ------------------------------------------------------------------ printer bed (OV-105)
const BEDS: { id: string; name: string; x: number; y: number; z: number }[] = [
  { id: 'bambu-a1mini', name: 'Bambu Lab A1 mini', x: 180, y: 180, z: 180 },
  { id: 'bambu-256', name: 'Bambu Lab A1 / P1 / X1', x: 256, y: 256, z: 256 },
  { id: 'prusa-mk4', name: 'Prusa MK4', x: 250, y: 210, z: 220 },
  { id: 'prusa-mini', name: 'Prusa MINI+', x: 180, y: 180, z: 180 },
  { id: 'prusa-xl', name: 'Prusa XL', x: 360, y: 360, z: 360 },
  { id: 'ender3', name: 'Creality Ender-3', x: 220, y: 220, z: 250 },
  { id: 'k1', name: 'Creality K1', x: 220, y: 220, z: 250 },
  { id: 'saturn', name: 'Resin, ~10" (e.g. Saturn class)', x: 218, y: 123, z: 220 },
  { id: 'custom', name: 'Custom size', x: 200, y: 200, z: 200 },
];
let bed: THREE.Group | null = null;
const bedState = () => {
  const id = store.get('bed', 'bambu-256');
  const b = BEDS.find((x) => x.id === id) ?? BEDS[1];
  if (id === 'custom') { try { return { ...b, ...JSON.parse(store.get('bedCustom', '{}')) }; } catch { return b; } }
  return b;
};
function clearBed() { bed?.traverse((o: any) => o.geometry?.dispose?.()); bed?.removeFromParent(); bed = null; ctx.viewer.requestRender(); }
/** Fit check: the footprint may be turned 90° on the bed; height must fit. */
function fitInfo() {
  const b = bedState();
  const box = ctx.viewer.bounds();
  const s = box.getSize(new THREE.Vector3());
  const w = toMm(s.x), d = toMm(s.z), h = toMm(s.y);
  const fitsXY = (w <= b.x && d <= b.y) || (w <= b.y && d <= b.x);
  const fits = fitsXY && h <= b.z;
  const k = Math.min(b.x / Math.max(w, 1e-9), b.y / Math.max(d, 1e-9), b.z / Math.max(h, 1e-9), Math.max(b.x, b.y) / Math.max(w, d, 1e-9));
  return { b, w, d, h, fits, fitsXY, scale: Math.min(1, k * 0.98) };
}
function drawBed() {
  clearBed();
  const v = ctx.viewer;
  if (!v.model) return;
  const { b, fits } = fitInfo();
  const box = v.bounds(), c = box.getCenter(new THREE.Vector3());
  bed = new THREE.Group();
  bed.userData.helper = true; bed.userData.noShot = true;
  const color = fits ? 0x7cc490 : 0xef7a70;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(mm(b.x), mm(b.y)).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
  const vol = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(mm(b.x), mm(b.z), mm(b.y))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
  vol.position.y = mm(b.z) / 2;
  for (const o of [plate, vol]) { o.userData.helper = true; (o as any).raycast = () => {}; bed.add(o); }
  bed.position.set(c.x, box.min.y - 1e-4, c.z);
  v.overlay.add(bed);
  v.requestRender();
}
registerPanel({
  id: 'bed', label: 'Printer bed', icon: 'bed',
  hint: 'Green box = fits your printer, red = too big. Nothing is scaled unless you confirm.',
  onActivate: () => drawBed(),
  onDeactivate: clearBed,
  render() {
    if (ctx.unit() === 'u') return '<p class="note" style="margin:0">Set real file units (Details → File units) to compare with a printer.</p>';
    const f = fitInfo();
    const id = store.get('bed', 'bambu-256');
    return `<div class="row" style="margin-top:0"><label for="bedSel">Printer</label><select id="bedSel" data-bed>${BEDS.map((b) => `<option value="${b.id}" ${b.id === id ? 'selected' : ''}>${b.name}${b.id !== 'custom' ? ` · ${b.x}×${b.y}×${b.z}` : ''}</option>`).join('')}</select></div>
      ${id === 'custom' ? `<div class="row"><label>Size mm</label><div class="xyz">${(['x', 'y', 'z'] as const).map((k) => `<input type="number" min="10" step="1" value="${f.b[k]}" data-bedc="${k}" aria-label="Bed ${k}"/>`).join('')}</div></div>` : ''}
      <div class="verdict ${f.fits ? 'ok' : 'warn'}" role="status">${f.fits ? '✓ Fits this printer' : f.fitsXY ? '⚠ Too tall for this printer' : '⚠ Too big for the bed'}</div>
      <dl class="kv"><dt>Model</dt><dd>${fmtNum(f.w, 1)} × ${fmtNum(f.d, 1)} × ${fmtNum(f.h, 1)} mm</dd><dt>Build volume</dt><dd>${f.b.x} × ${f.b.y} × ${f.b.z} mm</dd></dl>
      ${!f.fits ? `<div class="btn-row"><button class="chip" data-bedfit>Scale to fit (×${fmtNum(f.scale, 3)})…</button><button class="chip" data-tool="layflat">Lay flat</button></div>` : ''}
      <p class="note">Width and depth may be turned 90° on the bed. This is a size check only, not slicing: supports, brims and skirts need some extra room.</p>`;
  },
  bind(host) {
    host.querySelector('[data-bed]')?.addEventListener('change', (e) => { store.set('bed', (e.target as HTMLSelectElement).value); drawBed(); ctx.renderDetails(); });
    host.querySelectorAll<HTMLInputElement>('[data-bedc]').forEach((inp) => inp.addEventListener('change', () => {
      const b = bedState(); (b as any)[inp.dataset.bedc!] = Math.max(10, Number(inp.value) || 10);
      store.set('bedCustom', JSON.stringify({ x: b.x, y: b.y, z: b.z })); drawBed(); ctx.renderDetails();
    }));
    host.querySelector('[data-bedfit]')?.addEventListener('click', () => {
      const f = fitInfo();
      ctx.openModal(`<h2 id="dlgTitle">Scale to fit?</h2><p>This scales the whole model by ×${fmtNum(f.scale, 3)} so it fits the ${escHtml(f.b.name)} (${fmtNum(f.w * f.scale, 1)} × ${fmtNum(f.d * f.scale, 1)} × ${fmtNum(f.h * f.scale, 1)} mm). The real size changes. You can undo it.</p>
        <div class="modal-actions"><button class="btn-outline" data-modal-close>Cancel</button><button class="btn-solid" id="bedFitGo">Scale ×${fmtNum(f.scale, 3)}</button></div>`);
      document.getElementById('bedFitGo')!.onclick = () => { ctx.closeModal(); ctx.editor.scaleBy(f.scale, f.scale, f.scale, ctx.viewer.model!); ctx.viewer.fit(); drawBed(); ctx.renderDetails(); };
    });
  },
});

// ------------------------------------------------------------------ overhang map
let overhangAngle = Number(store.get('overhang', '45'));
let heat: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }[] = [];
let overhangShare = -1;
function clearHeat() { for (const h of heat) { h.mesh.geometry.dispose(); h.mesh.geometry = h.geometry; h.mesh.material = h.material; } heat = []; overhangShare = -1; ctx.viewer.requestRender(); }
/** Faces that point downward more steeply than the angle (from vertical) need support; the floor contact doesn't. */
function overhangCheck() {
  clearHeat();
  const v = ctx.viewer;
  const box = v.bounds();
  const floor = box.min.y + (box.max.y - box.min.y) * 0.002;
  const limit = Math.cos(THREE.MathUtils.degToRad(90 - overhangAngle)); // dot(n, down) above this = overhang
  let bad = 0, total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const mesh of targetMeshes()) {
    const src = mesh.geometry;
    const g = (src.index ? src.toNonIndexed() : src.clone());
    g.deleteAttribute('color');
    mesh.updateMatrixWorld(true);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const area = n.length() / 2;
      n.normalize();
      if (mesh.matrixWorld.determinant() < 0) n.negate();
      total += area;
      const onFloor = Math.max(a.y, b.y, c.y) <= floor;
      const down = -n.y;
      const over = !onFloor && down > limit;
      if (over) bad += area;
      const col = over ? [0.86, 0.32, 0.22] : onFloor ? [0.45, 0.66, 0.85] : [0.72, 0.74, 0.76];
      for (let k = 0; k < 3; k++) colors.set(col, (i + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    heat.push({ mesh, geometry: src, material: mesh.material });
    mesh.geometry = g;
    mesh.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  overhangShare = total ? bad / total : 0;
  v.requestRender();
  ctx.renderDetails();
}
registerPanel({
  id: 'overhang', label: 'Overhangs', icon: 'overhang',
  hint: 'Red = overhangs that will likely need support, blue = resting on the bed',
  onDeactivate: clearHeat,
  render() {
    return `<div class="row" style="margin-top:0"><label for="ohAngle">Angle</label><input type="range" id="ohAngle" min="20" max="80" step="5" value="${overhangAngle}" data-oh aria-label="Overhang angle from vertical"/><span class="cost-val" data-ohl>${overhangAngle}°</span></div>
      ${overhangShare >= 0 ? `<div class="verdict ${overhangShare < 0.01 ? 'ok' : 'warn'}" role="status">${overhangShare < 0.01 ? '✓ Little or no overhang at this angle' : `${fmtNum(overhangShare * 100, 1)}% of the surface overhangs more than ${overhangAngle}°`}</div>
        <p class="note"><span class="sw sw-red"></span>overhang <span class="sw sw-blue"></span>on the bed <span class="sw sw-grey"></span>fine</p>` : ''}
      <div class="btn-row"><button class="btn-solid" data-ohgo>${overhangShare >= 0 ? 'Check again' : 'Show overhangs'}</button>${overhangShare >= 0 ? '<button class="chip" data-ohclear>Clear colours</button>' : ''}<button class="chip" data-tool="layflat">Try another face down</button></div>
      <p class="note">Uses the current orientation: the floor of the view is the build plate. 45° is a common limit for FDM printing without supports. Bridges between two supports may print fine even when shown red.</p>`;
  },
  pill() {
    return `<input type="range" min="20" max="80" step="5" value="${overhangAngle}" data-oh aria-label="Overhang angle from vertical"/><span class="tp-val" data-ohl>${overhangAngle}°</span>
      <button class="tp-go" data-ohgo>${overhangShare >= 0 ? 'Check again' : 'Show'}</button>`;
  },
  bind(host) {
    host.querySelector('[data-oh]')?.addEventListener('input', (e) => { overhangAngle = Number((e.target as HTMLInputElement).value); host.querySelector('[data-ohl]')!.textContent = overhangAngle + '°'; store.set('overhang', String(overhangAngle)); });
    host.querySelector('[data-ohgo]')?.addEventListener('click', () => { ctx.setLoading('Finding overhangs…'); setTimeout(() => { try { overhangCheck(); } finally { ctx.setLoading(null); } }, 30); });
    host.querySelector('[data-ohclear]')?.addEventListener('click', () => { clearHeat(); ctx.renderDetails(); });
  },
});

// ------------------------------------------------------------------ clash check
let clearance = 0; // mm
let clashes: { a: THREE.Mesh; b: THREE.Mesh; d: number }[] | null = null;
function clashCheck() {
  const meshes = modelMeshes(ctx.viewer.model, true).slice(0, 400);
  const out: { a: THREE.Mesh; b: THREE.Mesh; d: number }[] = [];
  const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
  const gap = mm(clearance);
  const bvhs = new Map<THREE.Mesh, MeshBVH>();
  const bvhOf = (m: THREE.Mesh) => { let b = bvhs.get(m); if (!b) { b = new MeshBVH(m.geometry); bvhs.set(m, b); } return b; };
  for (let i = 0; i < meshes.length; i++) for (let j = i + 1; j < meshes.length; j++) {
    if (!boxes[i].clone().expandByScalar(gap).intersectsBox(boxes[j])) continue;
    const A = meshes[i], B = meshes[j];
    const rel = A.matrixWorld.clone().invert().multiply(B.matrixWorld);
    if (bvhOf(A).intersectsGeometry(B.geometry, rel)) { out.push({ a: A, b: B, d: 0 }); continue; }
    if (gap > 0) {
      const t1: any = {}, t2: any = {};
      const res = bvhOf(A).closestPointToGeometry(B.geometry, rel, t1, t2, 0, gap / Math.max(1e-12, A.matrixWorld.getMaxScaleOnAxis()));
      if (res && t1.distance !== undefined && t1.distance <= gap) out.push({ a: A, b: B, d: t1.distance * A.matrixWorld.getMaxScaleOnAxis() });
    }
  }
  clashes = out;
  ctx.renderDetails();
}
registerPanel({
  id: 'clash', label: 'Clash check', icon: 'clash',
  hint: 'Finds parts that overlap, or come closer than a clearance you choose',
  onDeactivate: () => { clashes = null; },
  render() {
    const meshes = modelMeshes(ctx.viewer.model, true).length;
    return `<p class="note" style="margin-top:0">Checks every pair of visible parts (${meshes > 400 ? 'the first 400 of ' : ''}${meshes}).</p>
      <div class="row"><label for="clashGap">Clearance</label><input type="number" id="clashGap" min="0" step="0.1" value="${clearance}" data-clashgap aria-label="Minimum clearance in millimetres"/><span class="cost-unit">mm</span></div>
      <div class="btn-row"><button class="btn-solid" data-clashgo>Check</button></div>
      ${clashes ? (clashes.length ? `<div class="verdict warn" role="status">⚠ ${clashes.length} pair${clashes.length === 1 ? '' : 's'} ${clearance > 0 ? 'overlap or are too close' : 'overlap'}</div>
        <ul class="clash-list">${clashes.slice(0, 200).map((c, i) => `<li><button class="link-btn" data-clashshow="${i}">${escHtml(c.a.name || 'Part')} ↔ ${escHtml(c.b.name || 'Part')}</button> <span class="muted">${c.d === 0 ? 'overlap' : `${fmtNum(toMm(c.d), 3)} mm apart`}</span></li>`).join('')}</ul>`
        : `<div class="verdict ok" role="status">✓ No overlaps${clearance > 0 ? ` and no gaps under ${clearance} mm` : ''}</div>`) : ''}
      <p class="note">Works on the displayed triangles. Parts that are meant to touch (threads, press fits) show up too.</p>`;
  },
  bind(host) {
    host.querySelector('[data-clashgap]')?.addEventListener('change', (e) => { clearance = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); });
    host.querySelector('[data-clashgo]')?.addEventListener('click', () => { ctx.setLoading('Checking for clashes…'); setTimeout(() => { try { clashCheck(); } catch (e: any) { ctx.toast('Clash check failed: ' + (e?.message || e), true); } finally { ctx.setLoading(null); } }, 30); });
    host.querySelectorAll<HTMLElement>('[data-clashshow]').forEach((b) => b.addEventListener('click', () => {
      const c = clashes![Number(b.dataset.clashshow)];
      ctx.editor.select(c.a); ctx.editor.multi.add(c.b);
      const g = new THREE.Box3().setFromObject(c.a).union(new THREE.Box3().setFromObject(c.b));
      const tmp = new THREE.Object3D(); void g; void tmp;
      ctx.viewer.fit(c.a);
      ctx.renderDetails();
    }));
  },
});

// ------------------------------------------------------------------ G-code inspection (OV-113)
let gLayer = -1;
let gTravel = false;
function gcodeLayers() {
  const lines: THREE.Object3D[] = [];
  ctx.viewer.model?.traverse((o: any) => { if (o.isLine && /^layer\d+$/.test(o.name)) lines.push(o); });
  return lines;
}
function applyGcode() {
  const lines = gcodeLayers();
  const max = lines.reduce((n, o) => Math.max(n, Number(o.name.slice(5))), 0);
  const upto = gLayer < 0 ? max : gLayer;
  for (const o of lines) {
    const i = Number(o.name.slice(5));
    const travel = ((o as any).material?.name || '') === 'path';
    o.visible = i <= upto && (!travel || gTravel);
    const m = (o as any).material;
    if (m && !travel) { m.color?.set(i === upto ? 0xffc04d : 0x4da3ff); }
  }
  ctx.viewer.requestRender();
}
registerPanel({
  id: 'gcode', label: 'G-code layers', icon: 'layers',
  hint: 'Step through the print layer by layer',
  onActivate: () => applyGcode(),
  render() {
    const lines = gcodeLayers();
    if (!lines.length) return '<p class="note" style="margin:0">This panel is for G-code toolpaths.</p>';
    const max = lines.reduce((n, o) => Math.max(n, Number(o.name.slice(5))), 0);
    const cur = gLayer < 0 ? max : gLayer;
    let ext = 0;
    for (const o of lines) {
      if (((o as any).material?.name || '') === 'path') continue;
      const p = (o as any).geometry.attributes.position;
      for (let i = 0; i + 1 < p.count; i += 2) ext += Math.hypot(p.getX(i + 1) - p.getX(i), p.getY(i + 1) - p.getY(i), p.getZ(i + 1) - p.getZ(i));
    }
    return `<div class="row" style="margin-top:0"><label for="gLayer">Layer</label><input type="range" id="gLayer" min="0" max="${max}" step="1" value="${cur}" data-glayer aria-label="Layer"/><span class="cost-val" data-glabel>${cur + 1} / ${max + 1}</span></div>
      <label class="check"><input type="checkbox" data-gtravel ${gTravel ? 'checked' : ''}/> Show travel moves</label>
      <dl class="kv"><dt>Layers</dt><dd>${max + 1}</dd><dt>Extrusion path</dt><dd>${fmtNum(ext / 1000, 2)} m</dd></dl>
      <p class="note">Blue = printed lines, orange = the current layer. G-code is a printer toolpath made of lines, not a solid, so volume, repair and mesh export don't apply. Firmware-specific commands (arcs, macros) may not be drawn.</p>`;
  },
  pill() {
    const lines = gcodeLayers();
    if (!lines.length) return '';
    const max = lines.reduce((n, o) => Math.max(n, Number(o.name.slice(5))), 0);
    const cur = gLayer < 0 ? max : gLayer;
    return `<input type="range" min="0" max="${max}" step="1" value="${cur}" data-glayer aria-label="Layer"/><span class="tp-val" data-glabel>${cur + 1} / ${max + 1}</span>`;
  },
  bind(host) {
    host.querySelector('[data-glayer]')?.addEventListener('input', (e) => { gLayer = Number((e.target as HTMLInputElement).value); host.querySelector('[data-glabel]')!.textContent = `${gLayer + 1} / ${(e.target as HTMLInputElement).max ? Number((e.target as HTMLInputElement).max) + 1 : ''}`; applyGcode(); });
    host.querySelector('[data-gtravel]')?.addEventListener('change', (e) => { gTravel = (e.target as HTMLInputElement).checked; applyGcode(); });
  },
});

export function initPrepare() {
  const has = () => !!ctx.viewer.model;
  const mesh = () => !!ctx.caps()?.meshTools;
  registerCommand(
    { id: 'bed', label: 'Printer bed: does it fit?', group: 'Prepare', keywords: 'build volume size printer bambu prusa ender', run: () => ctx.setTool('bed'), enabled: has },
    { id: 'overhang', label: 'Overhang map', group: 'Prepare', keywords: 'support angle 45 print orientation', run: () => ctx.setTool('overhang'), enabled: mesh },
    { id: 'clash', label: 'Clash check (overlapping parts)', group: 'Inspect', keywords: 'interference collision clearance assembly', run: () => ctx.setTool('clash'), enabled: mesh },
    { id: 'gcode', label: 'G-code layers', group: 'Inspect', keywords: 'toolpath layer slider travel', run: () => ctx.setTool('gcode'), enabled: () => !!ctx.caps()?.isToolpath },
  );
  ctx.viewer.cleanHooks.add({ off: () => { if (heat.length) clearHeat(); }, on: () => {} });
  void icon;
}

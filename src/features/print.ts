import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ctx, targetMeshes, modelMeshes, escHtml } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { analyse, weld, orient, fillHoles, removeSmallParts, toGeometry, replaceGeometries, lostAttributes, type Analysis } from './geom';
import { fmtInt, fmtNum, UNITS } from '../stats';

// ------------------------------------------------------------------ shared overlay for open edges
let openEdgeLines: THREE.Group | null = null;
function clearOpenEdges() {
  if (!openEdgeLines) return;
  openEdgeLines.removeFromParent();
  openEdgeLines.traverse((o: any) => o.geometry?.dispose?.());
  openEdgeLines = null;
}
function showOpenEdges(items: { mesh: THREE.Mesh; a: Analysis }[]) {
  clearOpenEdges();
  openEdgeLines = new THREE.Group();
  openEdgeLines.userData.helper = true;
  for (const { mesh, a } of items) {
    if (!a.openSegments.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.openSegments, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false, transparent: true }));
    lines.renderOrder = 996;
    lines.matrixAutoUpdate = false;
    mesh.updateWorldMatrix(true, false);
    lines.matrix.copy(mesh.matrixWorld);
    lines.userData.helper = true;
    lines.raycast = () => {};
    openEdgeLines.add(lines);
  }
  ctx.viewer.overlay.add(openEdgeLines);
}

/** "Applies to" line shown on every tool that changes geometry (OV-041). */
export function appliesTo(): string {
  const sel = ctx.editor.selected;
  const n = targetMeshes().length;
  return `<p class="applies">Applies to: <b>${sel && sel !== ctx.viewer.model ? escHtml(sel.name || 'the selected part') : 'all visible parts'}</b> · ${n} mesh${n === 1 ? '' : 'es'}</p>`;
}
function lossNote(): string {
  const lost = lostAttributes(targetMeshes());
  return lost.length ? `<p class="note warn-note">This rebuilds the mesh, so these are not kept: ${lost.join(', ')}. Undo restores them.</p>` : '';
}

// ------------------------------------------------------------------ repair & check
let report: { mesh: THREE.Mesh; a: Analysis }[] = [];
let analysing = false;

async function runAnalysis() {
  analysing = true;
  ctx.renderDetails();
  await new Promise((r) => setTimeout(r, 30));
  report = targetMeshes().map((mesh) => ({ mesh, a: analyse(mesh) }));
  analysing = false;
  showOpenEdges(report);
  ctx.renderDetails();
}

function sum<K extends keyof Analysis>(k: K): number { return report.reduce((n, r) => n + (r.a[k] as number), 0); }

function repairMeshes(opts: { orient: boolean; holes: boolean; small: boolean }) {
  const changes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
  let holes = 0, parts = 0;
  for (const mesh of targetMeshes()) {
    let w = weld(mesh);
    if (opts.small) { const r = removeSmallParts(w, 0.02); w = r.welded; parts += r.removed; }
    if (opts.holes) { const r = fillHoles(w); w = r.welded; holes += r.filled; }
    if (opts.orient) w = orient(w);
    changes.push({ mesh, geometry: toGeometry(w) });
  }
  replaceGeometries(changes, 'Repair mesh');
  runAnalysis().then(() => {
    const left = sum('openEdges') + sum('nonManifoldEdges') + sum('inconsistentFaces');
    ctx.toast(`Repaired ${changes.length} part${changes.length === 1 ? '' : 's'}${holes ? ` · ${holes} hole${holes === 1 ? '' : 's'} filled` : ''}${parts ? ` · ${parts} loose piece${parts === 1 ? '' : 's'} removed` : ''}${left ? ` · ${left} problem edge${left === 1 ? '' : 's'} remain` : ' · checks pass'}`, left > 0);
  });
}

registerPanel({
  id: 'repair', label: 'Repair & check', icon: 'repair',
  hint: 'Red lines show open edges (holes) · repair fixes holes, flipped faces and loose pieces',
  onActivate: () => { runAnalysis(); },
  onDeactivate: () => { clearOpenEdges(); report = []; },
  render() {
    if (analysing) return '<p class="note" style="margin:0">Checking the mesh…</p>';
    if (!report.length) return '<p class="note" style="margin:0">Nothing to check.</p>';
    const open = sum('openEdges'), nm = sum('nonManifoldEdges'), parts = sum('parts'), deg = sum('degenerate'), inc = sum('inconsistentFaces');
    const inside = report.some((r) => r.a.insideOut);
    // Degenerate triangles count too; and passing the mesh checks is not a printability promise (OV-021).
    const ok = open === 0 && nm === 0 && inc === 0 && !inside && deg === 0;
    const row = (label: string, v: string, bad: boolean) => `<dt>${label}</dt><dd class="${bad ? 'bad' : 'good'}">${v}</dd>`;
    return `<div class="verdict ${ok ? 'ok' : 'warn'}" role="status">${ok ? '✓ Mesh checks passed' : '⚠ The mesh has problems to fix'}</div>
      <p class="note" style="margin:6px 0 10px">Checked ${report.length === 1 ? escHtml(report[0].mesh.name || 'the selected part') : `${report.length} parts`}${ctx.editor.selected ? ' (selection)' : ''}: closed edges, manifold edges, face orientation and degenerate triangles. ${ok ? 'Wall thickness, overhangs, intersections between parts and printer settings are not part of this check.' : ''}</p>
      <dl class="kv">
        ${row('Holes (open edges)', fmtInt(open), open > 0)}
        ${row('Non-manifold edges', fmtInt(nm), nm > 0)}
        ${row('Flipped faces', fmtInt(inc), inc > 0)}
        ${row('Inside-out', inside ? 'yes' : 'no', inside)}
        ${row('Separate pieces', fmtInt(parts), false)}
        ${row('Degenerate triangles', fmtInt(deg), deg > 0)}
      </dl>
      ${appliesTo()}${lossNote()}
      <label class="check"><input type="checkbox" data-r="holes" checked/> Fill holes</label>
      <label class="check"><input type="checkbox" data-r="orient" checked/> Fix flipped / inside-out faces</label>
      <label class="check"><input type="checkbox" data-r="small"/> Remove tiny loose pieces</label>
      <div class="btn-row"><button class="btn-solid" data-repair>Repair</button><button class="chip" data-recheck>Check again</button></div>
      <p class="note">Repair merges duplicate vertices and removes degenerate triangles. Holes are closed with simple flat patches, which suit small gaps; large or curved openings may need a modelling program. The check runs again afterwards. Undo with Ctrl+Z.</p>`;
  },
  bind(host) {
    host.querySelector('[data-recheck]')?.addEventListener('click', () => runAnalysis());
    host.querySelector('[data-repair]')?.addEventListener('click', () => {
      const v = (k: string) => (host.querySelector(`[data-r="${k}"]`) as HTMLInputElement)?.checked;
      ctx.setLoading('Repairing…');
      setTimeout(() => { try { repairMeshes({ holes: v('holes'), orient: v('orient'), small: v('small') }); } finally { ctx.setLoading(null); } }, 30);
    });
  },
});

// ------------------------------------------------------------------ reduce polygons
let reduceTarget = 0.5;
let textureMax = 0; // 0 = keep textures as they are
const PRESETS: { id: string; label: string; ratio: number; tex: number; note: string }[] = [
  { id: 'web', label: 'Web / AR light', ratio: 0.25, tex: 1024, note: '25% of triangles, textures up to 1024 px' },
  { id: 'mobile', label: 'Phone friendly', ratio: 0.5, tex: 2048, note: '50% of triangles, textures up to 2048 px' },
  { id: 'print', label: 'Printing (shape first)', ratio: 0.7, tex: 0, note: '70% of triangles, textures untouched' },
];
/** Downscales textures above a size, as one undoable step (OV-107). */
function resizeTextures(max: number): number {
  if (!max) return 0;
  const done = new Map<THREE.Texture, { before: any; after: any }>();
  for (const mesh of targetMeshes()) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as any[]) for (const k of Object.keys(m)) {
      const t: THREE.Texture = m[k];
      if (!t?.isTexture || done.has(t)) continue;
      const img: any = t.image; const w = img?.width, h = img?.height;
      if (!w || !h || Math.max(w, h) <= max || typeof document === 'undefined') continue;
      const k2 = max / Math.max(w, h);
      const c = document.createElement('canvas'); c.width = Math.round(w * k2); c.height = Math.round(h * k2);
      try { c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); } catch { continue; }
      done.set(t, { before: img, after: c });
    }
  }
  if (!done.size) return 0;
  const apply = (which: 'before' | 'after') => { for (const [t, v] of done) { t.image = v[which]; t.needsUpdate = true; } ctx.viewer.requestRender(); };
  ctx.history.run({ label: `Resize ${done.size} texture${done.size === 1 ? '' : 's'}`, redo: () => apply('after'), undo: () => apply('before') });
  return done.size;
}
const approxBytes = () => targetMeshes().reduce((n, m) => n + Object.values(m.geometry.attributes).reduce((a, at: any) => a + at.array.byteLength, 0) + (m.geometry.index?.array.byteLength || 0), 0);

async function reduce(ratio: number) {
  const { MeshoptSimplifier } = await import('three/addons/libs/meshopt_simplifier.module.js');
  await MeshoptSimplifier.ready;
  const changes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
  let before = 0, after = 0;
  for (const mesh of targetMeshes()) {
    const w = weld(mesh);
    const target = Math.max(3, Math.floor((w.idx.length * ratio) / 3) * 3);
    const [idx] = MeshoptSimplifier.simplify(w.idx, w.pos, 3, target, 0.08, []);
    before += w.idx.length / 3;
    after += idx.length / 3;
    changes.push({ mesh, geometry: toGeometry({ ...w, idx }) });
  }
  const b0 = approxBytes();
  ctx.history.batch('Reduce & optimise', () => {
    replaceGeometries(changes, 'Reduce polygons');
    const tex = resizeTextures(textureMax);
    ctx.toast(`Triangles: ${fmtInt(before)} → ${fmtInt(after)} (${Math.round((1 - after / Math.max(1, before)) * 100)}% fewer) · geometry ≈${(b0 / 1048576).toFixed(1)} → ${(approxBytes() / 1048576).toFixed(1)} MB${tex ? ` · ${tex} texture${tex === 1 ? '' : 's'} resized` : ''}. Undo with Ctrl+Z, or compare with the original using Compare.`);
  });
}

registerPanel({
  id: 'reduce', label: 'Reduce polygons', icon: 'reduce',
  hint: 'Lower the triangle count to shrink files and speed up web / game use',
  render() {
    const tris = targetMeshes().reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    return `${appliesTo()}<p class="note" style="margin-top:0">Currently ${fmtInt(Math.round(tris))} triangles, geometry ≈${(approxBytes() / 1048576).toFixed(1)} MB.</p>
      <div class="field-label">Presets</div>
      <div class="btn-row">${PRESETS.map((p) => `<button class="chip" data-preset="${p.id}" title="${p.note}">${p.label}</button>`).join('')}</div>
      <div class="row"><label>Keep</label><input type="range" min="0.02" max="0.95" step="0.01" value="${reduceTarget}" data-ratio aria-label="Share of triangles to keep"/><span class="cost-val" data-ratiolabel>${Math.round(reduceTarget * 100)}%</span></div>
      <div class="row"><label>Textures</label><select data-texmax><option value="0" ${!textureMax ? 'selected' : ''}>Keep size</option>${[4096, 2048, 1024, 512].map((x) => `<option value="${x}" ${textureMax === x ? 'selected' : ''}>Max ${x} px</option>`).join('')}</select></div>
      <p class="note">Target: about <b data-tricount>${fmtInt(Math.round(tris * reduceTarget))}</b> triangles. Shape-preserving simplification (meshoptimizer).</p>${lossNote()}
      <div class="btn-row"><button class="btn-solid" data-reduce>Reduce</button></div>`;
  },
  pill() {
    const tris = targetMeshes().reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    return `<input type="range" min="0.02" max="0.95" step="0.01" value="${reduceTarget}" data-ratio aria-label="Share of triangles to keep"/><span class="tp-val"><span data-ratiolabel>${Math.round(reduceTarget * 100)}%</span> · <span data-tricount>${fmtInt(Math.round(tris * reduceTarget))}</span></span>
      <button class="tp-go" data-reduce>Reduce</button>`;
  },
  bind(host) {
    const tris = targetMeshes().reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    host.querySelector('[data-ratio]')?.addEventListener('input', (e) => {
      reduceTarget = Number((e.target as HTMLInputElement).value);
      host.querySelector('[data-ratiolabel]')!.textContent = Math.round(reduceTarget * 100) + '%';
      host.querySelector('[data-tricount]')!.textContent = fmtInt(Math.round(tris * reduceTarget));
    });
    host.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => b.addEventListener('click', () => { const p = PRESETS.find((x) => x.id === b.dataset.preset)!; reduceTarget = p.ratio; textureMax = p.tex; ctx.renderDetails(); }));
    host.querySelector('[data-texmax]')?.addEventListener('change', (e) => { textureMax = Number((e.target as HTMLSelectElement).value); });
    host.querySelector('[data-reduce]')?.addEventListener('click', async () => {
      ctx.setLoading('Reducing polygons…');
      try { await reduce(reduceTarget); } catch (e: any) { ctx.toast('Could not reduce: ' + (e?.message || e), true); } finally { ctx.setLoading(null); }
    });
  },
});

// ------------------------------------------------------------------ hollow
let hollowWallMm = 2;
/** millimetres → current model units */
const mmToUnits = (mm: number) => mm / (UNITS[ctx.unit()].toMeters * 1000);
const unitsToMm = (v: number) => v * UNITS[ctx.unit()].toMeters * 1000;
const round = (v: number) => Number(v.toPrecision(3));
function hollow(thickness: number) {
  const changes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
  for (const mesh of targetMeshes()) {
    const w = orient(weld(mesh));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(w.pos, 3));
    g.setIndex(new THREE.BufferAttribute(w.idx, 1));
    g.computeVertexNormals();
    const nrm = g.attributes.normal;
    mesh.updateWorldMatrix(true, false);
    const t = thickness / (mesh.matrixWorld.getMaxScaleOnAxis() || 1);
    const n = w.pos.length / 3;
    const pos = new Float32Array(n * 6);
    pos.set(w.pos);
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) pos[n * 3 + v * 3 + k] = w.pos[v * 3 + k] - nrm.getComponent(v, k) * t;
    const idx = new Uint32Array(w.idx.length * 2);
    idx.set(w.idx);
    // Inner shell: same triangles, reversed so they face into the cavity.
    for (let i = 0; i < w.idx.length; i += 3) {
      idx[w.idx.length + i] = w.idx[i] + n; idx[w.idx.length + i + 1] = w.idx[i + 2] + n; idx[w.idx.length + i + 2] = w.idx[i + 1] + n;
    }
    const colors = w.colors ? new Float32Array([...w.colors, ...w.colors]) : null;
    changes.push({ mesh, geometry: toGeometry({ pos, idx, colors }) });
  }
  replaceGeometries(changes, 'Hollow');
  // The inner surface is a simple offset: check whether it folds through the outer one (OV-023).
  let bad = 0;
  for (const c of changes) {
    const g = c.geometry, idx = g.index!, half = idx.count / 2;
    const outer = new THREE.BufferGeometry(); outer.setAttribute('position', g.attributes.position); outer.setIndex(new THREE.BufferAttribute((idx.array as Uint32Array).slice(0, half), 1));
    const inner = new THREE.BufferGeometry(); inner.setAttribute('position', g.attributes.position); inner.setIndex(new THREE.BufferAttribute((idx.array as Uint32Array).slice(half), 1));
    try { if (new MeshBVH(outer).intersectsGeometry(inner, new THREE.Matrix4())) bad++; } catch { /* skip */ }
  }
  ctx.toast(bad
    ? `Hollowed, but the inner wall crosses the outer surface in ${bad} part${bad === 1 ? '' : 's'} (thin or sharp areas). Use a thinner wall, or undo.`
    : 'Hollowed. Check the cut-away view, and add a drain hole for resin prints.', bad > 0);
}

/** Drain / escape hole for resin prints (CA-12): subtracts a cylinder at the lowest point, through the wall. */
async function addDrainHole(diameterMm: number) {
  const mesh = targetMeshes()[0];
  if (!mesh) return;
  const { Brush, Evaluator, SUBTRACTION } = await import('three-bvh-csg');
  const box = ctx.viewer.bounds(mesh);
  const c = box.getCenter(new THREE.Vector3());
  const r = mmToUnits(diameterMm) / 2;
  const len = (box.max.y - box.min.y) * 0.4 + r * 4;
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 32));
  cyl.position.set(c.x, box.min.y, c.z);
  cyl.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const inv = mesh.matrixWorld.clone().invert();
  const a = new Brush(mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()); a.updateMatrixWorld();
  const bGeo = cyl.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, cyl.matrixWorld));
  for (const k of Object.keys(bGeo.attributes)) if (!a.geometry.attributes[k] && k !== 'position' && k !== 'normal') bGeo.deleteAttribute(k);
  for (const k of Object.keys(a.geometry.attributes)) if (!bGeo.attributes[k]) a.geometry.deleteAttribute(k);
  const b = new Brush(bGeo); b.updateMatrixWorld();
  const out = new Evaluator().evaluate(a, b, SUBTRACTION);
  replaceGeometries([{ mesh, geometry: out.geometry }], `Drain hole ⌀${diameterMm} mm`);
  ctx.toast(`Added a ⌀${diameterMm} mm drain hole at the lowest point. Check it with the section plane.`);
}

registerPanel({
  id: 'hollow', label: 'Hollow', icon: 'hollow',
  hint: 'Make a closed model hollow with an approximate wall, e.g. to save resin',
  render() {
    const u = UNITS[ctx.unit()].short;
    return `${appliesTo()}<div class="row"><label>Wall</label><input type="number" step="0.1" min="0" value="${round(mmToUnits(hollowWallMm))}" data-wall aria-label="Wall thickness"/><span class="cost-unit">${u}</span></div>
      <p class="note">Approximate: the inner surface is the outer one moved inwards. It works best on closed, smooth models (run Repair first). Thin necks and sharp corners can fold; the result is checked and you are warned.</p>${lossNote()}
      <div class="btn-row"><button class="btn-solid" data-hollow>Hollow</button><button class="chip" data-showsection>Show cut-away</button></div>
      <div class="field-label" style="margin-top:12px">Drain hole (resin)</div>
      <div class="row"><label>Diameter</label><select data-drain>${[2, 3, 4, 5, 6].map((d) => `<option value="${d}" ${d === 3 ? 'selected' : ''}>${d} mm</option>`).join('')}</select><button class="chip" data-draingo>${'Add at lowest point'}</button></div>
      <p class="note">Resin trapped in a hollow part can crack it. Add at least one hole near the build plate, more for large parts.</p>`;
  },
  pill() {
    return `<label class="tp-field">Wall <input type="number" step="0.1" min="0" value="${round(mmToUnits(hollowWallMm))}" data-wall aria-label="Wall thickness"/> ${UNITS[ctx.unit()].short}</label>
      <button class="tp-go" data-hollow>Hollow</button>`;
  },
  bind(host) {
    host.querySelector('[data-wall]')?.addEventListener('change', (e) => { hollowWallMm = unitsToMm(Number((e.target as HTMLInputElement).value)) || hollowWallMm; });
    host.querySelector('[data-hollow]')?.addEventListener('click', () => {
      ctx.setLoading('Hollowing…');
      setTimeout(() => { try { hollow(mmToUnits(hollowWallMm)); } finally { ctx.setLoading(null); } }, 30);
    });
    host.querySelector('[data-showsection]')?.addEventListener('click', () => ctx.setTool('section'));
    host.querySelector('[data-draingo]')?.addEventListener('click', async () => {
      ctx.setLoading('Adding drain hole…');
      try { await addDrainHole(Number((host.querySelector('[data-drain]') as HTMLSelectElement).value)); } catch (e: any) { ctx.toast('Could not add the hole: ' + (e?.message || e), true); } finally { ctx.setLoading(null); }
    });
  },
});

// ------------------------------------------------------------------ wall thickness check
let minThicknessMm = 0.8;
let heat: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }[] = [];
let thinShare = -1;

function clearHeatmap() {
  for (const h of heat) { h.mesh.geometry.dispose(); h.mesh.geometry = h.geometry; h.mesh.material = h.material; }
  heat = [];
  thinShare = -1;
}

let unknownShare = 0;
function thicknessCheck(min: number) {
  clearHeatmap();
  let thinArea = 0, totalArea = 0, unknownArea = 0;
  let unknownCount = 0;
  const ray = new THREE.Ray();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const mesh of targetMeshes()) {
    const src = mesh.geometry;
    const g = (src.index ? src.toNonIndexed() : src.clone());
    g.deleteAttribute('color');
    if (!g.attributes.normal) g.computeVertexNormals();
    mesh.updateWorldMatrix(true, false);
    // Measure in world space so scaled parts give real thickness (OV-024); applyMatrix4 also transforms normals.
    g.applyMatrix4(mesh.matrixWorld);
    const minLocal = min;
    g.computeBoundingBox();
    const eps = (g.boundingBox!.getSize(new THREE.Vector3()).length() || 1) * 1e-4;
    const bvh = new MeshBVH(g);
    const pos = g.attributes.position, nrm = g.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    // Thickness at a vertex = distance to the opposite wall, cast straight inwards along the face normal from a point
    // just inside the triangle (exact corners make rays slide along the neighbouring faces).
    const thick = new Float32Array(pos.count);
    const fn = new THREE.Vector3(), cen = new THREE.Vector3(), p0 = new THREE.Vector3();
    void nrm;
    for (let v = 0; v < pos.count; v++) {
      const t0 = v - (v % 3);
      a.fromBufferAttribute(pos, t0); b.fromBufferAttribute(pos, t0 + 1); c.fromBufferAttribute(pos, t0 + 2);
      fn.subVectors(b, a).cross(c.clone().sub(a));
      if (fn.lengthSq() < 1e-30) { thick[v] = Infinity; colors.set([0.55, 0.55, 0.58], v * 3); continue; }
      const n = fn.normalize().clone().negate();
      cen.copy(a).add(b).add(c).divideScalar(3);
      p0.fromBufferAttribute(pos, v).lerp(cen, 0.2);
      ray.origin.copy(p0).addScaledVector(n, eps);
      ray.direction.copy(n);
      // Ignore grazing hits on the neighbouring faces at corners (distance ~0), take the nearest real wall.
      const hits = bvh.raycast(ray, THREE.DoubleSide);
      let best = Infinity;
      for (const h of hits) if (h.distance > eps && h.distance < best) best = h.distance;
      const hit = isFinite(best) ? { distance: best } : null;
      thick[v] = hit ? hit.distance : Infinity;
      if (!hit) { colors.set([0.55, 0.55, 0.58], v * 3); unknownCount++; continue; } // no opposite wall: Unknown, not "thick" (OV-024)
      // Colour-blind-friendly ramp: dark red (thin) → orange → light blue (thick enough), plus the legend text.
      const t = Math.min(1, Math.max(0, (thick[v] / minLocal - 0.5) / 1.5));
      col.setHSL(t < 0.5 ? 0.02 + t * 0.1 : 0.55, t < 0.5 ? 0.85 : 0.55, t < 0.5 ? 0.35 + t * 0.3 : 0.62);
      colors.set([col.r, col.g, col.b], v * 3);
    }
    for (let v = 0; v < pos.count; v += 3) {
      a.fromBufferAttribute(pos, v); b.fromBufferAttribute(pos, v + 1); c.fromBufferAttribute(pos, v + 2);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      totalArea += area;
      const avg = (thick[v] + thick[v + 1] + thick[v + 2]) / 3;
      if (!isFinite(avg)) unknownArea += area;
      else if (avg < minLocal) thinArea += area;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    heat.push({ mesh, geometry: src, material: mesh.material });
    g.applyMatrix4(mesh.matrixWorld.clone().invert()); // back to local space for display
    mesh.geometry = g;
    mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  thinShare = totalArea ? thinArea / totalArea : 0;
  unknownShare = totalArea ? unknownArea / totalArea : 0;
  void unknownCount;
  ctx.renderDetails();
}

registerPanel({
  id: 'thickness', label: 'Wall thickness', icon: 'thickness',
  hint: 'Red = thinner than your minimum wall, green = thick enough',
  onDeactivate: clearHeatmap,
  render() {
    const u = UNITS[ctx.unit()].short;
    return `<div class="row"><label>Minimum</label><input type="number" step="0.1" min="0" value="${round(mmToUnits(minThicknessMm))}" data-min/><span class="cost-unit">${u}</span></div>
      ${thinShare >= 0 ? `<div class="verdict ${thinShare < 0.005 && unknownShare < 0.005 ? 'ok' : 'warn'}" role="status">${thinShare < 0.005 ? (unknownShare < 0.005 ? '✓ No wall thinner than the minimum was found' : `No thin walls found in the measured areas; ${fmtNum(unknownShare * 100, 1)}% could not be measured`) : `⚠ ${fmtNum(thinShare * 100, 1)}% of the surface is thinner than ${round(mmToUnits(minThicknessMm))} ${u}`}</div>
        <div class="heat-legend thick-legend"><span>thin</span><i></i><span>thick enough</span></div>
        <p class="note"><span class="swatch-unknown"></span> Grey = unknown: no opposite wall was found (open surface or a ray that escaped). That is not the same as safe.</p>` : ''}
      <div class="btn-row"><button class="btn-solid" data-thick>${thinShare >= 0 ? 'Check again' : 'Check thickness'}</button>${thinShare >= 0 ? '<button class="chip" data-thickclear>Clear colours</button>' : ''}</div>
      <p class="note">Typical minimums: 0.8 mm for FDM, 0.5 mm for resin. Thickness is sampled straight inwards from each vertex in real-world size, so small features between vertices can be missed.</p>`;
  },
  pill() {
    return `<label class="tp-field">Min wall <input type="number" step="0.1" min="0" value="${round(mmToUnits(minThicknessMm))}" data-min aria-label="Minimum wall"/> ${UNITS[ctx.unit()].short}</label>
      <button class="tp-go" data-thick>${thinShare >= 0 ? 'Check again' : 'Check'}</button>`;
  },
  bind(host) {
    host.querySelector('[data-min]')?.addEventListener('change', (e) => { minThicknessMm = unitsToMm(Number((e.target as HTMLInputElement).value)) || minThicknessMm; });
    host.querySelector('[data-thick]')?.addEventListener('click', () => {
      ctx.setLoading('Measuring wall thickness…');
      setTimeout(() => { try { thicknessCheck(mmToUnits(minThicknessMm)); } catch (e: any) { ctx.toast('Thickness check failed: ' + (e?.message || e), true); } finally { ctx.setLoading(null); } }, 30);
    });
    host.querySelector('[data-thickclear]')?.addEventListener('click', () => { clearHeatmap(); ctx.renderDetails(); });
  },
});

// Hooks for workflow recipes (OV-109).
(window as any).__omniPanelActions = {
  repair: () => repairMeshes({ holes: true, orient: true, small: false }),
  reduce50: () => reduce(0.5),
};

export function initPrintTools() {
  const has = () => !!ctx.viewer.model && modelMeshes(ctx.viewer.model).length > 0;
  registerCommand(
    { id: 'repair', label: 'Repair & mesh check', group: 'Prepare', keywords: 'fix holes watertight manifold normals stl', run: () => ctx.setTool('repair'), enabled: has },
    { id: 'reduce', label: 'Reduce polygons (decimate)', group: 'Print', keywords: 'simplify optimize file size triangles', run: () => ctx.setTool('reduce'), enabled: has },
    { id: 'hollow', label: 'Hollow model', group: 'Print', keywords: 'shell resin save material', run: () => ctx.setTool('hollow'), enabled: has },
    { id: 'thickness', label: 'Wall thickness check', group: 'Print', keywords: 'thin walls heatmap', run: () => ctx.setTool('thickness'), enabled: has },
  );
}

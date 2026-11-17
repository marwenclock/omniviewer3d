import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ctx, targetMeshes, modelMeshes } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { analyse, weld, orient, fillHoles, removeSmallParts, toGeometry, replaceGeometries, type Analysis } from './geom';
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
  ctx.toast(`Repaired ${changes.length} part${changes.length === 1 ? '' : 's'}${holes ? ` · ${holes} hole${holes === 1 ? '' : 's'} filled` : ''}${parts ? ` · ${parts} loose piece${parts === 1 ? '' : 's'} removed` : ''}`);
  runAnalysis();
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
    const ok = open === 0 && nm === 0 && inc === 0 && !inside;
    const row = (label: string, v: string, bad: boolean) => `<dt>${label}</dt><dd class="${bad ? 'bad' : 'good'}">${v}</dd>`;
    return `<div class="verdict ${ok ? 'ok' : 'warn'}">${ok ? '✓ Ready to print: closed and consistent' : '⚠ Needs repair before printing'}</div>
      <p class="note" style="margin:6px 0 10px">Checking ${report.length === 1 ? (report[0].mesh.name || 'the selected part') : `${report.length} parts`}${ctx.editor.selected ? ' (selection)' : ''}.</p>
      <dl class="kv">
        ${row('Holes (open edges)', fmtInt(open), open > 0)}
        ${row('Non-manifold edges', fmtInt(nm), nm > 0)}
        ${row('Flipped faces', fmtInt(inc), inc > 0)}
        ${row('Inside-out', inside ? 'yes' : 'no', inside)}
        ${row('Separate pieces', fmtInt(parts), false)}
        ${row('Degenerate triangles', fmtInt(deg), deg > 0)}
      </dl>
      <label class="check"><input type="checkbox" data-r="holes" checked/> Fill holes</label>
      <label class="check"><input type="checkbox" data-r="orient" checked/> Fix flipped / inside-out faces</label>
      <label class="check"><input type="checkbox" data-r="small"/> Remove tiny loose pieces</label>
      <div class="btn-row"><button class="btn-solid" data-repair>Repair</button><button class="chip" data-recheck>Check again</button></div>
      <p class="note">Repair also merges duplicate vertices and removes degenerate triangles. Undo with Ctrl+Z.</p>`;
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
  replaceGeometries(changes, 'Reduce polygons');
  ctx.toast(`Triangles: ${fmtInt(before)} → ${fmtInt(after)} (${Math.round((1 - after / Math.max(1, before)) * 100)}% fewer)`);
}

registerPanel({
  id: 'reduce', label: 'Reduce polygons', icon: 'reduce',
  hint: 'Lower the triangle count to shrink files and speed up web / game use',
  render() {
    const tris = targetMeshes().reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    return `<p class="note" style="margin-top:0">Currently ${fmtInt(Math.round(tris))} triangles${ctx.editor.selected ? ' in the selection' : ''}.</p>
      <div class="row"><label>Keep</label><input type="range" min="0.02" max="0.95" step="0.01" value="${reduceTarget}" data-ratio/><span class="cost-val" data-ratiolabel>${Math.round(reduceTarget * 100)}%</span></div>
      <p class="note">Target: about <b data-tricount>${fmtInt(Math.round(tris * reduceTarget))}</b> triangles. Shape-preserving simplification (meshoptimizer). Textures and UVs are not kept.</p>
      <div class="btn-row"><button class="btn-solid" data-reduce>Reduce</button></div>`;
  },
  bind(host) {
    const tris = targetMeshes().reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    host.querySelector('[data-ratio]')?.addEventListener('input', (e) => {
      reduceTarget = Number((e.target as HTMLInputElement).value);
      host.querySelector('[data-ratiolabel]')!.textContent = Math.round(reduceTarget * 100) + '%';
      host.querySelector('[data-tricount]')!.textContent = fmtInt(Math.round(tris * reduceTarget));
    });
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
  ctx.toast('Hollowed. Check the section plane to see the walls.');
}

registerPanel({
  id: 'hollow', label: 'Hollow', icon: 'hollow',
  hint: 'Make a closed model hollow with an even wall, e.g. to save resin',
  render() {
    const u = UNITS[ctx.unit()].short;
    return `<div class="row"><label>Wall</label><input type="number" step="0.1" min="0" value="${round(mmToUnits(hollowWallMm))}" data-wall/><span class="cost-unit">${u}</span></div>
      <p class="note">Adds an inner surface offset inwards by the wall thickness. Works best on closed, fairly smooth models: run Repair first. For resin prints, add drain holes in your slicer.</p>
      <div class="btn-row"><button class="btn-solid" data-hollow>Hollow</button><button class="chip" data-showsection>Show cut-away</button></div>`;
  },
  bind(host) {
    host.querySelector('[data-wall]')?.addEventListener('change', (e) => { hollowWallMm = unitsToMm(Number((e.target as HTMLInputElement).value)) || hollowWallMm; });
    host.querySelector('[data-hollow]')?.addEventListener('click', () => {
      ctx.setLoading('Hollowing…');
      setTimeout(() => { try { hollow(mmToUnits(hollowWallMm)); } finally { ctx.setLoading(null); } }, 30);
    });
    host.querySelector('[data-showsection]')?.addEventListener('click', () => ctx.setTool('section'));
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

function thicknessCheck(min: number) {
  clearHeatmap();
  let thinArea = 0, totalArea = 0;
  const ray = new THREE.Ray();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const mesh of targetMeshes()) {
    const src = mesh.geometry;
    const g = (src.index ? src.toNonIndexed() : src.clone());
    g.deleteAttribute('color');
    if (!g.attributes.normal) g.computeVertexNormals();
    const bvh = new MeshBVH(g);
    const pos = g.attributes.position, nrm = g.attributes.normal;
    mesh.updateWorldMatrix(true, false);
    const scale = mesh.matrixWorld.getMaxScaleOnAxis() || 1;
    const minLocal = min / scale;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    // Thickness at a vertex = distance to the opposite wall, cast straight inwards.
    const thick = new Float32Array(pos.count);
    for (let v = 0; v < pos.count; v++) {
      const n = new THREE.Vector3(nrm.getX(v), nrm.getY(v), nrm.getZ(v)).normalize().negate();
      ray.origin.set(pos.getX(v), pos.getY(v), pos.getZ(v)).addScaledVector(n, minLocal * 1e-3);
      ray.direction.copy(n);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      thick[v] = hit ? hit.distance : Infinity;
      const t = Math.min(1, (thick[v] / minLocal - 0.5) / 1.5); // red below 0.5×min, green from 2×min
      col.setHSL(Math.max(0, t) * 0.33, 0.85, 0.5);
      colors.set([col.r, col.g, col.b], v * 3);
    }
    for (let v = 0; v < pos.count; v += 3) {
      a.fromBufferAttribute(pos, v); b.fromBufferAttribute(pos, v + 1); c.fromBufferAttribute(pos, v + 2);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      totalArea += area;
      if ((thick[v] + thick[v + 1] + thick[v + 2]) / 3 < minLocal) thinArea += area;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    heat.push({ mesh, geometry: src, material: mesh.material });
    mesh.geometry = g;
    mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  thinShare = totalArea ? thinArea / totalArea : 0;
  ctx.renderDetails();
}

registerPanel({
  id: 'thickness', label: 'Wall thickness', icon: 'thickness',
  hint: 'Red = thinner than your minimum wall, green = thick enough',
  onDeactivate: clearHeatmap,
  render() {
    const u = UNITS[ctx.unit()].short;
    return `<div class="row"><label>Minimum</label><input type="number" step="0.1" min="0" value="${round(mmToUnits(minThicknessMm))}" data-min/><span class="cost-unit">${u}</span></div>
      ${thinShare >= 0 ? `<div class="verdict ${thinShare < 0.005 ? 'ok' : 'warn'}">${thinShare < 0.005 ? '✓ Walls are thick enough' : `⚠ ${fmtNum(thinShare * 100, 1)}% of the surface is thinner than ${round(mmToUnits(minThicknessMm))} ${u}`}</div>
        <div class="heat-legend"><span>thin</span><i></i><span>thick</span></div>` : ''}
      <div class="btn-row"><button class="btn-solid" data-thick>${thinShare >= 0 ? 'Check again' : 'Check thickness'}</button>${thinShare >= 0 ? '<button class="chip" data-thickclear>Clear colours</button>' : ''}</div>
      <p class="note">Typical minimums: 0.8 mm for FDM, 0.5 mm for resin. Thickness is measured straight inwards from each point.</p>`;
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

export function initPrintTools() {
  const has = () => !!ctx.viewer.model && modelMeshes(ctx.viewer.model).length > 0;
  registerCommand(
    { id: 'repair', label: 'Repair & printability check', group: 'Print', keywords: 'fix holes watertight manifold normals stl', run: () => ctx.setTool('repair'), enabled: has },
    { id: 'reduce', label: 'Reduce polygons (decimate)', group: 'Print', keywords: 'simplify optimize file size triangles', run: () => ctx.setTool('reduce'), enabled: has },
    { id: 'hollow', label: 'Hollow model', group: 'Print', keywords: 'shell resin save material', run: () => ctx.setTool('hollow'), enabled: has },
    { id: 'thickness', label: 'Wall thickness check', group: 'Print', keywords: 'thin walls heatmap', run: () => ctx.setTool('thickness'), enabled: has },
  );
}

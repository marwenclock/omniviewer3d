import * as THREE from 'three';
import { analyse } from './geom';
import { ctx, targetMeshes } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { weld, toGeometry, type Welded } from './geom';
import { download } from '../exporters';
import { UNITS } from '../stats';

// ------------------------------------------------------------------ slicing
interface Slice { pos: number[]; neg: number[]; posCol: number[]; negCol: number[]; segments: number[] }

/** Splits a welded mesh by a plane (in the same space). Returns triangle soups for both sides plus the cut segments. */
function slice(w: Welded, plane: THREE.Plane): Slice {
  const P = w.pos, C = w.colors;
  const n = P.length / 3;
  const d = new Float32Array(n);
  for (let v = 0; v < n; v++) d[v] = plane.normal.x * P[v * 3] + plane.normal.y * P[v * 3 + 1] + plane.normal.z * P[v * 3 + 2] + plane.constant;
  const out: Slice = { pos: [], neg: [], posCol: [], negCol: [], segments: [] };
  const vert = (v: number) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const col = (v: number) => (C ? [C[v * 3], C[v * 3 + 1], C[v * 3 + 2]] : [1, 1, 1]);
  const lerp = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
  const push = (side: 'pos' | 'neg', pts: number[][], cols: number[][]) => {
    for (let i = 1; i < pts.length - 1; i++) {
      out[side].push(...pts[0], ...pts[i], ...pts[i + 1]);
      out[side === 'pos' ? 'posCol' : 'negCol'].push(...cols[0], ...cols[i], ...cols[i + 1]);
    }
  };
  for (let t = 0; t < w.idx.length; t += 3) {
    const ids = [w.idx[t], w.idx[t + 1], w.idx[t + 2]];
    const ds = ids.map((v) => d[v]);
    if (ds.every((x) => x >= 0)) { push('pos', ids.map(vert), ids.map(col)); continue; }
    if (ds.every((x) => x <= 0)) { push('neg', ids.map(vert), ids.map(col)); continue; }
    // Crossing triangle: walk its edges, emitting vertices to each side and the crossing points to both.
    const posPts: number[][] = [], negPts: number[][] = [], posC: number[][] = [], negC: number[][] = [], cross: number[][] = [];
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3], da = ds[e], db = ds[(e + 1) % 3];
      if (da >= 0) { posPts.push(vert(a)); posC.push(col(a)); }
      if (da <= 0) { negPts.push(vert(a)); negC.push(col(a)); }
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const k = da / (da - db);
        const p = lerp(vert(a), vert(b), k), c = lerp(col(a), col(b), k);
        posPts.push(p); negPts.push(p); posC.push(c); negC.push(c); cross.push(p);
      }
    }
    if (posPts.length >= 3) push('pos', posPts, posC);
    if (negPts.length >= 3) push('neg', negPts, negC);
    if (cross.length === 2) out.segments.push(...cross[0], ...cross[1]);
  }
  return out;
}

/** Joins cut segments into closed loops. */
function loops(segments: number[], eps: number): THREE.Vector3[][] {
  const key = (x: number, y: number, z: number) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
  const adj = new Map<string, { p: THREE.Vector3; links: string[] }>();
  const node = (x: number, y: number, z: number) => {
    const k = key(x, y, z);
    if (!adj.has(k)) adj.set(k, { p: new THREE.Vector3(x, y, z), links: [] });
    return k;
  };
  for (let i = 0; i < segments.length; i += 6) {
    const a = node(segments[i], segments[i + 1], segments[i + 2]);
    const b = node(segments[i + 3], segments[i + 4], segments[i + 5]);
    if (a === b) continue;
    adj.get(a)!.links.push(b); adj.get(b)!.links.push(a);
  }
  const used = new Set<string>();
  const result: THREE.Vector3[][] = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop: THREE.Vector3[] = [];
    let prev = '', cur = start, guard = 0;
    while (cur && !used.has(cur) && guard++ < 1e6) {
      used.add(cur);
      loop.push(adj.get(cur)!.p);
      const next = adj.get(cur)!.links.find((l) => l !== prev && !used.has(l));
      prev = cur;
      cur = next || '';
    }
    if (loop.length >= 3) result.push(loop);
  }
  return result;
}

/** 2D axes on the plane. */
function planeBasis(normal: THREE.Vector3) {
  const ref = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  return { u, v };
}

const area2 = (pts: THREE.Vector2[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
function inside(p: THREE.Vector2, poly: THREE.Vector2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Triangulates the cut outline (outer loops with their holes) into cap triangles facing `facing`. */
function capTriangles(ls: THREE.Vector3[][], plane: THREE.Plane, facing: THREE.Vector3): number[] {
  const { u, v } = planeBasis(plane.normal);
  const polys = ls.map((l) => l.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
  const depth = polys.map((p, i) => polys.filter((q, j) => j !== i && inside(p[0], q)).length);
  const tris: number[] = [];
  polys.forEach((outer, i) => {
    if (depth[i] % 2 === 1) return;
    const holes = polys.filter((h, j) => depth[j] === depth[i] + 1 && inside(h[0], outer));
    let o = outer; if (area2(o) < 0) o = [...o].reverse();
    const hs = holes.map((h) => (area2(h) > 0 ? [...h].reverse() : h));
    const faces = THREE.ShapeUtils.triangulateShape(o, hs);
    const all = [...o, ...hs.flat()];
    const to3 = (p: THREE.Vector2) => u.clone().multiplyScalar(p.x).addScaledVector(v, p.y).addScaledVector(plane.normal, -plane.constant);
    // Counter-clockwise in (u, v) faces +normal; flip when the cap must face the other way.
    const flip = facing.dot(plane.normal) < 0;
    for (const [a, b, c] of faces) {
      const pa = to3(all[a]), pb = to3(all[b]), pc = to3(all[c]);
      if (flip) tris.push(pa.x, pa.y, pa.z, pc.x, pc.y, pc.z, pb.x, pb.y, pb.z);
      else tris.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
    }
  });
  return tris;
}

function soupToGeometry(tris: number[], cols: number[], capTris: number[], capColor: number[], keepColors: boolean) {
  const pos = new Float32Array([...tris, ...capTris]);
  const n = pos.length / 3;
  const w: Welded = {
    pos, idx: new Uint32Array(n).map((_, i) => i),
    colors: keepColors ? new Float32Array([...cols, ...Array.from({ length: capTris.length / 3 }, () => capColor).flat()]) : null,
  };
  return toGeometry(w);
}

// ------------------------------------------------------------------ cut action
let gap = 0;

function cutModel() {
  const plane = ctx.viewer.clipPlane.clone();
  const meshes = targetMeshes();
  if (!meshes.length) return;
  const changes: { mesh: THREE.Mesh; parent: THREE.Object3D; index: number; a: THREE.Mesh; b: THREE.Mesh }[] = [];
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const inv = mesh.matrixWorld.clone().invert();
    const local = plane.clone().applyMatrix4(inv);
    const w = weld(mesh);
    const s = slice(w, local);
    if (!s.pos.length || !s.neg.length) continue; // plane misses this part
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(w.pos, 3));
    const ls = loops(s.segments, (box.getSize(new THREE.Vector3()).length() || 1) * 1e-6);
    const keepColors = !!w.colors;
    const capColor = [0.62, 0.62, 0.62];
    const capPos = capTriangles(ls, local, local.normal.clone().negate()); // positive side's cap faces the cut
    const capNeg = capTriangles(ls, local, local.normal);
    const ga = soupToGeometry(s.pos, s.posCol, capPos, capColor, keepColors);
    const gb = soupToGeometry(s.neg, s.negCol, capNeg, capColor, keepColors);
    const mat = (m: THREE.Material | THREE.Material[]) => {
      const first: any = (Array.isArray(m) ? m[0] : m).clone();
      if (keepColors) { first.vertexColors = true; if (first.color) first.color.set(0xffffff); }
      return first as THREE.Material;
    };
    const a = new THREE.Mesh(ga, mat(mesh.material)); a.name = `${mesh.name || 'Part'} (A)`;
    const b = new THREE.Mesh(gb, mat(mesh.material)); b.name = `${mesh.name || 'Part'} (B)`;
    for (const m of [a, b]) { m.position.copy(mesh.position); m.quaternion.copy(mesh.quaternion); m.scale.copy(mesh.scale); }
    if (gap > 0) {
      // Move the halves apart along the plane normal (world gap, converted to the parent's space).
      const parent = mesh.parent!;
      const toLocal = (wv: THREE.Vector3) => parent.worldToLocal(wv.clone().add(parent.getWorldPosition(new THREE.Vector3()))).sub(parent.worldToLocal(parent.getWorldPosition(new THREE.Vector3())));
      a.position.add(toLocal(plane.normal.clone().multiplyScalar(gap / 2)));
      b.position.add(toLocal(plane.normal.clone().multiplyScalar(-gap / 2)));
    }
    for (const m of [a, b]) m.userData.explodeBase = m.position.clone();
    changes.push({ mesh, parent: mesh.parent!, index: mesh.parent!.children.indexOf(mesh), a, b });
  }
  if (!changes.length) { ctx.toast('The plane does not cross the model. Move the slider first.', true); return; }
  // A bare STL is one mesh that is the model itself: the halves go into a group that becomes the model.
  const v = ctx.viewer;
  const rootCut = changes.find((c) => c.mesh === v.model);
  const rootGroup = rootCut ? Object.assign(new THREE.Group(), { name: rootCut.mesh.name || 'Model' }) : null;
  if (rootGroup && rootCut) rootGroup.userData = { ...rootCut.mesh.userData, explodeBase: new THREE.Vector3() };
  const redo = () => {
    for (const c of changes) {
      if (c === rootCut) { rootGroup!.add(c.a, c.b); v.swapModel(rootGroup, v.clips, false); continue; }
      c.parent.remove(c.mesh); c.parent.add(c.a, c.b);
    }
    ctx.editor.select(null); ctx.viewer.setSection({ enabled: false }); ctx.viewer.refreshMaterials(); ctx.refresh();
  };
  const undo = () => {
    for (const c of changes) {
      if (c === rootCut) { v.swapModel(c.mesh, v.clips, false); continue; }
      c.parent.remove(c.a, c.b); c.parent.children.splice(c.index, 0, c.mesh); c.mesh.parent = c.parent;
    }
    ctx.editor.select(null); ctx.viewer.refreshMaterials(); ctx.refresh();
  };
  ctx.history.run({ label: 'Cut model', redo, undo });
  // Re-check both halves instead of promising they are closed (CA-11).
  const open = changes.flatMap((c) => [c.a, c.b]).filter((m) => { const r = analyse(m); return r.openEdges > 0 || r.nonManifoldEdges > 0; });
  ctx.toast(open.length
    ? `Cut into ${changes.length * 2} parts. ${open.length} half${open.length === 1 ? ' is' : 's are'} not fully closed (the original had holes or overlaps): check with Repair before printing.`
    : `Cut into ${changes.length * 2} parts. Both halves were checked and are closed.`, open.length > 0);
}

// ------------------------------------------------------------------ outline export (SVG / DXF)
function sectionOutline() {
  const plane = ctx.viewer.clipPlane.clone();
  const all: THREE.Vector3[][] = [];
  for (const mesh of targetMeshes()) {
    mesh.updateWorldMatrix(true, false);
    const local = plane.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const w = weld(mesh);
    const s = slice(w, local);
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(w.pos, 3));
    for (const l of loops(s.segments, (box.getSize(new THREE.Vector3()).length() || 1) * 1e-6)) all.push(l.map((p) => p.clone().applyMatrix4(mesh.matrixWorld)));
  }
  const { u, v } = planeBasis(plane.normal);
  return all.map((l) => l.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
}

function exportOutline(kind: 'svg' | 'dxf') {
  const polys = sectionOutline();
  if (!polys.length) { ctx.toast('The section plane does not cross the model.', true); return; }
  const box = new THREE.Box2();
  polys.flat().forEach((p) => box.expandByPoint(p));
  const unit = UNITS[ctx.unit()];
  const name = `${ctx.baseFileName()}-section.${kind}`;
  if (kind === 'svg') {
    // SVG only knows mm, cm and in: metres and feet are converted to millimetres so the size stays physical (OV-029).
    const svgUnit = ['mm', 'cm', 'in'].includes(unit.short) ? unit.short : unit.short === 'u' ? '' : 'mm';
    const k = svgUnit === 'mm' && !['mm'].includes(unit.short) ? unit.toMeters * 1000 : 1;
    const w = (box.max.x - box.min.x) * k, h = (box.max.y - box.min.y) * k;
    const d = polys.map((poly) => 'M' + poly.map((p) => `${((p.x - box.min.x) * k).toFixed(4)} ${((box.max.y - p.y) * k).toFixed(4)}`).join(' L') + ' Z').join(' ');
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(4)}${svgUnit}" height="${h.toFixed(4)}${svgUnit}" viewBox="0 0 ${w.toFixed(4)} ${h.toFixed(4)}">
  <path d="${d}" fill="none" stroke="#000" stroke-width="${(Math.max(w, h) / 1000).toFixed(4)}" fill-rule="evenodd"/>
</svg>
`;
    download(new Blob([svg], { type: 'image/svg+xml' }), name);
  } else {
    // Minimal R12 DXF with LINE entities: opens in every laser-cutter and CAD program.
    const lines: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String({ mm: 4, cm: 5, m: 6, in: 1, ft: 2 }[unit.short as 'mm'] ?? 0), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
    for (const poly of polys) for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      lines.push('0', 'LINE', '8', 'SECTION', '10', a.x.toFixed(5), '20', a.y.toFixed(5), '30', '0', '11', b.x.toFixed(5), '21', b.y.toFixed(5), '31', '0');
    }
    lines.push('0', 'ENDSEC', '0', 'EOF');
    download(new Blob([lines.join('\n')], { type: 'application/dxf' }), name);
  }
  ctx.toast(`Saved section outline (${polys.length} loop${polys.length === 1 ? '' : 's'}) as ${kind.toUpperCase()}`);
}

// ------------------------------------------------------------------ panel
registerPanel({
  id: 'cut', label: 'Cut / split', icon: 'cut',
  hint: 'Position the plane, then cut: each half gets a flat face and is checked',
  onActivate: () => { if (!ctx.viewer.section.enabled) ctx.viewer.setSection({ enabled: true }); },
  render() {
    const s = ctx.viewer.section;
    const u = UNITS[ctx.unit()].short;
    return `<div class="row" style="margin-top:0"><label>Axis</label><div class="seg">${(['x', 'y', 'z'] as const).map((a) => `<button class="${s.axis === a ? 'active' : ''}" data-cutaxis="${a}">${a.toUpperCase()}</button>`).join('')}</div></div>
      <div class="row"><label>Position</label><input type="range" min="0" max="1" step="0.001" value="${s.t}" data-cutpos /></div>
      <div class="row"><label>Gap</label><input type="number" min="0" step="any" value="${gap}" data-cutgap /><span class="cost-unit">${u}</span></div>
      <div class="btn-row"><button class="btn-solid" data-cut>Cut</button></div>
      <p class="note">Applies to: <b>${ctx.editor.selected ? 'the selected part' : 'every visible part the plane crosses'}</b>. Each half gets a flat face and is checked afterwards. Undo with Ctrl+Z.</p>
      <div class="field-label" style="margin-top:12px">Section outline (for laser cutting / CNC)</div>
      <div class="btn-row" style="margin-top:6px"><button class="chip" data-outline="svg">${'Save SVG'}</button><button class="chip" data-outline="dxf">Save DXF</button></div>`;
  },
  pill() {
    const s = ctx.viewer.section;
    return `<div class="tp-seg">${(['x', 'y', 'z'] as const).map((a) => `<button class="${s.axis === a ? 'active' : ''}" data-cutaxis="${a}">${a.toUpperCase()}</button>`).join('')}</div>
      <input type="range" min="0" max="1" step="0.001" value="${s.t}" data-cutpos aria-label="Cut position" />
      <button class="tp-go" data-cut>Cut</button>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLElement>('[data-cutaxis]').forEach((b) => b.addEventListener('click', () => { ctx.viewer.setSection({ axis: b.dataset.cutaxis as any, enabled: true }); ctx.renderDetails(); }));
    host.querySelector('[data-cutpos]')?.addEventListener('input', (e) => ctx.viewer.setSection({ t: Number((e.target as HTMLInputElement).value), enabled: true }));
    host.querySelector('[data-cutgap]')?.addEventListener('change', (e) => { gap = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); });
    host.querySelector('[data-cut]')?.addEventListener('click', () => {
      ctx.setLoading('Cutting…');
      setTimeout(() => { try { cutModel(); } catch (e: any) { ctx.toast('Cut failed: ' + (e?.message || e), true); } finally { ctx.setLoading(null); } }, 30);
    });
    host.querySelectorAll<HTMLElement>('[data-outline]').forEach((b) => b.addEventListener('click', () => exportOutline(b.dataset.outline as 'svg' | 'dxf')));
  },
});

export function initCutTools() {
  const has = () => !!ctx.viewer.model;
  registerCommand(
    { id: 'cut', label: 'Cut / split model', group: 'Print', keywords: 'slice divide halves plane', run: () => ctx.setTool('cut'), enabled: has },
    { id: 'outline-svg', label: 'Save section outline as SVG', group: 'File', keywords: 'laser cut profile', run: () => exportOutline('svg'), enabled: has },
    { id: 'outline-dxf', label: 'Save section outline as DXF', group: 'File', keywords: 'laser cnc cad profile', run: () => exportOutline('dxf'), enabled: has },
  );
}

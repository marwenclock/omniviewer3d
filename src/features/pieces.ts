// Separate pieces inside one mesh. Multi-colour prints are often shipped as one STL that holds several bodies (a
// logo sitting in a base, letters on a plate): a slicer shows them as separate objects you can give their own
// filament. Here they can be counted, split into their own parts, isolated, and saved as one STL each.
import * as THREE from 'three';
import { ctx, modelMeshes } from '../context';
import { topology } from '../tools/features';
import { toGeometry } from './geom';
import { registerCommand } from '../registry';
import { exportModel, download, safeFileName, type UnitId } from '../exporters';
import { UNITS } from '../stats';

const MAX_PIECES = 400;

/** Body id of every triangle (triangle order of the geometry) and the number of bodies. */
function bodies(geo: THREE.BufferGeometry) {
  const T = topology(geo);
  if (!T) return null;
  const n = T.pos.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tri = T.tri;
  for (let t = 0; t < T.triCount; t++) {
    const a = find(tri[3 * t]), b = find(tri[3 * t + 1]), c = find(tri[3 * t + 2]);
    if (b !== a) parent[b] = a;
    const c2 = find(c); if (c2 !== a) parent[c2] = a;
  }
  const ids = new Map<number, number>();
  const triBody = new Int32Array(T.triCount);
  const sizes: number[] = [];
  for (let t = 0; t < T.triCount; t++) {
    const r = find(tri[3 * t]);
    let id = ids.get(r);
    if (id === undefined) { id = sizes.length; ids.set(r, id); sizes.push(0); }
    triBody[t] = id;
    sizes[id]++;
  }
  return { count: sizes.length, sizes, triBody };
}

const countCache = new WeakMap<THREE.BufferGeometry, { ver: number; n: number }>();
/** Number of separate bodies in a mesh (cached per geometry; 1 when it can't be worked out). */
export function pieceCount(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  const ver = (g.attributes.position as THREE.BufferAttribute | undefined)?.version ?? 0;
  const c = countCache.get(g);
  if (c && c.ver === ver) return c.n;
  const tris = (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
  const n = tris > 3_000_000 ? 1 : bodies(g)?.count ?? 1;
  countCache.set(g, { ver, n });
  return n;
}

/** Builds one geometry per body, keeping every attribute (normals, UVs, colours) and material groups. */
function splitGeometry(geo: THREE.BufferGeometry, triBody: Int32Array, count: number) {
  const idx = geo.index;
  const triCount = triBody.length;
  // Material slot of every triangle, from the geometry groups (counted in index / vertex units).
  const triMat = new Int32Array(triCount);
  for (const gr of geo.groups) for (let t = Math.floor(gr.start / 3); t < Math.min(triCount, (gr.start + gr.count) / 3); t++) triMat[t] = gr.materialIndex ?? 0;
  const lists: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < triCount; t++) lists[triBody[t]].push(t);
  const names = Object.keys(geo.attributes);
  return lists.map((list) => {
    // Sort by material so each slot is one group.
    if (geo.groups.length > 1) list.sort((a, b) => triMat[a] - triMat[b]);
    const out = new THREE.BufferGeometry();
    for (const name of names) {
      const src = geo.attributes[name] as THREE.BufferAttribute;
      const size = src.itemSize;
      const arr = new (src.array.constructor as any)(list.length * 3 * size);
      let o = 0;
      for (const t of list) for (let k = 0; k < 3; k++) {
        const v = idx ? idx.getX(3 * t + k) : 3 * t + k;
        for (let c = 0; c < size; c++) arr[o++] = src.getComponent(v, c);
      }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size, src.normalized));
    }
    if (geo.groups.length > 1) {
      let start = 0;
      for (let i = 1; i <= list.length; i++) {
        if (i === list.length || triMat[list[i]] !== triMat[list[start]]) { out.addGroup(start * 3, (i - start) * 3, triMat[list[start]]); start = i; }
      }
    }
    out.computeBoundingBox(); out.computeBoundingSphere();
    return out;
  });
}

const baseName = (mesh: THREE.Object3D) => (mesh.name || 'Part').replace(/\.(stl|obj|3mf|ply|amf|off|glb|gltf|fbx|stp|step|iges?)$/i, '');

/** A group in the mesh's place (same transform and data) holding the new parts. */
function groupFor(mesh: THREE.Mesh, parts: THREE.Mesh[]) {
  const group = new THREE.Group();
  group.name = mesh.name || 'Part';
  group.position.copy(mesh.position); group.quaternion.copy(mesh.quaternion); group.scale.copy(mesh.scale);
  group.userData = { ...mesh.userData, explodeBase: group.position.clone() };
  delete group.userData.paintReady; delete group.userData.filamentPaint;
  for (const m of parts) {
    m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
    m.userData.explodeBase = m.position.clone();
    group.add(m);
  }
  return group;
}

type Change = { mesh: THREE.Mesh; parent: THREE.Object3D; index: number; group: THREE.Group };
/** Swaps meshes for their groups in one undo step. */
function replaceWithGroups(changes: Change[], label: string) {
  const v = ctx.viewer;
  // A bare STL is one mesh that is the model itself: the new group takes its place as the model.
  const swap = (from: THREE.Object3D, to: THREE.Object3D) => {
    if (v.model === from) { v.swapModel(to, v.clips, false); return true; }
    return false;
  };
  const redo = () => {
    for (const c of changes) { if (swap(c.mesh, c.group)) continue; c.parent.remove(c.mesh); c.parent.children.splice(c.index, 0, c.group); c.group.parent = c.parent; }
    ctx.editor.select(changes.length === 1 ? changes[0].group : null); ctx.viewer.refreshMaterials(); ctx.refresh();
  };
  const undo = () => {
    for (const c of changes) { if (swap(c.group, c.mesh)) continue; c.parent.remove(c.group); c.parent.children.splice(c.index, 0, c.mesh); c.mesh.parent = c.parent; }
    ctx.editor.select(changes.length === 1 ? changes[0].mesh : null); ctx.viewer.refreshMaterials(); ctx.refresh();
  };
  ctx.history.run({ label, redo, undo });
}

// ------------------------------------------------------------------ colours
interface ColourGroup { key: number; color: THREE.Color; tris: number[]; area: number }

/** Triangles grouped by their painted colour (vertex colours, or material slots). */
function colourGroups(mesh: THREE.Mesh): ColourGroup[] | null {
  const g = mesh.geometry;
  const pos = g.attributes.position, idx = g.index;
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!pos || (!col && (mats.length < 2 || g.groups.length < 2))) return null;
  const triCount = (idx ? idx.count : pos.count) / 3;
  const triMat = new Int32Array(triCount);
  if (!col) for (const gr of g.groups) for (let t = Math.floor(gr.start / 3); t < Math.min(triCount, (gr.start + gr.count) / 3); t++) triMat[t] = gr.materialIndex ?? 0;
  const groups = new Map<number, ColourGroup>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const vid = (t: number, k: number) => (idx ? idx.getX(3 * t + k) : 3 * t + k);
  for (let t = 0; t < triCount; t++) {
    let r: number, gg: number, bb: number;
    if (col) { const v = vid(t, 0); r = col.getX(v); gg = col.getY(v); bb = col.getZ(v); }
    else { const m: any = mats[triMat[t]]; r = m?.color?.r ?? 1; gg = m?.color?.g ?? 1; bb = m?.color?.b ?? 1; }
    const key = (Math.round(r * 255) << 16) | (Math.round(gg * 255) << 8) | Math.round(bb * 255);
    let grp = groups.get(key);
    if (!grp) groups.set(key, (grp = { key, color: new THREE.Color(r, gg, bb), tris: [], area: 0 }));
    grp.tris.push(t);
    a.fromBufferAttribute(pos, vid(t, 0)); b.fromBufferAttribute(pos, vid(t, 1)); c.fromBufferAttribute(pos, vid(t, 2));
    grp.area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return [...groups.values()].sort((x, y) => y.area - x.area);
}

const colourCache = new WeakMap<THREE.BufferGeometry, { ver: number; n: number }>();
/** Number of colours painted on a mesh (1 when unpainted). */
export function colourCount(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  const ver = ((g.attributes.color as THREE.BufferAttribute | undefined)?.version ?? 0) + (g.attributes.position?.count ?? 0) * 7;
  const c = colourCache.get(g);
  if (c && c.ver === ver) return c.n;
  const n = colourGroups(mesh)?.length ?? 1;
  colourCache.set(g, { ver, n });
  return n;
}

/**
 * Splits painted meshes into one closed part per colour, the way a slicer prints them: each painted area becomes a
 * solid `depthMm` deep, and the main colour keeps the rest with a pocket of the same shape. Both are built from the
 * same vertices (no boolean engine), so every part is closed and they fit together exactly; their STLs line up
 * again in a slicer. The depth is limited to half the wall behind each point, so thin walls are never pierced.
 */
export async function splitByColour(depthMm: number, meshes = targets()): Promise<number> {
  const todo = meshes.map((m) => ({ m, groups: colourGroups(m) })).filter((x) => x.groups && x.groups.length > 1 && x.m.parent);
  if (!todo.length) { ctx.toast('Nothing painted in more than one colour. Paint areas first (Paint → Area), or open a painted 3MF.', true); return 0; }
  const { analyse } = await import('./geom');
  const { MeshBVH } = await import('three-mesh-bvh');
  const changes: Change[] = [];
  let open = 0, made = 0, thinned = 0;
  const unitMm = UNITS[ctx.unit()].toMeters * 1000;
  for (const { m: mesh, groups } of todo) {
    const geo = mesh.geometry;
    const T = topology(geo);
    if (!T) continue;
    const P = T.pos, tri = T.tri;
    const depth = depthMm / unitMm;
    const base = mesh.name ? baseName(mesh) : baseName({ name: ctx.modelName() } as THREE.Object3D);
    const hex = (c: THREE.Color) => '#' + c.getHexString(THREE.SRGBColorSpace);
    const matFor = (c: THREE.Color) => {
      const first: any = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).clone();
      first.vertexColors = false;
      if (first.color) first.color.copy(c);
      return first as THREE.Material;
    };
    const [main, ...rest] = groups!;
    const triColour = new Int32Array(T.triCount).fill(-1);
    groups!.forEach((g, gi) => { for (const t of g.tris) triColour[t] = gi; });
    // Directed edges per colour, to find borders (an edge whose reverse belongs to another colour).
    const edgeOwner = new Map<string, number>();
    for (let t = 0; t < T.triCount; t++) {
      const [i, j, k] = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
      edgeOwner.set(`${i},${j}`, triColour[t]); edgeOwner.set(`${j},${k}`, triColour[t]); edgeOwner.set(`${k},${i}`, triColour[t]);
    }
    const bvh = new MeshBVH(geo);
    const ray = new THREE.Ray();
    const out = new Map<number, number[]>(); // colour index → triangle soup
    const soupOf = (gi: number) => out.get(gi) ?? out.set(gi, []).get(gi)!;
    const push = (arr: number[], ...vs: THREE.Vector3[]) => { for (const v of vs) arr.push(v.x, v.y, v.z); };
    const V = (v: number) => new THREE.Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    for (let t = 0; t < T.triCount; t++) {
      if (triColour[t] !== 0) continue;
      const [i, j, k] = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
      if (i !== j && j !== k && i !== k) push(soupOf(0), V(i), V(j), V(k));
    }
    rest.forEach((g, ri) => {
      const gi = ri + 1;
      const own = soupOf(gi), body = soupOf(0);
      // Whole bodies in this colour (no border): a part as they are.
      const border: [number, number][] = [];
      for (const t of g.tris) {
        const vs = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
        for (let e = 0; e < 3; e++) { const x = vs[e], y = vs[(e + 1) % 3]; if (edgeOwner.get(`${y},${x}`) !== gi) border.push([x, y]); }
      }
      if (!border.length) { for (const t of g.tris) push(own, V(tri[3 * t]), V(tri[3 * t + 1]), V(tri[3 * t + 2])); return; }
      // Inward direction per vertex (area-weighted patch normal), and how far it may go before the far wall.
      const nrm = new Map<number, THREE.Vector3>();
      for (const t of g.tris) {
        const [i, j, k] = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
        const n = V(j).sub(V(i)).cross(V(k).sub(V(i)));
        for (const v of [i, j, k]) (nrm.get(v) ?? nrm.set(v, new THREE.Vector3()).get(v)!).add(n);
      }
      const off = new Map<number, THREE.Vector3>();
      for (const [v, n] of nrm) {
        n.normalize();
        const p = V(v);
        ray.origin.copy(p).addScaledVector(n, -depth * 1e-3); ray.direction.copy(n).negate();
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
        let d = depth;
        if (hit && hit.distance < depth * 2) { d = Math.min(depth, hit.distance * 0.5); if (d < depth) thinned++; }
        off.set(v, p.addScaledVector(n, -d));
      }
      for (const t of g.tris) {
        const [i, j, k] = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
        if (i === j || j === k || i === k) continue;
        push(own, V(i), V(j), V(k)); // painted surface
        push(own, off.get(i)!, off.get(k)!, off.get(j)!); // its floor
        push(body, off.get(i)!, off.get(j)!, off.get(k)!); // the pocket's floor, facing the painted part
      }
      for (const [x, y] of border) {
        const xt = V(x), yt = V(y), xb = off.get(x)!, yb = off.get(y)!;
        push(own, xt, xb, yb); push(own, xt, yb, yt);
        push(body, xt, yb, xb); push(body, xt, yt, yb);
      }
    });
    const parts: THREE.Mesh[] = [];
    groups!.forEach((g, gi) => {
      const arr = out.get(gi);
      if (!arr?.length) return;
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const welded = { pos: pg.attributes.position.array as Float32Array, idx: new Uint32Array(arr.length / 3).map((_, i) => i), colors: null };
      const m = new THREE.Mesh(toGeometry(welded), matFor(g.color));
      m.name = gi === 0 ? `${base} - main colour` : `${base} - colour ${gi + 1} ${hex(g.color).slice(1)}`;
      parts.push(m);
    });
    void main;
    // Only defects the split added count: a file with flaws of its own passes them on to the main part.
    const before = analyse(mesh);
    const baseline = before.openEdges + before.nonManifoldEdges;
    for (const p of parts) { const r = analyse(p); if (r.openEdges + r.nonManifoldEdges > baseline) open++; }
    made += parts.length;
    changes.push({ mesh, parent: mesh.parent!, index: mesh.parent!.children.indexOf(mesh), group: groupFor(mesh, parts) });
  }
  if (!changes.length) return 0;
  replaceWithGroups(changes, 'Split by colour');
  ctx.toast(open
    ? `Split into ${made} parts by colour. ${open} of them ${open === 1 ? 'is' : 'are'} not fully closed (the painted border may run along an open edge): check with Repair before slicing.`
    : `Split into ${made} closed parts by colour. Painted areas go ${depthMm} mm deep${thinned ? ' (less where the wall behind is thinner)' : ''}. Save each part as STL for your slicer.`, open > 0);
  return made;
}

/** Meshes the action applies to: the selected mesh, the meshes inside a selected group, or the whole model. */
function targets(): THREE.Mesh[] {
  const sel = ctx.editor.selected;
  return modelMeshes(sel ?? ctx.viewer.model, true);
}

/**
 * Splits every target mesh that holds more than one body into a group of one part per body, biggest first.
 * Returns the number of new parts (0 when nothing had to be split).
 */
export function splitIntoPieces(meshes = targets()): number {
  type Change = { mesh: THREE.Mesh; parent: THREE.Object3D; index: number; group: THREE.Group };
  const changes: Change[] = [];
  let tooMany = 0;
  for (const mesh of meshes) {
    if ((mesh as any).isInstancedMesh || (mesh as any).isSkinnedMesh || !mesh.parent) continue;
    const b = bodies(mesh.geometry);
    if (!b || b.count < 2) continue;
    if (b.count > MAX_PIECES) { tooMany = Math.max(tooMany, b.count); continue; }
    // Biggest body first, so "piece 1" is the base and the small inlays follow.
    const order = b.sizes.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]).map(([, i]) => i);
    const rank = new Int32Array(b.count); order.forEach((id, r) => (rank[id] = r));
    const triBody = b.triBody.map((id) => rank[id]);
    const geos = splitGeometry(mesh.geometry, triBody, b.count);
    const base = baseName(mesh);
    const parts = geos.map((g, i) => Object.assign(new THREE.Mesh(g, mesh.material), { name: `${base} piece ${i + 1}` }));
    const group = groupFor(mesh, parts);
    changes.push({ mesh, parent: mesh.parent, index: mesh.parent.children.indexOf(mesh), group });
  }
  if (!changes.length) {
    ctx.toast(tooMany ? `This mesh has ${tooMany} loose pieces, too many to split usefully. Run Repair to clean up loose bits first.` : 'Already one piece: nothing to split.', !!tooMany);
    return 0;
  }
  replaceWithGroups(changes, 'Split into pieces');
  const n = changes.reduce((s, c) => s + c.group.children.length, 0);
  ctx.toast(`Split into ${n} pieces. Each one is its own part now: pick it, isolate it or save it as STL.`);
  return n;
}

/** Saves each target mesh as its own STL; several go into one ZIP. */
export async function savePiecesAsStl(meshes = targets()) {
  const list = meshes.filter((m) => !(m as any).isPoints);
  if (!list.length) { ctx.toast('No mesh parts to save', true); return; }
  ctx.setLoading(list.length > 1 ? `Saving ${list.length} STL files…` : 'Saving STL…');
  try {
    const v = ctx.viewer;
    const opts = { unit: ctx.unit() as UnitId, zUp: v.upAxis === 'y', scope: 'all' as const };
    const used = new Set<string>();
    const files: Record<string, Uint8Array> = {};
    for (const m of list) {
      const blob = await exportModel(v, 'stl', m, opts);
      let name = safeFileName(m.name || 'part'), k = 2;
      while (used.has(name)) name = `${safeFileName(m.name || 'part')}-${k++}`;
      used.add(name);
      files[`${name}.stl`] = new Uint8Array(await blob.arrayBuffer());
      if (list.length === 1) { download(blob, `${name}.stl`); return; }
    }
    const { zipSync } = await import('fflate');
    download(new Blob([zipSync(files)], { type: 'application/zip' }), `${ctx.baseFileName()}-parts.zip`);
    ctx.toast(`Saved ${list.length} STL files in one ZIP (each part keeps its place, so they line up again in the slicer)`);
  } catch (e: any) {
    ctx.toast('Saving failed: ' + (e?.message || e), true);
  } finally { ctx.setLoading(null); }
}

export function initPieces() {
  const mesh = () => !!ctx.viewer.model && modelMeshes(ctx.viewer.model).length > 0;
  registerCommand(
    { id: 'split-colour', label: 'Split by colour into parts (painted areas)', group: 'Edit', keywords: 'multi colour filament paint 3mf bambu orca prusa separate stl logo', run: () => { void splitByColour(colourDepthMm()); }, enabled: mesh },
    { id: 'split-pieces', label: 'Split into separate pieces (bodies)', group: 'Edit', keywords: 'separate shells bodies loose parts multi colour filament logo inlay', run: () => splitIntoPieces(), enabled: mesh },
    { id: 'save-parts-stl', label: 'Save each part as its own STL (ZIP)', group: 'File', keywords: 'export separate stl multi colour filament bodies pieces zip', run: () => savePiecesAsStl(), enabled: mesh },
  );
}

/** Depth painted areas go into the part when split by colour (remembered). */
export function colourDepthMm() { return Number(localStorage.getItem('ov.colourDepth')) || 1; }
export function setColourDepthMm(v: number) { if (v > 0) localStorage.setItem('ov.colourDepth', String(v)); }

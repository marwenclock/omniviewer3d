// Separate pieces inside one mesh. Multi-colour prints are often shipped as one STL that holds several bodies (a
// logo sitting in a base, letters on a plate): a slicer shows them as separate objects you can give their own
// filament. Here they can be counted, split into their own parts, isolated, and saved as one STL each.
import * as THREE from 'three';
import { ctx, modelMeshes } from '../context';
import { topology } from '../tools/features';
import { registerCommand } from '../registry';
import { exportModel, download, safeFileName, type UnitId } from '../exporters';

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
    const group = new THREE.Group();
    group.name = mesh.name || 'Part';
    group.position.copy(mesh.position); group.quaternion.copy(mesh.quaternion); group.scale.copy(mesh.scale);
    group.userData = { ...mesh.userData, explodeBase: group.position.clone() };
    delete group.userData.paintReady;
    geos.forEach((g, i) => {
      const m = new THREE.Mesh(g, mesh.material);
      m.name = `${(mesh.name || 'Part').replace(/\.(stl|obj|3mf|ply|amf|off|glb|gltf|fbx|stp|step|iges?)$/i, '')} piece ${i + 1}`;
      m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
      m.userData.explodeBase = m.position.clone();
      group.add(m);
    });
    changes.push({ mesh, parent: mesh.parent, index: mesh.parent.children.indexOf(mesh), group });
  }
  if (!changes.length) {
    ctx.toast(tooMany ? `This mesh has ${tooMany} loose pieces, too many to split usefully. Run Repair to clean up loose bits first.` : 'Already one piece: nothing to split.', !!tooMany);
    return 0;
  }
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
  ctx.history.run({ label: 'Split into pieces', redo, undo });
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
    { id: 'split-pieces', label: 'Split into separate pieces (bodies)', group: 'Edit', keywords: 'separate shells bodies loose parts multi colour filament logo inlay', run: () => splitIntoPieces(), enabled: mesh },
    { id: 'save-parts-stl', label: 'Save each part as its own STL (ZIP)', group: 'File', keywords: 'export separate stl multi colour filament bodies pieces zip', run: () => savePiecesAsStl(), enabled: mesh },
  );
}

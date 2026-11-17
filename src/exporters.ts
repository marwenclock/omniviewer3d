import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { Viewer } from './viewer';

// ---------------------------------------------------------------------------------------------
// Export contract (audit OV-001, OV-004, OV-016, OV-017, OV-020, CA-02, CA-03, CA-04, CA-24)
//
// Every export goes through one function, `exportObject`, which never touches the visible scene:
//   1. it copies the chosen object into a temporary export graph,
//   2. applies ONE scope rule (visible parts / all parts) for every format,
//   3. strips viewer helpers and internal app data,
//   4. converts physical units and axes to the target format's convention:
//        glTF / GLB / USDZ : metres, Y-up (the formats' own specifications)
//        STL / OBJ / PLY    : no unit in the file, numbers written in a chosen unit (STL default mm), Z-up for print
//        3MF                : keeps the model's unit and declares it in the file
// ---------------------------------------------------------------------------------------------

export type UnitId = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'u';
export const UNIT_METRES: Record<UnitId, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048, u: 1 };

export interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  /** short, honest one-line description (audit CA-05) */
  note: string;
  /** coordinate convention written to the file */
  convention: 'metres-y' | 'unitless' | 'declared';
  keeps: { materials: boolean; textures: boolean; vertexColors: boolean; animation: boolean; hierarchy: boolean; points: boolean; lines: boolean };
}

const K = (materials: boolean, textures: boolean, vertexColors: boolean, animation: boolean, hierarchy: boolean, points = false, lines = false) =>
  ({ materials, textures, vertexColors, animation, hierarchy, points, lines });

export const EXPORT_FORMATS = [
  { id: 'glb', label: 'GLB (binary glTF)', ext: 'glb', convention: 'metres-y', keeps: K(true, true, true, true, true, true, true),
    note: 'Web, games and AR. Materials, textures, colours and animation; real-world size in metres.' },
  { id: 'gltf', label: 'glTF (JSON)', ext: 'gltf', convention: 'metres-y', keeps: K(true, true, true, true, true, true, true),
    note: 'Same as GLB as readable text with embedded data.' },
  { id: 'stl', label: 'STL (binary)', ext: 'stl', convention: 'unitless', keeps: K(false, false, false, false, false),
    note: 'For 3D printing. Geometry only, no units stored (written in millimetres by default).' },
  { id: 'stl-ascii', label: 'STL (ASCII)', ext: 'stl', convention: 'unitless', keeps: K(false, false, false, false, false),
    note: 'Readable text STL. Geometry only.' },
  { id: '3mf', label: '3MF', ext: '3mf', convention: 'declared', keeps: K(true, false, true, false, false),
    note: 'Modern printing format. Separate objects, declared units, one colour per object or per triangle.' },
  { id: 'obj', label: 'OBJ', ext: 'obj', convention: 'unitless', keeps: K(false, false, false, false, true, true, true),
    note: 'Geometry, normals and UVs. No materials (use OBJ + MTL for those).' },
  { id: 'obj-zip', label: 'OBJ + MTL + textures (ZIP)', ext: 'zip', convention: 'unitless', keeps: K(true, true, false, false, true, true, true),
    note: 'OBJ with a material file and texture images, packed in one ZIP.' },
  { id: 'ply', label: 'PLY (binary)', ext: 'ply', convention: 'unitless', keeps: K(false, false, true, false, false, true, false),
    note: 'Geometry and painted vertex colours. No materials or textures.' },
  { id: 'usdz', label: 'USDZ', ext: 'usdz', convention: 'metres-y', keeps: K(true, true, false, false, true),
    note: 'Apple AR Quick Look. Basic materials and textures; real-world size in metres.' },
] as const satisfies readonly ExportFormat[];

export type ExportId = (typeof EXPORT_FORMATS)[number]['id'];
export const formatById = (id: ExportId) => EXPORT_FORMATS.find((f) => f.id === id)!;
export const isUnitless = (id: ExportId) => formatById(id).convention === 'unitless';
export const isPrintFormat = (id: ExportId) => id === 'stl' || id === 'stl-ascii' || id === '3mf';

export type ExportScope = 'visible' | 'all';

export interface ExportOptions {
  /** unit the model's coordinates are in (the model's "file units") */
  unit?: UnitId;
  /** axis convention of the model's coordinates ('z' for STL/STEP-style Z-up files) */
  up?: 'y' | 'z';
  /** for print formats: stand a Y-up model upright (Z-up) */
  zUp?: boolean;
  /** visible parts only (default) or every part, hidden ones included */
  scope?: ExportScope;
  /** animations to include (glTF only) */
  clips?: THREE.AnimationClip[];
  /** unit for numbers in unit-less formats (STL default mm, OBJ/PLY default the model's unit) */
  outUnit?: UnitId;
  /** placement of `root` in the export frame (defaults to root.matrix) */
  relMatrix?: THREE.Matrix4;
  /** 3MF: write per-triangle colours from painted vertex colours */
  perTriangleColors?: boolean;
}

/** The unit numbers are written in for this format (null = the format stores real metres). */
export function outputUnit(id: ExportId, opts: ExportOptions): UnitId | null {
  const unit = opts.unit ?? 'mm';
  const conv = formatById(id).convention;
  if (conv === 'metres-y') return 'm';
  if (conv === 'declared') return unit === 'u' ? 'mm' : unit;
  return opts.outUnit ?? (id === 'stl' || id === 'stl-ascii' ? (unit === 'u' ? 'u' : 'mm') : unit);
}

/** Builds the conversion matrix (scale + axis change) from model coordinates to the target file's frame. */
export function conversionMatrix(id: ExportId, opts: ExportOptions): THREE.Matrix4 {
  const unit = opts.unit ?? 'mm';
  const up = opts.up ?? 'y';
  const conv = formatById(id).convention;
  let scale = 1, rotX = 0;
  if (conv === 'metres-y') {
    scale = UNIT_METRES[unit];
    if (up === 'z') rotX = -Math.PI / 2; // Z-up file axes → glTF / USD Y-up
  } else {
    const out = outputUnit(id, opts)!;
    scale = unit === 'u' || out === 'u' || conv === 'declared' ? 1 : UNIT_METRES[unit] / UNIT_METRES[out];
    if (opts.zUp && up === 'y') rotX = Math.PI / 2; // Y-up model → Z-up print convention
  }
  return new THREE.Matrix4().makeRotationX(rotX).scale(new THREE.Vector3(scale, scale, scale));
}

/** A temporary copy of the object, pruned to the chosen scope and stripped of helpers and app data. */
export function buildExportGraph(root: THREE.Object3D, id: ExportId, opts: ExportOptions): THREE.Group {
  const copy = skeletonClone(root) as THREE.Object3D;
  const rel = opts.relMatrix ?? root.matrix;
  rel.decompose(copy.position, copy.quaternion, copy.scale);
  const scope = opts.scope ?? 'visible';
  if (scope === 'visible' && !root.visible) throw new Error('Nothing visible to export');
  const drop: THREE.Object3D[] = [];
  copy.traverse((o) => {
    if (o !== copy && (o.userData.helper || o.userData.proxy || (scope === 'visible' && !o.visible))) drop.push(o);
  });
  drop.forEach((o) => o.removeFromParent());
  copy.traverse((o) => {
    o.visible = true;
    o.userData = {}; // internal state (explode bases, Rhino settings, ...) must not leak into files (CA-04)
  });
  const wrapper = new THREE.Group();
  wrapper.name = root.name || 'model';
  wrapper.add(copy);
  conversionMatrix(id, opts).decompose(wrapper.position, wrapper.quaternion, wrapper.scale);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

/** Keeps only animation tracks that point at nodes present in the export graph. */
function clipsFor(graph: THREE.Object3D, clips: THREE.AnimationClip[] = []): THREE.AnimationClip[] {
  const names = new Set<string>();
  graph.traverse((o) => { if (o.name) names.add(o.name); names.add(o.uuid); });
  return clips.map((c) => {
    const tracks = c.tracks.filter((t) => {
      try { return names.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName); } catch { return false; }
    });
    return tracks.length ? new THREE.AnimationClip(c.name, c.duration, tracks) : null;
  }).filter(Boolean) as THREE.AnimationClip[];
}

/** Temporarily clears material / geometry userData (shared with the visible scene) during export. */
function withCleanData<T>(graph: THREE.Object3D, fn: () => Promise<T>): Promise<T> {
  const saved: [{ userData: any }, any][] = [];
  const seen = new Set<any>();
  graph.traverse((o: any) => {
    const items = [o.geometry, ...(Array.isArray(o.material) ? o.material : [o.material])];
    for (const it of items) if (it && !seen.has(it)) { seen.add(it); saved.push([it, it.userData]); it.userData = {}; }
  });
  return fn().finally(() => saved.forEach(([it, ud]) => (it.userData = ud)));
}

export function hasSplat(root: THREE.Object3D) {
  let splat = false;
  root.traverse((o) => { if (o.userData.splat) splat = true; });
  return splat;
}

/** Exports any object to a file, without changing the visible scene. Pure: usable in tests and batch jobs. */
export async function exportObject(root: THREE.Object3D, id: ExportId, opts: ExportOptions = {}): Promise<Blob> {
  if (hasSplat(root)) throw new Error('Gaussian splats can be viewed and screenshotted, but not converted to mesh formats.');
  const graph = buildExportGraph(root, id, opts);
  let meshes = 0;
  graph.traverse((o: any) => { if (o.isMesh || o.isPoints || o.isLine) meshes++; });
  if (!meshes) throw new Error(opts.scope === 'all' ? 'Nothing to export' : 'Nothing visible to export');
  return withCleanData(graph, async () => {
    switch (id) {
      case 'glb':
      case 'gltf': {
        const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
        const out = await new GLTFExporter().parseAsync(graph, { binary: id === 'glb', onlyVisible: false, animations: clipsFor(graph, opts.clips) });
        return id === 'glb'
          ? new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' })
          : new Blob([JSON.stringify(out, null, 2)], { type: 'model/gltf+json' });
      }
      case 'stl':
      case 'stl-ascii': {
        const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
        const out: any = new STLExporter().parse(graph, { binary: id === 'stl' });
        return new Blob([out], { type: 'model/stl' });
      }
      case 'obj': {
        const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
        return new Blob([new OBJExporter().parse(graph)], { type: 'text/plain' });
      }
      case 'obj-zip':
        return exportObjZip(graph, root.name || 'model');
      case 'ply': {
        const { PLYExporter } = await import('three/addons/exporters/PLYExporter.js');
        const out = await new Promise<any>((res) => new PLYExporter().parse(graph, res, { binary: true }));
        return new Blob([out], { type: 'application/octet-stream' });
      }
      case '3mf':
        return export3MF(graph, outputUnit(id, opts)!, !!opts.perTriangleColors);
      case 'usdz': {
        const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
        const out = await new USDZExporter().parseAsync(graph);
        return new Blob([out as BlobPart], { type: 'model/vnd.usdz+zip' });
      }
    }
    throw new Error('Unknown export format');
  });
}

/** Exports what the viewer shows: display overrides removed, file axes and units from the viewer state. */
export async function exportModel(viewer: Viewer, id: ExportId, target?: THREE.Object3D, opts: ExportOptions = {}): Promise<Blob> {
  const model = target ?? viewer.model;
  if (!model) throw new Error('Nothing to export');
  return viewer.withCleanModel(async () => {
    viewer.world.updateMatrixWorld(true);
    // Placement relative to the (display-rotated) world group = the file's own frame.
    const rel = viewer.world.matrixWorld.clone().invert().multiply(model.matrixWorld);
    return exportObject(model, id, { up: viewer.upAxis, clips: viewer.clips, ...opts, relMatrix: rel });
  });
}

// ------------------------------------------------------------------ preflight report (OV-016)

export interface ExportReport {
  parts: number;
  hiddenParts: number;
  kept: string[];
  lost: string[];
  warnings: string[];
  /** size of the exported model, in the file's own unit */
  size: THREE.Vector3;
  sizeUnit: UnitId | null;
  /** true when something meaningful is lost that the user should see before downloading */
  needsReview: boolean;
}

/** Describes what an export will contain and lose, for the current model, before the user downloads it. */
export function describeExport(root: THREE.Object3D, id: ExportId, opts: ExportOptions): ExportReport {
  const f = formatById(id);
  let parts = 0, hidden = 0, textures = 0, vcolors = 0, points = 0, lines = 0, multiMat = false;
  const mats = new Set<THREE.Material>();
  const isShownIn = (o: THREE.Object3D | null) => { while (o && o !== root.parent) { if (!o.visible) return false; o = o.parent; } return true; };
  root.traverse((o: any) => {
    if (o.userData.helper || o.userData.proxy) return;
    if (!(o.isMesh || o.isPoints || o.isLine)) return;
    if (!isShownIn(o)) { hidden++; if ((opts.scope ?? 'visible') === 'visible') return; }
    parts++;
    if (o.isPoints) points++;
    if (o.isLine && !o.isMesh) lines++;
    if (o.geometry?.attributes?.color) vcolors++;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    if (list.length > 1) multiMat = true;
    for (const m of list) if (m) { mats.add(m); for (const k of Object.keys(m)) if ((m as any)[k]?.isTexture) textures++; }
  });
  const clips = (opts.clips ?? []).length;
  const kept: string[] = ['geometry'];
  const lost: string[] = [];
  const add = (have: boolean, keep: boolean, label: string) => { if (have) (keep ? kept : lost).push(label); };
  add(mats.size > 1 || [...mats].some((m: any) => m.color && m.color.getHex() !== 0xb4b8bd), f.keeps.materials, 'materials and colours');
  add(textures > 0, f.keeps.textures, `${textures} texture${textures === 1 ? '' : 's'}`);
  add(vcolors > 0, f.keeps.vertexColors || (id === '3mf' && !!opts.perTriangleColors), 'painted vertex colours');
  add(clips > 0, f.keeps.animation, `${clips} animation${clips === 1 ? '' : 's'}`);
  add(points > 0, f.keeps.points, 'point clouds');
  add(lines > 0, f.keeps.lines, 'lines / toolpaths');
  if (parts > 1) (f.keeps.hierarchy || id === '3mf' ? kept : lost).push(id === '3mf' ? 'separate objects' : 'part structure');
  if (id === '3mf' && vcolors && !opts.perTriangleColors) lost.push('painted detail (one colour per object)');
  if (id === '3mf' && multiMat) lost.push('multiple materials per part (first one kept)');
  const warnings: string[] = [];
  if (hidden && (opts.scope ?? 'visible') === 'visible') warnings.push(`${hidden} hidden part${hidden === 1 ? ' is' : 's are'} left out.`);
  if (hidden && opts.scope === 'all') warnings.push(`${hidden} hidden part${hidden === 1 ? ' is' : 's are'} included.`);
  if ((opts.unit ?? 'mm') === 'u' && f.convention === 'metres-y') warnings.push('The model has no real units, so its size in metres is a guess. Set the file units first.');
  const sizeUnit = outputUnit(id, opts);
  let size = new THREE.Vector3();
  try {
    const g = buildExportGraph(root, id, opts);
    const box = new THREE.Box3().setFromObject(g);
    if (!box.isEmpty()) size = box.getSize(new THREE.Vector3());
  } catch { /* nothing visible */ }
  return { parts, hiddenParts: hidden, kept, lost, warnings, size, sizeUnit, needsReview: lost.length > 0 || warnings.length > 0 };
}

// ------------------------------------------------------------------ helpers

export function download(blob: Blob | string, filename: string) {
  const a = document.createElement('a');
  a.href = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Safe file name that keeps letters from every language (OV-019). */
export function safeFileName(name: string, fallback = 'model') {
  const n = name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n || fallback;
}

const UNIT_3MF: Record<string, string> = { mm: 'millimeter', cm: 'centimeter', m: 'meter', in: 'inch', ft: 'foot', u: 'millimeter' };
const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));

/** Writes a 3MF package: one object per mesh, welded vertices, a display colour per object or per triangle. */
function export3MF(root: THREE.Object3D, unit: string, perTriangle: boolean): Blob {
  const objects: string[] = [], items: string[] = [], bases: string[] = [], groups: string[] = [];
  const v = new THREE.Vector3();
  let id = 2;
  let nextRes = 1000;
  root.updateMatrixWorld(true);
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const g: THREE.BufferGeometry = o.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const map = new Map<string, number>();
    const verts: string[] = [], tris: string[] = [];
    const vid = (i: number) => {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const k = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
      let n = map.get(k);
      if (n === undefined) { n = map.size; map.set(k, n); verts.push(`<vertex x="${v.x.toFixed(5)}" y="${v.y.toFixed(5)}" z="${v.z.toFixed(5)}"/>`); }
      return n;
    };
    const count = g.index ? g.index.count : pos.count;
    const flip = o.matrixWorld.determinant() < 0;
    const colorAttr = perTriangle ? g.attributes.color : undefined;
    const colorIndex = new Map<string, number>();
    const colors: string[] = [];
    const groupId = colorAttr ? nextRes++ : 0;
    const c = new THREE.Color();
    for (let t = 0; t < count; t += 3) {
      const i0 = g.index ? g.index.getX(t) : t, i1 = g.index ? g.index.getX(t + 1) : t + 1, i2 = g.index ? g.index.getX(t + 2) : t + 2;
      const a = vid(i0), b = vid(i1), cc = vid(i2);
      if (a === b || b === cc || a === cc) continue;
      let props = '';
      if (colorAttr) {
        const pi = [i0, i1, i2].map((i) => {
          c.fromBufferAttribute(colorAttr as THREE.BufferAttribute, i);
          const hex = '#' + c.getHexString(THREE.SRGBColorSpace).toUpperCase();
          let n = colorIndex.get(hex);
          if (n === undefined) { n = colors.length; colorIndex.set(hex, n); colors.push(`<m:color color="${hex}FF"/>`); }
          return n;
        });
        props = ` pid="${groupId}" p1="${pi[0]}" p2="${flip ? pi[2] : pi[1]}" p3="${flip ? pi[1] : pi[2]}"`;
      }
      tris.push(flip ? `<triangle v1="${a}" v2="${cc}" v3="${b}"${props}/>` : `<triangle v1="${a}" v2="${b}" v3="${cc}"${props}/>`);
    }
    if (!tris.length) return;
    const m: any = Array.isArray(o.material) ? o.material[0] : o.material;
    const col = m?.color && !m.vertexColors ? '#' + m.color.getHexString(THREE.SRGBColorSpace).toUpperCase() + 'FF' : '#B4B8BDFF';
    bases.push(`<base name="${xml(m?.name || 'Material ' + (bases.length + 1))}" displaycolor="${col}"/>`);
    if (colorAttr) groups.push(`<m:colorgroup id="${groupId}">${colors.join('')}</m:colorgroup>`);
    objects.push(`<object id="${id}" type="model" pid="1" pindex="${bases.length - 1}" name="${xml(o.name || 'Object ' + (id - 1))}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
    id++;
  });
  if (!objects.length) throw new Error('Nothing visible to export');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${UNIT_3MF[unit] || 'millimeter'}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<metadata name="Application">OMNIVIEWER by BANKASI MEDIA</metadata>
<resources><basematerials id="1">${bases.join('')}</basematerials>${groups.join('')}${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  };
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'model/3mf' });
}

/** OBJ + MTL + texture images in one ZIP (OV-020). */
async function exportObjZip(graph: THREE.Object3D, baseName: string): Promise<Blob> {
  const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
  const stem = safeFileName(baseName.replace(/\.[^.]+$/, '')).replace(/\s+/g, '_');
  const mats = new Map<THREE.Material, string>();
  const restore: [THREE.Material, string][] = [];
  graph.traverse((o: any) => {
    if (!o.isMesh) return;
    const m: THREE.Material = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || mats.has(m)) return;
    const name = `mat_${mats.size + 1}`;
    mats.set(m, name);
    restore.push([m, m.name]);
    m.name = name;
  });
  const files: Record<string, Uint8Array> = {};
  try {
    const obj = `mtllib ${stem}.mtl\n` + new OBJExporter().parse(graph);
    files[`${stem}.obj`] = strToU8(obj);
    const mtl: string[] = [];
    let tex = 0;
    for (const [m, name] of mats) {
      const mm: any = m;
      mtl.push(`newmtl ${name}`);
      if (mm.color) { const c = mm.color; mtl.push(`Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`); }
      if (mm.opacity !== undefined && mm.opacity < 1) mtl.push(`d ${mm.opacity.toFixed(3)}`);
      if (mm.map?.image) {
        const png = await imageToPng(mm.map.image);
        if (png) { const fn = `texture_${++tex}.png`; files[fn] = png; mtl.push(`map_Kd ${fn}`); }
      }
      mtl.push('');
    }
    files[`${stem}.mtl`] = strToU8(mtl.join('\n'));
  } finally {
    restore.forEach(([m, n]) => (m.name = n));
  }
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'application/zip' });
}

async function imageToPng(image: any): Promise<Uint8Array | null> {
  try {
    if (typeof document === 'undefined') return null;
    const w = image.width || image.videoWidth, h = image.height || image.videoHeight;
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    if (image.data && !(image instanceof ImageBitmap)) {
      const data = new Uint8ClampedArray(image.data.buffer ? image.data.buffer : image.data);
      if (data.length !== w * h * 4) return null;
      g.putImageData(new ImageData(data, w, h), 0, 0);
    } else g.drawImage(image, 0, 0);
    const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}

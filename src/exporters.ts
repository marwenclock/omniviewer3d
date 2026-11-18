import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { Viewer } from './viewer';
import { writeOFF, writeDXF, writeX3D, writeVRML, writeAMF, writeXYZ } from './writers';
import { writeFBX, writeDAE, writeKMZ, write3DS, writeUSDA, writeLWO, writeVOX, writeMD2, writeSTEP, writeIGES, writeBREP, write3DM, writeIFC, writeDRC, writeVTK, writeVTP, writePCD, writePTS, writeLAS, writeSPLAT, writeSPZ, writeKSPLAT, writeGCODE, writeBVH, writePDB, type PdbAtom } from './writers2';

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
  /** section in the converter list */
  group: 'print' | 'web' | 'apps' | 'cad' | 'data';
  /** words people search for: programs, uses, devices (converter search) */
  tags: string;
  /** other extensions for the same format (.stp for STEP, .vrml for WRL...) the user can pick */
  alias?: readonly string[];
  /** what the content must contain for this format to make sense */
  needs?: 'mesh' | 'points' | 'lines' | 'skeleton' | 'atoms';
}

const K = (materials: boolean, textures: boolean, vertexColors: boolean, animation: boolean, hierarchy: boolean, points = false, lines = false) =>
  ({ materials, textures, vertexColors, animation, hierarchy, points, lines });

export const EXPORT_FORMATS = [
  { id: 'glb', label: 'GLB (binary glTF)', ext: 'glb', convention: 'metres-y', keeps: K(true, true, true, true, true, true, true), group: 'web',
    tags: 'gltf web ar unity unreal godot three.js babylon blender game engine sketchfab vr quest roblox model-viewer shopify',
    note: 'Web, games and AR. Materials, textures, colours and animation; real-world size in metres.' },
  { id: 'gltf', label: 'glTF (JSON)', ext: 'gltf', convention: 'metres-y', keeps: K(true, true, true, true, true, true, true), group: 'web',
    tags: 'glb web json text three.js babylon cesium',
    note: 'Same as GLB as readable text with embedded data.' },
  { id: 'stl', label: 'STL (binary)', ext: 'stl', convention: 'unitless', keeps: K(false, false, false, false, false), group: 'print', needs: 'mesh',
    tags: '3d printing print slicer cura prusaslicer bambu studio orca chitubox lychee resin fdm thingiverse printables cnc',
    note: 'For 3D printing. Geometry only, no units stored (written in millimetres by default).' },
  { id: 'stl-ascii', label: 'STL (ASCII)', ext: 'stl', convention: 'unitless', keeps: K(false, false, false, false, false), group: 'print', needs: 'mesh',
    tags: '3d printing text readable stl',
    note: 'Readable text STL. Geometry only.' },
  { id: '3mf', label: '3MF', ext: '3mf', convention: 'declared', keeps: K(true, false, true, false, false), group: 'print', needs: 'mesh',
    tags: '3d printing color colour multi material bambu studio prusaslicer orca cura windows 3d builder units',
    note: 'Modern printing format. Separate objects, declared units, one colour per object or per triangle.' },
  { id: 'amf', label: 'AMF', ext: 'amf', convention: 'declared', keeps: K(true, false, false, false, true), group: 'print', needs: 'mesh',
    tags: '3d printing additive manufacturing xml colour color prusaslicer slic3r cura',
    note: 'Additive Manufacturing Format (XML). Separate objects with a colour each, declared units.' },
  { id: 'obj', label: 'OBJ', ext: 'obj', convention: 'unitless', keeps: K(false, false, false, false, true, true, true), group: 'apps',
    tags: 'wavefront blender maya 3ds max cinema 4d zbrush meshlab universal any program',
    note: 'Geometry, normals and UVs. No materials (use OBJ + MTL for those).' },
  { id: 'obj-zip', label: 'OBJ + MTL + textures (ZIP)', ext: 'zip', convention: 'unitless', keeps: K(true, true, false, false, true, true, true), group: 'apps',
    tags: 'wavefront materials textures mtl blender maya 3ds max cinema 4d zbrush sketchup',
    note: 'OBJ with a material file and texture images, packed in one ZIP.' },
  { id: 'ply', label: 'PLY (binary)', ext: 'ply', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data',
    tags: 'stanford scan scanning photogrammetry meshlab cloudcompare vertex colours colors painted point cloud',
    note: 'Geometry and painted vertex colours. No materials or textures.' },
  { id: 'ply-ascii', label: 'PLY (ASCII)', ext: 'ply', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data',
    tags: 'stanford text readable scan point cloud vertex colours',
    note: 'Readable text PLY with vertex colours.' },
  { id: 'usdz', label: 'USDZ', ext: 'usdz', convention: 'metres-y', keeps: K(true, true, false, false, true), group: 'web',
    tags: 'apple iphone ipad vision pro ar quick look reality composer usd pixar',
    note: 'Apple AR Quick Look. Basic materials and textures; real-world size in metres.' },
  { id: 'x3d', label: 'X3D', ext: 'x3d', convention: 'metres-y', keeps: K(true, false, true, false, false, true, true), group: 'web',
    tags: 'web3d x3dom xml iso standard vrml successor science education',
    note: 'ISO web 3D standard (XML). One colour per part and vertex colours, in metres.' },
  { id: 'wrl', label: 'VRML 2.0 (WRL)', ext: 'wrl', alias: ['vrml'], convention: 'metres-y', keeps: K(true, false, true, false, false), group: 'apps', needs: 'mesh',
    tags: 'vrml wrl legacy 3d printing colour color full colour full color sandstone shapeways matlab',
    note: 'Classic VRML 97 with colours. Still used for full-colour printing services.' },
  { id: 'dxf', label: 'DXF (3D faces)', ext: 'dxf', convention: 'unitless', keeps: K(false, false, false, false, true, false, true), group: 'cad',
    tags: 'autocad cad drawing 3dface librecad fusion rhino sketchup layers',
    note: 'AutoCAD exchange file with every triangle as a 3D face, one layer per part. Not a solid model.' },
  { id: 'off', label: 'OFF', ext: 'off', convention: 'unitless', keeps: K(false, false, true, false, false), group: 'data', needs: 'mesh',
    tags: 'object file format geomview research cgal meshlab academic',
    note: 'Simple research mesh format (vertex colours as COFF).' },
  { id: 'fbx', label: 'FBX', ext: 'fbx', convention: 'declared', keeps: K(true, false, true, false, true), group: 'apps', needs: 'mesh',
    tags: 'autodesk unity unreal blender maya 3ds max roblox mixamo game engine motionbuilder cinema 4d',
    note: 'Binary FBX 7.4 for Unity, Unreal, Blender and Maya. Parts, colours and vertex colours, unit declared. No textures or animation yet.' },
  { id: 'dae', label: 'COLLADA (DAE)', ext: 'dae', convention: 'declared', keeps: K(true, false, true, false, true), group: 'apps', needs: 'mesh',
    tags: 'collada sketchup blender unity cinema 4d xml khronos',
    note: 'Open XML exchange format. Parts with a colour each, vertex colours, unit and up axis declared.' },
  { id: 'kmz', label: 'KMZ (Google Earth)', ext: 'kmz', convention: 'declared', keeps: K(true, false, true, false, true), group: 'web', needs: 'mesh',
    tags: 'google earth kml map sketchup gis',
    note: 'A COLLADA model wrapped for Google Earth.' },
  { id: '3ds', label: '3DS (3D Studio)', ext: '3ds', convention: 'unitless', keeps: K(true, false, false, false, true), group: 'apps', needs: 'mesh',
    tags: 'autodesk 3ds max 3d studio legacy game',
    note: 'Classic 3D Studio format. Parts (split at 65,535 vertices) with a colour each; names up to 10 letters.' },
  { id: 'usda', label: 'USD (text)', ext: 'usda', alias: ['usd'], convention: 'declared', keeps: K(true, false, true, false, true), group: 'web', needs: 'mesh',
    tags: 'usd pixar omniverse nvidia houdini blender apple vision pro maya',
    note: 'Universal Scene Description as text (.usda or .usd). Parts, colours, unit and up axis. For a binary package use USDZ.' },
  { id: 'lwo', label: 'LightWave (LWO)', ext: 'lwo', convention: 'metres-y', keeps: K(true, false, false, false, true), group: 'apps', needs: 'mesh',
    tags: 'lightwave newtek lwo2',
    note: 'LightWave object (LWO2) with one surface per part, in metres.' },
  { id: 'vox', label: 'MagicaVoxel (VOX)', ext: 'vox', convention: 'unitless', keeps: K(true, false, true, false, false), group: 'apps', needs: 'mesh',
    tags: 'voxel magicavoxel minecraft pixel game teardown',
    note: 'Voxelised: about 128 voxels along the longest side, solid inside, coloured from the parts.' },
  { id: 'md2', label: 'Quake MD2', ext: 'md2', convention: 'unitless', keeps: K(false, false, false, false, false), group: 'apps', needs: 'mesh',
    tags: 'quake id tech game retro mod',
    note: 'Classic game model, one frame, up to 2,048 vertices; positions stored with 8-bit precision.' },
  { id: 'step', label: 'STEP (faceted)', ext: 'step', alias: ['stp'], convention: 'declared', keeps: K(false, false, false, false, true), group: 'cad', needs: 'mesh',
    tags: 'cad stp solidworks fusion 360 freecad onshape inventor catia creo ap214 solid stl to step',
    note: 'For CAD programs. Every triangle becomes a flat face (a solid if the mesh is closed). Not a smooth, editable CAD model.' },
  { id: 'iges', label: 'IGES (faceted)', ext: 'iges', alias: ['igs'], convention: 'declared', keeps: K(false, false, false, false, false), group: 'cad', needs: 'mesh',
    tags: 'cad igs legacy surfaces mastercam',
    note: 'Older CAD exchange. Every triangle becomes a trimmed flat surface. Large files for big meshes.' },
  { id: 'brep', label: 'OpenCascade BREP', ext: 'brep', alias: ['brp'], convention: 'unitless', keeps: K(false, false, false, false, false), group: 'cad', needs: 'mesh',
    tags: 'opencascade occt freecad cad brp',
    note: 'OpenCascade shape (FreeCAD). Every triangle becomes a flat face. No units stored.' },
  { id: '3dm', label: 'Rhino 3DM', ext: '3dm', convention: 'declared', keeps: K(true, false, true, false, true), group: 'cad', needs: 'mesh',
    tags: 'rhino rhinoceros grasshopper mcneel',
    note: 'Rhino file with one named mesh per part, its colour and the model unit.' },
  { id: 'ifc', label: 'IFC (BIM)', ext: 'ifc', convention: 'declared', keeps: K(true, false, false, false, true), group: 'cad', needs: 'mesh',
    tags: 'bim revit archicad building ifc4 architecture',
    note: 'IFC4 with one building element per part (triangulated, coloured) in a site, building and storey.' },
  { id: 'drc', label: 'Draco (DRC)', ext: 'drc', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'web',
    tags: 'google draco compressed compression web small',
    note: 'Google Draco compression: one small mesh (or point cloud) with vertex colours.' },
  { id: 'vtk', label: 'VTK (legacy)', ext: 'vtk', convention: 'unitless', keeps: K(false, false, true, false, false, true, true), group: 'data',
    tags: 'paraview kitware scientific simulation visualization',
    note: 'ParaView / VTK polydata (text) with points, lines, triangles and colours.' },
  { id: 'vtp', label: 'VTP (VTK XML)', ext: 'vtp', convention: 'unitless', keeps: K(false, false, true, false, false), group: 'data', needs: 'mesh',
    tags: 'paraview kitware scientific xml polydata',
    note: 'ParaView XML polydata with triangles and colours.' },
  { id: 'pcd', label: 'PCD point cloud', ext: 'pcd', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data', needs: 'points',
    tags: 'pcl point cloud library robotics ros lidar',
    note: 'Point Cloud Library format with colour. Meshes are written as their vertices.' },
  { id: 'pts', label: 'PTS point cloud', ext: 'pts', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data', needs: 'points',
    tags: 'leica cyclone recap scanner laser scan',
    note: 'Text point cloud (Leica / ReCap style) with colour. Meshes are written as their vertices.' },
  { id: 'las', label: 'LAS point cloud', ext: 'las', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data', needs: 'points',
    tags: 'lidar survey gis drone cloudcompare',
    note: 'LAS 1.2 with RGB. Meshes are written as their vertices.' },
  { id: 'splat', label: 'Gaussian splat (.splat)', ext: 'splat', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'web', needs: 'points',
    tags: 'gaussian splat 3dgs radiance field points',
    note: 'Every vertex or point becomes a small round splat. Not a photo-real capture.' },
  { id: 'spz', label: 'Gaussian splat (.spz)', ext: 'spz', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'web', needs: 'points',
    tags: 'gaussian splat 3dgs niantic compressed scaniverse',
    note: 'Compressed splats (Niantic SPZ). Every vertex or point becomes a small round splat.' },
  { id: 'ksplat', label: 'Gaussian splat (.ksplat)', ext: 'ksplat', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'web', needs: 'points',
    tags: 'gaussian splat 3dgs ksplat gaussiansplats3d',
    note: 'Splats for the GaussianSplats3D viewer. Every vertex or point becomes a small round splat.' },
  { id: 'gcode', label: 'G-code (lines)', ext: 'gcode', alias: ['gco'], convention: 'unitless', keeps: K(false, false, false, false, false, false, true), group: 'print', needs: 'lines',
    tags: 'gcode toolpath cnc printer lines',
    note: 'Toolpaths and lines as G0 / G1 moves, without extrusion. To print a mesh, export 3MF or STL and slice it.' },
  { id: 'bvh', label: 'BVH motion', ext: 'bvh', convention: 'unitless', keeps: K(false, false, false, true, true), group: 'apps', needs: 'skeleton',
    tags: 'motion capture mocap skeleton animation mixamo',
    note: 'A skeleton and its first animation at 30 frames per second.' },
  { id: 'pdb', label: 'PDB molecule', ext: 'pdb', convention: 'unitless', keeps: K(false, false, false, false, false), group: 'data', needs: 'atoms',
    tags: 'protein molecule chemistry biology',
    note: 'Atoms of a molecule opened from a PDB file, written back as HETATM records.' },
  { id: 'xyz', label: 'XYZ point list', ext: 'xyz', convention: 'unitless', keeps: K(false, false, true, false, false, true, false), group: 'data', needs: 'points',
    tags: 'point cloud points csv text coordinates cloudcompare lidar survey vertices',
    note: 'Plain text x y z (and colour) per point. Meshes are written as their vertices.' },
] as const satisfies readonly ExportFormat[];

export type ExportId = (typeof EXPORT_FORMATS)[number]['id'];
export const formatById = (id: ExportId) => EXPORT_FORMATS.find((f) => f.id === id)!;
export const isUnitless = (id: ExportId) => formatById(id).convention === 'unitless';
export const isPrintFormat = (id: ExportId) => id === 'stl' || id === 'stl-ascii' || id === '3mf' || id === 'amf' || id === 'dxf' || id === 'gcode';

export type ExportScope = 'visible' | 'all';
/** Web formats that stay Y-up (no "stand upright for printing" option). */
export const staysYUp = (id: ExportId) => ['drc', 'splat', 'spz', 'ksplat'].includes(id);

/** Why this format can't hold what is open (null = it can). Shown in the converter instead of a failed download. */
export function exportBlocker(root: THREE.Object3D, id: ExportId): string | null {
  const need = (formatById(id) as ExportFormat).needs;
  let mesh = false, pts = false, line = false, bone = false, atoms = false;
  root.traverse((o: any) => {
    if (o.userData?.helper) return;
    if (o.isMesh) mesh = true; else if (o.isPoints) pts = true; else if (o.isLine) line = true;
    if (o.isBone) bone = true; if (o.userData?.pdbAtoms) atoms = true;
  });
  const name = formatById(id).label;
  if (need === 'mesh' && !mesh) return `${name} stores surfaces, and this model has none (it is ${pts ? 'a point cloud' : line ? 'lines or a toolpath' : 'empty'}).`;
  if (need === 'points' && !mesh && !pts) return `${name} stores points, and this model has none.`;
  if (need === 'lines' && !line) return 'G-code is a machine toolpath. To print this model, convert it to 3MF or STL and slice it in PrusaSlicer, Bambu Studio or Cura.';
  if (need === 'skeleton' && !bone) return 'BVH stores a skeleton and its motion; this model has no skeleton.';
  if (need === 'atoms' && !atoms) return 'PDB stores the atoms of a molecule; only molecules opened from a PDB file can be saved as PDB.';
  return null;
}

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
  const blocked = exportBlocker(root, id);
  if (blocked) throw new Error(blocked);
  let atoms: PdbAtom[] | undefined;
  root.traverse((o) => { if (!atoms && o.userData?.pdbAtoms) atoms = o.userData.pdbAtoms; });
  const graph = buildExportGraph(root, id, opts);
  let meshes = 0;
  graph.traverse((o: any) => { if (o.isMesh || o.isPoints || o.isLine || (id === 'bvh' && o.isBone)) meshes++; });
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
      case 'ply':
      case 'ply-ascii': {
        const { PLYExporter } = await import('three/addons/exporters/PLYExporter.js');
        const out = await new Promise<any>((res) => new PLYExporter().parse(graph, res, { binary: id === 'ply' }));
        return new Blob([out], { type: id === 'ply' ? 'application/octet-stream' : 'text/plain' });
      }
      case 'off': return new Blob([writeOFF(graph)], { type: 'text/plain' });
      case 'dxf': return new Blob([writeDXF(graph, outputUnit(id, opts)!)], { type: 'image/vnd.dxf' });
      case 'x3d': return new Blob([writeX3D(graph, root.name || 'model')], { type: 'model/x3d+xml' });
      case 'wrl': return new Blob([writeVRML(graph)], { type: 'model/vrml' });
      case 'amf': return new Blob([writeAMF(graph, outputUnit(id, opts)!)], { type: 'application/x-amf' });
      case 'xyz': return new Blob([writeXYZ(graph)], { type: 'text/plain' });
      case 'fbx': return new Blob([writeFBX(graph, outputUnit(id, opts)!, fileUp(opts)) as BlobPart], { type: 'application/octet-stream' });
      case 'dae': return new Blob([writeDAE(graph, outputUnit(id, opts)!, fileUp(opts))], { type: 'model/vnd.collada+xml' });
      case 'kmz': return new Blob([writeKMZ(graph, outputUnit(id, opts)!, fileUp(opts), root.name || 'model') as BlobPart], { type: 'application/vnd.google-earth.kmz' });
      case '3ds': return new Blob([write3DS(graph) as BlobPart], { type: 'application/x-3ds' });
      case 'usda': return new Blob([writeUSDA(graph, outputUnit(id, opts)!, fileUp(opts))], { type: 'model/vnd.usda' });
      case 'lwo': return new Blob([writeLWO(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'vox': return new Blob([writeVOX(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'md2': return new Blob([writeMD2(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'step': return new Blob([writeSTEP(graph, outputUnit(id, opts)!, root.name || 'model')], { type: 'model/step' });
      case 'iges': return new Blob([writeIGES(graph, outputUnit(id, opts)!, root.name || 'model')], { type: 'model/iges' });
      case 'brep': return new Blob([writeBREP(graph)], { type: 'text/plain' });
      case '3dm': return new Blob([await write3DM(graph, outputUnit(id, opts)!) as BlobPart], { type: 'application/octet-stream' });
      case 'ifc': return new Blob([writeIFC(graph, outputUnit(id, opts)!, root.name || 'model')], { type: 'application/x-step' });
      case 'drc': return new Blob([await writeDRC(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'vtk': return new Blob([writeVTK(graph, root.name || 'model')], { type: 'text/plain' });
      case 'vtp': return new Blob([writeVTP(graph)], { type: 'text/xml' });
      case 'pcd': return new Blob([writePCD(graph)], { type: 'text/plain' });
      case 'pts': return new Blob([writePTS(graph)], { type: 'text/plain' });
      case 'las': return new Blob([writeLAS(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'splat': return new Blob([writeSPLAT(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'spz': return new Blob([writeSPZ(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'ksplat': return new Blob([writeKSPLAT(graph) as BlobPart], { type: 'application/octet-stream' });
      case 'gcode': return new Blob([writeGCODE(graph, outputUnit(id, opts)!)], { type: 'text/x-gcode' });
      case 'bvh': return new Blob([writeBVH(graph, clipsFor(graph, opts.clips))], { type: 'text/plain' });
      case 'pdb': return new Blob([writePDB(atoms, root.name || 'molecule')], { type: 'chemical/x-pdb' });
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

/** Axes of the written file: Z-up when the model is Z-up or was stood upright for printing / CAD. */
const fileUp = (opts: ExportOptions): 'y' | 'z' => (opts.up === 'z' || opts.zUp ? 'z' : 'y');

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
  if (['xyz', 'pcd', 'pts', 'las', 'splat', 'spz', 'ksplat'].includes(id) && parts > points) lost.push(id.includes('splat') || id === 'spz' ? 'surfaces (each vertex becomes a splat)' : 'surfaces (only the vertices are written, as points)');
  if (id === 'vox') lost.push('exact shape (voxelised to about 128 voxels along the longest side)');
  if (id === 'step' || id === 'iges' || id === 'brep') kept.push('flat faces (one per triangle)');
  if ((id === 'x3d' || id === 'wrl' || id === 'amf') && multiMat) lost.push('multiple materials per part (first one kept)');
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

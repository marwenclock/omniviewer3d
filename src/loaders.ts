import * as THREE from 'three';
import { unzipSync, unzip } from 'fflate';
import { parseX3D, parseDXF, parsePTS, parseLAS, sniffFormat, PROPRIETARY, ProprietaryFormatError } from './formats-extra';

/** Resolves a path inside public/libs relative to the page, so it works on any sub-path. */
export const libUrl = (path: string) => new URL(`libs/${path}`, document.baseURI).href;

export interface FormatInfo {
  ext: string[];
  name: string;
  /** true for formats that need companion files (textures, .mtl, .bin...) */
  companions?: boolean;
}

/** Every format OMNIVIEWER can open. Used for the file picker and the "supported formats" list. */
export const FORMATS: FormatInfo[] = [
  { ext: ['glb', 'gltf'], name: 'glTF / GLB', companions: true },
  { ext: ['obj'], name: 'Wavefront OBJ (+MTL)', companions: true },
  { ext: ['fbx'], name: 'Autodesk FBX', companions: true },
  { ext: ['stl'], name: 'STL' },
  { ext: ['step', 'stp'], name: 'STEP (CAD)' },
  { ext: ['iges', 'igs'], name: 'IGES (CAD)' },
  { ext: ['brep', 'brp'], name: 'OpenCascade BREP' },
  { ext: ['3dm'], name: 'Rhinoceros 3DM' },
  { ext: ['ifc'], name: 'IFC (BIM)' },
  { ext: ['3mf'], name: '3D Manufacturing (3MF)' },
  { ext: ['ply'], name: 'Stanford PLY' },
  { ext: ['dae'], name: 'Collada DAE', companions: true },
  { ext: ['3ds'], name: '3D Studio', companions: true },
  { ext: ['usdz', 'usd', 'usda', 'usdc'], name: 'Universal Scene Description' },
  { ext: ['off'], name: 'Object File Format (OFF)' },
  { ext: ['amf'], name: 'Additive Manufacturing (AMF)' },
  { ext: ['wrl', 'vrml'], name: 'VRML', companions: true },
  { ext: ['vtk', 'vtp'], name: 'VTK' },
  { ext: ['lwo'], name: 'LightWave', companions: true },
  { ext: ['kmz'], name: 'Google KMZ' },
  { ext: ['vox'], name: 'MagicaVoxel' },
  { ext: ['md2'], name: 'Quake MD2' },
  { ext: ['pcd'], name: 'Point Cloud Data' },
  { ext: ['xyz'], name: 'XYZ point cloud' },
  { ext: ['gcode', 'gco'], name: 'G-code toolpath' },
  { ext: ['splat', 'ksplat', 'spz'], name: 'Gaussian splats (also 3DGS .ply)' },
  { ext: ['drc'], name: 'Draco compressed mesh' },
  { ext: ['x3d'], name: 'X3D (XML)' },
  { ext: ['dxf'], name: 'DXF (3D faces, polyface meshes, lines)' },
  { ext: ['las'], name: 'LAS LiDAR point cloud' },
  { ext: ['pts'], name: 'PTS point cloud' },
  { ext: ['bvh'], name: 'BVH motion capture' },
  { ext: ['pdb'], name: 'Protein Data Bank (molecules)' },
  { ext: ['zip'], name: 'ZIP archive of any of the above' },
];

export const MODEL_EXTS = new Set(FORMATS.flatMap((f) => f.ext).filter((e) => e !== 'zip'));
export const ACCEPT = FORMATS.flatMap((f) => f.ext).map((e) => '.' + e).join(',') +
  ',.mtl,.bin,.png,.jpg,.jpeg,.webp,.bmp,.tga,.gif,.ktx2,.dds,.tif,.tiff,.omniproj';

export const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
/** Files that travel with a model (textures, material libraries, buffers): never sniffed as models. */
const COMPANION_EXTS = new Set(['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'gif', 'ktx2', 'dds', 'tif', 'tiff', 'hdr', 'exr', 'txt', 'md', 'pdf', 'json', 'omniproj']);

/**
 * Value for <input type="file" accept>. Phones and tablets (iOS especially) grey out any file whose type the
 * OS does not recognise, which includes STL, STEP and most 3D formats, so there we allow every file and let the
 * loader reject anything unsupported.
 */
export function pickerAccept(): string {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod|Android/i.test(ua) || iPadOS ? '' : ACCEPT;
}
const baseName = (p: string) => decodeURIComponent(p.split(/[\\/]/).pop() || p).toLowerCase();

const DEFAULT_COLOR = 0xb4b8bd;
export const defaultMaterial = () =>
  new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide });

// ------------------------------------------------------------------ virtual file system (OV-011)
/** Relative path of each file inside a dropped folder or ZIP ("textures/wood.png"). */
export const filePaths = new WeakMap<File, string>();
export const pathOf = (f: File) => (filePaths.get(f) || f.name).replace(/\\/g, '/').replace(/^\/+/, '');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function normalizePath(p: string) {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/').toLowerCase();
}

/** Limits for ZIP archives, so a huge or malicious archive cannot freeze the tab (OV-014). */
export const ZIP_LIMITS = { entries: 20_000, bytes: 2 * 1024 ** 3 };

/** Expands ZIP archives into File objects, keeping their folder paths. Unzips off the main thread where possible. */
async function expandZips(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (extOf(f.name) !== 'zip') { out.push(f); continue; }
    const data = new Uint8Array(await f.arrayBuffer());
    let count = 0, total = 0;
    const filter = (info: { name: string; originalSize: number }) => {
      if (info.name.endsWith('/') || info.name.startsWith('__MACOSX')) return false;
      count++; total += info.originalSize;
      if (count > ZIP_LIMITS.entries) throw new Error(`${f.name} has more than ${ZIP_LIMITS.entries.toLocaleString()} files. Unzip it and open the model files directly.`);
      if (total > ZIP_LIMITS.bytes) throw new Error(`${f.name} expands to more than ${(ZIP_LIMITS.bytes / 1024 ** 3).toFixed(0)} GB. Unzip it and open the model files directly.`);
      return true;
    };
    const entries: Record<string, Uint8Array> = await new Promise((resolve, reject) => {
      // Size and count are checked from the archive directory before anything is decompressed.
      try { unzipSync(data, { filter: (i) => { filter(i); return false; } }); } catch (e) { reject(e); return; }
      count = 0; total = 0;
      try { unzip(data, { filter }, (err, res) => (err ? resolve(unzipSync(data, { filter })) : resolve(res))); }
      catch { try { resolve(unzipSync(data, { filter })); } catch (e) { reject(e); } }
    });
    const prefix = dirOf(pathOf(f));
    for (const [path, bytes] of Object.entries(entries)) {
      const file = new File([bytes as BlobPart], path.split('/').pop()!);
      filePaths.set(file, prefix + path);
      out.push(file);
    }
  }
  return out;
}

/** Physical unit a file declares (or its format defines), when known (OV-007). */
export type DeclaredUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export interface LoadResult {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  mainFiles: string[];
  warnings: string[];
  /** unit declared by the file itself or by its format specification */
  declaredUnit?: DeclaredUnit;
  /** textures / buffers that were missing, blocked or failed (OV-012, OV-104) */
  resources: ResourceInfo[];
}

export interface ResourceInfo { url: string; owner: string; status: 'loaded' | 'missing' | 'blocked' | 'failed'; resolved?: string; ambiguous?: boolean }

type Progress = (msg: string) => void;

export interface LoadOptions {
  /** base URL when the model was opened from the web: relative references resolve against it */
  baseUrl?: string;
  /** allow files on this device to fetch textures from other websites (off by default, OV-013) */
  allowRemote?: boolean;
  /** how long to wait for textures before reporting them as still loading */
  textureTimeoutMs?: number;
}

/**
 * Loads a set of files (model files plus any companions such as textures and .mtl files)
 * and returns one Object3D containing every model found.
 */
export async function loadFiles(input: File[], onProgress: Progress = () => {}, signal?: AbortSignal, opts: LoadOptions = {}): Promise<LoadResult> {
  const aborted = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  let files = await expandZips(input);
  aborted();
  const byPath = new Map<string, File>();
  const byBase = new Map<string, File[]>();
  for (const f of files) {
    byPath.set(normalizePath(pathOf(f)), f);
    const b = f.name.toLowerCase();
    byBase.set(b, [...(byBase.get(b) || []), f]);
  }
  const blobUrls = new Map<File, string>();
  const urlFor = (f: File) => { let u = blobUrls.get(f); if (!u) { u = URL.createObjectURL(f); blobUrls.set(f, u); } return u; };
  const resources: ResourceInfo[] = [];
  let pending = 0;
  let idle: (() => void) | null = null;

  /** One loading manager per model file, resolving references relative to that file's folder. */
  const managerFor = (main: File) => {
    const m = new THREE.LoadingManager();
    const dir = dirOf(pathOf(main));
    const byResolved = new Map<string, ResourceInfo>();
    const track = (info: ResourceInfo, out: string) => { byResolved.set(out, info); return out; };
    m.setURLModifier((url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return url;
      // The app's own engines and decoders (Draco, KTX2, Rhino...) are not outside requests: never block them.
      if (typeof document !== 'undefined' && url.startsWith(libUrl(''))) return url;
      const info: ResourceInfo = { url, owner: main.name, status: 'loaded' };
      resources.push(info);
      const isAbs = /^[a-z][a-z0-9+.-]*:/i.test(url);
      if (!isAbs || url.startsWith('file:')) {
        const rel = url.replace(/^file:\/+/, '');
        const exact = byPath.get(normalizePath(dir + rel)) || byPath.get(normalizePath(rel));
        if (exact) { info.resolved = pathOf(exact); return track(info, urlFor(exact)); }
        const same = byBase.get(baseName(rel)) || [];
        if (same.length) {
          // Prefer the candidate whose folder shares the most with where the file says it is.
          const want = normalizePath(dir + rel);
          const score = (f: File) => { const p = normalizePath(pathOf(f)); let i = 0; while (i < p.length && p[i] === want[i]) i++; return i; };
          const best = same.slice().sort((a, b) => score(b) - score(a))[0];
          info.resolved = pathOf(best);
          info.ambiguous = same.length > 1;
          return track(info, urlFor(best));
        }
        if (opts.baseUrl) { info.resolved = new URL(rel, opts.baseUrl).href; return track(info, info.resolved); }
        info.status = 'missing';
        return track(info, 'data:,missing-' + encodeURIComponent(rel));
      }
      if (opts.baseUrl || opts.allowRemote) return track(info, url);
      info.status = 'blocked';
      return track(info, 'data:,blocked-' + encodeURIComponent(url));
    });
    // Count requests so we wait for exactly the textures that were asked for (OV-012).
    const start = m.itemStart.bind(m), end = m.itemEnd.bind(m), error = m.itemError.bind(m);
    m.itemStart = (u: string) => { pending++; start(u); };
    m.itemEnd = (u: string) => { pending = Math.max(0, pending - 1); end(u); if (!pending) idle?.(); };
    m.itemError = (u: string) => {
      const info = byResolved.get(u);
      if (info && info.status === 'loaded') info.status = 'failed';
      error(u);
    };
    return m;
  };

  // Files with no extension or a wrong one (.bin, .dat, renamed downloads): recognise them by their content.
  files = await Promise.all(files.map(async (f) => {
    const ext = extOf(f.name);
    if (MODEL_EXTS.has(ext) || COMPANION_EXTS.has(ext) || PROPRIETARY[ext] || ext === 'zip') return f;
    const real = await sniffFormat(f).catch(() => null);
    if (!real || real === 'zip' || real === 'omniproj') return f;
    const renamed = new File([f], `${f.name.includes('.') ? f.name.slice(0, f.name.lastIndexOf('.')) : f.name}.${real}`, { type: f.type, lastModified: f.lastModified });
    filePaths.set(renamed, pathOf(f).replace(/[^/]*$/, renamed.name));
    onProgress(`${f.name} looks like a .${real} file`);
    return renamed;
  }));
  const mains = files.filter((f) => MODEL_EXTS.has(extOf(f.name)));
  if (!mains.length) {
    const prop = files.find((f) => PROPRIETARY[extOf(f.name)]);
    if (prop) throw new ProprietaryFormatError(PROPRIETARY[extOf(prop.name)], prop);
    const ex = files.map((f) => extOf(f.name)).filter((e) => !COMPANION_EXTS.has(e));
    throw new Error(ex.length ? `.${ex[0]} is not a 3D format OMNIVIEWER recognises, and its content didn't match any known format. Try exporting it as STEP, glTF, OBJ or STL.` : 'No supported 3D model was found in the selected files.');
  }

  const root = new THREE.Group();
  root.name = mains.length === 1 ? mains[0].name : 'Scene';
  const animations: THREE.AnimationClip[] = [];
  const warnings: string[] = [];
  let declaredUnit: DeclaredUnit | undefined;

  try {
    for (const file of mains) {
      onProgress(`Reading ${file.name}…`);
      try {
        const { object, clips, unit } = await loadOne(file, files, managerFor(file), onProgress, signal);
        aborted();
        if (!object.name) object.name = file.name;
        root.add(object);
        animations.push(...clips);
        if (unit && !declaredUnit) declaredUnit = unit;
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        console.error(err);
        warnings.push(`${file.name}: ${err?.message || err}`);
      }
    }
    // Wait for the textures that were actually requested (not a fixed timer), honouring Cancel.
    if (pending) {
      onProgress(`Resolving ${pending} texture${pending === 1 ? '' : 's'}…`);
      const timeout = opts.textureTimeoutMs ?? 30000;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { warnings.push(`${pending} texture${pending === 1 ? ' was' : 's were'} still loading after ${Math.round(timeout / 1000)} s.`); resolve(); }, timeout);
        idle = () => { clearTimeout(t); resolve(); };
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
        if (!pending) idle();
      });
    }
    aborted();
  } finally {
    // Release object URLs once everything that needed them has finished (OV-015).
    setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }
  for (const r of resources) {
    if (r.status === 'missing') warnings.push(`Missing file: ${baseName(r.url)} (needed by ${r.owner})`);
    if (r.status === 'blocked') warnings.push(`Blocked a request to another website: ${r.url}. Files on your device don't fetch outside resources unless you allow it in Settings.`);
    if (r.status === 'failed') warnings.push(`Could not read ${baseName(r.url)} (needed by ${r.owner})`);
    if (r.ambiguous) warnings.push(`Several files are named ${baseName(r.url)}; used ${r.resolved}.`);
  }
  if (!root.children.length) throw new Error(warnings.join('\n') || 'The model could not be loaded.');
  return { object: root.children.length === 1 ? root.children[0] : root, animations, mainFiles: mains.map((f) => f.name), warnings, declaredUnit, resources };
}

/** True when a sample of the normals is (near) zero length or not a number. */
function normalsUnusable(n: THREE.BufferAttribute): boolean {
  const count = n.count; if (!count) return true;
  const step = Math.max(1, Math.floor(count / 2000));
  let bad = 0, seen = 0;
  for (let i = 0; i < count; i += step) {
    const l = n.getX(i) ** 2 + n.getY(i) ** 2 + n.getZ(i) ** 2;
    if (!(l > 0.25)) bad++;
    seen++;
  }
  return bad / seen > 0.5;
}

function meshFromGeometry(geometry: THREE.BufferGeometry, name: string): THREE.Object3D {
  const hasFaces = geometry.index !== null || geometry.attributes.position.count % 3 === 0;
  const hasColors = !!geometry.attributes.color;
  // Missing or unusable normals (many STL exporters write 0,0,0 facet normals) render black: rebuild them.
  if (hasFaces && (!geometry.attributes.normal || normalsUnusable(geometry.attributes.normal as THREE.BufferAttribute))) geometry.computeVertexNormals();
  const mat = defaultMaterial();
  if (hasColors) { mat.vertexColors = true; mat.color.set(0xffffff); }
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

function pointsFromGeometry(geometry: THREE.BufferGeometry, name: string): THREE.Points {
  const hasColors = !!geometry.attributes.color;
  geometry.computeBoundingSphere();
  const size = (geometry.boundingSphere?.radius || 1) / 400;
  const pts = new THREE.Points(geometry, new THREE.PointsMaterial({ size, vertexColors: hasColors, color: hasColors ? 0xffffff : DEFAULT_COLOR }));
  pts.name = name;
  return pts;
}

async function loadOne(
  file: File,
  all: File[],
  manager: THREE.LoadingManager,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<{ object: THREE.Object3D; clips: THREE.AnimationClip[]; unit?: DeclaredUnit }> {
  const ext = extOf(file.name);
  const name = file.name;
  const buf = () => file.arrayBuffer();
  const text = () => file.text();
  const one = (object: THREE.Object3D, clips: THREE.AnimationClip[] = [], unit?: DeclaredUnit) => ({ object, clips, unit });

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      const loader = new GLTFLoader(manager);
      loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath(libUrl('draco/')));
      const ktx2 = new KTX2Loader(manager).setTranscoderPath(libUrl('basis/'));
      ktx2.detectSupport(getSharedRenderer());
      loader.setKTX2Loader(ktx2);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(await buf(), '');
      return one(gltf.scene, gltf.animations, 'm'); // glTF is defined in metres
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
      const src = await text();
      const loader = new OBJLoader(manager);
      const mtlNames = [...src.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => baseName(m[1]));
      const stem = name.replace(/\.obj$/i, '').toLowerCase();
      const mtlFile = all.find((f) => mtlNames.includes(f.name.toLowerCase())) ||
        all.find((f) => f.name.toLowerCase() === stem + '.mtl') ||
        all.find((f) => extOf(f.name) === 'mtl');
      if (mtlFile) {
        const materials = new MTLLoader(manager).parse(await mtlFile.text(), '');
        materials.side = THREE.DoubleSide;
        materials.preload();
        loader.setMaterials(materials);
      }
      const obj = loader.parse(src);
      obj.traverse((o: any) => {
        if (o.isMesh && !mtlFile) o.material = defaultMaterial();
      });
      return one(obj);
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const data = await buf();
      const obj = new FBXLoader(manager).parse(data, '');
      return one(obj, obj.animations || [], fbxUnit(data));
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geo = new STLLoader(manager).parse(await buf());
      return one(meshFromGeometry(geo, name));
    }
    case 'splat':
    case 'ksplat':
    case 'spz': {
      const { loadSplat } = await import('./splat');
      return one(await loadSplat(file, ext, onProgress));
    }
    case 'ply': {
      const { isSplatPly, loadSplat } = await import('./splat');
      if (await isSplatPly(file)) return one(await loadSplat(file, 'ply', onProgress));
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geo = new PLYLoader(manager).parse(await buf());
      return one(geo.index ? meshFromGeometry(geo, name) : pointsFromGeometry(geo, name));
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      const data = await buf();
      return one(new ThreeMFLoader(manager).parse(data), [], unitOf3MF(data));
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const res: any = new ColladaLoader(manager).parse(await text(), '');
      return one(res.scene, res.scene?.animations || [], 'm'); // the loader applies <unit meter>
    }
    case '3ds': {
      const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
      return one(new TDSLoader(manager).parse(await buf(), ''));
    }
    case 'amf': {
      const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
      return one(new AMFLoader(manager).parse(await buf()), [], 'mm'); // the loader converts to millimetres
    }
    case 'wrl':
    case 'vrml': {
      const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
      const scene = new VRMLLoader(manager).parse(await text(), '');
      // Drop VRML Background sky/ground spheres: they are scenery, not part of the model.
      const sky: THREE.Object3D[] = [];
      scene.traverse((o: any) => { if (o.isMesh && o.material?.side === THREE.BackSide && o.material.depthTest === false) sky.push(o); });
      sky.forEach((o) => o.removeFromParent());
      return one(scene);
    }
    case 'vtk':
    case 'vtp': {
      const { VTKLoader } = await import('three/addons/loaders/VTKLoader.js');
      const geo = new VTKLoader(manager).parse(await buf(), '');
      return one(geo.index || geo.attributes.position.count % 3 === 0 ? meshFromGeometry(geo, name) : pointsFromGeometry(geo, name));
    }
    case 'xyz': {
      const { XYZLoader } = await import('three/addons/loaders/XYZLoader.js');
      const loader = new XYZLoader(manager);
      const url = URL.createObjectURL(file);
      try {
        const geo: THREE.BufferGeometry = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
        return one(pointsFromGeometry(geo, name));
      } finally { URL.revokeObjectURL(url); }
    }
    case 'pcd': {
      const { PCDLoader } = await import('three/addons/loaders/PCDLoader.js');
      const pts = new PCDLoader(manager).parse(await buf());
      pts.name = name;
      return one(pts);
    }
    case 'usd':
    case 'usda':
    case 'usdc':
    case 'usdz': {
      const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
      const loader: any = new USDLoader(manager);
      const data = await buf();
      const obj = await new Promise<THREE.Object3D>((resolve, reject) => {
        const r = loader.parse(data, '', resolve, reject);
        if (r && r.isObject3D) resolve(r);
        else if (r && typeof r.then === 'function') r.then(resolve, reject);
      });
      return one(obj);
    }
    case 'gcode':
    case 'gco': {
      const { GCodeLoader } = await import('three/addons/loaders/GCodeLoader.js');
      const gl = new GCodeLoader(manager);
      (gl as any).splitLayer = true; // one object per layer, for the layer slider (OV-113)
      return one(gl.parse(await text()), [], 'mm');
    }
    case 'lwo': {
      const { LWOLoader } = await import('three/addons/loaders/LWOLoader.js');
      const res: any = new LWOLoader(manager).parse(await buf(), '', name);
      const g = new THREE.Group();
      res.meshes.forEach((m: THREE.Object3D) => g.add(m));
      return one(g);
    }
    case 'kmz': {
      const { KMZLoader } = await import('three/addons/loaders/KMZLoader.js');
      const res: any = new KMZLoader(manager).parse(await buf());
      return one(res.scene, [], 'm');
    }
    case 'vox': {
      const { VOXLoader } = await import('three/addons/loaders/VOXLoader.js');
      const res: any = new VOXLoader(manager).parse(await buf());
      if (!res?.scene) throw new Error('Invalid VOX file');
      return one(res.scene);
    }
    case 'md2': {
      const { MD2Loader } = await import('three/addons/loaders/MD2Loader.js');
      const geo: any = new MD2Loader(manager).parse(await buf());
      const mesh = meshFromGeometry(geo, name);
      return one(mesh, geo.animations || []);
    }
    case '3dm': {
      const { Rhino3dmLoader } = await import('three/addons/loaders/3DMLoader.js');
      onProgress('Starting the Rhino engine…');
      // Not the file-resolving manager: it would treat the engine's own script as a missing companion file and
      // block it, so local .3dm files never finished loading. Rhino files embed their textures.
      const loader = new Rhino3dmLoader();
      loader.setLibraryPath(libUrl('rhino3dm/'));
      const data = await buf();
      const obj = await new Promise<THREE.Object3D>((res, rej) => loader.parse(data, res, rej));
      return one(obj, [], unitOf3dm(obj));
    }
    case 'ifc': {
      const { loadIFC } = await import('./ifc');
      onProgress('Starting the IFC engine…');
      return one(await loadIFC(await buf(), name, onProgress), [], 'm'); // web-ifc outputs metres
    }
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp': {
      const { loadCAD } = await import('./cad');
      onProgress('Starting the CAD engine (first time can take a few seconds)…');
      return one(await loadCAD(await buf(), ext, name, onProgress, signal), [], 'mm'); // tessellated in millimetres
    }
    case 'off':
      return one(meshFromGeometry(parseOFF(await text()), name));
    case 'drc': {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const loader = new DRACOLoader(manager).setDecoderPath(libUrl('draco/'));
      const data = await buf();
      try {
        const geo: THREE.BufferGeometry = await new Promise((res, rej) => loader.parse(data, res, rej));
        return one(geo.index || geo.attributes.position.count % 3 === 0 ? meshFromGeometry(geo, name) : pointsFromGeometry(geo, name));
      } finally { loader.dispose(); }
    }
    case 'x3d':
      return one(parseX3D(await text(), name), [], 'm'); // X3D is defined in metres
    case 'dxf': {
      const r = parseDXF(await text(), name);
      return one(r.object, [], r.unit);
    }
    case 'pts':
      return one(parsePTS(await text(), name));
    case 'las': {
      const r = parseLAS(await buf(), name);
      return one(r.object);
    }
    case 'bvh': {
      const { BVHLoader } = await import('three/addons/loaders/BVHLoader.js');
      const res = new BVHLoader(manager).parse(await text());
      const g = new THREE.Group(); g.name = name;
      g.add(res.skeleton.bones[0]);
      const helper = new THREE.SkeletonHelper(res.skeleton.bones[0]);
      (helper.material as THREE.LineBasicMaterial).linewidth = 2;
      helper.name = 'Skeleton';
      g.add(helper);
      // The helper builds its line positions from the bones on update: do it now so size, framing and stats are right.
      g.updateMatrixWorld(true);
      helper.geometry.computeBoundingBox(); helper.geometry.computeBoundingSphere();
      // SkeletonHelper can't be cloned (exports copy the scene): export a static copy of its lines instead.
      helper.clone = function (this: THREE.SkeletonHelper) {
        const l = new THREE.LineSegments(this.geometry.clone(), (this.material as THREE.Material).clone());
        l.name = this.name;
        this.matrix.decompose(l.position, l.quaternion, l.scale);
        return l as any;
      };
      res.clip.name = res.clip.name || 'Motion';
      return one(g, [res.clip]);
    }
    case 'pdb':
      return one(await moleculeFromPDB(await text(), name));
  }
  throw new Error(`Unsupported format: .${ext}`);
}

/** Atoms as shaded spheres (CPK colours from the file) and bonds as lines; coordinates are in ångström. */
async function moleculeFromPDB(text: string, name: string): Promise<THREE.Object3D> {
  const { PDBLoader } = await import('three/addons/loaders/PDBLoader.js');
  const pdb = new PDBLoader().parse(text);
  const atoms = pdb.geometryAtoms, bonds = pdb.geometryBonds;
  const n = atoms.attributes.position.count;
  if (!n) throw new Error('No atoms (ATOM / HETATM records) were found in this PDB file.');
  const ball = new THREE.IcosahedronGeometry(n > 20000 ? 0.25 : 0.35, n > 20000 ? 0 : 1);
  const mesh = new THREE.InstancedMesh(ball, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }), n);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(atoms.attributes.position.getX(i), atoms.attributes.position.getY(i), atoms.attributes.position.getZ(i));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setRGB(atoms.attributes.color.getX(i), atoms.attributes.color.getY(i), atoms.attributes.color.getZ(i)));
  }
  mesh.name = 'Atoms';
  mesh.computeBoundingSphere();
  // Instanced meshes don't survive every tool or export: bake them into one ordinary mesh.
  const baked = bakeInstanced(mesh);
  const g = new THREE.Group(); g.name = name; g.add(baked);
  // Keep the atoms so the molecule can be saved back as PDB.
  g.userData.pdbAtoms = (pdb.json?.atoms || []).map((a: any) => ({ x: a[0], y: a[1], z: a[2], element: String(a[4] || 'C') }));
  if (bonds.attributes.position.count) {
    const l = new THREE.LineSegments(bonds, new THREE.LineBasicMaterial({ color: 0x9aa0a6 }));
    l.name = 'Bonds'; g.add(l);
  }
  return g;
}

function bakeInstanced(im: THREE.InstancedMesh): THREE.Mesh {
  const src = im.geometry.index ? im.geometry.toNonIndexed() : im.geometry;
  const per = src.attributes.position.count;
  const pos = new Float32Array(per * im.count * 3), nor = new Float32Array(per * im.count * 3), col = new Float32Array(per * im.count * 3);
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m); nm.getNormalMatrix(m); im.getColorAt(i, c);
    for (let k = 0; k < per; k++) {
      const o = (i * per + k) * 3;
      v.fromBufferAttribute(src.attributes.position as THREE.BufferAttribute, k).applyMatrix4(m); pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
      v.fromBufferAttribute(src.attributes.normal as THREE.BufferAttribute, k).applyMatrix3(nm).normalize(); nor[o] = v.x; nor[o + 1] = v.y; nor[o + 2] = v.z;
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 }));
  mesh.name = im.name;
  return mesh;
}

/** Reads GlobalSettings › UnitScaleFactor (centimetres per file unit) from an FBX, binary or text. */
export function fbxUnit(data: ArrayBuffer): DeclaredUnit | undefined {
  const b = new Uint8Array(data);
  const map = (cm: number): DeclaredUnit | undefined => {
    const units: [number, DeclaredUnit][] = [[0.1, 'mm'], [1, 'cm'], [100, 'm'], [2.54, 'in'], [30.48, 'ft']];
    return units.find(([v]) => Math.abs(cm - v) < v * 1e-3)?.[1];
  };
  const head = new TextDecoder('latin1').decode(b.subarray(0, 20));
  if (head.startsWith('Kaydara FBX Binary')) {
    // Find the property record: "UnitScaleFactor" S, "double" S, "Number" S, "" S, then D <float64>.
    const key = new TextEncoder().encode('UnitScaleFactor');
    outer: for (let i = 0; i < b.length - 64; i++) {
      for (let k = 0; k < key.length; k++) if (b[i + k] !== key[k]) continue outer;
      let p = i + key.length;
      for (let s = 0; s < 3; s++) { if (b[p] !== 0x53) continue outer; const len = new DataView(data, p + 1, 4).getUint32(0, true); p += 5 + len; }
      if (b[p] !== 0x44) continue;
      return map(new DataView(data, p + 1, 8).getFloat64(0, true));
    }
    return undefined;
  }
  const m = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 200000))).match(/"UnitScaleFactor"\s*,[^,]*,[^,]*,[^,]*,\s*([\d.eE+-]+)/);
  return m ? map(Number(m[1])) : undefined;
}

/** Reads the unit a 3MF package declares (<model unit="inch">). */
function unitOf3MF(data: ArrayBuffer): DeclaredUnit | undefined {
  try {
    const files = unzipSync(new Uint8Array(data), { filter: (f) => /\.model$/i.test(f.name) });
    for (const bytes of Object.values(files)) {
      const head = new TextDecoder().decode(bytes.subarray(0, 4096));
      const m = head.match(/<model[^>]*\sunit\s*=\s*"([a-z]+)"/i);
      const map: Record<string, DeclaredUnit> = { micron: 'mm', millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };
      return map[(m?.[1] || 'millimeter').toLowerCase()] ?? 'mm';
    }
  } catch { /* not readable */ }
  return 'mm';
}

/** Reads Rhino's model unit system from the loaded file settings. */
function unitOf3dm(obj: THREE.Object3D): DeclaredUnit | undefined {
  const s: any = obj.userData?.settings?.modelUnitSystem;
  const v = typeof s === 'object' && s ? (s.value ?? s.name ?? s.constructor?.name) : s;
  const byNum: Record<number, DeclaredUnit> = { 2: 'mm', 3: 'cm', 4: 'm', 8: 'in', 9: 'ft' };
  if (typeof v === 'number') return byNum[v];
  const str = String(v ?? '').toLowerCase();
  if (str.includes('milli')) return 'mm';
  if (str.includes('centi')) return 'cm';
  if (str.includes('inch')) return 'in';
  if (str.includes('feet') || str.includes('foot')) return 'ft';
  if (str.includes('meter') || str.includes('metre')) return 'm';
  return undefined;
}

/** Minimal OFF / COFF parser. Polygons are ear-clipped so concave faces stay correct (audit OFF note). */
function parseOFF(src: string): THREE.BufferGeometry {
  const lines = src.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let i = 0;
  let header = lines[i++];
  const hasColor = /^C?OFF/i.test(header) && header.toUpperCase().startsWith('COFF');
  let counts: number[];
  const rest = header.replace(/^[A-Z]*OFF/i, '').trim();
  counts = rest ? rest.split(/\s+/).map(Number) : lines[i++].split(/\s+/).map(Number);
  const [nv, nf] = counts;
  const pos: number[] = [];
  const col: number[] = [];
  for (let v = 0; v < nv; v++) {
    const p = lines[i++].split(/\s+/).map(Number);
    pos.push(p[0], p[1], p[2]);
    if (hasColor) {
      const scale = p.slice(3, 6).some((c) => c > 1) ? 1 / 255 : 1;
      col.push((p[3] ?? 1) * scale, (p[4] ?? 1) * scale, (p[5] ?? 1) * scale);
    }
  }
  const idx: number[] = [];
  const v3 = (k: number) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  for (let f = 0; f < nf; f++) {
    const p = lines[i++].split(/\s+/).map(Number);
    const n = p[0];
    const ids = p.slice(1, n + 1);
    if (n <= 3) { if (n === 3) idx.push(...ids); continue; }
    // Project the polygon onto its best-fit plane and ear-clip it.
    const pts = ids.map(v3);
    const normal = new THREE.Vector3();
    for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % n]; normal.x += (a.y - b.y) * (a.z + b.z); normal.y += (a.z - b.z) * (a.x + b.x); normal.z += (a.x - b.x) * (a.y + b.y); }
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    const flat = pts.map((q) => (az >= ax && az >= ay ? new THREE.Vector2(q.x, q.y) : ax >= ay ? new THREE.Vector2(q.y, q.z) : new THREE.Vector2(q.z, q.x)));
    const tris = THREE.ShapeUtils.triangulateShape(flat, []);
    const flip = THREE.ShapeUtils.isClockWise(flat) !== ((az >= ax && az >= ay ? normal.z : ax >= ay ? normal.x : normal.y) < 0);
    for (const t of tris) idx.push(ids[t[0]], ids[flip ? t[2] : t[1]], ids[flip ? t[1] : t[2]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (hasColor) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// The KTX2 loader needs a renderer to detect GPU texture support; the viewer registers its own here.
let sharedRenderer: THREE.WebGLRenderer;
export const setSharedRenderer = (r: THREE.WebGLRenderer) => (sharedRenderer = r);
const getSharedRenderer = () => sharedRenderer;

/** Downloads models listed in a URL (e.g. from #model=...) and returns them as File objects. */
export async function filesFromUrls(list: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<File[]> {
  const loaded = new Array(list.length).fill(0), totals = new Array(list.length).fill(0);
  const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0), totals.reduce((a, b) => a + b, 0));
  return Promise.all(list.map(async (u, i) => {
    const res = await fetch(u, { signal });
    if (!res.ok) throw new Error(`Could not download ${u} (HTTP ${res.status})`);
    totals[i] = Number(res.headers.get('content-length')) || 0;
    // Stream the body so the progress bar moves for big downloads.
    const chunks: Uint8Array[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded[i] += value.length;
        report();
      }
    }
    const blob = reader ? new Blob(chunks as BlobPart[]) : await res.blob();
    const name = decodeURIComponent(new URL(u, location.href).pathname.split('/').pop() || 'model');
    return new File([blob], name);
  }));
}

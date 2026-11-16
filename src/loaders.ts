import * as THREE from 'three';
import { unzipSync } from 'fflate';

/** Resolves a path inside public/libs relative to the page, so it works on any sub-path. */
export const libUrl = (path: string) => new URL(`libs/${path}`, document.baseURI).href;

export interface FormatInfo {
  ext: string[];
  name: string;
  /** true for formats that need companion files (textures, .mtl, .bin...) */
  companions?: boolean;
}

/** Every format OMNIVIEW can open. Used for the file picker and the "supported formats" list. */
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
  { ext: ['zip'], name: 'ZIP archive of any of the above' },
];

export const MODEL_EXTS = new Set(FORMATS.flatMap((f) => f.ext).filter((e) => e !== 'zip'));
export const ACCEPT = FORMATS.flatMap((f) => f.ext).map((e) => '.' + e).join(',') +
  ',.mtl,.bin,.png,.jpg,.jpeg,.webp,.bmp,.tga,.gif,.ktx2,.dds,.tif,.tiff';

export const extOf = (name: string) => name.split('.').pop()!.toLowerCase();
const baseName = (p: string) => decodeURIComponent(p.split(/[\\/]/).pop() || p).toLowerCase();

const DEFAULT_COLOR = 0xb4b8bd;
export const defaultMaterial = () =>
  new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide });

/** Expands ZIP archives into plain File objects. */
async function expandZips(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (extOf(f.name) !== 'zip') { out.push(f); continue; }
    const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || path.startsWith('__MACOSX')) continue;
      out.push(new File([data as BlobPart], path.split('/').pop()!));
    }
  }
  return out;
}

export interface LoadResult {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  mainFiles: string[];
  warnings: string[];
}

type Progress = (msg: string) => void;

/**
 * Loads a set of files (model files plus any companions such as textures and .mtl files)
 * and returns one Object3D containing every model found.
 */
export async function loadFiles(input: File[], onProgress: Progress = () => {}): Promise<LoadResult> {
  const files = await expandZips(input);
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    return urls.get(baseName(url)) ?? url;
  });

  const mains = files.filter((f) => MODEL_EXTS.has(extOf(f.name)));
  if (!mains.length) throw new Error('No supported 3D model was found in the selected files.');

  const root = new THREE.Group();
  root.name = mains.length === 1 ? mains[0].name : 'Scene';
  const animations: THREE.AnimationClip[] = [];
  const warnings: string[] = [];

  for (const file of mains) {
    onProgress(`Reading ${file.name}…`);
    try {
      const { object, clips } = await loadOne(file, files, manager, onProgress);
      if (!object.name) object.name = file.name;
      root.add(object);
      animations.push(...clips);
    } catch (err: any) {
      console.error(err);
      warnings.push(`${file.name}: ${err?.message || err}`);
    }
  }
  // Give textures a moment to finish streaming in.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    manager.onLoad = finish;
    setTimeout(finish, 1500);
  });
  if (!root.children.length) throw new Error(warnings.join('\n') || 'The model could not be loaded.');
  return { object: root.children.length === 1 ? root.children[0] : root, animations, mainFiles: mains.map((f) => f.name), warnings };
}

function meshFromGeometry(geometry: THREE.BufferGeometry, name: string): THREE.Object3D {
  const hasFaces = geometry.index !== null || geometry.attributes.position.count % 3 === 0;
  const hasColors = !!geometry.attributes.color;
  if (!geometry.attributes.normal && hasFaces) geometry.computeVertexNormals();
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
): Promise<{ object: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const ext = extOf(file.name);
  const name = file.name;
  const buf = () => file.arrayBuffer();
  const text = () => file.text();
  const one = (object: THREE.Object3D, clips: THREE.AnimationClip[] = []) => ({ object, clips });

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
      return one(gltf.scene, gltf.animations);
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
      const obj = new FBXLoader(manager).parse(await buf(), '');
      return one(obj, obj.animations || []);
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geo = new STLLoader(manager).parse(await buf());
      return one(meshFromGeometry(geo, name));
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geo = new PLYLoader(manager).parse(await buf());
      return one(geo.index ? meshFromGeometry(geo, name) : pointsFromGeometry(geo, name));
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      return one(new ThreeMFLoader(manager).parse(await buf()));
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const res: any = new ColladaLoader(manager).parse(await text(), '');
      return one(res.scene, res.scene?.animations || []);
    }
    case '3ds': {
      const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
      return one(new TDSLoader(manager).parse(await buf(), ''));
    }
    case 'amf': {
      const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
      return one(new AMFLoader(manager).parse(await buf()));
    }
    case 'wrl':
    case 'vrml': {
      const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
      return one(new VRMLLoader(manager).parse(await text(), ''));
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
      const geo: THREE.BufferGeometry = await new Promise((res, rej) => loader.load(URL.createObjectURL(file), res, undefined, rej));
      return one(pointsFromGeometry(geo, name));
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
      return one(new GCodeLoader(manager).parse(await text()));
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
      return one(res.scene);
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
      const loader = new Rhino3dmLoader(manager);
      loader.setLibraryPath(libUrl('rhino3dm/'));
      const data = await buf();
      const obj = await new Promise<THREE.Object3D>((res, rej) => loader.parse(data, res, rej));
      return one(obj);
    }
    case 'ifc': {
      const { loadIFC } = await import('./ifc');
      onProgress('Starting the IFC engine…');
      return one(await loadIFC(await buf(), name, onProgress));
    }
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp': {
      const { loadCAD } = await import('./cad');
      onProgress('Starting the CAD engine (first time can take a few seconds)…');
      return one(await loadCAD(await buf(), ext, name, onProgress));
    }
    case 'off':
      return one(meshFromGeometry(parseOFF(await text()), name));
  }
  throw new Error(`Unsupported format: .${ext}`);
}

/** Minimal OFF / COFF parser (polygons are fan-triangulated). */
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
  for (let f = 0; f < nf; f++) {
    const p = lines[i++].split(/\s+/).map(Number);
    const n = p[0];
    for (let k = 2; k < n; k++) idx.push(p[1], p[k], p[k + 1]);
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
export async function filesFromUrls(list: string[]): Promise<File[]> {
  return Promise.all(list.map(async (u) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Could not download ${u} (HTTP ${res.status})`);
    const blob = await res.blob();
    const name = decodeURIComponent(new URL(u, location.href).pathname.split('/').pop() || 'model');
    return new File([blob], name);
  }));
}

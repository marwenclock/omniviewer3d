import * as THREE from 'three';
import { libUrl } from './loaders';

// occt-import-js (OpenCascade compiled to WebAssembly) reads STEP, IGES and BREP CAD files.
let occtPromise: Promise<any> | null = null;

function getOcct(): Promise<any> {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = libUrl('occt/occt-import-js.js');
      s.onload = () => {
        const factory = (window as any).occtimportjs;
        if (!factory) return reject(new Error('CAD engine failed to start'));
        factory({ locateFile: (f: string) => libUrl('occt/' + f) }).then(resolve, reject);
      };
      s.onerror = () => reject(new Error('Could not download the CAD engine'));
      document.head.appendChild(s);
    });
  }
  return occtPromise;
}

/** Tessellation quality for CAD files (Settings → CAD quality). */
export const CAD_QUALITY = {
  draft: { label: 'Draft (fastest)', linear: 0.004, angular: 0.9 },
  normal: { label: 'Normal', linear: 0.001, angular: 0.5 },
  fine: { label: 'Fine (smooth curves)', linear: 0.0003, angular: 0.2 },
} as const;
export type CadQuality = keyof typeof CAD_QUALITY;
export function cadQuality(): CadQuality {
  try { const q = localStorage.getItem('omniview.cadQuality') as CadQuality; return q && q in CAD_QUALITY ? q : 'normal'; } catch { return 'normal'; }
}

/** Runs OpenCascade in a Web Worker so the page stays responsive; falls back to the main thread. */
function readInWorker(format: string, data: Uint8Array, params: object, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(libUrl('occt/occt-import-js-worker.js')); } catch (e) { reject(e); return; }
    const abort = () => { worker.terminate(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (ev) => { signal?.removeEventListener('abort', abort); worker.terminate(); resolve(ev.data); };
    worker.onerror = (ev) => { signal?.removeEventListener('abort', abort); worker.terminate(); reject(new Error(ev.message || 'CAD worker failed')); };
    worker.postMessage({ format, buffer: data, params }, [data.buffer]);
  });
}

export async function loadCAD(buffer: ArrayBuffer, ext: string, name: string, onProgress: (m: string) => void, signal?: AbortSignal) {
  onProgress('Tessellating CAD geometry…');
  const q = CAD_QUALITY[cadQuality()];
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: q.linear, angularDeflection: q.angular };
  const format = ext === 'step' || ext === 'stp' ? 'step' : ext === 'iges' || ext === 'igs' ? 'iges' : 'brep';
  let res: any;
  try {
    res = await readInWorker(format, new Uint8Array(buffer.slice(0)), params, signal);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.warn('CAD worker unavailable, using main thread', e);
    const occt = await getOcct();
    const data = new Uint8Array(buffer);
    if (format === 'step') res = occt.ReadStepFile(data, params);
    else if (format === 'iges') res = occt.ReadIgesFile(data, params);
    else res = occt.ReadBrepFile(data, params);
  }
  if (!res?.success) throw new Error('The CAD file could not be read');

  const meshes: THREE.Mesh[] = res.meshes.map((m: any, i: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    g.setIndex(m.index.array);
    if (!m.attributes.normal) g.computeVertexNormals();
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0xc8c8c8);
    let material: THREE.Material | THREE.Material[] = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
    // Per-face colours (brep_faces) become geometry groups with their own materials.
    if (m.brep_faces?.some((f: any) => f.color)) {
      const mats: THREE.Material[] = [material as THREE.Material];
      const key = new Map<string, number>();
      for (const f of m.brep_faces) {
        let mi = 0;
        if (f.color) {
          const k = f.color.join(',');
          if (!key.has(k)) {
            key.set(k, mats.length);
            mats.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(f.color[0], f.color[1], f.color[2]), metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide }));
          }
          mi = key.get(k)!;
        }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, mi);
      }
      material = mats;
    }
    const mesh = new THREE.Mesh(g, material);
    mesh.name = m.name || `Part ${i + 1}`;
    return mesh;
  });

  // Rebuild the assembly hierarchy.
  const build = (node: any): THREE.Object3D => {
    const grp = new THREE.Group();
    grp.name = node.name || '';
    for (const idx of node.meshes || []) grp.add(meshes[idx]);
    for (const c of node.children || []) grp.add(build(c));
    return grp;
  };
  const root = res.root ? build(res.root) : new THREE.Group();
  if (!res.root) meshes.forEach((m) => root.add(m));
  root.name = root.name || name;
  return root;
}

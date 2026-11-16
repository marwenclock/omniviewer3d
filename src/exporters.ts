import * as THREE from 'three';
import type { Viewer } from './viewer';

export const EXPORT_FORMATS = [
  { id: 'glb', label: 'GLB (binary glTF)', ext: 'glb', note: 'Best all-round: keeps materials, textures, colours and animations' },
  { id: 'gltf', label: 'glTF (JSON)', ext: 'gltf', note: 'Text glTF with embedded data' },
  { id: 'stl', label: 'STL (binary)', ext: 'stl', note: 'For 3D printing; geometry only' },
  { id: 'stl-ascii', label: 'STL (ASCII)', ext: 'stl', note: 'Readable text STL' },
  { id: 'obj', label: 'OBJ', ext: 'obj', note: 'Widely supported; geometry, normals and UVs' },
  { id: 'ply', label: 'PLY (binary)', ext: 'ply', note: 'Keeps painted vertex colours' },
  { id: 'usdz', label: 'USDZ', ext: 'usdz', note: 'Apple AR Quick Look' },
] as const;
export type ExportId = (typeof EXPORT_FORMATS)[number]['id'];

export async function exportModel(viewer: Viewer, id: ExportId, target?: THREE.Object3D): Promise<Blob> {
  const model = target ?? viewer.model;
  if (!model) throw new Error('Nothing to export');
  // Export in the file's own axes: undo the Y/Z-up view rotation while exporting.
  const rot = viewer.world.rotation.clone();
  viewer.world.rotation.set(0, 0, 0);
  viewer.world.updateMatrixWorld(true);
  try {
    return await viewer.withCleanModel(async () => {
      switch (id) {
        case 'glb':
        case 'gltf': {
          const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
          const out = await new GLTFExporter().parseAsync(model, { binary: id === 'glb', onlyVisible: true, animations: viewer.clips });
          return id === 'glb'
            ? new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' })
            : new Blob([JSON.stringify(out, null, 2)], { type: 'model/gltf+json' });
        }
        case 'stl':
        case 'stl-ascii': {
          const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
          const out: any = new STLExporter().parse(model, { binary: id === 'stl' });
          return new Blob([out], { type: 'model/stl' });
        }
        case 'obj': {
          const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
          return new Blob([new OBJExporter().parse(model)], { type: 'text/plain' });
        }
        case 'ply': {
          const { PLYExporter } = await import('three/addons/exporters/PLYExporter.js');
          const out = await new Promise<any>((res) => new PLYExporter().parse(model, res, { binary: true }));
          return new Blob([out], { type: 'application/octet-stream' });
        }
        case 'usdz': {
          const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
          const out = await new USDZExporter().parseAsync(model);
          return new Blob([out as BlobPart], { type: 'model/vnd.usdz+zip' });
        }
      }
      throw new Error('Unknown export format');
    });
  } finally {
    viewer.world.rotation.copy(rot);
    viewer.world.updateMatrixWorld(true);
  }
}

export function download(blob: Blob | string, filename: string) {
  const a = document.createElement('a');
  a.href = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

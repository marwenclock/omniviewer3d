import * as THREE from 'three';
import type { Viewer } from './viewer';
import { zipSync, strToU8 } from 'fflate';

export const EXPORT_FORMATS = [
  { id: 'glb', label: 'GLB (binary glTF)', ext: 'glb', note: 'Best all-round: keeps materials, textures, colours and animations' },
  { id: 'gltf', label: 'glTF (JSON)', ext: 'gltf', note: 'Text glTF with embedded data' },
  { id: 'stl', label: 'STL (binary)', ext: 'stl', note: 'For 3D printing; geometry only' },
  { id: 'stl-ascii', label: 'STL (ASCII)', ext: 'stl', note: 'Readable text STL' },
  { id: 'obj', label: 'OBJ', ext: 'obj', note: 'Widely supported; geometry, normals and UVs' },
  { id: 'ply', label: 'PLY (binary)', ext: 'ply', note: 'Keeps painted vertex colours' },
  { id: 'usdz', label: 'USDZ', ext: 'usdz', note: 'Apple AR Quick Look' },
  { id: '3mf', label: '3MF', ext: '3mf', note: 'Modern 3D printing format: keeps units, colours and separate objects' },
] as const;
export type ExportId = (typeof EXPORT_FORMATS)[number]['id'];

export interface ExportOptions {
  /** model unit, written into formats that store units (3MF) */
  unit?: string;
  /** rotate a Y-up model so it stands upright in Z-up slicers */
  zUp?: boolean;
}

export async function exportModel(viewer: Viewer, id: ExportId, target?: THREE.Object3D, opts: ExportOptions = {}): Promise<Blob> {
  const model = target ?? viewer.model;
  if (!model) throw new Error('Nothing to export');
  let splat = false;
  model.traverse((o) => { if (o.userData.splat) splat = true; });
  if (splat) throw new Error('Gaussian splats can be viewed, measured and screenshotted, but not converted to mesh formats.');
  // Export in the file's own axes (undo the view rotation), or turned Z-up for printing.
  const rot = viewer.world.rotation.clone();
  viewer.world.rotation.set(opts.zUp && viewer.upAxis === 'y' ? Math.PI / 2 : 0, 0, 0);
  viewer.world.updateMatrixWorld(true);
  model.updateMatrixWorld(true);
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
        case '3mf':
          return export3MF(model, opts.unit);
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

const UNIT_3MF: Record<string, string> = { mm: 'millimeter', cm: 'centimeter', m: 'meter', in: 'inch', ft: 'foot', u: 'millimeter' };

/** Writes a 3MF package: one object per visible mesh, welded vertices, a display colour per object. */
function export3MF(root: THREE.Object3D, unit = 'mm'): Blob {
  const objects: string[] = [], items: string[] = [], bases: string[] = [];
  const v = new THREE.Vector3();
  let id = 2;
  root.traverse((o: any) => {
    if (!o.isMesh || o.userData.helper || !isShown(o)) return;
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
    // Mirrored transforms flip winding; keep normals pointing out.
    const flip = o.matrixWorld.determinant() < 0;
    for (let t = 0; t < count; t += 3) {
      const a = vid(g.index ? g.index.getX(t) : t), b = vid(g.index ? g.index.getX(t + 1) : t + 1), c = vid(g.index ? g.index.getX(t + 2) : t + 2);
      if (a === b || b === c || a === c) continue;
      tris.push(flip ? `<triangle v1="${a}" v2="${c}" v3="${b}"/>` : `<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    const m: any = Array.isArray(o.material) ? o.material[0] : o.material;
    const col = m?.color ? '#' + m.color.getHexString(THREE.SRGBColorSpace).toUpperCase() + 'FF' : '#B4B8BDFF';
    bases.push(`<base name="${xml(m?.name || 'Material ' + bases.length)}" displaycolor="${col}"/>`);
    objects.push(`<object id="${id}" type="model" pid="1" pindex="${bases.length - 1}" name="${xml(o.name || 'Object ' + (id - 1))}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
    id++;
  });
  if (!objects.length) throw new Error('Nothing visible to export');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${UNIT_3MF[unit] || 'millimeter'}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">OMNIVIEWER by BANKASI MEDIA</metadata>
<resources><basematerials id="1">${bases.join('')}</basematerials>${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  };
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'model/3mf' });
}

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
function isShown(o: THREE.Object3D | null) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

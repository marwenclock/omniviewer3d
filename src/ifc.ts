import * as THREE from 'three';
import { libUrl } from './loaders';

// web-ifc reads Building Information Models (IFC).
export async function loadIFC(buffer: ArrayBuffer, name: string, onProgress: (m: string) => void) {
  const WebIFC = await import('web-ifc');
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(libUrl('web-ifc/'), true);
  await api.Init(undefined, true);
  const modelID = api.OpenModel(new Uint8Array(buffer));
  const root = new THREE.Group();
  root.name = name;
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const matrix = new THREE.Matrix4();

  api.StreamAllMeshes(modelID, (flat: any, index: number, total: number) => {
    if (index % 200 === 0) onProgress(`Building IFC elements ${index}/${total}…`);
    const placed = flat.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const pos = new Float32Array(verts.length / 2);
      const nor = new Float32Array(verts.length / 2);
      for (let v = 0, p = 0; v < verts.length; v += 6, p += 3) {
        pos[p] = verts[v]; pos[p + 1] = verts[v + 1]; pos[p + 2] = verts[v + 2];
        nor[p] = verts[v + 3]; nor[p + 1] = verts[v + 4]; nor[p + 2] = verts[v + 5];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      const c = pg.color;
      const key = `${c.x},${c.y},${c.z},${c.w}`;
      let mat = materials.get(key);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.x, c.y, c.z), opacity: c.w, transparent: c.w < 1, side: THREE.DoubleSide, roughness: 0.7 });
        materials.set(key, mat);
      }
      const mesh = new THREE.Mesh(g, mat);
      matrix.fromArray(pg.flatTransformation);
      mesh.applyMatrix4(matrix);
      let label = `#${flat.expressID}`;
      try {
        const line = api.GetLine(modelID, flat.expressID);
        const typeName = api.GetNameFromTypeCode?.(api.GetLineType(modelID, flat.expressID)) || '';
        label = line?.Name?.value || typeName || label;
      } catch { /* names are optional */ }
      mesh.name = label;
      root.add(mesh);
      geom.delete?.();
    }
  });
  api.CloseModel(modelID);
  return root;
}

import * as THREE from 'three';
import { libUrl } from './loaders';

/** Metadata kept per IFC element for inspection (OV-111). Not written to exported mesh files. */
export interface IfcInfo { id: number; type: string; name: string; globalId?: string; storey?: string; objectType?: string; psets?: Record<string, Record<string, string>> }

// web-ifc reads Building Information Models (IFC). Elements are grouped by storey, then by type, so a reviewer can
// find, isolate and read them; identifiers and property sets are kept on each element.
export async function loadIFC(buffer: ArrayBuffer, name: string, onProgress: (m: string) => void) {
  const WebIFC: any = await import('web-ifc');
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(libUrl('web-ifc/'), true);
  await api.Init(undefined, true);
  const modelID = api.OpenModel(new Uint8Array(buffer));
  const root = new THREE.Group();
  root.name = name;
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const matrix = new THREE.Matrix4();
  const val = (x: any) => (x && typeof x === 'object' && 'value' in x ? String(x.value) : x == null ? '' : String(x));

  // Element → storey name, from the spatial containment relations.
  const storeyOf = new Map<number, string>();
  try {
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelID, rels.get(i));
      const structure = api.GetLine(modelID, rel.RelatingStructure.value);
      const sName = val(structure?.Name) || val(structure?.LongName) || `Level #${rel.RelatingStructure.value}`;
      for (const el of rel.RelatedElements || []) storeyOf.set(el.value, sName);
    }
  } catch { /* spatial structure is optional */ }

  // Property sets (limited, so huge models still open quickly).
  const psetsOf = new Map<number, Record<string, Record<string, string>>>();
  try {
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
    const n = Math.min(rels.size(), 20000);
    for (let i = 0; i < n; i++) {
      const rel = api.GetLine(modelID, rels.get(i));
      const def = api.GetLine(modelID, rel.RelatingPropertyDefinition.value, true);
      if (!def?.HasProperties) continue;
      const props: Record<string, string> = {};
      for (const p of def.HasProperties) { const k = val(p?.Name); if (k) props[k] = val(p?.NominalValue); }
      if (!Object.keys(props).length) continue;
      for (const o of rel.RelatedObjects || []) {
        const m = psetsOf.get(o.value) || {};
        m[val(def.Name) || 'Properties'] = props;
        psetsOf.set(o.value, m);
      }
    }
  } catch { /* property sets are optional */ }

  const storeys = new Map<string, THREE.Group>();
  const typeGroups = new Map<string, THREE.Group>();
  const groupFor = (storey: string, type: string) => {
    let s = storeys.get(storey);
    if (!s) { s = new THREE.Group(); s.name = storey; storeys.set(storey, s); root.add(s); }
    const key = storey + '|' + type;
    let g = typeGroups.get(key);
    if (!g) { g = new THREE.Group(); g.name = type; typeGroups.set(key, g); s.add(g); }
    return g;
  };

  api.StreamAllMeshes(modelID, (flat: any, index: number, total: number) => {
    if (index % 200 === 0) onProgress(`Building IFC elements ${index}/${total}…`);
    const id = flat.expressID;
    let info: IfcInfo = { id, type: 'Element', name: `#${id}` };
    try {
      const line = api.GetLine(modelID, id);
      const typeName = api.GetNameFromTypeCode?.(api.GetLineType(modelID, id)) || 'Element';
      info = { id, type: prettyType(typeName), name: val(line?.Name) || prettyType(typeName), globalId: val(line?.GlobalId) || undefined, objectType: val(line?.ObjectType) || undefined };
    } catch { /* names are optional */ }
    info.storey = storeyOf.get(id);
    info.psets = psetsOf.get(id);
    const placed = flat.geometries;
    const meshes: THREE.Mesh[] = [];
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
      mesh.name = info.name;
      mesh.userData.ifc = info;
      meshes.push(mesh);
      geom.delete?.();
    }
    const parent = groupFor(info.storey || 'Not assigned to a storey', info.type);
    if (meshes.length === 1) parent.add(meshes[0]);
    else if (meshes.length > 1) { const el = new THREE.Group(); el.name = info.name; el.userData.ifc = info; meshes.forEach((m) => el.add(m)); parent.add(el); }
  });
  // Label groups with their counts.
  for (const g of typeGroups.values()) g.name = `${g.name} (${g.children.length})`;
  api.CloseModel(modelID);
  return root;
}

const prettyType = (t: string) => t.replace(/^IFC/i, '').replace(/STANDARDCASE$/i, '').toLowerCase().replace(/^./, (c) => c.toUpperCase());

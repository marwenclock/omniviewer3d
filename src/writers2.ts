import * as THREE from 'three';
import { zipSync, strToU8, zlibSync, gzipSync } from 'fflate';
import { flatten, type FlatMesh } from './writers';

// Writers for the rest of the formats OMNIVIEWER opens, so every format it reads it can also write.
// Like writers.ts they receive the scoped, unit- and axis-converted export graph.

const f = (x: number) => (Math.abs(x) < 1e-12 ? '0' : String(+x.toPrecision(9)));
const fd = (x: number) => { const s = f(x); return s.includes('.') || s.includes('e') ? s : s + '.'; }; // STEP/IFC reals need a dot
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
const ident = (s: string, fallback = 'part') => (s || fallback).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || fallback;
const asciiOnly = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/'/g, '');
const bytes = (parts: (Uint8Array | ArrayBuffer)[]) => {
  const n = parts.reduce((a, p) => a + p.byteLength, 0), out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p instanceof Uint8Array ? p : new Uint8Array(p), o); o += p.byteLength; }
  return out;
};
/** Every vertex of every mesh and point set, with a colour, for point formats. */
function allPoints(graph: THREE.Object3D) {
  const { meshes, points } = flatten(graph);
  const out: { pos: Float32Array; col: Float32Array }[] = [];
  for (const m of meshes) out.push({ pos: m.pos, col: m.vcol ?? new Float32Array(m.pos.length).map((_, i) => [m.color.r, m.color.g, m.color.b][i % 3]) });
  for (const p of points) out.push({ pos: p.pos, col: p.vcol ?? new Float32Array(p.pos.length).fill(0.8) });
  const n = out.reduce((a, s) => a + s.pos.length / 3, 0);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0; for (const s of out) { pos.set(s.pos, o); col.set(s.col, o); o += s.pos.length; }
  return { pos, col, n };
}
const requireMeshes = (meshes: FlatMesh[], fmt: string) => { if (!meshes.length) throw new Error(`${fmt} stores surfaces: there are no meshes to write.`); };

// ------------------------------------------------------------------ FBX (binary 7.4)
type FbxProp = ['I', number] | ['D', number] | ['L', number] | ['S', string] | ['R', Uint8Array] | ['C', boolean] | ['d', ArrayLike<number>] | ['i', ArrayLike<number>];
interface FbxNode { name: string; props: FbxProp[]; children: FbxNode[] }
const N = (name: string, props: FbxProp[] = [], children: FbxNode[] = []): FbxNode => ({ name, props, children });
const P70 = (name: string, type: string, label: string, flags: string, ...vals: FbxProp[]) => N('P', [['S', name], ['S', type], ['S', label], ['S', flags], ...vals]);

function fbxProp(p: FbxProp): Uint8Array {
  const [t, v] = p;
  const enc = new TextEncoder();
  switch (t) {
    case 'I': { const b = new DataView(new ArrayBuffer(5)); b.setUint8(0, 73); b.setInt32(1, v as number, true); return new Uint8Array(b.buffer); }
    case 'D': { const b = new DataView(new ArrayBuffer(9)); b.setUint8(0, 68); b.setFloat64(1, v as number, true); return new Uint8Array(b.buffer); }
    case 'L': { const b = new DataView(new ArrayBuffer(9)); b.setUint8(0, 76); b.setBigInt64(1, BigInt(v as number), true); return new Uint8Array(b.buffer); }
    case 'C': return new Uint8Array([67, v ? 1 : 0]);
    case 'S': case 'R': {
      const data = t === 'S' ? enc.encode(v as string) : (v as Uint8Array);
      const b = new DataView(new ArrayBuffer(5)); b.setUint8(0, t.charCodeAt(0)); b.setUint32(1, data.length, true);
      return bytes([new Uint8Array(b.buffer), data]);
    }
    case 'd': case 'i': {
      const arr = v as ArrayLike<number>;
      const raw = t === 'd' ? new Uint8Array(new Float64Array(Array.from(arr)).buffer) : new Uint8Array(new Int32Array(Array.from(arr)).buffer);
      const zip = raw.length > 256;
      const data = zip ? zlibSync(raw) : raw;
      const b = new DataView(new ArrayBuffer(13)); b.setUint8(0, t.charCodeAt(0)); b.setUint32(1, arr.length, true); b.setUint32(5, zip ? 1 : 0, true); b.setUint32(9, data.length, true);
      return bytes([new Uint8Array(b.buffer), data]);
    }
  }
}
function fbxNode(n: FbxNode, offset: number): Uint8Array {
  const name = new TextEncoder().encode(n.name);
  const props = bytes(n.props.map(fbxProp));
  const head = 13 + name.length;
  const kids: Uint8Array[] = [];
  let o = offset + head + props.length;
  for (const c of n.children) { const b = fbxNode(c, o); kids.push(b); o += b.length; }
  const sentinel = n.children.length || !n.props.length ? new Uint8Array(13) : new Uint8Array(0);
  const end = o + sentinel.length;
  const h = new DataView(new ArrayBuffer(head));
  h.setUint32(0, end, true); h.setUint32(4, n.props.length, true); h.setUint32(8, props.length, true); h.setUint8(12, name.length);
  new Uint8Array(h.buffer).set(name, 13);
  return bytes([new Uint8Array(h.buffer), props, ...kids, sentinel]);
}

/** Binary FBX 7.4 (what Blender, Unity, Unreal and Maya read): meshes with normals, vertex colours and one material each. */
export function writeFBX(graph: THREE.Object3D, unit: string, up: 'y' | 'z'): Uint8Array {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'FBX');
  const cm: Record<string, number> = { mm: 0.1, cm: 1, m: 100, in: 2.54, ft: 30.48, u: 1 };
  let id = 1000000;
  const objects: FbxNode[] = [], conns: FbxNode[] = [];
  for (const m of meshes) {
    const gid = ++id, mid = ++id, matid = ++id;
    const name = asciiOnly(m.name) || 'part';
    const poly: number[] = [];
    for (let i = 0; i < m.idx.length; i += 3) poly.push(m.idx[i], m.idx[i + 1], -m.idx[i + 2] - 1);
    // Flat per-corner normals from the triangle (exact for CAD-style meshes, close for smooth ones).
    const nrm: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < m.idx.length; i += 3) {
      a.fromArray(m.pos, m.idx[i] * 3); b.fromArray(m.pos, m.idx[i + 1] * 3); c.fromArray(m.pos, m.idx[i + 2] * 3);
      const n = b.sub(a).cross(c.sub(a)).normalize();
      for (let k = 0; k < 3; k++) nrm.push(n.x, n.y, n.z);
    }
    const layers: FbxNode[] = [
      N('LayerElementNormal', [['I', 0]], [N('Version', [['I', 101]]), N('Name', [['S', '']]), N('MappingInformationType', [['S', 'ByPolygonVertex']]), N('ReferenceInformationType', [['S', 'Direct']]), N('Normals', [['d', nrm]])]),
      N('LayerElementMaterial', [['I', 0]], [N('Version', [['I', 101]]), N('Name', [['S', '']]), N('MappingInformationType', [['S', 'AllSame']]), N('ReferenceInformationType', [['S', 'IndexToDirect']]), N('Materials', [['i', [0]]])]),
    ];
    const layerRefs = [N('LayerElement', [], [N('Type', [['S', 'LayerElementNormal']]), N('TypedIndex', [['I', 0]])]), N('LayerElement', [], [N('Type', [['S', 'LayerElementMaterial']]), N('TypedIndex', [['I', 0]])])];
    if (m.vcol) {
      const col: number[] = [];
      for (let i = 0; i < m.idx.length; i++) col.push(m.vcol[m.idx[i] * 3], m.vcol[m.idx[i] * 3 + 1], m.vcol[m.idx[i] * 3 + 2], 1);
      layers.push(N('LayerElementColor', [['I', 0]], [N('Version', [['I', 101]]), N('Name', [['S', 'Col']]), N('MappingInformationType', [['S', 'ByPolygonVertex']]), N('ReferenceInformationType', [['S', 'Direct']]), N('Colors', [['d', col]])]));
      layerRefs.push(N('LayerElement', [], [N('Type', [['S', 'LayerElementColor']]), N('TypedIndex', [['I', 0]])]));
    }
    objects.push(
      N('Geometry', [['L', gid], ['S', `${name}\x00\x01Geometry`], ['S', 'Mesh']], [
        N('Vertices', [['d', m.pos]]), N('PolygonVertexIndex', [['i', poly]]), N('GeometryVersion', [['I', 124]]), ...layers, N('Layer', [['I', 0]], [N('Version', [['I', 100]]), ...layerRefs]),
      ]),
      N('Model', [['L', mid], ['S', `${name}\x00\x01Model`], ['S', 'Mesh']], [N('Version', [['I', 232]]), N('Properties70', [], [P70('DefaultAttributeIndex', 'int', 'Integer', '', ['I', 0])]), N('Shading', [['C', true]]), N('Culling', [['S', 'CullingOff']])]),
      N('Material', [['L', matid], ['S', `${name}\x00\x01Material`], ['S', '']], [N('Version', [['I', 102]]), N('ShadingModel', [['S', 'phong']]), N('MultiLayer', [['I', 0]]),
        N('Properties70', [], [P70('DiffuseColor', 'Color', '', 'A', ['D', m.color.r], ['D', m.color.g], ['D', m.color.b]), P70('Diffuse', 'Vector3D', 'Vector', '', ['D', m.color.r], ['D', m.color.g], ['D', m.color.b])])]),
    );
    conns.push(N('C', [['S', 'OO'], ['L', mid], ['L', 0]]), N('C', [['S', 'OO'], ['L', gid], ['L', mid]]), N('C', [['S', 'OO'], ['L', matid], ['L', mid]]));
  }
  const yUp = up === 'y';
  const root: FbxNode[] = [
    N('FBXHeaderExtension', [], [N('FBXHeaderVersion', [['I', 1003]]), N('FBXVersion', [['I', 7400]]), N('Creator', [['S', 'OMNIVIEWER']])]),
    N('FileId', [['R', new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1])]]),
    N('CreationTime', [['S', '1970-01-01 10:00:00:000']]),
    N('Creator', [['S', 'OMNIVIEWER']]),
    N('GlobalSettings', [], [N('Version', [['I', 1000]]), N('Properties70', [], [
      P70('UpAxis', 'int', 'Integer', '', ['I', yUp ? 1 : 2]), P70('UpAxisSign', 'int', 'Integer', '', ['I', 1]),
      P70('FrontAxis', 'int', 'Integer', '', ['I', yUp ? 2 : 1]), P70('FrontAxisSign', 'int', 'Integer', '', ['I', yUp ? 1 : -1]),
      P70('CoordAxis', 'int', 'Integer', '', ['I', 0]), P70('CoordAxisSign', 'int', 'Integer', '', ['I', 1]),
      P70('OriginalUpAxis', 'int', 'Integer', '', ['I', yUp ? 1 : 2]), P70('OriginalUpAxisSign', 'int', 'Integer', '', ['I', 1]),
      P70('UnitScaleFactor', 'double', 'Number', '', ['D', cm[unit] ?? 1]), P70('OriginalUnitScaleFactor', 'double', 'Number', '', ['D', cm[unit] ?? 1]),
    ])]),
    N('Documents', [], [N('Count', [['I', 1]]), N('Document', [['L', 1], ['S', ''], ['S', 'Scene']], [N('RootNode', [['L', 0]])])]),
    N('References'),
    N('Definitions', [], [N('Version', [['I', 100]]), N('Count', [['I', meshes.length * 3 + 1]]),
      N('ObjectType', [['S', 'GlobalSettings']], [N('Count', [['I', 1]])]),
      N('ObjectType', [['S', 'Model']], [N('Count', [['I', meshes.length]])]),
      N('ObjectType', [['S', 'Geometry']], [N('Count', [['I', meshes.length]])]),
      N('ObjectType', [['S', 'Material']], [N('Count', [['I', meshes.length]])])]),
    N('Objects', [], objects),
    N('Connections', [], conns),
  ];
  const head = bytes([new TextEncoder().encode('Kaydara FBX Binary  '), new Uint8Array([0, 0x1a, 0]), new Uint8Array(new Uint32Array([7400]).buffer)]);
  const parts: Uint8Array[] = [head];
  let o = head.length;
  for (const n of root) { const b = fbxNode(n, o); parts.push(b); o += b.length; }
  parts.push(new Uint8Array(13)); o += 13;
  // Footer as written by Blender's exporter (accepted by the Autodesk FBX SDK).
  parts.push(new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]), new Uint8Array(4)); o += 20;
  let pad = ((o + 15) & ~15) - o; if (pad === 0) pad = 16;
  parts.push(new Uint8Array(pad), new Uint8Array(new Uint32Array([7400]).buffer), new Uint8Array(120),
    new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]));
  return bytes(parts);
}

// ------------------------------------------------------------------ COLLADA and KMZ
const DAE_UNIT: Record<string, [string, number]> = { mm: ['millimeter', 0.001], cm: ['centimeter', 0.01], m: ['meter', 1], in: ['inch', 0.0254], ft: ['foot', 0.3048], u: ['meter', 1] };

/** COLLADA 1.4.1: one geometry, material and node per part; unit and up axis declared. */
export function writeDAE(graph: THREE.Object3D, unit: string, up: 'y' | 'z'): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'COLLADA');
  const [uname, meter] = DAE_UNIT[unit] ?? DAE_UNIT.m;
  const effects: string[] = [], mats: string[] = [], geoms: string[] = [], nodes: string[] = [];
  meshes.forEach((m, i) => {
    const id = `p${i}`, nm = xml(m.name);
    effects.push(`<effect id="${id}-fx"><profile_COMMON><technique sid="common"><phong><diffuse><color>${f(m.color.r)} ${f(m.color.g)} ${f(m.color.b)} 1</color></diffuse></phong></technique></profile_COMMON></effect>`);
    mats.push(`<material id="${id}-mat" name="${nm}"><instance_effect url="#${id}-fx"/></material>`);
    const nv = m.pos.length / 3;
    geoms.push(`<geometry id="${id}-geo" name="${nm}"><mesh>
<source id="${id}-pos"><float_array id="${id}-pos-arr" count="${m.pos.length}">${Array.from(m.pos, f).join(' ')}</float_array><technique_common><accessor source="#${id}-pos-arr" count="${nv}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
${m.vcol ? `<source id="${id}-col"><float_array id="${id}-col-arr" count="${m.vcol.length}">${Array.from(m.vcol, f).join(' ')}</float_array><technique_common><accessor source="#${id}-col-arr" count="${nv}" stride="3"><param name="R" type="float"/><param name="G" type="float"/><param name="B" type="float"/></accessor></technique_common></source>\n` : ''}<vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-pos"/>${m.vcol ? `<input semantic="COLOR" source="#${id}-col"/>` : ''}</vertices>
<triangles count="${m.idx.length / 3}" material="mat"><input semantic="VERTEX" source="#${id}-vtx" offset="0"/><p>${Array.from(m.idx).join(' ')}</p></triangles>
</mesh></geometry>`);
    nodes.push(`<node id="${id}-node" name="${nm}"><instance_geometry url="#${id}-geo"><bind_material><technique_common><instance_material symbol="mat" target="#${id}-mat"/></technique_common></bind_material></instance_geometry></node>`);
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><contributor><authoring_tool>OMNIVIEWER</authoring_tool></contributor><created>${new Date().toISOString()}</created><modified>${new Date().toISOString()}</modified><unit name="${uname}" meter="${meter}"/><up_axis>${up === 'z' ? 'Z_UP' : 'Y_UP'}</up_axis></asset>
<library_effects>${effects.join('')}</library_effects>
<library_materials>${mats.join('')}</library_materials>
<library_geometries>${geoms.join('\n')}</library_geometries>
<library_visual_scenes><visual_scene id="scene" name="scene">${nodes.join('')}</visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
}

/** KMZ: a COLLADA model with a KML wrapper, as Google Earth and SketchUp expect. */
export function writeKMZ(graph: THREE.Object3D, unit: string, up: 'y' | 'z', title: string): Uint8Array {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>${xml(title)}</name><Model><altitudeMode>relativeToGround</altitudeMode><Location><longitude>0</longitude><latitude>0</latitude><altitude>0</altitude></Location><Scale><x>1</x><y>1</y><z>1</z></Scale><Link><href>models/model.dae</href></Link></Model></Placemark></kml>
`;
  return zipSync({ 'doc.kml': strToU8(kml), 'models/model.dae': strToU8(writeDAE(graph, unit, up)) });
}

// ------------------------------------------------------------------ 3DS
/** 3D Studio: one object per part (split at 65,535 vertices, the format's limit), with a diffuse colour. */
export function write3DS(graph: THREE.Object3D): Uint8Array {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, '3DS');
  const chunk = (id: number, ...body: Uint8Array[]) => { const b = bytes(body); const h = new DataView(new ArrayBuffer(6)); h.setUint16(0, id, true); h.setUint32(2, b.length + 6, true); return bytes([new Uint8Array(h.buffer), b]); };
  const cstr = (s: string) => bytes([new TextEncoder().encode(asciiOnly(s).slice(0, 10) || 'part'), new Uint8Array(1)]);
  const u16 = (...v: number[]) => new Uint8Array(new Uint16Array(v).buffer);
  const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
  const matChunks: Uint8Array[] = [], objChunks: Uint8Array[] = [];
  meshes.forEach((m, mi) => {
    const mat = `M${mi}`;
    matChunks.push(chunk(0xafff, chunk(0xa000, cstr(mat)), chunk(0xa020, chunk(0x0011, new Uint8Array([m.color.r, m.color.g, m.color.b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)))))));
    // Split into pieces with at most 65,535 vertices.
    let start = 0, piece = 0;
    while (start < m.idx.length) {
      const map = new Map<number, number>(), verts: number[] = [], faces: number[] = [];
      let i = start;
      for (; i < m.idx.length; i += 3) {
        const tri = [m.idx[i], m.idx[i + 1], m.idx[i + 2]];
        const fresh = tri.filter((v) => !map.has(v)).length;
        if (map.size + fresh > 65535) break;
        for (const v of tri) { if (!map.has(v)) { map.set(v, map.size); verts.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]); } faces.push(map.get(v)!); }
        if (faces.length / 3 >= 65535) { i += 3; break; }
      }
      start = i;
      const nf = faces.length / 3;
      const faceData: number[] = []; for (let k = 0; k < faces.length; k += 3) faceData.push(faces[k], faces[k + 1], faces[k + 2], 7);
      const name = `${asciiOnly(m.name).slice(0, piece ? 7 : 10) || 'part'}${piece ? '_' + piece : ''}`;
      objChunks.push(chunk(0x4000, cstr(name), chunk(0x4100,
        chunk(0x4110, u16(verts.length / 3), new Uint8Array(new Float32Array(verts).buffer)),
        chunk(0x4120, u16(nf), u16(...faceData), chunk(0x4130, cstr(mat), u16(nf), u16(...Array.from({ length: nf }, (_, k) => k)))),
      )));
      piece++;
    }
  });
  return chunk(0x4d4d, chunk(0x0002, u32(3)), chunk(0x3d3d, chunk(0x3d3e, u32(3)), ...matChunks, ...objChunks));
}

// ------------------------------------------------------------------ USD (text)
const METERS: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048, u: 1 };
/** USDA (also saved as .usd): Mesh prims with points, faces and display colour; metersPerUnit and upAxis declared. */
export function writeUSDA(graph: THREE.Object3D, unit: string, up: 'y' | 'z'): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'USD');
  const used = new Set<string>();
  const prim = (m: FlatMesh) => {
    let n = ident(m.name); while (used.has(n)) n += '_'; used.add(n);
    const pts: string[] = []; for (let i = 0; i < m.pos.length; i += 3) pts.push(`(${f(m.pos[i])}, ${f(m.pos[i + 1])}, ${f(m.pos[i + 2])})`);
    const cols: string[] = []; if (m.vcol) for (let i = 0; i < m.vcol.length; i += 3) cols.push(`(${f(m.vcol[i])}, ${f(m.vcol[i + 1])}, ${f(m.vcol[i + 2])})`);
    return `    def Mesh "${n}"
    {
        int[] faceVertexCounts = [${Array(m.idx.length / 3).fill(3).join(', ')}]
        int[] faceVertexIndices = [${Array.from(m.idx).join(', ')}]
        point3f[] points = [${pts.join(', ')}]
        color3f[] primvars:displayColor = [${m.vcol ? cols.join(', ') : `(${f(m.color.r)}, ${f(m.color.g)}, ${f(m.color.b)})`}] (
            interpolation = "${m.vcol ? 'vertex' : 'constant'}"
        )
        uniform token subdivisionScheme = "none"
        uniform bool doubleSided = 1
    }`;
  };
  return `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = ${METERS[unit] ?? 1}
    upAxis = "${up === 'z' ? 'Z' : 'Y'}"
    doc = "Written by OMNIVIEWER"
)

def Xform "Root"
{
${meshes.map(prim).join('\n')}
}
`;
}

// ------------------------------------------------------------------ VTK (legacy and XML)
export function writeVTK(graph: THREE.Object3D, title: string): string {
  const { meshes, lines, points } = flatten(graph);
  const pts: number[] = [], polys: string[] = [], segs: string[] = [], verts: string[] = [], cols: number[] = [];
  let colored = false;
  const add = (pos: Float32Array, col: Float32Array | null, c: THREE.Color) => { const base = pts.length / 3; for (let i = 0; i < pos.length; i++) { pts.push(pos[i]); cols.push(col ? col[i] : [c.r, c.g, c.b][i % 3]); } if (col) colored = true; return base; };
  for (const m of meshes) { const b = add(m.pos, m.vcol, m.color); for (let i = 0; i < m.idx.length; i += 3) polys.push(`3 ${m.idx[i] + b} ${m.idx[i + 1] + b} ${m.idx[i + 2] + b}`); }
  for (const l of lines) { const b = add(l.pos, null, new THREE.Color(0.7, 0.7, 0.7)); for (let i = 0; i < l.pos.length / 3; i += 2) segs.push(`2 ${b + i} ${b + i + 1}`); }
  for (const p of points) { const b = add(p.pos, p.vcol, new THREE.Color(0.8, 0.8, 0.8)); for (let i = 0; i < p.pos.length / 3; i++) verts.push(`1 ${b + i}`); }
  const o = ['# vtk DataFile Version 3.0', asciiOnly(title).slice(0, 250) || 'OMNIVIEWER', 'ASCII', 'DATASET POLYDATA', `POINTS ${pts.length / 3} float`];
  for (let i = 0; i < pts.length; i += 3) o.push(`${f(pts[i])} ${f(pts[i + 1])} ${f(pts[i + 2])}`);
  if (verts.length) o.push(`VERTICES ${verts.length} ${verts.length * 2}`, ...verts);
  if (segs.length) o.push(`LINES ${segs.length} ${segs.length * 3}`, ...segs);
  if (polys.length) o.push(`POLYGONS ${polys.length} ${polys.length * 4}`, ...polys);
  if (colored) { o.push(`POINT_DATA ${pts.length / 3}`, 'COLOR_SCALARS rgb 3'); for (let i = 0; i < cols.length; i += 3) o.push(`${f(cols[i])} ${f(cols[i + 1])} ${f(cols[i + 2])}`); }
  return o.join('\n') + '\n';
}

export function writeVTP(graph: THREE.Object3D): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'VTP');
  const pts: number[] = [], conn: number[] = [], offs: number[] = [], cols: number[] = [];
  let colored = false;
  for (const m of meshes) {
    const b = pts.length / 3;
    for (let i = 0; i < m.pos.length; i++) { pts.push(m.pos[i]); cols.push(Math.round((m.vcol ? m.vcol[i] : [m.color.r, m.color.g, m.color.b][i % 3]) * 255)); }
    if (m.vcol) colored = true;
    for (let i = 0; i < m.idx.length; i++) { conn.push(m.idx[i] + b); if (i % 3 === 2) offs.push(conn.length); }
  }
  return `<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
  <PolyData>
    <Piece NumberOfPoints="${pts.length / 3}" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="${offs.length}">
      <Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">${pts.map(f).join(' ')}</DataArray></Points>
${colored ? `      <PointData Scalars="Colors"><DataArray type="UInt8" Name="Colors" NumberOfComponents="3" format="ascii">${cols.join(' ')}</DataArray></PointData>\n` : ''}      <Polys>
        <DataArray type="Int32" Name="connectivity" format="ascii">${conn.join(' ')}</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">${offs.join(' ')}</DataArray>
      </Polys>
    </Piece>
  </PolyData>
</VTKFile>
`;
}

// ------------------------------------------------------------------ LightWave LWO2
/** LightWave object (LWO2, metres): one surface per part with its colour. LightWave is left-handed: Z is mirrored. */
export function writeLWO(graph: THREE.Object3D): Uint8Array {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'LWO');
  const enc = new TextEncoder();
  const be = (n: number, size: 2 | 4) => { const d = new DataView(new ArrayBuffer(size)); if (size === 2) d.setUint16(0, n); else d.setUint32(0, n); return new Uint8Array(d.buffer); };
  const s0 = (s: string) => { const b = enc.encode(asciiOnly(s) || 'part'); const out = new Uint8Array(b.length + (b.length % 2 === 0 ? 2 : 1)); out.set(b); return out; };
  const vx = (i: number) => (i < 0xff00 ? be(i, 2) : be(0xff000000 | i, 4));
  const ch = (id: string, body: Uint8Array) => bytes([enc.encode(id), be(body.length, 4), body, body.length % 2 ? new Uint8Array(1) : new Uint8Array(0)]);
  const sub = (id: string, body: Uint8Array) => bytes([enc.encode(id), be(body.length, 2), body]);
  const names = meshes.map((m, i) => `${asciiOnly(m.name) || 'part'}_${i}`);
  const pnts: number[] = [], pols: Uint8Array[] = [enc.encode('FACE')], ptag: Uint8Array[] = [enc.encode('SURF')];
  let poly = 0;
  meshes.forEach((m, si) => {
    const b = pnts.length / 3;
    for (let i = 0; i < m.pos.length; i += 3) pnts.push(m.pos[i], m.pos[i + 1], -m.pos[i + 2]);
    for (let i = 0; i < m.idx.length; i += 3) {
      pols.push(be(3, 2), vx(m.idx[i] + b), vx(m.idx[i + 2] + b), vx(m.idx[i + 1] + b)); // mirrored Z: reverse winding
      ptag.push(vx(poly++), be(si, 2));
    }
  });
  const pts = new DataView(new ArrayBuffer(pnts.length * 4)); pnts.forEach((v, i) => pts.setFloat32(i * 4, v));
  const surfs = meshes.map((m, i) => {
    const col = new DataView(new ArrayBuffer(12)); col.setFloat32(0, m.color.r); col.setFloat32(4, m.color.g); col.setFloat32(8, m.color.b);
    const diff = new DataView(new ArrayBuffer(4)); diff.setFloat32(0, 1);
    return ch('SURF', bytes([s0(names[i]), s0(''), sub('COLR', bytes([new Uint8Array(col.buffer), be(0, 2)])), sub('DIFF', bytes([new Uint8Array(diff.buffer), be(0, 2)]))]));
  });
  const body = bytes([enc.encode('LWO2'),
    ch('TAGS', bytes(names.map(s0))),
    ch('LAYR', bytes([be(0, 2), be(0, 2), new Uint8Array(12), s0('Layer 1')])),
    ch('PNTS', new Uint8Array(pts.buffer)),
    ch('POLS', bytes(pols)),
    ch('PTAG', bytes(ptag)),
    ...surfs]);
  return bytes([enc.encode('FORM'), be(body.length, 4), body]);
}

// ------------------------------------------------------------------ MagicaVoxel VOX
/** Voxelises the model into at most `res` voxels along its longest side (solid inside), colours from the parts. */
export function writeVOX(graph: THREE.Object3D, res = 128): Uint8Array {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'VOX');
  const box = new THREE.Box3();
  for (const m of meshes) for (let i = 0; i < m.pos.length; i += 3) box.expandByPoint(new THREE.Vector3(m.pos[i], m.pos[i + 1], m.pos[i + 2]));
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const res2 = Math.min(256, Math.max(8, res));
  const vs = longest / (res2 - 1);
  const dims = [size.x, size.y, size.z].map((d) => Math.min(256, Math.max(1, Math.ceil(d / vs) + 1)));
  // Grid with a 1-voxel empty border for the outside flood fill.
  const [X, Y, Z] = dims.map((d) => d + 2);
  const grid = new Uint8Array(X * Y * Z); // 0 empty, 255 outside, otherwise palette index
  const palette: THREE.Color[] = [];
  const palIndex = (c: THREE.Color) => {
    let k = palette.findIndex((p) => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) < 0.02);
    if (k < 0) { if (palette.length >= 254) k = 0; else { palette.push(c.clone()); k = palette.length - 1; } }
    return k + 1;
  };
  const at = (x: number, y: number, z: number) => x + X * (y + Y * z);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  for (const m of meshes) {
    for (let i = 0; i < m.idx.length; i += 3) {
      const ia = m.idx[i], ib = m.idx[i + 1], ic = m.idx[i + 2];
      a.fromArray(m.pos, ia * 3); b.fromArray(m.pos, ib * 3); c.fromArray(m.pos, ic * 3);
      const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / (vs * 0.5)));
      if (m.vcol) col.setRGB((m.vcol[ia * 3] + m.vcol[ib * 3] + m.vcol[ic * 3]) / 3, (m.vcol[ia * 3 + 1] + m.vcol[ib * 3 + 1] + m.vcol[ic * 3 + 1]) / 3, (m.vcol[ia * 3 + 2] + m.vcol[ib * 3 + 2] + m.vcol[ic * 3 + 2]) / 3);
      else col.copy(m.color);
      const k = palIndex(col);
      for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
        const w = steps - u - v;
        p.set(0, 0, 0).addScaledVector(a, u / steps).addScaledVector(b, v / steps).addScaledVector(c, w / steps);
        const gx = Math.round((p.x - box.min.x) / vs) + 1, gy = Math.round((p.y - box.min.y) / vs) + 1, gz = Math.round((p.z - box.min.z) / vs) + 1;
        grid[at(gx, gy, gz)] = k;
      }
    }
  }
  // Flood the outside from a corner; whatever stays empty is inside the model and gets filled.
  const stack = [0]; grid[0] = 255;
  while (stack.length) {
    const i = stack.pop()!; const x = i % X, y = Math.floor(i / X) % Y, z = Math.floor(i / (X * Y));
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z) continue;
      const j = at(nx, ny, nz); if (grid[j] === 0) { grid[j] = 255; stack.push(j); }
    }
  }
  const fill = palIndex(meshes[0].color);
  const xyzi: number[] = [];
  for (let z = 1; z < Z - 1; z++) for (let y = 1; y < Y - 1; y++) for (let x = 1; x < X - 1; x++) {
    let v = grid[at(x, y, z)]; if (v === 255) continue; if (v === 0) v = fill;
    xyzi.push(x - 1, y - 1, z - 1, v);
  }
  const i32 = (...v: number[]) => new Uint8Array(new Int32Array(v).buffer);
  const chunk = (id: string, content: Uint8Array, children: Uint8Array = new Uint8Array(0)) => bytes([new TextEncoder().encode(id), i32(content.length, children.length), content, children]);
  const rgba = new Uint8Array(1024);
  palette.forEach((p2, i) => rgba.set([p2.r, p2.g, p2.b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).concat(255), i * 4));
  const kids = bytes([chunk('SIZE', i32(dims[0], dims[1], dims[2])), chunk('XYZI', bytes([i32(xyzi.length / 4), new Uint8Array(xyzi)])), chunk('RGBA', rgba)]);
  return bytes([new TextEncoder().encode('VOX '), i32(150), chunk('MAIN', new Uint8Array(0), kids)]);
}

// ------------------------------------------------------------------ Quake MD2
const MD2_NORMAL_COUNT = 162;
/** MD2 (one frame, up to 2,048 vertices): positions are stored as 8-bit values in the model's bounding box. */
export function writeMD2(graph: THREE.Object3D): Uint8Array {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'MD2');
  const pos: number[] = [], tris: number[] = [];
  for (const m of meshes) { const b = pos.length / 3; pos.push(...m.pos); for (const i of m.idx) tris.push(i + b); }
  const nv = pos.length / 3, nt = tris.length / 3;
  if (nv > 2048) throw new Error(`MD2 holds at most 2,048 vertices; this model has ${nv.toLocaleString()}. Use Reduce & optimise first.`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]); }
  const scale = max.map((v, k) => (v - min[k]) / 255 || 1);
  const frameSize = 40 + nv * 4;
  const ofsSt = 68, ofsTris = ofsSt + 4, ofsFrames = ofsTris + nt * 12, ofsGl = ofsFrames + frameSize, ofsEnd = ofsGl + 4;
  const dv = new DataView(new ArrayBuffer(ofsEnd));
  'IDP2'.split('').forEach((ch2, i) => dv.setUint8(i, ch2.charCodeAt(0)));
  [8, 256, 256, frameSize, 0, nv, 1, nt, 1, 1, 68, ofsSt, ofsTris, ofsFrames, ofsGl, ofsEnd].forEach((v, i) => dv.setInt32(4 + i * 4, v, true));
  dv.setInt16(ofsSt, 0, true); dv.setInt16(ofsSt + 2, 0, true);
  for (let i = 0; i < nt; i++) { for (let k = 0; k < 3; k++) dv.setUint16(ofsTris + i * 12 + k * 2, tris[i * 3 + k], true); for (let k = 0; k < 3; k++) dv.setUint16(ofsTris + i * 12 + 6 + k * 2, 0, true); }
  for (let k = 0; k < 3; k++) { dv.setFloat32(ofsFrames + k * 4, scale[k], true); dv.setFloat32(ofsFrames + 12 + k * 4, min[k], true); }
  'frame1'.split('').forEach((ch2, i) => dv.setUint8(ofsFrames + 24 + i, ch2.charCodeAt(0)));
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) dv.setUint8(ofsFrames + 40 + i * 4 + k, Math.round((pos[i * 3 + k] - min[k]) / scale[k]));
  for (let i = 0; i < nv; i++) dv.setUint8(ofsFrames + 40 + i * 4 + 3, i % MD2_NORMAL_COUNT === 0 ? 0 : 0);
  dv.setInt32(ofsGl, 0, true);
  return new Uint8Array(dv.buffer);
}

// ------------------------------------------------------------------ point clouds: PCD, PTS, LAS
export function writePCD(graph: THREE.Object3D): string {
  const { pos, col, n } = allPoints(graph);
  const o = ['# .PCD v0.7 - Point Cloud Data file format (OMNIVIEWER)', 'VERSION 0.7', 'FIELDS x y z rgb', 'SIZE 4 4 4 4', 'TYPE F F F U', 'COUNT 1 1 1 1', `WIDTH ${n}`, 'HEIGHT 1', 'VIEWPOINT 0 0 0 1 0 0 0', `POINTS ${n}`, 'DATA ascii'];
  for (let i = 0; i < n; i++) {
    const rgb = (Math.round(col[i * 3] * 255) << 16) | (Math.round(col[i * 3 + 1] * 255) << 8) | Math.round(col[i * 3 + 2] * 255);
    o.push(`${f(pos[i * 3])} ${f(pos[i * 3 + 1])} ${f(pos[i * 3 + 2])} ${rgb >>> 0}`);
  }
  return o.join('\n') + '\n';
}
export function writePTS(graph: THREE.Object3D): string {
  const { pos, col, n } = allPoints(graph);
  const o = [String(n)];
  for (let i = 0; i < n; i++) o.push(`${f(pos[i * 3])} ${f(pos[i * 3 + 1])} ${f(pos[i * 3 + 2])} 0 ${Math.round(col[i * 3] * 255)} ${Math.round(col[i * 3 + 1] * 255)} ${Math.round(col[i * 3 + 2] * 255)}`);
  return o.join('\n') + '\n';
}
/** LAS 1.2, point format 2 (XYZ + RGB), 0.1 mm-class precision relative to the model's extent. */
export function writeLAS(graph: THREE.Object3D): Uint8Array {
  const { pos, col, n } = allPoints(graph);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]); }
  if (!n) throw new Error('There are no points to write.');
  const scale = max.map((v, k) => Math.max((v - min[k]) / 2e9, 1e-7));
  const rec = 26, off = 227, dv = new DataView(new ArrayBuffer(off + rec * n));
  'LASF'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint8(24, 1); dv.setUint8(25, 2);
  'OMNIVIEWER'.split('').forEach((c, i) => dv.setUint8(58 + i, c.charCodeAt(0)));
  const d = new Date(); dv.setUint16(90, Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5), true); dv.setUint16(92, d.getUTCFullYear(), true);
  dv.setUint16(94, off, true); dv.setUint32(96, off, true); dv.setUint32(100, 0, true); dv.setUint8(104, 2); dv.setUint16(105, rec, true); dv.setUint32(107, n, true); dv.setUint32(111, n, true);
  for (let k = 0; k < 3; k++) { dv.setFloat64(131 + k * 8, scale[k], true); dv.setFloat64(155 + k * 8, min[k], true); }
  dv.setFloat64(179, max[0], true); dv.setFloat64(187, min[0], true); dv.setFloat64(195, max[1], true); dv.setFloat64(203, min[1], true); dv.setFloat64(211, max[2], true); dv.setFloat64(219, min[2], true);
  for (let i = 0; i < n; i++) {
    const p = off + i * rec;
    for (let k = 0; k < 3; k++) dv.setInt32(p + k * 4, Math.round((pos[i * 3 + k] - min[k]) / scale[k]), true);
    for (let k = 0; k < 3; k++) dv.setUint16(p + 20 + k * 2, Math.round(col[i * 3 + k] * 65535), true);
  }
  return new Uint8Array(dv.buffer);
}

// ------------------------------------------------------------------ Gaussian splats (.splat, .spz, .ksplat) from points
/** Each vertex / point becomes one small round splat sized from the point spacing. */
function splatParams(graph: THREE.Object3D) {
  const { pos, col, n } = allPoints(graph);
  if (!n) throw new Error('There are no points to turn into splats.');
  const box = new THREE.Box3(); for (let i = 0; i < pos.length; i += 3) box.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
  const diag = box.getSize(new THREE.Vector3()).length() || 1;
  const s = Math.max(diag / Math.cbrt(n) / 2.5, diag / 2000);
  return { pos, col, n, s };
}
export function writeSPLAT(graph: THREE.Object3D): Uint8Array {
  const { pos, col, n, s } = splatParams(graph);
  const dv = new DataView(new ArrayBuffer(n * 32));
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    for (let k = 0; k < 3; k++) { dv.setFloat32(o + k * 4, pos[i * 3 + k], true); dv.setFloat32(o + 12 + k * 4, s, true); dv.setUint8(o + 24 + k, Math.round(col[i * 3 + k] * 255)); }
    dv.setUint8(o + 27, 255);
    dv.setUint8(o + 28, 255); dv.setUint8(o + 29, 128); dv.setUint8(o + 30, 128); dv.setUint8(o + 31, 128); // identity rotation (w, x, y, z)
  }
  return new Uint8Array(dv.buffer);
}
export function writeSPZ(graph: THREE.Object3D): Uint8Array {
  const { pos, col, n, s } = splatParams(graph);
  let maxAbs = 1; for (let i = 0; i < pos.length; i++) maxAbs = Math.max(maxAbs, Math.abs(pos[i]));
  const frac = Math.max(0, Math.min(16, Math.floor(Math.log2(8388607 / maxAbs))));
  const size = 16 + n * 9 + n + n * 3 + n * 3 + n * 3;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 2, true); dv.setUint32(8, n, true); dv.setUint8(12, 0); dv.setUint8(13, frac); dv.setUint8(14, 0);
  let o = 16;
  for (let i = 0; i < n * 3; i++) { let v = Math.round(pos[i] * (1 << frac)); v = Math.max(-8388608, Math.min(8388607, v)); out[o++] = v & 255; out[o++] = (v >> 8) & 255; out[o++] = (v >> 16) & 255; }
  for (let i = 0; i < n; i++) out[o++] = 255;
  const C = 0.28209479177387814 / 0.15;
  for (let i = 0; i < n * 3; i++) out[o++] = Math.max(0, Math.min(255, Math.round(((col[i] - 0.5) / C + 0.5) * 255)));
  const sb = Math.max(0, Math.min(255, Math.round((Math.log(s) + 10) * 16)));
  for (let i = 0; i < n * 3; i++) out[o++] = sb;
  for (let i = 0; i < n; i++) { out[o++] = 128; out[o++] = 128; out[o++] = 128; } // identity quaternion (x, y, z = 0)
  return gzipSync(out);
}
export function writeKSPLAT(graph: THREE.Object3D): Uint8Array {
  const { pos, col, n, s } = splatParams(graph);
  const per = 44, base = 4096 + 1024;
  const dv = new DataView(new ArrayBuffer(base + n * per));
  dv.setUint8(0, 0); dv.setUint8(1, 1); dv.setUint32(4, 1, true); dv.setUint32(8, 1, true); dv.setUint32(12, n, true); dv.setUint32(16, n, true); dv.setUint16(20, 0, true);
  const sh = 4096;
  dv.setUint32(sh, n, true); dv.setUint32(sh + 4, n, true); dv.setUint32(sh + 8, 0, true); dv.setUint32(sh + 12, 0, true);
  dv.setFloat32(sh + 16, 0, true); dv.setUint16(sh + 20, 0, true); dv.setUint32(sh + 24, 1, true); dv.setUint32(sh + 32, 0, true); dv.setUint32(sh + 36, 0, true); dv.setUint16(sh + 40, 0, true);
  for (let i = 0; i < n; i++) {
    const o = base + i * per;
    for (let k = 0; k < 3; k++) { dv.setFloat32(o + k * 4, pos[i * 3 + k], true); dv.setFloat32(o + 12 + k * 4, s, true); }
    dv.setFloat32(o + 24, 1, true); dv.setFloat32(o + 28, 0, true); dv.setFloat32(o + 32, 0, true); dv.setFloat32(o + 36, 0, true);
    for (let k = 0; k < 3; k++) dv.setUint8(o + 40 + k, Math.round(col[i * 3 + k] * 255));
    dv.setUint8(o + 43, 255);
  }
  return new Uint8Array(dv.buffer);
}

// ------------------------------------------------------------------ STEP and IGES (faceted)
const STEP_UNIT: Record<string, [string, number]> = { mm: ['.MILLI.', 1], cm: ['.CENTI.', 1], m: ['$', 1], in: ['.MILLI.', 25.4], ft: ['.MILLI.', 304.8], u: ['.MILLI.', 1] };

/** Welds coincident vertices so shells can be checked for closure and STEP points are shared. */
function weld(m: FlatMesh) {
  const key = (i: number) => `${m.pos[i * 3].toFixed(6)},${m.pos[i * 3 + 1].toFixed(6)},${m.pos[i * 3 + 2].toFixed(6)}`;
  const map = new Map<string, number>(), remap = new Int32Array(m.pos.length / 3), pts: number[] = [];
  for (let i = 0; i < remap.length; i++) { const k = key(i); let j = map.get(k); if (j === undefined) { j = pts.length / 3; map.set(k, j); pts.push(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]); } remap[i] = j; }
  const tris: number[] = [];
  for (let i = 0; i < m.idx.length; i += 3) { const a = remap[m.idx[i]], b = remap[m.idx[i + 1]], c = remap[m.idx[i + 2]]; if (a !== b && b !== c && a !== c) tris.push(a, b, c); }
  const edges = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { const a = tris[i + k], b = tris[i + (k + 1) % 3]; const e = a < b ? `${a}_${b}` : `${b}_${a}`; edges.set(e, (edges.get(e) || 0) + 1); }
  const closed = tris.length > 0 && [...edges.values()].every((v) => v === 2);
  return { pts, tris, closed };
}

/** STEP AP214, faceted: every triangle is a planar face. Closed meshes become a solid (faceted B-rep), open ones a surface model. */
export function writeSTEP(graph: THREE.Object3D, unit: string, name: string): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'STEP');
  const [prefix, k] = STEP_UNIT[unit] ?? STEP_UNIT.mm;
  const L: string[] = [];
  let n = 0;
  const e = (s: string) => { L.push(`#${++n}=${s};`); return n; };
  const title = asciiOnly(name) || 'model';
  const ctxUnits = [e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${prefix},.METRE.))`), e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))'), e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())')];
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${ctxUnits[0]},'distance_accuracy_value','')`);
  const ctx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${ctxUnits.join(',#')}))REPRESENTATION_CONTEXT('',''))`);
  const origin = e("CARTESIAN_POINT('',(0.,0.,0.))"), dz = e("DIRECTION('',(0.,0.,1.))"), dx = e("DIRECTION('',(1.,0.,0.))");
  const axis = e(`AXIS2_PLACEMENT_3D('',#${origin},#${dz},#${dx})`);
  const items: number[] = [];
  let anyOpen = false;
  for (const m of meshes) {
    const w = weld(m);
    const pid = new Int32Array(w.pts.length / 3);
    for (let i = 0; i < pid.length; i++) pid[i] = e(`CARTESIAN_POINT('',(${fd(w.pts[i * 3] * k)},${fd(w.pts[i * 3 + 1] * k)},${fd(w.pts[i * 3 + 2] * k)}))`);
    const faces: number[] = [];
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let i = 0; i < w.tris.length; i += 3) {
      A.fromArray(w.pts, w.tris[i] * 3); B.fromArray(w.pts, w.tris[i + 1] * 3); C.fromArray(w.pts, w.tris[i + 2] * 3);
      const nrm = B.clone().sub(A).cross(C.clone().sub(A));
      if (nrm.lengthSq() < 1e-30) continue;
      nrm.normalize();
      const ref = B.clone().sub(A).normalize();
      // Each facet is a FACE_SURFACE on its own PLANE (OpenCascade and most CAD readers need the surface).
      const plane = e(`PLANE('',#${e(`AXIS2_PLACEMENT_3D('',#${pid[w.tris[i]]},#${e(`DIRECTION('',(${fd(nrm.x)},${fd(nrm.y)},${fd(nrm.z)}))`)},#${e(`DIRECTION('',(${fd(ref.x)},${fd(ref.y)},${fd(ref.z)}))`)})`)})`);
      const loop = e(`POLY_LOOP('',(#${pid[w.tris[i]]},#${pid[w.tris[i + 1]]},#${pid[w.tris[i + 2]]}))`);
      const bound = e(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(e(`FACE_SURFACE('',(#${bound}),#${plane},.T.)`));
    }
    const label = asciiOnly(m.name).slice(0, 60);
    if (w.closed) items.push(e(`FACETED_BREP('${label}',#${e(`CLOSED_SHELL('',(#${faces.join(',#')}))`)})`));
    else { anyOpen = true; items.push(e(`SHELL_BASED_SURFACE_MODEL('${label}',(#${e(`OPEN_SHELL('',(#${faces.join(',#')}))`)}))`)); }
  }
  const rep = anyOpen
    ? e(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${title}',(#${axis},#${items.join(',#')}),#${ctx})`)
    : e(`FACETED_BREP_SHAPE_REPRESENTATION('${title}',(#${axis},#${items.join(',#')}),#${ctx})`);
  const appCtx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const pctx = e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('${title}','${title}','',(#${pctx}))`);
  e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdctx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdctx})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const t = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('OMNIVIEWER faceted model'),'2;1');
FILE_NAME('${title}.step','${t}',(''),(''),'OMNIVIEWER','OMNIVIEWER','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
${L.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
}

const IGES_UNIT: Record<string, [number, string, number]> = { mm: [2, 'MM', 1], cm: [10, 'CM', 1], m: [6, 'M', 1], in: [1, 'IN', 1], ft: [4, 'FT', 1], u: [2, 'MM', 1] };

/** IGES 5.3, faceted: each triangle is a trimmed plane (type 144 over 108, bounded by 3 lines). */
export function writeIGES(graph: THREE.Object3D, unit: string, name: string): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'IGES');
  const [uflag, uname] = IGES_UNIT[unit] ?? IGES_UNIT.mm;
  type Ent = { type: number; params: (number | string)[]; status: string; form?: number };
  const ents: Ent[] = [];
  const add = (type: number, params: (number | string)[], status = '00000000', form = 0) => { ents.push({ type, params, status, form }); return ents.length * 2 - 1; };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let maxCoord = 1;
  for (const m of meshes) {
    for (let i = 0; i < m.pos.length; i++) maxCoord = Math.max(maxCoord, Math.abs(m.pos[i]));
    for (let i = 0; i < m.idx.length; i += 3) {
      a.fromArray(m.pos, m.idx[i] * 3); b.fromArray(m.pos, m.idx[i + 1] * 3); c.fromArray(m.pos, m.idx[i + 2] * 3);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a));
      if (nrm.lengthSq() < 1e-24) continue;
      nrm.normalize();
      const l1 = add(110, [a.x, a.y, a.z, b.x, b.y, b.z], '00010500');
      const l2 = add(110, [b.x, b.y, b.z, c.x, c.y, c.z], '00010500');
      const l3 = add(110, [c.x, c.y, c.z, a.x, a.y, a.z], '00010500');
      const comp = add(102, [3, l1, l2, l3], '00010500');
      const plane = add(108, [nrm.x, nrm.y, nrm.z, nrm.dot(a), 0, 0, 0, 0, 0], '00010000');
      const cos = add(142, [1, plane, 0, comp, 2], '00010500');
      add(144, [plane, 1, 0, cos], '00000000');
    }
  }
  const num = (v: number | string) => (typeof v === 'string' ? v : Number.isInteger(v) ? String(v) : (Math.abs(v) < 1e-12 ? '0.' : v.toExponential(9).replace('e', 'E')));
  const hol = (s: string) => `${s.length}H${s}`;
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  const right = (s: string | number, n = 8) => { const t = String(s); return t.length >= n ? t.slice(-n) : ' '.repeat(n - t.length) + t; };
  const lines = (text: string, sect: string, width = 72) => { const out: string[] = []; for (let i = 0; i < text.length; i += width) out.push(pad(text.slice(i, i + width), width)); return out.map((l, i) => `${l}${sect}${right(i + 1, 7)}`); };
  const title = asciiOnly(name) || 'model';
  const S = lines('OMNIVIEWER faceted IGES export', 'S');
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6}).*/, '$1.$2');
  const G = lines([hol(','), hol(';'), hol(title), hol(`${title}.igs`), hol('OMNIVIEWER'), hol('OMNIVIEWER'), 32, 38, 6, 308, 15, hol(title), 1, uflag, hol(uname), 1, 0.01, hol(now), 1e-6, maxCoord, hol(''), hol(''), 11, 0, hol(now)].map(num).join(',') + ';', 'G');
  const D: string[] = [], Pl: string[] = [];
  let pseq = 1;
  ents.forEach((en, i) => {
    const dseq = i * 2 + 1;
    const body = [en.type, ...en.params].map(num).join(',') + ';';
    const chunks: string[] = []; for (let k = 0; k < body.length; k += 64) chunks.push(body.slice(k, k + 64));
    const start = pseq;
    for (const ch of chunks) Pl.push(`${pad(ch, 64)}${right(dseq, 8)}P${right(pseq++, 7)}`);
    D.push(`${right(en.type)}${right(start)}${right(0)}${right(0)}${right(0)}${right(0)}${right(0)}${right(0)}${right(en.status)}D${right(dseq, 7)}`);
    D.push(`${right(en.type)}${right(0)}${right(0)}${right(chunks.length)}${right(en.form ?? 0)}${right('')}${right('')}${right('')}${right(0)}D${right(dseq + 1, 7)}`);
  });
  const T = `${pad(`S${right(S.length, 7)}G${right(G.length, 7)}D${right(D.length, 7)}P${right(Pl.length, 7)}`, 72)}T${right(1, 7)}`;
  return [...S, ...G, ...D, ...Pl, T].join('\n') + '\n';
}

// ------------------------------------------------------------------ OpenCascade BREP (ASCII), faceted
/** OCCT BREP v1: a compound of planar triangular faces with their edges and vertices. */
export function writeBREP(graph: THREE.Object3D): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'BREP');
  const surfaces: string[] = [], curves: string[] = [], shapes: string[] = [];
  const g = (v: number) => (Math.abs(v) < 1e-15 ? '0' : String(+v.toPrecision(15)));
  // Shapes are listed children-first; references are written as +index / -index counted from the end (1-based).
  const add = (s: string) => { shapes.push(s); return shapes.length; };
  const faces: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const m of meshes) {
    const w = weld(m);
    const vid = new Int32Array(w.pts.length / 3);
    for (let i = 0; i < vid.length; i++) vid[i] = add(`Ve\n1e-07\n${g(w.pts[i * 3])} ${g(w.pts[i * 3 + 1])} ${g(w.pts[i * 3 + 2])}\n0 0\n\n0101101\n*`);
    const edgeOf = new Map<string, [number, boolean]>();
    const edge = (p: number, q: number): [number, boolean] => {
      const k = p < q ? `${p}_${q}` : `${q}_${p}`;
      const hit = edgeOf.get(k);
      if (hit) return [hit[0], (p < q) === hit[1]];
      const P = new THREE.Vector3().fromArray(w.pts, p * 3), Q = new THREE.Vector3().fromArray(w.pts, q * 3);
      const len = P.distanceTo(Q), dir = Q.clone().sub(P).normalize();
      curves.push(`1 ${g(P.x)} ${g(P.y)} ${g(P.z)} ${g(dir.x)} ${g(dir.y)} ${g(dir.z)}`);
      const id = add(`Ed\n 1e-07 1 1 0\n1 ${curves.length} 0 0 ${g(len)}\n0\n\n0101000\n+${vid[p]} 0 -${vid[q]} 0 *`);
      edgeOf.set(k, [id, p < q]);
      return [id, true];
    };
    for (let i = 0; i < w.tris.length; i += 3) {
      const t = [w.tris[i], w.tris[i + 1], w.tris[i + 2]];
      a.fromArray(w.pts, t[0] * 3); b.fromArray(w.pts, t[1] * 3); c.fromArray(w.pts, t[2] * 3);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-24) continue;
      n.normalize();
      const xd = b.clone().sub(a).normalize(), yd = n.clone().cross(xd);
      surfaces.push(`1 ${g(a.x)} ${g(a.y)} ${g(a.z)} ${g(n.x)} ${g(n.y)} ${g(n.z)} ${g(xd.x)} ${g(xd.y)} ${g(xd.z)} ${g(yd.x)} ${g(yd.y)} ${g(yd.z)}`);
      const es = [edge(t[0], t[1]), edge(t[1], t[2]), edge(t[2], t[0])];
      const wire = add(`Wi\n\n0101100\n${es.map(([id, fwd]) => `${fwd ? '+' : '-'}${id} 0`).join(' ')} *`);
      faces.push(add(`Fa\n0  1e-07 ${surfaces.length} 0\n0\n0101000\n+${wire} 0 *`));
    }
  }
  const comp = add(`Co\n\n1100000\n${faces.map((id) => `+${id} 0`).join(' ')} *`);
  // BREP shape references count from the end of the list: index i becomes (total - i + 1).
  const total = shapes.length;
  const fix = (s: string) => s.replace(/([+-])(\d+) 0/g, (_, sign, id) => `${sign}${total - Number(id) + 1} 0`);
  return `DBRep_DrawableShape

CASCADE Topology V1, (c) Matra-Datavision
Locations 0
Curve2ds 0
Curves ${curves.length}
${curves.join('\n')}
Polygon3D 0
PolygonOnTriangulations 0
Surfaces ${surfaces.length}
${surfaces.join('\n')}
Triangulations 0

TShapes ${total}
${shapes.map(fix).join('\n')}

+${total - comp + 1} 0
`;
}

// ------------------------------------------------------------------ IFC4 (tessellated)
const IFC_UNIT: Record<string, [string, number]> = { mm: ['.MILLI.', 1], cm: ['.CENTI.', 1], m: ['$', 1], in: ['.MILLI.', 25.4], ft: ['.MILLI.', 304.8], u: ['.MILLI.', 1] };
const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const guid = () => { let s = GUID_CHARS[Math.floor(Math.random() * 4)]; for (let i = 0; i < 21; i++) s += GUID_CHARS[Math.floor(Math.random() * 64)]; return s; };

/** IFC4: one IfcBuildingElementProxy per part with a triangulated face set and its colour, in a site / building / storey. */
export function writeIFC(graph: THREE.Object3D, unit: string, name: string): string {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, 'IFC');
  const [prefix, k] = IFC_UNIT[unit] ?? IFC_UNIT.mm;
  const L: string[] = []; let n = 0;
  const e = (s: string) => { L.push(`#${++n}=${s};`); return n; };
  const title = asciiOnly(name) || 'model';
  const lu = e(`IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.)`), au = e('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = e(`IFCUNITASSIGNMENT((#${lu},#${au}))`);
  const o = e('IFCCARTESIANPOINT((0.,0.,0.))'), ax = e(`IFCAXIS2PLACEMENT3D(#${o},$,$)`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${ax},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const proj = e(`IFCPROJECT('${guid()}',$,'${title}',$,$,$,$,(#${ctx}),#${units})`);
  const place = () => e(`IFCLOCALPLACEMENT($,#${ax})`);
  const site = e(`IFCSITE('${guid()}',$,'Site',$,$,#${place()},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldg = e(`IFCBUILDING('${guid()}',$,'Building',$,$,#${place()},$,$,.ELEMENT.,$,$,$)`);
  const storey = e(`IFCBUILDINGSTOREY('${guid()}',$,'Level 0',$,$,#${place()},$,$,.ELEMENT.,0.)`);
  e(`IFCRELAGGREGATES('${guid()}',$,$,$,#${proj},(#${site}))`);
  e(`IFCRELAGGREGATES('${guid()}',$,$,$,#${site},(#${bldg}))`);
  e(`IFCRELAGGREGATES('${guid()}',$,$,$,#${bldg},(#${storey}))`);
  const elems: number[] = [];
  for (const m of meshes) {
    const pts: string[] = []; for (let i = 0; i < m.pos.length; i += 3) pts.push(`(${fd(m.pos[i] * k)},${fd(m.pos[i + 1] * k)},${fd(m.pos[i + 2] * k)})`);
    const tri: string[] = []; for (let i = 0; i < m.idx.length; i += 3) tri.push(`(${m.idx[i] + 1},${m.idx[i + 1] + 1},${m.idx[i + 2] + 1})`);
    const list = e(`IFCCARTESIANPOINTLIST3D((${pts.join(',')}),$)`);
    const tfs = e(`IFCTRIANGULATEDFACESET(#${list},$,$,(${tri.join(',')}),$)`);
    const rgb = e(`IFCCOLOURRGB($,${fd(m.color.r)},${fd(m.color.g)},${fd(m.color.b)})`);
    const shading = e(`IFCSURFACESTYLESHADING(#${rgb},0.)`);
    const style = e(`IFCSURFACESTYLE($,.BOTH.,(#${shading}))`);
    e(`IFCSTYLEDITEM(#${tfs},(#${style}),$)`);
    const srep = e(`IFCSHAPEREPRESENTATION(#${body},'Body','Tessellation',(#${tfs}))`);
    const pds = e(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${srep}))`);
    elems.push(e(`IFCBUILDINGELEMENTPROXY('${guid()}',$,'${asciiOnly(m.name).slice(0, 120) || 'Part'}',$,$,#${place()},#${pds},$,.ELEMENT.)`));
  }
  e(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(#${elems.join(',#')}),#${storey})`);
  const t = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('${title}.ifc','${t}',(''),(''),'OMNIVIEWER','OMNIVIEWER','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${L.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
}

// ------------------------------------------------------------------ Rhino 3DM (rhino3dm WebAssembly)
let rhinoP: Promise<any> | null = null;
async function rhino(): Promise<any> {
  if (!rhinoP) rhinoP = (async () => {
    if (typeof document !== 'undefined') {
      const { libUrl } = await import('./loaders');
      if (!(globalThis as any).rhino3dm) await new Promise<void>((res, rej) => { const s = document.createElement('script'); s.src = libUrl('rhino3dm/rhino3dm.js'); s.onload = () => res(); s.onerror = () => rej(new Error('Could not load the Rhino engine')); document.head.appendChild(s); });
      return (globalThis as any).rhino3dm({ locateFile: (f2: string) => libUrl(`rhino3dm/${f2}`) });
    }
    const name = 'rhino3dm'; // Node only (tests); the browser loads the copy in public/libs
    const mod: any = await import(/* @vite-ignore */ name);
    return (mod.default ?? mod)();
  })();
  return rhinoP;
}
const RHINO_UNIT: Record<string, string> = { mm: 'Millimeters', cm: 'Centimeters', m: 'Meters', in: 'Inches', ft: 'Feet', u: 'None' };
/** Rhino 3DM (version 7): one named mesh object per part, with its colour and the model unit. */
export async function write3DM(graph: THREE.Object3D, unit: string): Promise<Uint8Array> {
  const { meshes } = flatten(graph);
  requireMeshes(meshes, '3DM');
  const r = await rhino();
  const doc = new r.File3dm();
  doc.settings().modelUnitSystem = r.UnitSystem[RHINO_UNIT[unit] ?? 'Millimeters'];
  for (const m of meshes) {
    const mesh = new r.Mesh();
    for (let i = 0; i < m.pos.length; i += 3) mesh.vertices().add(m.pos[i], m.pos[i + 1], m.pos[i + 2]);
    for (let i = 0; i < m.idx.length; i += 3) mesh.faces().addTriFace(m.idx[i], m.idx[i + 1], m.idx[i + 2]);
    if (m.vcol) for (let i = 0; i < m.vcol.length; i += 3) mesh.vertexColors().add(Math.round(m.vcol[i] * 255), Math.round(m.vcol[i + 1] * 255), Math.round(m.vcol[i + 2] * 255));
    mesh.normals().computeNormals();
    mesh.compact();
    const attr = new r.ObjectAttributes();
    attr.name = m.name;
    attr.colorSource = r.ObjectColorSource.ColorFromObject;
    attr.objectColor = { r: Math.round(m.color.r * 255), g: Math.round(m.color.g * 255), b: Math.round(m.color.b * 255), a: 255 };
    doc.objects().add(mesh, attr);
  }
  return doc.toByteArray();
}

// ------------------------------------------------------------------ toolpaths, skeletons, molecules
/** G-code from lines / toolpaths (travel and move commands, no extrusion). Meshes need slicing, which a slicer does. */
export function writeGCODE(graph: THREE.Object3D, unit: string): string {
  const { lines } = flatten(graph);
  if (!lines.length) throw new Error('G-code is a machine toolpath. To print a mesh, convert it to 3MF or STL and slice it in a slicer such as PrusaSlicer, Bambu Studio or Cura.');
  const o = ['; OMNIVIEWER: lines written as G-code moves (no extrusion values)', unit === 'in' ? 'G20 ; inches' : 'G21 ; millimetres', 'G90 ; absolute'];
  let cur: number[] | null = null;
  const fx = (v: number) => v.toFixed(4).replace(/\.?0+$/, '');
  for (const l of lines) for (let i = 0; i + 5 < l.pos.length; i += 6) {
    const s = [l.pos[i], l.pos[i + 1], l.pos[i + 2]], t = [l.pos[i + 3], l.pos[i + 4], l.pos[i + 5]];
    if (!cur || Math.abs(cur[0] - s[0]) + Math.abs(cur[1] - s[1]) + Math.abs(cur[2] - s[2]) > 1e-6) o.push(`G0 X${fx(s[0])} Y${fx(s[1])} Z${fx(s[2])}`);
    o.push(`G1 X${fx(t[0])} Y${fx(t[1])} Z${fx(t[2])}`);
    cur = t;
  }
  return o.join('\n') + '\n';
}

/** BVH motion: the skeleton (bones) and its first animation, sampled at 30 frames per second. */
export function writeBVH(graph: THREE.Object3D, clips: THREE.AnimationClip[] = []): string {
  const roots: THREE.Bone[] = [];
  graph.traverse((o: any) => { if (o.isBone && !(o.parent as any)?.isBone) roots.push(o); });
  if (!roots.length) throw new Error('BVH stores a skeleton and its motion: this model has no skeleton (bones).');
  const root = roots[0];
  const joints: THREE.Bone[] = [];
  const out: string[] = ['HIERARCHY'];
  const fx = (v: number) => v.toFixed(6);
  const walk = (b: THREE.Bone, depth: number, isRoot: boolean) => {
    const ind = '  '.repeat(depth);
    joints.push(b);
    out.push(`${ind}${isRoot ? 'ROOT' : 'JOINT'} ${ident(b.name, `joint${joints.length}`)}`, `${ind}{`, `${ind}  OFFSET ${fx(b.position.x)} ${fx(b.position.y)} ${fx(b.position.z)}`,
      `${ind}  CHANNELS ${isRoot ? '6 Xposition Yposition Zposition' : '3'} Zrotation Xrotation Yrotation`);
    const kids = b.children.filter((c: any) => c.isBone) as THREE.Bone[];
    const leaf = (k: THREE.Bone) => !k.children.some((c: any) => c.isBone);
    // A single childless bone is BVH's "End Site" (importers turn End Sites into such bones): write it back as one.
    if (kids.length === 1 && leaf(kids[0])) out.push(`${ind}  End Site`, `${ind}  {`, `${ind}    OFFSET ${fx(kids[0].position.x)} ${fx(kids[0].position.y)} ${fx(kids[0].position.z)}`, `${ind}  }`);
    else if (kids.length) for (const k of kids) walk(k, depth + 1, false);
    else out.push(`${ind}  End Site`, `${ind}  {`, `${ind}    OFFSET 0 0 0`, `${ind}  }`);
    out.push(`${ind}}`);
  };
  walk(root, 0, true);
  const clip = clips[0];
  const mixer = new THREE.AnimationMixer(graph);
  if (clip) mixer.clipAction(clip).play();
  const fps = 30, frames = clip ? Math.max(1, Math.round(clip.duration * fps) + 1) : 1;
  out.push('MOTION', `Frames: ${frames}`, `Frame Time: ${(1 / fps).toFixed(6)}`);
  const e = new THREE.Euler();
  for (let fi = 0; fi < frames; fi++) {
    if (clip) mixer.setTime(fi / fps);
    const row: string[] = [];
    joints.forEach((j, i) => {
      if (i === 0) row.push(fx(j.position.x), fx(j.position.y), fx(j.position.z));
      e.setFromQuaternion(j.quaternion, 'ZXY');
      row.push(fx(THREE.MathUtils.radToDeg(e.z)), fx(THREE.MathUtils.radToDeg(e.x)), fx(THREE.MathUtils.radToDeg(e.y)));
    });
    out.push(row.join(' '));
  }
  mixer.stopAllAction();
  return out.join('\n') + '\n';
}

export interface PdbAtom { x: number; y: number; z: number; element: string; name?: string }
/** PDB: atoms (as opened from a PDB file) written back as HETATM records. */
export function writePDB(atoms: PdbAtom[] | undefined, title: string): string {
  if (!atoms?.length) throw new Error('PDB stores the atoms of a molecule: only molecules opened from a PDB file can be saved as PDB.');
  const r = (s: string | number, n: number) => String(s).padStart(n).slice(-n);
  const l = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const out = [`HEADER    ${l(asciiOnly(title).toUpperCase(), 40)}`, 'REMARK   1 WRITTEN BY OMNIVIEWER'];
  atoms.forEach((a, i) => {
    const el = (a.element || 'C').toUpperCase().slice(0, 2);
    out.push(`HETATM${r(i + 1, 5)} ${l(a.name || el, 4)} MOL A   1    ${r(a.x.toFixed(3), 8)}${r(a.y.toFixed(3), 8)}${r(a.z.toFixed(3), 8)}  1.00  0.00          ${r(el, 2)}`);
  });
  out.push('END');
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ Draco (.drc)
let dracoP: Promise<any> | null = null;
async function dracoEncoder(): Promise<any> {
  if (!dracoP) dracoP = (async () => {
    if (typeof document !== 'undefined') {
      const { libUrl } = await import('./loaders');
      if (!(globalThis as any).DracoEncoderModule) await new Promise<void>((res, rej) => { const s = document.createElement('script'); s.src = libUrl('draco/draco_encoder.js'); s.onload = () => res(); s.onerror = () => rej(new Error('Could not load the Draco encoder')); document.head.appendChild(s); });
      return (globalThis as any).DracoEncoderModule({ locateFile: (f2: string) => libUrl(`draco/${f2}`) });
    }
    const name = 'draco3d'; // Node only (tests); the browser loads the copy in public/libs
    const mod: any = await import(/* @vite-ignore */ name);
    return (mod.default ?? mod).createEncoderModule({});
  })();
  return dracoP;
}
/** Draco: everything merged into one compressed mesh (or point cloud), with vertex colours. 14-bit positions. */
export async function writeDRC(graph: THREE.Object3D): Promise<Uint8Array> {
  const { meshes, points } = flatten(graph);
  const D = await dracoEncoder();
  const encoder = new D.Encoder();
  const arr = new D.DracoInt8Array();
  let len = 0;
  const colorsOf = (pos: Float32Array, vcol: Float32Array | null, c: THREE.Color) => vcol ?? new Float32Array(pos.length).map((_, i) => [c.r, c.g, c.b][i % 3]);
  try {
    encoder.SetAttributeQuantization(D.POSITION, 14);
    encoder.SetAttributeQuantization(D.COLOR, 8);
    encoder.SetSpeedOptions(5, 5);
    if (meshes.length) {
      const nv = meshes.reduce((a, m) => a + m.pos.length / 3, 0), ni = meshes.reduce((a, m) => a + m.idx.length, 0);
      const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
      let vo = 0, io = 0;
      for (const m of meshes) { pos.set(m.pos, vo * 3); col.set(colorsOf(m.pos, m.vcol, m.color), vo * 3); for (let i = 0; i < m.idx.length; i++) idx[io + i] = m.idx[i] + vo; vo += m.pos.length / 3; io += m.idx.length; }
      const builder = new D.MeshBuilder(), mesh = new D.Mesh();
      builder.AddFacesToMesh(mesh, ni / 3, idx);
      builder.AddFloatAttributeToMesh(mesh, D.POSITION, nv, 3, pos);
      builder.AddFloatAttributeToMesh(mesh, D.COLOR, nv, 3, col);
      encoder.SetEncodingMethod(D.MESH_EDGEBREAKER_ENCODING);
      len = encoder.EncodeMeshToDracoBuffer(mesh, arr);
      D.destroy(mesh); D.destroy(builder);
    } else if (points.length) {
      const nv = points.reduce((a, p) => a + p.pos.length / 3, 0);
      const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      let vo = 0; for (const p of points) { pos.set(p.pos, vo); col.set(colorsOf(p.pos, p.vcol, new THREE.Color(0.8, 0.8, 0.8)), vo); vo += p.pos.length; }
      const builder = new D.PointCloudBuilder(), pc = new D.PointCloud();
      builder.AddFloatAttribute(pc, D.POSITION, nv, 3, pos);
      builder.AddFloatAttribute(pc, D.COLOR, nv, 3, col);
      len = encoder.EncodePointCloudToDracoBuffer(pc, false, arr);
      D.destroy(pc); D.destroy(builder);
    } else throw new Error('Draco stores a mesh or a point cloud: there is nothing to write.');
    if (!len) throw new Error('Draco could not encode this model.');
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = arr.GetValue(i);
    return out;
  } finally { D.destroy(arr); D.destroy(encoder); }
}

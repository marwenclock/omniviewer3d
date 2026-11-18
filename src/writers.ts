import * as THREE from 'three';

// Plain-text writers for the extra export formats. They take the export graph that `exportObject` has already
// scoped, cleaned and converted to the target units and axes, so they only serialise world-space triangles.

export interface FlatMesh { name: string; pos: Float32Array; idx: Uint32Array; color: THREE.Color; vcol: Float32Array | null }
export interface FlatLines { name: string; pos: Float32Array }
export interface FlatPoints { name: string; pos: Float32Array; vcol: Float32Array | null }

/** Flattens the graph into world-space meshes, line sets and point sets. */
export function flatten(graph: THREE.Object3D): { meshes: FlatMesh[]; lines: FlatLines[]; points: FlatPoints[] } {
  graph.updateMatrixWorld(true);
  const meshes: FlatMesh[] = [], lines: FlatLines[] = [], points: FlatPoints[] = [];
  const v = new THREE.Vector3();
  let n = 0;
  graph.traverse((o: any) => {
    if (!o.geometry?.attributes?.position) return;
    const g: THREE.BufferGeometry = o.geometry;
    const p = g.attributes.position as THREE.BufferAttribute;
    const instances = o.isInstancedMesh ? o.count : 1;
    for (let inst = 0; inst < instances; inst++) {
      const m = o.matrixWorld.clone();
      if (o.isInstancedMesh) { const im = new THREE.Matrix4(); o.getMatrixAt(inst, im); m.multiply(im); }
      const pos = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
      const c = g.attributes.color as THREE.BufferAttribute | undefined;
      const vcol = c ? new Float32Array(p.count * 3).map((_, i) => c.getComponent(Math.floor(i / 3), i % 3)) : null;
      const name = o.name || `part ${++n}`;
      if (o.isMesh) {
        const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array(p.count).map((_, i) => i);
        // Respect geometry groups / draw range only as a whole: every triangle is written.
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const flip = m.determinant() < 0; // mirrored parts: keep outward-facing winding
        if (flip) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        meshes.push({ name, pos, idx, color: mat?.color ? mat.color.clone() : new THREE.Color(0xb4b8bd), vcol });
      } else if (o.isLine) {
        const segs: number[] = [];
        const ids = g.index ? Array.from(g.index.array) : Array.from({ length: p.count }, (_, i) => i);
        const step = o.isLineSegments ? 2 : 1;
        for (let i = 0; i + 1 < ids.length; i += step) segs.push(...pos.subarray(ids[i] * 3, ids[i] * 3 + 3), ...pos.subarray(ids[i + 1] * 3, ids[i + 1] * 3 + 3));
        lines.push({ name, pos: new Float32Array(segs) });
      } else if (o.isPoints) points.push({ name, pos, vcol });
    }
  });
  return { meshes, lines, points };
}

const f = (x: number) => (Math.abs(x) < 1e-12 ? '0' : String(+x.toPrecision(9)));
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
const rgb = (c: THREE.Color) => `${f(c.r)} ${f(c.g)} ${f(c.b)}`;

/** OFF: one merged mesh (vertex colours as COFF when present). */
export function writeOFF(graph: THREE.Object3D): string {
  const { meshes } = flatten(graph);
  const colored = meshes.some((m) => m.vcol);
  const nv = meshes.reduce((a, m) => a + m.pos.length / 3, 0), nf = meshes.reduce((a, m) => a + m.idx.length / 3, 0);
  const out: string[] = [`${colored ? 'COFF' : 'OFF'}`, `${nv} ${nf} 0`];
  for (const m of meshes) for (let i = 0; i < m.pos.length; i += 3) {
    const c = m.vcol ? [m.vcol[i], m.vcol[i + 1], m.vcol[i + 2]] : [m.color.r, m.color.g, m.color.b];
    out.push(`${f(m.pos[i])} ${f(m.pos[i + 1])} ${f(m.pos[i + 2])}${colored ? ' ' + c.map((x) => Math.round(x * 255)).join(' ') + ' 255' : ''}`);
  }
  let base = 0;
  for (const m of meshes) { for (let i = 0; i < m.idx.length; i += 3) out.push(`3 ${m.idx[i] + base} ${m.idx[i + 1] + base} ${m.idx[i + 2] + base}`); base += m.pos.length / 3; }
  return out.join('\n') + '\n';
}

const INSUNITS: Record<string, number> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6, u: 0 };

/** DXF (R12-compatible ASCII): every triangle as a 3DFACE on a layer per part, lines as LINE. */
export function writeDXF(graph: THREE.Object3D, unit: string): string {
  const { meshes, lines } = flatten(graph);
  const o: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', String(INSUNITS[unit] ?? 0), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const layer = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 31) || '0';
  const pt = (code: number, p: Float32Array, i: number) => o.push(String(10 + code), f(p[i]), String(20 + code), f(p[i + 1]), String(30 + code), f(p[i + 2]));
  for (const m of meshes) {
    const L = layer(m.name);
    for (let i = 0; i < m.idx.length; i += 3) {
      o.push('0', '3DFACE', '8', L);
      pt(0, m.pos, m.idx[i] * 3); pt(1, m.pos, m.idx[i + 1] * 3); pt(2, m.pos, m.idx[i + 2] * 3); pt(3, m.pos, m.idx[i + 2] * 3);
    }
  }
  for (const l of lines) { const L = layer(l.name); for (let i = 0; i + 5 < l.pos.length; i += 6) { o.push('0', 'LINE', '8', L); pt(0, l.pos, i); pt(1, l.pos, i + 3); } }
  o.push('0', 'ENDSEC', '0', 'EOF');
  return o.join('\n') + '\n';
}

/** X3D (XML encoding, metres, Y-up): one Shape per part with its colour. */
export function writeX3D(graph: THREE.Object3D, title: string): string {
  const { meshes, lines, points } = flatten(graph);
  const coords = (p: Float32Array) => Array.from(p, f).join(' ');
  const shapes = meshes.map((m) => `    <Shape DEF="${xml(m.name.replace(/\s+/g, '_'))}">
      <Appearance><Material diffuseColor="${rgb(m.color)}"/></Appearance>
      <IndexedTriangleSet solid="false" index="${Array.from(m.idx).join(' ')}">
        <Coordinate point="${coords(m.pos)}"/>${m.vcol ? `\n        <Color color="${coords(m.vcol)}"/>` : ''}
      </IndexedTriangleSet>
    </Shape>`);
  for (const l of lines) shapes.push(`    <Shape><Appearance><Material emissiveColor="0.7 0.7 0.7"/></Appearance><LineSet vertexCount="${Array(l.pos.length / 6).fill(2).join(' ')}"><Coordinate point="${coords(l.pos)}"/></LineSet></Shape>`);
  for (const p of points) shapes.push(`    <Shape><PointSet><Coordinate point="${coords(p.pos)}"/>${p.vcol ? `<Color color="${coords(p.vcol)}"/>` : ''}</PointSet></Shape>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE X3D PUBLIC "ISO//Web3D//DTD X3D 3.3//EN" "http://www.web3d.org/specifications/x3d-3.3.dtd">
<X3D profile="Interchange" version="3.3">
  <head><meta name="title" content="${xml(title)}"/><meta name="generator" content="OMNIVIEWER"/></head>
  <Scene>
${shapes.join('\n')}
  </Scene>
</X3D>
`;
}

/** VRML 2.0 / 97 (metres, Y-up). */
export function writeVRML(graph: THREE.Object3D): string {
  const { meshes } = flatten(graph);
  const o = ['#VRML V2.0 utf8', '# Written by OMNIVIEWER', ''];
  for (const m of meshes) {
    const pts: string[] = []; for (let i = 0; i < m.pos.length; i += 3) pts.push(`${f(m.pos[i])} ${f(m.pos[i + 1])} ${f(m.pos[i + 2])}`);
    const faces: string[] = []; for (let i = 0; i < m.idx.length; i += 3) faces.push(`${m.idx[i]} ${m.idx[i + 1]} ${m.idx[i + 2]} -1`);
    const cols: string[] = []; if (m.vcol) for (let i = 0; i < m.vcol.length; i += 3) cols.push(`${f(m.vcol[i])} ${f(m.vcol[i + 1])} ${f(m.vcol[i + 2])}`);
    o.push(`DEF ${m.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'part'} Shape {`,
      `  appearance Appearance { material Material { diffuseColor ${rgb(m.color)} } }`,
      `  geometry IndexedFaceSet {`, '    solid FALSE',
      `    coord Coordinate { point [ ${pts.join(', ')} ] }`,
      ...(m.vcol ? [`    color Color { color [ ${cols.join(', ')} ] }`, '    colorPerVertex TRUE'] : []),
      `    coordIndex [ ${faces.join(', ')} ]`, '  }', '}', '');
  }
  return o.join('\n');
}

const AMF_UNIT: Record<string, string> = { mm: 'millimeter', m: 'meter', in: 'inch', ft: 'feet' };

/** AMF 1.1: one object per part with its colour, unit declared (centimetres are written as millimetres). */
export function writeAMF(graph: THREE.Object3D, unit: string): string {
  const { meshes } = flatten(graph);
  const k = unit === 'cm' ? 10 : 1;
  const u = AMF_UNIT[unit] ?? 'millimeter';
  const o = ['<?xml version="1.0" encoding="UTF-8"?>', `<amf unit="${u}" version="1.1">`, '  <metadata type="producer">OMNIVIEWER</metadata>'];
  meshes.forEach((m, id) => {
    o.push(`  <object id="${id}">`, `    <metadata type="name">${xml(m.name)}</metadata>`, `    <color><r>${f(m.color.r)}</r><g>${f(m.color.g)}</g><b>${f(m.color.b)}</b></color>`, '    <mesh>', '      <vertices>');
    for (let i = 0; i < m.pos.length; i += 3) o.push(`        <vertex><coordinates><x>${f(m.pos[i] * k)}</x><y>${f(m.pos[i + 1] * k)}</y><z>${f(m.pos[i + 2] * k)}</z></coordinates></vertex>`);
    o.push('      </vertices>', '      <volume>');
    for (let i = 0; i < m.idx.length; i += 3) o.push(`        <triangle><v1>${m.idx[i]}</v1><v2>${m.idx[i + 1]}</v2><v3>${m.idx[i + 2]}</v3></triangle>`);
    o.push('      </volume>', '    </mesh>', '  </object>');
  });
  o.push('</amf>');
  return o.join('\n') + '\n';
}

/** XYZ point list: point clouds as they are, meshes as their vertices. Colours as 0–255 when present. */
export function writeXYZ(graph: THREE.Object3D): string {
  const { meshes, points } = flatten(graph);
  const sets = [...points, ...meshes.map((m) => ({ pos: m.pos, vcol: m.vcol }))];
  const o: string[] = [];
  for (const s of sets) for (let i = 0; i < s.pos.length; i += 3) {
    o.push(`${f(s.pos[i])} ${f(s.pos[i + 1])} ${f(s.pos[i + 2])}${s.vcol ? ` ${Math.round(s.vcol[i] * 255)} ${Math.round(s.vcol[i + 1] * 255)} ${Math.round(s.vcol[i + 2] * 255)}` : ''}`);
  }
  return o.join('\n') + '\n';
}

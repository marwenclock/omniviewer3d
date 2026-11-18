import * as THREE from 'three';
import { unzipSync } from 'fflate';

// ---------------------------------------------------------------------------------------------
// Extra formats that three.js has no loader for (X3D, DXF, PTS, LAS), content sniffing for files
// with a missing or wrong extension, and honest help for proprietary formats that no browser can
// read (Fusion 360 .f3d, SolidWorks, SketchUp, Blender...).
// ---------------------------------------------------------------------------------------------

type DeclaredUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

const defaultMat = () => new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide });

function meshFrom(positions: number[], indices: number[] | null, name: string, colors?: number[] | null, color?: THREE.Color | null, opacity = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors && colors.length === positions.length) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (indices) g.setIndex(indices);
  g.computeVertexNormals();
  const m = defaultMat();
  if (g.attributes.color) { m.vertexColors = true; m.color.set(0xffffff); } else if (color) m.color.copy(color);
  if (opacity < 1) { m.transparent = true; m.opacity = opacity; }
  const mesh = new THREE.Mesh(g, m);
  mesh.name = name;
  return mesh;
}

/** Triangulates polygon index lists (-1 separated, as in X3D / VRML) with a fan. */
function fan(index: number[]): number[] {
  const out: number[] = [];
  let poly: number[] = [];
  const flush = () => { for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0], poly[i], poly[i + 1]); poly = []; };
  for (const i of index) { if (i < 0) flush(); else poly.push(i); }
  flush();
  return out;
}

const nums = (s: string | null | undefined) => (s || '').trim().split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));

// ------------------------------------------------------------------ X3D (XML encoding)
export function parseX3D(text: string, name: string): THREE.Object3D {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This X3D file is not valid XML. Only the XML encoding (.x3d) is supported; for the classic encoding use .wrl.');
  const scene = doc.getElementsByTagName('Scene')[0];
  if (!scene) throw new Error('No <Scene> found in this X3D file.');
  const defs = new Map<string, Element>();
  doc.querySelectorAll('[DEF]').forEach((e) => defs.set(e.getAttribute('DEF')!, e));
  const resolve = (e: Element) => (e.getAttribute('USE') ? defs.get(e.getAttribute('USE')!) || e : e);
  const root = new THREE.Group();
  root.name = name;
  let shapes = 0;

  const material = (shape: Element) => {
    const app = [...shape.children].map(resolve).find((c) => c.tagName === 'Appearance');
    const mat = app && [...app.children].map(resolve).find((c) => c.tagName === 'Material');
    const col = nums(mat?.getAttribute('diffuseColor'));
    const tr = Number(mat?.getAttribute('transparency') || 0);
    return { color: col.length === 3 ? new THREE.Color(col[0], col[1], col[2]) : null, opacity: 1 - tr };
  };

  const geometryOf = (geo: Element, label: string, m: { color: THREE.Color | null; opacity: number }): THREE.Object3D | null => {
    const tag = geo.tagName;
    const child = (t: string) => [...geo.children].map(resolve).find((c) => c.tagName === t);
    const coords = nums(child('Coordinate')?.getAttribute('point'));
    const colorNode = child('Color') || child('ColorRGBA');
    const colVals = nums(colorNode?.getAttribute('color'));
    const stride = colorNode?.tagName === 'ColorRGBA' ? 4 : 3;
    const perVertexColors = (count: number) => {
      if (!colVals.length || geo.getAttribute('colorPerVertex') === 'false') return null;
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(colVals[i * stride] ?? 1, colVals[i * stride + 1] ?? 1, colVals[i * stride + 2] ?? 1);
      return out;
    };
    switch (tag) {
      case 'IndexedFaceSet': {
        const idx = fan(nums(geo.getAttribute('coordIndex')).map(Math.trunc));
        return coords.length ? meshFrom(coords, idx, label, colorNode && !geo.getAttribute('colorIndex') ? perVertexColors(coords.length / 3) : null, m.color, m.opacity) : null;
      }
      case 'IndexedTriangleSet':
        return coords.length ? meshFrom(coords, nums(geo.getAttribute('index')).map(Math.trunc), label, perVertexColors(coords.length / 3), m.color, m.opacity) : null;
      case 'TriangleSet':
        return coords.length ? meshFrom(coords, null, label, perVertexColors(coords.length / 3), m.color, m.opacity) : null;
      case 'IndexedLineSet': {
        const idx = nums(geo.getAttribute('coordIndex')).map(Math.trunc);
        const seg: number[] = [];
        let prev = -1;
        for (const i of idx) { if (i >= 0 && prev >= 0) seg.push(...coords.slice(prev * 3, prev * 3 + 3), ...coords.slice(i * 3, i * 3 + 3)); prev = i; }
        if (!seg.length) return null;
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: m.color ?? 0xb4b8bd })); l.name = label; return l;
      }
      case 'PointSet': {
        if (!coords.length) return null;
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
        const c = perVertexColors(coords.length / 3); if (c) g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
        const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.01, vertexColors: !!c, color: c ? 0xffffff : 0xb4b8bd })); p.name = label; return p;
      }
      case 'Box': { const s = nums(geo.getAttribute('size')); const [x, y, z] = s.length === 3 ? s : [2, 2, 2]; return wrap(new THREE.BoxGeometry(x, y, z)); }
      case 'Sphere': return wrap(new THREE.SphereGeometry(Number(geo.getAttribute('radius') || 1), 32, 16));
      case 'Cylinder': return wrap(new THREE.CylinderGeometry(Number(geo.getAttribute('radius') || 1), Number(geo.getAttribute('radius') || 1), Number(geo.getAttribute('height') || 2), 32));
      case 'Cone': return wrap(new THREE.CylinderGeometry(0, Number(geo.getAttribute('bottomRadius') || 1), Number(geo.getAttribute('height') || 2), 32));
    }
    return null;
    function wrap(g: THREE.BufferGeometry) {
      const mat = defaultMat(); if (m.color) mat.color.copy(m.color);
      if (m.opacity < 1) { mat.transparent = true; mat.opacity = m.opacity; }
      const mesh = new THREE.Mesh(g, mat); mesh.name = label; return mesh;
    }
  };

  const walk = (el: Element, parent: THREE.Object3D, depth: number) => {
    if (depth > 64) return;
    for (const raw of [...el.children]) {
      const c = resolve(raw);
      const tag = c.tagName;
      if (tag === 'Transform' || tag === 'Group' || tag === 'Collision' || tag === 'Anchor' || tag === 'StaticGroup' || tag === 'Switch' || tag === 'LOD' || tag === 'Billboard') {
        const g = new THREE.Group();
        g.name = c.getAttribute('DEF') || '';
        if (tag === 'Transform') {
          const t = nums(c.getAttribute('translation')); if (t.length === 3) g.position.set(t[0], t[1], t[2]);
          const r = nums(c.getAttribute('rotation')); if (r.length === 4 && r[3]) g.quaternion.setFromAxisAngle(new THREE.Vector3(r[0], r[1], r[2]).normalize(), r[3]);
          const s = nums(c.getAttribute('scale')); if (s.length === 3) g.scale.set(s[0], s[1], s[2]);
        }
        parent.add(g);
        if (tag === 'Switch' || tag === 'LOD') { const first = [...c.children][Number(c.getAttribute('whichChoice') ?? 0)] || c.children[0]; if (first) { const holder = document.createElement('x'); holder.appendChild(first.cloneNode(true)); walk(holder, g, depth + 1); } }
        else walk(c, g, depth + 1);
      } else if (tag === 'Shape') {
        const m = material(c);
        for (const gc of [...c.children].map(resolve)) {
          if (gc.tagName === 'Appearance') continue;
          const obj = geometryOf(gc, c.getAttribute('DEF') || `Shape ${++shapes}`, m);
          if (obj) parent.add(obj);
        }
      } else if (tag === 'Inline') {
        // Inline references other files; they are not fetched (local-first).
      } else walk(c, parent, depth + 1);
    }
  };
  walk(scene, root, 0);
  let n = 0; root.traverse((o: any) => { if (o.isMesh || o.isLine || o.isPoints) n++; });
  if (!n) throw new Error('No supported geometry (IndexedFaceSet, IndexedTriangleSet, Box, Sphere…) was found in this X3D file.');
  return root;
}

// ------------------------------------------------------------------ DXF (3D faces, polyface meshes, lines)
const DXF_UNITS: Record<number, DeclaredUnit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };

export function parseDXF(text: string, name: string): { object: THREE.Object3D; unit?: DeclaredUnit } {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
  let unit: DeclaredUnit | undefined;
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') { unit = DXF_UNITS[Number(pairs[i + 1]?.[1])]; break; }
  const start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[i - 1]?.[1] === 'SECTION');
  if (start < 0) throw new Error('This DXF has no ENTITIES section.');
  // Split into entities: each begins with group code 0.
  const ents: { type: string; g: [number, string][] }[] = [];
  for (let i = start + 1; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0) { if (v === 'ENDSEC') break; ents.push({ type: v, g: [] }); } else ents[ents.length - 1]?.g.push([c, v]);
  }
  const num = (g: [number, string][], c: number, d = 0) => { const p = g.find((x) => x[0] === c); return p ? Number(p[1]) : d; };
  const tri: number[] = [];
  const seg: number[] = [];
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.type === '3DFACE') {
      const v = [0, 1, 2, 3].map((k) => [num(e.g, 10 + k), num(e.g, 20 + k), num(e.g, 30 + k)]);
      tri.push(...v[0], ...v[1], ...v[2]);
      if (v[3].some((x, k) => x !== v[2][k])) tri.push(...v[0], ...v[2], ...v[3]);
    } else if (e.type === 'LINE') {
      seg.push(num(e.g, 10), num(e.g, 20), num(e.g, 30), num(e.g, 11), num(e.g, 21), num(e.g, 31));
    } else if (e.type === 'LWPOLYLINE') {
      const z = num(e.g, 38); const xs = e.g.filter((p) => p[0] === 10).map((p) => Number(p[1])); const ys = e.g.filter((p) => p[0] === 20).map((p) => Number(p[1]));
      const closed = (num(e.g, 70) & 1) === 1;
      for (let k = 0; k + 1 < xs.length; k++) seg.push(xs[k], ys[k], z, xs[k + 1], ys[k + 1], z);
      if (closed && xs.length > 2) seg.push(xs[xs.length - 1], ys[ys.length - 1], z, xs[0], ys[0], z);
    } else if (e.type === 'POLYLINE') {
      const flags = num(e.g, 70);
      const verts: number[][] = [], faces: number[][] = [];
      let j = i + 1;
      for (; j < ents.length && ents[j].type === 'VERTEX'; j++) {
        const vf = num(ents[j].g, 70);
        if (flags & 64) {
          if (vf & 64) verts.push([num(ents[j].g, 10), num(ents[j].g, 20), num(ents[j].g, 30)]);
          else if (vf & 128) faces.push([71, 72, 73, 74].map((c) => Math.abs(num(ents[j].g, c))).filter(Boolean));
        } else verts.push([num(ents[j].g, 10), num(ents[j].g, 20), num(ents[j].g, 30)]);
      }
      if (flags & 64) {
        for (const f of faces) { const p = f.map((k) => verts[k - 1]).filter(Boolean); for (let k = 1; k + 1 < p.length; k++) tri.push(...p[0], ...p[k], ...p[k + 1]); }
      } else {
        for (let k = 0; k + 1 < verts.length; k++) seg.push(...verts[k], ...verts[k + 1]);
        if (flags & 1 && verts.length > 2) seg.push(...verts[verts.length - 1], ...verts[0]);
      }
      i = j;
    }
  }
  const root = new THREE.Group(); root.name = name;
  if (tri.length) root.add(meshFrom(tri, null, '3D faces'));
  if (seg.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb4b8bd })); l.name = 'Lines'; root.add(l);
  }
  if (!root.children.length) throw new Error('No 3D faces, polyface meshes or lines were found. 2D-only drawings, blocks (INSERT), solids (3DSOLID) and MESH entities are not supported: export the model as STL, OBJ or STEP from your CAD program.');
  return { object: root.children.length === 1 ? root.children[0] : root, unit };
}

// ------------------------------------------------------------------ point clouds: PTS and LAS
const MAX_POINTS = 6_000_000;

function cloud(pos: Float32Array, col: Float32Array | null, name: string): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: (g.boundingSphere?.radius || 1) / 400, vertexColors: !!col, color: col ? 0xffffff : 0xb4b8bd }));
  pts.name = name;
  return pts;
}

export function parsePTS(text: string, name: string): THREE.Points {
  const rows = text.split(/\r?\n/);
  let i = 0;
  if (/^\s*\d+\s*$/.test(rows[0] || '')) i = 1;
  const pos: number[] = [], col: number[] = [];
  let hasCol = true;
  for (; i < rows.length && pos.length / 3 < MAX_POINTS; i++) {
    const v = rows[i].trim().split(/[\s,]+/).map(Number);
    if (v.length < 3 || v.slice(0, 3).some(Number.isNaN)) continue;
    pos.push(v[0], v[1], v[2]);
    if (v.length >= 7) col.push(v[4] / 255, v[5] / 255, v[6] / 255); else if (v.length === 6) col.push(v[3] / 255, v[4] / 255, v[5] / 255); else hasCol = false;
  }
  if (!pos.length) throw new Error('No points were found in this file.');
  return cloud(new Float32Array(pos), hasCol && col.length === pos.length ? new Float32Array(col) : null, name);
}

/** LAS 1.0–1.4 (uncompressed). LAZ needs a decompressor that is not bundled. */
export function parseLAS(buf: ArrayBuffer, name: string): { object: THREE.Points; warnings: string[] } {
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'LASF') throw new Error('Not a LAS file.');
  const minor = dv.getUint8(25);
  const offset = dv.getUint32(96, true);
  const fmtByte = dv.getUint8(104);
  if (fmtByte & 0x80 || fmtByte & 0x40) throw new Error('This is a compressed LAZ point cloud. Decompress it to LAS first (for example with LAStools or CloudCompare), then open the .las file.');
  const fmt = fmtByte & 0x3f;
  const rec = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (minor >= 4 && buf.byteLength > 255) { const big = Number(dv.getBigUint64(247, true)); if (big) count = big; }
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const rgbAt: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
  const rgb = rgbAt[fmt];
  count = Math.min(count, Math.floor((buf.byteLength - offset) / rec));
  const step = Math.max(1, Math.ceil(count / MAX_POINTS));
  const n = Math.ceil(count / step);
  const pos = new Float32Array(n * 3);
  const col = rgb !== undefined ? new Float32Array(n * 3) : null;
  // Recentre georeferenced coordinates around the first point so float precision is kept.
  const cx = dv.getInt32(offset, true) * sx + ox, cy = dv.getInt32(offset + 4, true) * sy + oy, cz = dv.getInt32(offset + 8, true) * sz + oz;
  let maxC = 0;
  for (let i = 0, k = 0; i < count; i += step, k++) {
    const p = offset + i * rec;
    pos[k * 3] = dv.getInt32(p, true) * sx + ox - cx;
    pos[k * 3 + 1] = dv.getInt32(p + 4, true) * sy + oy - cy;
    pos[k * 3 + 2] = dv.getInt32(p + 8, true) * sz + oz - cz;
    if (col) for (let c = 0; c < 3; c++) { const v = dv.getUint16(p + rgb! + c * 2, true); col[k * 3 + c] = v; if (v > maxC) maxC = v; }
  }
  if (col) { const div = maxC > 255 ? 65535 : 255; for (let i = 0; i < col.length; i++) col[i] /= div; }
  const warnings: string[] = [];
  if (step > 1) warnings.push(`Showing every ${step}th point (${n.toLocaleString()} of ${count.toLocaleString()}) to fit in memory.`);
  const pts = cloud(pos, col && maxC > 0 ? col : null, name);
  pts.userData.geoOffset = [cx, cy, cz];
  return { object: pts, warnings };
}

// ------------------------------------------------------------------ content sniffing
/**
 * Guesses the real format from the first bytes, for files with no extension, a wrong one (.bin, .dat, .txt, .3d)
 * or a renamed download. Returns an extension the loader knows, or null.
 */
export async function sniffFormat(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const txt = new TextDecoder('latin1').decode(head);
  const t = txt.trimStart();
  if (txt.startsWith('glTF')) return 'glb';
  if (txt.startsWith('LASF')) return 'las';
  if (txt.startsWith('DRACO')) return 'drc';
  if (txt.startsWith('Kaydara FBX Binary') || t.startsWith('; FBX')) return 'fbx';
  if (txt.startsWith('ply')) return 'ply';
  if (txt.startsWith('ISO-10303-21')) return /FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(txt) ? 'ifc' : 'step';
  if (txt.startsWith('3D Geometry File Format')) return '3dm';
  if (t.startsWith('#VRML')) return 'wrl';
  if (/^(<\?xml[^>]*>\s*)?(<!DOCTYPE X3D[^>]*>\s*)?<X3D/i.test(t)) return 'x3d';
  if (/^(<\?xml[^>]*>\s*)?<amf/i.test(t)) return 'amf';
  if (/^(<\?xml[^>]*>\s*)?<COLLADA/i.test(t)) return 'dae';
  if (/^(C|N|ST)?OFF\b/.test(t)) return 'off';
  if (txt.startsWith('VOX ')) return 'vox';
  if (txt.startsWith('IDP2')) return 'md2';
  if (txt.startsWith('# vtk DataFile') || /^<\?xml[^>]*>\s*<VTKFile/.test(t)) return 'vtk';
  if (/^#\s*\.PCD|^VERSION \.?\d/m.test(t.slice(0, 200)) && /FIELDS/.test(txt)) return 'pcd';
  if (txt.startsWith('PK')) return sniffZip(file);
  if (head[0] === 0x4d && head[1] === 0x4d && head.length >= 6 && new DataView(head.buffer).getUint32(2, true) === file.size) return '3ds';
  if (/^0\s*\r?\n\s*SECTION/.test(t)) return 'dxf';
  if (/^(HEADER|ATOM|HETATM|COMPND|REMARK)\s/m.test(t.slice(0, 200)) && /^(ATOM|HETATM)/m.test(txt)) return 'pdb';
  if (t.startsWith('HIERARCHY')) return 'bvh';
  if (/^solid\b/.test(t) && /facet\s+normal/.test(txt)) return 'stl';
  if (/^(;|G0|G1|M\d)/m.test(t) && /\bG[01]\s+[XYZEF]/.test(txt)) return 'gcode';
  if (/^\s*(v|vn|vt|f|o|g|mtllib|usemtl)\s/m.test(txt) && /^v\s+-?[\d.]/m.test(txt)) return 'obj';
  // Binary STL: 80-byte header + count, size must match exactly.
  if (file.size >= 84) {
    const c = new DataView(await file.slice(80, 84).arrayBuffer()).getUint32(0, true);
    if (84 + c * 50 === file.size) return 'stl';
  }
  if (/^-?[\d.]+[\s,]+-?[\d.]+[\s,]+-?[\d.]+/m.test(t)) return 'xyz';
  return null;
}

async function sniffZip(file: File): Promise<string | null> {
  try {
    const names: string[] = [];
    unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => { names.push(f.name); return false; } });
    if (names.some((n) => /3D\/.*\.model$/i.test(n))) return '3mf';
    if (names.some((n) => /\.usd[ac]?$/i.test(n)) && !names.some((n) => /\.(glb|gltf|obj|fbx|stl)$/i.test(n))) return 'usdz';
    if (names.some((n) => /^doc\.kml$/i.test(n))) return 'kmz';
    if (names.some((n) => /^project\.json$/i.test(n)) && names.some((n) => /^scene\.glb$/i.test(n))) return 'omniproj';
    if (names.some((n) => /FusionAssetName|\.smt$|\.smb$/i.test(n))) return 'f3d';
    return 'zip';
  } catch { return null; }
}

// ------------------------------------------------------------------ proprietary formats
export interface ProprietaryInfo {
  ext: string;
  app: string;
  vendor: string;
  kind: 'cad' | 'dcc' | 'bim' | 'drawing' | 'sculpt';
  /** best formats to export from the original program, in order */
  exportAs: string[];
  /** the menu path in the original program */
  how: string;
  /** a free official route, when one exists */
  freeRoute?: string;
}

const P = (ext: string[], app: string, vendor: string, kind: ProprietaryInfo['kind'], exportAs: string[], how: string, freeRoute?: string) =>
  ext.map((e) => [e, { ext: e, app, vendor, kind, exportAs, how, freeRoute }] as const);

/** Formats that only their own (closed) program can read. We explain how to get a file OMNIVIEWER opens. */
export const PROPRIETARY: Record<string, ProprietaryInfo> = Object.fromEntries([
  ...P(['f3d', 'f3z'], 'Fusion 360', 'Autodesk', 'cad', ['STEP', '3MF', 'STL'], 'File → Export… → choose STEP (*.step) for exact CAD, or 3MF / STL for printing. In the browser version: open the design in the Fusion web client → File → Export.', 'Upload to Autodesk Fusion (free personal plan) or open it in the Fusion web client, then export STEP.'),
  ...P(['sldprt', 'sldasm', 'slddrw'], 'SolidWorks', 'Dassault Systèmes', 'cad', ['STEP', 'STL', '3MF'], 'File → Save As… → Save as type: STEP AP214 (*.step) or STL (*.stl).', 'eDrawings Viewer (free) can open the file and save it as STL or eDrawings.'),
  ...P(['ipt', 'iam', 'idw'], 'Inventor', 'Autodesk', 'cad', ['STEP', 'STL', 'OBJ'], 'File → Export → CAD Format… → STEP (*.stp), or File → Export → 3D Print.', 'Autodesk Viewer (viewer.autodesk.com) opens it after an upload to Autodesk.'),
  ...P(['catpart', 'catproduct', 'cgr'], 'CATIA', 'Dassault Systèmes', 'cad', ['STEP', 'STL'], 'File → Save As… → Save as type: stp.'),
  ...P(['prt', 'asm', 'neu'], 'Creo / NX / Solid Edge', 'PTC / Siemens', 'cad', ['STEP', 'STL'], 'File → Save a Copy (Creo) or File → Export (NX / Solid Edge) → STEP.', 'Creo View Express or Solid Edge Viewer can open and print them.'),
  ...P(['par', 'psm'], 'Solid Edge', 'Siemens', 'cad', ['STEP', 'STL'], 'Application menu → Save As → STEP Documents (*.stp).'),
  ...P(['x_t', 'x_b', 'xmt_txt'], 'Parasolid', 'Siemens', 'cad', ['STEP'], 'Open it in any Parasolid-based CAD (SolidWorks, Solid Edge, NX, Onshape) and export STEP.', 'Onshape (free plan) imports Parasolid and exports STEP or STL.'),
  ...P(['sat', 'sab', 'smt'], 'ACIS / ShapeManager', 'Spatial / Autodesk', 'cad', ['STEP'], 'Open it in the CAD program that wrote it (Fusion 360, Inventor, AutoCAD) and export STEP.'),
  ...P(['jt'], 'JT', 'Siemens', 'cad', ['STEP', 'STL'], 'Export STEP from the CAD program that wrote it, or use Siemens JT2Go (free) to view it.', 'JT2Go is a free JT viewer.'),
  ...P(['3dxml'], '3DXML', 'Dassault Systèmes', 'cad', ['STEP', 'STL'], 'In CATIA or SolidWorks: File → Save As → STEP.', '3D XML Player (free) can view it.'),
  ...P(['skp'], 'SketchUp', 'Trimble', 'dcc', ['glTF / GLB', 'OBJ', 'STL'], 'File → Export → 3D Model… → choose OBJ, STL or COLLADA (.dae). SketchUp for Web: Download → STL or (with an extension) glTF.', 'SketchUp for Web (free) opens .skp files and exports STL.'),
  ...P(['blend'], 'Blender', 'Blender Foundation', 'dcc', ['glTF / GLB', 'FBX', 'OBJ'], 'File → Export → glTF 2.0 (.glb) keeps materials, textures and animation. Blender is free.', 'Blender is free and open source: blender.org.'),
  ...P(['max'], '3ds Max', 'Autodesk', 'dcc', ['FBX', 'OBJ', 'glTF / GLB'], 'File → Export → Export… → FBX (*.fbx) or glTF (*.glb, 2023+).'),
  ...P(['ma', 'mb'], 'Maya', 'Autodesk', 'dcc', ['FBX', 'OBJ', 'USD'], 'File → Export All… → FBX export, OBJexport or USD Export.'),
  ...P(['c4d'], 'Cinema 4D', 'Maxon', 'dcc', ['FBX', 'glTF / GLB', 'OBJ'], 'File → Export → FBX (*.fbx) or glTF (*.gltf).'),
  ...P(['hip', 'hiplc', 'hipnc'], 'Houdini', 'SideFX', 'dcc', ['USD', 'FBX', 'OBJ'], 'Use a ROP (USD, FBX or Geometry) to write a .usd, .fbx or .obj file.'),
  ...P(['ztl', 'zpr'], 'ZBrush', 'Maxon', 'sculpt', ['OBJ', 'STL', 'FBX'], 'Tool → Export (OBJ), or Zplugin → 3D Print Hub → Export to STL.'),
  ...P(['spp'], 'Substance Painter', 'Adobe', 'dcc', ['glTF / GLB', 'FBX'], 'Export the textures, then export the mesh from your modelling program as glTF or FBX.'),
  ...P(['dwg'], 'AutoCAD (DWG)', 'Autodesk', 'drawing', ['STL', 'STEP', 'DXF (3D faces)'], 'For 3D solids: EXPORT → STL, or STEPOUT. For 3D faces: SAVEAS → DXF, then open the DXF here.', 'Autodesk DWG TrueView (free) converts DWG to DXF.'),
  ...P(['dgn'], 'MicroStation', 'Bentley', 'drawing', ['IFC', 'STEP', 'OBJ'], 'File → Export → IFC, STEP or OBJ.', 'Bentley View (free) opens DGN files.'),
  ...P(['rvt', 'rfa', 'rte'], 'Revit', 'Autodesk', 'bim', ['IFC'], 'File → Export → IFC. The IFC keeps storeys, element types and properties, and opens here.'),
  ...P(['pln', 'pla', 'gsm'], 'Archicad', 'Graphisoft', 'bim', ['IFC'], 'File → Save As… → IFC (*.ifc).', 'BIMx (free) can view Archicad models.'),
  ...P(['nwd', 'nwc', 'nwf'], 'Navisworks', 'Autodesk', 'bim', ['FBX', 'IFC (from the source model)'], 'Output → Export Scene → FBX. For IFC, export from the original Revit / Civil 3D model.', 'Navisworks Freedom (free) views .nwd files.'),
  ...P(['e57'], 'E57 point cloud', 'ASTM', 'cad', ['LAS', 'PLY', 'PTS'], 'Convert it with CloudCompare (free): File → Save as → LAS, PLY or PTS.', 'CloudCompare (free) converts E57 to LAS or PLY.'),
  ...P(['laz'], 'LAZ (compressed LAS)', 'rapidlasso', 'cad', ['LAS'], 'Decompress with LAStools (laszip -i in.laz -o out.las) or CloudCompare, then open the .las file.', 'CloudCompare (free) saves LAZ as LAS.'),
  ...P(['rcp', 'rcs'], 'ReCap point cloud', 'Autodesk', 'cad', ['E57 → LAS', 'PTS'], 'In ReCap: Export → E57 or PTS. Open .pts here directly, or convert E57 to LAS.'),
  ...P(['x', 'ase', 'ms3d', 'mdl', 'b3d', 'cob', 'lws', 'smd'], 'Legacy game / DCC format', 'various', 'dcc', ['FBX', 'OBJ', 'glTF / GLB'], 'Open it in Blender (with the matching add-on) or Autodesk FBX Converter, then export glTF or OBJ.', 'Blender (free) imports many legacy formats through add-ons.'),
]);

/** Pulls a preview picture out of a proprietary file when it carries one (zip entries, or embedded PNG / JPEG). */
export async function extractPreview(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024 * 1024).arrayBuffer());
  const blobUrl = (b: Uint8Array, type: string) => URL.createObjectURL(new Blob([b as BlobPart], { type }));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      let best: { name: string; size: number } | null = null;
      const all = unzipSync(bytes, {
        filter: (f) => {
          const isImg = /\.(png|jpe?g)$/i.test(f.name) && f.originalSize < 8 * 1024 * 1024;
          if (isImg && (!best || f.originalSize > best.size)) best = { name: f.name, size: f.originalSize };
          return isImg || /\.f3d$/i.test(f.name);
        },
      });
      if (best) return blobUrl(all[(best as { name: string }).name], /\.png$/i.test((best as { name: string }).name) ? 'image/png' : 'image/jpeg');
      const inner = Object.entries(all).find(([n]) => /\.f3d$/i.test(n)); // .f3z archives hold .f3d designs
      if (inner) return extractPreview(new File([inner[1] as BlobPart], inner[0]));
    } catch { /* not a readable zip */ }
  }
  // Embedded PNG: 89 50 4E 47 ... IEND AE 42 60 82. Take the largest one (usually the thumbnail, not an icon).
  let found: Uint8Array | null = null;
  for (let i = 0; i < bytes.length - 8; i++) {
    if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) {
      for (let j = i + 8; j < Math.min(bytes.length - 8, i + 8 * 1024 * 1024); j++) {
        if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4e && bytes[j + 3] === 0x44) {
          const png = bytes.subarray(i, j + 8);
          if (png.length > 1500 && (!found || png.length > found.length)) found = png;
          i = j; break;
        }
      }
    }
  }
  if (found) return blobUrl(found, 'image/png');
  // Embedded JPEG: FF D8 FF ... FF D9.
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      for (let j = i + 3; j < Math.min(bytes.length - 1, i + 8 * 1024 * 1024); j++) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) { if (j - i > 4000) return blobUrl(bytes.subarray(i, j + 2), 'image/jpeg'); break; }
      }
    }
  }
  return null;
}

export class ProprietaryFormatError extends Error {
  constructor(public info: ProprietaryInfo, public file: File) {
    super(`${info.app} files (.${info.ext}) can only be read by ${info.app}. Export them as ${info.exportAs[0]} to open them here.`);
    this.name = 'ProprietaryFormatError';
  }
}

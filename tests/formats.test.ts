import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { exportObject, describeExport } from '../src/exporters';
import { parseDXF, parsePTS, parseLAS, sniffFormat, PROPRIETARY } from '../src/formats-extra';

function box(w = 20, d = 30, h = 40, name = 'box') {
  const g = new THREE.BoxGeometry(w, d, h).translate(w / 2, d / 2, h / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xff0000 }));
  m.name = name;
  return m;
}
const bbox = (o: THREE.Object3D) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()); };
const near = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

test('DXF export → DXF import keeps size, triangles and the declared unit', async () => {
  const text = await (await exportObject(box(), 'dxf', { unit: 'mm', up: 'z' })).text();
  assert.match(text, /\$INSUNITS\n70\n4\n/);
  const r = parseDXF(text, 'box.dxf');
  assert.equal(r.unit, 'mm');
  const s = bbox(r.object);
  near(s.x, 20); near(s.y, 30); near(s.z, 40);
  const mesh = r.object as THREE.Mesh;
  assert.equal(mesh.geometry.attributes.position.count / 3, 12);
});

test('DXF export of a Y-up metre model stands it Z-up in millimetres', async () => {
  const r = parseDXF(await (await exportObject(box(2, 4, 1), 'dxf', { unit: 'm', up: 'y', zUp: true, outUnit: 'mm' })).text(), 'b');
  const s = bbox(r.object);
  near(s.x, 2000); near(s.y, 1000); near(s.z, 4000);
});

test('OFF export writes one merged mesh with matching counts', async () => {
  const g = new THREE.Group(); g.add(box(1, 1, 1, 'a')); const b = box(1, 1, 1, 'b'); b.position.x = 5; g.add(b);
  const lines = (await (await exportObject(g, 'off', { unit: 'mm', up: 'z' })).text()).trim().split('\n');
  assert.equal(lines[0], 'OFF');
  assert.equal(lines[1], '48 24 0');
  assert.equal(lines.length, 2 + 48 + 24);
});

test('AMF declares its unit; centimetres are written as millimetres', async () => {
  const text = await (await exportObject(box(2, 3, 4), 'amf', { unit: 'cm', up: 'z' })).text();
  assert.match(text, /<amf unit="millimeter"/);
  const xs = [...text.matchAll(/<x>([-\d.e]+)<\/x>/g)].map((m) => Number(m[1]));
  near(Math.max(...xs) - Math.min(...xs), 20);
  assert.match(text, /<color><r>1<\/r><g>0<\/g><b>0<\/b><\/color>/);
});

test('X3D and VRML are written in metres with the part colour', async () => {
  const x3d = await (await exportObject(box(), 'x3d', { unit: 'mm', up: 'z' })).text();
  assert.match(x3d, /<X3D profile="Interchange"/);
  assert.match(x3d, /diffuseColor="1 0 0"/);
  const pts = x3d.match(/point="([^"]+)"/)![1].split(' ').map(Number);
  near(Math.max(...pts), 0.04);
  const wrl = await (await exportObject(box(), 'wrl', { unit: 'mm', up: 'z' })).text();
  assert.ok(wrl.startsWith('#VRML V2.0 utf8'));
  assert.match(wrl, /diffuseColor 1 0 0/);
});

test('XYZ writes points; describeExport says surfaces are lost for meshes', async () => {
  const text = await (await exportObject(box(), 'xyz', { unit: 'mm', up: 'z' })).text();
  assert.equal(text.trim().split('\n').length, 24);
  const rep = describeExport(box(), 'xyz', { unit: 'mm', up: 'z' });
  assert.ok(rep.lost.some((l) => l.startsWith('surfaces')));
});

test('PTS and LAS point clouds parse (LAS recentred, colours scaled)', () => {
  const pts = parsePTS('3\n0 0 0 10 255 0 0\n1 0 0 10 0 255 0\n0 2 0 10 0 0 255\n', 'a.pts');
  assert.equal(pts.geometry.attributes.position.count, 3);
  assert.ok(pts.geometry.attributes.color);
  // Minimal LAS 1.2, point format 2 (RGB), 2 points.
  const rec = 26, off = 227, buf = new ArrayBuffer(off + rec * 2), dv = new DataView(buf);
  'LASF'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint8(24, 1); dv.setUint8(25, 2); dv.setUint16(94, 227, true); dv.setUint32(96, off, true);
  dv.setUint8(104, 2); dv.setUint16(105, rec, true); dv.setUint32(107, 2, true);
  for (const o of [131, 139, 147]) dv.setFloat64(o, 0.01, true);
  for (const o of [155, 163, 171]) dv.setFloat64(o, 1000, true);
  dv.setInt32(off, 0, true); dv.setInt32(off + rec, 150, true); dv.setInt32(off + rec + 4, 250, true);
  dv.setUint16(off + 20, 65535, true);
  const r = parseLAS(buf, 'a.las');
  const p = r.object.geometry.attributes.position;
  near(p.getX(1), 1.5); near(p.getY(1), 2.5);
  near(r.object.geometry.attributes.color.getX(0), 1);
  assert.deepEqual(r.object.userData.geoOffset, [1000, 1000, 1000]);
});

test('LAZ is refused with an explanation', () => {
  const buf = new ArrayBuffer(400), dv = new DataView(buf);
  'LASF'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint8(104, 0x83);
  assert.throws(() => parseLAS(buf, 'x.laz'), /compressed LAZ/);
});

test('Format sniffing: binary STL, GLB, ASCII STL, OBJ, STEP vs IFC, DXF', async () => {
  const stl = await exportObject(box(), 'stl', { unit: 'mm', up: 'z' });
  assert.equal(await sniffFormat(new File([stl], 'download')), 'stl');
  const glb = await exportObject(box(), 'glb', { unit: 'mm', up: 'z' });
  assert.equal(await sniffFormat(new File([glb], 'model.bin')), 'glb');
  assert.equal(await sniffFormat(new File(['solid x\nfacet normal 0 0 1\n'], 'a')), 'stl');
  assert.equal(await sniffFormat(new File(['# made by x\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'a.txt')), 'obj');
  assert.equal(await sniffFormat(new File(["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));"], 'a')), 'step');
  assert.equal(await sniffFormat(new File(["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));"], 'a')), 'ifc');
  assert.equal(await sniffFormat(new File(['0\nSECTION\n2\nHEADER\n'], 'a')), 'dxf');
  assert.equal(await sniffFormat(new File(['hello world, not a model'], 'a')), null);
});

test('Closed formats have an export route', () => {
  for (const ext of ['f3d', 'f3z', 'sldprt', 'skp', 'blend', 'dwg', 'rvt', 'ipt', 'catpart', 'max', 'c4d']) {
    assert.ok(PROPRIETARY[ext], ext);
    assert.ok(PROPRIETARY[ext].exportAs.length > 0 && PROPRIETARY[ext].how.length > 10, ext);
  }
});

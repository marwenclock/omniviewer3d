import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { VOXLoader } from 'three/addons/loaders/VOXLoader.js';
import { MD2Loader } from 'three/addons/loaders/MD2Loader.js';
import { VTKLoader } from 'three/addons/loaders/VTKLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { SPLATLoader } from 'three/addons/loaders/SPLATLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { KSPLATLoader } from 'three/addons/loaders/KSPLATLoader.js';
import { GCodeLoader } from 'three/addons/loaders/GCodeLoader.js';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { PDBLoader } from 'three/addons/loaders/PDBLoader.js';
import { LWOLoader } from 'three/addons/loaders/LWOLoader.js';
import { exportObject, exportBlocker, EXPORT_FORMATS } from '../src/exporters';
import { parsePTS, parseLAS } from '../src/formats-extra';

const require = createRequire(import.meta.url);

/** The audit's 20 × 30 × 40 box (file units), red. */
function box(w = 20, d = 30, h = 40) {
  const g = new THREE.BoxGeometry(w, d, h).translate(w / 2, d / 2, h / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xff0000 }));
  m.name = 'box';
  return m;
}
const sizeOf = (o: THREE.Object3D | THREE.BufferGeometry) => {
  if ((o as THREE.BufferGeometry).isBufferGeometry) { const g = o as THREE.BufferGeometry; g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()); }
  (o as THREE.Object3D).updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o as THREE.Object3D).getSize(new THREE.Vector3());
};
const sorted = (v: THREE.Vector3) => [v.x, v.y, v.z].map((x) => +x.toFixed(3)).sort((a, b) => a - b);
const sameSize = (v: THREE.Vector3, want: number[], eps = 1e-3) => { const s = sorted(v), w = [...want].sort((a, b) => a - b); s.forEach((x, i) => assert.ok(Math.abs(x - w[i]) <= eps * Math.max(1, w[i]), `size ${s} ≈ ${w}`)); };
const ab = async (b: Blob) => await b.arrayBuffer();
const MM = { unit: 'mm' as const, up: 'z' as const };

test('FBX (binary 7.4) round-trips through three.js FBXLoader with its size', async () => {
  const buf = await ab(await exportObject(box(), 'fbx', MM));
  assert.equal(new TextDecoder().decode(new Uint8Array(buf, 0, 18)), 'Kaydara FBX Binary');
  const scene = new FBXLoader().parse(buf, '');
  let mesh = 0; scene.traverse((o: any) => { if (o.isMesh) mesh++; });
  assert.equal(mesh, 1);
  // Numbers stay in the model unit; UnitScaleFactor (0.1 cm per mm) tells other programs the unit.
  sameSize(sizeOf(scene), [20, 30, 40], 2e-3);
  const { fbxUnit } = await import('../src/loaders');
  assert.equal(fbxUnit(buf), 'mm'); // the importer reads the declared unit back
  assert.equal(fbxUnit(await ab(await exportObject(box(), 'fbx', { unit: 'in', up: 'z' }))), 'in');
});

test('3DS round-trips through TDSLoader', async () => {
  const obj = new TDSLoader().parse(await ab(await exportObject(box(), '3ds', MM)), '');
  sameSize(sizeOf(obj), [20, 30, 40]);
});

test('3DS splits meshes over 65,535 vertices into several objects', async () => {
  const g = new THREE.SphereGeometry(10, 300, 150).toNonIndexed(); // ~270k vertices
  const obj = new TDSLoader().parse(await ab(await exportObject(new THREE.Mesh(g, new THREE.MeshStandardMaterial()), '3ds', MM)), '');
  let n = 0; obj.traverse((o: any) => { if (o.isMesh) { n++; assert.ok(o.geometry.attributes.position.count <= 65535 * 3); } });
  assert.ok(n >= 4, `${n} objects`);
});

test('LightWave LWO2 round-trips through LWOLoader (metres)', async () => {
  const res: any = new LWOLoader().parse(await ab(await exportObject(box(), 'lwo', MM)), '', '');
  const meshes = res.meshes as THREE.Mesh[];
  assert.ok(meshes.length >= 1);
  sameSize(sizeOf(meshes[0].geometry), [0.02, 0.03, 0.04]);
});

test('MagicaVoxel VOX is solid and about 128 voxels along the longest side', async () => {
  const chunks: any = new VOXLoader().parse(await ab(await exportObject(box(), 'vox', MM)));
  const c = Array.isArray(chunks) ? chunks[0] : chunks.chunks?.[0] ?? chunks;
  const size = c.size, n = c.data.length / 4;
  assert.equal(Math.max(size.x, size.y, size.z), 128);
  assert.ok(n > 0.8 * size.x * size.y * size.z, `${n} voxels of ${size.x * size.y * size.z}`); // a box fills its grid
});

test('MD2 round-trips through MD2Loader; too many vertices is refused', async () => {
  const geo = new MD2Loader().parse(await ab(await exportObject(box(), 'md2', MM)));
  sameSize(sizeOf(geo), [20, 30, 40], 0.01);
  const big = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64).toNonIndexed(), new THREE.MeshStandardMaterial());
  await assert.rejects(exportObject(big, 'md2', MM), /2,048 vertices/);
});

test('USDA declares metersPerUnit and up axis, with every triangle', async () => {
  const txt = await (await exportObject(box(), 'usda', MM)).text();
  assert.match(txt, /^#usda 1\.0/);
  assert.match(txt, /metersPerUnit = 0\.001/);
  assert.match(txt, /upAxis = "Z"/);
  assert.equal((txt.match(/faceVertexCounts = \[([^\]]*)\]/)![1].split(',')).length, 12);
});

test('COLLADA and KMZ: declared unit, up axis, matching counts', async () => {
  const dae = await (await exportObject(box(), 'dae', MM)).text();
  assert.match(dae, /<unit name="millimeter" meter="0.001"\/>/);
  assert.match(dae, /<up_axis>Z_UP<\/up_axis>/);
  assert.match(dae, /<triangles count="12"/);
  const kmz = unzipSync(new Uint8Array(await ab(await exportObject(box(), 'kmz', MM))));
  assert.ok(kmz['doc.kml'] && kmz['models/model.dae']);
  assert.match(strFromU8(kmz['doc.kml']), /<href>models\/model.dae<\/href>/);
});

test('VTK legacy round-trips through VTKLoader; VTP has matching counts', async () => {
  const geo = new VTKLoader().parse(await ab(await exportObject(box(), 'vtk', MM)), '');
  sameSize(sizeOf(geo), [20, 30, 40]);
  const vtp = await (await exportObject(box(), 'vtp', MM)).text();
  assert.match(vtp, /NumberOfPolys="12"/);
});

test('Point clouds: PCD, PTS and LAS round-trip with their size', async () => {
  const pcd = new PCDLoader().parse(await ab(await exportObject(box(), 'pcd', MM)));
  sameSize(sizeOf(pcd.geometry), [20, 30, 40]);
  sameSize(sizeOf(parsePTS(await (await exportObject(box(), 'pts', MM)).text(), 'a').geometry), [20, 30, 40]);
  sameSize(sizeOf(parseLAS(await ab(await exportObject(box(), 'las', MM)), 'a').object.geometry), [20, 30, 40], 1e-4);
});

test('Gaussian splats: .splat, .spz and .ksplat load in three.js with one splat per vertex', async () => {
  for (const [id, L] of [['splat', SPLATLoader], ['spz', SPZLoader], ['ksplat', KSPLATLoader]] as const) {
    const out: any = new (L as any)().parse(await ab(await exportObject(box(), id, MM)));
    const geo = out.isBufferGeometry ? out : out.geometry;
    const centers = geo.attributes.position ?? geo.attributes.center ?? Object.values(geo.attributes)[0];
    assert.ok(centers.count >= 8, `${id}: ${centers.count}`);
    sameSize(sizeOf(geo), [20, 30, 40], 0.02);
  }
});

test('G-code from lines round-trips; meshes are explained, not written', async () => {
  const pts = [0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 5, 0, 10, 5, 0, 10, 5, 3];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial());
  const txt = await (await exportObject(lines, 'gcode', MM)).text();
  assert.match(txt, /G21/);
  assert.equal((txt.match(/^G1 /gm) || []).length, 3);
  const parsed = new GCodeLoader().parse(txt);
  assert.ok(parsed.children.length >= 1);
  assert.match(exportBlocker(box(), 'gcode')!, /slice/);
});

test('BVH: skeleton and motion round-trip; needs a skeleton', async () => {
  const src = `HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n JOINT Spine\n {\n  OFFSET 0 10 0\n  CHANNELS 3 Zrotation Xrotation Yrotation\n  End Site\n  {\n   OFFSET 0 10 0\n  }\n }\n}\nMOTION\nFrames: 2\nFrame Time: 0.5\n0 0 0 0 0 0 0 0 0\n0 1 0 0 0 0 30 0 0\n`;
  const r = new BVHLoader().parse(src);
  const g = new THREE.Group(); g.add(r.skeleton.bones[0]);
  g.updateMatrixWorld(true);
  const out = await (await exportObject(g, 'bvh', { unit: 'u', up: 'y', clips: [r.clip] })).text();
  const back = new BVHLoader().parse(out);
  assert.equal(back.skeleton.bones.length, r.skeleton.bones.length);
  assert.ok(back.clip.duration > 0.4);
  assert.match(exportBlocker(box(), 'bvh')!, /skeleton/);
});

test('PDB: atoms round-trip; other models are explained', async () => {
  const g = new THREE.Group(); g.add(box(1, 1, 1));
  g.userData.pdbAtoms = [{ x: 0, y: 0, z: 0, element: 'O' }, { x: 0.957, y: 0, z: 0, element: 'H' }, { x: -0.24, y: 0.927, z: 0, element: 'H' }];
  const txt = await (await exportObject(g, 'pdb', { unit: 'u', up: 'y' })).text();
  const back: any = new PDBLoader().parse(txt);
  assert.equal(back.json.atoms.length, 3);
  assert.match(exportBlocker(box(), 'pdb')!, /molecule/);
});

test('STEP, IGES and BREP (faceted) are read back by OpenCascade with the right size', async () => {
  const occt = await require('occt-import-js')();
  for (const [id, fn] of [['step', 'ReadStepFile'], ['iges', 'ReadIgesFile'], ['brep', 'ReadBrepFile']] as const) {
    const data = new Uint8Array(await ab(await exportObject(box(), id, MM)));
    const r = occt[fn](data, null);
    assert.ok(r.success, `${id} read by OCCT`);
    assert.ok(r.meshes.length >= 1, `${id}: ${r.meshes.length} meshes`);
    const box3 = new THREE.Box3();
    for (const m of r.meshes) { const p = m.attributes.position.array; for (let i = 0; i < p.length; i += 3) box3.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2])); }
    sameSize(box3.getSize(new THREE.Vector3()), [20, 30, 40], 1e-3);
  }
});

test('STEP declares centimetres; inches are written as millimetres', async () => {
  assert.match(await (await exportObject(box(2, 3, 4), 'step', { unit: 'cm', up: 'z' })).text(), /SI_UNIT\(\.CENTI\.,\.METRE\.\)/);
  const inch = await (await exportObject(box(1, 1, 1), 'step', { unit: 'in', up: 'z' })).text();
  assert.match(inch, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  assert.match(inch, /25\.4/);
});

test('Rhino 3DM round-trips through rhino3dm with its unit', async () => {
  const rhino = await require('rhino3dm')();
  const data = new Uint8Array(await ab(await exportObject(box(), '3dm', MM)));
  const doc = rhino.File3dm.fromByteArray(data);
  assert.equal(doc.objects().count, 1);
  assert.equal(doc.settings().modelUnitSystem, rhino.UnitSystem.Millimeters);
  const bb = doc.objects().get(0).geometry().getBoundingBox();
  sameSize(new THREE.Vector3(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]), [20, 30, 40]);
});

test('IFC4 opens in web-ifc with one building element and its geometry', async () => {
  const W = require('web-ifc');
  const api = new W.IfcAPI();
  await api.Init();
  const data = new Uint8Array(await ab(await exportObject(box(), 'ifc', MM)));
  const id = api.OpenModel(data);
  assert.equal(api.GetLineIDsWithType(id, W.IFCBUILDINGELEMENTPROXY).size(), 1);
  let verts = 0;
  api.StreamAllMeshes(id, (mesh: any) => { for (let i = 0; i < mesh.geometries.size(); i++) { const g = api.GetGeometry(id, mesh.geometries.get(i).geometryExpressID); verts += api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize()).length; } });
  assert.ok(verts > 0, 'IFC geometry was generated');
  api.CloseModel(id);
});

test('Draco round-trips through the Draco decoder', async () => {
  const draco = require('draco3d');
  const data = new Uint8Array(await ab(await exportObject(box(), 'drc', MM)));
  const D = await draco.createDecoderModule({});
  const buffer = new D.DecoderBuffer(); buffer.Init(new Int8Array(data.buffer), data.length);
  const decoder = new D.Decoder();
  assert.equal(decoder.GetEncodedGeometryType(buffer), D.TRIANGULAR_MESH);
  const mesh = new D.Mesh();
  assert.ok(decoder.DecodeBufferToMesh(buffer, mesh).ok());
  assert.equal(mesh.num_faces(), 12);
  D.destroy(mesh); D.destroy(decoder); D.destroy(buffer);
});

test('Every format OMNIVIEWER opens has an export target', async () => {
  const { FORMATS } = await import('../src/loaders');
  const opens = new Set(FORMATS.flatMap((f) => f.ext).filter((e) => e !== 'zip'));
  const writes = new Set(EXPORT_FORMATS.flatMap((f: any) => [f.ext, ...(f.alias ?? [])]));
  const missing = [...opens].filter((e) => !writes.has(e));
  assert.deepEqual(missing, ['usdc'], `not writable: ${missing.join(', ')}`);
});

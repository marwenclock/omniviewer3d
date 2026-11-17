import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { exportObject, describeExport, safeFileName, outputUnit, type UnitId } from '../src/exporters';

/** The audit's 20×30×40 box, sitting at the origin like an STL file (coordinates are file units). */
function box(w = 20, d = 30, h = 40, name = 'box') {
  const g = new THREE.BoxGeometry(w, d, h).translate(w / 2, d / 2, h / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x808080 }));
  m.name = name;
  return m;
}

async function parseGlb(blob: Blob): Promise<THREE.Object3D> {
  const buf = await blob.arrayBuffer();
  return new Promise((res, rej) => new GLTFLoader().parse(buf, '', (g) => res(g.scene), rej));
}
const size = (o: THREE.Object3D) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()); };
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

test('OV-001 + CA-02: mm Z-up STL → GLB keeps physical size and stands upright (Y-up metres)', async () => {
  const s = size(await parseGlb(await exportObject(box(), 'glb', { unit: 'mm', up: 'z' })));
  near(s.x, 0.020); near(s.y, 0.040); near(s.z, 0.030);
});

test('OV-001: every source unit round-trips through GLB at the same physical size', async () => {
  for (const [unit, k] of [['mm', 0.001], ['cm', 0.01], ['m', 1], ['in', 0.0254], ['ft', 0.3048]] as [UnitId, number][]) {
    const s = size(await parseGlb(await exportObject(box(2, 3, 4), 'glb', { unit, up: 'y' })));
    near(s.x, 2 * k); near(s.y, 3 * k); near(s.z, 4 * k);
  }
});

test('CA-24: metre Y-up model → STL is written in millimetres, Z-up for printing', async () => {
  const buf = await (await exportObject(box(2, 1, 0.5), 'stl', { unit: 'm', up: 'y', zUp: true })).arrayBuffer();
  const g = new STLLoader().parse(buf);
  g.computeBoundingBox();
  const s = g.boundingBox!.getSize(new THREE.Vector3());
  near(s.x, 2000, 1e-4); near(s.y, 500, 1e-4); near(s.z, 1000, 1e-4);
});

test('STL from a mm model keeps the numbers (no double scaling)', async () => {
  const g = new STLLoader().parse(await (await exportObject(box(), 'stl', { unit: 'mm', up: 'z' })).arrayBuffer());
  g.computeBoundingBox();
  const s = g.boundingBox!.getSize(new THREE.Vector3());
  near(s.x, 20, 1e-4); near(s.y, 30, 1e-4); near(s.z, 40, 1e-4);
});

test('OV-004: hidden parts are left out of every mesh format, included with scope "all"', async () => {
  const scene = new THREE.Group();
  const a = box(10, 10, 10, 'A'), b = box(10, 10, 10, 'B');
  b.position.x = 20; b.visible = false;
  scene.add(a, b);
  const stlTris = async (scope: 'visible' | 'all') => new DataView(await (await exportObject(scene, 'stl', { unit: 'mm', scope })).arrayBuffer()).getUint32(80, true);
  assert.equal(await stlTris('visible'), 12);
  assert.equal(await stlTris('all'), 24);
  const obj = await (await exportObject(scene, 'obj', { unit: 'mm' })).text();
  assert.equal((obj.match(/^o /gm) || []).length, 1);
  const ply = await (await exportObject(scene, 'ply', { unit: 'mm' })).arrayBuffer();
  const header = new TextDecoder().decode(ply.slice(0, 300));
  assert.match(header, /element face 12\b/);
  const glb = await parseGlb(await exportObject(scene, 'glb', { unit: 'mm' }));
  let meshes = 0; glb.traverse((o: any) => { if (o.isMesh) meshes++; });
  assert.equal(meshes, 1);
  // A hidden parent hides its children too.
  const outer = new THREE.Group(); const inner = new THREE.Group(); inner.visible = false; inner.add(box()); outer.add(inner, box(5, 5, 5));
  assert.equal(new DataView(await (await exportObject(outer, 'stl', { unit: 'mm' })).arrayBuffer()).getUint32(80, true), 12);
});

test('CA-04: internal app data does not leak into glTF extras', async () => {
  const m = box();
  m.userData.explodeBase = new THREE.Vector3(1, 2, 3);
  (m.material as any).userData.orig = { opacity: 1 };
  m.geometry.userData.groupNames = ['secret'];
  const json = await (await exportObject(m, 'gltf', { unit: 'mm' })).text();
  assert.doesNotMatch(json, /explodeBase|groupNames|"orig"/);
  assert.ok((m.material as any).userData.orig, 'the visible material keeps its own data');
});

test('CA-03: USDZ is written in metres with a Y-up stage', async () => {
  const files = unzipSync(new Uint8Array(await (await exportObject(box(), 'usdz', { unit: 'mm', up: 'z' })).arrayBuffer()));
  const usda = strFromU8(files[Object.keys(files).find((k) => k.endsWith('.usda'))!]);
  assert.match(usda, /metersPerUnit = 1/);
  assert.match(usda, /upAxis = "Y"/);
  assert.match(usda, /0\.001/);
});

test('3MF declares the model unit and keeps the numbers', async () => {
  const files = unzipSync(new Uint8Array(await (await exportObject(box(1, 2, 3), '3mf', { unit: 'in', up: 'z' })).arrayBuffer()));
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.match(model, /unit="inch"/);
  const zs = [...model.matchAll(/z="([-\d.]+)"/g)].map((m) => Number(m[1]));
  near(Math.max(...zs) - Math.min(...zs), 3, 1e-4);
});

test('OV-020: 3MF can carry painted per-triangle colours', async () => {
  const m = box(1, 1, 1);
  const n = m.geometry.attributes.position.count;
  m.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1).map((v, i) => (i % 3 === 0 ? 1 : 0)), 3));
  const files = unzipSync(new Uint8Array(await (await exportObject(m, '3mf', { unit: 'mm', perTriangleColors: true })).arrayBuffer()));
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.match(model, /<m:colorgroup/);
  assert.match(model, /p1="0"/);
});

test('Animation tracks for parts outside the export are dropped (part export)', async () => {
  const scene = new THREE.Group();
  const a = box(1, 1, 1, 'Keep'), b = box(1, 1, 1, 'Gone');
  scene.add(a, b);
  const clip = new THREE.AnimationClip('spin', 1, [
    new THREE.NumberKeyframeTrack('Keep.position[x]', [0, 1], [0, 1]),
    new THREE.NumberKeyframeTrack('Gone.position[x]', [0, 1], [0, 1]),
  ]);
  const json = JSON.parse(await (await exportObject(a, 'gltf', { unit: 'm', clips: [clip] })).text());
  assert.equal(json.animations?.length, 1);
  assert.equal(json.animations[0].channels.length, 1);
});

test('OV-016: preflight report lists losses and hidden parts', () => {
  const scene = new THREE.Group();
  const a = box(); const b = box(); b.visible = false;
  scene.add(a, b);
  const r = describeExport(scene, 'stl', { unit: 'mm', clips: [new THREE.AnimationClip('x', 1, [])] });
  assert.equal(r.parts, 1);
  assert.equal(r.hiddenParts, 1);
  assert.ok(r.lost.some((s) => /animation/.test(s)));
  assert.ok(r.warnings.some((s) => /hidden/.test(s)));
  assert.equal(r.sizeUnit, 'mm');
  assert.equal(outputUnit('glb', { unit: 'mm' }), 'm');
});

test('OV-019: file names keep non-Latin letters', () => {
  assert.equal(safeFileName('Pièce_für Ölwanne çà.stl'), 'Pièce_für Ölwanne çà.stl');
  assert.equal(safeFileName('a/b:c*?.stl'), 'abc.stl');
  assert.equal(safeFileName('  '), 'model');
});

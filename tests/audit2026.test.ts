import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportObject } from '../src/exporters';
import { groupFiles, needsUnitConfirm } from '../src/features/qclogic';

// Regression tests for the 18 November 2026 audit fixes that don't need a browser.

const companion = (f: string) => /\.(mtl|png|jpe?g|bin)$/i.test(f);

test('F13: a single model keeps companions from sibling folders such as textures/', () => {
  const g = groupFiles(['pack/model.obj', 'pack/model.mtl', 'pack/textures/a.png', 'pack/textures/b.png'], (f) => f, companion);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0], ['pack/model.obj', 'pack/model.mtl', 'pack/textures/a.png', 'pack/textures/b.png']);
});

test('F13: two models each keep their own folder; an unowned texture goes to both', () => {
  const g = groupFiles(['a/one.obj', 'a/one.mtl', 'a/tex/x.png', 'b/two.obj', 'b/two.mtl', 'shared.png'], (f) => f, companion);
  assert.deepEqual(g[0], ['a/one.obj', 'a/one.mtl', 'a/tex/x.png', 'shared.png']);
  assert.deepEqual(g[1], ['b/two.obj', 'b/two.mtl', 'shared.png']);
});

test('F12: only textures gives no model group (the UI then explains what to add)', () => {
  assert.deepEqual(groupFiles(['x.png', 'y.mtl'], (f) => f, companion), []);
});

test('F02: an estimated unit needs confirming for formats that record a size, not for unitless ones', () => {
  assert.equal(needsUnitConfirm({ unitSrc: 'guess', target: 'glb' }), true);
  assert.equal(needsUnitConfirm({ unitSrc: 'guess', target: '3mf' }), true);
  assert.equal(needsUnitConfirm({ unitSrc: 'guess', target: 'stl' }), false);
  assert.equal(needsUnitConfirm({ unitSrc: 'user', target: 'glb' }), false);
  assert.equal(needsUnitConfirm({ unitSrc: 'declared', target: '3mf' }), false);
  assert.equal(needsUnitConfirm({ unitSrc: 'format', target: '3mf' }), false);
});

async function parseGlb(blob: Blob): Promise<THREE.Object3D> {
  const buf = await blob.arrayBuffer();
  return new Promise((res, rej) => new GLTFLoader().parse(buf, '', (g) => res(g.scene), rej));
}

test('F03: project export keeps node ids for same-name and unnamed parts, and marks the model root', async () => {
  const root = new THREE.Group(); root.name = 'assembly';
  const mk = (name: string) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.name = name; return m; };
  const parts = [mk('Bracket'), mk('Bracket'), mk('')];
  root.add(...parts);
  let n = 0; root.traverse((o) => { o.userData.ovId = n++; });
  parts[1].visible = false; parts[2].visible = false;
  const back = await parseGlb(await exportObject(root, 'glb', { unit: 'm', up: 'y', scope: 'all', keepIds: true }));
  const ids: number[] = []; let marked = 0;
  back.traverse((o) => { if (typeof o.userData.ovId === 'number') ids.push(o.userData.ovId); if (o.userData.ovRoot) marked++; });
  assert.deepEqual(ids.sort(), [0, 1, 2, 3]);
  assert.equal(marked, 1);
});

test('CA-04 still holds: ordinary exports carry no app data', async () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); m.userData.ovId = 7; m.userData.secret = 'x';
  const back = await parseGlb(await exportObject(m, 'glb', { unit: 'm', up: 'y', scope: 'all' }));
  back.traverse((o) => { assert.equal(o.userData.ovId, undefined); assert.equal(o.userData.secret, undefined); });
});

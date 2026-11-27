import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { decodePaint, applyPaint3MF } from '../src/paint3mf';

test('slicer paint codes decode to the filament that covers the triangle', () => {
  assert.equal(decodePaint(''), 0);
  assert.equal(decodePaint('4'), 1);
  assert.equal(decodePaint('8'), 2);
  assert.equal(decodePaint('0C'), 3); // Bambu Studio: filament 3
  assert.equal(decodePaint('1C'), 4);
  // Split into 2 halves (code 1): one half filament 1, the other filament 2 → whichever comes first wins a tie.
  assert.ok([1, 2].includes(decodePaint('841')));
  // Split into 4 (code 3): three quarters filament 2, one quarter filament 1.
  assert.equal(decodePaint('48883'), 2);
});

test('a Bambu-painted 3MF triangle gets its filament colour', () => {
  const model = `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="1" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="2" v2="1" v3="3" paint_color="0C"/></triangles>
    </mesh></object></resources><build><item objectid="1"/></build></model>`;
  const settings = JSON.stringify({ filament_colour: ['#FFFFFF', '#000000', '#C12E1E'] });
  const data = zipSync({ '3D/3dmodel.model': strToU8(model), 'Metadata/project_settings.config': strToU8(settings) });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0], 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  const root = new THREE.Group().add(mesh);
  assert.equal(applyPaint3MF(root, data.buffer as ArrayBuffer), 1);
  const col = mesh.geometry.attributes.color;
  const red = new THREE.Color('#C12E1E');
  assert.ok(Math.abs(col.getX(3) - red.r) < 1e-4 && Math.abs(col.getY(3) - red.g) < 1e-4, 'painted triangle is filament 3');
  assert.ok(col.getX(0) > 0.9, 'unpainted triangle uses the object filament (1 = white)');
});

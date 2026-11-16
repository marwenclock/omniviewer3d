// Copies the WebAssembly decoders/engines that the viewer lazy-loads at runtime
// from node_modules into public/libs, so they are served as static files.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'libs');

const copies = [
  ['three/examples/jsm/libs/draco/gltf/draco_decoder.wasm', 'draco/draco_decoder.wasm'],
  ['three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js', 'draco/draco_wasm_wrapper.js'],
  ['three/examples/jsm/libs/draco/gltf/draco_decoder.js', 'draco/draco_decoder.js'],
  ['three/examples/jsm/libs/basis/basis_transcoder.js', 'basis/basis_transcoder.js'],
  ['three/examples/jsm/libs/basis/basis_transcoder.wasm', 'basis/basis_transcoder.wasm'],
  ['occt-import-js/dist/occt-import-js.js', 'occt/occt-import-js.js'],
  ['occt-import-js/dist/occt-import-js.wasm', 'occt/occt-import-js.wasm'],
  ['web-ifc/web-ifc.wasm', 'web-ifc/web-ifc.wasm'],
  ['rhino3dm/rhino3dm.js', 'rhino3dm/rhino3dm.js'],
  ['rhino3dm/rhino3dm.wasm', 'rhino3dm/rhino3dm.wasm'],
];

for (const [from, to] of copies) {
  const src = join(nm, from);
  if (!existsSync(src)) { console.warn(`[copy-libs] missing ${from}`); continue; }
  const dest = join(out, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}
console.log('[copy-libs] runtime libraries copied to public/libs');

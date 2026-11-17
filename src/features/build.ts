import * as THREE from 'three';
import { ctx, escHtml, modelMeshes } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { libUrl, defaultMaterial } from '../loaders';
import { UNITS } from '../stats';
import { registerContextAction } from './palette';

const mmToUnits = (mm: number) => mm / (UNITS[ctx.unit()].toMeters * 1000);
const round = (v: number) => Number(v.toPrecision(3));

/** Puts a geometry's base on y = 0 and centres it in x/z, so it can be dropped next to the model. */
function seat(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const b = g.boundingBox!, c = b.getCenter(new THREE.Vector3());
  g.translate(-c.x, -b.min.y, -c.z);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ 3D text
const FONTS = { 'Geist Bold': 'fonts/Geist-Bold.ttf', 'Geist Regular': 'fonts/Geist-Regular.ttf', 'Geist Mono': 'fonts/GeistMono-Bold.ttf' } as const;
type FontName = keyof typeof FONTS;
const fontCache = new Map<string, any>();
async function loadFont(name: FontName) {
  if (!fontCache.has(name)) {
    const opentype: any = await import('opentype.js');
    const buf = await (await fetch(libUrl(FONTS[name]))).arrayBuffer();
    fontCache.set(name, (opentype.parse || opentype.default.parse)(buf));
  }
  return fontCache.get(name);
}

const text = { value: 'BANKASI', font: 'Geist Bold' as FontName, heightMm: 20, depthMm: 5, bevel: true, base: false };

async function makeText() {
  const font = await loadFont(text.font);
  const size = 100; // font units, scaled to the requested letter height below
  const path = font.getPath(text.value, 0, 0, size);
  const sp = new THREE.ShapePath();
  // opentype is y-down; flip to three's y-up
  for (const c of path.commands) {
    if (c.type === 'M') sp.moveTo(c.x, -c.y);
    else if (c.type === 'L') sp.lineTo(c.x, -c.y);
    else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
    else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
  }
  const shapes = sp.toShapes();
  if (!shapes.length) throw new Error('Type some text first');
  const capHeight = (font.tables?.os2?.sCapHeight || font.unitsPerEm * 0.7) * (size / font.unitsPerEm);
  const k = mmToUnits(text.heightMm) / capHeight;
  const depth = mmToUnits(text.depthMm) / k;
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth, curveSegments: 10,
    bevelEnabled: text.bevel, bevelThickness: depth * 0.08, bevelSize: size * 0.012, bevelSegments: 2,
  });
  g.scale(k, k, k);
  // Stand the letters up: text in the X/Y plane, extruded towards the viewer.
  const parts: THREE.BufferGeometry[] = [g];
  let geo: THREE.BufferGeometry = g;
  if (text.base) {
    g.computeBoundingBox();
    const b = g.boundingBox!, pad = mmToUnits(text.heightMm) * 0.35;
    const plate = new THREE.BoxGeometry(b.max.x - b.min.x + pad * 2, mmToUnits(text.heightMm) * 0.25, b.max.z - b.min.z + pad * 2);
    plate.translate((b.min.x + b.max.x) / 2, b.min.y - mmToUnits(text.heightMm) * 0.125, (b.min.z + b.max.z) / 2);
    parts.push(plate.toNonIndexed());
    const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
    geo = mergeGeometries(parts.map((p) => { const q = p.index ? p.toNonIndexed() : p; q.deleteAttribute('uv'); return q; }))!;
  }
  const mesh = new THREE.Mesh(seat(geo), defaultMaterial());
  mesh.name = `Text "${text.value}"`;
  ctx.editor.addObject(mesh, 'Add 3D text');
}

registerPanel({
  id: 'text', label: '3D text', icon: 'text', needsModel: false,
  hint: 'Type, pick a font and size, then add: great for nameplates and keychains',
  render() {
    const u = UNITS[ctx.unit()].short;
    return `<div class="row" style="margin-top:0"><input type="text" value="${escHtml(text.value)}" data-txt placeholder="Your text"/></div>
      <div class="row"><label>Font</label><select data-txtfont>${Object.keys(FONTS).map((f) => `<option ${f === text.font ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="row"><label>Letter height</label><input type="number" min="0" step="any" value="${round(mmToUnits(text.heightMm))}" data-txth/><span class="cost-unit">${u}</span></div>
      <div class="row"><label>Depth</label><input type="number" min="0" step="any" value="${round(mmToUnits(text.depthMm))}" data-txtd/><span class="cost-unit">${u}</span></div>
      <label class="check"><input type="checkbox" data-txtbevel ${text.bevel ? 'checked' : ''}/> Rounded edges (bevel)</label>
      <label class="check"><input type="checkbox" data-txtbase ${text.base ? 'checked' : ''}/> Add a base plate</label>
      <div class="btn-row"><button class="btn-solid" data-txtadd>Add text</button></div>`;
  },
  bind(host) {
    const toMm = (v: string) => Number(v) * UNITS[ctx.unit()].toMeters * 1000;
    host.querySelector('[data-txt]')?.addEventListener('input', (e) => { text.value = (e.target as HTMLInputElement).value; });
    host.querySelector('[data-txtfont]')?.addEventListener('change', (e) => { text.font = (e.target as HTMLSelectElement).value as FontName; });
    host.querySelector('[data-txth]')?.addEventListener('change', (e) => { text.heightMm = toMm((e.target as HTMLInputElement).value) || text.heightMm; });
    host.querySelector('[data-txtd]')?.addEventListener('change', (e) => { text.depthMm = toMm((e.target as HTMLInputElement).value) || text.depthMm; });
    host.querySelector('[data-txtbevel]')?.addEventListener('change', (e) => { text.bevel = (e.target as HTMLInputElement).checked; });
    host.querySelector('[data-txtbase]')?.addEventListener('change', (e) => { text.base = (e.target as HTMLInputElement).checked; });
    host.querySelector('[data-txtadd]')?.addEventListener('click', async () => {
      ctx.setLoading('Building 3D text…');
      try { await makeText(); document.body.classList.add('has-model'); } catch (e: any) { ctx.toast(e?.message || String(e), true); } finally { ctx.setLoading(null); }
    });
  },
});

// ------------------------------------------------------------------ SVG logo extrusion
const svg = { widthMm: 60, depthMm: 3, file: '' as string, name: '' };

async function makeSvg() {
  if (!svg.file) throw new Error('Choose an SVG file first');
  const { SVGLoader } = await import('three/addons/loaders/SVGLoader.js');
  const data = new SVGLoader().parse(svg.file);
  const group = new THREE.Group();
  group.name = svg.name || 'Logo';
  const geos: { g: THREE.BufferGeometry; color: THREE.Color }[] = [];
  for (const path of data.paths) {
    const style: any = path.userData?.style || {};
    if (style.fill === 'none' && !style.stroke) continue;
    const shapes = SVGLoader.createShapes(path);
    if (!shapes.length) continue;
    const color = style.fill && style.fill !== 'none' ? new THREE.Color().setStyle(style.fill) : path.color;
    geos.push({ g: new THREE.ExtrudeGeometry(shapes, { depth: 1, curveSegments: 12, bevelEnabled: false }), color });
  }
  if (!geos.length) throw new Error('No filled shapes found in this SVG');
  const box = new THREE.Box3();
  geos.forEach(({ g }) => { g.computeBoundingBox(); box.union(g.boundingBox!); });
  const k = mmToUnits(svg.widthMm) / (box.max.x - box.min.x || 1);
  const depth = mmToUnits(svg.depthMm);
  geos.forEach(({ g, color }, i) => {
    // SVG is y-down: flip, scale to the requested width, set depth, lay it flat like a badge standing up.
    g.scale(k, -k, depth);
    g.translate(0, 0, i * depth * 0.001); // avoid z-fighting between overlapping layers
    const mat = defaultMaterial();
    mat.color.copy(color);
    const m = new THREE.Mesh(g, mat);
    m.name = `Shape ${i + 1}`;
    group.add(m);
  });
  const all = new THREE.Box3().setFromObject(group), c = all.getCenter(new THREE.Vector3());
  group.children.forEach((m) => (m as THREE.Mesh).geometry.translate(-c.x, -all.min.y, -c.z));
  ctx.editor.addObject(group, 'Add SVG logo');
}

registerPanel({
  id: 'svg', label: 'SVG logo', icon: 'logo', needsModel: false,
  hint: 'Turn a flat SVG logo into a 3D shape, keeping its colours',
  render() {
    const u = UNITS[ctx.unit()].short;
    return `<div class="btn-row" style="margin-top:0"><button class="chip" data-svgpick>${svg.name ? escHtml(svg.name) : 'Choose SVG…'}</button></div>
      <div class="row"><label>Width</label><input type="number" min="0" step="any" value="${round(mmToUnits(svg.widthMm))}" data-svgw/><span class="cost-unit">${u}</span></div>
      <div class="row"><label>Depth</label><input type="number" min="0" step="any" value="${round(mmToUnits(svg.depthMm))}" data-svgd/><span class="cost-unit">${u}</span></div>
      <div class="btn-row"><button class="btn-solid" data-svgadd ${svg.file ? '' : 'disabled'}>Add logo</button></div>
      <p class="note">Works with filled shapes (most logo SVGs). Each colour becomes its own part, so you can recolour or export them separately.</p>`;
  },
  bind(host) {
    const toMm = (v: string) => Number(v) * UNITS[ctx.unit()].toMeters * 1000;
    host.querySelector('[data-svgpick]')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.svg,image/svg+xml';
      input.onchange = async () => { const f = input.files?.[0]; if (!f) return; svg.file = await f.text(); svg.name = f.name.replace(/\.svg$/i, ''); ctx.renderDetails(); };
      input.click();
    });
    host.querySelector('[data-svgw]')?.addEventListener('change', (e) => { svg.widthMm = toMm((e.target as HTMLInputElement).value) || svg.widthMm; });
    host.querySelector('[data-svgd]')?.addEventListener('change', (e) => { svg.depthMm = toMm((e.target as HTMLInputElement).value) || svg.depthMm; });
    host.querySelector('[data-svgadd]')?.addEventListener('click', async () => {
      ctx.setLoading('Extruding logo…');
      try { await makeSvg(); document.body.classList.add('has-model'); } catch (e: any) { ctx.toast(e?.message || String(e), true); } finally { ctx.setLoading(null); }
    });
  },
});

// ------------------------------------------------------------------ boolean (combine / subtract / intersect)
let boolOp: 'subtract' | 'union' | 'intersect' = 'subtract';
let toolUuid = '';
let keepTool = false;

async function runBoolean() {
  const a = ctx.editor.selected as THREE.Mesh | null;
  const b = modelMeshes(ctx.viewer.model).find((m) => m.uuid === toolUuid);
  if (!a || !(a as any).isMesh) throw new Error('Select the part to change first (click it)');
  if (!b || b === a) throw new Error('Choose the second part in the list');
  const { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } = await import('three-bvh-csg');
  const prep = (m: THREE.Mesh) => {
    m.updateWorldMatrix(true, false);
    let g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.clearGroups();
    g.applyMatrix4(m.matrixWorld);
    const brush = new Brush(g, new THREE.MeshStandardMaterial());
    brush.updateMatrixWorld();
    return brush;
  };
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;
  const op = boolOp === 'union' ? ADDITION : boolOp === 'intersect' ? INTERSECTION : SUBTRACTION;
  const result = ev.evaluate(prep(a), prep(b), op);
  const geo = result.geometry;
  if (!geo.attributes.position?.count) throw new Error('The result is empty (the parts may not overlap)');
  // Back into A's local space.
  geo.applyMatrix4(a.matrixWorld.clone().invert());
  const before = a.geometry, parentB = b.parent!, indexB = parentB.children.indexOf(b);
  const removeB = !keepTool;
  ctx.history.run({
    label: boolOp === 'subtract' ? 'Subtract' : boolOp === 'union' ? 'Combine' : 'Intersect',
    redo: () => { a.geometry = geo; if (removeB) parentB.remove(b); ctx.viewer.refreshMaterials(); ctx.refresh(); },
    undo: () => { a.geometry = before; if (removeB) { parentB.children.splice(indexB, 0, b); b.parent = parentB; } ctx.viewer.refreshMaterials(); ctx.refresh(); },
  });
  ctx.toast('Done. Undo with Ctrl+Z.');
}

registerPanel({
  id: 'boolean', label: 'Combine / subtract', icon: 'boolean',
  hint: 'Select a part, choose a second part, then combine or cut one from the other',
  render() {
    const a = ctx.editor.selected;
    const others = modelMeshes(ctx.viewer.model).filter((m) => m !== a);
    if (!toolUuid || !others.some((m) => m.uuid === toolUuid)) toolUuid = others[others.length - 1]?.uuid || '';
    return `<div class="seg" style="margin-bottom:8px">${(['subtract', 'union', 'intersect'] as const).map((o) => `<button class="${boolOp === o ? 'active' : ''}" data-boolop="${o}">${o === 'subtract' ? 'Subtract' : o === 'union' ? 'Combine' : 'Intersect'}</button>`).join('')}</div>
      <div class="row"><label>Part A</label><span style="font-size:12.5px">${a && (a as any).isMesh ? escHtml(a.name || 'Selected part') : '<span class="note">click a part to select it</span>'}</span></div>
      <div class="row"><label>Part B</label><select data-booltool>${others.map((m) => `<option value="${m.uuid}" ${m.uuid === toolUuid ? 'selected' : ''}>${escHtml(m.name || 'Part')}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" data-boolkeep ${keepTool ? 'checked' : ''}/> Keep part B afterwards</label>
      <div class="btn-row"><button class="btn-solid" data-boolgo>${boolOp === 'subtract' ? 'Subtract B from A' : boolOp === 'union' ? 'Combine A and B' : 'Keep the overlap'}</button></div>
      <p class="note">Tip: to drill a hole, add a cylinder, move it through the part, select the part, then subtract the cylinder.</p>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLElement>('[data-boolop]').forEach((b) => b.addEventListener('click', () => { boolOp = b.dataset.boolop as any; ctx.renderDetails(); }));
    host.querySelector('[data-booltool]')?.addEventListener('change', (e) => { toolUuid = (e.target as HTMLSelectElement).value; });
    host.querySelector('[data-boolkeep]')?.addEventListener('change', (e) => { keepTool = (e.target as HTMLInputElement).checked; });
    host.querySelector('[data-boolgo]')?.addEventListener('click', async () => {
      ctx.setLoading('Calculating…');
      try { await runBoolean(); } catch (e: any) { ctx.toast(e?.message || String(e), true); } finally { ctx.setLoading(null); }
    });
  },
});

// ------------------------------------------------------------------ place a face on the floor
/** Rotates `obj` so the clicked face points straight down, then sets it on the floor. */
export function layFlat(obj: THREE.Object3D, worldNormal: THREE.Vector3) {
  const down = new THREE.Vector3(0, -1, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), down);
  const parentQ = obj.parent ? obj.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  ctx.editor.transformObject(obj, 'Place face on floor', (o) => {
    // world' = q · world  →  local' = parent⁻¹ · q · parent · local
    o.quaternion.copy(parentQ.clone().invert().multiply(q).multiply(parentQ).multiply(o.quaternion));
  });
  ctx.editor.dropToFloor();
}

let flatTarget: THREE.Object3D | null = null;
function onFlatClick(e: PointerEvent) {
  if (ctx.activeTool() !== 'layflat' || e.button !== 0) return;
  const hit = ctx.viewer.pick(e);
  if (!hit?.face) return;
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const target = flatTarget ?? ctx.viewer.model!;
  setTimeout(() => { ctx.editor.select(target === ctx.viewer.model ? null : target); layFlat(target, n); ctx.viewer.fit(); ctx.setTool('none'); }, 0);
}

registerPanel({
  id: 'layflat', label: 'Place face on floor', icon: 'layflat',
  hint: 'Click the face that should sit on the print bed',
  onActivate: () => { flatTarget = ctx.editor.selected; },
  render: () => `<p class="note" style="margin:0">Click a flat face on ${flatTarget ? `“${escHtml(flatTarget.name || 'the selected part')}”` : 'the model'}. It will be rotated so that face lies on the floor, ready to slice.</p>`,
});

export function initBuild() {
  ctx.viewer.renderer.domElement.addEventListener('pointerup', onFlatClick);
  registerContextAction({
    label: 'Place this face on the floor', icon: 'layflat',
    when: (h) => !!h?.face,
    run: (h) => { const n = h!.face!.normal.clone().transformDirection(h!.object.matrixWorld); layFlat(ctx.viewer.model!, n); ctx.viewer.fit(); },
  });
  registerCommand(
    { id: 'text', label: 'Add 3D text…', group: 'Add', keywords: 'letters name keychain nameplate font', run: () => { ctx.editor.ensureModel(); document.body.classList.add('has-model'); ctx.setTool('text'); } },
    { id: 'svg', label: 'Add SVG logo…', group: 'Add', keywords: 'extrude vector image badge', run: () => { ctx.editor.ensureModel(); document.body.classList.add('has-model'); ctx.setTool('svg'); } },
    { id: 'boolean', label: 'Combine / subtract parts (boolean)', group: 'Edit', keywords: 'csg hole cut union difference intersect', run: () => ctx.setTool('boolean'), enabled: () => !!ctx.viewer.model },
    { id: 'layflat', label: 'Place face on floor', group: 'Print', keywords: 'lay flat orient bed rotate', run: () => ctx.setTool('layflat'), enabled: () => !!ctx.viewer.model },
  );
}

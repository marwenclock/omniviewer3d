// Multi-colour painting stored in 3MF files by slicers: Bambu Studio / OrcaSlicer (`paint_color`) and PrusaSlicer
// (`slic3rpe:mmu_segmentation`) mark each triangle with the filament it prints in. three's 3MF loader ignores these,
// so a painted logo would open in one colour. Here the marks are read and shown as vertex colours, using the
// filament colours from the project settings, so the colour borders can be seen, picked and split into parts.
import * as THREE from 'three';
import { unzipSync } from 'fflate';

/** Default colours when the project doesn't list its filaments. */
const FALLBACK = ['#f2f2f2', '#262626', '#d23c2c', '#2e86de', '#f3a712', '#76b041', '#6c5ce7', '#e84393'];

/**
 * Decodes a TriangleSelector string (shared by PrusaSlicer, Bambu Studio and OrcaSlicer). Hex digits are read from
 * the end; a triangle split into smaller ones lists its children. Returns the filament state that covers most of the
 * triangle (0 = the object's own filament).
 */
export function decodePaint(code: string): number {
  let i = code.length - 1;
  const next = () => (i >= 0 ? parseInt(code[i--], 16) : 0);
  const counts = new Map<number, number>();
  const walk = (weight: number, depth: number) => {
    const n = next();
    const split = n & 3;
    if (split && depth < 12) {
      const kids = split + 1;
      for (let k = 0; k < kids; k++) walk(weight / kids, depth + 1);
      return;
    }
    let state = n >> 2;
    if (state === 3) { let m = next(); state = 3 + m; while (m === 15 && i >= 0) { m = next(); state += m; } }
    counts.set(state, (counts.get(state) || 0) + weight);
  };
  if (code) walk(1, 0);
  let best = 0, bestW = -1;
  for (const [s, w] of counts) if (w > bestW) { best = s; bestW = w; }
  return best;
}

interface Painted { tris: Map<string, number>; objectFilament: number }

/** Reads the painted triangles per object from the package, keyed by their three vertex positions. */
function readPaint(data: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(data), { filter: (f) => /\.model$|project_settings\.config$|model_settings\.config$|Slic3r_PE\.config$/i.test(f.name) });
  const dec = new TextDecoder();
  let colours: string[] = [];
  let anyPaint = false;
  const objects: Painted[] = [];
  const objectFilament = new Map<string, number>();
  for (const [name, bytes] of Object.entries(files)) {
    const text = dec.decode(bytes);
    if (/project_settings\.config$/i.test(name)) {
      try { colours = (JSON.parse(text).filament_colour as string[]) ?? []; } catch { /* not JSON */ }
    } else if (/Slic3r_PE\.config$/i.test(name)) {
      const m = text.match(/;\s*extruder_colour\s*=\s*(.+)/);
      if (m) colours = m[1].split(';').map((s) => s.trim().replace(/"/g, ''));
    } else if (/model_settings\.config$/i.test(name)) {
      for (const m of text.matchAll(/<object id="(\d+)">[\s\S]*?<metadata key="extruder" value="(\d+)"/g)) objectFilament.set(m[1], Number(m[2]));
    }
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.model$/i.test(name)) continue;
    const text = dec.decode(bytes);
    if (!/paint_color=|mmu_segmentation=/.test(text)) continue;
    anyPaint = true;
    for (const om of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const body = om[2];
      if (!/paint_color=|mmu_segmentation=/.test(body)) continue;
      const id = om[1].match(/\bid="(\d+)"/)?.[1] ?? '';
      const verts: number[] = [];
      for (const v of body.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) verts.push(+v[1], +v[2], +v[3]);
      const tris = new Map<string, number>();
      for (const t of body.matchAll(/<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"([^>]*)>/g)) {
        const p = t[4].match(/(?:paint_color|mmu_segmentation)="([0-9A-Fa-f]+)"/);
        if (!p) continue;
        const state = decodePaint(p[1]);
        if (!state) continue;
        tris.set(triKey(verts, +t[1], +t[2], +t[3]), state);
      }
      objects.push({ tris, objectFilament: objectFilament.get(id) ?? 1 });
    }
  }
  // Bambu keeps the object extruder per build object, not per mesh object: use the first one found.
  const defaultFilament = objectFilament.size ? [...objectFilament.values()][0] : 1;
  return anyPaint ? { objects, colours, defaultFilament } : null;
}

const r5 = (x: number) => Math.round(x * 1e4);
function triKey(p: ArrayLike<number>, a: number, b: number, c: number) {
  const k = [a, b, c].map((v) => `${r5(p[v * 3])},${r5(p[v * 3 + 1])},${r5(p[v * 3 + 2])}`);
  k.sort();
  return k.join('|');
}

/** Colours painted triangles of a loaded 3MF. Returns the number of painted triangles found. */
export function applyPaint3MF(root: THREE.Object3D, data: ArrayBuffer): number {
  let info: ReturnType<typeof readPaint>;
  try { info = readPaint(data); } catch { return 0; }
  if (!info) return 0;
  const all = new Map<string, number>();
  for (const o of info.objects) for (const [k, s] of o.tris) all.set(k, s);
  // Pure black filament would render as a flat silhouette with no shading: lift it to a very dark grey.
  const colour = (filament: number) => {
    const c = new THREE.Color(info!.colours[filament - 1] || FALLBACK[(filament - 1) % FALLBACK.length]);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum < 0.012) c.lerp(new THREE.Color(0.012, 0.012, 0.012), 1 - lum / 0.012);
    return c;
  };
  const base = colour(info.defaultFilament);
  let painted = 0;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const g0 = o.geometry as THREE.BufferGeometry;
    const g = g0.index ? g0.toNonIndexed() : g0;
    const pos = g.attributes.position;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    let hits = 0;
    const c = new THREE.Color();
    for (let t = 0; t < n / 3; t++) {
      const key = triKey(pos.array as ArrayLike<number>, 3 * t, 3 * t + 1, 3 * t + 2);
      const state = all.get(key);
      if (state) { c.copy(colour(state)); hits++; } else c.copy(base);
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (3 * t + k) * 3);
    }
    if (!hits) return;
    painted += hits;
    // Vertex colours are linear; the filament hex codes are sRGB like every colour picker.
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    o.geometry = g;
    const fix = (m: any) => { const x = m.clone(); x.vertexColors = true; if (x.color) x.color.set(0xffffff); return x; };
    o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
    o.userData.paintReady = true;
    o.userData.filamentPaint = true;
  });
  return painted;
}

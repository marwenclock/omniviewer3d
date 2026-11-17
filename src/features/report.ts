import * as THREE from 'three';
import { ctx, escHtml } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { download } from '../exporters';
import { fmtNum, fmtInt, UNITS } from '../stats';
import { icon } from '../icons';
import type { ViewName } from '../viewer';

// ------------------------------------------------------------------ orthographic captures
interface ViewShot { name: string; view: ViewName; url: string; w: number; h: number; project: (p: THREE.Vector3) => { x: number; y: number }; box: THREE.Box3 }

/** Renders orthographic views with edges on a white background, then puts the camera and look back exactly. */
async function captureViews(views: ViewName[], w = 900, h = 700): Promise<ViewShot[]> {
  const v = ctx.viewer;
  if (!v.model) return [];
  const prev = { pos: v.camera.position.clone(), target: v.controls.target.clone(), proj: v.camera === v.ortho ? 'orthographic' : 'perspective', edges: v.showEdges, bg: v.background, mode: v.displayMode, grid: v.showGrid };
  const shots: ViewShot[] = [];
  try {
    v.setProjection('orthographic');
    v.setEdges(true);
    v.setDisplayMode('shaded');
    v.setGrid(false);
    v.setBackground('#ffffff');
    const box = v.bounds();
    for (const view of views) {
      v.fit(v.model, view);
      v.ortho.updateMatrixWorld(); v.ortho.updateProjectionMatrix();
      // The screenshot keeps the on-screen framing and widens it to the image's aspect ratio; mirror that here.
      const cw = v.container.clientWidth || 1, ch = v.container.clientHeight || 1;
      const sx = (cw / ch) / (w / h);
      const url = v.screenshot(1, false, false, { width: w, height: h });
      const cam = v.ortho.clone();
      cam.updateMatrixWorld();
      shots.push({
        name: view[0].toUpperCase() + view.slice(1), view, url, w, h, box: box.clone(),
        project: (p) => {
          const n = p.clone().project(cam);
          const nx = sx < 1 ? n.x * sx : n.x, ny = sx > 1 ? n.y / sx : n.y;
          return { x: ((nx + 1) / 2) * w, y: ((1 - ny) / 2) * h };
        },
      });
    }
  } finally {
    v.setBackground(prev.bg || '#151515');
    v.setEdges(prev.edges);
    v.setDisplayMode(prev.mode);
    v.setGrid(prev.grid);
    v.setProjection(prev.proj as any);
    v.camera.position.copy(prev.pos); v.controls.target.copy(prev.target); v.controls.update();
    v.requestRender();
  }
  return shots;
}

// ------------------------------------------------------------------ technical drawing (3 views + dimensions)
let angle: 'third' | 'first' = 'third';

/** A drawing sheet: front, top and right views with overall dimensions and a title block (SVG). */
export async function buildDrawing(title: string): Promise<string> {
  const shots = await captureViews(['front', 'top', 'right'], 640, 480);
  if (!shots.length) throw new Error('Open a model first');
  const [front, top, right] = shots;
  const box = front.box;
  const size = box.getSize(new THREE.Vector3());
  const u = ctx.dispUnitShort();
  const D = (v: number) => `${fmtNum(ctx.toDisp(v), 2)} ${u}`;
  const W = 1400, H = 990, cell = { w: 640, h: 480 };
  // Third angle: top above front, right to the right. First angle: top below, right on the left.
  const pos = angle === 'third'
    ? { front: { x: 40, y: 470 }, top: { x: 40, y: -20 }, right: { x: 700, y: 470 } }
    : { front: { x: 700, y: 20 }, top: { x: 700, y: 500 }, right: { x: 40, y: 20 } };
  const dimLine = (s: ViewShot, at: { x: number; y: number }, a: THREE.Vector3, b: THREE.Vector3, text: string, off: number, vertical = false) => {
    const p = s.project(a), q = s.project(b);
    const x1 = at.x + p.x, y1 = at.y + p.y, x2 = at.x + q.x, y2 = at.y + q.y;
    if (!vertical) {
      const y = Math.max(y1, y2) + off;
      return `<g class="dim"><line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y + 6}"/><line x1="${x2}" y1="${y2}" x2="${x2}" y2="${y + 6}"/>
        <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-start="url(#arr)" marker-end="url(#arr)"/><text x="${(x1 + x2) / 2}" y="${y - 6}" text-anchor="middle">${text}</text></g>`;
    }
    const x = Math.max(x1, x2) + off;
    return `<g class="dim"><line x1="${x1}" y1="${y1}" x2="${x + 6}" y2="${y1}"/><line x1="${x2}" y1="${y2}" x2="${x + 6}" y2="${y2}"/>
      <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" marker-start="url(#arr)" marker-end="url(#arr)"/><text x="${x + 8}" y="${(y1 + y2) / 2}" dominant-baseline="middle">${text}</text></g>`;
  };
  const { min, max } = box;
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const views = [
    { s: front, at: pos.front, dims: dimLine(front, pos.front, v3(min.x, min.y, max.z), v3(max.x, min.y, max.z), D(size.x), 24) + dimLine(front, pos.front, v3(max.x, min.y, max.z), v3(max.x, max.y, max.z), D(size.y), 24, true) },
    { s: top, at: pos.top, dims: dimLine(top, pos.top, v3(max.x, max.y, min.z), v3(max.x, max.y, max.z), D(size.z), 24, true) },
    { s: right, at: pos.right, dims: dimLine(right, pos.right, v3(max.x, min.y, max.z), v3(max.x, min.y, min.z), D(size.z), 24) },
  ];
  const date = new Date().toISOString().slice(0, 10);
  const info = ctx.unitInfo();
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist, Helvetica, Arial, sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 2 L10 5 L0 8 z" fill="#111"/></marker>
<style>.dim line{stroke:#111;stroke-width:1}.dim text{font-size:15px;fill:#111}.lab{font-size:13px;fill:#555;letter-spacing:.08em}.tb text{fill:#111}</style></defs>
<rect width="${W}" height="${H}" fill="#fff"/><rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="none" stroke="#111" stroke-width="1.5"/>
${views.map(({ s, at, dims }) => `<image x="${at.x}" y="${at.y}" width="${cell.w}" height="${cell.h}" xlink:href="${s.url}"/><text class="lab" x="${at.x + 8}" y="${at.y + 22}">${s.name.toUpperCase()}</text>${dims}`).join('\n')}
<g class="tb" transform="translate(${W - 452} ${H - 132})"><rect width="440" height="120" fill="#fff" stroke="#111"/>
<text x="12" y="28" font-size="18" font-weight="700">${escHtml(title)}</text>
<text x="12" y="52" font-size="13">Overall ${D(size.x)} × ${D(size.y)} × ${D(size.z)}</text>
<text x="12" y="72" font-size="13">Units: ${UNITS[info.display].label} · file units ${UNITS[info.unit].short} (${escHtml(info.label)})</text>
<text x="12" y="92" font-size="13">${angle === 'third' ? 'Third-angle' : 'First-angle'} projection · views not to a fixed scale · ${date}</text>
<text x="12" y="111" font-size="11" fill="#555">OMNIVIEWER by BANKASI MEDIA · from the displayed mesh, check before manufacture</text></g>
</svg>`;
}

// ------------------------------------------------------------------ inspection report (OV-101)
const opt = { images: true, drawing: true, measurements: true, fileName: false, notes: '' };

async function buildReport(): Promise<string> {
  const v = ctx.viewer;
  const s = ctx.stats();
  const caps = ctx.caps();
  const info = ctx.unitInfo();
  if (!v.model || !s) throw new Error('Open a model first');
  const u = ctx.dispUnitShort();
  const k = ctx.toDisp(1);
  const D = (x: number) => `${fmtNum(x * k, 3)} ${u}`;
  const shots = opt.images ? await captureViews(['iso', 'front', 'top', 'right'], 800, 600) : [];
  const drawing = opt.drawing && caps?.hasMesh ? await buildDrawing(opt.fileName ? ctx.modelName() : 'Model') : '';
  const missing = ctx.resources().filter((r) => r.status !== 'loaded');
  const title = opt.fileName ? ctx.modelName() : 'Model inspection';
  const check = (label: string, state: string, note: string) => `<tr><td>${label}</td><td class="st-${state.toLowerCase().replace(/\s+/g, '-')}">${state}</td><td>${note}</td></tr>`;
  const ms = ctx.measurements();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · inspection report</title>
<style>
:root{--ink:#171819;--muted:#5b5f63;--line:#d6d8da;--bg:#fafaf8}
body{font:15px/1.55 Geist,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:32px max(16px,4vw)}
main{max-width:980px;margin:auto}h1{font-size:28px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta{color:var(--muted);font-size:13px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px 6px 0;text-align:left;vertical-align:top}
td.num{font-family:"Geist Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);background:#fff}figure img{width:100%;display:block}figcaption{font-size:12px;color:var(--muted);padding:6px 8px}
.st-pass{color:#2c7a43;font-weight:600}.st-check,.st-fail{color:#b8392f;font-weight:600}.st-not-checked,.st-unknown{color:#9a6400;font-weight:600}.st-not-applicable{color:var(--muted)}
.note{color:var(--muted);font-size:13px}.svgwrap{border:1px solid var(--line);background:#fff;overflow:auto}.svgwrap svg{width:100%;height:auto;display:block}
@media print{body{background:#fff;padding:0}h2{break-after:avoid}figure,.svgwrap{break-inside:avoid}}
</style></head><body><main>
<h1>${escHtml(title)}</h1>
<p class="meta">Inspection report · ${new Date().toLocaleString()} · OMNIVIEWER ${escHtml(ctx.appVersion)} by BANKASI MEDIA · made on this device</p>
${opt.notes ? `<p>${escHtml(opt.notes)}</p>` : ''}
<h2>Size and units</h2>
<table><tr><td>Width × height × depth</td><td class="num">${D(s.size.x)} × ${D(s.size.y)} × ${D(s.size.z)}</td></tr>
<tr><td>File units</td><td>${UNITS[info.unit].label} (${escHtml(info.label)})</td></tr>
<tr><td>Shown in</td><td>${UNITS[info.display].label}</td></tr>
${caps?.volume ? `<tr><td>Surface area</td><td class="num">${fmtNum(s.area * k * k, 2)} ${u}²</td></tr><tr><td>Volume</td><td class="num">${fmtNum(s.volume * k ** 3, 2)} ${u}³${s.closed ? '' : ' (estimate: the surface is not confirmed closed)'}</td></tr>` : ''}
<tr><td>Parts</td><td class="num">${fmtInt(s.meshes)}${s.hiddenParts ? ` (+ ${s.hiddenParts} hidden, not included)` : ''}</td></tr>
<tr><td>Triangles / points</td><td class="num">${fmtInt(s.triangles)} / ${fmtInt(s.points)}</td></tr></table>
<h2>Checks</h2>
<table><tr><th>Check</th><th>Result</th><th>Note</th></tr>
${check('Units', info.source === 'declared' || info.source === 'user' || info.source === 'saved' ? 'Pass' : 'Not checked', `${escHtml(info.label)}`)}
${check('Files and textures', missing.length ? 'Check' : 'Pass', missing.length ? `${missing.length} missing or blocked` : 'Everything the model asked for was found')}
${caps?.volume ? check('Closed surface', s.closed === null ? 'Not checked' : s.closed ? 'Pass' : 'Check', s.closed === null ? 'Large mesh, check was still running' : s.closed ? 'Every edge is shared by two triangles' : 'Has holes or open edges') : check('Closed surface', 'Not applicable', caps?.isSplat ? 'Gaussian splats have no surface' : 'No triangle mesh')}
${caps?.volume ? check('Face orientation', s.invertedParts ? 'Check' : 'Pass', s.invertedParts ? `${s.invertedParts} part(s) inside-out` : 'Faces point outwards') : ''}
</table>
<p class="note">These are mesh checks. They do not cover wall thickness, overhangs, intersections between parts, tolerances or printer settings. Values come from the displayed triangle mesh; for CAD files that is an approximation of the exact surfaces.</p>
${opt.measurements && ms.length ? `<h2>Measurements</h2><table><tr><th>Name</th><th>Value</th><th>Status</th></tr>${ms.map((m) => `<tr><td>${escHtml(m.name)}</td><td class="num">${m.kind === 'circle' ? '⌀ ' : ''}${D(m.distance)}${m.angle !== null ? ` · ${fmtNum(m.angle, 2)}° between faces` : ''}</td><td>${m.stale ? 'Measured before an edit' : 'Current'}</td></tr>`).join('')}</table>` : ''}
${shots.length ? `<h2>Views</h2><div class="grid">${shots.map((sh) => `<figure><img src="${sh.url}" alt="${sh.name} view"><figcaption>${sh.name}${sh.view === 'iso' ? '' : ' (orthographic)'}</figcaption></figure>`).join('')}</div>` : ''}
${drawing ? `<h2>Drawing</h2><div class="svgwrap">${drawing.replace(/^<\?xml[^>]*>\s*/, '')}</div>` : ''}
<p class="note" style="margin-top:28px">Generated locally by OMNIVIEWER. Nothing was uploaded.${opt.fileName ? '' : ' The original file name is not included.'}</p>
</main></body></html>`;
}

registerPanel({
  id: 'report', label: 'Inspection report', icon: 'report',
  hint: 'A printable summary you can send: size, units, checks, measurements and views',
  render() {
    return `<p class="note" style="margin-top:0">Makes one HTML file that opens offline in any browser and prints well. It is created on this device.</p>
      <label class="check"><input type="checkbox" data-ropt="images" ${opt.images ? 'checked' : ''}/> Views (isometric, front, top, right)</label>
      <label class="check"><input type="checkbox" data-ropt="drawing" ${opt.drawing ? 'checked' : ''}/> Drawing with overall dimensions</label>
      <label class="check"><input type="checkbox" data-ropt="measurements" ${opt.measurements ? 'checked' : ''}/> Measurements (${ctx.measurements().length})</label>
      <label class="check"><input type="checkbox" data-ropt="fileName" ${opt.fileName ? 'checked' : ''}/> Include the file name</label>
      <div class="row"><label for="rNotes">Note</label><input type="text" id="rNotes" data-rnotes value="${escHtml(opt.notes)}" placeholder="Optional: who it is for, revision…"/></div>
      <div class="btn-row"><button class="btn-solid" data-rgo>${icon('download')}Download report</button></div>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLInputElement>('[data-ropt]').forEach((c) => c.addEventListener('change', () => { (opt as any)[c.dataset.ropt!] = c.checked; }));
    host.querySelector('[data-rnotes]')?.addEventListener('input', (e) => { opt.notes = (e.target as HTMLInputElement).value; });
    host.querySelector('[data-rgo]')?.addEventListener('click', async () => {
      ctx.setLoading('Making the report…');
      try { download(new Blob([await buildReport()], { type: 'text/html' }), `${ctx.baseFileName()}-report.html`); ctx.toast('Report saved. Open it in a browser to read or print it.'); }
      catch (e: any) { ctx.toast('Could not make the report: ' + (e?.message || e), true); }
      finally { ctx.setLoading(null); }
    });
  },
});

registerPanel({
  id: 'drawing', label: 'Technical drawing', icon: 'drawing',
  hint: 'Front, top and right views with overall dimensions, as an SVG sheet',
  render() {
    return `<div class="row" style="margin-top:0"><label>Projection</label><div class="seg"><button class="${angle === 'third' ? 'active' : ''}" data-dangle="third">Third angle</button><button class="${angle === 'first' ? 'active' : ''}" data-dangle="first">First angle</button></div></div>
      <div class="btn-row"><button class="btn-solid" data-dgo>${icon('download')}Download SVG</button><button class="chip" data-dpng>PNG</button></div>
      <p class="note">Views are rendered from the displayed mesh with edges and overall dimensions in ${ctx.dispUnitShort()}. Good for quotes and communication; check details against the original CAD before manufacture.</p>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLElement>('[data-dangle]').forEach((b) => b.addEventListener('click', () => { angle = b.dataset.dangle as any; ctx.renderDetails(); }));
    const make = async (png: boolean) => {
      ctx.setLoading('Drawing views…');
      try {
        const svg = await buildDrawing(ctx.modelName());
        if (!png) { download(new Blob([svg], { type: 'image/svg+xml' }), `${ctx.baseFileName()}-drawing.svg`); return; }
        const img = new Image(); img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); await img.decode();
        const c = document.createElement('canvas'); c.width = 2800; c.height = 1980; c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        download(c.toDataURL('image/png'), `${ctx.baseFileName()}-drawing.png`);
      } catch (e: any) { ctx.toast('Could not make the drawing: ' + (e?.message || e), true); }
      finally { ctx.setLoading(null); }
    };
    host.querySelector('[data-dgo]')?.addEventListener('click', () => make(false));
    host.querySelector('[data-dpng]')?.addEventListener('click', () => make(true));
  },
});

export function initReport() {
  const has = () => !!ctx.viewer.model;
  registerCommand(
    { id: 'report', label: 'Inspection report (HTML)…', group: 'Inspect', keywords: 'pdf print summary send dimensions checks', run: () => ctx.setTool('report'), enabled: has },
    { id: 'drawing', label: 'Technical drawing (3 views + dimensions)…', group: 'Inspect', keywords: 'blueprint orthographic sheet svg dimensions', run: () => ctx.setTool('drawing'), enabled: () => !!ctx.caps()?.hasMesh },
  );
}

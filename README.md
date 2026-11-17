# 👁 OMNIVIEWER <sub>by BANKASI<sup>MEDIA</sup></sub>

**A free, open-source, all-in-one 3D toolkit in your browser:** view, convert, scale, measure, paint and edit almost any 3D file. No ads, no accounts, no uploads: your files never leave your device.

**Live site:** https://omniviewer3d.com/

> Completely free and ad-free. To support hosting and development, donations are welcome (coming soon).

---

## Supported formats

| Import | |
| --- | --- |
| Mesh / scene | glTF, GLB, OBJ (+MTL), FBX, STL, PLY, 3MF, DAE (Collada), 3DS, USD/USDZ/USDA/USDC, OFF, AMF, VRML/WRL, VTK/VTP, LWO, KMZ, VOX, MD2 |
| CAD | STEP/STP, IGES/IGS, BREP (OpenCascade, in a background worker), 3DM (Rhino) |
| BIM | IFC |
| Gaussian splats | .splat, .ksplat, .spz, 3DGS .ply (view, measure, screenshot) |
| Point clouds & toolpaths | PCD, XYZ, PLY point clouds, G-code |
| Archives | ZIP of any of the above (with textures) |

| Export |
| --- |
| GLB, glTF, STL (binary / ASCII), OBJ, PLY, USDZ, 3MF (with units and colours), section outlines as SVG / DXF, PNG screenshots, MP4 / WebM / GIF turntables |

Drop or paste a model together with its textures, `.mtl` or `.bin` files, a whole folder, or a `.zip`. Batch convert many files into one ZIP.

## Features

**Viewing**
- Orbit / pan / zoom, 7 camera views, perspective or orthographic, clickable axis gizmo, saved camera views (also in share links)
- Shaded, flat, wireframe, X-ray, edges, grid, axes, auto-rotate, dimension arrows
- Inspect: surface normals, face orientation (flipped faces), clay matcap, UV checker, vertex colours
- Lighting: studio, soft, sunset, overcast, night, flat; gradient backdrops; ground shadow
- Section plane with solid cut faces; explode assemblies; compare two models (overlay or side by side)
- Scene tree, animations, light/dark theme, phone layout with a bottom toolbar

**Print & fix**
- Repair & printability check: open edges highlighted, non-manifold, flipped, inside-out, loose pieces; one-click repair
- Reduce polygons (meshoptimizer), hollow with a wall thickness, wall-thickness heatmap
- Cut / split into closed halves; place a face on the floor; Z-up export for slicers
- Print estimate: weight, filament length, resin volume and cost by material, infill, walls and copies
- Size details: dimensions, area, volume, watertight check; smart unit guess (remembered per file type), unit conversion, exact resize

**Measure, paint, edit**
- Measure distances, ΔX/ΔY/ΔZ, face angles, gaps, distance to a face plane, and circles/holes (diameter, radius)
- Paint with a brush (vertex colours, kept in GLB/PLY) or recolour whole parts
- Move / rotate / scale with handles or exact numbers, shapes, duplicate, mirror, materials
- 3D text (bundled Geist fonts), SVG logo extrusion, boolean combine / subtract / intersect
- Undo / redo for everything

**Ease of use**
- Command palette (Ctrl+K or /) over every tool, right-click menu, paste to open, first-visit tips
- Recent files (kept only in your browser), loading progress with cancel
- Installable app that works offline after the first visit

## Tool pages (SEO)

Every format, conversion and tool has its own landing page, generated at build time from [`scripts/seo-data.mjs`](scripts/seo-data.mjs), in English, Spanish, German, Portuguese and French ([`scripts/i18n.mjs`](scripts/i18n.mjs)): 82 pages per language, 410 in total, each with its own title, description, FAQ, structured data, hreflang links and a 1200×630 share image.

- Viewers: `/stl-viewer/`, `/step-viewer/`, `/splat-viewer/` … (27)
- Converters: `/step-to-stl/`, `/obj-to-glb/`, `/stl-to-3mf/` … (34). The export window opens with the target format ready (optionally downloads automatically).
- Tools: `/repair-stl/`, `/reduce-polygons/`, `/stl-cost-calculator/`, `/split-stl/`, `/3d-text-generator/`, `/svg-to-stl/`, `/3d-model-to-gif/`, `/batch-3d-converter/` … (20)
- Translations live under `/es/`, `/de/`, `/pt/`, `/fr/`.

Set the public address with `SITE_URL` in [`scripts/seo.mjs`](scripts/seo.mjs) or as an environment variable when building.

## Open a model from a link

```
https://omniviewer3d.com/#model=https://example.com/model.glb
```

Several files (e.g. OBJ + MTL + textures) are separated with commas. Add `&embed=1` for an embeddable, chrome-free view:

```html
<iframe src="https://omniviewer3d.com/#model=https://example.com/model.glb&embed=1" width="640" height="480" style="border:0" allowfullscreen></iframe>
```

The server hosting the file must allow cross-origin downloads (GitHub raw links, most CDNs and public cloud-storage links do).

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Open files | O |
| Fit to window | F |
| Camera views | 1 – 7 |
| Measure / Paint / Section | M / P / X |
| Move / Rotate / Scale | W / E / R |
| Hide selected | H |
| Delete / Duplicate | Del / Ctrl+D |
| Undo / Redo | Ctrl+Z / Ctrl+Y |
| Cancel tool, deselect | Esc |

## Run locally

```bash
git clone https://github.com/marwenclock/omniviewer3d.git
cd omniviewer3d
npm install
npm run dev
```

`npm run build` creates a static site in `dist/` that can be hosted anywhere (GitHub Pages, Cloudflare Pages, Netlify, any web server). Pushing to `main` deploys to omniviewer3d.com (Cloudflare) via `.github/workflows/deploy.yml`; `npm run deploy` deploys from your machine.

To switch on donations, set `donateUrl` in [`src/config.ts`](src/config.ts).

## Built with

[three.js](https://threejs.org) · [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) · [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) · [gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D) · [opentype.js](https://github.com/opentypejs/opentype.js) · [gifenc](https://github.com/mattdesl/gifenc) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade, for STEP/IGES/BREP) · [web-ifc](https://github.com/ThatOpen/engine_web-ifc) · [rhino3dm](https://github.com/mcneel/rhino3dm) · [fflate](https://github.com/101arrowz/fflate) · [Vite](https://vite.dev)

Inspired by the excellent [Online 3D Viewer](https://3dviewer.net). OMNIVIEWER is an independent project with its own code.

## Licence

MIT © BANKASI MEDIA. See [LICENSE](LICENSE). Third-party libraries keep their own licences (occt-import-js and OpenCascade are LGPL-2.1, web-ifc is MPL-2.0, rhino3dm and three.js are MIT); they are loaded unmodified.

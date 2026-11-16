# 👁 OMNIVIEWER <sub>by BANKASI<sup>MEDIA</sup></sub>

**A free, open-source, all-in-one 3D toolkit in your browser:** view, convert, scale, measure, paint and edit almost any 3D file. No ads, no accounts, no uploads: your files never leave your device.

**Live site:** https://omniviewer3d.com/

> Completely free and ad-free. To support hosting and development, donations are welcome (coming soon).

---

## Supported formats

| Import | |
| --- | --- |
| Mesh / scene | glTF, GLB, OBJ (+MTL), FBX, STL, PLY, 3MF, DAE (Collada), 3DS, USD/USDZ/USDA/USDC, OFF, AMF, VRML/WRL, VTK/VTP, LWO, KMZ, VOX, MD2 |
| CAD | STEP/STP, IGES/IGS, BREP (OpenCascade), 3DM (Rhino) |
| BIM | IFC |
| Point clouds & toolpaths | PCD, XYZ, PLY point clouds, G-code |
| Archives | ZIP of any of the above (with textures) |

| Export |
| --- |
| GLB, glTF, STL (binary and ASCII), OBJ, PLY, USDZ |

Drop a model together with its textures, `.mtl` or `.bin` files, a whole folder, or a `.zip`.

## Features

**Viewing**
- Orbit / pan / zoom, fit to window, 7 camera views, perspective or orthographic camera, clickable axis gizmo
- Display modes: shaded, flat, wireframe, X-ray, plus edge overlay, grid, axes and auto-rotate
- Y-up / Z-up switch (CAD and print files open Z-up automatically)
- Scene tree with show/hide, isolate and zoom-to-part
- Animations (glTF, FBX, Collada, MD2)
- Light and dark interface, custom background and lighting presets

**Tools**
- **Measure** point to point with corner snapping: distance, ΔX/ΔY/ΔZ, angle between faces and gap between parallel faces
- **Paint** with a brush (saved as vertex colours, kept in GLB/PLY export) or colour whole parts
- **Section plane** on X/Y/Z with flip
- **Explode** assemblies
- **Size details**: width/height/depth, vertices, triangles, materials, textures, surface area, volume and watertight check, in mm, cm, m, inches or feet
- **Scale**: scale by a factor, set an exact size (with or without keeping proportions), convert units (e.g. inches → mm)
- Screenshots at 1×, 2× or 4×, optionally with a transparent background
- Share links and embed code for models opened from a URL

**Editing (deliberately simple)**
- Move, rotate and scale with an on-screen gizmo or exact numbers (optional snapping)
- Add shapes: box, sphere, cylinder, cone, torus, capsule, icosahedron, plane, or start from an empty scene
- Duplicate, delete, rename, mirror, reset, drop to floor, centre on origin
- Edit material colour, metalness, roughness and opacity
- Undo / redo for everything

## Tool pages

Every format, conversion and tool has its own landing page (generated at build time from [`scripts/seo-data.mjs`](scripts/seo-data.mjs)), for example:

- Viewers: `/stl-viewer/`, `/step-viewer/`, `/obj-viewer/`, `/ifc-viewer/`, `/3dm-viewer/` … (26)
- Converters: `/step-to-stl/`, `/obj-to-glb/`, `/fbx-to-glb/`, `/glb-to-usdz/` … (30). The export window opens with the target format ready.
- Tools: `/convert/`, `/scale/`, `/unit-converter/`, `/measure/`, `/stl-volume-calculator/`, `/paint/`, `/editor/`

Each page has its own title, description, how-to, FAQ and structured data, plus `sitemap.xml` and `robots.txt`.
Set the public address in `SITE_URL` ([`scripts/seo.mjs`](scripts/seo.mjs)) or as an environment variable when building.

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

`npm run build` creates a static site in `dist/` that can be hosted anywhere (GitHub Pages, Cloudflare Pages, Netlify, any web server). Pushing to `main` deploys to GitHub Pages automatically via `.github/workflows/deploy.yml`.

To switch on donations, set `donateUrl` in [`src/config.ts`](src/config.ts).

## Built with

[three.js](https://threejs.org) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade, for STEP/IGES/BREP) · [web-ifc](https://github.com/ThatOpen/engine_web-ifc) · [rhino3dm](https://github.com/mcneel/rhino3dm) · [fflate](https://github.com/101arrowz/fflate) · [Vite](https://vite.dev)

Inspired by the excellent [Online 3D Viewer](https://3dviewer.net). OMNIVIEWER is an independent project with its own code.

## Licence

MIT © BANKASI MEDIA. See [LICENSE](LICENSE). Third-party libraries keep their own licences (occt-import-js and OpenCascade are LGPL-2.1, web-ifc is MPL-2.0, rhino3dm and three.js are MIT); they are loaded unmodified.

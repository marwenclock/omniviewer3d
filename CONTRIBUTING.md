# Contributing to OMNIVIEW

Thanks for helping! Bug reports, format requests and pull requests are all welcome.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # TypeScript checks
npm run build      # production build in dist/
```

## Where things live

| File | What it does |
| --- | --- |
| `src/main.ts` | App wiring: toolbar, panels, dialogs, shortcuts |
| `src/viewer.ts` | three.js scene, camera, display modes, section plane, explode, picking |
| `src/loaders.ts` | Every import format (plus `cad.ts` for STEP/IGES/BREP and `ifc.ts` for IFC) |
| `src/exporters.ts` | GLB, glTF, STL, OBJ, PLY, USDZ export |
| `src/editor.ts` | Move/rotate/scale, shapes, duplicate/delete, mirror, materials, scaling |
| `src/tools/measure.ts`, `src/tools/paint.ts` | Measure and paint tools |
| `src/stats.ts` | Dimensions, surface area, volume, watertight check, units |
| `src/history.ts` | Undo / redo |
| `src/config.ts` | Name, links and the donation URL |

## Adding a format

Add an entry to `FORMATS` and a `case` in `loadOne()` in `src/loaders.ts`. Return an `Object3D`.
Heavy engines should be imported lazily (`await import(...)`) and their WebAssembly copied by `scripts/copy-libs.mjs`.

## Guidelines

- Files must never leave the user's device. No analytics, no ads, no uploads.
- Keep the BANKASI MEDIA look: monochrome, Geist, uppercase tracked labels, hairline borders.

# Contributing to OMNIVIEWER

Thanks for helping! Bug reports, format requests and pull requests are all welcome.

## Product principles

These decide every change. A feature that breaks one of them does not ship, however useful it looks.

1. **Free, with no catch.** No paywalls, no "pro" tier, no ads, no tracking pixels, no sign-up. Donations stay optional and
   never gate a feature.
2. **Local first.** Files are opened, converted and exported on the user's device. Nothing is uploaded. Remote textures or
   models load only when the user asks for them (a link they pasted, or "Allow remote files" in Settings).
3. **No automatic telemetry.** The app does not phone home. Diagnostics exist only as text the user can read, copy and
   choose to send (Help → Report a problem).
4. **Honest numbers.** Every measurement says which unit it is in and where that unit came from (declared by the file,
   remembered, format default, guessed, chosen). Checks say what they cover and what they don't ("mesh checks passed" is
   not "printable"). Estimates are labelled as estimates, with their date and assumptions.
5. **Nothing changes silently.** Every edit is undoable, the model bar shows unsaved changes, exports show a preflight
   report of what will be lost, and destructive actions ask first.
6. **Explain, don't hide.** Controls that cannot work right now stay visible, are marked unavailable and say why.
7. **Works for everyone.** Keyboard reachable, screen-reader labelled, respects reduced motion, usable with touch, and
   the interface is translated (English, Spanish, German, French, Portuguese).
8. **The Bankasi look.** Charcoal and graphite, warm off-white, Geist and Geist Mono, hairline borders, restrained accents.
   Fonts are self-hosted; no third-party CSS or font requests.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # TypeScript checks
npm test           # export-contract tests (esbuild + node --test)
npm run build      # production build in dist/, including the 410 landing pages
```

`npm test` also runs in CI before every deploy (`.github/workflows/deploy.yml`). Pushing to `main` deploys to the live
site, so work on a branch and open a pull request.

## Where things live

| File | What it does |
| --- | --- |
| `src/main.ts` | Boot: checks for WebGL, shows the capability notice if it is missing, then loads the app |
| `src/app.ts` | App wiring: toolbar, workspaces, panels, dialogs, settings, tabs, shortcuts |
| `src/viewer.ts` | three.js scene, render-on-demand loop, camera, display modes, section, explode, screenshots |
| `src/loaders.ts` | Every import format, resource resolution, ZIP limits (plus `cad.ts` for STEP/IGES/BREP and `ifc.ts` for IFC) |
| `src/exporters.ts` | Export contract: scope, units and axes per format, preflight report, 3MF, OBJ+MTL zip |
| `src/capabilities.ts` | What the loaded content is (mesh, points, splat, toolpath) and which tools apply |
| `src/units.ts`, `src/stats.ts` | Units with provenance, dimensions, area, volume, closed-mesh check |
| `src/history.ts` | Undo / redo with transactions, a memory budget and a clean marker |
| `src/i18n.ts` | Interface translations, keyed by the English text |
| `src/features/*.ts` | Tool panels (print checks, cut, compare, turntable, prepare, report, assets, batch, views…) |
| `src/tools/measure.ts`, `src/tools/paint.ts` | Measure and paint tools |
| `scripts/seo*.mjs`, `scripts/generate-pages.mjs` | Landing pages, share images, sitemap, 404 and icons |
| `tests/*.test.ts` | Tests, bundled by `scripts/test.mjs` |
| `docs/` | Test plans and roadmap |

## Adding a format

Add an entry to `FORMATS` and a `case` in `loadOne()` in `src/loaders.ts`. Return an `Object3D`, and set
`declaredUnit` when the file states its unit. Heavy engines should be imported lazily (`await import(...)`) and their
WebAssembly copied by `scripts/copy-libs.mjs`. Add the format to `detectCapabilities` if it is not a plain mesh.

## Adding a tool panel

Register it in `src/features/index.ts`. Give it a one-line `hint`, an "applies to" line, and say what it cannot do.
Wrap every change in `history.batch()` so one Undo reverts it. Add new interface strings to `src/i18n.ts`.

## Before you open a pull request

- `npm run typecheck`, `npm test` and `npm run build` pass.
- New exports or unit handling have a test in `tests/export.test.ts`.
- Check the change on a phone-sized window and with the keyboard only.
- If it touches a principle above, say how in the description.

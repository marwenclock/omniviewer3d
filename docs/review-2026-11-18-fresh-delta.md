# OmniViewer3D: independent review of the Fresh-Delta audit (2026-11-17 package)

Reviewed 18 November 2026. I did not implement, deploy, contact anyone or change the site. I reproduced several findings myself in a local build and made read-only checks of the live home page.

## 0. Scope and evidence

### What I inspected

**Package (all 49 files, extracted to an isolated folder)**
- Markdown: `README.md`, `01-CURRENT-FINDINGS.md`, `02-AUDIT-COMPARISON.md`, `03-PRODUCT-OPPORTUNITIES.md`, `04-COVERAGE-AND-REPRODUCTION.md`, `05-PROMPT-FOR-CLAUDE.md`.
- Scripts (read, not run): `browser-check.mjs`, `dirty-test.mjs`, `dirty-test-local.mjs`, `project-test.mjs`, `project-test-local.mjs`, `workflow-check.mjs`, `compare-original.py`, `crosswalk-second.py`, `route-scan.py`.
- Machine-readable files: `browser-check.json`, `workflow-check.json`, `dirty-export(.json|-local.json)`, `project-duplicate(.json|-local.json)`, `route-summary.json`, `route-inventory.csv` (header plus sample rows, 410 rows), `original-120-crosswalk.csv` and `second-audit-crosswalk.csv` (both read in full), and `box-valid-normals.stl` (header). I did not parse the binary artifacts `dirty-export*.stl` and `duplicate-boxes*.omniproj`.
- All 21 screenshots, viewed one by one.

**Repository:** `dfeb616` (HEAD of `main`, working tree clean). I read `src/history.ts`, the relevant parts of `src/app.ts` (discard guard, export, project save/open, recents, offline info, beforeunload), `src/features/batch.ts`, `src/loaders.ts` (ZIP limits), `src/features/cut.ts`, `scripts/seo-data.mjs` (split, hollow and thickness entries), `scripts/seo.mjs:145-150`, `src/capabilities.ts`, `src/tools/measure.ts` (serialize/restore), `src/recent.ts`, `README.md`, `docs/roadmap.md`, `wrangler.jsonc`, and grepped for analytics and network calls.

**My own runs**
- `npm run typecheck` passed. `npm test` passed 12 of 12.
- Browser tests against `vite preview` of the existing `dist/`. It was built after the commit and its entry is `index-CQDPxA-7.js`, the same hash as the package's "local build". Tests ran in the Claude desktop browser pane (Chromium). Caveats: I set visibility and names through the scene graph instead of the UI, sent synthetic keyboard events, and captured downloads by patching anchor `click` in the page.
- Live site, read-only: loaded the home page twice and recorded which scripts and resources it requested. I did not load models on the live site; the live D01 and D02 runs are the package's evidence, not mine.

### What I did not inspect
The original 120-item ZIP (`recommendations.json` and its dossiers), the later audit's full text (`01-FINDINGS.md`, `03-NEW-FEATURES.md`), the CA change table, any real STEP or splat file, Firefox, real Safari or any physical phone, screen readers, external slicers or viewers, translation quality beyond one screenshot, performance, and the other 400+ routes.

### Labels used below
- **PL** = package, live run
- **PB** = package, local-build run
- **C** = my code reading
- **T** = my own test on the local build
- **LV** = my live check

---

## 1. Verdicts on D01–D10

| ID | Package claim | My verdict | Severity (package → mine) | Evidence |
|---|---|---|---|---|
| D01 | Lossy export clears the dirty marker | **Confirmed, and wider than stated** | P0 → **P0** | PL, PB, C, T |
| D02 | Project restores visibility by name | **Confirmed, and wider: names change and hierarchy grows each round trip** | P0 → **P1** (no geometry lost) | PL, PB, C, T |
| D03 | Project decompression bypasses limits | **Confirmed for entry count (bounded test); size bypass is code-confirmed only** | P1 → **P2** (local file, freeze not exfiltration) | C, T |
| D04 | Batch retry mixes old outputs | **Confirmed at runtime (mislabelled ZIP)** | P1 → **P2** | C, T |
| D05 | Landing copy contradicts the tools | **Confirmed, and the same claims are in in-app hints in all five languages** | P1 → **P1** | C, package screenshots |
| D06 | Splat and conversion promises | **Confirmed in source**; no splat file tested | P2 → P2 | C |
| D07 | First-use privacy and offline | **Confirmed; recents store full file blobs (up to 250 MB) and are on by default** | P2 → P2 (owner call; see change 8) | C |
| D08 | Phone onboarding overlay | Agree as a hypothesis; emulation only | P2 → P3 | screenshots |
| D09 | Validation debt | Agree; the roadmap itself says nothing has been tested outside Chromium | P1 → P1 | docs, tests |
| D10 | Disclose uncertainty | Agree; partly implemented already | P2 → P2 | C, screenshots |

### D01: lossy export clears the unsaved marker (confirmed, P0)

- **Reproduction (T).** Add a box and a sphere, then Export → STL. The preflight lists "Lost: materials and colours, part structure". After download, `history.dirty` goes from true to false and `#mbDirty` is hidden. This matches PL and PB exactly.
- **Root cause (C).** `src/app.ts:2159` calls `history.markClean()` unconditionally in `runExport`. That covers every format, every scope (visible, all, selected) and single-part export from the context menu. `confirmDiscard()` (`app.ts:226`) and `beforeunload` (`app.ts:2514`) both trust `history.dirty`, so both guards switch off.
- **Aggravating findings (C).**
  - The discard dialog (`app.ts:228-233`) offers **"Export changes"** but not **"Save project"**, even though the project is the only lossless path. It actively steers people toward the lossy action that then clears the guard.
  - Measurements, measurement renames and saved views never call `history`. The only history users I found are paint, assets, build, cut, geom, print, units and recipes. So a session whose only work is measurements or views is never dirty, although `.omniproj` would preserve that work. I confirmed this in code only; I did not run it.
- **Impact.** Local-first means no server copy. Someone who edits, exports an STL and closes the tab loses materials, structure, measurements and edits without a warning.
- **Fix direction.** Split the state into "project dirty" (anything a project would save) and "last export" (format, scope, losses). Only a project save, or an export whose preflight reports no losses, all parts in scope and a defined round-trip contract, clears project dirty. Add "Save project" as the primary action in the discard dialog. Route measurement and view changes through a lightweight "document changed" signal; they don't need to be undoable.
- **Tradeoff.** Users who only convert will see more close warnings. Soften this with wording such as "Exported STL at 14:02. Materials, parts and measurements exist only in this tab. [Save project] [Close anyway]". Don't add a modal for each export.
- **Acceptance.** For each scope (visible, all, selected, single part) × each lossy format: after export, `dirty` stays true and the close and replace guards fire. Project save clears it. Adding, removing or renaming a measurement, or saving a view, sets dirty. Undo back to the saved state clears it. Tab switching keeps each document's state.

### D02: project fidelity on save and reopen (confirmed, P1)

- **Reproduction (T), scene:** Box (x=17, visible), Box (hidden), unnamed sphere (hidden), unnamed cylinder (visible). After save and reopen:

  | Before | After |
  |---|---|
  | `Box` visible | `Box` **hidden** |
  | `Box` hidden | `Box_1` **visible** |
  | `''` hidden | `mesh_2` **visible** (hidden state lost) |
  | `''` visible | `mesh_3` visible |

- **New: the hierarchy grows on every round trip (T).**
  - Before: `Untitled scene > parts`.
  - After round 1: `AuxScene > Untitled_scene > Untitled_scene_1 > parts`.
  - After round 3: seven wrapper levels, with duplicate names `AuxScene_1` and `AuxScene_2` at different depths.
  - File size grows slightly each round (30,205 → 30,235 → 30,247 bytes).
  - The package screenshot `project-duplicate.png` already shows the `AuxScene` root, but the package didn't call it out.
- **Root cause (C).**
  - `saveProject` (`app.ts:2614-2633`) stores `hidden` as a list of `o.name`. GLTFExporter/GLTFLoader then make names unique (`Box_1`) and give names to unnamed nodes (`mesh_N`), so name lookup misses or hits the wrong part.
  - Exporting a non-Scene root wraps it in an `AuxScene`. On reopen, the loaded scene becomes the model root and is wrapped again on the next save.
- **What survives.** Geometry, positions and world-space measurements (`measure.ts:284` stores points, not part references). A "Box" primitive comes back as plain `BufferGeometry`, which is expected.
- **Impact.** CAD assemblies routinely repeat names ("Bolt", "Washer") and contain unnamed nodes. Hidden or visible state comes back wrong, part names change silently, and the parts tree grows deeper each session, which leaks into GLB and 3MF exports.
- **Fix direction.**
  - Give each node a stable id at save time (for example in `node.extras.ovId` or a parallel manifest array in traversal order) and restore visibility, names, and later per-part metadata by id.
  - Export the model's children under one known root and unwrap on load, so the depth is the same after every round trip.
  - Keep original names in extras and restore them after the loader renames.
  - Legacy v1 projects: fall back to name matching and warn when names are ambiguous.
- **Acceptance.** Duplicate names, blank names, nested groups, hidden parent with visible child (and the reverse), renamed parts, and three consecutive round trips must give identical tree depth, names, visibility and transforms. A v1 project still opens with a visible ambiguity note.

### D03: project archive handling (confirmed, P2)

- **Reproduction (T), bounded.** I hand-built stored-entry ZIPs:
  - **25,000 empty entries.** The generic ZIP path rejects anything over 20,000 entries (`ZIP_LIMITS`, `loaders.ts:81`). The `.omniproj` path decompressed all of them and failed only at the manifest check ("This is not an OMNIVIEWER project file").
  - **Missing `project.json`:** the error was "Unexpected end of JSON input".
  - **Corrupt JSON:** the raw `JSON.parse` message.
  - **Missing `scene.glb`:** "t.glb: "undefined" is not valid JSON", then **"Cannot read properties of undefined (reading 'short')"**.
- **Root cause (C).**
  - `maybeOpenProject` (`app.ts:2635-2663`) calls `unzipSync` on the whole file with no filter, and nothing validates the schema.
  - It checks `if (!viewer.model) return true` after `openFiles`. When the new GLB fails, the **previous** model is still present, so the code goes on to apply the broken project's name, axis, unit, camera and hidden list to the old scene. The second error above fits `setFileUnit(undefined)` running against the old scene. The tree stayed unchanged in my test, but I couldn't fully see the state mutation from the header, so treat it as plausible.
- **Severity, challenged.** P2, not P1: the user has to open a hostile file themselves, and the outcome is a frozen tab or a mis-set scene, not data leaving the device. Note that even the generic limit of 2 GB expanded is high for a phone tab.
- **Fix direction.**
  - Allow-list the entries (`project.json`, `scene.glb`) and give each a size cap (for example manifest under 1 MB, scene under the generic cap).
  - Read the ZIP directory before decompressing, in a worker.
  - Validate the schema: types of `hidden`, `unit`, `up`, `version`.
  - Load into a staging scene and swap only after success. Otherwise leave the old scene and its state untouched.
  - Show human errors ("This project is incomplete: scene.glb is missing").
- **Acceptance.** Fixtures for too many entries, oversize entries, unexpected entries, missing or duplicate entries, corrupt JSON, wrong field types, a newer version and a truncated GLB each give one plain-language error. The previous scene, name, units and camera stay byte-identical.

### D04: batch retry after a configuration change (confirmed, P2)

- **Reproduction (T).** good.stl plus a corrupt bad.glb, target STL → `converted-stl.zip` containing good.stl and the report. Then switch the target to **OBJ** and press "Retry failed". The result is `converted-obj.zip` with a report headed **"Target: OBJ"** that contains **good.stl** and no OBJ. If the retry had succeeded, the ZIP would have held a mix of STL and OBJ; that follows from the same code but I didn't run it.
- **Root cause (C).**
  - `outputs` is created once per dialog (`batch.ts:71`).
  - Retry processes only jobs whose status isn't `done` (`:127`).
  - Target, Z-up and image size are re-read on every run (`:120-125`).
- **Related, new (C).** The report doesn't record each file's guessed unit or its source. `guessUnit` is applied silently, with no way to confirm, so an inch STL in a batch is written as millimetres without a trace.
- **Fix direction.**
  - Freeze settings per run and show them.
  - If settings change, mark finished jobs as "done for STL" and offer either "Convert all to OBJ" or "Retry failed with the original settings".
  - Report lines record source file → output, target, unit and where it came from (declared, guessed, user), axis change and warnings.
- **Acceptance.** Fail, change format, retry: no ZIP ever mixes targets under one label. Cancel, then resume: the manifest stays truthful. The report lists the unit and its source for every file.

### D05: unsupported geometry promises (confirmed and extended, P1)

- **Confirmed in landing copy (C).** `scripts/seo-data.mjs:276-278` promises that split halves are "watertight and printable", against the re-check toast in `cut.ts:190-193`. `:292` promises an "even wall thickness", against the panel's own "Approximate" caveat. `:302` says thickness is measured "from every point of the surface", against the panel's "sampled … from each vertex".
- **New (C, plus package screenshots).** The same claims appear **inside the app**:
  - Split hint `cut.ts:247`: "both halves are closed with a flat face". The split panel itself says "Each half gets a flat face and is checked afterwards".
  - Hollow hint `print.ts:272`: "even wall".
  - Both hints are translated into es, de, fr and pt (`i18n.ts:210`, `:217`).
  - So `split-loaded.png` and `hollow-loaded.png` show the claim and the caveat on the same screen.
- **Also.** The hollow landing page says "add drain holes in your slicer", but the app now has a drain-hole tool.
- **Note.** `docs/roadmap.md` lists "Honest wording in checks, estimates and landing pages" as done. That is only partly true.
- **Acceptance.** A CI check that fails when generated or in-app strings contain absolute claims ("watertight", "even", "every point", "real size kept") for a tool whose capability entry is marked approximate. The check covers all five languages and page metadata.

### D06: splat and conversion claims (confirmed in source, P2)
- `README.md:18` says splats can be "view, measure, screenshot". `capabilities.ts:49` sets `pickable: !has('splat')`, so measuring is impossible.
- The converter template `seo.mjs:148` says "with the real size kept" without exception, but unitless inputs (STL, OBJ, PLY) depend on a guess or on the user's confirmation.
- Fix: generate the README format table and converter wording from `capabilities.ts`, and mention unit confirmation for unitless sources.
- Not tested with a real splat file.

### D07: local retention and offline (confirmed, P2, owner decision)
- **Recents (C).** `rememberRecents` defaults to on (`app.ts:50`). Every local open stores the **full file blobs** in IndexedDB (`recent.ts`, up to 10 entries / 250 MB), plus a thumbnail.
- **Disclosure.** It exists ("How files and local storage work", a Settings clear button), but there is no notice at the moment a file is first kept. On a shared or work computer, a confidential CAD model stays in the browser.
- **Offline readiness (C).** It is real, but approximate: "Mesh viewer ✓" means any `/assets/` file is cached, not that every chunk is.
- **Recommendation.** Either default to "remember names and thumbnails only, ask before keeping file contents", or show a one-time quiet notice the first time a file is kept, with "Don't keep files" next to it.

### D08: phone onboarding (agree as hypothesis, P3)
- `chromium-390-loaded.png` shows the Quick-tips card covering roughly a third of the model, with a toast on top of it.
- This is desktop emulation, and the code shows different tips for coarse pointers.
- Prototype a one-line dismissible hint above the bottom bar and test it on real phones.

### D09: validation debt (agree, P1)
- Tests cover only the export contract.
- `docs/roadmap.md` "Next #1" says: "Nothing on this branch has been tested outside Chromium yet."
- **Unflagged evidence gap.** In `webkit-1440-loaded.png` and `webkit-390-loaded.png`, **the viewport is empty**: no model, grid or axis gizmo, while the panel reports 12 triangles. The WebKit home page does render the sample preview (`webkit-1440-home.png`). So "WebKit loaded a model" is backed only by DOM state, not by rendering. It may be a headless-WebKit artefact or a real Safari rendering bug. **Treat it as a P1 item to check on real Safari before anything else on that platform.**

### D10: uncertainty in results (agree, partly implemented, P2)
- Already present: the cut re-check toast, the hollow "Approximate" note, the thickness vertex-sampling caveat and the "grey ≠ safe" toast, and capability messages.
- Still missing: those caveats and the scope (which parts, sampled versus exact) don't travel into the report, the export preflight or copied numbers.

---

## 2. New findings not in the package

| N | Finding | Evidence | Severity |
|---|---|---|---|
| **N1** | **The live site injects Cloudflare Web Analytics (RUM).** The home page loads `https://static.cloudflareinsights.com/beacon.min.js/…` and sends a request to `https://omniviewer3d.com/cdn-cgi/rum?`. The beacon isn't in the repo or `dist/` (grep found nothing), so it is edge-injected, most likely Cloudflare Web Analytics automatic setup or RUM on the zone. This contradicts README.md:7 ("no automatic telemetry"), the in-app privacy text `docs.ts:25` ("It sends no analytics"), and the roadmap's rejection of OV-094. Cloudflare's beacon is cookieless and doesn't see model files, but it is still automatic third-party telemetry. | LV (two loads), C | **P0 trust**; fix is a dashboard setting, no code |
| N2 | Project round trips add two wrapper levels each time (see D02) | T | P1 (with D02) |
| N3 | Unnamed hidden parts lose their hidden state; all unnamed or duplicate parts are renamed (`mesh_N`, `Box_1`) | T | P1 (with D02) |
| N4 | The discard dialog offers "Export changes" but no "Save project" | C | P1 (with D01) |
| N5 | Measurements and saved views don't mark the document dirty | C | P2 (with D01) |
| N6 | A failed project open applies manifest fields to the previously open scene | C, partly T | P2 (with D03) |
| N7 | Errors are raw engine messages: "Unexpected token '\u0001' … is not valid JSON" for a corrupt GLB in batch, "Cannot read properties of undefined" when opening a project | T | P2 |
| N8 | In-app hints repeat the D05 claims in all five languages | C | P1 (with D05) |
| N9 | Runtime localisation is incomplete: on `/es/stl-viewer/` the panel mixes Spanish with English ("Use for all .stl files", "To keep the size and change the numbers, use Rescale below.", "whole model", "Scale by", "Set size", "Quick tips") | `spanish-stl-loaded.png` | P2 |
| N10 | No rendered model in either WebKit screenshot (see D09) | package screenshots | P1 to investigate |
| N11 | The batch report has no unit or unit-source per file | C | P2 (with D04) |
| N12 | The roadmap attributes compare to OV-108 (which is AR; compare is OV-099/100) | docs | trivial |

---

## 3. One deduplicated change list

Each item maps to the IDs it absorbs. Status: **F** = fixed or substantially implemented (as far as I checked), **R** = current residual, **N** = new candidate, **U** = unknown or unreviewed. Implement each item once, not once per ID.

### Fixed or substantially implemented (residuals noted)
These come from what I actually saw in code, tests or screenshots. "Substantially" means acceptance criteria are not fully proven.

1. **Export contract: units, axes, scope, preflight, 3MF units and colours, non-Latin filenames.** OV-001, OV-004, OV-016, OV-019, OV-020, OV-077, OVN-25, F08 (partial). Status **F**: 12 tests pass. Residual: external round trips (change 12) and the D01 save semantics.
2. **WebGL fallback.** OV-006, OVN-22 (part). Status **F** (package screenshot `no-webgl.png`).
3. **Undo with transactions, memory budget, dirty marker and guards.** OV-002, OV-042, OV-090, OV-003. Status **F**, with the D01 residual.
4. **Generic ZIP limits and path-preserving archives.** OV-011, OV-014. Status **F** for generic import; the project path is change 3.
5. **Capability gating for splats, points and toolpaths.** OV-028, OV-073. Status **F** in code; copy residual in change 6.
6. **Honest in-panel wording for thickness, hollow and the cut re-check.** OV-021, OV-023, OV-024, OV-025. Status **F** in panels; residuals in changes 5 and 11.
7. **Workspaces, model bar, responsive toolbar and phone bottom bar.** OV-031, OV-032, OV-033, OV-035, OV-039, OV-064. Status **F**, seen in screenshots; accessibility and devices still unverified.
8. **Welcome screen with drop zone, built-in sample and example list.** OV-043, OV-046, F24, OVN-16 (part). Status **F**.
9. **Offline readiness panel and release-stamped service worker.** OV-082, F28 (part), OVN-08 (part). Status **F**, approximate.
10. **Project format `.omniproj`.** OV-085, F23, OVN-35 (part). Status partial; changes 2 and 3 apply.
11. **Batch queue, retry and report.** OV-017, OV-018, F15. Status partial; change 4 applies.
12. **Measurement persistence (project and JSON export), stale flags.** OV-102, F02 (part), OVN-32 (part). Status **F** for storage; no measurement sets in the report yet.

### Current residuals (what to do)
1. **Save semantics and the dirty model.** D01, N4, N5. Maps to OV-003, OV-085, OVN-13, F04. **R, P0.**
2. **Project fidelity: stable ids, names, visibility, no wrapper growth.** D02, N2, N3. Maps to OV-085, OVN-35, F23. **R, P1.**
3. **Project open hardening: limits, schema, staged swap, readable errors.** D03, N6. Maps to OV-014, OV-086, OV-050. **R, P2.**
4. **Batch: frozen runs and a truthful manifest with unit provenance.** D04, N11. Maps to OV-017, OV-018, OVN-05, F15. **R, P2.**
5. **Geometry claims in landing pages, in-app hints and every translation, plus a CI copy check.** D05, N8. Maps to OV-021, OV-023, OV-024, OV-079, OVN-01, OVN-02, OVN-03, OVN-20. **R, P1.**
6. **README, format table and converter copy generated from capabilities and unit provenance.** D06. Maps to OV-028, OV-073, OV-079, OVN-04, OVN-05, OVN-19, F07. **R, P2.**
7. **Turn off edge analytics, and add a release check that the live HTML loads no third-party scripts.** N1. Maps to OV-094 (rejected), OV-117, OVN-43. **R, P0.**
8. **Local retention defaults and network disclosure.** D07. Maps to OV-047, OV-048, OV-013, OVN-06, OVN-07, OVN-08, F28. **R, P2.**
9. **Finish runtime localisation, then native-speaker review.** N9. Maps to OV-074, OV-075, OVN-20, OVN-42. **R, P2.**
10. **Readable errors everywhere: loaders, batch, project.** N7. Maps to OV-050, OVN-12, OVN-22. **R, P2.**
11. **Carry uncertainty and scope into reports, preflight and copied values.** D10. Maps to OV-021 to OV-026, OVN-11, F18 (part). **R, P2.**
12. **Validation: real Safari (first, because of N10), Android, screen readers, external round trips, regression tests for project, dirty state and batch.** D09, N10. Maps to OV-066, OV-093, OV-119, OVN-09, OVN-37, OVN-41. **R, P1.**
13. **Phone first-use hint footprint.** D08. Maps to OV-043, OV-049, OV-061, OVN-17, OVN-27. **R, P3.**

### Genuinely new or extended candidates
1. **Save receipt.** After a save or export, a quiet line: "Project saved" or "Exported STL: materials, parts and 3 measurements not included [Save project]". New, from D01; it delivers change R1, not a second preflight. **N.**
2. **Project restore summary.** On open: object count, hidden count, units, measurements, and ambiguity warnings for v1 files. Depends on R2. **N.**
3. **Opt-in local recovery journal.** An autosave snapshot in IndexedDB, off by default, shown as "Recover last session?". Extends F04 and OVN-13. It conflicts with D07's minimal-retention stance, which is why it should be opt-in. **N, defer.**
4. **Precision provenance on measurements:** tessellated CAD surface, mesh vertex, or guessed unit. Extends OV-007, OV-102, OV-103, F27. **N.**
5. **Versioned fixture scenes** that double as compatibility samples and regression inputs. Extends OV-046, OV-093. **N** (they help R12).
6. **Guided prepare-for-print as a recipe chain** (repair → orient → bed fit → export), not a new workspace. OV-109, F01, roadmap "Later". **Extension.**
7. **Measurement sets and compare overlays in the existing report.** OV-099 to OV-102, F02, F05, F09, F10, F14. **Extension**, after R2.
8. **User-initiated offline prefetch per engine**, with sizes. OV-082, F28. **Extension.**

### Unknown or unreviewed (said plainly)
- **About 95 of the 120 OV IDs were not individually verified.** I relied on the package's pointer CSV, which only says where an ID is cited. The CSV marks 11 IDs as having no citation (OV-010, 051, 055, 056, 063, 066, 070, 081, 086, 093, 117); their status is unknown, not missing.
- **OVN not checked individually:** OVN-10, 14, 15, 18, 21, 23, 28-31, 33, 34, 36, 38-40.
- **F items not checked against current UI:** F06, F11-F13, F16, F17, F19-F22, F25, F26, F29, F30.
- **Reject or park:** F31 (collaboration), F32 (plugin or scripting API).
- The CA change table was not available to me.

---

## 4. Ranked recommendations for the owner

Value is weighed against reliability, privacy, accessibility, effort and maintenance.

| Rank | Change | Why it ranks here | Effort |
|---|---|---|---|
| 1 | **R7: disable edge analytics** | Directly contradicts a public promise and the in-app text; one dashboard toggle | XS |
| 2 | **R1: save semantics and "Save project" in the discard dialog** | Prevents silent loss; the core trust promise of a local-first tool | S–M |
| 3 | **R2: project identity and stable hierarchy** | The project format is otherwise unreliable for real assemblies; the gap grows with every session | M |
| 4 | **R12a: real Safari smoke test (iPhone and Mac)** | N10 could mean the model doesn't render for every Safari user; cheap to rule out | S |
| 5 | **R5: claims, hints and translations, plus a CI check** | Trust and SEO honesty; mostly string work, and the check stops it coming back | S |
| 6 | **R3: project open hardening** | Robustness; reuse the existing ZIP limiter | S |
| 7 | **R4: batch freeze and manifest** | Small change that makes batch output trustworthy | S |
| 8 | **R8: recents default** | Privacy on shared machines; a product decision more than code | XS–S |
| 9 | **R10 and R9: readable errors, finished localisation** | Polish that every non-English or unlucky user hits | M |
| 10 | **N1 save receipt, then N2 restore summary** | The first visible features built on the reliability fixes | S each |
| 11 | **Extension 6 (guided print recipe) and 7 (report integration)** | Highest-value features; the pieces already exist | M |

**Partly implemented ideas that the later audit presented as new:**
- F02, F03, F15, F23, F24 and F28: the foundations exist, and only the residuals above remain.
- F01: recipes exist; the chained guide does not.
- F05 and F14: compare exists with alignment and a heatmap; what remains is report integration plus an accuracy check of the alignment.

---

## 5. Design direction (desktop and phone)

Keep what works. The screenshots show a strong, model-first dark workspace with a monochrome palette and a quiet "by BANKASI MEDIA". Refine it rather than adding surfaces.

- **Canvas first.** The viewport owns the centre at every width. Panels sit at the edges, are resizable on desktop, and become sheets on phones. Tool hints sit in one fixed slot (the top-centre pill already used) and never overlap the model in the middle. Toasts move to a corner stack that never covers the bottom bar or the tips card (in the screenshots, toasts overlap both).
- **One place for document state.** The model bar already has name, format and unit. Add a compact state chip next to the name: "Saved project" / "Unsaved" / "Exported STL · not a project". This is where the save receipt (N1) appears. Don't add a second toolbar.
- **Instrument typography.** Monospace numbers for measured values (already used), always with a unit, and a small provenance glyph where relevant (N4). Hints stay sentence case. Keep display type (the "Every 3D file." hero) on the welcome and landing pages only.
- **Selection and state without colour.** Selection outline plus a label chip. Hidden parts get a crossed-eye icon in the tree and a count pill (already present). Results use icon plus text plus colour: "Thin", "Not checked", "OK in sampled area". Never a lone green.
- **Workspaces stay four** (View, Inspect, Prepare, Present). Guided print lives inside Prepare as a stepper, not as a fifth workspace. Compare and report live in Inspect.
- **Phone.** The entry screen offers Open plus Try sample, with the existing small preview at reduced height. After load: model plus the bottom bar (Open, Parts, Measure, Tools, Export, Details) plus a one-line dismissible hint. Active tools show a top "Done" bar (exists) and keep Undo reachable. Validate safe areas, the file picker and long-press on real devices.
- **Brand.** Keep the wordmark small and the "by BANKASI MEDIA" endorsement in the header on welcome and landing pages. In the working UI, only the footer "© BANKASI MEDIA · Free & open source · No ads". No colour accent beyond the existing restrained one.
- **Accessibility as a definition of done.** Every icon button has a name. The tree uses roving tabindex (OV-054 cited in code; not verified). Dialogs have labels (the export dialog has `dlgTitle`). Numeric camera and transform input exists (Position, Rotation and Scale fields seen). Respect reduced motion. Verify with NVDA, VoiceOver and keyboard-only passes (Phase B below).

---

## 6. Phased acceptance tests

None of these needs ads, accounts or automatic telemetry. Device and user feedback is collected by people who opt in, and fixtures are synthetic or licensed.

### Phase A: reliability gates (automated, before any new feature)
1. **Dirty state.** For each format × scope (visible, all, selected, part), with lossy and lossless cases: export keeps or clears `dirty` according to the contract. Measurement add, rename, delete and saved views set dirty. Undo back to the clean point clears it. The discard dialog offers Save project. `beforeunload` fires when expected. Each document tab tracks its own state.
2. **Project fidelity.** Duplicate names, blank names, nested groups, hidden parent and child combinations, rename, three consecutive round trips. Compare tree depth, names, visibility, transforms, units, camera, measurements and views exactly. Legacy v1 file opens with an ambiguity notice.
3. **Archive limits.** The fixtures listed under D03 each give a plain error with the previous scene (geometry, name, units, camera) unchanged. Time to reject is under 1 s for oversized directories.
4. **Batch.** Success plus failure, then change target, then retry: never a mixed ZIP under one label. Cancel mid-run, then resume. Report includes target, unit and its source, and axis per file.
5. **Copy consistency.** A CI script scans `seo-data.mjs`, `seo.mjs`, `README.md`, in-app hints and `i18n.ts` for absolute claims about tools marked approximate in `capabilities.ts`. It fails the build on a hit.
6. **Privacy.** On each release, load the live home page and three tool pages, and fail if any request goes to a third-party origin or `/cdn-cgi/rum`. Re-run after Cloudflare settings changes.

### Phase B: external and human validation
7. **Unit and export round trips.** STL and 3MF from mm, inch and m sources into two slicers (for example PrusaSlicer and Bambu Studio or Cura). GLB and USDZ into two viewers (for example Blender and the three.js editor, plus AR Quick Look on iOS). Record dimensions to 0.01 mm. Each mismatch becomes a test in `tests/export.test.ts`.
8. **Screen readers.** NVDA with Firefox or Chrome, and VoiceOver on macOS and iOS. Tasks: open a sample, find a part in the tree, hide it, measure, export with preflight, save a project. Pass means each task can be completed and announced without sight.
9. **Physical devices.** iPhone (current and one older iOS), iPad, Mac Safari, and a mid-range Android. Run `docs/device-test-matrix.md`, and first confirm that a loaded model actually renders in Safari (N10). Test the file picker for STL and STEP, pinch and orbit, long-press, sheets, safe areas, and a memory ceiling with a 50 MB model.
10. **Native-language review.** es and de first (roadmap), then fr and pt. Reviewers check panels, hints, errors and landing pages, including leftover English (N9).

### Phase C: product and performance
11. **Performance budget.** First load size and time-to-interactive on a mid-range Android. Memory after opening and closing ten models. Frame time with a 2M-triangle model, measured locally and recorded by hand, not by telemetry.
12. **Usability round.** Five opt-in participants (printer user, engineer, designer, BIM user, first-timer) following `docs/usability-test-plan.md`. Fix every finding that blocks a task before adding extensions.

---

## 7. Decision list

| Decision | Item |
|---|---|
| **Approve now** | R7: disable Cloudflare Web Analytics or RUM injection and add the third-party request check (N1) |
| **Approve now** | R1: save semantics, plus Save project in the discard dialog (D01, N4, N5) |
| **Approve now** | R2: stable project identity and hierarchy (D02, N2, N3) |
| **Approve now** | Real Safari smoke test for N10 |
| **Approve** | R5: claims, hints and translations, plus the CI copy check (D05, N8) |
| **Approve** | R3: project open hardening (D03, N6) |
| **Approve** | R4: batch freeze and manifest (D04, N11) |
| **Approve (owner picks the default)** | R8: recents keep file contents only after a one-time choice (D07) |
| **Approve** | R9, R10: finish localisation, readable errors |
| **Approve after Phase A** | N1 save receipt, N2 restore summary |
| **Defer** | Guided print recipe, report integration for measurements and compare, offline prefetch, provenance badges, fixture scenes, opt-in recovery journal |
| **Defer** | D08 phone hint redesign until device testing |
| **Reject** | Automatic telemetry or analytics of any kind (OV-094); accounts; a fifth workspace; a second diagnostics or import-doctor panel (F03 duplicates Files & textures) |
| **Park** | F31 collaboration, F32 plugin or scripting API |

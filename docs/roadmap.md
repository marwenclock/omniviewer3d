# Roadmap

How the 2026 audit is being sequenced. IDs refer to the audit (`OV-…`) and to the independent review's additions (`CA-…`); the code cites them in comments
(search for `OV-0`), and the review's change table has the full mapping.

## Done on the `audit-implementation` branch

**Trust and correctness**
- Export contract: one tested path for scope (visible / all), units and axes per format, a preflight report of what is
  lost, 3MF with declared units and painted colours, OBJ + MTL + textures as a zip
- Units with provenance and a separate display unit; rescale vs reinterpret, both undoable
- Undo for everything, with transactions, a memory budget and an unsaved-changes marker; in-app discard dialog and a
  leave-page guard (OV-003, OV-004, CA-06)
- Resource resolution by path, a Files & textures panel with relink, remote files blocked unless allowed, ZIP limits
- Honest wording in checks, estimates and landing pages; capability-aware pages for splats, point clouds and G-code

**Workspace and design**
- Model bar with tabs, workspaces (View / Inspect / Prepare / Present), a responsive toolbar that compacts then folds
  into a labelled Tools menu, unavailable controls that explain why
- Welcome screen with a drop zone, built-in sample, recents with thumbnails and a live preview
- Phone sheets that keep the model visible, a Done bar, tablet one-drawer rule
- Self-hosted Geist fonts, light theme pass, density setting, focus rings, reduced motion

**Reach**
- Interface translated into Spanish, German, French and Portuguese (OV-074, machine quality: needs review)
- Installable app with file handlers, icons, release-stamped offline cache; 404 page that works at any path
- Embed builder (UI level, spin, background, credit), screenshot sizes and presets, project files (`.omniproj`)

**New tools**
- Printer bed fit, overhang map, clash check, G-code layer preview (OV-105, OV-113)
- Compare with alignment, wipe slider and deviation heatmap (OV-108)
- Report and dimensioned drawing (three views, title block, first / third angle)
- Watch a file and reload on save (Chrome and Edge), View in AR on iPhone, recipes, batch product shots, drain holes
  for hollow prints (CA-12)
- Model health summary, material diagnostics, point-cloud controls, IFC storeys and properties

## Deliberately not done

| Item | Why |
| --- | --- |
| OV-094 automatic telemetry | Breaks the "no automatic telemetry" principle. Diagnostics stay user-initiated (Help → Report a problem). |
| CA-20 View / Advanced toggle | Conflicts with the workspaces (OV-033); two ways to hide tools would confuse more than help. |
| CA-21 icon redesign | A brand decision for the owner, not an engineering change. |

## Next

Ordered by risk to users, not by size.

1. **Verify on real devices.** Run `docs/device-test-matrix.md` on the tier 1 devices, especially Safari on iPhone and
   Mac (file picker, memory, AR Quick Look). Nothing on this branch has been tested outside Chromium yet.
2. **Round-trip exports in other tools.** Open exported STL / 3MF in two slicers and GLB / USDZ in two viewers; add any
   mismatch as a test in `tests/export.test.ts`.
3. **Native-speaker review of translations.** `src/i18n.ts` and `scripts/i18n.mjs` are machine quality. Prioritise
   Spanish and German (largest traffic after English).
4. **Usability round one.** Run `docs/usability-test-plan.md` with five people; fix every "blocks" finding.
5. **Performance budget.** The main bundle grew with the new tools; split rarely used panels (report, drawing, batch,
   compare) into lazy chunks and keep first load under the current size.
6. **More tests.** Units provenance, history transactions and the loaders' resource resolution are only checked by hand.
7. **Release.** Merge to `main` (this deploys), watch the error reports that users choose to send for a week, then
   announce.

## Later, if users ask

- Section views in the drawing export
- Saved measurement sets per model in the report
- More printer presets for bed fit
- A guided "prepare for print" recipe that chains repair → orient → bed fit → export

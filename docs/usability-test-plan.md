# Usability test plan

Five short moderated sessions per round tell us whether people can do the jobs the site promises, without help.
Run a round before each larger release and after any change to the welcome screen, toolbar or export flow.

## Who

Recruit five people per round, mixed across these groups:

| Group | Why they matter | Typical entry page |
| --- | --- | --- |
| Hobby 3D printing (FDM or resin) | Largest audience; units, repair and export to slicers | `/stl-viewer/`, `/repair-stl/` |
| Product or mechanical engineer | STEP files, measuring, dimensions, drawings | `/step-viewer/`, `/step-to-stl/` |
| Designer or marketer | Screenshots, turntables, embeds, product shots | `/glb-viewer/`, `/3d-model-to-gif/` |
| Architecture or BIM | IFC models, storeys, properties | `/ifc-viewer/` |
| First-time user | Has a file but no 3D experience | Home page |

At least one person per round uses a phone, and at least one uses a language other than English.

## Setup

- Their own device and browser where possible; otherwise a clean browser profile.
- Prepare files: a mm STL with no unit, an inch STL (looks tiny), a STEP assembly, a GLB with textures, an OBJ with a
  missing texture, an IFC, a 2 M-triangle scan.
- Think-aloud, 30 minutes, recorded only with consent. The moderator does not help unless someone is stuck for 2 minutes.

## Tasks

Score each task: **done unaided**, **done with a hint**, **not done**. Note time and wrong turns.

| # | Task (as told to the participant) | What it checks | Pass |
| --- | --- | --- | --- |
| 1 | "Open this file and tell me how big it is." | Open, units, dimensions | Says the right size and unit |
| 2 | "This one looks tiny. Make it the right size." (inch STL) | Unit hint, reinterpret vs rescale | Chooses inches; size is right |
| 3 | "Measure the distance between these two holes." | Measure, snapping, touch | Within 0.5 mm |
| 4 | "Convert this STEP file to STL for your slicer." | Export dialog, preflight, Z-up | Downloads STL; can say its unit |
| 5 | "Hide the cover and export only what you see." | Hide, export scope | Export leaves the cover out |
| 6 | "Is this ready to print? Fix it if not." | Repair, honest wording | Repairs; does not claim "printable" |
| 7 | "Undo everything you just did." | History, dirty state | Back to the opened state |
| 8 | "Make a picture for a shop listing." | Screenshot dialog, presets | Gets a clean PNG at a chosen size |
| 9 | "Put this model on a web page." | Share / embed builder | Copies a working iframe snippet |
| 10 | "Find the tool that makes walls thicker." (doesn't exist) | Search, honest "no result" | Gives up quickly, not confused |
| 11 | Phone: "Open, measure, then go back to looking around." | Sheets, Done bar, model stays visible | Finishes without losing the model |
| 12 | Keyboard only: "Open a sample and take a screenshot." | Focus order, skip link, dialogs | Done without a mouse |

## Questions afterwards

1. What did you expect this site to cost? Did anything make you think it would ask for money or an account?
2. Where do you think your file went when you opened it?
3. Was there a moment you weren't sure what a number or message meant?
4. What would you use this for next week, if anything?

## What to report

For each task: success rate, median time, and the top problems with a severity (blocks / slows / cosmetic). Turn every
"blocks" item into an issue before the next release. Keep the raw notes out of the repository (they can contain
personal data); keep only the summary in `docs/usability-results/`.

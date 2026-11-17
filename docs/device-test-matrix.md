# Device and browser test matrix

Automated tests cover the export contract (`npm test`). Everything below needs a real device, because WebGL drivers,
touch handling, file pickers and memory limits differ in ways an emulator does not show.

## Devices

| Tier | Device class | Browser(s) | Why |
| --- | --- | --- | --- |
| 1 | Windows laptop, integrated GPU | Chrome, Edge, Firefox | Most visitors |
| 1 | MacBook (Apple silicon) | Safari, Chrome | Safari WebGL and file handling differ |
| 1 | iPhone (recent, and one 3+ years old) | Safari | File picker, memory limits, AR Quick Look |
| 1 | Mid-range Android phone | Chrome | Touch, GPU limits, install prompt |
| 2 | iPad | Safari | Tablet layout (one drawer at a time) |
| 2 | Android tablet or Chromebook | Chrome | 700–1100 px layout, keyboard + touch |
| 2 | Low-end Windows (4 GB RAM) | Chrome | Quality ladder, large-file limits |
| 3 | Linux desktop | Firefox | Driver variety |
| 3 | Desktop with a screen reader | NVDA + Firefox, VoiceOver + Safari | Labels, tree, dialogs |

## Checks per device

Mark each **pass**, **fail** (with a note) or **n/a**.

### Opening

- [ ] Drop a file, a folder and a ZIP (desktop); the file picker accepts STL, STEP and GLB (phones)
- [ ] OBJ + MTL + textures open together; a missing texture shows in Files & textures with a relink option
- [ ] A 2 M-triangle model opens, stays interactive and shows its size; a 200 MB file shows a clear limit instead of crashing
- [ ] Loading can be cancelled and the previous model stays

### Viewing

- [ ] Orbit, pan, zoom (mouse, trackpad, touch); double-click / double-tap zooms to a part
- [ ] The canvas is never blank after opening a panel or rotating the device
- [ ] Light and dark themes; reduced motion stops the landing spin and camera animations
- [ ] The view recovers after the GPU resets (Chrome: `chrome://gpuclean`, or switch GPUs)

### Tools

- [ ] Measure with snapping; values match a known part to 0.1 mm
- [ ] Section, explode, hide/isolate, saved views
- [ ] Repair, reduce, thickness, overhang, bed fit, clash, cut, compare (wipe and deviation)
- [ ] Turntable records MP4 or WebM (and GIF), with the axis gizmo hidden
- [ ] Report and drawing open and print

### Export

- [ ] STL, 3MF, GLB, OBJ zip, USDZ download with the right name, including non-Latin names
- [ ] Exported STL opens at the right size in a slicer (PrusaSlicer, Bambu Studio or Cura)
- [ ] Exported GLB opens upright and at the right size in another viewer (for example the three.js editor or Blender)
- [ ] USDZ opens in AR Quick Look on iPhone (View in AR)

### App and offline

- [ ] Install as an app; it opens STL/GLB files from the OS (where the platform supports file handlers)
- [ ] After one visit, the app opens with the network off
- [ ] A new release replaces the old cache (check the version in About)

### Accessibility

- [ ] Every control is reachable by Tab, with a visible focus ring
- [ ] The scene tree works with arrow keys and announces names
- [ ] Dialogs trap focus and return it when closed
- [ ] Single-key shortcuts can be limited to the 3D view or turned off

## Recording results

Copy the checklist into an issue per device and release, titled like
`Device check: iPhone 13 / Safari 18 / 2026.11.17-dea150c`, so results are tied to a release.

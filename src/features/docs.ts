// In-app help centre (OV-080) and release notes (OV-118). Plain HTML, readable without WebGL, linked from errors.

const ARTICLES: { id: string; title: string; body: string }[] = [
  { id: 'missing', title: 'Textures are missing or the model is grey', body: `
    <p>Many formats keep textures in separate files: OBJ uses a <code>.mtl</code> file plus images, glTF can use a <code>.bin</code> file plus images, and FBX, DAE and 3DS often point to image files.</p>
    <ol><li>Open the model <b>together with</b> its textures: select all the files, drop the whole folder, or drop a ZIP.</li>
    <li>If some are still missing, open <b>Tools → Files &amp; textures</b>. It lists each file the model asked for and lets you pick the missing ones.</li>
    <li>Two textures with the same name in different folders are matched by their folder path.</li></ol>
    <p>Files on your device never fetch textures from other websites unless you allow it in Settings.</p>` },
  { id: 'cors', title: 'A link will not open', body: `
    <p>Opening from a URL downloads the file into your browser. The server hosting it must allow cross-origin downloads. GitHub "raw" links and most public CDN links work. Many cloud-drive share pages do not, because they are web pages, not direct file links.</p>
    <p>Download the file to your device and open it instead. OMNIVIEWER does not use a proxy server, so private links are never passed to a third party.</p>` },
  { id: 'units', title: 'The model is the wrong size', body: `
    <p>Some formats (STL, OBJ, PLY) store only numbers, with no unit. OMNIVIEWER uses the unit the file declares when there is one (glTF, 3MF, STEP, Rhino, IFC). Otherwise it uses the usual unit for the format and checks whether the size looks plausible.</p>
    <ul><li><b>File units</b> tells OMNIVIEWER what the numbers mean. Changing it changes the real size: use it when "20" should be 20 inches, not 20 mm.</li>
    <li><b>Show sizes in</b> only changes how sizes are displayed.</li>
    <li><b>Rescale to</b> rewrites the numbers in another unit and keeps the real size, for example before saving an inch-based STL for a slicer that expects millimetres.</li></ul>
    <p>Exports write the right real-world size for each format: glTF, GLB and USDZ in metres; STL in millimetres by default; 3MF with its unit declared.</p>` },
  { id: 'repair', title: 'What repair and the checks can and cannot do', body: `
    <p>The checks look at the triangle mesh: open edges (holes), edges shared by more than two faces, faces pointing the wrong way and degenerate triangles. "Mesh checks passed" means those checks found nothing. It does <b>not</b> mean the part will print well: wall thickness, overhangs, intersections between parts and your printer settings matter too.</p>
    <p>Repair fills holes with simple patches, turns faces outwards and removes loose pieces. Repair and polygon reduction rebuild the mesh, so textures (UVs) are not kept. Hollowing offsets the surface inwards. It works best on smooth, closed shapes and can fold on thin or sharp features, so check the cut-away view and add a drain hole for resin prints.</p>` },
  { id: 'storage', title: 'How files and local storage work', body: `
    <p>Your models are read and converted in this browser. They are never uploaded. When you open a file from a URL, your browser downloads it from that address.</p>
    <p>If recent files are on, a copy of each file you open (up to 250 MB in total) is kept in this browser's storage, so you can reopen it. Turn this off and clear it under <b>Recent files</b>, or in Settings. Saved views, unit defaults and preferences are also kept locally. Clearing your browser's site data removes everything.</p>
    <p>The page loads its own scripts and the first-time engines (CAD, IFC, Rhino) from omniviewer3d.com. It sends no analytics.</p>` },
  { id: 'offline', title: 'Using it offline', body: `
    <p>After a visit, the viewer works offline for the formats you have used. Engines for STEP/IGES, IFC and Rhino are downloaded the first time you open such a file, so open one while online if you need it offline later. Settings shows which engines are ready offline.</p>` },
  { id: 'browsers', title: 'Browser and device support', body: `
    <p>OMNIVIEWER needs WebGL. Current Chrome, Edge, Firefox and Safari on desktop, iOS and Android are supported. Very large models (hundreds of MB) depend on the memory of your device; phones may reload the page when they run out of memory.</p>` },
  { id: 'export', title: 'What each export format keeps', body: `
    <table class="help-table"><tr><th>Format</th><th>Keeps</th><th>Loses</th></tr>
    <tr><td>GLB / glTF</td><td>Geometry, materials, textures, vertex colours, animation, real size in metres</td><td>Exact CAD surfaces</td></tr>
    <tr><td>STL</td><td>Geometry</td><td>Colours, materials, textures, animation, part names; no units stored</td></tr>
    <tr><td>3MF</td><td>Geometry, separate objects, declared unit, one colour per object or per triangle</td><td>Textures, animation</td></tr>
    <tr><td>OBJ</td><td>Geometry, normals, UVs, part names</td><td>Materials (use OBJ + MTL), animation</td></tr>
    <tr><td>OBJ + MTL</td><td>Geometry, base colours, colour textures</td><td>Advanced material maps, animation</td></tr>
    <tr><td>PLY</td><td>Geometry, vertex colours</td><td>Materials, textures, animation</td></tr>
    <tr><td>USDZ</td><td>Geometry, basic materials, textures, size in metres</td><td>Animation, vertex colours</td></tr></table>` },
];

export function helpArticlesHtml(open?: string) {
  return `<div class="help-centre">${ARTICLES.map((a) => `<details id="help-${a.id}" ${a.id === open ? 'open' : ''}><summary>${a.title}</summary>${a.body}</details>`).join('')}</div>`;
}

const NOTES: { version: string; items: string[] }[] = [
  { version: '2026.11', items: [
    'Conversions keep the real size and orientation: GLB, glTF and USDZ are written in metres and Y-up; STL in millimetres by default; 3MF declares its unit.',
    'Exports use one rule for every format: visible parts, all parts or your selection. A preflight shows what is kept and what is lost.',
    'Units: "File units" (with where they came from), "Show sizes in", and "Rescale" are separate, and all are undoable.',
    'You are asked before an edited scene is replaced or the page is left.',
    'Screenshots keep their framing on high-resolution screens, at any size or aspect ratio.',
    'Checks are honest: "Mesh checks passed" instead of "Ready to print", Unknown wall thickness where no wall was found, Not checked for very large meshes.',
    'Files & textures panel, persistent problems panel, searchable keyboard-friendly parts list with multi-select and grouping.',
    'New: printer-bed check, overhang map, clash check, saved measurements, inspection report and technical drawing, project files, file watching, compare wipe and deviation map, OBJ + MTL export.',
    'The interface follows your page language (Spanish, German, French, Portuguese) for most labels.',
  ] },
];

export function releaseNotesHtml(current: string) {
  return `<p class="note">You are using version ${current}.</p>${NOTES.map((n) => `<h3>${n.version}</h3><ul>${n.items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('')}`;
}

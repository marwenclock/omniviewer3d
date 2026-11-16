// Content for the landing pages (one per format, converter and tool).
// Edit text here; scripts/seo.mjs turns it into static HTML pages at build time.

/** Formats OMNIVIEWER opens. `ext` is the main extension, `alt` other extensions. */
export const FORMATS = {
  stl: {
    name: 'STL', full: 'STL (stereolithography)', alt: [],
    about: 'STL is the standard file format for 3D printing. It describes the surface of an object as a mesh of triangles, without colours, textures or units, which is why almost every CAD program, slicer and 3D scanner can read and write it.',
    users: 'makers, 3D printing services and engineers checking a part before slicing',
    tips: ['Check the real size and volume of a print before you slice it.', 'STL has no units: if a part looks 25.4× too big or small, use the unit converter (inches ↔ mm).', 'Use the watertight check to spot open meshes that may fail to print.'],
  },
  step: {
    name: 'STEP', full: 'STEP / STP (ISO 10303)', alt: ['stp'],
    about: 'STEP (.step or .stp) is the most widely used neutral CAD format. SolidWorks, Fusion 360, Inventor, CATIA, Creo, Onshape, FreeCAD and nearly every other CAD system export it to share exact solid geometry between programs.',
    users: 'mechanical engineers, machinists, suppliers and anyone who received a CAD part without the software to open it',
    tips: ['OMNIVIEWER reads STEP with the OpenCascade CAD kernel and keeps the assembly tree and part colours.', 'Use the section plane and measuring tools to inspect parts and gaps.', 'Convert STEP to STL for 3D printing or to GLB for the web.'],
  },
  obj: {
    name: 'OBJ', full: 'Wavefront OBJ', alt: [],
    about: 'OBJ is a simple, widely supported text format for 3D meshes. It stores geometry, normals and texture coordinates, while materials live in a separate .mtl file that points to texture images.',
    users: '3D artists, game developers and photogrammetry users',
    tips: ['Drop the .obj together with its .mtl file and textures (or a .zip of all of them) to see materials.', 'Convert OBJ to GLB for a single file that keeps textures.', 'Convert OBJ to STL for 3D printing.'],
  },
  glb: {
    name: 'GLB', full: 'GLB (binary glTF)', alt: [],
    about: 'GLB is the single-file, binary version of glTF, the "JPEG of 3D" standardised by the Khronos Group. It packs meshes, PBR materials, textures and animations into one compact file, and is used across the web, AR and game engines.',
    users: 'web developers, e-commerce teams, AR creators and 3D artists',
    tips: ['Animations play automatically; pick another clip in the details panel.', 'Draco, Meshopt and KTX2 compressed files are supported.', 'Convert GLB to USDZ for iPhone AR Quick Look, or to STL for printing.'],
  },
  gltf: {
    name: 'glTF', full: 'glTF (GL Transmission Format)', alt: [],
    about: 'glTF is the open standard for delivering 3D scenes to apps and the web. A .gltf file is JSON that usually references a .bin buffer and texture images; GLB is the same thing in one binary file.',
    users: 'web and app developers, technical artists and AR teams',
    tips: ['Drop the .gltf together with its .bin and texture files, or a .zip of the folder.', 'Convert glTF to GLB to bundle everything into one file.', 'Inspect materials, vertex and triangle counts before shipping a model.'],
  },
  fbx: {
    name: 'FBX', full: 'Autodesk FBX', alt: [],
    about: 'FBX is Autodesk\'s interchange format used by Maya, 3ds Max, Blender, Cinema 4D, Unity and Unreal Engine. It carries meshes, materials, skeletons and animations.',
    users: 'game developers, animators and 3D artists',
    tips: ['Animations are detected and can be played in the details panel.', 'Drop textures together with the FBX if they are not embedded.', 'Convert FBX to GLB for the web or to OBJ/STL for other tools.'],
  },
  '3mf': {
    name: '3MF', full: '3MF (3D Manufacturing Format)', alt: [],
    about: '3MF is the modern 3D printing format backed by Microsoft, Prusa, Bambu Lab and others. Unlike STL it stores units, colours, materials and multiple objects in one zipped file.',
    users: 'makers using PrusaSlicer, Bambu Studio, Cura or OrcaSlicer',
    tips: ['See every object in a print plate in the scene tree.', 'Check real dimensions and volume in millimetres.', 'Convert 3MF to STL for older slicers or services.'],
  },
  ifc: {
    name: 'IFC', full: 'IFC (Industry Foundation Classes)', alt: [],
    about: 'IFC is the open BIM (building information modelling) standard used to exchange building models between Revit, ArchiCAD, Tekla, Vectorworks and other architecture and construction software.',
    users: 'architects, engineers, contractors and clients reviewing building models',
    tips: ['Every building element appears by name in the scene tree; hide or isolate walls, slabs and roofs.', 'Use the section plane to cut through floors.', 'Convert IFC to GLB or OBJ to use the model in other 3D tools.'],
  },
  '3dm': {
    name: '3DM', full: 'Rhino 3DM', alt: [],
    about: '3DM is the native file format of Rhinoceros (Rhino 3D), popular in industrial design, jewellery, architecture and marine design. OMNIVIEWER uses McNeel\'s official rhino3dm library to read it.',
    users: 'designers and clients who need to look at a Rhino model without owning Rhino',
    tips: ['Open Rhino files without installing Rhino.', 'Measure distances and check overall dimensions.', 'Convert 3DM to STL for printing or to GLB/OBJ for other software.'],
  },
  iges: {
    name: 'IGES', full: 'IGES / IGS', alt: ['igs'],
    about: 'IGES (.iges or .igs) is an older neutral CAD exchange format that is still common for surfaces and legacy parts from CAD and CAM systems.',
    users: 'engineers and machinists working with older CAD data',
    tips: ['Read with the OpenCascade CAD kernel, the same engine used by FreeCAD.', 'Convert IGES to STL or OBJ.', 'Section and measure parts in the browser.'],
  },
  brep: {
    name: 'BREP', full: 'OpenCascade BREP', alt: ['brp'],
    about: 'BREP is the native boundary-representation format of the OpenCascade kernel, used by FreeCAD and other open-source CAD tools.',
    users: 'FreeCAD and OpenCascade users',
    tips: ['View exact CAD geometry without installing FreeCAD.', 'Convert BREP to STL or GLB.', 'Measure and section parts.'],
  },
  dae: {
    name: 'DAE', full: 'COLLADA DAE', alt: [],
    about: 'COLLADA (.dae) is an XML-based 3D interchange format. SketchUp, Blender, Google Earth and many older tools export it with materials, textures and animations.',
    users: 'SketchUp users, 3D artists and developers working with older pipelines',
    tips: ['Drop textures together with the .dae file.', 'Convert DAE to GLB for a modern single-file format.', 'Convert DAE to OBJ or STL.'],
  },
  ply: {
    name: 'PLY', full: 'PLY (Stanford Polygon File)', alt: [],
    about: 'PLY is a format for meshes and point clouds that commonly comes from 3D scanners and photogrammetry. It can store per-vertex colours, which OMNIVIEWER displays.',
    users: '3D scanning, photogrammetry and research users',
    tips: ['Both meshes and point clouds open.', 'Painted vertex colours are kept when you export back to PLY or GLB.', 'Convert PLY to STL for printing.'],
  },
  usdz: {
    name: 'USDZ', full: 'USDZ / USD (Universal Scene Description)', alt: ['usd', 'usda', 'usdc'],
    about: 'USDZ is Apple\'s augmented-reality format, built on Pixar\'s Universal Scene Description (USD). It powers AR Quick Look on iPhone and iPad. Plain .usd, .usda and .usdc files also open.',
    users: 'AR creators, e-commerce teams and Apple developers',
    tips: ['Preview USDZ files on Windows, Android or Linux.', 'Convert USDZ to GLB for Android and the web.', 'Convert GLB, OBJ or STL to USDZ for iPhone AR.'],
  },
  '3ds': {
    name: '3DS', full: 'Autodesk 3D Studio (3DS)', alt: [],
    about: '3DS is the legacy 3D Studio format from the 1990s. Many old model libraries and archives still ship in it.',
    users: 'anyone opening older model archives',
    tips: ['Drop textures together with the .3ds file.', 'Convert 3DS to OBJ or GLB to use it in modern tools.', 'Check the model size and parts.'],
  },
  off: {
    name: 'OFF', full: 'Object File Format (OFF)', alt: [],
    about: 'OFF is a simple text mesh format used in geometry processing and research datasets such as the Princeton Shape Benchmark and ModelNet.',
    users: 'researchers and students',
    tips: ['Coloured COFF files are supported.', 'Convert OFF to STL, OBJ or PLY.', 'Check vertex and triangle counts.'],
  },
  amf: {
    name: 'AMF', full: 'AMF (Additive Manufacturing File)', alt: [],
    about: 'AMF is an XML-based 3D printing format designed as a successor to STL, with support for colours, materials and multiple objects.',
    users: 'makers and 3D printing services',
    tips: ['Convert AMF to STL or 3MF-friendly formats.', 'Check dimensions and volume.', 'Inspect each object in the scene tree.'],
  },
  wrl: {
    name: 'VRML', full: 'VRML / WRL', alt: ['vrml'],
    about: 'VRML (.wrl) is an early web 3D format that is still exported by electronics CAD (such as KiCad), scientific software and some 3D scanners.',
    users: 'electronics engineers and scientists',
    tips: ['Open KiCad and other VRML board exports.', 'Convert WRL to STL, OBJ or GLB.', 'Measure components and boards.'],
  },
  vtk: {
    name: 'VTK', full: 'VTK / VTP', alt: ['vtp'],
    about: 'VTK files come from the Visualization Toolkit, ParaView and scientific simulation software.',
    users: 'scientists and simulation engineers',
    tips: ['Legacy .vtk and XML .vtp polydata open.', 'Convert VTK to STL or PLY.', 'Inspect geometry size and counts.'],
  },
  lwo: {
    name: 'LWO', full: 'LightWave Object (LWO)', alt: [],
    about: 'LWO is the object format of NewTek LightWave 3D.',
    users: 'LightWave users and archive owners',
    tips: ['Drop textures with the file.', 'Convert LWO to GLB or OBJ.', 'Inspect materials.'],
  },
  kmz: {
    name: 'KMZ', full: 'KMZ (zipped KML + COLLADA)', alt: [],
    about: 'KMZ files bundle COLLADA 3D models for Google Earth and SketchUp\'s 3D Warehouse.',
    users: 'SketchUp and Google Earth users',
    tips: ['Open the 3D model inside a KMZ.', 'Convert KMZ to GLB or OBJ.', 'Measure buildings and objects.'],
  },
  vox: {
    name: 'VOX', full: 'MagicaVoxel VOX', alt: [],
    about: 'VOX is the voxel format of MagicaVoxel, popular for voxel art and games.',
    users: 'voxel artists and indie game developers',
    tips: ['Convert voxel models to GLB, OBJ or STL (to 3D print voxel art).', 'Paint and recolour parts.', 'Check the size in voxels.'],
  },
  md2: {
    name: 'MD2', full: 'Quake II MD2', alt: [],
    about: 'MD2 is the animated model format of Quake II and many games based on its engine.',
    users: 'retro game modders',
    tips: ['Keyframe animations play automatically.', 'Convert MD2 to GLB or OBJ.', 'Inspect the mesh.'],
  },
  pcd: {
    name: 'PCD', full: 'PCD (Point Cloud Data)', alt: [],
    about: 'PCD is the point cloud format of the Point Cloud Library (PCL), common for LiDAR and depth-camera scans.',
    users: 'robotics, LiDAR and scanning users',
    tips: ['ASCII and binary PCD files open.', 'Measure distances between points.', 'Export to PLY.'],
  },
  xyz: {
    name: 'XYZ', full: 'XYZ point cloud', alt: [],
    about: 'XYZ is a plain-text point cloud with one "x y z" coordinate per line, often exported by scanners and survey software.',
    users: 'surveyors and scanning users',
    tips: ['Open large point clouds in the browser.', 'Measure between points.', 'Export to PLY.'],
  },
  gcode: {
    name: 'G-code', full: 'G-code toolpaths', alt: ['gco'],
    about: 'G-code is the set of machine instructions that a 3D printer or CNC machine follows. Viewing it shows the exact toolpath your slicer generated.',
    users: 'makers checking a sliced print before sending it to the printer',
    tips: ['Preview the print path layer by layer with the section plane.', 'Check the overall print size.', 'Spot travel moves and gaps.'],
  },
};

/** Export targets: id must match EXPORT_FORMATS in src/exporters.ts. */
export const TARGETS = {
  stl: { name: 'STL', id: 'stl', note: 'STL is geometry only, so colours and textures are dropped. It is the format every slicer accepts.' },
  obj: { name: 'OBJ', id: 'obj', note: 'OBJ keeps geometry, normals and UV coordinates and opens in almost any 3D program.' },
  glb: { name: 'GLB', id: 'glb', note: 'GLB keeps materials, textures, colours and animations in one compact file, ideal for the web, AR and game engines.' },
  gltf: { name: 'glTF', id: 'gltf', note: 'glTF is the JSON version of GLB with all data embedded.' },
  ply: { name: 'PLY', id: 'ply', note: 'PLY keeps vertex colours, including anything you painted.' },
  usdz: { name: 'USDZ', id: 'usdz', note: 'USDZ opens in AR Quick Look on iPhone and iPad.' },
};

/** Converter pages: [from, to]. Picked for search demand. */
export const CONVERSIONS = [
  ['step', 'stl'], ['step', 'obj'], ['step', 'glb'], ['iges', 'stl'], ['3dm', 'stl'], ['3dm', 'obj'],
  ['stl', 'obj'], ['obj', 'stl'], ['stl', 'glb'], ['glb', 'stl'], ['glb', 'obj'], ['obj', 'glb'],
  ['fbx', 'glb'], ['fbx', 'obj'], ['fbx', 'stl'], ['gltf', 'glb'], ['3mf', 'stl'], ['dae', 'glb'], ['dae', 'obj'],
  ['ifc', 'glb'], ['ifc', 'obj'], ['ply', 'stl'], ['stl', 'ply'], ['usdz', 'glb'], ['glb', 'usdz'], ['obj', 'usdz'],
  ['stl', 'usdz'], ['3ds', 'obj'], ['wrl', 'stl'], ['vox', 'stl'],
];

/** Tool pages. `tool` is read by the app to open the right panel after a file loads. */
export const TOOLS = [
  {
    slug: 'convert', tool: 'convert', icon: 'download', label: 'Converter', short: 'Convert between 30+ formats',
    title: '3D File Converter Online · Free, No Upload',
    h1: 'Free <span class="glow">3D file converter</span>.',
    lede: 'Convert STEP, STL, OBJ, FBX, GLB, 3MF, IFC, 3DM and more to STL, OBJ, GLB, glTF, PLY or USDZ. Files are converted on your device and never uploaded.',
    desc: 'Free online 3D file converter. Convert STEP, STL, OBJ, FBX, GLB, 3MF, IFC, 3DM and 30+ formats to STL, OBJ, GLB, PLY or USDZ. No upload, no sign-up, no ads.',
    body: ['Open any supported 3D file, then pick an export format. The converter keeps your edits, paint and scaling, and can export just one selected part.', 'Because conversion happens in your browser, even confidential CAD files stay on your computer.'],
  },
  {
    slug: 'scale', tool: 'scale', icon: 'scale', label: 'Scale & resize', short: 'Resize to an exact size',
    title: 'Scale & Resize 3D Models Online (STL, OBJ, STEP)',
    h1: 'Scale and <span class="glow">resize</span> 3D models.',
    lede: 'Resize an STL, OBJ, STEP or any 3D model to an exact width, height or depth, scale by a percentage, or stretch one axis. Then download the result.',
    desc: 'Free online tool to scale and resize STL, OBJ, STEP, 3MF and other 3D models to an exact size in mm or inches, by percentage or per axis. Download as STL, OBJ or GLB.',
    body: ['Set an exact size on any axis with "Keep proportions" on, or turn it off to stretch only one axis. You can also scale by a factor, mirror, or use the move/rotate/scale handles.', 'When you are done, export to STL, OBJ, GLB, PLY or USDZ.'],
  },
  {
    slug: 'unit-converter', tool: 'units', icon: 'ruler', label: 'Unit converter', short: 'Inches ↔ mm and more',
    title: 'Convert STL Units: Inches to mm (and mm to Inches) Online',
    h1: 'Convert 3D model <span class="glow">units</span>.',
    lede: 'Model came out 25.4× too small or too big? Rescale STL, OBJ and other 3D files between inches, millimetres, centimetres, metres and feet in one click.',
    desc: 'Free online tool to convert STL, OBJ and 3D model units from inches to mm, mm to inches, cm, m and feet. Fix models that import at the wrong size, then download.',
    body: ['STL and OBJ files store plain numbers without units, so a model drawn in inches often opens 25.4 times too small in a slicer that expects millimetres. Pick the unit the file was made in and the unit you need, and OMNIVIEWER rescales the geometry so the numbers match.', 'Then export a corrected STL, OBJ or GLB.'],
  },
  {
    slug: 'measure', tool: 'measure', icon: 'ruler', label: 'Measure', short: 'Distances, angles, sizes',
    title: 'Measure 3D Models Online · Distances, Angles & Dimensions',
    h1: 'Measure <span class="glow">3D models</span> online.',
    lede: 'Click two points to measure distances on STL, STEP, OBJ, IFC and other 3D files, with corner snapping, X/Y/Z deltas, face angles and overall dimensions.',
    desc: 'Free online 3D measuring tool. Measure distances, angles between faces and overall dimensions of STL, STEP, OBJ, IFC and 3DM models in mm, cm, m, inches or feet.',
    body: ['The measure tool snaps to corners, shows the straight-line distance and the X/Y/Z differences, the angle between the two surfaces you clicked, and the gap between parallel faces.', 'The details panel always shows the overall width, height and depth.'],
  },
  {
    slug: 'stl-volume-calculator', tool: 'volume', icon: 'cube', label: 'Volume calculator', short: 'Volume, area, watertight',
    title: 'STL Volume Calculator Online · Volume, Surface Area & Size',
    h1: 'STL <span class="glow">volume</span> calculator.',
    lede: 'Get the volume, surface area, dimensions and watertight status of STL, OBJ, 3MF and STEP models instantly, to estimate material and print cost.',
    desc: 'Free STL volume calculator. Calculate the volume, surface area and dimensions of STL, OBJ, 3MF and STEP files in mm³, cm³ or in³ and check if the mesh is watertight.',
    body: ['Volume is computed from the closed mesh, so the watertight check tells you whether the number can be trusted. Multiply the volume by your material density to estimate weight and cost.', 'Switch units to see the result in mm³, cm³, m³, in³ or ft³.'],
  },
  {
    slug: 'paint', tool: 'paint', icon: 'brush', label: 'Paint', short: 'Brush colour onto models',
    title: 'Paint 3D Models Online · Color STL, OBJ & GLB',
    h1: 'Paint <span class="glow">3D models</span> online.',
    lede: 'Brush colour onto any 3D model or recolour whole parts, then export to GLB or PLY with the paint kept as vertex colours.',
    desc: 'Free online 3D painting tool. Brush colours onto STL, OBJ, GLB and other models or recolour whole parts, then export to GLB or PLY with vertex colours.',
    body: ['Choose Brush to paint faces under the cursor, or Whole part to recolour an object in one click. Brush size and colour are adjustable, and every stroke can be undone.', 'Paint is stored as vertex colours, so it survives export to GLB and PLY.'],
  },
  {
    slug: 'editor', tool: 'edit', icon: 'move', label: 'Editor', short: 'Move, add shapes, edit',
    title: 'Free Online 3D Editor · Move, Rotate, Scale & Add Shapes',
    h1: 'A simple online <span class="glow">3D editor</span>.',
    lede: 'Move, rotate and scale parts, add boxes, spheres, cylinders and other shapes, duplicate, mirror, recolour and delete, with full undo. Then export.',
    desc: 'Free online 3D editor in your browser. Move, rotate and scale objects, add primitive shapes, duplicate, mirror, recolour and delete parts, then export to STL, OBJ or GLB.',
    body: ['Open a model or start from an empty scene. Select a part to move, rotate or scale it with the handles or by typing exact numbers, or add new shapes from the toolbar.', 'It is deliberately simple: perfect for quick fixes, mock-ups and kit-bashing before printing or exporting.'],
  },
];

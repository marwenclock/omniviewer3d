import type * as THREE from 'three';

// One source of truth for what the loaded content supports (audit OV-073). Tools, export options, the print
// estimate and messages all ask here instead of guessing from the file extension. Point-cloud PLY, mesh PLY and
// Gaussian-splat PLY share an extension but get different capabilities because they are detected by content.

export type ContentKind = 'mesh' | 'points' | 'splat' | 'toolpath' | 'lines' | 'empty';

export interface Capabilities {
  kinds: Set<ContentKind>;
  /** the main kind, for messages */
  primary: ContentKind;
  hasMesh: boolean;
  hasPoints: boolean;
  isSplat: boolean;
  isToolpath: boolean;
  isCAD: boolean;
  isBIM: boolean;
  animated: boolean;
  /** surfaces can be picked with the mouse (measure, paint, select) */
  pickable: boolean;
  /** triangle tools: repair, reduce, hollow, thickness, boolean, cut */
  meshTools: boolean;
  /** volume, watertight and print estimate make sense */
  volume: boolean;
  /** mesh export formats work */
  exportable: boolean;
}

const CAD = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', '3dm']);

export function detectCapabilities(root: THREE.Object3D | null, ext: string, clips = 0): Capabilities {
  const kinds = new Set<ContentKind>();
  root?.traverse((o: any) => {
    if (o.userData.helper || o.userData.proxy) return;
    if (o.userData.splat) { kinds.add('splat'); return; }
    if (o.isMesh) kinds.add('mesh');
    else if (o.isPoints) kinds.add('points');
    else if (o.isLine) kinds.add(ext === 'gcode' || ext === 'gco' ? 'toolpath' : 'lines');
  });
  if (!kinds.size) kinds.add('empty');
  const has = (k: ContentKind) => kinds.has(k);
  const primary: ContentKind = has('splat') ? 'splat' : has('mesh') ? 'mesh' : has('points') ? 'points' : has('toolpath') ? 'toolpath' : has('lines') ? 'lines' : 'empty';
  const isBIM = ext === 'ifc';
  return {
    kinds, primary,
    hasMesh: has('mesh'), hasPoints: has('points'), isSplat: has('splat'), isToolpath: has('toolpath'),
    isCAD: CAD.has(ext), isBIM, animated: clips > 0,
    pickable: !has('splat') && (has('mesh') || has('points') || has('lines') || has('toolpath')),
    meshTools: has('mesh') && !has('splat'),
    volume: has('mesh') && !has('splat'),
    exportable: !has('splat') && !kinds.has('empty'),
  };
}

/** Why a tool is unavailable for this content, or null when it can be used. */
export function unavailableReason(c: Capabilities | null, need: 'model' | 'mesh' | 'pickable' | 'export'): string | null {
  if (!c || c.primary === 'empty') return 'Open a model first.';
  if (need === 'mesh' && !c.meshTools) {
    if (c.isSplat) return 'Gaussian splats are a cloud of soft points, not a surface, so mesh tools can’t work on them.';
    if (c.hasPoints) return 'Point clouds have no surface (no triangles), so mesh tools can’t work on them.';
    if (c.isToolpath) return 'G-code is a printer toolpath made of lines, not a solid, so mesh tools can’t work on it.';
    return 'This tool needs a triangle mesh.';
  }
  if (need === 'pickable' && !c.pickable) return c.isSplat ? 'Picking points on Gaussian splats is not supported yet.' : 'Nothing to pick.';
  if (need === 'export' && !c.exportable) return c.isSplat ? 'Gaussian splats can be viewed and screenshotted, but not converted to mesh formats.' : 'Nothing to export.';
  return null;
}

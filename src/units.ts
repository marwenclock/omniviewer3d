import type { Unit } from './stats';

// Unit and up-axis defaults per file type, remembered per format once the user changes them.

const Z_UP = new Set(['stl', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', '3mf', 'amf', 'off', 'gcode', 'gco', '3dm', 'ply', 'vox']);
const MM = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', '3mf', 'amf', 'gcode', 'gco', 'obj', 'off', 'ply', '3dm']);
const METRES = new Set(['glb', 'gltf', 'usdz', 'usd', 'usda', 'usdc', 'ifc', 'fbx', 'dae', 'kmz']);

interface Pref { unit?: Unit; up?: 'y' | 'z' }
const key = (ext: string) => 'omniview.fmt.' + ext;

export function rememberedPref(ext: string): Pref {
  try { return JSON.parse(localStorage.getItem(key(ext)) || '{}'); } catch { return {}; }
}
export function rememberPref(ext: string, patch: Pref) {
  try { localStorage.setItem(key(ext), JSON.stringify({ ...rememberedPref(ext), ...patch })); } catch { /* private mode */ }
}

export function defaultUp(ext: string): 'y' | 'z' { return rememberedPref(ext).up ?? (Z_UP.has(ext) ? 'z' : 'y'); }

export interface UnitGuess { unit: Unit; /** a likely alternative to suggest when the size looks wrong */ suggest?: { unit: Unit; why: string } }

/**
 * Picks a unit from the file type, then sanity-checks the size: a "mm" part smaller than half a millimetre
 * is probably in metres, and one under ~25 mm may well be in inches.
 */
export function guessUnit(ext: string, maxSize: number): UnitGuess {
  const remembered = rememberedPref(ext).unit;
  if (remembered) return { unit: remembered };
  if (MM.has(ext)) {
    if (maxSize > 0 && maxSize < 0.5) return { unit: 'm', suggest: { unit: 'mm', why: `It is only ${maxSize.toPrecision(2)} units across, so it was probably made in metres.` } };
    if (maxSize >= 0.5 && maxSize < 25) return { unit: 'mm', suggest: { unit: 'in', why: `At ${maxSize.toPrecision(3)} mm across it is very small. It may have been made in inches.` } };
    if (maxSize > 5000) return { unit: 'mm', suggest: { unit: 'm', why: 'It is over 5 metres across in millimetres. It may be in centimetres or metres.' } };
    return { unit: 'mm' };
  }
  if (METRES.has(ext)) {
    if (maxSize > 200) return { unit: 'm', suggest: { unit: 'cm', why: `At ${Math.round(maxSize)} m across it is huge. It may be in centimetres or millimetres.` } };
    return { unit: 'm' };
  }
  return { unit: 'mm' };
}

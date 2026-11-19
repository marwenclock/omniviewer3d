import type { Unit } from './stats';
import { t } from './i18n';

// Unit and up-axis defaults per file type. A default saved for a format is always shown to the user (CA-07).

const Z_UP = new Set(['stl', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', '3mf', 'amf', 'off', 'gcode', 'gco', '3dm', 'ply', 'vox']);
const MM = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', '3mf', 'amf', 'gcode', 'gco', 'obj', 'off', 'ply', '3dm']);
const METRES = new Set(['glb', 'gltf', 'usdz', 'usd', 'usda', 'usdc', 'ifc', 'fbx', 'dae', 'kmz', 'splat', 'ksplat', 'spz']);

interface Pref { unit?: Unit; up?: 'y' | 'z' }
const key = (ext: string) => 'omniview.fmt.' + ext;

export function rememberedPref(ext: string): Pref {
  try { return JSON.parse(localStorage.getItem(key(ext)) || '{}'); } catch { return {}; }
}
export function rememberPref(ext: string, patch: Pref) {
  try { localStorage.setItem(key(ext), JSON.stringify({ ...rememberedPref(ext), ...patch })); } catch { /* private mode */ }
}
/** Removes a saved default (unit or up axis) for a format. */
export function forgetPref(ext: string, field: keyof Pref) {
  const p = rememberedPref(ext);
  delete p[field];
  try { localStorage.setItem(key(ext), JSON.stringify(p)); } catch { /* private mode */ }
}

export function defaultUp(ext: string): 'y' | 'z' { return rememberedPref(ext).up ?? (Z_UP.has(ext) ? 'z' : 'y'); }

/**
 * Where the current unit came from (OV-007):
 *  declared – written in the file or fixed by the format specification (glTF = metres, STEP tessellated in mm…)
 *  saved    – a default the user saved for this file type
 *  format   – the usual unit for this file type (STL has no units; most are millimetres)
 *  guess    – picked from the model's size; a suggestion is shown
 *  user     – chosen by the user for this model
 *  new      – a new empty scene
 */
export type UnitSource = 'declared' | 'saved' | 'format' | 'guess' | 'user' | 'new';

export interface UnitGuess { unit: Unit; source: UnitSource; /** a likely alternative to suggest when the size looks wrong */ suggest?: { unit: Unit; why: string } }

/**
 * Picks a unit: the file's declared unit first, then a saved default, then the format's usual unit,
 * sanity-checked against the size ("mm" smaller than half a millimetre is probably metres, etc.).
 */
export function guessUnit(ext: string, maxSize: number, declared?: Unit): UnitGuess {
  if (declared) return { unit: declared, source: 'declared' };
  const remembered = rememberedPref(ext).unit;
  if (remembered) return { unit: remembered, source: 'saved' };
  if (MM.has(ext)) {
    if (maxSize > 0 && maxSize < 0.5) return { unit: 'm', source: 'guess', suggest: { unit: 'mm', why: t('It is only {n} units across, so it was probably made in metres.', { n: maxSize.toPrecision(2) }) } };
    if (maxSize >= 0.5 && maxSize < 25) return { unit: 'mm', source: 'guess', suggest: { unit: 'in', why: t('At {n} mm across it is very small. It may have been made in inches.', { n: maxSize.toPrecision(3) }) } };
    if (maxSize > 5000) return { unit: 'mm', source: 'guess', suggest: { unit: 'm', why: t('It is over 5 metres across in millimetres. It may be in centimetres or metres.') } };
    return { unit: 'mm', source: 'format' };
  }
  if (METRES.has(ext)) {
    if (maxSize > 200) return { unit: 'm', source: 'guess', suggest: { unit: 'cm', why: t('At {n} m across it is huge. It may be in centimetres or millimetres.', { n: Math.round(maxSize) }) } };
    return { unit: 'm', source: 'format' };
  }
  return { unit: 'mm', source: 'format' };
}

export const UNIT_SOURCE_LABEL: Record<UnitSource, string> = {
  declared: 'declared by the file',
  saved: 'your saved default',
  format: 'usual for this file type',
  guess: 'guessed from the size',
  user: 'chosen by you',
  new: 'new scene',
};

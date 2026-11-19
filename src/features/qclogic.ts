import { formatById, type ExportId } from '../exporters';

// Pure Quick Convert rules, kept apart from the UI so they run in the Node tests.

/**
 * Groups dropped files into one model each with its companions (textures, .mtl, .bin). Companions in the model's
 * folder or any folder below it (textures/, maps/…) go with that model; with a single model every companion does;
 * a companion nobody owns goes to every model, so each loader can still resolve it by name (audit F13).
 */
export function groupFiles<F>(files: F[], pathFor: (f: F) => string, isCompanion: (f: F) => boolean): F[][] {
  const companions = files.filter(isCompanion);
  const mains = files.filter((f) => !companions.includes(f));
  if (mains.length === 1) return [[mains[0], ...companions]];
  const dir = (f: F) => { const p = pathFor(f); return p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''; };
  const owned = new Set<F>();
  const groups = mains.map((m) => { const d = dir(m); const mine = companions.filter((c) => dir(c).startsWith(d)); mine.forEach((c) => owned.add(c)); return [m, ...mine]; });
  const loose = companions.filter((c) => !owned.has(c));
  if (loose.length) groups.forEach((g) => g.push(...loose));
  return groups;
}

/** An estimated unit must be confirmed before writing a format that records a physical size (audit F02). */
export const needsUnitConfirm = (r: { unitSrc: string; target: ExportId }) => r.unitSrc === 'guess' && formatById(r.target).convention !== 'unitless';

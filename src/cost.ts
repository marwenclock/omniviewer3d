// 3D-print weight, filament length and cost estimate from the model's volume and surface area.

export interface Material { id: string; name: string; density: number; refill: number; spool: number; resin?: boolean }

/**
 * Density in g/cm³ and price per kg in USD, based on Bambu Lab's official US store MSRP (refill = filament only,
 * spool = filament on a reusable spool, typically $3 more). Resin has no spool option. Users can override the price.
 */
export const MATERIALS: Material[] = [
  { id: 'pla', name: 'PLA (Basic)', density: 1.24, refill: 14.99, spool: 17.99 },
  { id: 'petg', name: 'PETG', density: 1.27, refill: 15.99, spool: 18.99 },
  { id: 'abs', name: 'ABS', density: 1.04, refill: 16.99, spool: 19.99 },
  { id: 'asa', name: 'ASA', density: 1.07, refill: 14.99, spool: 17.99 },
  { id: 'tpu', name: 'TPU 95A (flexible)', density: 1.21, refill: 22.19, spool: 25.19 },
  { id: 'pla-cf', name: 'PLA-CF', density: 1.3, refill: 31.99, spool: 34.99 },
  { id: 'pc', name: 'Polycarbonate (PC)', density: 1.2, refill: 20.99, spool: 23.99 },
  { id: 'nylon', name: 'Nylon CF (PAHT-CF)', density: 1.22, refill: 59.98, spool: 65.98 },
  { id: 'resin', name: 'Standard resin', density: 1.1, refill: 24.99, spool: 24.99, resin: true },
  { id: 'resin-abs', name: 'ABS-like resin', density: 1.15, refill: 29.99, spool: 29.99, resin: true },
];

export interface CostInput {
  volumeCm3: number;
  areaCm2: number;
  material: Material;
  /** 0..1 */
  infill: number;
  /** total wall thickness (perimeters + top/bottom), mm */
  wallMm: number;
  pricePerKg: number;
  /** filament diameter, mm */
  diameterMm: number;
  copies: number;
}

export interface CostResult { grams: number; meters: number; cost: number; solidGrams: number; shellShare: number }

export function estimate(i: CostInput): CostResult {
  const vol = Math.max(0, i.volumeCm3);
  // Shell volume ≈ surface area × wall thickness, never more than the whole part.
  const shell = Math.min(vol, i.areaCm2 * (i.wallMm / 10));
  const fill = i.material.resin ? 1 : i.infill;
  const printedCm3 = (shell + (vol - shell) * fill) * i.copies;
  const grams = printedCm3 * i.material.density;
  const r = i.diameterMm / 20; // radius in cm
  const meters = i.material.resin ? 0 : printedCm3 / (Math.PI * r * r) / 100;
  return {
    grams,
    meters,
    cost: (grams / 1000) * i.pricePerKg,
    solidGrams: vol * i.material.density * i.copies,
    shellShare: vol ? shell / vol : 0,
  };
}

// 3D-print weight, filament length and cost estimate from the model's volume and surface area.

export interface Material { id: string; name: string; density: number; price: number; resin?: boolean }

/** density in g/cm³, default price per kg in your currency */
export const MATERIALS: Material[] = [
  { id: 'pla', name: 'PLA', density: 1.24, price: 20 },
  { id: 'petg', name: 'PETG', density: 1.27, price: 22 },
  { id: 'abs', name: 'ABS', density: 1.04, price: 20 },
  { id: 'asa', name: 'ASA', density: 1.07, price: 25 },
  { id: 'tpu', name: 'TPU (flexible)', density: 1.21, price: 30 },
  { id: 'pla-cf', name: 'PLA-CF', density: 1.3, price: 35 },
  { id: 'nylon', name: 'Nylon (PA)', density: 1.14, price: 45 },
  { id: 'pc', name: 'Polycarbonate', density: 1.2, price: 40 },
  { id: 'resin', name: 'Standard resin', density: 1.1, price: 35, resin: true },
  { id: 'resin-abs', name: 'ABS-like resin', density: 1.15, price: 45, resin: true },
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

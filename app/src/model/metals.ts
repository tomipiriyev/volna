// Conductor materials and the skin-effect surface resistance the solver applies.
//
// A metal conductor is voxelized like PEC; its surface edges carry the surface
// resistance R_s = sqrt(pi f mu0 / sigma) (docs/physics.md, "Conductor loss").
// R_s grows as sqrt(f), but the time-domain model uses one value, evaluated at
// the band centre (the geometric mean of f_min and f_max, as for dielectric
// loss), so elsewhere in the band the conductor loss is off by sqrt(f / f_fit) - 1.
// The presets are room-temperature bulk values for non-magnetic metals (the
// model assumes mu = mu0, so nickel and ferritic steel are not offered).
import { lossFitFrequency } from './materials';
import type { ConductorSpec } from './types';

export const MU0 = 1.25663706212e-6;

export interface MetalPreset {
  id: string;
  name: string;
  sigma: number; // S/m
}

export const METALS: MetalPreset[] = [
  { id: 'silver', name: 'Silver', sigma: 6.3e7 },
  { id: 'copper', name: 'Copper', sigma: 5.8e7 },
  { id: 'gold', name: 'Gold', sigma: 4.1e7 },
  { id: 'aluminium', name: 'Aluminium', sigma: 3.77e7 },
  { id: 'brass', name: 'Brass', sigma: 1.5e7 },
  { id: 'tin', name: 'Tin', sigma: 9.17e6 },
  { id: 'stainless', name: 'Stainless steel (304)', sigma: 1.45e6 },
];

export const skinDepth = (sigma: number, f: number) => 1 / Math.sqrt(Math.PI * f * MU0 * sigma);
export const surfaceResistance = (sigma: number, f: number) => Math.sqrt((Math.PI * f * MU0) / sigma);

/** The preset a metal conductor matches, if any. */
export function metalPreset(c: ConductorSpec | undefined): MetalPreset | undefined {
  return c?.kind === 'metal' ? METALS.find((m) => m.name === c.name && m.sigma === c.sigma) : undefined;
}

export function conductorLabel(c: ConductorSpec | undefined): string {
  return c?.kind === 'metal' ? `${c.name} (σ ${c.sigma.toExponential(2)} S/m)` : 'PEC';
}

export interface MetalBandValidity {
  fFit: number;
  /** Model loss relative to the sqrt(f) law at f_min and f_max (e.g. +0.2 = 20 % too high). */
  atMin: number;
  atMax: number;
  maxDeviation: number;
  ok: boolean;
}

const MAX_METAL_DEVIATION = 0.25;

/** How far the constant-R_s model drifts from R_s ~ sqrt(f) across [fMin, fMax]. */
export function metalBandValidity(fMin: number, fMax: number): MetalBandValidity {
  const fFit = lossFitFrequency(fMin, fMax);
  const atMin = Math.sqrt(fFit / fMin) - 1;
  const atMax = Math.sqrt(fFit / fMax) - 1;
  const maxDeviation = Math.max(Math.abs(atMin), Math.abs(atMax));
  return { fFit, atMin, atMax, maxDeviation, ok: maxDeviation <= MAX_METAL_DEVIATION };
}

// Dielectric materials and their time-domain loss representation.
//
// The FDTD solver models dielectric loss with a constant conductivity sigma.
// A constant sigma gives tan(delta)(f) = sigma / (2 pi f eps0 epsR), i.e. the
// loss tangent falls as 1/f across the simulated band.
//
// A loss tangent is entered with the frequency it was specified at (often a
// datasheet value at 10 GHz). Laminate loss tangents are roughly constant over
// a decade, so the entered value is assumed to hold in the simulated band and
// sigma is fitted at the band centre (geometric mean of f_min and f_max):
//   sigma = 2 pi f_fit eps0 epsR tan(delta).
// Fitting at the datasheet frequency instead would scale the loss by
// f_ref / f (10x too lossy for a 10 GHz value used at 1 GHz).
import type { Material } from './types';

export const EPS0 = 8.8541878128e-12;

export const BUILTIN_MATERIALS: Material[] = [
  { id: 'fr4', name: 'FR-4 (generic)', epsR: 4.3, loss: { kind: 'tanDelta', tanDelta: 0.02, fRef: 1e9 }, builtin: true },
  { id: 'ro4003c', name: 'RO4003C-like', epsR: 3.38, loss: { kind: 'tanDelta', tanDelta: 0.0027, fRef: 10e9 }, builtin: true },
  {
    id: 'openems-patch',
    name: 'openEMS patch substrate (εr 3.38, tanδ 0.001 @ 2.45 GHz)',
    epsR: 3.38,
    loss: { kind: 'tanDelta', tanDelta: 1e-3, fRef: 2.45e9 },
    builtin: true,
  },
  { id: 'ptfe', name: 'PTFE', epsR: 2.1, loss: { kind: 'tanDelta', tanDelta: 0.0002, fRef: 10e9 }, builtin: true },
  { id: 'lossless-3', name: 'Lossless εr = 3', epsR: 3, loss: { kind: 'none' }, builtin: true },
];

/** Frequency at which a tan(delta) is converted to sigma for the band [fMin, fMax]. */
export function lossFitFrequency(fMin: number, fMax: number): number {
  return Math.sqrt(fMin * fMax);
}

/** Conductivity (S/m) the solver will use for this material, fitted at fFit. */
export function materialSigma(m: Material, fFit: number): number {
  switch (m.loss.kind) {
    case 'none':
      return 0;
    case 'conductivity':
      return m.loss.sigma;
    case 'tanDelta':
      return 2 * Math.PI * fFit * EPS0 * m.epsR * m.loss.tanDelta;
  }
}

/** Loss tangent the constant-sigma model actually produces at frequency f. */
export function effectiveTanDelta(m: Material, f: number, fFit: number): number {
  return materialSigma(m, fFit) / (2 * Math.PI * f * EPS0 * m.epsR);
}

export interface LossValidity {
  sigma: number;
  fFit: number;
  atMin: number;
  atMax: number;
  /** Largest relative deviation from the entered tan(delta) over [fMin, fMax]. */
  maxDeviation: number;
  ok: boolean;
}

const MAX_TAN_DELTA_DEVIATION = 0.25;

/** Only meaningful for tan(delta) materials; how far the 1/f model drifts across the band. */
export function lossValidity(m: Material, fMin: number, fMax: number): LossValidity | null {
  if (m.loss.kind !== 'tanDelta' || m.loss.tanDelta === 0) return null;
  const fFit = lossFitFrequency(fMin, fMax);
  const atMin = effectiveTanDelta(m, fMin, fFit);
  const atMax = effectiveTanDelta(m, fMax, fFit);
  const td = m.loss.tanDelta;
  const maxDeviation = Math.max(Math.abs(atMin / td - 1), Math.abs(atMax / td - 1));
  return { sigma: materialSigma(m, fFit), fFit, atMin, atMax, maxDeviation, ok: maxDeviation <= MAX_TAN_DELTA_DEVIATION };
}

export function validateMaterial(m: Material): string | null {
  if (!(m.epsR >= 1)) return 'Relative permittivity must be at least 1.';
  if (m.loss.kind === 'conductivity' && !(m.loss.sigma >= 0)) return 'Conductivity must be zero or positive.';
  if (m.loss.kind === 'tanDelta') {
    if (!(m.loss.tanDelta >= 0 && m.loss.tanDelta < 1)) return 'Loss tangent must be in [0, 1).';
    if (!(m.loss.fRef > 0)) return 'A loss tangent needs the frequency at which it was specified.';
  }
  return null;
}

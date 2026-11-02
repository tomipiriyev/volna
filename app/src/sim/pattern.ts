// Radiation-pattern analysis on the solver's far-field grid (pure functions).
//
// Conventions (docs/results.md): theta from +z, phi from +x toward +y, grid
// theta-major (index it * nPhi + ip). E fields are r*E peak phasors (e^{jwt}).
// The total directivity D(theta, phi) = 4 pi U / P_rad comes from the solver;
// a polarization component takes the fraction |E_c|^2 / (|E_theta|^2 + |E_phi|^2)
// of it. Gain and realized gain rescale D by P_rad/P_acc and P_rad/P_inc.
//
// Ludwig-3 (boresight +z), reference polarization along x:
//   E_co = E_theta cos(phi) - E_phi sin(phi),  E_cross = E_theta sin(phi) + E_phi cos(phi)
// and along y:
//   E_co = E_theta sin(phi) + E_phi cos(phi),  E_cross = E_theta cos(phi) - E_phi sin(phi).
import type { FarFieldJson } from './results';

export type Quantity = 'directivity' | 'gain' | 'realizedGain' | 'normalized';
export type Polarization = 'total' | 'theta' | 'phi' | 'co' | 'cross';
export type Ludwig3Ref = 'x' | 'y';

export interface Pattern {
  thetaDeg: number[];
  phiDeg: number[];
  nT: number;
  nP: number;
  d: number[]; // total directivity, linear
  eThRe: number[];
  eThIm: number[];
  ePhRe: number[];
  ePhIm: number[];
}

export const QUANTITY_LABEL: Record<Quantity, string> = {
  directivity: 'Directivity',
  gain: 'Gain',
  realizedGain: 'Realized gain',
  normalized: 'Normalized pattern',
};

/** Unit label: absolute quantities are dBi; the normalized pattern never is. */
export const unitLabel = (q: Quantity, db: boolean) => (q === 'normalized' ? (db ? 'dB (normalized)' : 'normalized (linear)') : db ? 'dBi' : 'linear (isotropic = 1)');

export function patternOf(ff: FarFieldJson): Pattern | null {
  const { thetaDeg, phiDeg, directivityPattern: d, eThetaRe, eThetaIm, ePhiRe, ePhiIm } = ff;
  if (!thetaDeg || !phiDeg || !d || !eThetaRe || !eThetaIm || !ePhiRe || !ePhiIm) return null;
  const n = thetaDeg.length * phiDeg.length;
  if (d.length !== n || eThetaRe.length !== n || ePhiRe.length !== n) return null;
  return { thetaDeg, phiDeg, nT: thetaDeg.length, nP: phiDeg.length, d, eThRe: eThetaRe, eThIm: eThetaIm, ePhRe: ePhiRe, ePhIm: ePhiIm };
}

/** Fraction of the radiated intensity in one polarization component at sample i. */
export function componentFraction(p: Pattern, i: number, pol: Polarization, ref: Ludwig3Ref = 'y'): number {
  if (pol === 'total') return 1;
  const tr = p.eThRe[i], ti = p.eThIm[i], pr = p.ePhRe[i], pi = p.ePhIm[i];
  const tot = tr * tr + ti * ti + pr * pr + pi * pi;
  if (!(tot > 0)) return 0;
  if (pol === 'theta') return (tr * tr + ti * ti) / tot;
  if (pol === 'phi') return (pr * pr + pi * pi) / tot;
  const phi = (p.phiDeg[i % p.nP] * Math.PI) / 180;
  const c = Math.cos(phi), s = Math.sin(phi);
  // ref x: co = Et c - Ep s; ref y: co = Et s + Ep c. Cross is the other rotation.
  const [a, b] = (pol === 'co') === (ref === 'x') ? [c, -s] : [s, c];
  const re = tr * a + pr * b, im = ti * a + pi * b;
  return (re * re + im * im) / tot;
}

/** Linear values of the chosen quantity and polarization on the whole grid, given the D-to-quantity factor. */
export function patternValues(p: Pattern, factor: number, pol: Polarization, ref: Ludwig3Ref = 'y'): Float64Array {
  const out = new Float64Array(p.d.length);
  for (let i = 0; i < out.length; i++) out[i] = p.d[i] * factor * componentFraction(p, i, pol, ref);
  return out;
}

export const toDb = (v: number) => (v > 0 ? 10 * Math.log10(v) : -Infinity);

export interface Cut {
  /** Plot angle (deg): elevation cuts use psi in (-180, 180], psi = theta on the phi0 half and -theta on the phi0+180 half; azimuth cuts use phi in [0, 360). */
  angleDeg: number[];
  values: number[]; // linear
  kind: 'elevation' | 'azimuth';
  /** Fixed angle actually used (nearest grid sample), deg: phi0 for elevation, theta0 for azimuth. */
  fixedDeg: number;
}

const nearestIndex = (arr: number[], v: number) => {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
  return best;
};

/** Index of the grid phi nearest to an angle, with wrap-around. */
function phiIndex(p: Pattern, phiDeg: number): number {
  const w = ((phiDeg % 360) + 360) % 360;
  let best = 0, bestD = Infinity;
  for (let j = 0; j < p.nP; j++) {
    const d = Math.min(Math.abs(p.phiDeg[j] - w), 360 - Math.abs(p.phiDeg[j] - w));
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

/** Full-circle elevation cut through phi0 and phi0 + 180 (theta = 0 at psi = 0). */
export function elevationCut(p: Pattern, values: ArrayLike<number>, phi0Deg: number): Cut {
  const j0 = phiIndex(p, phi0Deg), j1 = phiIndex(p, p.phiDeg[j0] + 180);
  const angleDeg: number[] = [], vals: number[] = [];
  const last = p.nT - 1;
  // phi0 + 180 half, theta from just below 180 down to just above 0 (theta = 0 and 180 are shared points).
  for (let it = last - 1; it >= 1; it--) {
    angleDeg.push(-p.thetaDeg[it]);
    vals.push(values[it * p.nP + j1]);
  }
  for (let it = 0; it <= last; it++) {
    angleDeg.push(p.thetaDeg[it]);
    vals.push(values[it * p.nP + j0]);
  }
  return { angleDeg, values: vals, kind: 'elevation', fixedDeg: p.phiDeg[j0] };
}

/** Azimuth cut at theta0 (phi 0 .. 360). */
export function azimuthCut(p: Pattern, values: ArrayLike<number>, theta0Deg: number): Cut {
  const it = nearestIndex(p.thetaDeg, theta0Deg);
  const vals = Array.from({ length: p.nP }, (_, j) => values[it * p.nP + j]);
  return { angleDeg: [...p.phiDeg], values: vals, kind: 'azimuth', fixedDeg: p.thetaDeg[it] };
}

/**
 * Half-power beamwidth (deg) of the lobe containing the cut's maximum: the
 * -3 dB crossings on both sides, interpolated linearly in dB between samples.
 * Cuts are treated as closed circles. Null if the cut never drops 3 dB.
 */
export function hpbw(cut: Cut): number | null {
  const n = cut.values.length;
  if (n < 3) return null;
  let im = 0;
  for (let i = 1; i < n; i++) if (cut.values[i] > cut.values[im]) im = i;
  const peak = toDb(cut.values[im]);
  if (!Number.isFinite(peak)) return null;
  const level = peak - 10 * Math.log10(2);
  const step = (cut.angleDeg[(im + 1) % n] - cut.angleDeg[im] + 360) % 360 || 360 / n;
  const walk = (dir: 1 | -1): number | null => {
    let prev = peak;
    for (let k = 1; k < n; k++) {
      const v = toDb(cut.values[(((im + dir * k) % n) + n) % n]);
      if (v < level) return (k - 1 + (prev - level) / (prev - v)) * step;
      prev = v;
    }
    return null;
  };
  const r = walk(1), l = walk(-1);
  return r === null || l === null || r + l >= 360 ? null : r + l;
}

/** Ludwig-3 reference with the stronger co-polar field at the beam direction (nearest sample). */
export function dominantLudwigRef(p: Pattern, beamThetaDeg: number, beamPhiDeg: number): Ludwig3Ref {
  const i = nearestIndex(p.thetaDeg, beamThetaDeg) * p.nP + phiIndex(p, beamPhiDeg);
  return componentFraction(p, i, 'co', 'x') > componentFraction(p, i, 'co', 'y') ? 'x' : 'y';
}

/** Front-to-back ratio (dB): value at the beam direction over the value at the opposite direction (nearest samples). */
export function frontToBack(p: Pattern, values: ArrayLike<number>, beamThetaDeg: number, beamPhiDeg: number): number {
  const front = values[nearestIndex(p.thetaDeg, beamThetaDeg) * p.nP + phiIndex(p, beamPhiDeg)];
  const back = values[nearestIndex(p.thetaDeg, 180 - beamThetaDeg) * p.nP + phiIndex(p, beamPhiDeg + 180)];
  return toDb(front) - toDb(back);
}

export interface PatternMesh {
  positions: Float32Array; // mm, centred at the origin
  colors: Float32Array; // linear RGB
  indices: Uint32Array;
}

/**
 * Surface r(theta, phi) for the 3D overlay. dB scale: r grows linearly from the
 * floor (peak - rangeDb) to the peak; linear scale: r is proportional to the value.
 * The phi seam is closed; theta = 0 and 180 rows collapse to the poles.
 */
export function patternMesh(p: Pattern, values: ArrayLike<number>, opts: { db: boolean; rangeDb: number; radius: number }): PatternMesh {
  let vmax = 0;
  for (let i = 0; i < values.length; i++) vmax = Math.max(vmax, values[i]);
  const norm = (v: number) => {
    if (!(vmax > 0)) return 0;
    if (!opts.db) return Math.max(v, 0) / vmax;
    const t = (toDb(v) - (toDb(vmax) - opts.rangeDb)) / opts.rangeDb;
    return Math.min(Math.max(t, 0), 1);
  };
  const positions = new Float32Array(p.nT * p.nP * 3);
  const colors = new Float32Array(p.nT * p.nP * 3);
  for (let it = 0; it < p.nT; it++) {
    const th = (p.thetaDeg[it] * Math.PI) / 180;
    for (let j = 0; j < p.nP; j++) {
      const i = it * p.nP + j;
      const t = norm(values[i]);
      const ph = (p.phiDeg[j] * Math.PI) / 180;
      const r = t * opts.radius;
      positions[3 * i] = r * Math.sin(th) * Math.cos(ph);
      positions[3 * i + 1] = r * Math.sin(th) * Math.sin(ph);
      positions[3 * i + 2] = r * Math.cos(th);
      colors.set(colormap(t), 3 * i);
    }
  }
  const idx: number[] = [];
  for (let it = 0; it + 1 < p.nT; it++)
    for (let j = 0; j < p.nP; j++) {
      const j1 = (j + 1) % p.nP;
      const a = it * p.nP + j, b = it * p.nP + j1, c = (it + 1) * p.nP + j, d = (it + 1) * p.nP + j1;
      idx.push(a, c, b, b, c, d);
    }
  return { positions, colors, indices: new Uint32Array(idx) };
}

// Perceptually ordered blue -> cyan -> green -> yellow -> red ramp (linear RGB).
const RAMP: [number, number, number][] = [
  [0.02, 0.05, 0.35],
  [0.0, 0.35, 0.8],
  [0.05, 0.7, 0.6],
  [0.45, 0.85, 0.15],
  [1.0, 0.75, 0.05],
  [0.9, 0.12, 0.05],
];

export function colormap(t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

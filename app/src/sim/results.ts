// Typed view of the solver's results JSON and derived port metrics.
import type { MeshReport } from '../workers/protocol';

export interface PortResultJson {
  z0: number;
  frequencies: number[];
  zinRe: number[];
  zinIm: number[];
  s11Re: number[];
  s11Im: number[];
  pAcc: number[];
  pInc: number[];
  sourceDb: number[];
}

export interface FarFieldJson {
  frequency: number;
  pRad: number;
  pRadPoynting: number;
  directivity: number;
  directivityDbi: number;
  beamThetaDeg: number;
  beamPhiDeg: number;
  sourceDb: number;
  zinRe?: number;
  zinIm?: number;
  s11Db?: number;
  pAcc?: number;
  pInc?: number;
  gainDbi?: number | null; // null when P_acc <= 0 (NaN in C++)
  realizedGainDbi?: number | null;
  efficiency?: number | null;
  uMax?: number;
  thetaDeg?: number[];
  phiDeg?: number[];
  directivityPattern?: number[]; // linear, theta-major
  eThetaRe?: number[];
  eThetaIm?: number[];
  ePhiRe?: number[];
  ePhiIm?: number[];
}

export interface ResultsJson {
  ok: true;
  run: {
    steps: number;
    maxSteps: number;
    dt: number;
    finalEnergyDb: number;
    terminatedBy: string;
    cells: number;
    memoryBytes: number;
    seconds: number;
    threads: number;
    mcellsPerSec: number;
    backend?: 'cpu' | 'webgpu';
  };
  port?: PortResultJson;
  farField: FarFieldJson[];
  warnings: string[];
  mesh?: MeshReport;
}

export interface Resonance {
  f: number; // Hz, Im(Zin) = 0
  r: number; // ohm
}

/** Series resonance: the Im(Zin) zero crossing closest to the |S11| minimum (linear interpolation). */
export function seriesResonance(p: PortResultJson): Resonance | null {
  const s = p.frequencies.map((_, i) => Math.hypot(p.s11Re[i], p.s11Im[i]));
  const best = s.indexOf(Math.min(...s));
  let pick: (Resonance & { i: number }) | null = null;
  for (let i = 1; i < p.frequencies.length; i++) {
    const a = p.zinIm[i - 1], b = p.zinIm[i];
    if (a <= 0 !== b <= 0) {
      const t = -a / (b - a);
      const cand = {
        i,
        f: p.frequencies[i - 1] + t * (p.frequencies[i] - p.frequencies[i - 1]),
        r: p.zinRe[i - 1] + t * (p.zinRe[i] - p.zinRe[i - 1]),
      };
      if (!pick || Math.abs(i - best) < Math.abs(pick.i - best)) pick = cand;
    }
  }
  return pick ? { f: pick.f, r: pick.r } : null;
}

export function minS11(p: PortResultJson): { f: number; db: number } {
  let k = 0, m = Infinity;
  p.frequencies.forEach((_, i) => {
    const v = Math.hypot(p.s11Re[i], p.s11Im[i]);
    if (v < m) {
      m = v;
      k = i;
    }
  });
  return { f: p.frequencies[k], db: 20 * Math.log10(m) };
}

export interface MatchedBand {
  fLo: number;
  fHi: number;
  /** True when the band runs into the edge of the simulated band on that side. */
  openLo: boolean;
  openHi: boolean;
}

/** Band around the |S11| minimum where |S11| stays below thresholdDb (crossings interpolated in dB). */
export function matchedBand(p: PortResultJson, thresholdDb = -10): MatchedBand | null {
  const db = p.frequencies.map((_, i) => 20 * Math.log10(Math.hypot(p.s11Re[i], p.s11Im[i])));
  let im = 0;
  db.forEach((v, i) => {
    if (v < db[im]) im = i;
  });
  if (!(db[im] < thresholdDb)) return null;
  const edge = (dir: 1 | -1) => {
    let i = im;
    while (i + dir >= 0 && i + dir < db.length && db[i + dir] < thresholdDb) i += dir;
    const j = i + dir;
    if (j < 0 || j >= db.length) return { f: p.frequencies[i], open: true };
    const t = (thresholdDb - db[i]) / (db[j] - db[i]);
    return { f: p.frequencies[i] + t * (p.frequencies[j] - p.frequencies[i]), open: false };
  };
  const lo = edge(-1), hi = edge(1);
  return { fLo: lo.f, fHi: hi.f, openLo: lo.open, openHi: hi.open };
}

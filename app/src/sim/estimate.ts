// Pre-run estimates from the grid alone. They mirror the C++ solver: the time
// step is the rectilinear-grid CFL limit (YeeFields), the pulse length is that
// of GaussianPulse::forBand. Run time is cells x steps x a measured cost per
// cell-step; it is an estimate, and resonant structures run far past the minimum.

const C0 = 299792458;

/** CFL time step (s) for grid lines in mm: S / (c sqrt(sum 1/dmin^2)). */
export function timeStep(lines: number[][], courant = 0.99): number {
  let inv2 = 0;
  for (const l of lines) {
    let d = Infinity;
    for (let i = 1; i < l.length; i++) d = Math.min(d, l[i] - l[i - 1]);
    inv2 += 1 / (d * 1e-3) ** 2;
  }
  return courant / (C0 * Math.sqrt(inv2));
}

/** Duration (s) of the Gaussian-modulated excitation for the band (2 t0, as in the solver). */
export function pulseDuration(fMin: number, fMax: number): number {
  const fc = 0.5 * (fMax - fMin);
  const tau = Math.sqrt(Math.log(10)) / (Math.PI * fc);
  return 2 * tau * Math.sqrt(Math.log(1e6));
}

/** Lower bound on the steps: the pulse plus two transits of the domain diagonal. */
export function minimumSteps(lines: number[][], fMin: number, fMax: number, courant = 0.99): number {
  const diag = Math.hypot(...lines.map((l) => (l[l.length - 1] - l[0]) * 1e-3));
  return Math.ceil((pulseDuration(fMin, fMax) + (2 * diag) / C0) / timeStep(lines, courant));
}

export interface TimeEstimate {
  dt: number;
  minSteps: number;
  maxSteps: number;
  minSeconds: number;
  maxSeconds: number;
}

export function estimateRunTime(lines: number[][], fMin: number, fMax: number, maxSteps: number, nsPerCellStep: number, courant = 0.99): TimeEstimate {
  const cells = lines.reduce((n, l) => n * (l.length - 1), 1);
  const minSteps = Math.min(minimumSteps(lines, fMin, fMax, courant), maxSteps);
  const secs = (steps: number) => cells * steps * nsPerCellStep * 1e-9;
  return { dt: timeStep(lines, courant), minSteps, maxSteps, minSeconds: secs(minSteps), maxSeconds: secs(maxSteps) };
}

/** Chord deviation (imported units) for the simulation tessellation: a tenth of the smallest cell. */
export function simDeflection(minCellMm: number, unitScale: number): number {
  return Math.min(Math.max(minCellMm / 10, 0.002), 0.5) / unitScale;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

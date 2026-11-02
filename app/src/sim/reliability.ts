// Availability of each result quantity: available, unreliable (with a
// reason, value still shown) or unavailable (with a reason, rendered as "—").
// The rules are listed in docs/results.md.
import type { FarFieldJson, PortResultJson, ResultsJson } from './results';

export type Avail<T> = { state: 'ok'; value: T } | { state: 'unreliable'; value: T; reason: string } | { state: 'unavailable'; reason: string };

/** Excitation spectrum below this (dB re. peak) makes a frequency unreliable. */
export const SOURCE_FLOOR_DB = -40;
/** Far-field (quadrature) vs Poynting-box radiated power mismatch that flags the far field. */
export const POWER_MISMATCH = 0.05;
/** For lossless models, P_rad above P_acc by more than this flags gain and efficiency. */
export const ENERGY_EXCESS = 0.05;

const ok = <T>(value: T): Avail<T> => ({ state: 'ok', value });
const no = <T>(reason: string): Avail<T> => ({ state: 'unavailable', reason });

/** Combines a value with the reasons that make it unreliable (empty: ok). */
function judge<T>(value: T, reasons: (string | false | null | undefined)[]): Avail<T> {
  const r = reasons.filter(Boolean) as string[];
  return r.length ? { state: 'unreliable', value, reason: r.join('; ') } : ok(value);
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function runCaveat(r: ResultsJson): string | null {
  return r.run.terminatedBy === 'energy' ? null : `the run stopped at the step cap (field energy ${r.run.finalEnergyDb.toFixed(1)} dB), so spectra are truncated`;
}

/** Reasons a port sample is unreliable ('' when it is fine). */
export function portSampleCaveats(r: ResultsJson, p: PortResultJson): string[] {
  const run = runCaveat(r);
  return p.frequencies.map((_, i) => {
    const reasons: string[] = [];
    if (run) reasons.push(run);
    if (p.sourceDb[i] < SOURCE_FLOOR_DB) reasons.push(`excitation ${p.sourceDb[i].toFixed(0)} dB below its peak`);
    if (Math.hypot(p.s11Re[i], p.s11Im[i]) > 1 + 1e-9) reasons.push('|S11| > 1 (passive-port check failed)');
    return reasons.join('; ');
  });
}

export interface FarFieldAvail {
  directivityDbi: Avail<number>;
  gainDbi: Avail<number>;
  realizedGainDbi: Avail<number>;
  efficiency: Avail<number>;
  pRad: Avail<number>;
  pRadPoynting: Avail<number>;
  pAcc: Avail<number>;
  pInc: Avail<number>;
  s11Db: Avail<number>;
  /** P_rad / P_acc (gain) and P_rad / P_inc (realized gain) factors applied to the D pattern. */
  gainFactor: Avail<number>;
  realizedFactor: Avail<number>;
}

/**
 * @param lossless whether the problem has no conductive material (then P_rad > P_acc
 *        beyond the tolerance is numerical error, not physics).
 */
export function farFieldAvail(r: ResultsJson, ff: FarFieldJson, lossless: boolean): FarFieldAvail {
  const run = runCaveat(r);
  const lowSource = ff.sourceDb < SOURCE_FLOOR_DB && `excitation ${ff.sourceDb.toFixed(0)} dB below its peak at this frequency`;
  const mismatch = Math.abs(ff.pRad / ff.pRadPoynting - 1);
  const powerMismatch = mismatch > POWER_MISMATCH && `far-field and Poynting-box powers differ by ${(100 * mismatch).toFixed(1)}%`;
  const common = [run, lowSource, powerMismatch];
  const directivityDbi = finite(ff.directivityDbi) ? judge(ff.directivityDbi, common) : no<number>('no radiated power');
  const pRad = finite(ff.pRad) && ff.pRad > 0 ? judge(ff.pRad, common) : no<number>('no radiated power');
  const pRadPoynting = finite(ff.pRadPoynting) ? judge(ff.pRadPoynting, [run, lowSource]) : no<number>('not computed');

  if (!r.port || !finite(ff.pAcc) || !finite(ff.pInc)) {
    const reason = 'the problem has no port';
    return { directivityDbi, pRad, pRadPoynting, gainDbi: no(reason), realizedGainDbi: no(reason), efficiency: no(reason), pAcc: no(reason), pInc: no(reason), s11Db: no(reason), gainFactor: no(reason), realizedFactor: no(reason) };
  }
  const accOk = ff.pAcc > 0;
  const accReason = 'accepted power ≤ 0 (the port delivers no power at this frequency)';
  const excess = lossless && accOk && ff.pRad / ff.pAcc > 1 + ENERGY_EXCESS && `energy balance: P_rad exceeds P_acc by ${(100 * (ff.pRad / ff.pAcc - 1)).toFixed(1)}% in a lossless model`;
  const s11Mag = ff.s11Db !== undefined && ff.s11Db !== null ? 10 ** (ff.s11Db / 20) : NaN;
  const notPassive = s11Mag > 1 + 1e-9 && '|S11| > 1 (passive-port check failed)';
  const gainReasons = [...common, excess, notPassive];
  return {
    directivityDbi,
    pRad,
    pRadPoynting,
    pAcc: accOk ? judge(ff.pAcc, [run, lowSource]) : no(accReason),
    pInc: ff.pInc > 0 ? judge(ff.pInc, [run, lowSource]) : no('incident power ≤ 0'),
    s11Db: finite(ff.s11Db) ? judge(ff.s11Db, [run, lowSource, notPassive]) : no('not computed'),
    gainDbi: accOk && finite(ff.gainDbi) ? judge(ff.gainDbi, gainReasons) : no(accReason),
    efficiency: accOk && finite(ff.efficiency) ? judge(ff.efficiency, gainReasons) : no(accReason),
    realizedGainDbi: ff.pInc > 0 && finite(ff.realizedGainDbi) ? judge(ff.realizedGainDbi, [...common, notPassive]) : no('incident power ≤ 0'),
    gainFactor: accOk ? judge(ff.pRad / ff.pAcc, gainReasons) : no(accReason),
    realizedFactor: ff.pInc > 0 ? judge(ff.pRad / ff.pInc, [...common, notPassive]) : no('incident power ≤ 0'),
  };
}

/** True when no material in the problem dissipates (PEC and lossless dielectrics only). */
export function isLossless(problem: { materials?: { sigma?: number; type?: string }[] }): boolean {
  return !(problem.materials ?? []).some((m) => (m.sigma ?? 0) > 0 || m.type === 'metal');
}

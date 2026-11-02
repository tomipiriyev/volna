// CSV export of raw results. Raw columns are the solver's own numbers written
// with JavaScript's shortest round-trip formatting, so parsing a field gives
// back exactly the double in the results JSON (tested). Derived columns are
// marked "derived" in the header comment. Display settings (floor, scale,
// mode) never reach these functions.
import { portSampleCaveats } from './reliability';
import type { FarFieldJson, ResultsJson } from './results';

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const text = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function table(comments: string[], header: string[], rows: string[][]): string {
  return [...comments.map((c) => `# ${c}`), header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

export function portCsv(r: ResultsJson, name: string): string {
  const p = r.port;
  if (!p) throw new Error('the results have no port data');
  const caveats = portSampleCaveats(r, p);
  const rows = p.frequencies.map((f, i) => {
    const mag = Math.hypot(p.s11Re[i], p.s11Im[i]);
    return [num(f), num(p.zinRe[i]), num(p.zinIm[i]), num(p.s11Re[i]), num(p.s11Im[i]), num(p.pAcc[i]), num(p.pInc[i]), num(p.sourceDb[i]), num(20 * Math.log10(mag)), num(mag < 1 ? (1 + mag) / (1 - mag) : NaN), text(caveats[i])];
  });
  return table(
    [
      `Volna Antenna Simulation port results: ${name}`,
      `Z0 = ${p.z0} ohm; Zin = V/I at the lumped port (reference plane = gap); e^{jwt}; powers in W for the DFT-scaled source`,
      'raw solver values: frequency_Hz .. source_dB; derived: s11_dB = 20 log10|S11|, vswr = (1+|S11|)/(1-|S11|) (empty when |S11| >= 1)',
      'reliability: empty = ok, otherwise the reasons the sample is unreliable',
    ],
    ['frequency_Hz', 'zin_re_ohm', 'zin_im_ohm', 's11_re', 's11_im', 'p_acc_W', 'p_inc_W', 'source_dB', 's11_dB', 'vswr', 'reliability'],
    rows,
  );
}

export function farFieldSummaryCsv(r: ResultsJson, name: string): string {
  const rows = r.farField.map((f) => [
    num(f.frequency),
    num(f.directivityDbi),
    num(f.gainDbi),
    num(f.realizedGainDbi),
    num(f.efficiency),
    num(f.pRad),
    num(f.pRadPoynting),
    num(f.pAcc),
    num(f.pInc),
    num(f.beamThetaDeg),
    num(f.beamPhiDeg),
    num(f.s11Db),
    num(f.sourceDb),
  ]);
  return table(
    [
      `Volna Antenna Simulation far-field summary: ${name}`,
      'all raw solver values; D = 4 pi Umax / P_rad, G = 4 pi Umax / P_acc, G_realized = 4 pi Umax / P_inc, efficiency = P_rad / P_acc',
      'P_rad by quadrature of the far field; P_rad_poynting through the Huygens box; theta from +z, phi from +x toward +y; empty = unavailable',
    ],
    ['frequency_Hz', 'directivity_dBi', 'gain_dBi', 'realized_gain_dBi', 'efficiency', 'p_rad_W', 'p_rad_poynting_W', 'p_acc_W', 'p_inc_W', 'beam_theta_deg', 'beam_phi_deg', 's11_dB', 'source_dB'],
    rows,
  );
}

export function patternCsv(ff: FarFieldJson, name: string): string {
  const { thetaDeg: th, phiDeg: ph, directivityPattern: d, eThetaRe, eThetaIm, ePhiRe, ePhiIm } = ff;
  if (!th || !ph || !d || !eThetaRe || !eThetaIm || !ePhiRe || !ePhiIm) throw new Error('the results have no pattern data');
  const rows: string[][] = [];
  for (let it = 0; it < th.length; it++)
    for (let j = 0; j < ph.length; j++) {
      const i = it * ph.length + j;
      rows.push([num(th[it]), num(ph[j]), num(d[i]), num(eThetaRe[i]), num(eThetaIm[i]), num(ePhiRe[i]), num(ePhiIm[i])]);
    }
  return table(
    [
      `Volna Antenna Simulation far-field pattern: ${name}, ${ff.frequency} Hz`,
      'raw solver values; directivity linear (isotropic = 1, total polarization); r*E peak phasors in V with e^{jwt}, e^{-jkr} removed',
      'theta from +z, phi from +x toward +y',
    ],
    ['theta_deg', 'phi_deg', 'directivity_lin', 'e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im'],
    rows,
  );
}

/** Parses a CSV written by this module (comments skipped, quoted fields supported). */
export function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.split('\n').filter((l) => l && !l.startsWith('#'));
  const split = (l: string) => {
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) {
        if (c === '"' && l[i + 1] === '"') (cur += '"', i++);
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') (out.push(cur), (cur = ''));
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const [header, ...rows] = lines.map(split);
  return { header, rows };
}

export interface CsvFile {
  fileName: string;
  content: string;
}

/**
 * The CSV files for a result. Only the far-field frequency index is taken from
 * the view, so display settings (floor, scale, quantity, polarization) cannot
 * change exported numbers.
 */
export function csvExports(results: ResultsJson, stem: string, view: { freqIndex: number }): CsvFile[] {
  const out: CsvFile[] = [];
  if (results.port) out.push({ fileName: `${stem}_port.csv`, content: portCsv(results, stem) });
  if (results.farField.length) out.push({ fileName: `${stem}_farfield.csv`, content: farFieldSummaryCsv(results, stem) });
  const ff = results.farField[Math.min(view.freqIndex, results.farField.length - 1)];
  if (ff?.directivityPattern) out.push({ fileName: `${stem}_pattern_${(ff.frequency / 1e9).toFixed(4)}GHz.csv`, content: patternCsv(ff, stem) });
  return out;
}

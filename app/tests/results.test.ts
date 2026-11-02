// M4 results analysis: pattern cuts, HPBW, front-to-back, Ludwig-3, CSV
// exactness and availability rules. The dipole checks run the native CLI on
// the M2 validation case (skipped if the CLI has not been built).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvExports, farFieldSummaryCsv, parseCsv, patternCsv, portCsv } from '../src/sim/exportCsv';
import { readProjectZip, writeProjectZip } from '../src/model/projectFile';
import { BUILTIN_MATERIALS } from '../src/model/materials';
import { DEFAULT_FREQ } from '../src/model/store';
import { remainingSeconds } from '../src/sim/simFlow';
import { DEFAULT_SIM_SETTINGS, DEFAULT_VIEW, type ResultView } from '../src/sim/simStore';
import { matchedBand } from '../src/sim/results';
import { fixtureBytes, loadFixture } from './helpers/fixtures';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSim } from '../src/sim/simStore';
import { ResultsDashboard } from '../src/ui/ResultsView';
import { azimuthCut, componentFraction, dominantLudwigRef, elevationCut, frontToBack, hpbw, patternMesh, patternOf, patternValues, type Pattern } from '../src/sim/pattern';
import { farFieldAvail, isLossless, portSampleCaveats } from '../src/sim/reliability';
import type { FarFieldJson, ResultsJson } from '../src/sim/results';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'build/native-release/antsim_cli');

/** Far field of a z-directed short dipole: E_theta = sin(theta), D = 1.5 sin^2(theta). */
function shortDipoleFF(step = 2, extraPhi = 0): FarFieldJson {
  const thetaDeg: number[] = [], phiDeg: number[] = [];
  for (let t = 0; t <= 180; t += step) thetaDeg.push(t);
  for (let p = 0; p < 360; p += step) phiDeg.push(p);
  const d: number[] = [], tr: number[] = [], ti: number[] = [], pr: number[] = [], pi: number[] = [];
  for (const t of thetaDeg)
    for (const p of phiDeg) {
      const s = Math.sin((t * Math.PI) / 180);
      d.push(1.5 * s * s);
      tr.push(s);
      ti.push(0);
      pr.push(extraPhi ? extraPhi * Math.cos((p * Math.PI) / 180) : 0); // JSON has no -0
      pi.push(0);
    }
  return {
    frequency: 1e9, pRad: 1, pRadPoynting: 1, directivity: 1.5, directivityDbi: 10 * Math.log10(1.5), beamThetaDeg: 90, beamPhiDeg: 0, sourceDb: -3,
    thetaDeg, phiDeg, directivityPattern: d, eThetaRe: tr, eThetaIm: ti, ePhiRe: pr, ePhiIm: pi,
  };
}

function resultsWith(ff: FarFieldJson, port = true): ResultsJson {
  return {
    ok: true,
    run: { steps: 100, maxSteps: 1000, dt: 1e-12, finalEnergyDb: -60, terminatedBy: 'energy', cells: 1, memoryBytes: 1, seconds: 1, threads: 1, mcellsPerSec: 1 },
    port: port ? { z0: 50, frequencies: [1e9], zinRe: [50], zinIm: [0], s11Re: [0], s11Im: [0], pAcc: [1], pInc: [1], sourceDb: [-3] } : undefined,
    farField: [ff],
    warnings: [],
  };
}

describe('pattern analysis', () => {
  const p = patternOf(shortDipoleFF())!;
  const total = patternValues(p, 1, 'total');

  it('elevation cut spans a closed circle with theta = 0 at psi = 0', () => {
    const cut = elevationCut(p, total, 0);
    expect(cut.angleDeg[0]).toBe(-178);
    expect(cut.angleDeg[cut.angleDeg.length - 1]).toBe(180);
    expect(new Set(cut.angleDeg).size).toBe(cut.angleDeg.length);
    expect(cut.values[cut.angleDeg.indexOf(90)]).toBeCloseTo(1.5, 12);
    expect(cut.values[cut.angleDeg.indexOf(-90)]).toBeCloseTo(1.5, 12);
  });

  it('HPBW of sin^2(theta) is 90 degrees; an omnidirectional cut has none', () => {
    expect(hpbw(elevationCut(p, total, 0))).toBeCloseTo(90, 0);
    expect(hpbw(elevationCut(p, total, 90))).toBeCloseTo(90, 0);
    expect(hpbw(azimuthCut(p, total, 90))).toBeNull();
  });

  it('front-to-back of a symmetric dipole is 0 dB', () => {
    expect(frontToBack(p, total, 90, 0)).toBeCloseTo(0, 12);
  });

  it('polarization components partition the total, Ludwig-3 included', () => {
    const q = patternOf(shortDipoleFF(2, 0.7))!;
    for (const i of [0, 137, 2000, 9000, q.d.length - 1]) {
      expect(componentFraction(q, i, 'theta') + componentFraction(q, i, 'phi')).toBeCloseTo(1, 12);
      for (const ref of ['x', 'y'] as const) expect(componentFraction(q, i, 'co', ref) + componentFraction(q, i, 'cross', ref)).toBeCloseTo(1, 12);
    }
    // On the phi = 0 plane, Ludwig-3 with an x reference is E_theta; at phi = 90 with a y reference too.
    const at = (t: number, ph: number) => (t / 2) * q.nP + ph / 2;
    expect(componentFraction(q, at(30, 0), 'co', 'x')).toBeCloseTo(componentFraction(q, at(30, 0), 'theta'), 12);
    expect(componentFraction(q, at(30, 90), 'co', 'y')).toBeCloseTo(componentFraction(q, at(30, 90), 'theta'), 12);
    expect(componentFraction(p, at(60, 0), 'phi')).toBe(0);
  });

  it('auto Ludwig-3 reference follows the polarization at the beam', () => {
    // x-polarized aperture: E_theta = cos(theta) cos(phi), E_phi = -sin(phi).
    const ff = shortDipoleFF(2);
    let i = 0;
    for (const t of ff.thetaDeg!)
      for (const ph of ff.phiDeg!) {
        const tr = (t * Math.PI) / 180, pr = (ph * Math.PI) / 180;
        ff.eThetaRe![i] = Math.cos(tr) * Math.cos(pr);
        ff.ePhiRe![i] = -Math.sin(pr) || 0;
        ff.directivityPattern![i++] = 1;
      }
    const q = patternOf(ff)!;
    expect(dominantLudwigRef(q, 0, 0)).toBe('x');
    // Rotated 90 degrees about z it is y-polarized.
    i = 0;
    for (const t of ff.thetaDeg!)
      for (const ph of ff.phiDeg!) {
        const tr = (t * Math.PI) / 180, pr = (ph * Math.PI) / 180;
        ff.eThetaRe![i] = Math.cos(tr) * Math.sin(pr);
        ff.ePhiRe![i++] = Math.cos(pr);
      }
    expect(dominantLudwigRef(patternOf(ff)!, 0, 0)).toBe('y');
  });

  it('3D mesh: one vertex per sample, closed seam, radius equals the peak', () => {
    const m = patternMesh(p, total, { db: true, rangeDb: 30, radius: 10 });
    expect(m.positions.length).toBe(p.nT * p.nP * 3);
    expect(m.indices.length).toBe((p.nT - 1) * p.nP * 6);
    let rmax = 0;
    for (let i = 0; i < m.positions.length; i += 3) rmax = Math.max(rmax, Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
    expect(rmax).toBeCloseTo(10, 5); // float32 positions
  });
});

describe('CSV export', () => {
  it('raw columns round-trip exactly, including awkward doubles', () => {
    const ff = shortDipoleFF(30);
    const awkward = [0.1 + 0.2, 1e-300, 5e-324, 123456789.123456789, -2.5e-17, Math.PI];
    ff.directivityPattern = ff.directivityPattern!.map((v, i) => v + awkward[i % awkward.length]);
    const { header, rows } = parseCsv(patternCsv(ff, 'synthetic'));
    expect(header[2]).toBe('directivity_lin');
    rows.forEach((row, i) => {
      expect(Number(row[2])).toBe(ff.directivityPattern![i]);
      expect(Number(row[3])).toBe(ff.eThetaRe![i]);
    });
  });

  it('port and summary CSVs carry the solver values and empty fields for unavailable ones', () => {
    const ff = { ...shortDipoleFF(30), gainDbi: null };
    const r = resultsWith(ff);
    const port = parseCsv(portCsv(r, 'x'));
    expect(port.rows[0].slice(0, 3).map(Number)).toEqual([1e9, 50, 0]);
    const sum = parseCsv(farFieldSummaryCsv(r, 'x'));
    expect(sum.rows[0][sum.header.indexOf('gain_dBi')]).toBe('');
    expect(Number(sum.rows[0][sum.header.indexOf('directivity_dBi')])).toBe(ff.directivityDbi);
  });
});

describe('exports and project files', () => {
  it('display settings never change exported data', () => {
    const r = resultsWith(shortDipoleFF(10));
    // The full view state goes in, as the Export buttons pass it.
    const v1: ResultView = { ...DEFAULT_VIEW, rangeDb: 10, db: true, quantity: 'normalized', polarization: 'co' };
    const v2: ResultView = { ...DEFAULT_VIEW, rangeDb: 70, db: false, quantity: 'realizedGain', polarization: 'cross', elevationPhi: 90 };
    const a = csvExports(r, 'case', v1);
    const b = csvExports(r, 'case', v2);
    expect(a.map((f) => f.fileName)).toEqual(['case_port.csv', 'case_farfield.csv', 'case_pattern_1.0000GHz.csv']);
    expect(a).toEqual(b);
  });

  it('project files keep saved results exactly, with their metadata and the simulation settings', async () => {
    const m = await loadFixture('dipole.step');
    const ff = shortDipoleFF(10);
    ff.directivityPattern = ff.directivityPattern!.map((v) => v * (1 + 1e-13) + 1e-301);
    const saved = { id: 'run-1', label: 'dipole · 12:00', hash: 'abc', finishedAt: 1, lossless: true, center: [0, 0, 1] as [number, number, number], results: resultsWith(ff) };
    const settings = { ...DEFAULT_SIM_SETTINGS, energyDb: -70 };
    const zip = writeProjectZip({ model: m, stepBytes: fixtureBytes('dipole.step'), units: { override: null, confirmed: true }, assignments: {}, materials: BUILTIN_MATERIALS, port: null, frequency: DEFAULT_FREQ, simulation: settings, results: [saved] }, true);
    const back = readProjectZip(zip);
    expect(back.project.simulation).toEqual(settings);
    expect(back.droppedResults).toBe(0);
    expect(back.results).toHaveLength(1);
    expect(back.results[0]).toEqual(saved);
    expect(back.results[0].results.farField[0].directivityPattern).toEqual(ff.directivityPattern);
  });
});

describe('port and run helpers', () => {
  it('-10 dB band brackets the |S11| minimum, open at the band edge', () => {
    const f = [1, 2, 3, 4, 5].map((x) => x * 1e9);
    const s11 = [-3, -12, -25, -8, -2].map((db) => 10 ** (db / 20));
    const port = { z0: 50, frequencies: f, zinRe: f.map(() => 50), zinIm: f.map(() => 0), s11Re: s11, s11Im: f.map(() => 0), pAcc: f.map(() => 1), pInc: f.map(() => 1), sourceDb: f.map(() => 0) };
    const b = matchedBand(port)!;
    expect(b.fLo).toBeCloseTo(1e9 + (7 / 9) * 1e9, 3);
    expect(b.fHi).toBeCloseTo(3e9 + (15 / 17) * 1e9, 3);
    expect(b.openLo || b.openHi).toBe(false);
    expect(matchedBand({ ...port, s11Re: port.s11Re.map((v) => Math.max(v, 0.5)) })).toBeNull();
    expect(matchedBand({ ...port, s11Re: [-20, -25, -8, -2, -1].map((db) => 10 ** (db / 20)) })!.openLo).toBe(true);
  });

  it('time-left estimate follows a steady energy decay and stays silent before it', () => {
    const decay = Array.from({ length: 40 }, (_, i) => ({ t: i, db: i < 10 ? 0 : -2 * (i - 10) }));
    expect(remainingSeconds(decay.slice(0, 10), -60)).toBeNull(); // still at the peak
    expect(remainingSeconds(decay, -60)).toBeCloseTo((-60 - -58) / -2, 9); // 1 s left at 2 dB/s
  });
});

describe('availability', () => {
  it('without a port, gain-type quantities are unavailable with a reason', () => {
    const a = farFieldAvail(resultsWith(shortDipoleFF(30), false), shortDipoleFF(30), true);
    expect(a.directivityDbi.state).toBe('ok');
    expect(a.gainDbi).toEqual({ state: 'unavailable', reason: 'the problem has no port' });
  });

  it('flags capped runs, weak excitation, power mismatch and P_acc <= 0', () => {
    const ff = { ...shortDipoleFF(30), pAcc: 1, pInc: 2, gainDbi: 1, realizedGainDbi: 0, efficiency: 1, s11Db: -10 };
    const r = resultsWith(ff);
    expect(farFieldAvail(r, ff, true).gainDbi.state).toBe('ok');
    r.run.terminatedBy = 'maxSteps';
    expect(farFieldAvail(r, ff, true).gainDbi).toMatchObject({ state: 'unreliable', reason: expect.stringContaining('step cap') });
    r.run.terminatedBy = 'energy';
    expect(farFieldAvail(r, { ...ff, sourceDb: -45 }, true).directivityDbi).toMatchObject({ state: 'unreliable', reason: expect.stringContaining('excitation') });
    expect(farFieldAvail(r, { ...ff, pRadPoynting: 1.2 }, true).directivityDbi).toMatchObject({ state: 'unreliable', reason: expect.stringContaining('Poynting') });
    expect(farFieldAvail(r, { ...ff, pAcc: -1, gainDbi: null, efficiency: null }, true).gainDbi).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('accepted power') });
    expect(farFieldAvail(r, { ...ff, pAcc: 0.8 }, true).efficiency).toMatchObject({ state: 'unreliable', reason: expect.stringContaining('energy balance') });
    expect(farFieldAvail(r, { ...ff, pAcc: 0.8 }, false).efficiency.state).toBe('ok');
    expect(portSampleCaveats(r, { ...r.port!, s11Re: [1.1] })[0]).toContain('|S11| > 1');
    expect(isLossless({ materials: [{ sigma: 0 }] })).toBe(true);
    expect(isLossless({ materials: [{ sigma: 1e-3 }] })).toBe(false);
    expect(isLossless({ materials: [{ type: 'metal' }] })).toBe(false); // conductor loss
  });
});

describe.skipIf(!existsSync(CLI))('validation dipole (native solver)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antsim-m4-'));
  const run = () => {
    const out = join(dir, 'r.json');
    if (!existsSync(out)) execFileSync(CLI, ['run', join(ROOT, 'validation/cases/dipole/problem.json'), '--out', out], { stdio: 'ignore' });
    return JSON.parse(readFileSync(out, 'utf8')) as ResultsJson;
  };

  it('E-plane HPBW of the half-wave dipole is 78 ± 2 degrees and the pattern is symmetric', () => {
    const r = run();
    const ff = r.farField.find((f) => f.frequency === 0.95e9)!;
    const p = patternOf(ff) as Pattern;
    const d = patternValues(p, 1, 'total');
    const w = hpbw(elevationCut(p, d, 0))!;
    expect(Math.abs(w - 78)).toBeLessThan(2);
    expect(Math.abs(frontToBack(p, d, ff.beamThetaDeg, ff.beamPhiDeg))).toBeLessThan(0.1);
  }, 120_000);

  it('CSV fields equal the C++ output exactly', () => {
    const r = run();
    const port = parseCsv(portCsv(r, 'dipole'));
    port.rows.forEach((row, i) => {
      expect(Number(row[0])).toBe(r.port!.frequencies[i]);
      expect(Number(row[1])).toBe(r.port!.zinRe[i]);
      expect(Number(row[2])).toBe(r.port!.zinIm[i]);
      expect(Number(row[5])).toBe(r.port!.pAcc[i]);
    });
    const ff = r.farField[0];
    const pat = parseCsv(patternCsv(ff, 'dipole'));
    expect(pat.rows.length).toBe(ff.directivityPattern!.length);
    pat.rows.forEach((row, i) => {
      expect(Number(row[2])).toBe(ff.directivityPattern![i]);
      expect(Number(row[6])).toBe(ff.ePhiIm![i]);
    });
  }, 120_000);
});

describe('results dashboard rendering', () => {
  const html = (r: ResultsJson, lossless = true) => {
    useSim.getState().reset(undefined, [{ id: 'r', key: '', hash: 'h', results: r, finishedAt: 0, label: 'case', lossless, center: [0, 0, 0], source: 'run' }]);
    // Server rendering reads zustand's initial state (the server snapshot); copy the live state into it.
    Object.assign(useSim.getInitialState(), useSim.getState());
    return renderToStaticMarkup(createElement(ResultsDashboard));
  };

  it('renders unavailable quantities as "—" with the reason', () => {
    const out = html(resultsWith(shortDipoleFF(10), false));
    expect(out).toContain('— (the problem has no port)');
    expect(out).toMatch(/data-testid="sum-g" data-state="unavailable">— <span[^>]*>\(the problem has no port\)/);
    expect(out).toMatch(/data-testid="sum-d" data-state="ok">1\.76 dBi/);
  });

  it('flags unreliable values next to the number and shows the HPBW', () => {
    const r = resultsWith({ ...shortDipoleFF(10), pAcc: 1, pInc: 1, gainDbi: 1.76, realizedGainDbi: 1.76, efficiency: 1, s11Db: -30 });
    r.run.terminatedBy = 'maxSteps';
    const out = html(r);
    expect(out).toContain('unreliable: the run stopped at the step cap');
    const p10 = patternOf(shortDipoleFF(10))!;
    expect(out).toContain(`HPBW (Total): ${hpbw(elevationCut(p10, patternValues(p10, 1, 'total'), 0))!.toFixed(1)}°`);
  });
});

// M2/M3 validation: runs the native solver on validation/cases, compares with the
// openEMS references (validation/openems/run_problem.py, same grid) and with
// analytical expectations, and writes validation/report/validation-report.md.
// The patch cases come from validation/cases/make_step_cases.mjs (STEP import).
//
//   node validation/run_validation.mjs [--rerun] [--wasm]
//
// --rerun  re-run cases even if out/antsim.json exists
// --wasm   also run the dipole in the single-thread wasm build under Node and
//          compare it with the native result (needs `npm run wasm`)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const CASES = join(ROOT, 'validation/cases');
const CLI = join(ROOT, 'build/native-release/antsim_cli');
const TOL = JSON.parse(readFileSync(join(ROOT, 'validation/tolerances.json'), 'utf8'));
const args = new Set(process.argv.slice(2));

const rows = []; // { group, check, value, limit, pass }
const check = (group, name, value, limit, pass, fmt = (v) => v) =>
  rows.push({ group, check: name, value: fmt(value), limit, pass });

// ------------------------------------------------------------------ runs
function runCase(name, problemOverride) {
  const dir = join(CASES, name.split('@')[0]);
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  const tag = name.includes('@') ? name.split('@')[1] : '';
  const out = join(outDir, tag ? `antsim_${tag}.json` : 'antsim.json');
  let probPath = join(dir, 'problem.json');
  if (problemOverride) {
    const p = JSON.parse(readFileSync(probPath, 'utf8'));
    problemOverride(p);
    probPath = join(outDir, `problem_${tag}.json`);
    writeFileSync(probPath, JSON.stringify(p));
  }
  if (args.has('--rerun') || !existsSync(out)) {
    process.stdout.write(`running ${name} ... `);
    execFileSync(CLI, ['run', probPath, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    process.stdout.write('done\n');
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}

function reference(name) {
  const p = join(CASES, name, 'out/reference.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// ------------------------------------------------------------------ metrics
const cAbs = (re, im) => Math.hypot(re, im);
function zin(port) {
  return port.frequencies.map((f, i) => ({ f, re: port.zinRe[i], im: port.zinIm[i] }));
}
/** Series resonance: Im(Zin) = 0 crossing closest to the |S11| minimum, linearly interpolated. */
function resonance(port, z0 = 50) {
  const z = zin(port);
  let best = 0;
  z.forEach((p, i) => {
    const s = cAbs(p.re - z0, p.im) / cAbs(p.re + z0, p.im);
    const sb = cAbs(z[best].re - z0, z[best].im) / cAbs(z[best].re + z0, z[best].im);
    if (s < sb) best = i;
  });
  let cand = null;
  for (let i = 1; i < z.length; i++) {
    if (z[i - 1].im <= 0 !== z[i].im <= 0) {
      const t = -z[i - 1].im / (z[i].im - z[i - 1].im);
      const f = z[i - 1].f + t * (z[i].f - z[i - 1].f);
      const r = z[i - 1].re + t * (z[i].re - z[i - 1].re);
      if (!cand || Math.abs(i - best) < Math.abs(cand.i - best)) cand = { i, f, r };
    }
  }
  return cand;
}
function maxRelZDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.frequencies.length; i++) {
    const d = cAbs(a.zinRe[i] - b.zinRe[i], a.zinIm[i] - b.zinIm[i]) / cAbs(b.zinRe[i], b.zinIm[i]);
    m = Math.max(m, d);
  }
  return m;
}
/** |S11| minimum with a parabolic fit through the three samples around it (dB on a 50 ohm port). */
function s11Min(port, z0 = 50) {
  const db = zin(port).map((p) => 20 * Math.log10(cAbs(p.re - z0, p.im) / cAbs(p.re + z0, p.im)));
  let i = db.indexOf(Math.min(...db));
  i = Math.min(Math.max(i, 1), db.length - 2);
  const [y0, y1, y2] = [db[i - 1], db[i], db[i + 1]];
  const den = y0 - 2 * y1 + y2;
  const t = den > 0 ? (0.5 * (y0 - y2)) / den : 0;
  const df = port.frequencies[i + 1] - port.frequencies[i];
  return { f: port.frequencies[i] + t * df, db: y1 - 0.25 * (y0 - y2) * t };
}
const ff = (r, f) => r.farField.find((x) => Math.abs(x.frequency - f) < 1);
const pct = (v) => `${(100 * v).toFixed(3)} %`;
const db = (v) => `${v.toFixed(3)} dB`;
const ghz = (v) => `${(v / 1e9).toFixed(4)} GHz`;

/** Compact key numbers for the browser benchmark panel (app/src/ui/BenchmarkPanel.tsx). */
function writeExpected(name, a, ref) {
  const r = resonance(a.port);
  const rr = ref ? resonance(ref.port) : null;
  const byF = (list) => Object.fromEntries(list.map((x) => [String(x.frequency), x.directivityDbi]));
  const exp = {
    native: { fRes: r.f, rRes: r.r, directivityDbi: byF(a.farField), steps: a.run.steps },
    openems: ref ? { fRes: rr.f, directivityDbi: byF(ref.farField) } : null,
  };
  writeFileSync(join(CASES, name, 'expected.json'), JSON.stringify(exp, null, 1) + '\n');
}

// ------------------------------------------------------------------ 1. comparisons with openEMS
for (const name of ['dipole', 'monopole']) {
  const a = runCase(name);
  const ref = reference(name);
  writeExpected(name, a, ref);
  const t = TOL.openems;
  if (!ref) {
    check(`vs openEMS: ${name}`, 'reference available', 'missing', 'run validation/openems/run_problem.py', false);
    continue;
  }
  check(`vs openEMS: ${name}`, 'max |ΔZin| / |Zin| over band', maxRelZDiff(a.port, ref.port), `< ${pct(t.zinRel)}`, maxRelZDiff(a.port, ref.port) < t.zinRel, pct);
  const ra = resonance(a.port), rr = resonance(ref.port);
  const df = Math.abs(ra.f - rr.f) / rr.f;
  check(`vs openEMS: ${name}`, `f_res ${ghz(ra.f)} vs ${ghz(rr.f)}`, df, `< ${pct(t.fResRel)}`, df < t.fResRel, pct);
  for (const fr of ref.farField) {
    const mine = ff(a, fr.frequency);
    const dD = Math.abs(mine.directivityDbi - fr.directivityDbi);
    check(`vs openEMS: ${name}`, `D at ${ghz(fr.frequency)}: ${mine.directivityDbi.toFixed(3)} vs ${fr.directivityDbi.toFixed(3)} dBi`, dD, `< ${t.dDb} dB`, dD < t.dDb, db);
    const dEff = Math.abs(mine.efficiency - fr.efficiency);
    check(`vs openEMS: ${name}`, `P_rad/P_acc at ${ghz(fr.frequency)}: ${mine.efficiency.toFixed(4)} vs ${fr.efficiency.toFixed(4)}`, dEff, `< ${t.effAbs}`, dEff < t.effAbs, (v) => v.toFixed(4));
  }
}

// ------------------------------------------------------------------ 2. dipole physics
{
  const a = runCase('dipole');
  const t = TOL.dipolePhysics;
  const r = resonance(a.port);
  const lam = 299792458 / r.f;
  const L = 0.1475; // tip to tip, m
  check('dipole physics', 'L / λ at series resonance', L / lam, `${t.lOverLambda[0]} – ${t.lOverLambda[1]}`, L / lam >= t.lOverLambda[0] && L / lam <= t.lOverLambda[1], (v) => v.toFixed(4));
  check('dipole physics', 'R at series resonance', r.r, `${t.rRes[0]} – ${t.rRes[1]} Ω`, r.r >= t.rRes[0] && r.r <= t.rRes[1], (v) => `${v.toFixed(2)} Ω`);
  const near = ff(a, 0.95e9);
  check('dipole physics', 'D at 0.95 GHz (thin λ/2 dipole: 2.15 dBi)', near.directivityDbi, `2.15 ± ${t.dTol} dBi`, Math.abs(near.directivityDbi - 2.15) < t.dTol, (v) => `${v.toFixed(3)} dBi`);
  for (const x of a.farField) {
    check('dipole physics', `energy balance P_rad/P_acc at ${ghz(x.frequency)}`, x.efficiency, `1 ± ${t.effTol}`, Math.abs(x.efficiency - 1) < t.effTol, (v) => v.toFixed(4));
    const box = x.pRad / x.pRadPoynting;
    check('dipole physics', `P_rad far field / Poynting box at ${ghz(x.frequency)}`, box, `1 ± ${t.boxTol}`, Math.abs(box - 1) < t.boxTol, (v) => v.toFixed(5));
  }
}

// ------------------------------------------------------------------ 3. absorbing-boundary sensitivity
{
  const base = runCase('dipole');
  const t = TOL.boundary;
  for (const v of ['dipole_pml16', 'dipole_pad2']) {
    const r = runCase(v);
    const dz = maxRelZDiff(r.port, base.port);
    check('boundary sensitivity', `${v}: max |ΔZin|/|Zin| vs base`, dz, `< ${pct(t.zinRel)}`, dz < t.zinRel, pct);
    for (const x of base.farField) {
      const dD = Math.abs(ff(r, x.frequency).directivityDbi - x.directivityDbi);
      check('boundary sensitivity', `${v}: ΔD at ${ghz(x.frequency)}`, dD, `< ${t.dDb} dB`, dD < t.dDb, db);
    }
  }
}

// ------------------------------------------------------------------ 4. mesh refinement (square-arm dipole)
{
  const t = TOL.refinement;
  const levels = [['2.5', 2.5], ['1.25', 1.25], ['0.833', 2.5 / 3]].map(([tag, h]) => {
    const r = runCase(`dipole_sq_h${tag}`);
    return { h, f: resonance(r.port).f, d: ff(r, 0.95e9).directivityDbi, cells: r.run.cells, steps: r.run.steps };
  });
  for (const l of levels) check('mesh refinement', `h = ${l.h.toFixed(3)} mm: f_res ${ghz(l.f)}, D ${l.d.toFixed(3)} dBi (${l.cells.toLocaleString()} cells)`, 0, 'info', true, () => '—');
  const [, b, c] = levels;
  const df = Math.abs(c.f - b.f) / c.f;
  check('mesh refinement', 'finest pair Δf_res', df, `< ${pct(t.fResRel)}`, df < t.fResRel, pct);
  const dD = Math.abs(c.d - b.d);
  check('mesh refinement', 'finest pair ΔD (0.95 GHz)', dD, `< ${t.dDb} dB`, dD < t.dDb, db);
  // Observed order from three levels with ratios h1/h2 = 2, h2/h3 = 1.5: solve (f1-f2)/(f2-f3) = (h1^p - h2^p)/(h2^p - h3^p).
  const q = (levels[0].f - b.f) / (b.f - c.f);
  let p = NaN;
  if (Number.isFinite(q) && q > 0) {
    let lo = 0.2, hi = 4;
    const g = (pp) => (2.5 ** pp - 1.25 ** pp) / (1.25 ** pp - (2.5 / 3) ** pp) - q;
    if (g(lo) * g(hi) < 0) {
      for (let i = 0; i < 80; i++) {
        const m = 0.5 * (lo + hi);
        if (g(lo) * g(m) <= 0) hi = m;
        else lo = m;
      }
      p = 0.5 * (lo + hi);
    }
  }
  const monotone = (levels[0].f - b.f) * (b.f - c.f) > 0;
  const orderText = Number.isFinite(p) ? p.toFixed(2) : monotone ? (q < 1.71 ? 'below 0.2 (monotone, slow)' : 'above 4') : 'n/a (non-monotone)';
  check('mesh refinement', 'observed convergence order of f_res', p, 'info (PEC edges and the feed gap are field singularities, so convergence is slower than O(h²))', true, () => orderText);
}

// ------------------------------------------------------------------ 4b. conformal conductors
{
  // A top-hat dipole, whose resonance follows the hats' shape, rotated about the feed axis:
  // the same antenna, against its axis-aligned twin on the same grid lines.
  const t = TOL.conformal;
  const rotated = (tag, deg, conformal) =>
    runCase(`dipole_hat_h${tag}@r${deg}${conformal ? 'c' : 's'}`, (p) => {
      const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
      for (const o of p.objects) {
        if (o.type !== 'mesh') continue;
        for (let i = 0; i < o.positions.length; i += 3) {
          const [x, y] = [o.positions[i], o.positions[i + 1]];
          o.positions[i] = c * x - s * y;
          o.positions[i + 1] = s * x + c * y;
        }
      }
      p.conformal = conformal;
    });
  const levels = ['2.5', '1.25'].map((tag) => {
    const twin = runCase(`dipole_hat_h${tag}`);
    const f0 = resonance(twin.port).f;
    const gap = (r) => resonance(r.port).f / f0 - 1;
    const c30 = rotated(tag, 30, true), c45 = rotated(tag, 45, true), s30 = rotated(tag, 30, false), s45 = rotated(tag, 45, false);
    const out = { tag, f0, c30: gap(c30), c45: gap(c45), s30: gap(s30), s45: gap(s45), effTwin: ff(twin, 0.75e9).efficiency, effC: Math.max(Math.abs(ff(c30, 0.75e9).efficiency - ff(twin, 0.75e9).efficiency), Math.abs(ff(c45, 0.75e9).efficiency - ff(twin, 0.75e9).efficiency)) };
    check('conformal conductors', `hats rotated 30° / 45°, h = ${tag} mm, f_res vs axis-aligned twin (${ghz(f0)}): staircase ${pct(out.s30)} / ${pct(out.s45)}, conformal ${pct(out.c30)} / ${pct(out.c45)}`, 0, 'info', true, () => '—');
    return out;
  });
  const [coarse, fine] = levels;
  const spread = (a, b) => Math.abs(a - b);
  check('conformal conductors', 'conformal: f_res difference between 30° and 45°, 2.5 mm cells', spread(coarse.c30, coarse.c45), `< ${pct(t.spreadCoarse)}`, spread(coarse.c30, coarse.c45) < t.spreadCoarse, pct);
  check('conformal conductors', 'conformal: f_res difference between 30° and 45°, 1.25 mm cells', spread(fine.c30, fine.c45), `< ${pct(t.spreadFine)}`, spread(fine.c30, fine.c45) < t.spreadFine, pct);
  const gain = Math.min(spread(coarse.s30, coarse.s45) / spread(coarse.c30, coarse.c45), spread(fine.s30, fine.s45) / spread(fine.c30, fine.c45));
  check('conformal conductors', 'that difference, staircase / conformal (worse of the two grids)', gain, `> ${t.minSpreadGain}`, gain > t.minSpreadGain, (v) => v.toFixed(1));
  const worst45 = Math.abs(fine.c45);
  check('conformal conductors', 'conformal: f_res vs twin at 45°, 1.25 mm cells', worst45, `< ${pct(t.gapFine)}`, worst45 < t.gapFine, pct);
  const shrink = Math.abs(coarse.c45 / fine.c45);
  check('conformal conductors', 'conformal: that gap shrinks when the cell halves (ratio)', shrink, `> ${t.minShrink}`, shrink > t.minShrink, (v) => v.toFixed(2));
  const dEff = Math.max(coarse.effC, fine.effC);
  check('conformal conductors', 'conformal: radiation efficiency vs twin (0.75 GHz)', dEff, `< ${t.effAbs}`, dEff < t.effAbs, (v) => v.toFixed(5));

  // A slender round metal dipole: its resonance follows length and feed gap, not surface shape,
  // so conformal faces change little here. Reported, with no limit.
  const tags = [['2.5', 2.5], ['1.25', 1.25], ['0.833', 2.5 / 3]];
  const run = (tag, staircase) => {
    const r = staircase ? runCase(`dipole_round_h${tag}@staircase`, (p) => { p.conformal = false; }) : runCase(`dipole_round_h${tag}`);
    return { f: resonance(r.port).f, eff: ff(r, 0.95e9).efficiency };
  };
  const conf = tags.map(([tag]) => run(tag, false)), stair = tags.map(([tag]) => run(tag, true));
  tags.forEach(([, h], i) => {
    const e = (x) => `${(100 * (x.f / conf[2].f - 1)).toFixed(2)} %`;
    check('conformal conductors', `round dipole, h = ${h.toFixed(3)} mm, f_res vs finest conformal: staircase ${e(stair[i])}, conformal ${e(conf[i])}; efficiency ${stair[i].eff.toFixed(4)} / ${conf[i].eff.toFixed(4)}`, 0, 'info', true, () => '—');
  });
}

// ------------------------------------------------------------------ 5. far-field angular resolution
{
  const t = TOL.angular;
  const variant = (tag, step, quad) =>
    runCase(`dipole@${tag}`, (p) => {
      p.farField.thetaStep = step;
      p.farField.phiStep = step;
      p.farField.quadTheta = quad;
      p.farField.quadPhi = 2 * quad;
    });
  const coarse = variant('ang5', 5, 12), mid = runCase('dipole'), fine = variant('ang1', 1, 96);
  for (const x of mid.farField) {
    const pr = (r) => ff(r, x.frequency).pRad;
    const d1 = Math.abs(10 * Math.log10(pr(coarse) / pr(fine))), d2 = Math.abs(10 * Math.log10(pr(mid) / pr(fine)));
    check('angular resolution', `P_rad quadrature 12×24 vs 96×192 at ${ghz(x.frequency)}`, d1, `< ${t.pRadDb} dB`, d1 < t.pRadDb, db);
    check('angular resolution', `P_rad quadrature 48×96 vs 96×192 at ${ghz(x.frequency)}`, d2, `< ${t.pRadDb} dB`, d2 < t.pRadDb, db);
    const dd = Math.abs(ff(coarse, x.frequency).directivityDbi - ff(fine, x.frequency).directivityDbi);
    check('angular resolution', `D on 5° vs 1° display grid at ${ghz(x.frequency)}`, dd, `< ${t.dDb} dB`, dd < t.dDb, db);
  }
}

// ------------------------------------------------------------------ 6. termination sensitivity
{
  const strict = runCase('dipole');
  const loose = runCase('dipole@end50', (p) => {
    p.termination.energyDb = -50;
  });
  const dz = maxRelZDiff(loose.port, strict.port);
  check('termination', `dipole Zin, end criterion -50 dB (${loose.run.steps} steps) vs -70 dB (${strict.run.steps} steps)`, dz, 'info (band edges, where the excitation is -20 dB)', true, pct);
}

// ------------------------------------------------------------------ 7. STEP patch (dielectric) vs openEMS
{
  const t = TOL.patch;
  const g = 'STEP patch vs openEMS';
  const a = runCase('patch_step');
  const twin = runCase('patch_step_prim');
  const dz = maxRelZDiff(a.port, twin.port);
  check(g, 'STEP-built vs primitive twin (same grid): max |ΔZin|/|Zin|', dz, `< ${t.twinRel}`, dz < t.twinRel, (v) => v.toExponential(2));
  const pec = (r) => r.mesh.pecEdges;
  check(g, `PEC edges STEP vs twin: ${pec(a)} vs ${pec(twin)}`, pec(a) - pec(twin), '= 0', pec(a) === pec(twin), (v) => String(v));
  const ref = reference('patch_step_prim');
  if (!ref) check(g, 'reference available', 'missing', 'run validation/openems/run_problem.py on patch_step_prim', false);
  else {
    const fa = s11Min(a.port), fr = s11Min(ref.port);
    const df = Math.abs(fa.f - fr.f) / fr.f;
    check(g, `f_res (|S11| min) ${ghz(fa.f)} (${fa.db.toFixed(1)} dB) vs ${ghz(fr.f)} (${fr.db.toFixed(1)} dB)`, df, `< ${pct(t.fResRel)}`, df < t.fResRel, pct);
    const dzr = maxRelZDiff(a.port, ref.port);
    check(g, 'max |ΔZin| / |Zin| over band', dzr, `< ${pct(t.zinRel)}`, dzr < t.zinRel, pct);
    for (const x of ref.farField) {
      const mine = ff(a, x.frequency);
      const dD = Math.abs(mine.directivityDbi - x.directivityDbi);
      check(g, `D at ${ghz(x.frequency)}: ${mine.directivityDbi.toFixed(3)} vs ${x.directivityDbi.toFixed(3)} dBi`, dD, `< ${t.dDb} dB`, dD < t.dDb, db);
      const dEff = Math.abs(mine.efficiency - x.efficiency);
      check(g, `radiation efficiency at ${ghz(x.frequency)}: ${mine.efficiency.toFixed(4)} vs ${x.efficiency.toFixed(4)}`, dEff, `< ${t.effAbs}`, dEff < t.effAbs, (v) => v.toFixed(4));
    }
    for (const x of a.farField) {
      const box = x.pRad / x.pRadPoynting;
      check(g, `P_rad far field / Poynting box at ${ghz(x.frequency)}`, box, `1 ± ${TOL.dipolePhysics.boxTol}`, Math.abs(box - 1) < TOL.dipolePhysics.boxTol, (v) => v.toFixed(5));
    }
  }
}

// ------------------------------------------------------------------ 8. pattern metrics (M4), with the app's own pattern code
{
  const t = TOL.pattern;
  const { createServer } = await import('vite');
  const server = await createServer({ root: join(ROOT, 'app'), configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  try {
    const P = await server.ssrLoadModule(join(ROOT, 'app/src/sim/pattern.ts'));
    const g = 'pattern metrics';
    const dip = runCase('dipole');
    const ffd = ff(dip, 0.95e9);
    const pd = P.patternOf(ffd);
    const dd = P.patternValues(pd, 1, 'total');
    const w = P.hpbw(P.elevationCut(pd, dd, 0));
    check(g, 'dipole E-plane HPBW at 0.95 GHz (thin λ/2 dipole: 78°)', w, `78 ± ${t.dipoleHpbwTol}°`, Math.abs(w - 78) < t.dipoleHpbwTol, (v) => `${v.toFixed(2)}°`);
    // phi = 0 elevation cut vs openEMS, where the reference is within 20 dB of its peak.
    for (const [name, refName] of [['dipole', 'dipole'], ['monopole', 'monopole'], ['patch_step', 'patch_step_prim']]) {
      const a = runCase(name);
      const ref = reference(refName);
      if (!ref) continue;
      for (const rf of ref.farField) {
        const mine = ff(a, rf.frequency);
        const p = P.patternOf(mine);
        const vals = P.patternValues(p, 1, 'total');
        const cut = P.elevationCut(p, vals, 0);
        const peak = Math.max(...rf.cutPhi0Dbi);
        let worst = 0;
        rf.thetaDeg.forEach((th, i) => {
          if (rf.cutPhi0Dbi[i] < peak - 20) return;
          let k = 0;
          cut.angleDeg.forEach((x, j) => {
            if (Math.abs(x - th) < Math.abs(cut.angleDeg[k] - th)) k = j;
          });
          worst = Math.max(worst, Math.abs(P.toDb(cut.values[k]) - rf.cutPhi0Dbi[i]));
        });
        check(g, `${name} φ = 0 cut vs openEMS at ${ghz(rf.frequency)} (within 20 dB of peak)`, worst, `< ${t.cutDb} dB`, worst < t.cutDb, db);
        const e = P.hpbw(cut), h = P.hpbw(P.elevationCut(p, vals, 90));
        const fb = P.frontToBack(p, vals, mine.beamThetaDeg, mine.beamPhiDeg);
        const fmt = (v) => (v === null ? 'none' : `${v.toFixed(1)}°`);
        check(g, `${name} at ${ghz(rf.frequency)}: HPBW φ=0 ${fmt(e)}, φ=90 ${fmt(h)}, F/B ${fb.toFixed(1)} dB`, 0, 'info', true, () => '—');
      }
    }
  } finally {
    await server.close();
  }
}

// ------------------------------------------------------------------ 9. native vs wasm
if (args.has('--wasm')) {
  const native = runCase('dipole');
  const { default: create } = await import(pathToFileURL(join(ROOT, 'app/public/wasm/antsim-st.js')).href);
  const mod = await create();
  const solver = new mod.Solver();
  const prep = JSON.parse(solver.prepare(readFileSync(join(CASES, 'dipole/problem.json'), 'utf8'), 0));
  if (!prep.ok) throw new Error(prep.error);
  const t0 = performance.now();
  let st;
  do st = JSON.parse(solver.step(500));
  while (!st.done);
  const w = JSON.parse(solver.finish(false));
  const secs = (performance.now() - t0) / 1000;
  const dz = maxRelZDiff(w.port, native.port);
  check('native vs wasm', `dipole Zin, wasm ST (${secs.toFixed(1)} s, ${w.run.steps} steps vs ${native.run.steps})`, dz, `< ${TOL.wasm.zinRel}`, dz < TOL.wasm.zinRel, (v) => v.toExponential(2));
  for (const x of native.farField) {
    const dd = Math.abs(ff(w, x.frequency).directivityDbi - x.directivityDbi);
    check('native vs wasm', `D at ${ghz(x.frequency)}`, dd, `< ${TOL.wasm.dDb} dB`, dd < TOL.wasm.dDb, (v) => v.toExponential(2));
  }
}

// ------------------------------------------------------------------ report
const failed = rows.filter((r) => !r.pass);
const groups = [...new Set(rows.map((r) => r.group))];
let md = `# Validation report\n\nGenerated ${new Date().toISOString()} by \`node validation/run_validation.mjs${process.argv.slice(2).map((a) => ' ' + a).join('')}\`.\n\n`;
md += `**${rows.length - failed.length} / ${rows.length} checks passed.** Tolerances: \`validation/tolerances.json\`. Reference solver: openEMS 0.37 on identical grid lines.\n\n`;
for (const g of groups) {
  md += `## ${g}\n\n| Check | Value | Limit | Result |\n|---|---|---|---|\n`;
  for (const r of rows.filter((x) => x.group === g)) md += `| ${r.check} | ${r.value} | ${r.limit} | ${r.limit === 'info' || r.limit.startsWith('info') ? 'info' : r.pass ? 'pass' : '**FAIL**'} |\n`;
  md += '\n';
}
const reportPath = join(ROOT, 'validation/report/validation-report.md');
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, md);
console.log(md);
if (failed.length) {
  console.error(`${failed.length} check(s) failed`);
  process.exitCode = 1;
}

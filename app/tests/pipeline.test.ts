// STEP -> project -> mesher/problem builder -> C++ voxelizer and solver.
// The native CLI runs the problems (skipped if it has not been built).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../src/model/diagnostics';
import { BUILTIN_MATERIALS } from '../src/model/materials';
import { bodyRef } from '../src/model/refs';
import type { Assignment, CadModel, PortDef, Vec3 } from '../src/model/types';
import { DEFAULT_MESH_SETTINGS, fillLines, generateMesh } from '../src/sim/mesher';
import { blockingIssues, buildSimulation, bytesToBase64, type SimBody } from '../src/sim/problemBuilder';
import { bodyByName, loadFixture } from './helpers/fixtures';
import { primitiveTwin } from './helpers/primitive';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'build/native-release/antsim_cli');
const hasCli = existsSync(CLI);

function snapshotFor(model: CadModel, assignments: Record<string, Assignment>, port: PortDef, freq: ProjectSnapshot['freq']): ProjectSnapshot {
  return { model, units: { declared: model.units, override: null, confirmed: true }, assignments, materials: BUILTIN_MATERIALS, port, freq };
}

function simBodies(model: CadModel): Map<string, SimBody> {
  return new Map(model.bodies.map((b) => [b.id, { positions: b.positions, indices: b.indices }]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runCli(problem: any): any {
  const dir = mkdtempSync(join(tmpdir(), 'antsim-'));
  writeFileSync(join(dir, 'p.json'), JSON.stringify(problem));
  execFileSync(CLI, ['run', join(dir, 'p.json'), '--out', join(dir, 'r.json'), '--no-patterns'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
}

describe('mesher', () => {
  it('fills gaps keeping fixed lines, the size limit and the grading ratio', () => {
    const fixed = [0, 0.5, 1.0, 40, 41, 100];
    const lines = fillLines(fixed, (_lo, hi) => (hi <= 1.01 ? 0.25 : 5), 1.3);
    for (const f of fixed) expect(lines).toContain(f);
    const d = lines.slice(1).map((x, i) => x - lines[i]);
    for (let i = 1; i < d.length; i++) expect(Math.max(d[i] / d[i - 1], d[i - 1] / d[i])).toBeLessThanOrEqual(1.3 * (1 + 1e-6));
    expect(Math.max(...d)).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.max(...d.slice(0, 4))).toBeLessThanOrEqual(0.25 + 1e-12);
  });

  it('meshes the openEMS patch: 3+ cells in the substrate, sheets snapped to the feed ends', async () => {
    const m = await loadFixture('patch_fr4.step');
    const sub = bodyByName(m, 'substrate'), patch = bodyByName(m, 'patch'), gnd = bodyByName(m, 'ground');
    const res = generateMesh({
      bodies: [
        { id: sub.id, name: 'substrate', bbox: sub.bbox, conductor: false, epsR: 3.38, cls: { type: 'slab', axis: 2, thickness: 1.524 } },
        { id: patch.id, name: 'patch', bbox: patch.bbox, conductor: true, epsR: 1, cls: { type: 'sheet', axis: 2, thickness: 0.035, zeroThickness: false } },
        { id: gnd.id, name: 'ground', bbox: gnd.bbox, conductor: true, epsR: 1, cls: { type: 'sheet', axis: 2, thickness: 0.035, zeroThickness: false } },
      ],
      feed: { axis: 2, start: [-6, 0, 0], end: [-6, 0, 1.524] },
      fMin: 1e9,
      fMax: 3e9,
      settings: DEFAULT_MESH_SETTINGS,
    });
    expect(res.sheets[patch.id].coord).toBeCloseTo(1.524, 9);
    expect(res.sheets[gnd.id].coord).toBeCloseTo(0, 9);
    const z = res.lines[2];
    const inSub = z.filter((v) => v > 1e-9 && v < 1.524 - 1e-9).length + 1;
    expect(inSub).toBeGreaterThanOrEqual(3);
    for (const v of [0, 1.524]) expect(z).toContain(v);
    expect(res.lines[0]).toContain(-6);
    expect(res.lines[0]).toContain(-16);
    expect(res.lines[0]).toContain(16);
    expect(res.cells).toBeLessThan(DEFAULT_MESH_SETTINGS.maxCells);
    expect(res.notes).toEqual([]);
  });
});

describe('problem builder', () => {
  it('encodes base64 like the standard encoder', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'hello world']) expect(bytesToBase64(new TextEncoder().encode(s))).toBe(btoa(s));
  });

  it('lists blocking issues before building', async () => {
    const m = await loadFixture('dipole_square.step');
    const port: PortDef = { signal: bodyRef(bodyByName(m, 'arm_top')), reference: bodyRef(bodyByName(m, 'arm_bottom')), axis: 2, lateral: [0, 0], anchor: 1.25, z0: 50, amplitude: 1 };
    const s = snapshotFor(m, {}, port, { fMin: 0.5e9, fMax: 1.5e9, farField: [1e9], cellsPerWavelength: 20 });
    const codes = blockingIssues({ ...s, units: { ...s.units, confirmed: false } }).map((d) => d.code);
    expect(codes).toContain('UNASSIGNED');
    expect(codes).toContain('UNITS_UNCONFIRMED');
    expect(() => buildSimulation(s, simBodies(m))).toThrow(/no role/);
  });
});

describe('problem builder: metal conductors', () => {
  it('emits metal materials, sheet thickness and current faces; PEC projects are unchanged', async () => {
    const m = await loadFixture('patch_fr4.step');
    const by = (n: string) => bodyByName(m, n);
    const copper = { kind: 'metal' as const, name: 'Copper', sigma: 5.8e7 };
    const port: PortDef = { signal: bodyRef(by('patch')), reference: bodyRef(by('ground')), axis: 2, lateral: [-6, 0], anchor: 0.762, z0: 50, amplitude: 1 };
    const freq = { fMin: 1e9, fMax: 3e9, farField: [], cellsPerWavelength: 20 };
    const assign = (metal: boolean): Record<string, Assignment> => ({
      [by('substrate').id]: { role: 'dielectric', materialId: 'openems-patch', priority: 0 },
      [by('patch').id]: { role: 'radiator', priority: 0, ...(metal ? { conductor: copper, sheetCurrent: 'one' as const } : {}) },
      [by('ground').id]: { role: 'ground', priority: 0, ...(metal ? { conductor: copper } : {}) },
    });
    const plan = buildSimulation(snapshotFor(m, assign(true), port, freq), simBodies(m));
    expect(plan.problem.materials).toContainEqual({ name: 'Copper', type: 'metal', conductivity: 5.8e7 });
    expect(plan.problem.metalLossFrequency).toBeCloseTo(Math.sqrt(1e9 * 3e9), 3);
    const sheets = (plan.problem.objects as { type: string; name: string; material: string; currentFaces?: number; thickness?: number }[]).filter((o) => o.type === 'sheet');
    const patch = sheets.find((o) => o.name === 'patch')!, ground = sheets.find((o) => o.name === 'ground')!;
    expect([patch.material, patch.currentFaces, ground.material, ground.currentFaces]).toEqual(['Copper', 1, 'Copper', 2]);
    expect(patch.thickness).toBeCloseTo(0.035, 6);
    // A PEC project builds the same problem JSON as before metal loss existed (its hash, and
    // so the freshness of saved results, does not change).
    const pec = buildSimulation(snapshotFor(m, assign(false), port, freq), simBodies(m)).problem;
    expect('metalLossFrequency' in pec).toBe(false);
    expect('conformal' in pec).toBe(false); // nothing here is off the grid lines
    for (const o of pec.objects as Record<string, unknown>[]) {
      if (o.type === 'mesh' && o.material !== 'openems-patch') expect(o.material).toBe('pec');
      expect('currentFaces' in o || 'thickness' in o || 'radius' in o).toBe(false);
    }
  });
});

describe.skipIf(!hasCli)('STEP pipeline vs programmatic geometry (native solver)', () => {
  it('square-arm dipole from STEP reproduces the programmatic case on the identical grid', async () => {
    const m = await loadFixture('dipole_square.step');
    const top = bodyByName(m, 'arm_top'), bottom = bodyByName(m, 'arm_bottom');
    const assignments = { [top.id]: { role: 'radiator', priority: 0 } as Assignment, [bottom.id]: { role: 'radiator', priority: 0 } as Assignment };
    const port: PortDef = { signal: bodyRef(top), reference: bodyRef(bottom), axis: 2, lateral: [0, 0], anchor: 1.25, z0: 50, amplitude: 1 };
    const s = snapshotFor(m, assignments, port, { fMin: 0.5e9, fMax: 1.5e9, farField: [0.95e9, 1e9], cellsPerWavelength: 20 });
    const ref = JSON.parse(readFileSync(join(ROOT, 'validation/cases/dipole_sq_h2.5/problem.json'), 'utf8'));
    const plan = buildSimulation(s, simBodies(m), DEFAULT_MESH_SETTINGS, [ref.grid.x, ref.grid.y, ref.grid.z]);
    // Same run settings as the programmatic case, so only the geometry path differs.
    Object.assign(plan.problem, { portFrequencies: ref.portFrequencies, termination: ref.termination, farField: ref.farField, pml: ref.pml });
    expect((plan.problem.objects as { type: string }[]).map((o) => o.type)).toEqual(['mesh', 'mesh']);
    const a = runCli(plan.problem);
    const b = runCli(ref);
    expect(a.mesh.dcConnected).toBe(false);
    expect(a.mesh.pecEdges).toBe(b.mesh.pecEdges);
    let worst = 0;
    for (let i = 0; i < b.port.frequencies.length; i++)
      worst = Math.max(worst, Math.hypot(a.port.zinRe[i] - b.port.zinRe[i], a.port.zinIm[i] - b.port.zinIm[i]) / Math.hypot(b.port.zinRe[i], b.port.zinIm[i]));
    expect(worst).toBeLessThan(1e-9);
    for (let k = 0; k < b.farField.length; k++) expect(Math.abs(a.farField[k].directivityDbi - b.farField[k].directivityDbi)).toBeLessThan(1e-9);
  }, 120_000);

  it('patch with copper solids and a substrate equals its primitive twin (sheets, dielectric mesh)', async () => {
    const m = await loadFixture('patch_fr4.step');
    const by = (n: string) => bodyByName(m, n);
    const assignments: Record<string, Assignment> = {
      [by('substrate').id]: { role: 'dielectric', materialId: 'openems-patch', priority: 0 } as Assignment,
      [by('patch').id]: { role: 'radiator', priority: 0 } as Assignment,
      [by('ground').id]: { role: 'ground', priority: 0 } as Assignment,
    };
    const port: PortDef = { signal: bodyRef(by('patch')), reference: bodyRef(by('ground')), axis: 2, lateral: [-6, 0], anchor: 0.762, z0: 50, amplitude: 1 };
    const s = snapshotFor(m, assignments, port, { fMin: 1e9, fMax: 3e9, farField: [], cellsPerWavelength: 20 });
    const plan = buildSimulation(s, simBodies(m));
    expect((plan.problem.objects as { type: string }[]).map((o) => o.type).sort()).toEqual(['mesh', 'sheet', 'sheet']);
    // Snapped to the feed ends (the feed comes from float32 CAD faces).
    expect(plan.mesh.sheets[by('patch').id].coord).toBe((plan.problem.port as { stop: Vec3 }).stop[2]);
    expect(plan.mesh.sheets[by('patch').id].coord).toBeCloseTo(1.524, 6);
    expect(plan.mesh.sheets[by('ground').id].coord).toBeCloseTo(0, 9);
    // Identical inputs give identical fields, so a short capped run is enough.
    Object.assign(plan.problem, { termination: { energyDb: -60, maxSteps: 1500 }, portFrequencies: 21 });
    const twin = primitiveTwin(plan, m);
    const a = runCli(plan.problem), b = runCli(twin);
    expect(a.mesh.objects.map((o: { pecEdges: number; cells: number }) => [o.pecEdges, o.cells])).toEqual(b.mesh.objects.map((o: { pecEdges: number; cells: number }) => [o.pecEdges, o.cells]));
    expect(a.port.zinRe).toEqual(b.port.zinRe);
    expect(a.port.zinIm).toEqual(b.port.zinIm);
  }, 120_000);

  it('cylindrical-wire dipole from STEP meshes, validates and runs end to end', async () => {
    const m = await loadFixture('dipole.step');
    const top = bodyByName(m, 'arm_top'), bottom = bodyByName(m, 'arm_bottom');
    const assignments = { [top.id]: { role: 'radiator', priority: 0 } as Assignment, [bottom.id]: { role: 'radiator', priority: 0 } as Assignment };
    const port: PortDef = { signal: bodyRef(top), reference: bodyRef(bottom), axis: 2, lateral: [0, 0], anchor: 0, z0: 50, amplitude: 1 };
    const s = snapshotFor(m, assignments, port, { fMin: 1.5e9, fMax: 3.5e9, farField: [2.4e9], cellsPerWavelength: 20 });
    const plan = buildSimulation(s, simBodies(m));
    expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(plan.mesh.cells).toBeLessThan(2_000_000);
    const r = runCli(plan.problem);
    expect(r.run.terminatedBy).toBe('energy');
    expect(r.mesh.diagnostics.filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
    const ff = r.farField[0];
    // A ~59 mm dipole at 2.4 GHz (L ~ 0.47 lambda): dipole-like directivity, energy balance.
    expect(ff.directivityDbi).toBeGreaterThan(1.9);
    expect(ff.directivityDbi).toBeLessThan(2.4);
    expect(Math.abs(ff.efficiency - 1)).toBeLessThan(0.02);
  }, 300_000);

  it('resistive-metal dipole: conformal mesh arms lose the same power as exact cylinder twins', async () => {
    const m = await loadFixture('dipole.step');
    const top = bodyByName(m, 'arm_top'), bottom = bodyByName(m, 'arm_bottom');
    const sigma = 1e4, f = 2.4e9; // poor conductor, so the loss stands well above the energy-balance error
    const conductor = { kind: 'metal' as const, name: 'Resistive', sigma };
    const port: PortDef = { signal: bodyRef(top), reference: bodyRef(bottom), axis: 2, lateral: [0, 0], anchor: 0, z0: 50, amplitude: 1 };
    const freq = { fMin: 1.5e9, fMax: 3.5e9, farField: [f], cellsPerWavelength: 20 };
    const plan = (metal: boolean) =>
      buildSimulation(
        snapshotFor(m, { [top.id]: { role: 'radiator', priority: 0, ...(metal ? { conductor } : {}) }, [bottom.id]: { role: 'radiator', priority: 0, ...(metal ? { conductor } : {}) } }, port, freq),
        simBodies(m),
      );
    const lossy = plan(true);
    // Curved conductors turn conformal mode on, so the wire calibration hint is not needed.
    expect(lossy.problem.conformal).toBe(true);
    for (const o of lossy.problem.objects as { wire?: unknown }[]) expect(o.wire).toBeUndefined();
    // Without conformal faces, the arms (4 cells across here) are passed as round wires instead.
    const staircase = buildSimulation(
      snapshotFor(m, { [top.id]: { role: 'radiator', priority: 0, conductor }, [bottom.id]: { role: 'radiator', priority: 0, conductor } }, port, freq),
      simBodies(m),
      { ...DEFAULT_MESH_SETTINGS, conformal: false },
    );
    expect('conformal' in staircase.problem).toBe(false);
    for (const o of staircase.problem.objects as { wire?: { axis: number; radius: number } }[]) {
      expect(o.wire?.axis).toBe(2);
      expect(o.wire?.radius).toBeCloseTo(1, 2);
    }
    // Twin: the same arms as exact cylinder primitives on the same grid (checked against
    // exact Q values in the C++ tests).
    const twin = {
      ...lossy.problem,
      objects: [
        { type: 'cylinder', name: 'arm_top', material: 'Resistive', axis: 2, center: [0, 0], radius: 1, range: [0.5, 29.5] },
        { type: 'cylinder', name: 'arm_bottom', material: 'Resistive', axis: 2, center: [0, 0], radius: 1, range: [-29.5, -0.5] },
      ],
    };
    const pecProblem = plan(false).problem;
    const pecTwin = { ...pecProblem, objects: twin.objects.map((o) => ({ ...o, material: 'pec' })), materials: [] };
    const r = runCli(lossy.problem), rTwin = runCli(twin), rPec = runCli(pecProblem), rPecTwin = runCli(pecTwin);
    const loss = (x: { farField: { efficiency: number }[] }, base = rPec) => 1 - x.farField[0].efficiency / base.farField[0].efficiency;
    // Ballpark: sinusoidal current on the two arms, R' of a round wire. This thick dipole is
    // electrically longer than half a wave at 2.4 GHz, so its current stays nearer the feed
    // value along the arm than the sine (measured: up to 1.05 x mid-arm) and the real loss is higher.
    const mu0 = 1.25663706212e-6, fFit = Math.sqrt(1.5e9 * 3.5e9), delta = 1 / Math.sqrt(Math.PI * fFit * mu0 * sigma), a = 1e-3;
    const rPerLength = (1 / (sigma * delta) / (2 * Math.PI * a)) * (1 + delta / (2 * a));
    const k = (2 * Math.PI * f) / 299792458, h = 0.0295;
    let i2 = 0;
    for (let z = 0.0005; z < h; z += 1e-5) i2 += 2 * 1e-5 * (Math.sin(k * (h - z)) / Math.sin(k * h)) ** 2;
    const at = r.port.frequencies.findIndex((x: number) => x >= f);
    const sine = (rPerLength * i2) / r.port.zinRe[at];
    console.log(`resistive dipole: loss ${(100 * loss(r)).toFixed(2)} % (cylinder twin ${(100 * loss(rTwin, rPecTwin)).toFixed(2)} %, sinusoidal-current estimate ${(100 * sine).toFixed(2)} %)`);
    expect(Math.abs(loss(r) / loss(rTwin, rPecTwin) - 1)).toBeLessThan(0.05);
    expect(loss(r) / sine).toBeGreaterThan(1);
    expect(loss(r) / sine).toBeLessThan(2);
  }, 600_000);
});

// Loads the single-thread wasm solver in Node and checks the embind surface,
// error handling, the memory estimate mirror and a small end-to-end solve.
// Requires `npm run wasm` first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateMemory, type ProblemJson } from '../src/sim/memoryEstimate';

const modPath = resolve(import.meta.dirname, '../public/wasm/antsim-st.js');
const casesDir = resolve(import.meta.dirname, '../../validation/cases');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<any> {
  const { default: create } = await import(pathToFileURL(modPath).href);
  return create();
}

describe.skipIf(!existsSync(modPath))('wasm solver (single-thread build)', () => {
  it('reports version and thread support', async () => {
    const mod = await load();
    expect(mod.version()).toBe('0.1.0');
    expect(mod.threadsEnabled()).toBe(false);
    expect(mod.maxThreads()).toBe(1);
  });

  it('runs the cavity benchmark and conserves energy', async () => {
    const mod = await load();
    const out = mod.runBenchmark(24, 40, 1);
    expect(out.ok).toBe(true);
    expect(Math.abs(out.result.energyEnd / out.result.energyStart - 1)).toBeLessThan(0.15);
  });

  it('returns C++ errors as values instead of throwing', async () => {
    const mod = await load();
    expect(mod.runBenchmark(2, 10, 1).error).toMatch(/cube size/);
    const s = new mod.Solver();
    const bad = JSON.parse(s.prepare('{"grid": {}}', 0));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/problem/);
    expect(JSON.parse(s.step(10)).error).toMatch(/no problem prepared/);
    s.delete();
  });

  it('prepare reports the voxelization and exports PEC and port edges for preview', async () => {
    const mod = await load();
    const problem = {
      unit: 1e-3,
      grid: { uniform: { min: [-20, -20, -20], max: [20, 20, 20], cell: 1 } },
      boundaries: 'cpml',
      objects: [
        { type: 'box', name: 'lower', min: [0, 0, -8], max: [0, 0, 0] },
        { type: 'box', name: 'upper', min: [0, 0, 1], max: [0, 0, 9] },
      ],
      port: { start: [0, 0, 0], stop: [0, 0, 1], axis: 'z' },
      excitation: { fMin: 1e9, fMax: 3e9 },
    };
    const s = new mod.Solver();
    const info = JSON.parse(s.prepare(JSON.stringify(problem), 0));
    expect(info.ok).toBe(true);
    expect(info.report.pecEdges).toBe(16);
    expect(info.report.objects.map((o: { name: string; pecEdges: number }) => [o.name, o.pecEdges])).toEqual([['lower', 8], ['upper', 8]]);
    expect(info.report.dcConnected).toBe(false);
    expect(info.portSegments).toEqual([0, 0, 0, 0, 0, 1]);
    const all = s.pecSegments(1000);
    expect(all).toBeInstanceOf(Float32Array);
    expect(all.length).toBe(16 * 6);
    expect(s.pecSegments(4).length / 6).toBeLessThanOrEqual(4);
    s.release();
    expect(s.pecSegments(10)).toBeNull();
    s.delete();
  });

  // Import exactness (an imported run post-processes bit-identically) is a native test (test_solver.cpp).
  it('exports the prepared problem for the GPU and rejects malformed imported runs', async () => {
    const mod = await load();
    const problem = readFileSync(resolve(casesDir, 'dipole/problem.json'), 'utf8');
    const p = JSON.parse(problem);
    p.termination = { energyDb: -40, maxSteps: 300 };
    p.portFrequencies = 51;
    const text = JSON.stringify(p);
    // CPU reference.
    const a = new mod.Solver();
    expect(JSON.parse(a.prepare(text, 0)).ok).toBe(true);
    let st;
    do st = JSON.parse(a.step(500));
    while (!st.done);
    const ref = JSON.parse(a.finish(false));
    a.release();
    a.delete();
    // A second solver exports what the GPU loop needs.
    const b = new mod.Solver();
    expect(JSON.parse(b.prepare(text, 0)).ok).toBe(true);
    const layout = JSON.parse(b.gpuLayout());
    expect(layout.ok).toBe(true);
    expect(layout.cpml).toHaveLength(6);
    expect(layout.nf2ff.faces).toHaveLength(6);
    const n = layout.nodes as number;
    expect(b.gpuArray('mz').length).toBe(Math.ceil(n / 2));
    expect(b.gpuArray('waveform').length).toBe(300);
    expect(b.gpuArray('bogus')).toBeNull();
    expect(b.lastError()).toMatch(/unknown GPU float array/);
    expect(b.fieldSnapshot(2).length).toBe(n);
    // Wrong sizes are rejected with a message, not a crash.
    const bad = JSON.parse(b.gpuFinish(JSON.stringify({ steps: 10, energyDb: 0, terminatedBy: 'maxSteps', seconds: 0 }), new Float64Array(3), new Float64Array(3), new Float64Array(0), false));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/series length|NF2FF import/);
    b.release();
    b.delete();
    expect(ref.run.backend).toBe('cpu');
  }, 60_000);

  it('memory estimate in TypeScript matches the C++ estimate for every validation case', async () => {
    const mod = await load();
    const cases = readdirSync(casesDir).filter((d) => existsSync(resolve(casesDir, d, 'problem.json')));
    expect(cases.length).toBeGreaterThan(3);
    for (const c of cases) {
      const text = readFileSync(resolve(casesDir, c, 'problem.json'), 'utf8');
      const cpp = JSON.parse(mod.estimate(text));
      expect(cpp.ok).toBe(true);
      const ts = estimateMemory(JSON.parse(text) as ProblemJson);
      expect(ts).toEqual({
        cells: cpp.cells,
        fields: cpp.fields,
        materials: cpp.materials,
        cpml: cpp.cpml,
        nf2ff: cpp.nf2ff,
        portSeries: cpp.portSeries,
        rasterTemp: cpp.rasterTemp,
        total: cpp.total,
      });
    }
  });

  it('enforces the memory limit before allocating', async () => {
    const mod = await load();
    const s = new mod.Solver();
    const text = readFileSync(resolve(casesDir, 'dipole/problem.json'), 'utf8');
    const r = JSON.parse(s.prepare(text, 1024 * 1024));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^MEMORY_LIMIT/);
    s.delete();
  });

  it('solves a small TEM line end to end with the expected impedance', async () => {
    const mod = await load();
    const problem = {
      unit: 1e-3,
      grid: { uniform: { min: [-30, 0, 0], max: [30, 4, 4], cell: 1 } },
      boundaries: ['cpml', 'cpml', 'pmc', 'pmc', 'pec', 'pec'],
      port: { start: [0, 0, 0], stop: [0, 4, 4], axis: 'z', resistance: 50 },
      excitation: { fMin: 1e9, fMax: 10e9 },
      portFrequencies: 10,
      termination: { energyDb: -60, maxSteps: 20000 },
    };
    const s = new mod.Solver();
    expect(JSON.parse(s.prepare(JSON.stringify(problem), 0)).ok).toBe(true);
    let st;
    do st = JSON.parse(s.step(1000));
    while (!st.done);
    expect(st.terminatedBy).toBe('energy');
    const r = JSON.parse(s.finish(false));
    s.delete();
    const z = r.port.zinRe.map((re: number, i: number) => Math.hypot(re, r.port.zinIm[i]));
    const expected = (376.73 * 4) / (2 * 4);
    for (const v of z) expect(Math.abs(v / expected - 1)).toBeLessThan(0.02);
  });
});

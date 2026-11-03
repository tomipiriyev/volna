import { useRef, useState } from 'react';
import dipoleProblem from '../../../validation/cases/dipole/problem.json?raw';
import patchProblem from '../../../validation/cases/patch_step/problem.json?raw';
import roundProblem from '../../../validation/cases/dipole_round_h2.5/problem.json?raw';
import dipoleExpected from '../../../validation/cases/dipole/expected.json';
import type { Capabilities } from '../platform/capabilities';
import { estimateMemory, formatBytes, type ProblemJson } from '../sim/memoryEstimate';
import { seriesResonance, type ResultsJson } from '../sim/results';
import { SolverClient, type SolveHandle } from '../sim/solverClient';
import type { GpuCompareResult, GpuSelfTestResult, PreparedInfo, RunProgress, SolverBackend } from '../workers/protocol';

const MEMORY_LIMIT = 1024 ** 3; // 1 GB default cap for browser runs

interface Expected {
  native: { fRes: number; rRes: number; directivityDbi: Record<string, number>; steps: number };
  openems: { fRes: number; directivityDbi: Record<string, number> } | null;
}

// Runs the half-wave wire-dipole validation case in the browser's wasm solver
// and compares it with the native C++ run and openEMS (validation/report).
export function BenchmarkPanel({ caps }: { caps: Capabilities | null }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [info, setInfo] = useState<PreparedInfo | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [results, setResults] = useState<ResultsJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variant, setVariant] = useState<string>('');
  const [backend, setBackend] = useState<SolverBackend>('cpu');
  const [gpuTest, setGpuTest] = useState<{ name: string; r: GpuSelfTestResult }[]>([]);
  const [gpuTestState, setGpuTestState] = useState<'idle' | 'running' | 'error'>('idle');
  const [gpuTestError, setGpuTestError] = useState<string | null>(null);
  const gpuOk = !!caps?.webgpu.available;
  const [compare, setCompare] = useState<{ name: string; r: GpuCompareResult }[]>([]);
  const [compareState, setCompareState] = useState<string | null>(null);
  const handle = useRef<SolveHandle | null>(null);
  const estimate = estimateMemory(JSON.parse(dipoleProblem) as ProblemJson);
  const expected = dipoleExpected as Expected;

  async function run() {
    if (!caps) return;
    setState('running');
    setError(null);
    setResults(null);
    setProgress(null);
    let client: SolverClient | null = null;
    try {
      client = await SolverClient.create(caps.threads, caps.threadsReason);
      setVariant(client.info.variant === 'mt' ? `multi-thread, ${client.info.maxThreads} threads` : 'single-thread');
      handle.current = client.solve(dipoleProblem, {
        memoryLimitBytes: MEMORY_LIMIT,
        patterns: false,
        backend,
        onPrepared: (i) => {
          setInfo(i);
          if (i.backend === 'webgpu') setVariant(`WebGPU (${i.gpuAdapter})`);
        },
        onProgress: setProgress,
      });
      const json = await handle.current.promise;
      setResults(JSON.parse(json) as ResultsJson);
      setState('done');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    } finally {
      handle.current = null;
      client?.terminate(); // release wasm memory after every run
    }
  }

  async function runGpuSelfTest() {
    if (!caps) return;
    setGpuTestState('running');
    setGpuTestError(null);
    setGpuTest([]);
    let client: SolverClient | null = null;
    try {
      client = await SolverClient.create(caps.threads, caps.threadsReason);
      const out: { name: string; r: GpuSelfTestResult }[] = [];
      for (const [name, problem] of [['λ/2 dipole', dipoleProblem], ['STEP patch (dielectric)', patchProblem], ['round metal dipole (conformal)', roundProblem]] as const) {
        out.push({ name, r: await client.gpuSelfTest(problem, 1000) });
        setGpuTest([...out]);
      }
      setGpuTestState('idle');
    } catch (e) {
      setGpuTestError((e as Error).message);
      setGpuTestState('error');
    } finally {
      client?.terminate();
    }
  }

  async function runCompare() {
    if (!caps) return;
    setCompare([]);
    setGpuTestError(null);
    let client: SolverClient | null = null;
    try {
      client = await SolverClient.create(caps.threads, caps.threadsReason);
      const out: { name: string; r: GpuCompareResult }[] = [];
      for (const [name, problem] of [['λ/2 dipole', dipoleProblem], ['STEP patch (dielectric)', patchProblem], ['round metal dipole (conformal)', roundProblem]] as const) {
        setCompareState(`Running ${name} on the CPU, then on WebGPU…`);
        out.push({ name, r: await client.gpuCompare(problem) });
        setCompare([...out]);
      }
    } catch (e) {
      setGpuTestError((e as Error).message);
    } finally {
      setCompareState(null);
      client?.terminate();
    }
  }

  const res = results?.port ? seriesResonance(results.port) : null;
  const pctDiff = (a: number, b: number) => `${(100 * (a / b - 1)).toFixed(3)} %`;
  const energyFrac = progress ? Math.min(1, Math.max(0, progress.energyDb / progress.targetDb)) : 0;

  return (
    <div className="benchmark" data-testid="benchmark">
      <div className="row">
        <select value={backend} onChange={(e) => setBackend(e.target.value as SolverBackend)} aria-label="Solver backend" data-testid="benchmark-backend">
          <option value="cpu">CPU (wasm)</option>
          <option value="webgpu" disabled={!gpuOk}>
            WebGPU{gpuOk ? '' : ' (unavailable)'}
          </option>
        </select>
        <button type="button" onClick={run} disabled={!caps || state === 'running'} data-testid="run-benchmark">
          {state === 'running' ? 'Running…' : 'Run validation dipole'}
        </button>
        {state === 'running' && (
          <button type="button" onClick={() => handle.current?.cancel()} data-testid="cancel-benchmark">
            Cancel
          </button>
        )}
        <span className="muted">
          λ/2 wire dipole, {estimate.cells.toLocaleString()} cells, about {formatBytes(estimate.total)} — validated against openEMS.
        </span>
      </div>
      {info && (
        <p className="small muted">
          {variant}; grid {info.grid.join(' × ')}, Δt {(info.dt * 1e12).toFixed(2)} ps, {formatBytes(info.memoryBytes)} allocated.
        </p>
      )}
      {progress && state === 'running' && (
        <div className="progress" data-testid="benchmark-progress">
          <div className="bar">
            <div style={{ width: `${(100 * energyFrac).toFixed(1)}%` }} />
          </div>
          <span className="small">
            step {progress.step.toLocaleString()} · field energy {progress.energyDb.toFixed(1)} dB (stops at {progress.targetDb} dB) ·{' '}
            {progress.mcellsPerSec.toFixed(0)} Mcells/s · {progress.elapsedSeconds.toFixed(1)} s
          </span>
        </div>
      )}
      {results && res && (
        <table className="kv small" data-testid="benchmark-results">
          <thead>
            <tr>
              <td>Quantity</td>
              <td>Browser</td>
              <td>Native</td>
              <td>openEMS</td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Series resonance</td>
              <td>{(res.f / 1e9).toFixed(4)} GHz</td>
              <td>
                {(expected.native.fRes / 1e9).toFixed(4)} GHz <span className="muted">({pctDiff(res.f, expected.native.fRes)})</span>
              </td>
              <td>{expected.openems ? `${(expected.openems.fRes / 1e9).toFixed(4)} GHz` : '—'}</td>
            </tr>
            <tr>
              <td>R at resonance</td>
              <td>{res.r.toFixed(2)} Ω</td>
              <td>{expected.native.rRes.toFixed(2)} Ω</td>
              <td>—</td>
            </tr>
            {results.farField.map((f) => {
              const key = String(f.frequency);
              return (
                <tr key={key}>
                  <td>Directivity at {(f.frequency / 1e9).toFixed(2)} GHz</td>
                  <td>{f.directivityDbi.toFixed(3)} dBi</td>
                  <td>{expected.native.directivityDbi[key]?.toFixed(3) ?? '—'} dBi</td>
                  <td>{expected.openems?.directivityDbi[key]?.toFixed(3) ?? '—'} dBi</td>
                </tr>
              );
            })}
            <tr>
              <td>Run</td>
              <td colSpan={3}>
                {results.run.steps.toLocaleString()} steps ({results.run.terminatedBy}), {results.run.seconds.toFixed(1)} s,{' '}
                {results.run.mcellsPerSec.toFixed(0)} Mcells/s on {results.run.threads} thread{results.run.threads === 1 ? '' : 's'}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {error && (
        <p className="error" data-testid="benchmark-error">
          {error}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" onClick={runGpuSelfTest} disabled={!caps || !gpuOk || gpuTestState === 'running'} data-testid="run-gpu-selftest">
          {gpuTestState === 'running' ? 'Comparing…' : 'GPU self-test'}
        </button>
        <span className="muted small">
          {gpuOk
            ? 'Runs the dipole and the STEP patch for 1000 steps on the CPU and on WebGPU and compares every field component.'
            : `WebGPU unavailable: ${caps?.webgpu.reason ?? 'not detected'}`}
        </span>
      </div>
      {gpuTest.length > 0 && (
        <table className="kv small" data-testid="gpu-selftest">
          <thead>
            <tr>
              <td>Problem ({gpuTest[0].r.steps} steps)</td>
              <td>Fields GPU vs CPU (relative L2) and speed</td>
            </tr>
          </thead>
          <tbody>
            {gpuTest.map(({ name, r }) => (
              <tr key={name} data-testid="gpu-selftest-row" data-worst={r.worst} data-speedup={r.cpuSeconds / r.gpuSeconds}>
                <td>{name}</td>
                <td>
                  E {r.eRel.toExponential(2)} · H {r.hRel.toExponential(2)} ({r.worst < 1e-4 ? 'within' : 'above'} the 1e-4 tolerance)
                  <span className="muted block">{['Ex', 'Ey', 'Ez', 'Hx', 'Hy', 'Hz'].map((c, i) => `${c} ${r.diffs[i].toExponential(1)}`).join(' · ')}</span>
                  <span className="block">
                    {r.cells.toLocaleString()} cells: CPU {((r.cells * r.steps) / r.cpuSeconds / 1e6).toFixed(0)} Mcells/s ({r.cpuThreads} thread{r.cpuThreads === 1 ? '' : 's'}) · WebGPU{' '}
                    {((r.cells * r.steps) / r.gpuSeconds / 1e6).toFixed(0)} Mcells/s ({r.adapter}) · ×{(r.cpuSeconds / r.gpuSeconds).toFixed(1)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" onClick={runCompare} disabled={!caps || !gpuOk || !!compareState} data-testid="run-gpu-compare">
          {compareState ? 'Comparing…' : 'GPU vs CPU, complete runs'}
        </button>
        <span className="muted small">{compareState ?? 'All problems to termination on each backend; compares Z_in over the band and D (a few minutes).'}</span>
      </div>
      {compare.length > 0 && (
        <table className="kv small" data-testid="gpu-compare">
          <tbody>
            {compare.map(({ name, r }) => (
              <tr key={name} data-testid="gpu-compare-row" data-zin={r.zinMaxRel} data-d={r.dMaxDb} data-speedup={r.cpu.seconds / r.gpu.seconds}>
                <td>{name}</td>
                <td>
                  max |ΔZ_in|/|Z_in| {(100 * r.zinMaxRel).toFixed(4)} % · max ΔD {r.dMaxDb.toFixed(4)} dB · steps {r.cpu.steps.toLocaleString()} (CPU) / {r.gpu.steps.toLocaleString()} (GPU)
                  <span className="block muted">
                    CPU {r.cpu.seconds.toFixed(1)} s on {r.cpu.threads} thread{r.cpu.threads === 1 ? '' : 's'} · WebGPU {r.gpu.seconds.toFixed(1)} s ({r.adapter}) · ×{(r.cpu.seconds / r.gpu.seconds).toFixed(1)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {gpuTestError && (
        <p className="error small" data-testid="gpu-selftest-error">
          {gpuTestError}
        </p>
      )}
    </div>
  );
}

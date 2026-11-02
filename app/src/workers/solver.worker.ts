/// <reference lib="webworker" />
// Solver worker: loads the Emscripten module (single- or multi-threaded) from
// /wasm/ at runtime and runs solver jobs off the main thread. Long runs are
// stepped in chunks sized to ~100 ms so progress can be reported and cancel
// messages handled between chunks. C++ errors arrive as {ok:false, error}.
import { GPU_ARRAY_NAMES, GpuError, GpuFdtd, requestFdtdDevice, type GpuArrays, type GpuLayout } from '../gpu/gpuFdtd';
import type { BenchmarkResult, GpuCompareResult, GpuSelfTestResult, PreparedInfo, SolverBackend, SolverRequest, SolverResponse, SolverVariant } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface EmbindSolver {
  prepare(problem: string, memoryLimitBytes: number): string;
  step(maxSteps: number): string;
  finish(patterns: boolean): string;
  pecSegments(maxSegments: number): Float32Array | null;
  gpuLayout(): string;
  gpuArray(name: string): Float32Array | Uint32Array | null;
  fieldSnapshot(comp: number): Float32Array | null;
  releaseTimeLoopStorage(): void;
  gpuFinish(run: string, voltage: Float64Array, current: Float64Array, nf2ff: Float64Array, patterns: boolean): string;
  lastError(): string;
  release(): void;
  delete(): void;
}

interface AntsimModule {
  version(): string;
  threadsEnabled(): boolean;
  maxThreads(): number;
  runBenchmark(n: number, steps: number, threads: number): { ok: boolean; error: string; result: BenchmarkResult };
  Solver: new () => EmbindSolver;
}

const TARGET_CHUNK_MS = 100;
let mod: AntsimModule | null = null;
const cancelled = new Set<number>();

function post(msg: SolverResponse) {
  self.postMessage(msg);
}

async function init(variant: SolverVariant, wasmBase: string) {
  const url = new URL(`antsim-${variant}.js`, wasmBase).href;
  const { default: create } = (await import(/* @vite-ignore */ url)) as {
    default: (opts?: object) => Promise<AntsimModule>;
  };
  mod = await create();
  post({ type: 'ready', variant, version: mod.version(), maxThreads: mod.maxThreads(), threadsEnabled: mod.threadsEnabled() });
}

class SolveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(json: string): T & { ok: boolean; error?: string } {
  const v = JSON.parse(json) as T & { ok: boolean; error?: string };
  if (!v.ok) {
    const msg = v.error ?? 'unknown solver error';
    const code = /^([A-Z_]+):/.exec(msg)?.[1] ?? 'SOLVER_ERROR';
    throw new SolveError(code, msg);
  }
  return v;
}

/** Layout and arrays of a prepared solver, for the GPU backend. */
function exportForGpu(s: EmbindSolver): { layout: GpuLayout; arrays: GpuArrays } {
  const layout = parse<GpuLayout>(s.gpuLayout());
  const arrays: GpuArrays = {};
  for (const name of GPU_ARRAY_NAMES) {
    const a = s.gpuArray(name);
    if (!a) throw new SolveError('SOLVER_ERROR', s.lastError());
    arrays[name] = a;
  }
  return { layout, arrays };
}

const gpuCode = (e: unknown) => (e instanceof GpuError ? e.code : null);

async function solveGpu(id: number, s: EmbindSolver, info: PreparedInfo, patterns: boolean, loseDeviceAfter?: number) {
  const { layout, arrays } = exportForGpu(s);
  const { device, adapterName } = await requestFdtdDevice(layout);
  let gpu: GpuFdtd | null = null;
  try {
    gpu = await GpuFdtd.create(device, layout, arrays);
    s.releaseTimeLoopStorage(); // the CPU copies of the fields are no longer needed
    post({ type: 'prepared', id, info: { ...info, backend: 'webgpu', gpuAdapter: adapterName } });
    const out = await gpu.run({
      cancelled: () => cancelled.has(id),
      loseDeviceAfter,
      onProgress: (p) =>
        post({
          type: 'progress',
          id,
          progress: { step: p.step, maxSteps: p.maxSteps, time: p.step * layout.dt, energyDb: p.energyDb, targetDb: p.targetDb, done: false, terminatedBy: '', elapsedSeconds: p.seconds, mcellsPerSec: (info.cells * p.step) / Math.max(p.seconds, 1e-6) / 1e6 },
        }),
    });
    const results = s.gpuFinish(JSON.stringify({ steps: out.steps, energyDb: out.energyDb, terminatedBy: out.terminatedBy, seconds: out.seconds }), out.voltage, out.current, out.nf2ffAcc, patterns);
    parse(results);
    post({ type: 'solved', id, results });
  } catch (e) {
    const code = gpuCode(e);
    throw code ? new SolveError(code, (e as Error).message) : e;
  } finally {
    gpu?.destroy();
    device.destroy();
  }
}

async function solve(id: number, problem: string, memoryLimitBytes: number, patterns: boolean, backend: SolverBackend = 'cpu', loseDeviceAfter?: number) {
  if (!mod) throw new SolveError('NOT_READY', 'solver module not initialized');
  const s = new mod.Solver();
  try {
    const info = parse<PreparedInfo>(s.prepare(problem, memoryLimitBytes));
    if (backend === 'webgpu') return await solveGpu(id, s, info, patterns, loseDeviceAfter);
    post({ type: 'prepared', id, info: { ...info, backend: 'cpu' } });
    let chunk = 20;
    const t0 = performance.now();
    for (;;) {
      const c0 = performance.now();
      const st = parse<{ step: number; maxSteps: number; time: number; energyDb: number; targetDb: number; done: boolean; terminatedBy: string }>(s.step(chunk));
      const ms = Math.max(performance.now() - c0, 0.5);
      chunk = Math.max(1, Math.min(100000, Math.round((chunk * TARGET_CHUNK_MS) / ms)));
      const elapsed = (performance.now() - t0) / 1000;
      post({
        type: 'progress',
        id,
        progress: { ...st, elapsedSeconds: elapsed, mcellsPerSec: (info.cells * st.step) / Math.max(elapsed, 1e-6) / 1e6 },
      });
      if (st.done) break;
      await new Promise((r) => setTimeout(r, 0)); // let a cancel message in
      if (cancelled.has(id)) throw new SolveError('CANCELLED', 'run cancelled');
    }
    const results = s.finish(patterns);
    parse(results);
    post({ type: 'solved', id, results });
  } finally {
    cancelled.delete(id);
    s.release();
    s.delete();
  }
}

/** Prepares the grid only (voxelize, port, checks) and returns the report and edge preview. */
function validate(id: number, problem: string, memoryLimitBytes: number, maxSegments: number) {
  if (!mod) throw new SolveError('NOT_READY', 'solver module not initialized');
  // Cost per cell-step on this machine and build, for the run-time estimate (a 64^3 cavity, ~50 ms).
  const bench = mod.runBenchmark(64, 16, mod.maxThreads());
  const nsPerCellStep = bench.ok ? bench.result.nsPerCellStep : NaN;
  const s = new mod.Solver();
  try {
    const info = parse<PreparedInfo>(s.prepare(problem, memoryLimitBytes));
    const pecSegments = s.pecSegments(maxSegments) ?? new Float32Array(0);
    self.postMessage({ type: 'validated', id, info, pecSegments, nsPerCellStep } satisfies SolverResponse, [pecSegments.buffer]);
  } finally {
    s.release();
    s.delete();
  }
}

/**
 * Runs `steps` steps of one problem on the CPU and on the GPU and compares all
 * field components. One solver at a time: in the multi-threaded build each
 * solver owns the pthread pool, and a second live solver cannot start threads.
 */
async function gpuSelfTest(id: number, problem: string, steps: number) {
  if (!mod) throw new SolveError('NOT_READY', 'solver module not initialized');
  const p = JSON.parse(problem);
  p.termination = { energyDb: -400, maxSteps: steps }; // exactly `steps` steps on both sides
  const text = JSON.stringify(p);
  let gpu: GpuFdtd | null = null;
  let device: GPUDevice | null = null;
  let s: EmbindSolver | null = null;
  try {
    s = new mod.Solver();
    const info = parse<PreparedInfo>(s.prepare(text, 0));
    let t0 = performance.now();
    for (;;) {
      const st = parse<{ done: boolean }>(s.step(steps));
      if (st.done) break;
    }
    const cpuSeconds = (performance.now() - t0) / 1000;
    const ref = [0, 1, 2, 3, 4, 5].map((c) => s!.fieldSnapshot(c)!);
    s.release();
    s.delete();
    s = new mod.Solver();
    parse<PreparedInfo>(s.prepare(text, 0));
    const { layout, arrays } = exportForGpu(s);
    s.releaseTimeLoopStorage();
    const req = await requestFdtdDevice(layout);
    device = req.device;
    gpu = await GpuFdtd.create(device, layout, arrays);
    await gpu.advance(1, true); // compiles pipelines and warms up
    const warm = 1;
    t0 = performance.now();
    await gpu.advance(steps - warm, true);
    const gpuSeconds = ((performance.now() - t0) / 1000) * (steps / (steps - warm));
    // Differences are relative to the norm of the whole E (or H) field: a component
    // that is physically zero (Hz of a z-directed dipole) holds only rounding noise,
    // and noise measured against itself says nothing.
    const num: number[] = [], den: number[] = [];
    for (let c = 0; c < 6; c++) {
      const a = ref[c];
      const b = await gpu.readField(c);
      let n2 = 0, d2 = 0;
      for (let i = 0; i < a.length; i++) {
        n2 += (b[i] - a[i]) ** 2;
        d2 += a[i] ** 2;
      }
      num.push(n2);
      den.push(d2);
    }
    const norm = (cs: number[]) => Math.sqrt(cs.reduce((s, c) => s + den[c], 0));
    const eNorm = norm([0, 1, 2]), hNorm = norm([3, 4, 5]);
    const diffs = num.map((n2, c) => Math.sqrt(n2) / (c < 3 ? eNorm : hNorm));
    const eRel = Math.sqrt(num[0] + num[1] + num[2]) / eNorm, hRel = Math.sqrt(num[3] + num[4] + num[5]) / hNorm;
    const result: GpuSelfTestResult = { steps, cells: info.cells, adapter: req.adapterName, cpuSeconds, cpuThreads: info.threads, gpuSeconds, diffs, eRel, hRel, worst: Math.max(eRel, hRel) };
    post({ type: 'gpuSelfTestResult', id, result });
  } catch (e) {
    const code = gpuCode(e);
    throw code ? new SolveError(code, (e as Error).message) : e;
  } finally {
    gpu?.destroy();
    device?.destroy();
    if (s) {
      s.release();
      s.delete();
    }
  }
}

interface RunJson {
  run: { steps: number; seconds: number; threads: number; terminatedBy: string };
  port?: { zinRe: number[]; zinIm: number[] };
  farField: { frequency: number; directivityDbi: number }[];
}

/** Runs one problem to completion on the CPU, then on the GPU, and compares Zin and D. */
async function gpuCompare(id: number, problem: string) {
  if (!mod) throw new SolveError('NOT_READY', 'solver module not initialized');
  let s: EmbindSolver | null = null;
  let gpu: GpuFdtd | null = null;
  let device: GPUDevice | null = null;
  try {
    s = new mod.Solver();
    const info = parse<PreparedInfo>(s.prepare(problem, 0));
    for (;;) {
      if (parse<{ done: boolean }>(s.step(1000)).done) break;
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled.has(id)) throw new SolveError('CANCELLED', 'comparison cancelled');
    }
    const cpu = parse<RunJson>(s.finish(false));
    s.release();
    s.delete();
    s = new mod.Solver();
    parse<PreparedInfo>(s.prepare(problem, 0));
    const { layout, arrays } = exportForGpu(s);
    s.releaseTimeLoopStorage();
    const req = await requestFdtdDevice(layout);
    device = req.device;
    gpu = await GpuFdtd.create(device, layout, arrays);
    const out = await gpu.run({ cancelled: () => cancelled.has(id) });
    const g = parse<RunJson>(s.gpuFinish(JSON.stringify({ steps: out.steps, energyDb: out.energyDb, terminatedBy: out.terminatedBy, seconds: out.seconds }), out.voltage, out.current, out.nf2ffAcc, false));
    let zinMaxRel = 0;
    if (cpu.port && g.port)
      cpu.port.zinRe.forEach((re, i) => {
        const im = cpu.port!.zinIm[i];
        zinMaxRel = Math.max(zinMaxRel, Math.hypot(g.port!.zinRe[i] - re, g.port!.zinIm[i] - im) / Math.hypot(re, im));
      });
    const dMaxDb = Math.max(0, ...cpu.farField.map((f, i) => Math.abs(g.farField[i].directivityDbi - f.directivityDbi)));
    const result: GpuCompareResult = {
      cells: info.cells,
      adapter: req.adapterName,
      cpu: { steps: cpu.run.steps, seconds: cpu.run.seconds, threads: cpu.run.threads, terminatedBy: cpu.run.terminatedBy },
      gpu: { steps: g.run.steps, seconds: g.run.seconds, terminatedBy: g.run.terminatedBy },
      zinMaxRel,
      dMaxDb,
    };
    post({ type: 'gpuCompareResult', id, result });
  } catch (e) {
    const code = gpuCode(e);
    throw code ? new SolveError(code, (e as Error).message) : e;
  } finally {
    cancelled.delete(id);
    gpu?.destroy();
    device?.destroy();
    if (s) {
      s.release();
      s.delete();
    }
  }
}

self.onmessage = async (ev: MessageEvent<SolverRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.variant, msg.wasmBase);
        break;
      case 'benchmark': {
        if (!mod) throw new Error('solver module not initialized');
        const threads = Math.min(msg.threads ?? mod.maxThreads(), mod.maxThreads());
        const out = mod.runBenchmark(msg.n, msg.steps, threads);
        if (!out.ok) post({ type: 'error', id: msg.id, code: 'SOLVER_ERROR', message: out.error });
        else post({ type: 'benchmarkResult', id: msg.id, result: out.result });
        break;
      }
      case 'solve':
        await solve(msg.id, msg.problem, msg.memoryLimitBytes, msg.patterns, msg.backend, msg.debugLoseDeviceAfter);
        break;
      case 'gpuSelfTest':
        await gpuSelfTest(msg.id, msg.problem, msg.steps);
        break;
      case 'gpuCompare':
        await gpuCompare(msg.id, msg.problem);
        break;
      case 'validate':
        validate(msg.id, msg.problem, msg.memoryLimitBytes, msg.maxSegments);
        break;
    }
  } catch (e) {
    post({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      code: e instanceof SolveError ? e.code : msg.type === 'init' ? 'INIT_FAILED' : 'WORKER_ERROR',
      message: ((e as Error)?.message ?? String(e)) + (msg.type === "gpuSelfTest" ? ` [${(e as Error)?.stack ?? ""}]` : ""),
    });
  }
};

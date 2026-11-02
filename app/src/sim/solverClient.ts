// Main-thread handle to the solver worker. Chooses the multi-threaded build
// when the page can use SharedArrayBuffer, falls back to single-thread when
// it cannot (or when MT initialization fails), and turns worker errors into
// rejected promises. terminate() releases all wasm memory.
import type {
  BenchmarkResult,
  GpuCompareResult,
  GpuSelfTestResult,
  PreparedInfo,
  SolverBackend,
  RunProgress,
  SolverRequest,
  SolverResponse,
  SolverVariant,
} from '../workers/protocol';

export interface SolverInfo {
  variant: SolverVariant;
  version: string;
  maxThreads: number;
  threadsEnabled: boolean;
  /** Why the MT build was not used, if it was not. */
  fallbackReason?: string;
}

export class SolverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const INIT_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 2_000;
const wasmBase = () => new URL(`${import.meta.env.BASE_URL}wasm/`, location.href).href;

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  onPrepared?: (i: PreparedInfo) => void;
  onProgress?: (p: RunProgress) => void;
}

export interface ValidateResult {
  info: PreparedInfo;
  pecSegments: Float32Array;
  nsPerCellStep: number; // measured on a small cavity; NaN if the benchmark failed
}

export interface SolveHandle {
  promise: Promise<string>; // results JSON
  cancel: () => void;
}

export class SolverClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private dead = false;

  private constructor(
    private worker: Worker,
    readonly info: SolverInfo,
  ) {
    worker.onmessage = (ev: MessageEvent<SolverResponse>) => this.onMessage(ev.data);
    worker.onerror = (ev) => this.failAll(new SolverError('WORKER_CRASHED', `solver worker crashed: ${ev.message || 'unknown error'}`));
  }

  static async create(preferThreads: boolean, threadsReason?: string): Promise<SolverClient> {
    if (preferThreads) {
      try {
        return await SolverClient.spawn('mt');
      } catch (e) {
        const client = await SolverClient.spawn('st');
        client.info.fallbackReason = `multi-thread build failed to start: ${(e as Error).message}`;
        return client;
      }
    }
    const client = await SolverClient.spawn('st');
    client.info.fallbackReason = threadsReason ?? 'threads unavailable';
    return client;
  }

  private static spawn(variant: SolverVariant): Promise<SolverClient> {
    const worker = new Worker(new URL('../workers/solver.worker.ts', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`solver (${variant}) did not initialize within ${INIT_TIMEOUT_MS / 1000} s`));
      }, INIT_TIMEOUT_MS);
      worker.onmessage = (ev: MessageEvent<SolverResponse>) => {
        const m = ev.data;
        clearTimeout(timer);
        if (m.type === 'ready') {
          const { type: _type, ...rest } = m;
          resolve(new SolverClient(worker, { ...rest }));
        } else {
          worker.terminate();
          reject(new Error(m.type === 'error' ? `${m.code}: ${m.message}` : `unexpected message ${m.type}`));
        }
      };
      worker.onerror = (ev) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(ev.message || 'worker failed to load'));
      };
      const req: SolverRequest = { type: 'init', variant, wasmBase: wasmBase() };
      worker.postMessage(req);
    });
  }

  benchmark(n: number, steps: number, threads?: number): Promise<BenchmarkResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'benchmark', id, n, steps, threads });
    });
  }

  /** Same problem, `steps` steps on the CPU and on the GPU; compares the fields. */
  gpuSelfTest(problem: string, steps: number): Promise<GpuSelfTestResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'gpuSelfTest', id, problem, steps });
    });
  }

  /** Complete CPU and GPU runs of one problem, compared on Zin and D. */
  gpuCompare(problem: string): Promise<GpuCompareResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'gpuCompare', id, problem });
    });
  }

  /** Prepares a problem without running it: grid, voxelization report, PEC and port edges. */
  validate(problem: string, opts: { memoryLimitBytes: number; maxSegments?: number }): Promise<ValidateResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'validate', id, problem, memoryLimitBytes: opts.memoryLimitBytes, maxSegments: opts.maxSegments ?? 200_000 });
    });
  }

  /** Runs a problem (antsim problem JSON). Progress arrives about every 100 ms. */
  solve(
    problem: string,
    opts: { memoryLimitBytes: number; patterns?: boolean; backend?: SolverBackend; debugLoseDeviceAfter?: number; onPrepared?: (i: PreparedInfo) => void; onProgress?: (p: RunProgress) => void },
  ): SolveHandle {
    const id = this.nextId++;
    let cancel = () => {};
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onPrepared: opts.onPrepared, onProgress: opts.onProgress });
      this.send({ type: 'solve', id, problem, memoryLimitBytes: opts.memoryLimitBytes, patterns: opts.patterns ?? true, backend: opts.backend ?? 'cpu', debugLoseDeviceAfter: opts.debugLoseDeviceAfter });
      cancel = () => {
        if (!this.pending.has(id)) return;
        this.send({ type: 'cancel', id });
        // A chunk can take a while on a slow machine; terminate if the worker does not respond.
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.terminate();
            reject(new SolverError('CANCELLED', 'run cancelled (worker terminated)'));
          }
        }, CANCEL_GRACE_MS);
      };
    });
    return { promise, cancel };
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    this.failAll(new SolverError('TERMINATED', 'solver terminated'));
  }

  private send(req: SolverRequest) {
    if (this.dead) throw new SolverError('TERMINATED', 'solver terminated');
    this.worker.postMessage(req);
  }

  private onMessage(m: SolverResponse) {
    if (m.type === 'ready') return;
    const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
    switch (m.type) {
      case 'benchmarkResult':
        p?.resolve(m.result as never);
        this.pending.delete(m.id);
        break;
      case 'prepared':
        p?.onPrepared?.(m.info);
        break;
      case 'gpuCompareResult':
        p?.resolve(m.result as never);
        this.pending.delete(m.id);
        break;
      case 'gpuSelfTestResult':
        p?.resolve(m.result as never);
        this.pending.delete(m.id);
        break;
      case 'validated':
        p?.resolve({ info: m.info, pecSegments: m.pecSegments, nsPerCellStep: m.nsPerCellStep } as never);
        this.pending.delete(m.id);
        break;
      case 'progress':
        p?.onProgress?.(m.progress);
        break;
      case 'solved':
        p?.resolve(m.results as never);
        this.pending.delete(m.id);
        break;
      case 'error': {
        const err = new SolverError(m.code, m.message);
        if (m.id !== undefined) {
          p?.reject(err);
          this.pending.delete(m.id);
        } else this.failAll(err);
        break;
      }
    }
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

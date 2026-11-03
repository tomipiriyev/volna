// Typed messages between the main thread and the solver worker. Kept free of
// DOM and WebWorker types so both sides can import it.

export type SolverVariant = 'st' | 'mt';
/** Where the time loop runs: the wasm solver (CPU) or WebGPU kernels. */
export type SolverBackend = 'cpu' | 'webgpu';

export interface BenchmarkResult {
  n: number;
  steps: number;
  threads: number;
  seconds: number;
  mcellsPerSec: number;
  nsPerCellStep: number;
  energyStart: number;
  energyEnd: number;
}

export interface SolverDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

/** Voxelization report of a prepared grid (C++ MeshReport). */
export interface MeshReport {
  objects: { name: string; kind: string; material: string; conductor: boolean; pecEdges: number; lossyEdges: number; cells: number; snapDistance: number }[];
  overlaps: { a: string; b: string; cells: number }[];
  pecEdges: number;
  minCell: number;
  maxCell: number;
  dcConnected: boolean | null;
  /** Conformal mode only: faces cut by conductors, those capped for stability, the update's largest eigenvalue. */
  conformal?: { cutFaces: number; cappedFaces: number; eigenvalue: number };
  diagnostics: SolverDiagnostic[];
}

export interface PreparedInfo {
  cells: number;
  grid: [number, number, number];
  dt: number;
  maxSteps: number;
  threads: number;
  memoryBytes: number;
  estimate: { cells: number; fields: number; materials: number; cpml: number; nf2ff: number; portSeries: number; rasterTemp: number; total: number };
  warnings: string[];
  report: MeshReport;
  portSegments: number[]; // 6 floats per edge, mm
  backend?: SolverBackend;
  /** WebGPU adapter used for the time loop. */
  gpuAdapter?: string;
}

/** CPU and GPU after the same number of steps on one problem (relative L2 differences). */
/** Complete CPU and GPU runs of one problem, compared on the post-processed results. */
export interface GpuCompareResult {
  cells: number;
  adapter: string;
  cpu: { steps: number; seconds: number; threads: number; terminatedBy: string };
  gpu: { steps: number; seconds: number; terminatedBy: string };
  /** max over the port frequencies of |Zin_gpu - Zin_cpu| / |Zin_cpu|. */
  zinMaxRel: number;
  /** max over the far-field frequencies of |D_gpu - D_cpu| (dB). */
  dMaxDb: number;
}

export interface GpuSelfTestResult {
  steps: number;
  cells: number;
  adapter: string;
  cpuSeconds: number;
  cpuThreads: number;
  gpuSeconds: number;
  /** Per component Ex Ey Ez Hx Hy Hz: ||gpu - cpu|| over the norm of the whole E (or H) field. */
  diffs: number[];
  /** ||E_gpu - E_cpu|| / ||E_cpu|| and the same for H, over all three components. */
  eRel: number;
  hRel: number;
  worst: number;
}

export interface RunProgress {
  step: number;
  maxSteps: number;
  time: number;
  energyDb: number;
  targetDb: number;
  done: boolean;
  terminatedBy: string;
  mcellsPerSec: number;
  elapsedSeconds: number;
}

export type SolverRequest =
  | { type: 'init'; variant: SolverVariant; wasmBase: string }
  | { type: 'benchmark'; id: number; n: number; steps: number; threads?: number }
  | { type: 'solve'; id: number; problem: string; memoryLimitBytes: number; patterns: boolean; backend?: SolverBackend; debugLoseDeviceAfter?: number }
  | { type: 'gpuSelfTest'; id: number; problem: string; steps: number }
  | { type: 'gpuCompare'; id: number; problem: string }
  | { type: 'validate'; id: number; problem: string; memoryLimitBytes: number; maxSegments: number }
  | { type: 'cancel'; id: number };

export type SolverResponse =
  | { type: 'ready'; variant: SolverVariant; version: string; maxThreads: number; threadsEnabled: boolean }
  | { type: 'benchmarkResult'; id: number; result: BenchmarkResult }
  | { type: 'prepared'; id: number; info: PreparedInfo }
  | { type: 'validated'; id: number; info: PreparedInfo; pecSegments: Float32Array; nsPerCellStep: number }
  | { type: 'progress'; id: number; progress: RunProgress }
  | { type: 'solved'; id: number; results: string }
  | { type: 'gpuSelfTestResult'; id: number; result: GpuSelfTestResult }
  | { type: 'gpuCompareResult'; id: number; result: GpuCompareResult }
  | { type: 'error'; id?: number; code: string; message: string };

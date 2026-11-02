// WebGPU time loop for a problem prepared by the C++ solver (wasm). The solver
// exports its layout and arrays (Solver::gpuLayoutJson / gpuFloats / gpuUints);
// this class uploads them once, runs the update kernels in fdtd.wgsl, checks
// the field energy at the same steps as the C++ loop (so both stop at the same
// step), and returns what Solver::importRun needs: the port V/I series and the
// NF2FF accumulators. Buffers stay on the GPU; only energy partials are read
// back per chunk, the series and accumulators once at the end.
import shaderSource from './fdtd.wgsl?raw';

// WebGPU constants (the TypeScript DOM lib has the interfaces but not these namespaces).
const BUF = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const STAGE_COMPUTE = 0x4;
const MAP_READ = 0x1;

export interface GpuLayout {
  nx: number;
  ny: number;
  nz: number;
  sx: number;
  sy: number;
  nodes: number;
  dt: number;
  chH: number;
  checkEvery: number;
  maxSteps: number;
  energyEndDb: number;
  pulseEnd: number;
  materials: number;
  pmc: boolean[];
  cells: number;
  cpml: { axis: number; lo: number; hi: number; nE: number; nH: number; planeE: number; profE: number; profH: number; psiE: number; psiH: number }[];
  port: { axis: number; edges: { at: number; length: number; source: number; line: number }[]; lines: { ijk: [number, number, number]; area: number; weight: number }[] } | null;
  nf2ff: { freqs: number[]; faces: { a: number; side: number; plane: number; B0: number; B1: number; C0: number; C1: number; nb: number; nc: number; offEp: number; offHq: number; offEq: number; offHp: number }[] } | null;
}

/** Arrays exported by the solver, by name (see Solver::gpuFloats / gpuUints). */
export type GpuArrays = Record<string, Float32Array | Uint32Array>;

export const GPU_ARRAY_NAMES = ['mx', 'my', 'mz', 'ca', 'cb', 'epsR', 'invD0', 'invD1', 'invD2', 'invDd0', 'invDd1', 'invDd2', 'd0', 'd1', 'd2', 'dd0', 'dd1', 'dd2', 'cpmlProfE', 'cpmlProfH', 'waveform'];

export interface GpuProgress {
  step: number;
  maxSteps: number;
  energyDb: number;
  targetDb: number;
  seconds: number;
}

export interface GpuOutcome {
  steps: number;
  energyDb: number;
  terminatedBy: 'energy' | 'maxSteps';
  seconds: number;
  voltage: Float64Array;
  current: Float64Array;
  nf2ffAcc: Float64Array; // Nf2ff::exportAcc layout, dt included
}

export class GpuError extends Error {
  constructor(
    readonly code: 'GPU_UNAVAILABLE' | 'GPU_LIMITS' | 'GPU_DEVICE_LOST' | 'GPU_UNSUPPORTED' | 'GPU_ERROR' | 'CANCELLED',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const EPS0 = 8.8541878128e-12;
const MU0 = 1.25663706212e-6;
const N_PART = 512; // energy workgroups

/** Requests a device with storage limits large enough for the problem, or explains why not. */
export async function requestFdtdDevice(layout: GpuLayout): Promise<{ device: GPUDevice; adapterName: string }> {
  const gpu = (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu; // window or worker
  if (!gpu) throw new GpuError('GPU_UNAVAILABLE', 'WebGPU is not available in this browser');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuError('GPU_UNAVAILABLE', 'no WebGPU adapter');
  const need = largestBuffer(layout);
  const lim = adapter.limits;
  const cap = Math.min(lim.maxStorageBufferBindingSize, lim.maxBufferSize);
  if (need > cap)
    throw new GpuError(
      'GPU_LIMITS',
      `the largest GPU buffer would be ${(need / 2 ** 20).toFixed(0)} MB, above this GPU's limit of ${(cap / 2 ** 20).toFixed(0)} MB; use the CPU solver or a coarser grid`,
    );
  if (layout.nx + 1 > lim.maxComputeWorkgroupsPerDimension || layout.ny + 1 > lim.maxComputeWorkgroupsPerDimension)
    throw new GpuError('GPU_LIMITS', 'the grid has more lines per axis than this GPU can dispatch');
  // Ask for what the problem needs (at least the WebGPU defaults), never more than the adapter has.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, Math.max(need, 128 * 2 ** 20)),
      maxBufferSize: Math.min(lim.maxBufferSize, Math.max(need, 256 * 2 ** 20)),
    },
  });
  const info = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } }).info;
  return { device, adapterName: [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'WebGPU adapter' };
}

/** Bytes of the largest buffer the run allocates (fields, PML state, NF2FF sums or constants). */
export function largestBuffer(l: GpuLayout): number {
  const psi = 2 * l.cpml.reduce((s, x) => s + (x.nE + x.nH) * x.planeE, 0);
  const consts = 3 * l.materials + 4 * (l.nx + l.ny + l.nz + 3) + l.maxSteps + 2 * l.cpml.reduce((s, x) => s + x.nE + x.nH, 0);
  return 4 * Math.max(6 * l.nodes, 6 * accLength(l), psi, consts, 2 * l.maxSteps + N_PART + 4 * (l.nf2ff?.freqs.length ?? 0));
}

/** Complex NF2FF accumulator entries (Ep, Hq, Eq, Hp of every face, all frequencies). */
function accLength(l: GpuLayout): number {
  if (!l.nf2ff) return 0;
  const nf = l.nf2ff.freqs.length;
  return l.nf2ff.faces.reduce((s, f) => s + 2 * (f.nb + f.nc) * nf, 0);
}

export class GpuFdtd {
  private bufs: Record<'F' | 'M' | 'C' | 'PSI' | 'IO' | 'ACC' | 'META' | 'P' | 'D', GPUBuffer>;
  private bg0: GPUBindGroup;
  private bg1: GPUBindGroup;
  private pipes: Record<string, GPUComputePipeline>;
  private dStride: number;
  private ioI: number;
  private ioPart: number;
  private accL: number;
  private totalSamples: number;
  private lost: string | null = null;
  private lostPromise: Promise<unknown>;
  private step = 0;

  private constructor(
    readonly device: GPUDevice,
    readonly layout: GpuLayout,
    arrays: GpuArrays,
  ) {
    const L = layout;
    const nMat = L.materials;
    const nSum = L.nx + L.ny + L.nz;
    // ---- constants
    const parts: [string, ArrayLike<number>][] = [
      ['ca', arrays.ca],
      ['cb', arrays.cb],
      ['eps', arrays.epsR],
      ['invD', concat([arrays.invD0, arrays.invD1, arrays.invD2])],
      ['invDd', concat([arrays.invDd0, arrays.invDd1, arrays.invDd2])],
      // Cell sizes in mm (energy volumes; the scale cancels in dB).
      ['d', scale(concat([arrays.d0, arrays.d1, arrays.d2]), 1e3)],
      ['dd', scale(concat([arrays.dd0, arrays.dd1, arrays.dd2]), 1e3)],
      ['profE', arrays.cpmlProfE],
      ['profH', arrays.cpmlProfH],
      ['wave', arrays.waveform],
      ['edgeLen', L.port?.edges.map((e) => e.length) ?? []],
      ['edgeSrc', L.port?.edges.map((e) => e.source) ?? []],
      ['lineArea', L.port?.lines.map((l) => l.area) ?? []],
      ['lineW', L.port?.lines.map((l) => l.weight) ?? []],
    ];
    const off: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of parts) {
      off[k] = n;
      n += v.length;
    }
    const consts = new Float32Array(Math.max(n, 4));
    for (const [k, v] of parts) consts.set(v, off[k]);
    if (arrays.invD0.length !== L.nx || arrays.invDd2.length !== L.nz + 1 || nSum + 3 !== off.d - off.invDd) throw new GpuError('GPU_ERROR', 'unexpected spacing array sizes');

    // ---- integer tables
    const meta: number[] = new Array(16).fill(0); // run state, see fdtd.wgsl
    const mSlab = meta.length;
    for (const s of L.cpml) {
      const np = [L.nx, L.ny, L.nz][(s.axis + 1) % 3], nq = [L.nx, L.ny, L.nz][(s.axis + 2) % 3];
      meta.push(s.axis, s.lo, s.hi, s.nE, s.nH, s.planeE, s.profE, s.profH, s.psiE, s.psiH, np, nq);
    }
    const mEdges = meta.length;
    for (const e of L.port?.edges ?? []) meta.push(e.at, e.line);
    const mLines = meta.length;
    for (const l of L.port?.lines ?? []) meta.push(...l.ijk);
    const mFaces = meta.length;
    let start = 0;
    for (const f of L.nf2ff?.faces ?? []) {
      meta.push(f.a, f.plane, f.B0, f.B1, f.C0, f.C1, f.nb, f.nc, f.offEp, f.offHq, f.offEq, f.offHp, start, start + f.nb, 0, 0);
      start += f.nb + f.nc;
    }
    this.totalSamples = start;
    const mPhase = meta.length;
    // Phase increment per half step, as a u32 fraction of a turn: f dt / 2 * 2^32.
    for (const f of L.nf2ff?.freqs ?? []) meta.push(Math.round(((f * L.dt) / 2) * 2 ** 32) >>> 0);
    if (meta.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) throw new GpuError('GPU_ERROR', 'index tables exceed 32 bits');

    const totE = L.cpml.reduce((s, x) => s + x.nE * x.planeE, 0);
    const totH = L.cpml.reduce((s, x) => s + x.nH * x.planeE, 0);
    this.accL = accLength(L); // complex entries
    this.ioI = L.maxSteps;
    this.ioPart = 2 * L.maxSteps;
    const W = Math.ceil(L.nodes / 2);

    const P = new ArrayBuffer(192);
    const u = new Uint32Array(P), fl = new Float32Array(P);
    const nf = L.nf2ff?.freqs.length ?? 0;
    u.set([L.nx, L.ny, L.nz, L.sx, L.sy, L.nodes, W, nMat], 0);
    fl[8] = L.chH;
    u.set([nf, L.port?.edges.length ?? 0, L.port?.lines.length ?? 0, L.port?.axis ?? 0, L.maxSteps, L.nf2ff?.faces.length ?? 0, this.totalSamples], 9);
    u.set([off.ca, off.cb, off.eps, off.invD, off.invDd, off.d, off.dd, off.profE, off.profH, off.wave, off.edgeLen, off.edgeSrc, off.lineArea, off.lineW], 16);
    u.set([mSlab, mEdges, mLines, mFaces, mPhase, 0, totE, 2 * totE, 2 * totE + totH, this.accL, this.ioI, this.ioPart, N_PART], 30);
    fl[43] = MU0 / EPS0;
    u[44] = this.ioPart + N_PART; // twiddles: 4 floats per frequency
    fl[45] = L.dt;
    fl[46] = L.pulseEnd;
    fl[47] = L.energyEndDb;

    const dev = device;
    const make = (size: number, usage: number, data?: ArrayBufferView) => {
      const b = dev.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, mappedAtCreation: !!data });
      if (data) {
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        b.unmap();
      }
      return b;
    };
    const S = BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST;
    const mats = new Uint32Array(3 * W);
    mats.set(arrays.mx as Uint32Array, 0);
    mats.set(arrays.my as Uint32Array, W);
    mats.set(arrays.mz as Uint32Array, 2 * W);
    this.dStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
    const nD = L.cpml.length + 4; // slabs, NF2FF H, NF2FF E, energy check, chunk end without check
    const dData = new Uint32Array((this.dStride / 4) * nD);
    L.cpml.forEach((_, s) => (dData[(this.dStride / 4) * s] = s));
    dData[(this.dStride / 4) * L.cpml.length + 1] = 0; // NF2FF, magnetic
    dData[(this.dStride / 4) * (L.cpml.length + 1) + 1] = 1; // NF2FF, electric
    dData[(this.dStride / 4) * (L.cpml.length + 2) + 2] = 1; // energy check at this chunk end
    this.bufs = {
      F: make(6 * L.nodes * 4, S),
      M: make(mats.byteLength, BUF.STORAGE, mats),
      C: make(consts.byteLength, BUF.STORAGE, consts),
      PSI: make(2 * (totE + totH) * 4, S),
      IO: make((2 * L.maxSteps + N_PART + 4 * nf) * 4, S),
      ACC: make(6 * this.accL * 4, S),
      META: make(meta.length * 4, S, new Uint32Array(meta)),
      P: make(192, BUF.UNIFORM, new Uint8Array(P)),
      D: make(dData.byteLength, BUF.UNIFORM, dData),
    };

    const bgl0 = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2, 3, 4, 5, 6].map((binding) => ({ binding, visibility: STAGE_COMPUTE, buffer: { type: (binding === 1 || binding === 2 ? 'read-only-storage' : 'storage') as GPUBufferBindingType } })),
        { binding: 7, visibility: STAGE_COMPUTE, buffer: { type: 'uniform' as GPUBufferBindingType } },
      ],
    });
    const bgl1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: STAGE_COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }] });
    const order = ['F', 'M', 'C', 'PSI', 'IO', 'ACC', 'META', 'P'] as const;
    this.bg0 = device.createBindGroup({ layout: bgl0, entries: order.map((k, binding) => ({ binding, resource: { buffer: this.bufs[k] } })) });
    this.bg1 = device.createBindGroup({ layout: bgl1, entries: [{ binding: 0, resource: { buffer: this.bufs.D, size: 16 } }] });
    const module = device.createShaderModule({ code: shaderSource, label: 'fdtd' });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
    this.pipes = {};
    for (const entryPoint of ['updateH', 'updateE', 'cpmlE', 'cpmlH', 'portCurrent', 'portVoltage', 'twiddle', 'nf2ff', 'fold', 'energy', 'energyCheck', 'advance'])
      this.pipes[entryPoint] = device.createComputePipeline({ layout: pl, compute: { module, entryPoint }, label: entryPoint });
    this.lostPromise = device.lost.then((info) => {
      this.lost ??= info.message || info.reason || 'device lost';
    });
  }

  /** Uploads the problem and compiles the kernels. Rejects (with the WGSL/validation message) if anything fails. */
  static async create(device: GPUDevice, layout: GpuLayout, arrays: GpuArrays): Promise<GpuFdtd> {
    if (layout.pmc.some(Boolean)) throw new GpuError('GPU_UNSUPPORTED', 'PMC boundaries are not implemented on the GPU backend');
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let g: GpuFdtd;
    try {
      g = new GpuFdtd(device, layout, arrays);
    } finally {
      const oom = await device.popErrorScope();
      const val = await device.popErrorScope();
      if (oom) throw new GpuError('GPU_LIMITS', `out of GPU memory: ${oom.message}`);
      if (val) throw new GpuError('GPU_ERROR', val.message);
    }
    return g!;
  }

  get stepsDone() {
    return this.step;
  }

  private check() {
    if (this.lost) throw new GpuError('GPU_DEVICE_LOST', this.lost);
  }

  /** Records `count` time steps into a compute pass (the order of Solver::step). */
  private encodeSteps(pass: GPUComputePassEncoder, count: number) {
    const L = this.layout;
    const p = this.pipes;
    const gx = Math.ceil((L.nz + 1) / 64);
    const dims = [L.nx, L.ny, L.nz];
    const slabDims = L.cpml.map((s) => [Math.ceil((dims[(s.axis + 2) % 3] + 1) / 64), dims[(s.axis + 1) % 3] + 1]);
    const nfGroups = Math.ceil(this.totalSamples / 64);
    const nSlab = L.cpml.length;
    pass.setBindGroup(0, this.bg0);
    pass.setBindGroup(1, this.bg1, [0]);
    for (let c = 0; c < count; c++) {
      pass.setPipeline(p.updateH);
      pass.dispatchWorkgroups(gx, L.ny + 1, L.nx + 1);
      pass.setPipeline(p.cpmlH);
      L.cpml.forEach((s, i) => {
        if (!s.nH) return;
        pass.setBindGroup(1, this.bg1, [i * this.dStride]);
        pass.dispatchWorkgroups(slabDims[i][0], slabDims[i][1], s.nH);
      });
      if (L.port) {
        pass.setPipeline(p.portCurrent);
        pass.dispatchWorkgroups(1);
      }
      if (this.totalSamples) {
        pass.setPipeline(p.twiddle);
        pass.dispatchWorkgroups(1);
        pass.setBindGroup(1, this.bg1, [nSlab * this.dStride]);
        pass.setPipeline(p.nf2ff);
        pass.dispatchWorkgroups(nfGroups);
      }
      pass.setPipeline(p.updateE);
      pass.dispatchWorkgroups(gx, L.ny + 1, L.nx + 1);
      pass.setPipeline(p.cpmlE);
      L.cpml.forEach((s, i) => {
        if (!s.nE) return;
        pass.setBindGroup(1, this.bg1, [i * this.dStride]);
        pass.dispatchWorkgroups(slabDims[i][0], slabDims[i][1], s.nE);
      });
      if (L.port) {
        pass.setPipeline(p.portVoltage);
        pass.dispatchWorkgroups(1);
      }
      if (this.totalSamples) {
        pass.setBindGroup(1, this.bg1, [(nSlab + 1) * this.dStride]);
        pass.setPipeline(p.nf2ff);
        pass.dispatchWorkgroups(nfGroups);
      }
      pass.setPipeline(p.advance);
      pass.dispatchWorkgroups(1);
    }
  }

  private async read(src: GPUBuffer, offsetBytes: number, sizeBytes: number, encoder?: GPUCommandEncoder): Promise<ArrayBuffer> {
    const dev = this.device;
    const staging = dev.createBuffer({ size: Math.max(4, sizeBytes), usage: BUF.MAP_READ | BUF.COPY_DST });
    const enc = encoder ?? dev.createCommandEncoder();
    if (sizeBytes > 0) enc.copyBufferToBuffer(src, offsetBytes, staging, 0, sizeBytes);
    dev.queue.submit([enc.finish()]);
    try {
      await staging.mapAsync(MAP_READ);
    } catch (e) {
      // A lost device rejects pending maps; its lost promise may settle a moment later.
      await Promise.race([this.lostPromise, new Promise((r) => setTimeout(r, 200))]);
      this.check();
      throw new GpuError('GPU_ERROR', `readback failed: ${(e as Error).message}`);
    }
    const out = staging.getMappedRange().slice(0);
    staging.destroy();
    this.check();
    return out;
  }

  /**
   * Advances `count` steps; with `measure`, folds the NF2FF chunk sums and returns the
   * field energy (J, as Yee::energy), else resolves once the work is queued.
   */
  async advance(count: number, measure: boolean): Promise<number | null> {
    this.check();
    const dev = this.device;
    const enc = dev.createCommandEncoder();
    // Bounded command buffers: a few hundred steps per pass.
    for (let done = 0; done < count; ) {
      const n = Math.min(count - done, 256);
      const pass = enc.beginComputePass();
      this.encodeSteps(pass, n);
      pass.end();
      done += n;
    }
    this.step += count;
    if (!measure) {
      dev.queue.submit([enc.finish()]);
      return null;
    }
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bg0);
    pass.setBindGroup(1, this.bg1, [0]);
    if (this.accL) {
      pass.setPipeline(this.pipes.fold);
      pass.dispatchWorkgroups(Math.ceil((2 * this.accL) / 256));
    }
    pass.setPipeline(this.pipes.energy);
    pass.dispatchWorkgroups(N_PART);
    pass.end();
    const parts = new Float32Array(await this.read(this.bufs.IO, this.ioPart * 4, N_PART * 4, enc));
    let s = 0;
    for (const v of parts) s += v;
    // Units of eps0 * mm^3 -> J, with the 1/2 of Yee::energy.
    return 0.5 * s * EPS0 * 1e-9;
  }

  /**
   * Runs to termination with the C++ criteria (energy every checkEvery steps), decided
   * on the GPU (energyCheck), so the host keeps two chunks in flight without waiting
   * for each energy value; work queued after the end is a no-op.
   */
  async run(opts: { onProgress?: (p: GpuProgress) => void; cancelled?: () => boolean; loseDeviceAfter?: number } = {}): Promise<GpuOutcome> {
    const L = this.layout;
    const dev = this.device;
    const t0 = performance.now();
    const nSlab = L.cpml.length;
    type Pending = { staging: GPUBuffer; done: Promise<void> };
    const inflight: Pending[] = [];
    let queued = 0; // steps queued so far (the GPU may stop earlier)
    let state = { step: 0, done: false, term: 0, energyDb: 0 };
    let lastReport = 0;
    const readState = async (p: Pending) => {
      try {
        await p.done;
      } catch (e) {
        await Promise.race([this.lostPromise, new Promise((r) => setTimeout(r, 200))]);
        this.check();
        throw new GpuError('GPU_ERROR', `readback failed: ${(e as Error).message}`);
      }
      const u = new Uint32Array(p.staging.getMappedRange().slice(0));
      p.staging.destroy();
      this.check();
      state = { step: u[0], done: u[1] !== 0, term: u[2], energyDb: new Float32Array(u.buffer)[5] };
    };
    while (!state.done) {
      this.check();
      if (queued < L.maxSteps) {
        const next = Math.min((Math.floor(queued / L.checkEvery) + 1) * L.checkEvery, L.maxSteps);
        const isCheck = next % L.checkEvery === 0;
        const enc = dev.createCommandEncoder();
        for (let done = queued; done < next; ) {
          const n = Math.min(next - done, 256);
          const pass = enc.beginComputePass();
          this.encodeSteps(pass, n);
          pass.end();
          done += n;
        }
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, this.bg0);
        pass.setBindGroup(1, this.bg1, [0]);
        if (this.accL) {
          pass.setPipeline(this.pipes.fold);
          pass.dispatchWorkgroups(Math.ceil((2 * this.accL) / 256));
        }
        if (isCheck) {
          pass.setPipeline(this.pipes.energy);
          pass.dispatchWorkgroups(N_PART);
        }
        pass.setBindGroup(1, this.bg1, [(nSlab + (isCheck ? 2 : 3)) * this.dStride]);
        pass.setPipeline(this.pipes.energyCheck);
        pass.dispatchWorkgroups(1);
        pass.end();
        const staging = dev.createBuffer({ size: 32, usage: BUF.MAP_READ | BUF.COPY_DST });
        enc.copyBufferToBuffer(this.bufs.META, 0, staging, 0, 32);
        dev.queue.submit([enc.finish()]);
        inflight.push({ staging, done: staging.mapAsync(MAP_READ) });
        queued = next;
      }
      // Keep two chunks queued; read the oldest state.
      if (inflight.length >= 2 || queued >= L.maxSteps) await readState(inflight.shift()!);
      this.step = state.step;
      const now = performance.now();
      if (opts.onProgress && (now - lastReport > 100 || state.done)) {
        lastReport = now;
        opts.onProgress({ step: state.step, maxSteps: L.maxSteps, energyDb: state.energyDb, targetDb: L.energyEndDb, seconds: (now - t0) / 1000 });
      }
      if (!state.done && opts.cancelled?.()) throw new GpuError('CANCELLED', 'run cancelled');
      if (!state.done && opts.loseDeviceAfter !== undefined && state.step >= opts.loseDeviceAfter) {
        // Test hook (?gpuLoseDevice=N): behave as if the GPU went away mid-run.
        this.lost = 'device destroyed by the test hook';
        dev.destroy();
        this.check();
      }
      if (!state.done && queued >= L.maxSteps && !inflight.length) throw new GpuError('GPU_ERROR', 'the step cap was reached without the GPU marking the run finished');
    }
    // Drain chunks queued after the end (no-ops on the GPU).
    for (const p of inflight) await p.done.then(() => p.staging.destroy(), () => undefined);
    const seconds = (performance.now() - t0) / 1000;
    const out = await this.outputs();
    return { steps: state.step, energyDb: state.energyDb, terminatedBy: state.term === 1 ? 'energy' : 'maxSteps', seconds, ...out };
  }

  /** Port series and NF2FF accumulators (Kahan total minus compensation, times dt). */
  async outputs(): Promise<{ voltage: Float64Array; current: Float64Array; nf2ffAcc: Float64Array }> {
    const n = this.step;
    const v = this.layout.port ? new Float32Array(await this.read(this.bufs.IO, 0, n * 4)) : new Float32Array(0);
    const i = this.layout.port ? new Float32Array(await this.read(this.bufs.IO, this.ioI * 4, n * 4)) : new Float32Array(0);
    let nf2ffAcc = new Float64Array(0);
    if (this.accL) {
      // Fold any steps since the last measurement, then read totals and compensation.
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, this.bg0);
      pass.setBindGroup(1, this.bg1, [0]);
      pass.setPipeline(this.pipes.fold);
      pass.dispatchWorkgroups(Math.ceil((2 * this.accL) / 256));
      pass.end();
      const both = new Float32Array(await this.read(this.bufs.ACC, 2 * this.accL * 4, 4 * this.accL * 4, enc));
      const L2 = 2 * this.accL;
      nf2ffAcc = new Float64Array(L2);
      const dt = this.layout.dt;
      for (let k = 0; k < L2; k++) nf2ffAcc[k] = (both[k] - both[L2 + k]) * dt;
    }
    return { voltage: Float64Array.from(v), current: Float64Array.from(i), nf2ffAcc };
  }

  /** One field component (0-2 E, 3-5 H), for comparisons with the CPU solver. */
  async readField(comp: number): Promise<Float32Array> {
    const N = this.layout.nodes;
    return new Float32Array(await this.read(this.bufs.F, comp * N * 4, N * 4));
  }

  destroy() {
    for (const b of Object.values(this.bufs)) b.destroy();
  }
}

function concat(arrs: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function scale(a: Float32Array, s: number): Float32Array {
  return a.map((v) => v * s);
}

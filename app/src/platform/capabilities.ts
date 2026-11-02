// Runtime feature detection. Every flag records what was actually observed,
// and every "unavailable" carries a reason the UI can show.

export interface WebGpuInfo {
  available: boolean;
  reason?: string;
  adapter?: { vendor: string; architecture: string; device: string; description: string };
  limits?: Record<string, number>;
  features?: string[];
}

export interface Capabilities {
  secureContext: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  /** Multi-threaded wasm is usable: cross-origin isolated and SharedArrayBuffer present. */
  threads: boolean;
  threadsReason?: string;
  hardwareConcurrency: number;
  deviceMemoryGB?: number;
  wasm: boolean;
  wasmSimd: boolean;
  /** Legacy wasm exception handling, which the solver build uses (Emscripten default). */
  wasmExceptions: boolean;
  webgpu: WebGpuInfo;
}

// Minimal modules from the wasm-feature-detect project (Apache-2.0).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
const EH_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11,
]);

function validates(bytes: Uint8Array): boolean {
  try {
    return WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

const GPU_LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
  'maxComputeWorkgroupSizeX',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupsPerDimension',
] as const;

// Typed locally to avoid a dependency on @webgpu/types for one probe.
interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  limits: Record<string, number>;
  features: Iterable<string>;
}
interface GpuLike {
  requestAdapter(opts?: { powerPreference?: string }): Promise<GpuAdapterLike | null>;
}

export async function detectWebGpu(): Promise<WebGpuInfo> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) {
    return {
      available: false,
      reason: isSecureContext
        ? 'navigator.gpu is not present (browser without WebGPU, or it is disabled)'
        : 'not a secure context (WebGPU requires HTTPS or localhost)',
    };
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'requestAdapter() returned null (no suitable GPU or blocklisted)' };
    const limits: Record<string, number> = {};
    for (const k of GPU_LIMITS) limits[k] = adapter.limits[k];
    return {
      available: true,
      adapter: {
        vendor: adapter.info?.vendor ?? '',
        architecture: adapter.info?.architecture ?? '',
        device: adapter.info?.device ?? '',
        description: adapter.info?.description ?? '',
      },
      limits,
      features: [...adapter.features].sort(),
    };
  } catch (e) {
    return { available: false, reason: `requestAdapter() failed: ${(e as Error).message}` };
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const wasm = typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';
  const sab = typeof SharedArrayBuffer === 'function';
  const coi = globalThis.crossOriginIsolated === true;
  let threadsReason: string | undefined;
  if (!coi) threadsReason = 'page is not cross-origin isolated (needs COOP: same-origin + COEP: require-corp)';
  else if (!sab) threadsReason = 'SharedArrayBuffer is unavailable';
  return {
    secureContext: isSecureContext,
    crossOriginIsolated: coi,
    sharedArrayBuffer: sab,
    threads: wasm && coi && sab,
    threadsReason,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    wasm,
    wasmSimd: wasm && validates(SIMD_PROBE),
    wasmExceptions: wasm && validates(EH_PROBE),
    webgpu: await detectWebGpu(),
  };
}

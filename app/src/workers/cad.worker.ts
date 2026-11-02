/// <reference lib="webworker" />
// CAD worker: STEP parsing and tessellation (occt-import-js, LGPL-2.1), unit
// detection and mesh analysis. occt-import-js ships as separate files under
// /vendor/ and is loaded on the first import; it is synchronous, so progress
// is reported per stage.
import { convertOcctResult, DISPLAY_TESSELLATION, sha256Hex, type OcctResult } from '../cad/occtImport';
import { parseStepUnits } from '../cad/stepUnits';
import { modelTransferables, type CadRequest, type CadResponse, type SimTessellation } from './cadProtocol';

declare const self: DedicatedWorkerGlobalScope;

type Occt = { ReadStepFile(content: Uint8Array, params: object | null): unknown };
type OcctFactory = (opts: { locateFile: (path: string) => string }) => Promise<Occt>;
let occt: Promise<Occt> | null = null;

const vendorBase = new URL(`${import.meta.env.BASE_URL}vendor/occt-import-js/`, self.location.origin).href;

async function loadKernel(): Promise<Occt> {
  const mod = (await import(/* @vite-ignore */ `${vendorBase}occt-import-js.mjs`)) as { default: OcctFactory };
  return mod.default({ locateFile: (path) => `${vendorBase}${path}` });
}

function post(msg: CadResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

async function tessellate(msg: Extract<CadRequest, { type: 'tessellate' }>) {
  const t0 = performance.now();
  occt ??= loadKernel();
  const kernel = await occt;
  const result = kernel.ReadStepFile(msg.bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: msg.deflection,
    angularDeflection: msg.angularDeflection,
  }) as OcctResult;
  // Same conversion as the display import, so body ids match.
  const model = convertOcctResult(result, { fileName: '', sha256: '', units: { unit: null, found: [] } });
  const bodies: SimTessellation[] = model.bodies.map((b) => ({ id: b.id, positions: b.positions, indices: b.indices }));
  const triangles = bodies.reduce((n, b) => n + b.indices.length / 3, 0);
  post(
    { type: 'tessellated', id: msg.id, bodies, triangles, seconds: (performance.now() - t0) / 1000 },
    bodies.flatMap((b) => [b.positions.buffer as ArrayBuffer, b.indices.buffer as ArrayBuffer]),
  );
}

self.onmessage = async (ev: MessageEvent<CadRequest>) => {
  const msg = ev.data;
  if (msg.type === 'tessellate') {
    try {
      await tessellate(msg);
    } catch (e) {
      post({ type: 'error', id: msg.id, message: (e as Error)?.message ?? String(e) });
    }
    return;
  }
  if (msg.type !== 'import') return;
  const t0 = performance.now();
  try {
    post({ type: 'progress', id: msg.id, stage: 'loading-kernel' });
    occt ??= loadKernel();
    const kernel = await occt;
    const sha256 = await sha256Hex(msg.bytes);
    const units = parseStepUnits(msg.bytes);
    post({ type: 'progress', id: msg.id, stage: 'parsing' });
    const result = kernel.ReadStepFile(msg.bytes, DISPLAY_TESSELLATION) as OcctResult;
    post({ type: 'progress', id: msg.id, stage: 'analyzing' });
    const model = convertOcctResult(result, { fileName: msg.fileName, sha256, units });
    post({ type: 'imported', id: msg.id, model, seconds: (performance.now() - t0) / 1000 }, modelTransferables(model));
  } catch (e) {
    occt = null; // allow a retry if the kernel failed to load
    post({ type: 'error', id: msg.id, message: (e as Error)?.message ?? String(e) });
  }
};

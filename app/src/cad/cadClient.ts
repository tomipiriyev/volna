// Main-thread handle to the CAD worker. The worker (and its ~7.6 MB OCCT
// wasm) is created on the first import only.
import type { CadModel } from '../model/types';
import type { CadRequest, CadResponse, CadStage, SimTessellation } from '../workers/cadProtocol';

let worker: Worker | null = null;
let nextId = 1;

export interface ImportResult {
  model: CadModel;
  seconds: number;
}

export function importStep(
  fileName: string,
  bytes: Uint8Array,
  onStage?: (stage: CadStage) => void,
): { promise: Promise<ImportResult>; cancel: () => void } {
  worker ??= new Worker(new URL('../workers/cad.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = nextId++;
  let cancel = () => {};
  const promise = new Promise<ImportResult>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<CadResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onStage?.(m.stage);
      else {
        w.removeEventListener('message', onMessage);
        if (m.type === 'imported') resolve({ model: m.model, seconds: m.seconds });
        else if (m.type === 'error') reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMessage);
    w.onerror = (ev) => {
      reject(new Error(`CAD worker crashed: ${ev.message || 'unknown error'}`));
      worker = null;
    };
    // The kernel call is synchronous inside the worker; cancelling terminates it.
    cancel = () => {
      w.terminate();
      if (worker === w) worker = null;
      reject(new Error('import cancelled'));
    };
    // Copy so the caller keeps its bytes (they are embedded in project files).
    const req: CadRequest = { type: 'import', id, fileName, bytes: bytes.slice() };
    w.postMessage(req, [req.bytes.buffer]);
  });
  return { promise, cancel };
}

/** Simulation tessellation of the given STEP bytes (absolute chord deviation in imported mm). */
export function tessellateForSimulation(
  bytes: Uint8Array,
  deflection: number,
): Promise<{ bodies: SimTessellation[]; triangles: number; seconds: number }> {
  worker ??= new Worker(new URL('../workers/cad.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<CadResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') return;
      w.removeEventListener('message', onMessage);
      if (m.type === 'tessellated') resolve({ bodies: m.bodies, triangles: m.triangles, seconds: m.seconds });
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.addEventListener('message', onMessage);
    const req: CadRequest = { type: 'tessellate', id, bytes: bytes.slice(), deflection, angularDeflection: 0.2 };
    w.postMessage(req, [req.bytes.buffer]);
  });
}

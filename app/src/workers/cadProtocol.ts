// Messages between the main thread and the CAD worker.
import type { CadModel } from '../model/types';

export type CadRequest =
  | { type: 'import'; id: number; fileName: string; bytes: Uint8Array }
  /** Re-tessellate for simulation with an absolute chord deviation (imported mm). */
  | { type: 'tessellate'; id: number; bytes: Uint8Array; deflection: number; angularDeflection: number };

export interface SimTessellation {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export type CadStage = 'loading-kernel' | 'parsing' | 'analyzing';

export type CadResponse =
  | { type: 'progress'; id: number; stage: CadStage }
  | { type: 'imported'; id: number; model: CadModel; seconds: number }
  | { type: 'tessellated'; id: number; bodies: SimTessellation[]; triangles: number; seconds: number }
  | { type: 'error'; id: number; message: string };

/** Typed arrays in a model, for zero-copy transfer between threads. */
export function modelTransferables(model: CadModel): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of model.bodies) {
    for (const arr of [b.positions, b.indices, b.featureEdges, b.normals]) if (arr) out.push(arr.buffer as ArrayBuffer);
  }
  return out;
}

// Synthetic swept round wires (a circle carried along a path, flat end caps) as CadBodies,
// tessellated like the CAD importer's output: one face for the side, one per cap.
import { analyzeBody } from '../../src/cad/meshAnalysis';
import type { CadBody, Vec3 } from '../../src/model/types';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A tube of radius r along `path` (sampled at nSeg + 1 points), nAround facets around. */
export function tubeBody(id: string, path: (t: number) => Vec3, r: number, nSeg = 200, nAround = 16): CadBody {
  const c: Vec3[] = Array.from({ length: nSeg + 1 }, (_, i) => path(i / nSeg));
  const T = c.map((_, i) => unit(sub(c[Math.min(i + 1, nSeg)], c[Math.max(i - 1, 0)])));
  // Parallel-transported frame.
  const N: Vec3[] = [];
  const seed: Vec3 = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  N.push(unit(cross(cross(T[0], seed), T[0])));
  for (let i = 1; i <= nSeg; i++) N.push(unit(cross(cross(T[i], N[i - 1]), T[i])));
  const pos: number[] = [];
  const ring = (i: number, j: number): Vec3 => {
    const th = (2 * Math.PI * j) / nAround, B = cross(T[i], N[i]);
    return [0, 1, 2].map((k) => c[i][k] + r * (Math.cos(th) * N[i][k] + Math.sin(th) * B[k])) as Vec3;
  };
  for (let i = 0; i <= nSeg; i++) for (let j = 0; j < nAround; j++) pos.push(...ring(i, j));
  const idx: number[] = [];
  const v = (i: number, j: number) => i * nAround + (j % nAround);
  for (let i = 0; i < nSeg; i++)
    for (let j = 0; j < nAround; j++) idx.push(v(i, j), v(i, j + 1), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1), v(i + 1, j));
  const side = idx.length / 3;
  for (const [i, sign] of [[0, -1], [nSeg, 1]] as const) {
    const base = pos.length / 3;
    pos.push(...c[i]);
    for (let j = 0; j < nAround; j++) pos.push(...ring(i, j));
    for (let j = 0; j < nAround; j++) {
      const a = base + 1 + j, b = base + 1 + ((j + 1) % nAround);
      if (sign < 0) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  }
  const positions = Float32Array.from(pos), indices = Uint32Array.from(idx);
  const ranges = [{ first: 0, last: side - 1 }, { first: side, last: side + nAround - 1 }, { first: side + nAround, last: side + 2 * nAround - 1 }];
  const an = analyzeBody(positions, indices, ranges);
  return { id, name: id, path: [], positions, indices, featureEdges: an.featureEdges, faces: an.faces, bbox: an.bbox, topology: an.topology, fingerprint: an.fingerprint };
}

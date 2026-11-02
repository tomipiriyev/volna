// Small geometric queries on body tessellations (model coordinates, mm).
import type { Axis, Box3, CadBody, Vec3 } from './types';

export interface RayHit {
  t: number;
  normal: Vec3; // unit triangle normal (outward for consistently oriented closed meshes)
  triangle: number;
}

/** All intersections of the infinite line origin + t*dir with the body's triangles, sorted by t. */
export function lineHits(body: CadBody, origin: Vec3, dir: Vec3): RayHit[] {
  const p = body.positions, idx = body.indices;
  const hits: RayHit[] = [];
  const eps = 1e-12;
  for (let tri = 0; tri < idx.length / 3; tri++) {
    const a = 3 * idx[3 * tri], b = 3 * idx[3 * tri + 1], c = 3 * idx[3 * tri + 2];
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < eps) continue;
    const inv = 1 / det;
    const tx = origin[0] - p[a], ty = origin[1] - p[a + 1], tz = origin[2] - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    hits.push({ t, normal: [nx / nl, ny / nl, nz / nl], triangle: tri });
  }
  hits.sort((x, y) => x.t - y.t);
  // A line through a shared edge/vertex hits several triangles at the same t.
  return hits.filter((h, i) => i === 0 || Math.abs(h.t - hits[i - 1].t) > 1e-9);
}

export function axisLine(axis: Axis, lateral: [number, number]): { origin: Vec3; dir: Vec3 } {
  const [u, v] = otherAxes(axis);
  const origin: Vec3 = [0, 0, 0];
  origin[u] = lateral[0];
  origin[v] = lateral[1];
  const dir: Vec3 = [0, 0, 0];
  dir[axis] = 1;
  return { origin, dir };
}

export function otherAxes(axis: Axis): [Axis, Axis] {
  return axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
}

export function boxSize(b: Box3): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Overlap depth per axis (negative = separated by that distance). */
export function boxOverlap(a: Box3, b: Box3): Vec3 {
  return [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])) as Vec3;
}

/** Euclidean distance between boxes (0 if they touch or overlap). */
export function boxDistance(a: Box3, b: Box3): number {
  const o = boxOverlap(a, b);
  return Math.hypot(...o.map((x) => Math.max(0, -x)));
}

function pointTriangleDistanceSq(px: number, py: number, pz: number, p: Float32Array, a: number, b: number, c: number) {
  // Ericson, Real-Time Collision Detection, 5.1.5 (closest point on triangle).
  const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
  const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
  const apx = px - p[a], apy = py - p[a + 1], apz = pz - p[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number) => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - p[b], bpy = py - p[b + 1], bpz = pz - p[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(apx - v * abx, apy - v * aby, apz - v * abz);
  }
  const cpx = px - p[c], cpy = py - p[c + 1], cpz = pz - p[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(apx - w * acx, apy - w * acy, apz - w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    // Closest point b + w (c - b); P - Q = (P - b) - w (c - b).
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(bpx - w * (p[c] - p[b]), bpy - w * (p[c + 1] - p[b + 1]), bpz - w * (p[c + 2] - p[b + 2]));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

/**
 * Approximate minimum distance between two meshes: vertex-to-triangle in
 * both directions. Exact when the closest pair involves a vertex (always
 * true for touching or face-parallel bodies); can overestimate edge-to-edge
 * gaps. Returns null if the pair is too large to check (work > maxWork).
 */
export function approxMeshDistance(a: CadBody, b: CadBody, maxWork = 4e6): number | null {
  const work = (a.positions.length / 3) * (b.indices.length / 3) + (b.positions.length / 3) * (a.indices.length / 3);
  if (work > maxWork) return null;
  let best = Infinity;
  const sweep = (src: CadBody, dst: CadBody) => {
    const p = dst.positions, idx = dst.indices, s = src.positions;
    for (let v = 0; v < s.length; v += 3) {
      for (let t = 0; t < idx.length; t += 3) {
        const d = pointTriangleDistanceSq(s[v], s[v + 1], s[v + 2], p, 3 * idx[t], 3 * idx[t + 1], 3 * idx[t + 2]);
        if (d < best) best = d;
      }
    }
  };
  sweep(a, b);
  sweep(b, a);
  return Math.sqrt(best);
}

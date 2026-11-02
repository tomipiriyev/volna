// Tessellation analysis for one body: welding, edge topology (open, non-
// manifold, inconsistently oriented), per-B-rep-face properties, enclosed
// volume and feature edges for display. Pure TS, runs in the CAD worker.
//
// These are facts about the *display tessellation*. They detect open shells,
// zero-thickness sheets and thin features; they are not a B-rep validity
// check (occt-import-js does not expose BRepCheck).
import type { Axis, Box3, CadFace, Fingerprint, MeshTopology, Vec3 } from '../model/types';

const COS_HALF_DEG = Math.cos((0.5 * Math.PI) / 180);

export interface FaceRange {
  first: number;
  last: number;
  color?: Vec3;
}

export interface BodyAnalysis {
  topology: MeshTopology;
  faces: CadFace[];
  featureEdges: Uint32Array;
  bbox: Box3;
  fingerprint: Fingerprint;
}

/** Canonical vertex id per vertex: identical float32 positions share an id. */
export function weldVertices(positions: Float32Array): Uint32Array {
  const n = positions.length / 3;
  const norm = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) norm[i] = positions[i] === 0 ? 0 : positions[i]; // -0 -> +0
  const bits = new Uint32Array(norm.buffer);
  let cap = 16;
  while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const canon = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const a = bits[3 * v], b = bits[3 * v + 1], c = bits[3 * v + 2];
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    for (;;) {
      const slot = h & (cap - 1);
      const w = table[slot];
      if (w < 0) {
        table[slot] = v;
        canon[v] = v;
        break;
      }
      if (bits[3 * w] === a && bits[3 * w + 1] === b && bits[3 * w + 2] === c) {
        canon[v] = w;
        break;
      }
      h++;
    }
  }
  return canon;
}

export function computeBBox(positions: Float32Array): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export function analyzeBody(positions: Float32Array, indices: Uint32Array, ranges: FaceRange[]): BodyAnalysis {
  const nTri = indices.length / 3;
  const canon = weldVertices(positions);
  const bbox = computeBBox(positions);
  const diag = Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]);
  const degenerateArea = 1e-12 * diag * diag;

  // Triangle -> B-rep face.
  const triFace = new Int32Array(nTri).fill(-1);
  ranges.forEach((r, f) => {
    for (let t = r.first; t <= r.last; t++) triFace[t] = f;
  });

  // Per-triangle area vector (cross product / 2) in double precision.
  const tn = new Float64Array(nTri * 3);
  let area = 0, volume6 = 0, degenerate = 0;
  const p = (i: number, a: number) => positions[3 * i + a];
  for (let t = 0; t < nTri; t++) {
    const i0 = indices[3 * t], i1 = indices[3 * t + 1], i2 = indices[3 * t + 2];
    const ux = p(i1, 0) - p(i0, 0), uy = p(i1, 1) - p(i0, 1), uz = p(i1, 2) - p(i0, 2);
    const vx = p(i2, 0) - p(i0, 0), vy = p(i2, 1) - p(i0, 1), vz = p(i2, 2) - p(i0, 2);
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    tn[3 * t] = cx / 2;
    tn[3 * t + 1] = cy / 2;
    tn[3 * t + 2] = cz / 2;
    const a = Math.hypot(cx, cy, cz) / 2;
    area += a;
    if (a <= degenerateArea || canon[i0] === canon[i1] || canon[i1] === canon[i2] || canon[i0] === canon[i2])
      degenerate++;
    // Signed tetra volume against the origin (divergence theorem).
    volume6 += p(i0, 0) * (p(i1, 1) * p(i2, 2) - p(i1, 2) * p(i2, 1)) -
      p(i0, 1) * (p(i1, 0) * p(i2, 2) - p(i1, 2) * p(i2, 0)) +
      p(i0, 2) * (p(i1, 0) * p(i2, 1) - p(i1, 1) * p(i2, 0));
  }

  // Undirected edges keyed by canonical endpoints.
  const nCanon = canon.length;
  const edgeId = new Map<number, number>();
  const fwd: number[] = [], bwd: number[] = [], faceA: number[] = [], faceB: number[] = [], ends: number[] = [];
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const ia = indices[3 * t + e], ib = indices[3 * t + ((e + 1) % 3)];
      const a = canon[ia], b = canon[ib];
      if (a === b) continue;
      const key = a < b ? a * nCanon + b : b * nCanon + a;
      let id = edgeId.get(key);
      if (id === undefined) {
        id = fwd.length;
        edgeId.set(key, id);
        fwd.push(0);
        bwd.push(0);
        faceA.push(triFace[t]);
        faceB.push(-2);
        ends.push(ia, ib);
      } else if (faceB[id] === -2) faceB[id] = triFace[t];
      if (a < b) fwd[id]++;
      else bwd[id]++;
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  const feature: number[] = [];
  for (let id = 0; id < fwd.length; id++) {
    const total = fwd[id] + bwd[id];
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (fwd[id] === 2 || bwd[id] === 2) inconsistent++;
    if (total !== 2 || faceA[id] !== faceB[id]) feature.push(ends[2 * id], ends[2 * id + 1]);
  }
  const closed = boundary === 0 && nonManifold === 0 && inconsistent === 0 && nTri > 0;
  const volume = closed ? volume6 / 6 : null;

  // Per-face properties.
  const faces: CadFace[] = ranges.map((r, f) => {
    let fa = 0;
    const c: Vec3 = [0, 0, 0];
    const nsum: Vec3 = [0, 0, 0];
    for (let t = r.first; t <= r.last; t++) {
      const ax = tn[3 * t], ay = tn[3 * t + 1], az = tn[3 * t + 2];
      const a = Math.hypot(ax, ay, az);
      fa += a;
      nsum[0] += ax;
      nsum[1] += ay;
      nsum[2] += az;
      for (let k = 0; k < 3; k++) {
        const i = indices[3 * t + k];
        c[0] += (a * p(i, 0)) / 3;
        c[1] += (a * p(i, 1)) / 3;
        c[2] += (a * p(i, 2)) / 3;
      }
    }
    const nl = Math.hypot(nsum[0], nsum[1], nsum[2]);
    const normal: Vec3 = nl > 0 ? [nsum[0] / nl, nsum[1] / nl, nsum[2] / nl] : [0, 0, 0];
    let planar = nl > 0;
    for (let t = r.first; t <= r.last && planar; t++) {
      const ax = tn[3 * t], ay = tn[3 * t + 1], az = tn[3 * t + 2];
      const a = Math.hypot(ax, ay, az);
      if (a <= degenerateArea) continue;
      if ((ax * normal[0] + ay * normal[1] + az * normal[2]) / a < COS_HALF_DEG) planar = false;
    }
    let axisAligned: Axis | null = null;
    if (planar) for (const ax of [0, 1, 2] as Axis[]) if (Math.abs(normal[ax]) >= COS_HALF_DEG) axisAligned = ax;
    return {
      index: f,
      triFirst: r.first,
      triLast: r.last,
      color: r.color,
      area: fa,
      centroid: fa > 0 ? [c[0] / fa, c[1] / fa, c[2] / fa] : [0, 0, 0],
      normal,
      planar,
      axisAligned,
    };
  });

  const centroid: Vec3 = [0, 0, 0];
  for (const f of faces) for (let a = 0; a < 3; a++) centroid[a] += f.centroid[a] * f.area;
  if (area > 0) for (let a = 0; a < 3; a++) centroid[a] /= area;

  return {
    topology: {
      closed,
      boundaryEdges: boundary,
      nonManifoldEdges: nonManifold,
      inconsistentEdges: inconsistent,
      degenerateTriangles: degenerate,
      area,
      volume,
      characteristicThickness: volume !== null && volume > 0 && area > 0 ? (2 * volume) / area : null,
    },
    faces,
    featureEdges: Uint32Array.from(feature),
    bbox,
    fingerprint: { area, centroid, bbox, faceCount: faces.length },
  };
}

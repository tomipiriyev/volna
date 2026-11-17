// Centreline and radius of a thin round wire bent along any path (a circular section swept
// along a 3-D curve), recovered from its tessellation, since STEP arrives here only as
// triangles. The solver models it as a chain of thin-wire segments (docs/physics.md,
// "Thin wires").
//
// 1. The two end caps are the planar faces whose area is about pi r^2 (r from 2V/A); their
//    centroids are the wire's ends.
// 2. Every vertex on the side surface, moved inward along its normal by r, lies on the axis.
// 3. Those axis points are ordered by their distance from the first cap measured over the
//    side surface (Dijkstra on the welded mesh), averaged in bins of 2r, and joined with the
//    cap centroids into a polyline; then re-binned twice, in bins of r, by the arc length of
//    each axis point's projection onto that path (fine enough for bends of a few r).
// 4. r is re-measured as the mean distance of the side vertices from that polyline and the
//    path recomputed once. The result is accepted only if every side vertex lies within
//    r +- 25 % of the path and the path's length matches the volume (V / pi r^2) to 10 %.
import type { CadBody, Vec3 } from './types';

export interface WirePath {
  /** Centreline, model units, from one end cap to the other. */
  points: Vec3[];
  radius: number;
  length: number;
}

const cache = new WeakMap<CadBody, WirePath | null>();

/** The body's wire path, or null if it is not a thin swept round wire with two flat ends. */
export function wirePath(body: CadBody): WirePath | null {
  if (!cache.has(body)) cache.set(body, extract(body));
  return cache.get(body)!;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

function polylineLength(p: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += norm(sub(p[i], p[i - 1]));
  return s;
}

/** Distance from q to the polyline. */
export function distanceToPath(q: Vec3, path: Vec3[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], d = sub(path[i], a), l2 = dot(d, d);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / l2)) : 0;
    best = Math.min(best, norm(sub(q, [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]])));
  }
  return best;
}

/** Arc length along the polyline to the point nearest q. */
function arcOfProjection(q: Vec3, path: Vec3[]): number {
  let best = Infinity, at = 0, s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], d = sub(path[i], a), l2 = dot(d, d), l = Math.sqrt(l2);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / l2)) : 0;
    const e = norm(sub(q, [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]));
    if (e < best) (best = e), (at = s + t * l);
    s += l;
  }
  return at;
}

function extract(body: CadBody): WirePath | null {
  const topo = body.topology;
  if (!topo.closed || !topo.volume || topo.volume <= 0 || !topo.characteristicThickness) return null;
  const V = topo.volume;
  // 2V/A = r L / (L + r) for a capped tube; one fixed-point step recovers r.
  let r = topo.characteristicThickness;
  r = r * (1 + r / (V / (Math.PI * r * r)));
  const P = body.positions, I = body.indices;
  const vert = (i: number): Vec3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];

  // End caps: planar faces of area ~ pi r^2 whose vertices stay within ~1.3 r of the centroid.
  const caps = body.faces.filter((f) => {
    if (!f.planar || Math.abs(f.area / (Math.PI * r * r) - 1) > 0.35) return false;
    for (let t = f.triFirst; t <= f.triLast; t++)
      for (let k = 0; k < 3; k++) if (norm(sub(vert(I[3 * t + k]), f.centroid)) > 1.3 * r) return false;
    return true;
  });
  if (caps.length !== 2) return null;
  const capTris = new Set<number>();
  for (const f of caps) for (let t = f.triFirst; t <= f.triLast; t++) capTris.add(t);
  const nTri = I.length / 3;
  if (nTri - capTris.size < 8) return null;
  // The wire must be long next to its radius, or it is a stub (a solid or a disc).
  if (V / (Math.PI * r * r) < 4 * r) return null;

  // Weld coincident vertices (faces carry their own copies along shared edges).
  const key = (i: number) => `${Math.round(P[3 * i] * 1e4)},${Math.round(P[3 * i + 1] * 1e4)},${Math.round(P[3 * i + 2] * 1e4)}`;
  const weld = new Map<string, number>();
  const wid = new Int32Array(P.length / 3);
  const wpos: Vec3[] = [];
  for (let i = 0; i < P.length / 3; i++) {
    const k = key(i);
    let w = weld.get(k);
    if (w === undefined) weld.set(k, (w = wpos.length)), wpos.push(vert(i));
    wid[i] = w;
  }
  const nW = wpos.length;
  // Outward vertex normals of the side surface from its triangles (closed mesh with positive
  // volume: counter-clockwise winding faces outward), and the side surface's edge graph.
  const nrm = new Float64Array(3 * nW);
  const side = new Uint8Array(nW);
  const adj: Map<number, number>[] = Array.from({ length: nW }, () => new Map());
  for (let t = 0; t < nTri; t++) {
    if (capTris.has(t)) continue;
    const ids = [wid[I[3 * t]], wid[I[3 * t + 1]], wid[I[3 * t + 2]]];
    const [a, b, c] = ids.map((w) => wpos[w]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (let k = 0; k < 3; k++) {
      const w = ids[k];
      side[w] = 1;
      for (let d = 0; d < 3; d++) nrm[3 * w + d] += n[d];
      const o = ids[(k + 1) % 3];
      const len = norm(sub(wpos[w], wpos[o]));
      adj[w].set(o, len);
      adj[o].set(w, len);
    }
  }
  const sideIds: number[] = [];
  for (let w = 0; w < nW; w++) {
    if (!side[w]) continue;
    const l = Math.hypot(nrm[3 * w], nrm[3 * w + 1], nrm[3 * w + 2]);
    if (l === 0) continue;
    for (let d = 0; d < 3; d++) nrm[3 * w + d] /= l;
    sideIds.push(w);
  }

  // Surface distance from the first cap's rim (side vertices that sit on that cap's boundary).
  const rimOf = (f: (typeof caps)[number]) => {
    const s = new Set<number>();
    for (let t = f.triFirst; t <= f.triLast; t++) for (let k = 0; k < 3; k++) if (side[wid[I[3 * t + k]]]) s.add(wid[I[3 * t + k]]);
    return s;
  };
  const rim0 = rimOf(caps[0]);
  if (rim0.size < 3 || rimOf(caps[1]).size < 3) return null;
  const dist = new Float64Array(nW).fill(Infinity);
  const heap: [number, number][] = [];
  const push = (d: number, w: number) => {
    heap.push([d, w]);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, rr = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const w of rim0) (dist[w] = 0), push(0, w);
  while (heap.length) {
    const [d, w] = pop();
    if (d > dist[w]) continue;
    for (const [o, len] of adj[w])
      if (d + len < dist[o]) (dist[o] = d + len), push(d + len, o);
  }
  if (sideIds.some((w) => !Number.isFinite(dist[w]))) return null; // not one connected tube

  const c0 = caps[0].centroid, c1 = caps[1].centroid;
  // Axis points binned by a parameter along the wire: first the surface distance, then (in
  // bends, where the inside and outside of the tube differ in length) the arc length of each
  // axis point's projection onto the previous path.
  const build = (radius: number, param: Float64Array, bin: number): Vec3[] => {
    const span = Math.max(...sideIds.map((w) => param[w]));
    const nb = Math.max(1, Math.ceil(span / bin));
    const acc = Array.from({ length: nb }, () => [0, 0, 0, 0]);
    for (const w of sideIds) {
      const b = Math.max(0, Math.min(nb - 1, Math.floor(param[w] / bin)));
      for (let d = 0; d < 3; d++) acc[b][d] += wpos[w][d] - radius * nrm[3 * w + d];
      acc[b][3]++;
    }
    const pts: Vec3[] = [c0];
    for (const a of acc) if (a[3] >= 3) pts.push([a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
    pts.push(c1);
    // Drop bin centres that fold back (a bin straddling the start or end of the side surface).
    const out: Vec3[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const q = pts[i];
      if (i < pts.length - 1 && norm(sub(q, out[out.length - 1])) < 0.5 * radius) continue;
      if (out.length >= 2 && i < pts.length - 1) {
        const u = sub(out[out.length - 1], out[out.length - 2]), v = sub(q, out[out.length - 1]);
        if (dot(u, v) < -0.5 * norm(u) * norm(v)) continue;
      }
      out.push(q);
    }
    return out;
  };
  const axisPoint = (w: number, radius: number): Vec3 => [wpos[w][0] - radius * nrm[3 * w], wpos[w][1] - radius * nrm[3 * w + 1], wpos[w][2] - radius * nrm[3 * w + 2]];
  const refine = (radius: number, path: Vec3[]) => {
    const param = new Float64Array(nW);
    for (const w of sideIds) param[w] = arcOfProjection(axisPoint(w, radius), path);
    return build(radius, param, radius);
  };
  let points = build(r, dist, 2 * r);
  for (let pass = 0; pass < 2; pass++) points = refine(r, points);
  let sum = 0;
  for (const w of sideIds) sum += distanceToPath(wpos[w], points);
  r = sum / sideIds.length;
  for (let pass = 0; pass < 2; pass++) points = refine(r, points);
  let worst = 0;
  for (const w of sideIds) worst = Math.max(worst, Math.abs(distanceToPath(wpos[w], points) / r - 1));
  const length = polylineLength(points);
  if (worst > 0.25 || Math.abs(length / (V / (Math.PI * r * r)) - 1) > 0.1) return null;
  return { points, radius: r, length };
}

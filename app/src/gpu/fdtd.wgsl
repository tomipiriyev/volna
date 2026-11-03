// FDTD time loop on the GPU. Mirrors the C++ solver (cpp/src/fdtd/yee.cpp,
// cpml.cpp, api/solver.cpp step(), nf2ff/nf2ff.cpp accumulate()) on the same
// node-indexed layout: q = i*sx + j*sy + k for every component.
//
// Buffers (group 0):
//   F    fields: Ex Ey Ez Hx Hy Hz, N floats each
//   M    material ids: two u16 per word; mx, my, mz, W words each
//   C    constants (offsets in P): ca cb epsR invD invDd d dd cpml profiles waveform port data
//   PSI  CPML state: psiEp psiEq (E slabs) psiHp psiHq (H slabs)
//   IO   V[maxSteps] I[maxSteps] energy partials, DFT twiddles of the current step
//   ACC  NF2FF DFT: chunk sums, Kahan totals, Kahan compensation (2*accL floats each)
//   META run state at [0..8): step, done, terminatedBy (1 energy, 2 maxSteps), -,
//        peak energy, energy dB, last energy (f32 bits); then slab, port, face, phase and cut-face tables
//        (offsets in P). Once `done` is set every step kernel is a no-op, so the host can
//        queue work ahead and the run still stops at the step the C++ loop would.
// Group 1 holds per-dispatch parameters (CPML slab, NF2FF field kind) at a dynamic offset.

struct Params {
  nx: u32, ny: u32, nz: u32, sx: u32,
  sy: u32, N: u32, W: u32, nMat: u32,
  chH: f32, nf: u32, nEdges: u32, nLines: u32,
  portAxis: u32, maxSteps: u32, nFaces: u32, totalSamples: u32,
  oCa: u32, oCb: u32, oEps: u32, oInvD: u32,
  oInvDd: u32, oD: u32, oDd: u32, oProfE: u32,
  oProfH: u32, oWave: u32, oEdgeLen: u32, oEdgeSrc: u32,
  oLineArea: u32, oLineW: u32, mSlab: u32, mEdges: u32,
  mLines: u32, mFaces: u32, mPhase: u32, psiEpO: u32,
  psiEqO: u32, psiHpO: u32, psiHqO: u32, accL: u32,
  ioI: u32, ioPart: u32, nPart: u32, etaSq: f32,
  ioTw: u32, dt: f32, pulseEnd: f32, targetDb: f32,
  nCut: u32, mCut: u32, oCut: u32, pad0: u32,
}

struct Dispatch { slab: u32, electric: u32, check: u32, pad1: u32 }

@group(0) @binding(0) var<storage, read_write> F: array<f32>;
@group(0) @binding(1) var<storage, read> M: array<u32>;
@group(0) @binding(2) var<storage, read> C: array<f32>;
@group(0) @binding(3) var<storage, read_write> PSI: array<f32>;
@group(0) @binding(4) var<storage, read_write> IO: array<f32>;
@group(0) @binding(5) var<storage, read_write> ACC: array<f32>;
@group(0) @binding(6) var<storage, read_write> META: array<u32>;
@group(0) @binding(7) var<uniform> P: Params;
@group(1) @binding(0) var<uniform> D: Dispatch;

const TWO_PI_OVER_2_32: f32 = 1.4629180792671596e-9; // 2 pi / 2^32

fn finished() -> bool { return META[1] != 0u; }

fn nAxis(a: u32) -> u32 { return select(select(P.nz, P.ny, a == 1u), P.nx, a == 0u); }
fn stride(a: u32) -> u32 { return select(select(1u, P.sy, a == 1u), P.sx, a == 0u); }
// Per-axis 1D arrays are stored back to back: primary (n cells) and dual (n + 1 nodes).
fn primOff(a: u32) -> u32 { return select(select(P.nx + P.ny, P.nx, a == 1u), 0u, a == 0u); }
fn dualOff(a: u32) -> u32 { return select(select(P.nx + P.ny + 2u, P.nx + 1u, a == 1u), 0u, a == 0u); }
fn invD(a: u32, i: u32) -> f32 { return C[P.oInvD + primOff(a) + i]; }
fn invDd(a: u32, i: u32) -> f32 { return C[P.oInvDd + dualOff(a) + i]; }
fn dPrim(a: u32, i: u32) -> f32 { return C[P.oD + primOff(a) + i]; }
fn dDual(a: u32, i: u32) -> f32 { return C[P.oDd + dualOff(a) + i]; }
fn eIdx(c: u32, q: u32) -> u32 { return c * P.N + q; }
fn hIdx(c: u32, q: u32) -> u32 { return (3u + c) * P.N + q; }
fn mat(c: u32, q: u32) -> u32 {
  let w = M[c * P.W + (q >> 1u)];
  return (w >> ((q & 1u) * 16u)) & 0xFFFFu;
}
fn idx3(v: vec3<u32>) -> u32 { return v.x * P.sx + v.y * P.sy + v.z; }
fn comp(v: vec3<u32>, a: u32) -> u32 { return select(select(v.z, v.y, a == 1u), v.x, a == 0u); }
fn withComp(v: vec3<u32>, a: u32, x: u32) -> vec3<u32> {
  var r = v;
  if (a == 0u) { r.x = x; } else if (a == 1u) { r.y = x; } else { r.z = x; }
  return r;
}
// E component c at node v is updated: tangential edges on the outer (PEC) faces stay 0.
fn eActive(c: u32, v: vec3<u32>) -> bool {
  for (var a = 0u; a < 3u; a++) {
    let m = comp(v, a);
    if (a == c) {
      if (m >= nAxis(a)) { return false; }
    } else if (m == 0u || m >= nAxis(a)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- bulk updates

@compute @workgroup_size(64, 1, 1)
fn updateH(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x; let j = g.y; let i = g.z;
  if (i > P.nx || j > P.ny || k > P.nz || finished()) { return; }
  let q = i * P.sx + j * P.sy + k;
  let N = P.N;
  let ch = P.chH;
  if (j < P.ny && k < P.nz) { // Hx
    F[3u * N + q] -= ch * ((F[2u * N + q + P.sy] - F[2u * N + q]) * invD(1u, j) - (F[N + q + 1u] - F[N + q]) * invD(2u, k));
  }
  if (i < P.nx) {
    if (k < P.nz) { // Hy
      F[4u * N + q] -= ch * ((F[q + 1u] - F[q]) * invD(2u, k) - (F[2u * N + q + P.sx] - F[2u * N + q]) * invD(0u, i));
    }
    if (j < P.ny) { // Hz
      F[5u * N + q] -= ch * ((F[N + q + P.sx] - F[N + q]) * invD(0u, i) - (F[q + P.sy] - F[q]) * invD(1u, j));
    }
  }
}

@compute @workgroup_size(64, 1, 1)
fn updateE(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x; let j = g.y; let i = g.z;
  if (i >= P.nx || j > P.ny || k > P.nz || finished()) { return; }
  let q = i * P.sx + j * P.sy + k;
  let N = P.N;
  if (j >= 1u && j < P.ny && k >= 1u && k < P.nz) { // Ex
    let curl = (F[5u * N + q] - F[5u * N + q - P.sy]) * invDd(1u, j) - (F[4u * N + q] - F[4u * N + q - 1u]) * invDd(2u, k);
    let m = mat(0u, q);
    F[q] = C[P.oCa + m] * F[q] + C[P.oCb + m] * curl;
  }
  if (i >= 1u) {
    if (j < P.ny && k >= 1u && k < P.nz) { // Ey
      let curl = (F[3u * N + q] - F[3u * N + q - 1u]) * invDd(2u, k) - (F[5u * N + q] - F[5u * N + q - P.sx]) * invDd(0u, i);
      let m = mat(1u, q);
      F[N + q] = C[P.oCa + m] * F[N + q] + C[P.oCb + m] * curl;
    }
    if (j >= 1u && j < P.ny && k < P.nz) { // Ez
      let curl = (F[4u * N + q] - F[4u * N + q - P.sx]) * invDd(0u, i) - (F[3u * N + q] - F[3u * N + q - P.sy]) * invDd(1u, j);
      let m = mat(2u, q);
      F[2u * N + q] = C[P.oCa + m] * F[2u * N + q] + C[P.oCb + m] * curl;
    }
  }
}

// Faces cut by conductors (YeeFields::applyCutFaces), after the bulk H update. META holds
// the flat F indices of H and its four contour edges, C their five coefficients.
@compute @workgroup_size(64, 1, 1)
fn cutFaces(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.nCut || finished()) { return; }
  let m = P.mCut + 5u * g.x;
  let c = P.oCut + 5u * g.x;
  let h = META[m];
  F[h] = C[c] * F[h] + C[c + 1u] * F[META[m + 1u]] + C[c + 2u] * F[META[m + 2u]] + C[c + 3u] * F[META[m + 3u]] + C[c + 4u] * F[META[m + 4u]];
}

// ---------------------------------------------------------------- CPML (one slab per dispatch)
// META slab record (12 words): axis lo hi nE nH planeE profE profH psiE psiH np nq

fn slab(f: u32) -> u32 { return META[P.mSlab + D.slab * 12u + f]; }

@compute @workgroup_size(64, 1, 1)
fn cpmlE(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = slab(0u); let np = slab(10u); let nq = slab(11u);
  let jq = g.x; let jp = g.y; let li = g.z;
  if (jq > nq || jp > np || li >= slab(3u) || finished()) { return; }
  let pAx = (a + 1u) % 3u; let qAx = (a + 2u) % 3u;
  let i = slab(1u) + li;
  let pr = P.oProfE + 2u * (slab(6u) + li);
  let b = C[pr]; let c = C[pr + 1u];
  if (c == 0.0) { return; }
  let inv = invDd(a, i);
  let v = withComp(withComp(withComp(vec3<u32>(0u), a, i), pAx, jp), qAx, jq);
  let at = idx3(v);
  let sa = stride(a);
  let ps = slab(8u) + li * slab(5u) + jp * (nq + 1u) + jq;
  if (jp < np && eActive(pAx, v)) {
    let d = (F[hIdx(qAx, at)] - F[hIdx(qAx, at - sa)]) * inv;
    let s = b * PSI[P.psiEpO + ps] + c * d;
    PSI[P.psiEpO + ps] = s;
    F[eIdx(pAx, at)] -= C[P.oCb + mat(pAx, at)] * s;
  }
  if (jq < nq && eActive(qAx, v)) {
    let d = (F[hIdx(pAx, at)] - F[hIdx(pAx, at - sa)]) * inv;
    let s = b * PSI[P.psiEqO + ps] + c * d;
    PSI[P.psiEqO + ps] = s;
    F[eIdx(qAx, at)] += C[P.oCb + mat(qAx, at)] * s;
  }
}

@compute @workgroup_size(64, 1, 1)
fn cpmlH(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = slab(0u); let np = slab(10u); let nq = slab(11u);
  let jq = g.x; let jp = g.y; let li = g.z;
  if (jq > nq || jp > np || li >= slab(4u) || finished()) { return; }
  let pAx = (a + 1u) % 3u; let qAx = (a + 2u) % 3u;
  let i = slab(1u) - 1u + li;
  let pr = P.oProfH + 2u * (slab(7u) + li);
  let b = C[pr]; let c = C[pr + 1u];
  if (c == 0.0) { return; }
  let inv = invD(a, i);
  let v = withComp(withComp(withComp(vec3<u32>(0u), a, i), pAx, jp), qAx, jq);
  let at = idx3(v);
  let sa = stride(a);
  let ps = slab(9u) + li * slab(5u) + jp * (nq + 1u) + jq;
  if (jq < nq) {
    let d = (F[eIdx(qAx, at + sa)] - F[eIdx(qAx, at)]) * inv;
    let s = b * PSI[P.psiHpO + ps] + c * d;
    PSI[P.psiHpO + ps] = s;
    F[hIdx(pAx, at)] += P.chH * s;
  }
  if (jp < np) {
    let d = (F[eIdx(pAx, at + sa)] - F[eIdx(pAx, at)]) * inv;
    let s = b * PSI[P.psiHqO + ps] + c * d;
    PSI[P.psiHqO + ps] = s;
    F[hIdx(qAx, at)] -= P.chH * s;
  }
}

// ---------------------------------------------------------------- lumped port

// (curl H)_c at the E edge of node v, with H outside the domain taken as 0.
fn curlH(c: u32, v: vec3<u32>) -> f32 {
  let p = (c + 1u) % 3u; let q = (c + 2u) % 3u;
  let at = idx3(v);
  var dq = 0.0; // d H_q / d p
  var dp = 0.0; // d H_p / d q
  let mp = comp(v, p);
  let mq = comp(v, q);
  let hiQ = select(0.0, F[hIdx(q, at)], mp <= nAxis(p) - 1u);
  let loQ = select(0.0, F[hIdx(q, at - stride(p))], mp >= 1u);
  dq = (hiQ - loQ) * invDd(p, mp);
  let hiP = select(0.0, F[hIdx(p, at)], mq <= nAxis(q) - 1u);
  let loP = select(0.0, F[hIdx(p, at - stride(q))], mq >= 1u);
  dp = (hiP - loP) * invDd(q, mq);
  return dq - dp;
}

@compute @workgroup_size(1)
fn portCurrent() {
  if (finished()) { return; }
  let n = META[0];
  var s = 0.0;
  for (var l = 0u; l < P.nLines; l++) {
    let b = P.mLines + 3u * l;
    s += curlH(P.portAxis, vec3<u32>(META[b], META[b + 1u], META[b + 2u])) * C[P.oLineArea + l];
  }
  IO[P.ioI + n] = s;
}

@compute @workgroup_size(1)
fn portVoltage() {
  if (finished()) { return; }
  let n = META[0];
  let g = C[P.oWave + n];
  var v = 0.0;
  for (var e = 0u; e < P.nEdges; e++) {
    let at = META[P.mEdges + 2u * e];
    let line = META[P.mEdges + 2u * e + 1u];
    let fi = eIdx(P.portAxis, at);
    F[fi] += C[P.oEdgeSrc + e] * g;
    v -= C[P.oLineW + line] * F[fi] * C[P.oEdgeLen + e];
  }
  IO[n] = v;
}

// ---------------------------------------------------------------- NF2FF running DFT
// META face record (16 words): a plane B0 B1 C0 C1 nb nc offEp offHq offEq offHp startB startC pad pad
// Each thread handles one sample (b or c) of one face; sums for the current chunk
// go to ACC[0 .. 2 accL); fold() moves them into the Kahan totals.

// cos/sin of the DFT phase for every frequency at this step: H at (n+1/2) dt, E at (n+1) dt.
// Computed once per step instead of per sample.
@compute @workgroup_size(1)
fn twiddle() {
  if (finished()) { return; }
  let n = META[0];
  for (var k = 0u; k < P.nf; k++) {
    let inc = META[P.mPhase + k];
    let phH = f32(inc * (2u * n + 1u)) * TWO_PI_OVER_2_32;
    let phE = f32(inc * (2u * n + 2u)) * TWO_PI_OVER_2_32;
    IO[P.ioTw + 4u * k] = cos(phH);
    IO[P.ioTw + 4u * k + 1u] = sin(phH);
    IO[P.ioTw + 4u * k + 2u] = cos(phE);
    IO[P.ioTw + 4u * k + 3u] = sin(phE);
  }
}

@compute @workgroup_size(64)
fn nf2ff(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = g.x;
  if (s >= P.totalSamples || finished()) { return; }
  var f = 0u;
  for (var t = 1u; t < P.nFaces; t++) {
    if (s >= META[P.mFaces + 16u * t + 12u]) { f = t; }
  }
  let r = P.mFaces + 16u * f;
  let a = META[r]; let plane = META[r + 1u];
  let B0 = META[r + 2u]; let B1 = META[r + 3u]; let C0 = META[r + 4u]; let C1 = META[r + 5u];
  let nb = META[r + 6u];
  let pAx = (a + 1u) % 3u; let qAx = (a + 2u) % 3u;
  let local = s - META[r + 12u];
  let electric = D.electric == 1u;
  var jp: u32; var jq: u32; var off: u32; var sample: u32; var isB: bool;
  if (local < nb) {
    isB = true; sample = local;
    let nbQ = C1 - C0 + 1u;
    jp = B0 + local / nbQ; jq = C0 + local % nbQ;
    off = select(META[r + 9u], META[r + 8u], electric);
  } else {
    isB = false; sample = local - nb;
    let ncQ = C1 - C0;
    jp = B0 + sample / ncQ; jq = C0 + sample % ncQ;
    off = select(META[r + 11u], META[r + 10u], electric);
  }
  let v3 = withComp(withComp(withComp(vec3<u32>(0u), a, plane), pAx, jp), qAx, jq);
  let at = idx3(v3);
  let sa = stride(a);
  var val: f32;
  if (electric) {
    val = F[eIdx(select(qAx, pAx, isB), at)];
  } else {
    let hc = select(pAx, qAx, isB); // b-samples carry H_q, c-samples H_p, averaged across the plane
    val = 0.5 * (F[hIdx(hc, at)] + F[hIdx(hc, at - sa)]);
  }
  // Twiddles of this step (twiddle()): exact u32 phase in whole half steps.
  let tw = P.ioTw + select(0u, 2u, electric);
  for (var k = 0u; k < P.nf; k++) {
    let e = 2u * (off + sample * P.nf + k);
    ACC[e] += val * IO[tw + 4u * k];
    ACC[e + 1u] -= val * IO[tw + 4u * k + 1u];
  }
}

@compute @workgroup_size(256)
fn fold(@builtin(global_invocation_id) g: vec3<u32>) {
  let e = g.x;
  if (e >= 2u * P.accL) { return; }
  let L2 = 2u * P.accL;
  let y = ACC[e] - ACC[2u * L2 + e];
  let t = ACC[L2 + e] + y;
  ACC[2u * L2 + e] = (t - ACC[L2 + e]) - y;
  ACC[L2 + e] = t;
  ACC[e] = 0.0;
}

// ---------------------------------------------------------------- energy and step counter
// Energy in units of eps0 * mm^3 (volumes in mm, H weighted by mu0/eps0 = eta0^2),
// summed per workgroup; the host adds the partials in double.

var<workgroup> wsum: array<f32, 256>;

fn nodeEnergy(q: u32) -> f32 {
  let k = q % P.sy;
  let j = (q / P.sy) % (P.ny + 1u);
  let i = q / P.sx;
  let N = P.N;
  var s = 0.0;
  let ex = F[q]; let ey = F[N + q]; let ez = F[2u * N + q];
  let hx = F[3u * N + q]; let hy = F[4u * N + q]; let hz = F[5u * N + q];
  if (i < P.nx) { s += C[P.oEps + mat(0u, q)] * ex * ex * dPrim(0u, i) * dDual(1u, j) * dDual(2u, k); }
  if (j < P.ny) { s += C[P.oEps + mat(1u, q)] * ey * ey * dDual(0u, i) * dPrim(1u, j) * dDual(2u, k); }
  if (k < P.nz) { s += C[P.oEps + mat(2u, q)] * ez * ez * dDual(0u, i) * dDual(1u, j) * dPrim(2u, k); }
  var h = 0.0;
  if (j < P.ny && k < P.nz) { h += hx * hx * dDual(0u, i) * dPrim(1u, j) * dPrim(2u, k); }
  if (i < P.nx && k < P.nz) { h += hy * hy * dPrim(0u, i) * dDual(1u, j) * dPrim(2u, k); }
  if (i < P.nx && j < P.ny) { h += hz * hz * dPrim(0u, i) * dPrim(1u, j) * dDual(2u, k); }
  return s + P.etaSq * h;
}

@compute @workgroup_size(256)
fn energy(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) w: vec3<u32>) {
  var s = 0.0;
  let total = P.nPart * 256u;
  for (var q = g.x; q < P.N; q += total) { s += nodeEnergy(q); }
  wsum[l.x] = s;
  workgroupBarrier();
  for (var h = 128u; h > 0u; h >>= 1u) {
    if (l.x < h) { wsum[l.x] += wsum[l.x + h]; }
    workgroupBarrier();
  }
  if (l.x == 0u) { IO[P.ioPart + w.x] = wsum[0]; }
}

@compute @workgroup_size(1)
fn advance() {
  if (!finished()) { META[0] = META[0] + 1u; }
}

// Termination at a chunk end, with the C++ criteria (Solver::step): at check steps the
// energy (sum of the partials) updates the peak and the dB level; the run ends when the
// pulse is over and the level is below the target, or at the step cap.
var<workgroup> esum: array<f32, 256>;

@compute @workgroup_size(256)
fn energyCheck(@builtin(local_invocation_id) l: vec3<u32>) {
  // No early exit before the barriers (they need uniform control flow); the done
  // flag is tested by the single thread that updates the state.
  var s = 0.0;
  for (var i = l.x; i < P.nPart; i += 256u) { s += IO[P.ioPart + i]; }
  esum[l.x] = s;
  workgroupBarrier();
  for (var h = 128u; h > 0u; h >>= 1u) {
    if (l.x < h) { esum[l.x] += esum[l.x + h]; }
    workgroupBarrier();
  }
  if (l.x != 0u || finished()) { return; }
  let step = META[0];
  if (D.check == 1u) {
    let w = esum[0];
    let peak = max(bitcast<f32>(META[4]), w);
    var db = 0.0;
    if (peak > 0.0 && w > 0.0) { db = 10.0 * log(w / peak) / log(10.0); } else if (peak > 0.0) { db = -300.0; }
    META[4] = bitcast<u32>(peak);
    META[5] = bitcast<u32>(db);
    META[6] = bitcast<u32>(w);
    if (f32(step) * P.dt > P.pulseEnd && peak > 0.0 && db <= P.targetDb) {
      META[1] = 1u;
      META[2] = 1u;
      return;
    }
  }
  if (step >= P.maxSteps) {
    META[1] = 1u;
    META[2] = 2u;
  }
}

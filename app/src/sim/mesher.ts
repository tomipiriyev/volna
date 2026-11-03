// Rectilinear grid generator for the FDTD solver (all lengths in true mm).
//
// 1. Background cell h0 = lambda(f_max) / cellsPerWavelength, divided by
//    sqrt(epsR) inside dielectric bodies.
// 2. Local refinement: thin dielectric layers get >= minSlabCells across;
//    small solid conductors >= 2 cells per dimension; the feed gap
//    >= feedGapCells along the feed axis and the same cell size laterally.
// 3. Fixed lines: solid faces, sheet planes (snapped), sheet outlines, wire
//    axes and ends, feed ends and the feed line, domain ends.
// 4. Each gap between fixed lines is split uniformly at its smallest allowed
//    cell, then cells are graded so neighbours differ by at most maxRatio.
// 5. Padding (structure to PML) and the PML cells are added outside.
import type { GeomClass } from '../model/classify';
import type { Axis, Box3, Vec3 } from '../model/types';

const C0 = 299792458;

export interface MeshSettings {
  cellsPerWavelength: number;
  maxRatio: number;
  /** Structure-to-PML clearance as a fraction of the wavelength at f_min. */
  paddingWavelengths: number;
  pmlCells: number;
  farFieldMarginCells: number;
  minSlabCells: number;
  feedGapCells: number;
  maxCells: number;
  /** Curved or oblique conductors use conformal faces instead of staircases (docs/physics.md). */
  conformal: boolean;
}

export const DEFAULT_MESH_SETTINGS: MeshSettings = {
  cellsPerWavelength: 20,
  maxRatio: 1.3,
  paddingWavelengths: 0.25,
  pmlCells: 8,
  farFieldMarginCells: 4,
  minSlabCells: 3,
  feedGapCells: 2,
  maxCells: 8_000_000,
  conformal: true,
};

export interface MeshBody {
  id: string;
  name: string;
  bbox: Box3; // true mm
  conductor: boolean;
  epsR: number; // 1 for conductors
  cls: GeomClass;
}

export interface MeshFeed {
  axis: Axis;
  start: Vec3; // reference side, true mm
  end: Vec3; // signal side
}

export interface MeshInput {
  bodies: MeshBody[];
  feed: MeshFeed | null;
  fMin: number;
  fMax: number;
  settings: MeshSettings;
}

export interface SheetPlacement {
  axis: Axis;
  coord: number; // grid plane the sheet is snapped to (mm)
}

export interface WirePlacement {
  axis: Axis;
  center: [number, number]; // on the other two axes, ascending order
  range: [number, number];
}

export interface MeshResult {
  lines: [number[], number[], number[]]; // node coordinates incl. PML, mm
  domain: Box3; // inside the PML
  structure: Box3;
  pmlCells: number;
  nf2ffBox: Box3;
  cells: number;
  minCell: Vec3;
  maxCell: Vec3;
  backgroundCell: number;
  sheets: Record<string, SheetPlacement>;
  wires: Record<string, WirePlacement>;
  notes: string[];
}

interface Region {
  lo: number;
  hi: number;
  h: number;
}

const otherAxes = (a: Axis): [Axis, Axis] => (a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1]);

/**
 * Fills the gaps between fixed lines. Each gap gets a geometric sequence that
 * starts at the size required at both ends (the finer of the two adjacent
 * gaps' limits), grows by `ratio` up to the gap's own limit, and is rescaled
 * to fit the gap exactly (rescaling keeps the ratios). Fixed lines never move.
 */
export function fillLines(fixed: number[], hmax: (lo: number, hi: number) => number, ratio: number): number[] {
  const f = [...new Set(fixed)].sort((a, b) => a - b);
  const nGap = f.length - 1;
  // Effective limit per gap: never larger than the gap itself.
  const lim = Array.from({ length: nGap }, (_, i) => Math.min(hmax(f[i], f[i + 1]), f[i + 1] - f[i]));
  // Required cell size at each fixed line, relaxed outward so it grows at most by `ratio` per gap.
  const end = f.map((_, i) => Math.min(i > 0 ? lim[i - 1] : Infinity, i < nGap ? lim[i] : Infinity));
  const lines = [f[0]];
  for (let i = 0; i < nGap; i++) {
    const L = f[i + 1] - f[i];
    const cells = fillGap(L, Math.min(end[i], lim[i]), Math.min(end[i + 1], lim[i]), lim[i], ratio);
    let x = f[i];
    for (let k = 0; k < cells.length - 1; k++) {
      x += cells[k];
      lines.push(x);
    }
    lines.push(f[i + 1]);
  }
  return lines;
}

/** Cells for one gap of length L: geometric growth from sizes sa (left) and sb (right) up to hmax. */
function fillGap(L: number, sa: number, sb: number, hmax: number, r: number): number[] {
  if (L <= Math.max(sa, sb) * (1 + 1e-9) || L <= hmax * (1 + 1e-9) && Math.max(sa, sb) >= hmax / r) {
    const n = Math.max(1, Math.round(L / Math.max(sa, sb)));
    return Array(n).fill(L / n);
  }
  const left: number[] = [], right: number[] = [];
  let nl = sa, nr = sb, rem = L;
  for (let guard = 0; guard < 100000; guard++) {
    const takeLeft = nl <= nr;
    const next = takeLeft ? nl : nr;
    if (next > rem) break;
    if (takeLeft) {
      left.push(nl);
      nl = Math.min(nl * r, hmax);
    } else {
      right.push(nr);
      nr = Math.min(nr * r, hmax);
    }
    rem -= next;
  }
  const cells = [...left, ...right.reverse()];
  const sum = L - rem;
  // Either stretch the cells to absorb the remainder, or add one cell and shrink; keep the scale nearest 1.
  const up = L / sum;
  const extra = Math.min(nl, nr);
  const down = L / (sum + extra);
  const fitsUp = Math.max(...cells) * up <= hmax * (1 + 1e-9);
  if (cells.length === 0 || (fitsUp && up - 1 <= 1 - down)) return cells.map((c) => c * up);
  // Insert the extra cell where the sequence is coarsest (between the two growth fronts).
  const withExtra = [...left, extra, ...right];
  return withExtra.map((c) => c * down);
}

export function generateMesh(input: MeshInput): MeshResult {
  const { bodies, feed, settings: s } = input;
  if (!(input.fMin > 0 && input.fMax > input.fMin)) throw new Error('mesh: invalid frequency band');
  const notes: string[] = [];
  const lambdaMin = (C0 / input.fMax) * 1000;
  const h0 = lambdaMin / s.cellsPerWavelength;
  const padding = s.paddingWavelengths * ((C0 / input.fMin) * 1000);
  const sheets: Record<string, SheetPlacement> = {};
  const wires: Record<string, WirePlacement> = {};

  // Structure extent.
  const structure: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const grow = (p: Vec3) => {
    for (let a = 0; a < 3; a++) {
      structure.min[a] = Math.min(structure.min[a], p[a]);
      structure.max[a] = Math.max(structure.max[a], p[a]);
    }
  };
  for (const b of bodies) {
    grow(b.bbox.min);
    grow(b.bbox.max);
  }
  if (feed) {
    grow(feed.start);
    grow(feed.end);
  }
  if (!Number.isFinite(structure.min[0])) throw new Error('mesh: no bodies to mesh');

  const fixed: number[][] = [[], [], []];
  const regions: Region[][] = [[], [], []];

  // Feed first: its ends and line take precedence for snapping sheets.
  let hFeed = Infinity;
  if (feed) {
    const a = feed.axis;
    const gap = Math.abs(feed.end[a] - feed.start[a]);
    hFeed = Math.min(h0, gap / s.feedGapCells);
    fixed[a].push(feed.start[a], feed.end[a]);
    regions[a].push({ lo: Math.min(feed.start[a], feed.end[a]), hi: Math.max(feed.start[a], feed.end[a]), h: hFeed });
    for (const o of otherAxes(a)) {
      fixed[o].push(feed.start[o]);
      regions[o].push({ lo: feed.start[o] - 2 * hFeed, hi: feed.start[o] + 2 * hFeed, h: hFeed });
    }
  }
  // The existing fixed line within tol of x, if any (snap to it, not to the float32 CAD value).
  const nearFixed = (a: Axis, x: number, tol: number) => fixed[a].find((v) => Math.abs(v - x) <= tol);

  // Solids (conductors and dielectrics): faces, dielectric cell size, thin-feature refinement.
  for (const b of bodies) {
    const size = [0, 1, 2].map((a) => b.bbox.max[a] - b.bbox.min[a]);
    if (b.cls.type === 'solid' || b.cls.type === 'slab') {
      for (const a of [0, 1, 2] as Axis[]) {
        fixed[a].push(b.bbox.min[a], b.bbox.max[a]);
        let h = h0 / Math.sqrt(b.epsR);
        if (b.cls.type === 'slab' && b.cls.axis === a) h = Math.min(h, size[a] / s.minSlabCells);
        if (b.cls.type === 'solid' && b.conductor) h = Math.min(h, Math.max(size[a] / 2, 1e-9));
        if (h < h0) regions[a].push({ lo: b.bbox.min[a], hi: b.bbox.max[a], h });
      }
    }
  }
  // Sheets: snap to a feed end, else to a solid face, else the mid-plane; outline on the other axes.
  for (const b of bodies) {
    if (b.cls.type !== 'sheet') continue;
    const a = b.cls.axis;
    const tol = 1e-4 + 1e-3 * Math.max(b.bbox.max[a] - b.bbox.min[a], 0);
    const candidates = [b.bbox.min[a], b.bbox.max[a]];
    const feedEnds = feed && feed.axis === a ? [feed.start[a], feed.end[a]] : [];
    let coord: number | undefined;
    for (const c of candidates) coord ??= feedEnds.find((e) => Math.abs(c - e) < tol);
    for (const c of candidates) coord ??= nearFixed(a, c, tol);
    coord ??= 0.5 * (b.bbox.min[a] + b.bbox.max[a]);
    sheets[b.id] = { axis: a, coord };
    fixed[a].push(coord);
    for (const o of otherAxes(a)) fixed[o].push(b.bbox.min[o], b.bbox.max[o]);
  }
  // Wires: a line of edges on the wire axis.
  for (const b of bodies) {
    if (b.cls.type !== 'wire') continue;
    const a = b.cls.axis;
    const [u, v] = otherAxes(a);
    const center: [number, number] = [0.5 * (b.bbox.min[u] + b.bbox.max[u]), 0.5 * (b.bbox.min[v] + b.bbox.max[v])];
    wires[b.id] = { axis: a, center, range: [b.bbox.min[a], b.bbox.max[a]] };
    fixed[u].push(center[0]);
    fixed[v].push(center[1]);
    fixed[a].push(b.bbox.min[a], b.bbox.max[a]);
  }

  // Domain and fill.
  const domain: Box3 = {
    min: structure.min.map((v) => v - padding) as Vec3,
    max: structure.max.map((v) => v + padding) as Vec3,
  };
  const lines: number[][] = [];
  const minCell: number[] = [], maxCell: number[] = [];
  for (const a of [0, 1, 2] as Axis[]) {
    // Merge fixed lines closer than a small fraction of the finest cell they bound.
    const span = domain.max[a] - domain.min[a];
    const regionEdges = regions[a].flatMap((r) => [r.lo, r.hi]).filter((x) => x > domain.min[a] && x < domain.max[a]);
    const sorted = [...fixed[a], ...regionEdges, domain.min[a], domain.max[a]].sort((x, y) => x - y);
    const merged: number[] = [];
    // Tessellated coordinates carry float32 noise (~1e-7 relative): merge lines closer than 0.1 um.
    const mergeTol = Math.max(1e-4, 1e-7 * span);
    for (const x of sorted) if (!merged.length || x - merged[merged.length - 1] > mergeTol) merged.push(x);
    const hmax = (lo: number, hi: number) => {
      let h = h0;
      for (const r of regions[a]) if (r.hi > lo + 1e-12 && r.lo < hi - 1e-12) h = Math.min(h, r.h);
      return h;
    };
    const inner = fillLines(merged, hmax, clampRatio(s.maxRatio));
    const first = inner[1] - inner[0], last = inner[inner.length - 1] - inner[inner.length - 2];
    const pmlLo = Array.from({ length: s.pmlCells }, (_, i) => inner[0] - first * (s.pmlCells - i));
    const pmlHi = Array.from({ length: s.pmlCells }, (_, i) => inner[inner.length - 1] + last * (i + 1));
    const all = [...pmlLo, ...inner, ...pmlHi];
    lines.push(all);
    const d = all.slice(1).map((x, i) => x - all[i]);
    minCell.push(Math.min(...d));
    maxCell.push(Math.max(...d));
  }
  const cells = (lines[0].length - 1) * (lines[1].length - 1) * (lines[2].length - 1);
  const m = s.pmlCells + s.farFieldMarginCells;
  const nf2ffBox: Box3 = {
    min: [lines[0][m], lines[1][m], lines[2][m]],
    max: [lines[0][lines[0].length - 1 - m], lines[1][lines[1].length - 1 - m], lines[2][lines[2].length - 1 - m]],
  };
  for (let a = 0; a < 3; a++)
    if (nf2ffBox.min[a] >= structure.min[a] || nf2ffBox.max[a] <= structure.max[a]) notes.push('The NF2FF box does not enclose the structure; increase the padding.');
  if (Math.min(...minCell) < h0 / 50)
    notes.push(`Smallest cell ${Math.min(...minCell).toFixed(4)} mm is far below the background cell (${h0.toFixed(3)} mm); the time step shrinks with it.`);
  return {
    lines: lines as [number[], number[], number[]],
    domain,
    structure,
    pmlCells: s.pmlCells,
    nf2ffBox,
    cells,
    minCell: minCell as Vec3,
    maxCell: maxCell as Vec3,
    backgroundCell: h0,
    sheets,
    wires,
    notes,
  };
}

function clampRatio(r: number) {
  return Math.max(1.05, Math.min(2, r));
}

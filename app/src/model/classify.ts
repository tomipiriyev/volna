// Classifies bodies against the FDTD geometry rules, using an *estimated*
// cell size (the background cell at f max). The mesher (sim/mesher.ts) then
// computes the real grid, and the problem builder re-checks thin conductors
// against the local cells there.
import { boxSize } from './geometry';
import type { Axis, CadBody, FrequencySettings, Material, Role, Vec3 } from './types';
import { CONDUCTOR_ROLES } from './types';
import { wirePath } from './wirePath';

const C0 = 299792458;

/** Estimated cell size (mm): lambda_min / cellsPerWavelength in the densest assigned dielectric. */
export function estimatedCellMm(freq: FrequencySettings, epsRMax: number): number {
  return ((C0 / freq.fMax) * 1000) / Math.sqrt(Math.max(1, epsRMax)) / freq.cellsPerWavelength;
}

/** A straight round wire: its axis and the radius of its circumference (for metal loss). */
export interface RoundWire {
  axis: Axis;
  radius: number; // mm
}

export type GeomClass =
  /** `roundWire`: a straight round wire thick enough to be voxelized as a solid. */
  | { type: 'solid'; thicknessCells: number; marginal: boolean; roundWire?: RoundWire }
  | { type: 'sheet'; axis: Axis; thickness: number; zeroThickness: boolean }
  /** `lossRadius`: radius of a circle with the wire's perimeter (its radius if round). */
  | { type: 'wire'; axis: Axis; diameter: number; lossRadius: number; round: boolean }
  /** Thin axis-aligned dielectric layer: the mesher refines across it. */
  | { type: 'slab'; axis: Axis; thickness: number }
  /** Thin round wire along a bent or oblique path: a chain of thin-wire segments (true mm). */
  | { type: 'curvedWire'; radius: number; length: number; points: Vec3[] }
  /**
   * Dielectric smaller than a cell: voxelized at cell centres (it fills only the cells whose
   * centre it contains, often none) and does not refine the grid; left out if its surface is
   * not closed (it cannot be voxelized).
   */
  | { type: 'subcell'; voxelized: boolean }
  | { type: 'unsupported'; reason: string; fix: string };

/** Minimum cells the mesher places across a thin dielectric layer. */
export const MIN_SLAB_CELLS = 3;

/**
 * Rules (dimensions in true mm, i.e. after the unit scale):
 * - Open surface: supported only as a flat, axis-aligned zero-thickness sheet.
 * - Closed body with thickness t = 2V/A (plate thickness, or wire radius):
 *   two or more cells thick: solid. One to two cells: solid, marginal.
 *   Thinner than a cell: an axis-aligned conductor plate becomes a sheet and
 *   an axis-aligned wire becomes a line of PEC edges. An axis-aligned
 *   dielectric plate is a slab the mesher refines across (the estimate is the
 *   background cell, not the local one). A round conductor wire along any
 *   other path becomes a thin-wire chain (curvedWire). Any other dielectric
 *   is sub-cell (voxelized at cell centres); any other conductor is unsupported.
 */
export function classifyBody(body: CadBody, scale: number, cellMm: number, role?: Role): GeomClass {
  const size = boxSize(body.bbox).map((s) => s * scale);
  const topo = body.topology;
  const smallDielectric = role === 'dielectric' && Math.max(...size) < 2 * cellMm;
  if (smallDielectric && (!topo.closed || topo.nonManifoldEdges > 0 || topo.inconsistentEdges > 0 || !(topo.volume! > 0)))
    return { type: 'subcell', voxelized: false };
  if (!topo.closed) {
    const axes = new Set(body.faces.map((f) => f.axisAligned));
    const flat = body.faces.length > 0 && body.faces.every((f) => f.planar) && axes.size === 1 && !axes.has(null);
    if (flat) {
      const axis = [...axes][0] as Axis;
      if (size[axis] <= 1e-9 * Math.max(...size, 1))
        return { type: 'sheet', axis, thickness: 0, zeroThickness: true };
    }
    return {
      type: 'unsupported',
      reason: 'Open surface that is not a flat, axis-aligned sheet.',
      fix: 'Model it as a closed solid, or as a flat sheet parallel to a coordinate plane.',
    };
  }
  if (topo.volume === null || topo.volume <= 0 || topo.characteristicThickness === null)
    return {
      type: 'unsupported',
      reason: 'Closed surface with zero or inverted enclosed volume.',
      fix: 'Check the solid in CAD (face orientation, degenerate geometry).',
    };
  const t = topo.characteristicThickness * scale; // plate thickness or wire radius
  const thin = size.map((s) => s < 2 * cellMm);
  const nThin = thin.filter(Boolean).length;
  // Perimeter of a straight body along `axis`, from t = 2V/A with flat ends: P = 2 (V/L) (1/t - 1/L).
  const perimeterAlong = (axis: Axis) => 2 * ((topo.volume! * scale ** 3) / size[axis]) * (1 / t - 1 / size[axis]);
  // Straight round wire (any thickness): one axis at least four times the others, a square
  // bounding cross-section that the body fills to pi/4.
  const long = size.indexOf(Math.max(...size)) as Axis;
  const cross = size.filter((_, k) => k !== long);
  const fill = topo.volume / ((size[0] * size[1] * size[2]) / scale ** 3);
  const roundWire: RoundWire | undefined =
    size[long] >= 4 * Math.max(...cross) && Math.abs(cross[0] - cross[1]) <= 0.05 * Math.max(...cross) && Math.abs(fill - Math.PI / 4) < 0.05 && perimeterAlong(long) > 0
      ? { axis: long, radius: perimeterAlong(long) / (2 * Math.PI) }
      : undefined;
  const wireTag = roundWire ? { roundWire } : {};
  // Wire: two small cross-section dimensions, length along an axis.
  if (nThin === 2) {
    const axis = thin.indexOf(false) as Axis;
    const diameter = 2 * t;
    const lossRadius = perimeterAlong(axis) > 0 ? perimeterAlong(axis) / (2 * Math.PI) : diameter / 2;
    if (diameter < cellMm) return role === 'dielectric' ? { type: 'subcell', voxelized: true } : { type: 'wire', axis, diameter, lossRadius, round: roundWire !== undefined };
    return { type: 'solid', thicknessCells: diameter / cellMm, marginal: diameter < 2 * cellMm, ...wireTag };
  }
  if (t >= 2 * cellMm) return { type: 'solid', thicknessCells: t / cellMm, marginal: false, ...wireTag };
  // Marginal or thinner than a cell: an axis-aligned plate is a sheet (conductor) or a slab (dielectric).
  // A plate is axis-aligned when it fills most of its bounding box and is thin along one axis
  // (a tilted plate has a large, mostly empty box).
  if (nThin === 1) {
    const axis = thin.indexOf(true) as Axis;
    const others = size.filter((_, k) => k !== axis);
    const fill = topo.volume / (size[0] * size[1] * size[2] / scale ** 3);
    if (fill >= 0.5 && size[axis] <= 0.5 * Math.min(...others)) {
      if (role === 'dielectric') return { type: 'slab', axis, thickness: size[axis] };
      if (t < cellMm) return { type: 'sheet', axis, thickness: size[axis], zeroThickness: false };
    }
  }
  if (t >= cellMm) return { type: 'solid', thicknessCells: t / cellMm, marginal: t < 2 * cellMm, ...wireTag };
  if (role === 'dielectric') return { type: 'subcell', voxelized: true };
  // A round wire along a bent or oblique path (a swept circle): a thin-wire chain.
  const path = wirePath(body);
  if (path)
    return { type: 'curvedWire', radius: path.radius * scale, length: path.length * scale, points: path.points.map((p) => p.map((v) => v * scale) as Vec3) };
  return {
    type: 'unsupported',
    reason: `Feature thinner than one cell (${t.toFixed(3)} mm vs ~${cellMm.toFixed(3)} mm) that is not an axis-aligned sheet or wire.`,
    fix: 'Thicken it to at least two cells, align it with a coordinate axis, or refine the mesh.',
  };
}

export function maxAssignedEpsR(assignments: Record<string, { role: Role; materialId?: string }>, materials: Material[]) {
  let e = 1;
  for (const a of Object.values(assignments)) {
    if (a.role !== 'dielectric' || !a.materialId) continue;
    const m = materials.find((x) => x.id === a.materialId);
    if (m) e = Math.max(e, m.epsR);
  }
  return e;
}

export const isConductor = (role: Role | undefined) => role !== undefined && CONDUCTOR_ROLES.includes(role);

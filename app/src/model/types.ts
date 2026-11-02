// Project data model. Pure types, no DOM or worker dependencies, so it is
// shared by the main thread, workers and tests.
//
// Length convention: CAD geometry is stored in millimetres as converted by
// the importer from the file's declared unit. `UnitState.scale` multiplies
// those coordinates to get the true size in millimetres (1 unless the user
// overrides a wrong unit declaration). The solver works in metres.

export type Vec3 = [number, number, number];
export type Axis = 0 | 1 | 2;
export type Box3 = { min: Vec3; max: Vec3 };

export type LengthUnit = 'um' | 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'mil';

export const UNIT_TO_MM: Record<LengthUnit, number> = {
  um: 1e-3,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  mil: 0.0254,
};

export const UNIT_LABEL: Record<LengthUnit, string> = {
  um: 'µm',
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  in: 'inch',
  ft: 'foot',
  mil: 'mil',
};

/** What the STEP file declares, as parsed from its length-unit entities. */
export interface DeclaredUnits {
  /** Single declared unit, or null when absent/ambiguous. */
  unit: LengthUnit | null;
  /** Every distinct unit found (more than one means mixed contexts). */
  found: string[];
  note?: string;
}

export interface UnitState {
  declared: DeclaredUnits;
  /** Unit the user says the file's coordinates are really in (null = trust the declaration). */
  override: LengthUnit | null;
  /** True once the user has confirmed or overridden the unit. */
  confirmed: boolean;
}

/** Geometric fingerprint used to re-identify entities across re-imports. */
export interface Fingerprint {
  area: number; // mm^2
  centroid: Vec3; // area-weighted, mm
  bbox: Box3;
  faceCount?: number;
}

export interface CadFace {
  index: number; // B-rep face index within the body (importer order)
  triFirst: number;
  triLast: number; // inclusive
  color?: Vec3;
  area: number;
  centroid: Vec3;
  /** Area-weighted mean normal (unit) and whether all triangles share it. */
  normal: Vec3;
  planar: boolean;
  /** Axis the face normal is aligned with (within 0.5 deg), if any. */
  axisAligned: Axis | null;
}

/** Facts about a body's tessellation, computed in the CAD worker. */
export interface MeshTopology {
  closed: boolean; // every welded edge shared by exactly two triangles
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number; // edges used twice in the same direction
  degenerateTriangles: number;
  area: number; // mm^2
  /** Enclosed volume (mm^3) for closed meshes, from the divergence theorem; negative means inverted. */
  volume: number | null;
  /** 2V/A: plate thickness for thin plates, radius for thin wires. Null if open. */
  characteristicThickness: number | null;
}

export interface CadBody {
  /** Stable key: hierarchy path + mesh index (e.g. "0.1/2"), deterministic for a given file and importer. */
  id: string;
  name: string;
  path: string[]; // names from the root to the owning node
  color?: Vec3; // linear RGB
  positions: Float32Array; // mm, world space
  normals?: Float32Array;
  indices: Uint32Array;
  /** Pairs of vertex indices for B-rep face boundary lines (display). */
  featureEdges: Uint32Array;
  faces: CadFace[];
  bbox: Box3;
  topology: MeshTopology;
  fingerprint: Fingerprint;
}

export interface CadNode {
  name: string;
  children: CadNode[];
  bodyIds: string[];
}

export interface CadModel {
  importer: { id: string; version: string };
  fileName: string;
  sourceSha256: string;
  root: CadNode;
  bodies: CadBody[];
  bbox: Box3;
  units: DeclaredUnits;
}

// ---------------------------------------------------------------- assignments
export type Role = 'radiator' | 'ground' | 'passiveConductor' | 'dielectric' | 'excluded';

export const CONDUCTOR_ROLES: readonly Role[] = ['radiator', 'ground', 'passiveConductor'];

export interface BodyRef {
  bodyId: string;
  fingerprint: Fingerprint;
}

export interface FaceRef extends BodyRef {
  faceIndex: number;
  faceFingerprint: { area: number; centroid: Vec3 };
}

/** Conductor material: lossless PEC, or a metal with finite conductivity (skin-effect loss). */
export type ConductorSpec = { kind: 'pec' } | { kind: 'metal'; name: string; sigma: number }; // sigma in S/m

/** Faces of a metal sheet that carry its current (docs/physics.md, "Conductor loss"). */
export type SheetCurrent = 'both' | 'one';

export interface Assignment {
  role: Role;
  materialId?: string; // dielectrics only
  /** Conductors only; absent means PEC. */
  conductor?: ConductorSpec;
  /** Metal sheets only; absent means both faces. */
  sheetCurrent?: SheetCurrent;
  /** Overlap priority among dielectrics: higher wins. */
  priority: number;
}

export type MaterialLoss =
  | { kind: 'none' }
  | { kind: 'conductivity'; sigma: number } // S/m
  | { kind: 'tanDelta'; tanDelta: number; fRef: number }; // fRef in Hz

export interface Material {
  id: string;
  name: string;
  epsR: number;
  loss: MaterialLoss;
  builtin?: boolean;
}

// ---------------------------------------------------------------- feed
export interface PortDef {
  signal: BodyRef;
  reference: BodyRef;
  /** Feed axis and lateral position of the (axis-aligned) feed line, in model mm. */
  axis: Axis;
  lateral: [number, number]; // coordinates on the two other axes, ascending axis order
  /** A point near the gap along the axis, used to choose which surfaces bound it (mm). */
  anchor: number;
  z0: number; // ohm, real reference impedance
  amplitude: number; // V, source EMF
}

/** Feed geometry derived from the bodies along the feed line. */
export interface PortGeometry {
  start: Vec3; // on the reference conductor surface
  end: Vec3; // on the signal conductor surface
  gap: number; // mm (model units after scale)
  direction: 1 | -1; // +axis if the signal side is at higher coordinate
}

// ---------------------------------------------------------------- settings
export interface FrequencySettings {
  fMin: number; // Hz
  fMax: number; // Hz
  farField: number[]; // Hz, at most 5
  cellsPerWavelength: number;
}

// ---------------------------------------------------------------- diagnostics
export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  fix?: string;
  bodyIds?: string[];
  location?: Vec3;
}

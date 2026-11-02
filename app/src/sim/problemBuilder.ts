// Turns a project (model, roles, materials, feed, band) into the solver's
// problem JSON: generates the grid, then emits PEC/dielectric meshes, sheets
// (snapped to their grid plane) and wires, plus the lumped port. All lengths
// in the problem are true millimetres (imported coordinates x unit scale).
import { isConductor, type GeomClass } from '../model/classify';
import { computeDiagnostics, unitScale, type ProjectSnapshot } from '../model/diagnostics';
import { lossFitFrequency, materialSigma } from '../model/materials';
import type { Assignment, Axis, Diagnostic, Vec3 } from '../model/types';
import { DEFAULT_MESH_SETTINGS, generateMesh, type MeshBody, type MeshResult, type MeshSettings } from './mesher';

export interface SimBody {
  positions: Float32Array; // imported mm
  indices: Uint32Array;
}

export interface SimulationPlan {
  problem: Record<string, unknown>;
  mesh: MeshResult;
  diagnostics: Diagnostic[]; // errors block the run
}

/** The grid and final per-body classes, before any geometry is emitted. */
export interface MeshPlan {
  mesh: MeshResult;
  classes: Map<string, GeomClass>;
  feed: { axis: Axis; start: Vec3; end: Vec3 };
  diagnostics: Diagnostic[];
  settings: MeshSettings;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

const f32b64 = (a: Float32Array) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const u32b64 = (a: Uint32Array) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

function scaled(p: Float32Array, s: number): Float32Array {
  if (s === 1) return p;
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) o[i] = p[i] * s;
  return o;
}

/** Size of [lo, hi] in units of the mean grid cell it overlaps. */
function cellsAcross(lines: number[], lo: number, hi: number): number {
  let n = 0, len = 0;
  for (let i = 0; i + 1 < lines.length; i++)
    if (lines[i + 1] > lo && lines[i] < hi) {
      n++;
      len += lines[i + 1] - lines[i];
    }
  return n ? (hi - lo) / (len / n) : 0;
}

/** Errors that make a simulation meaningless, on top of the project diagnostics. */
export function blockingIssues(s: ProjectSnapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const r = computeDiagnostics(s);
  out.push(...r.diagnostics.filter((d) => d.severity === 'error'));
  if (!s.units.confirmed) out.push({ code: 'UNITS_UNCONFIRMED', severity: 'error', message: 'Confirm the model units before simulating.' });
  const unassigned = s.model.bodies.filter((b) => !s.assignments[b.id]);
  if (unassigned.length)
    out.push({ code: 'UNASSIGNED', severity: 'error', message: `${unassigned.length} body/bodies have no role: ${unassigned.map((b) => `"${b.name}"`).join(', ')}.`, fix: 'Assign a role or mark them excluded.', bodyIds: unassigned.map((b) => b.id) });
  if (!s.port) out.push({ code: 'NO_PORT', severity: 'error', message: 'Define a feed before simulating.' });
  if (!Object.values(s.assignments).some((a) => isConductor(a.role))) out.push({ code: 'NO_CONDUCTOR', severity: 'error', message: 'No body is a conductor.' });
  return out;
}

/**
 * Generates the grid for a project; needs no tessellation. Throws if blocking
 * issues exist (call blockingIssues first to show them).
 */
export function planMesh(s: ProjectSnapshot, meshSettings: MeshSettings = DEFAULT_MESH_SETTINGS, gridOverride?: [number[], number[], number[]]): MeshPlan {
  // Classification (diagnostics) and meshing use the project's cells per wavelength.
  const settings = { ...meshSettings, cellsPerWavelength: s.freq.cellsPerWavelength };
  const issues = blockingIssues(s);
  if (issues.length) throw new Error(issues.map((d) => d.message).join(' '));
  const diag = computeDiagnostics(s);
  const scale = unitScale(s.units);
  const geom = diag.port!.geometry!;
  const port = s.port!;
  const diagnostics: Diagnostic[] = [];

  const active = s.model.bodies.filter((b) => s.assignments[b.id] && s.assignments[b.id].role !== 'excluded');
  const classes = new Map<string, GeomClass>(active.map((b) => [b.id, diag.classes[b.id]]));
  const scaleBox = (b: { min: Vec3; max: Vec3 }) => ({ min: b.min.map((v) => v * scale) as Vec3, max: b.max.map((v) => v * scale) as Vec3 });
  const meshBodies: MeshBody[] = active.map((b) => {
    const a = s.assignments[b.id];
    const m = a.role === 'dielectric' ? s.materials.find((x) => x.id === a.materialId) : undefined;
    return { id: b.id, name: b.name, bbox: scaleBox(b.bbox), conductor: isConductor(a.role), epsR: m?.epsR ?? 1, cls: classes.get(b.id)! };
  });
  const feed: MeshPlan['feed'] = { axis: port.axis, start: geom.start.map((v) => v * scale) as Vec3, end: geom.end.map((v) => v * scale) as Vec3 };

  // Snap the feed line onto a wire's axis if a terminal is a thin wire.
  for (const id of [port.signal.bodyId, port.reference.bodyId]) {
    const c = classes.get(id);
    if (c?.type !== 'wire' || c.axis !== port.axis) continue;
    const bb = meshBodies.find((m) => m.id === id)!.bbox;
    for (const o of [0, 1, 2].filter((x) => x !== port.axis)) {
      const center = 0.5 * (bb.min[o] + bb.max[o]);
      if (Math.abs(center - feed.start[o]) > 1e-6)
        diagnostics.push({ code: 'FEED_SNAPPED_TO_WIRE', severity: 'info', message: `The feed line was moved ${Math.abs(center - feed.start[o]).toFixed(3)} mm onto the axis of wire "${meshBodies.find((m) => m.id === id)!.name}".` });
      feed.start[o] = feed.end[o] = center;
    }
  }

  const meshIt = () => {
    const m = generateMesh({ bodies: meshBodies, feed, fMin: s.freq.fMin, fMax: s.freq.fMax, settings });
    if (gridOverride) m.lines = gridOverride;
    return m;
  };
  let mesh = meshIt();
  // Thin-body classes were decided against the background cell. Where the grid is
  // finer (near the feed), a conductor "wire" or thick "sheet" that spans 2+ local
  // cells is voxelized as a solid instead, and the grid is regenerated so its faces
  // become grid lines. Only wire/sheet -> solid changes, so this terminates.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const mb of meshBodies) {
      const c = mb.cls;
      if (!mb.conductor) continue;
      const axes = c.type === 'wire' ? [0, 1, 2].filter((x) => x !== c.axis) : c.type === 'sheet' && !c.zeroThickness ? [c.axis] : [];
      if (!axes.length) continue;
      const across = Math.min(...axes.map((a) => cellsAcross(mesh.lines[a], mb.bbox.min[a], mb.bbox.max[a])));
      if (across < 2) continue;
      mb.cls = { type: 'solid', thicknessCells: across, marginal: false, ...(c.type === 'wire' && c.round ? { roundWire: { axis: c.axis, radius: c.lossRadius } } : {}) };
      classes.set(mb.id, mb.cls);
      changed = true;
      diagnostics.push({ code: 'RECLASSIFIED_SOLID', severity: 'info', message: `"${mb.name}" spans ${across.toFixed(1)} local grid cells, so it is voxelized as a solid instead of a ${c.type}.`, bodyIds: [mb.id] });
    }
    if (!changed) break;
    mesh = meshIt();
  }
  for (const n of mesh.notes) diagnostics.push({ code: 'MESH_NOTE', severity: 'warning', message: n });
  if (mesh.cells > settings.maxCells)
    diagnostics.push({ code: 'MESH_TOO_LARGE', severity: 'error', message: `The grid has ${mesh.cells.toLocaleString()} cells, above the limit of ${settings.maxCells.toLocaleString()}.`, fix: 'Lower f_max or cells per wavelength, or raise the limit.' });
  return { mesh, classes, feed, diagnostics, settings };
}

/**
 * Builds the solver problem: the mesh plan plus PEC/dielectric objects and the port.
 * `sim` holds the simulation tessellation per body id (finer than the display mesh).
 */
export function buildSimulation(
  s: ProjectSnapshot,
  sim: Map<string, SimBody>,
  meshSettings: MeshSettings = DEFAULT_MESH_SETTINGS,
  gridOverride?: [number[], number[], number[]],
  plan: MeshPlan = planMesh(s, meshSettings, gridOverride),
): SimulationPlan {
  const { mesh, classes, feed, settings } = plan;
  const diagnostics = [...plan.diagnostics];
  const scale = unitScale(s.units);
  const port = s.port!;
  const active = s.model.bodies.filter((b) => s.assignments[b.id] && s.assignments[b.id].role !== 'excluded');

  // Materials and objects. Metal conductors become "metal" materials (one per
  // name and conductivity); PEC conductors use the reserved "pec".
  const fFit = lossFitFrequency(s.freq.fMin, s.freq.fMax);
  const usedMaterials = new Map<string, Record<string, unknown>>();
  const metalNames = new Map<string, string>(); // "name|sigma" -> problem material name
  const conductorMaterial = (a: Assignment): string => {
    const c = a.conductor;
    if (c?.kind !== 'metal') return 'pec';
    const key = `${c.name}|${c.sigma}`;
    let name = metalNames.get(key);
    if (!name) {
      name = c.name;
      for (let i = 2; usedMaterials.has(name) || name === 'pec' || name === 'vacuum'; i++) name = `${c.name} ${i}`;
      metalNames.set(key, name);
      usedMaterials.set(name, { name, type: 'metal', conductivity: c.sigma });
    }
    return name;
  };
  const objects: Record<string, unknown>[] = [];
  for (const b of active) {
    const a = s.assignments[b.id];
    const cls = classes.get(b.id)!;
    const t = sim.get(b.id);
    if (a.role === 'dielectric') {
      const m = s.materials.find((x) => x.id === a.materialId)!;
      usedMaterials.set(m.id, { name: m.id, epsR: m.epsR, sigma: materialSigma(m, fFit) });
      if (!t) throw new Error(`missing simulation tessellation for "${b.name}"`);
      objects.push({ type: 'mesh', name: b.name, material: m.id, priority: a.priority, positions: f32b64(scaled(t.positions, scale)), indices: u32b64(t.indices) });
      continue;
    }
    const material = conductorMaterial(a);
    const metal = material !== 'pec';
    if (cls.type === 'wire') {
      const w = mesh.wires[b.id];
      const lo: Vec3 = [0, 0, 0], hi: Vec3 = [0, 0, 0];
      const [u, v] = [0, 1, 2].filter((x) => x !== w.axis);
      lo[u] = hi[u] = w.center[0];
      lo[v] = hi[v] = w.center[1];
      lo[w.axis] = w.range[0];
      hi[w.axis] = w.range[1];
      // A metal wire's loss uses its CAD radius (the grid line has no radius of its own).
      objects.push({ type: 'box', name: b.name, material, min: lo, max: hi, ...(metal ? { radius: cls.lossRadius } : {}) });
    } else if (cls.type === 'sheet') {
      if (!t) throw new Error(`missing simulation tessellation for "${b.name}"`);
      const sp = mesh.sheets[b.id];
      const sheetLoss = metal ? { ...(cls.thickness > 0 ? { thickness: cls.thickness } : {}), currentFaces: a.sheetCurrent === 'one' ? 1 : 2 } : {};
      objects.push({ type: 'sheet', name: b.name, material, axis: sp.axis, coord: sp.coord, ...sheetLoss, positions: f32b64(scaled(t.positions, scale)), indices: u32b64(t.indices) });
    } else if (cls.type === 'solid') {
      if (!t) throw new Error(`missing simulation tessellation for "${b.name}"`);
      // A round metal wire voxelized as a solid is calibrated to the round wire's resistance (staircase corners would overstate its loss).
      const wire = metal && cls.roundWire ? { wire: { axis: cls.roundWire.axis, radius: cls.roundWire.radius } } : {};
      objects.push({ type: 'mesh', name: b.name, material, ...wire, positions: f32b64(scaled(t.positions, scale)), indices: u32b64(t.indices) });
    } else {
      throw new Error(`"${b.name}" cannot be represented on the grid (${cls.type}).`);
    }
  }

  const problem = {
    name: s.model.fileName,
    unit: 1e-3,
    grid: { x: mesh.lines[0], y: mesh.lines[1], z: mesh.lines[2] },
    boundaries: 'cpml',
    pml: { cells: settings.pmlCells },
    materials: [...usedMaterials.values()],
    objects,
    port: { start: feed.start, stop: feed.end, axis: port.axis, resistance: port.z0, amplitude: port.amplitude },
    excitation: { fMin: s.freq.fMin, fMax: s.freq.fMax },
    ...(metalNames.size ? { metalLossFrequency: fFit } : {}),
    portFrequencies: 401,
    farField: { frequencies: s.freq.farField, marginCells: settings.farFieldMarginCells, thetaStep: 2, phiStep: 2, quadTheta: 48, quadPhi: 96 },
    termination: { energyDb: -60, maxSteps: 200000 },
    courant: 0.99,
  };
  return { problem, mesh, diagnostics };
}

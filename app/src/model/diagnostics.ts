// Project-level diagnostics: units, geometry versus the estimated grid, role
// and material assignments, overlaps, gaps, losses and the feed. Pure
// function of the project state, recomputed whenever it changes.
import { classifyBody, estimatedCellMm, isConductor, maxAssignedEpsR, MIN_SLAB_CELLS, type GeomClass } from './classify';
import { approxMeshDistance, boxDistance, boxOverlap, boxSize } from './geometry';
import { lossValidity } from './materials';
import { metalBandValidity } from './metals';
import { evaluatePort, portFeedDiagnostics, type PortEvaluation } from './port';
import type { Assignment, CadModel, Diagnostic, FrequencySettings, Material, PortDef, UnitState } from './types';
import { UNIT_LABEL, UNIT_TO_MM } from './types';

export interface ProjectSnapshot {
  model: CadModel;
  units: UnitState;
  assignments: Record<string, Assignment>;
  materials: Material[];
  port: PortDef | null;
  freq: FrequencySettings;
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
  classes: Record<string, GeomClass>;
  cellMm: number;
  port: PortEvaluation | null;
}

/** Factor from imported (declared-unit-converted) mm to true mm. */
export function unitScale(units: UnitState): number {
  if (!units.override) return 1;
  return UNIT_TO_MM[units.override] / UNIT_TO_MM[units.declared.unit ?? 'mm'];
}

const MAX_GAP_PAIRS = 200;

export function computeDiagnostics(s: ProjectSnapshot): DiagnosticsResult {
  const { model, units, assignments, materials, freq } = s;
  const out: Diagnostic[] = [];
  const scale = unitScale(units);
  const cellMm = estimatedCellMm(freq, maxAssignedEpsR(assignments, materials));
  const classes: Record<string, GeomClass> = {};
  const roleOf = (id: string) => assignments[id]?.role;
  const active = (id: string) => roleOf(id) !== undefined && roleOf(id) !== 'excluded';

  // Units.
  if (!units.confirmed) {
    const d = units.declared;
    out.push({
      code: 'UNITS_UNCONFIRMED',
      severity: 'warning',
      message: d.unit
        ? `The file declares ${UNIT_LABEL[d.unit]}. Confirm the unit (or override it) before simulating.`
        : d.note ?? 'The file does not declare a length unit.',
      fix: 'Open the Units panel and confirm or override.',
    });
  }

  // Frequency.
  if (!(freq.fMin > 0 && freq.fMax > freq.fMin))
    out.push({ code: 'FREQ_INVALID', severity: 'error', message: 'The frequency band is invalid (need 0 < f_min < f_max).' });

  // Per-body geometry and assignment checks.
  for (const b of model.bodies) {
    const cls = classifyBody(b, scale, cellMm, roleOf(b.id));
    classes[b.id] = cls;
    const role = roleOf(b.id);
    const t = b.topology;
    const ids = [b.id];
    if (role === undefined)
      out.push({ code: 'UNASSIGNED', severity: 'warning', message: `"${b.name}" has no electromagnetic role.`, fix: 'Assign a role or mark it excluded.', bodyIds: ids });
    if (t.nonManifoldEdges > 0)
      out.push({ code: 'NON_MANIFOLD', severity: active(b.id) ? 'error' : 'warning', message: `"${b.name}" has ${t.nonManifoldEdges} non-manifold edge(s) in its tessellation.`, fix: 'Repair the body in CAD.', bodyIds: ids });
    if (t.inconsistentEdges > 0)
      out.push({ code: 'INCONSISTENT_ORIENTATION', severity: active(b.id) ? 'error' : 'warning', message: `"${b.name}" has inconsistently oriented faces (${t.inconsistentEdges} edges).`, fix: 'Repair the body in CAD.', bodyIds: ids });
    if (t.degenerateTriangles > 0)
      out.push({ code: 'DEGENERATE_TRIANGLES', severity: 'info', message: `"${b.name}" has ${t.degenerateTriangles} degenerate triangle(s) in its tessellation.`, bodyIds: ids });
    if (t.closed && t.volume !== null && t.volume < 0)
      out.push({ code: 'INVERTED_SOLID', severity: active(b.id) ? 'error' : 'warning', message: `"${b.name}" is inside out (negative enclosed volume).`, fix: 'Reverse the solid orientation in CAD.', bodyIds: ids });

    const maxDim = Math.max(...boxSize(b.bbox)) * scale;
    if (maxDim < cellMm && cls.type !== 'unsupported')
      out.push({ code: 'BELOW_RESOLUTION', severity: active(b.id) ? 'warning' : 'info', message: `"${b.name}" (${maxDim.toFixed(3)} mm) is smaller than one estimated cell (~${cellMm.toFixed(3)} mm).`, bodyIds: ids });

    switch (cls.type) {
      case 'unsupported':
        out.push({
          code: t.closed ? 'THIN_FEATURE_UNSUPPORTED' : 'OPEN_SURFACE',
          severity: active(b.id) ? 'error' : 'warning',
          message: `"${b.name}": ${cls.reason}`,
          fix: cls.fix,
          bodyIds: ids,
        });
        break;
      case 'sheet':
        out.push({
          code: cls.zeroThickness ? 'ZERO_THICKNESS_SHEET' : 'THIN_SHEET',
          severity: role === 'dielectric' ? 'error' : 'info',
          message:
            role === 'dielectric'
              ? `"${b.name}" is a sheet; a dielectric must be a closed solid at least one cell thick.`
              : `"${b.name}" is a ${cls.zeroThickness ? 'zero-thickness' : `${cls.thickness.toFixed(3)} mm`} sheet normal to ${'xyz'[cls.axis]}; as a conductor it is modelled as a zero-thickness PEC sheet snapped to a grid plane.`,
          bodyIds: ids,
        });
        break;
      case 'wire':
        if (role !== 'dielectric')
          out.push({ code: 'THIN_WIRE', severity: active(b.id) ? 'warning' : 'info', message: `"${b.name}" (Ø ${cls.diameter.toFixed(3)} mm) is thinner than a cell along ${'xyz'[cls.axis]}; it becomes a line of PEC edges whose effective radius is a fraction of the cell, not the CAD radius.`, fix: 'Refine the mesh for an accurate input impedance.', bodyIds: ids });
        else out.push({ code: 'THIN_DIELECTRIC', severity: 'error', message: `"${b.name}" is too thin to be a dielectric on this grid.`, bodyIds: ids });
        break;
      case 'slab':
        out.push({
          code: 'THIN_DIELECTRIC_LAYER',
          severity: 'info',
          message: `"${b.name}" is a ${cls.thickness.toFixed(3)} mm layer normal to ${'xyz'[cls.axis]}, thinner than the background cell (~${cellMm.toFixed(3)} mm); the mesher places at least ${MIN_SLAB_CELLS} cells across it.`,
          bodyIds: ids,
        });
        break;
      case 'solid':
        if (cls.marginal)
          out.push({ code: 'MARGINAL_THICKNESS', severity: 'warning', message: `"${b.name}" is only ${cls.thicknessCells.toFixed(1)} cells thick at the estimated resolution.`, fix: 'Two or more cells are recommended.', bodyIds: ids });
        break;
    }

    if (role === 'dielectric') {
      const a = assignments[b.id];
      const m = materials.find((x) => x.id === a.materialId);
      if (!m) out.push({ code: 'DIELECTRIC_NO_MATERIAL', severity: 'error', message: `Dielectric "${b.name}" has no material.`, fix: 'Choose a material.', bodyIds: ids });
    }
  }

  // Loss-tangent validity over the band, once per used material.
  const usedMaterials = new Set(Object.values(assignments).filter((a) => a.role === 'dielectric').map((a) => a.materialId));
  for (const m of materials) {
    if (!usedMaterials.has(m.id)) continue;
    const v = lossValidity(m, freq.fMin, freq.fMax);
    if (v && !v.ok)
      out.push({
        code: 'LOSS_TANGENT_BAND',
        severity: 'warning',
        message: `"${m.name}": the constant-conductivity loss model (fitted at ${(v.fFit / 1e9).toFixed(3)} GHz) gives tanδ ${v.atMin.toExponential(2)} at f_min and ${v.atMax.toExponential(2)} at f_max instead of ${m.loss.kind === 'tanDelta' ? m.loss.tanDelta : ''}, off by up to ${(100 * v.maxDeviation).toFixed(0)}% at the band edges.`,
        fix: 'Narrow the band for accurate loss over it; dispersive (Debye/Lorentz) loss models are not implemented.',
      });
  }

  // Metal loss on curved surfaces: the staircase adds corners where current crowds.
  for (const b of model.bodies) {
    const a = assignments[b.id];
    const cls = classes[b.id];
    if (!a || !isConductor(a.role) || a.conductor?.kind !== 'metal' || cls?.type !== 'solid' || cls.roundWire) continue;
    if (b.faces.some((f) => !f.planar || f.axisAligned === null))
      out.push({
        code: 'METAL_CURVED',
        severity: 'warning',
        message: `"${b.name}" has curved or oblique faces. On the grid they become staircases whose corners concentrate the current, so its conductor loss can be overstated by up to about 70% (straight round wires are calibrated and exact).`,
        fix: 'Treat its conductor loss as an upper bound, or approximate the part with axis-aligned faces.',
        bodyIds: [b.id],
      });
  }

  // Metal loss: the surface resistance is evaluated at the band centre.
  if (Object.values(assignments).some((a) => isConductor(a.role) && a.conductor?.kind === 'metal')) {
    const v = metalBandValidity(freq.fMin, freq.fMax);
    const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}%`;
    out.push({
      code: 'METAL_LOSS_BAND',
      severity: v.ok ? 'info' : 'warning',
      message: `Conductor loss uses the surface resistance at ${(v.fFit / 1e9).toFixed(3)} GHz; the true loss grows as √f, so the model's loss is ${pct(v.atMin)} at f_min and ${pct(v.atMax)} at f_max. Gain and efficiency are exact at ${(v.fFit / 1e9).toFixed(3)} GHz.`,
      ...(v.ok ? {} : { fix: 'Narrow the band around the frequencies of interest for accurate conductor loss.' }),
    });
  }

  // Pairwise: bounding-box overlaps and small gaps.
  const bodies = model.bodies.filter((b) => active(b.id));
  let gapPairs = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      const ra = roleOf(a.id)!, rb = roleOf(b.id)!;
      const ov = boxOverlap(a.bbox, b.bbox);
      const tol = 1e-6 * Math.max(...boxSize(model.bbox));
      if (ov.every((o) => o > tol)) {
        // Radiator vs ground: say what this means for the feed, with the actual clearance.
        const pair = new Set([ra, rb]);
        if (pair.has('radiator') && pair.has('ground')) {
          const d = approxMeshDistance(a, b);
          const rad = ra === 'radiator' ? a : b, gnd = ra === 'radiator' ? b : a;
          const near = d === null ? 'intersect (bounding boxes)' : d * scale <= 1e-6 ? 'touch or overlap' : `come within ${(d * scale).toFixed(3)} mm of each other`;
          out.push({
            code: 'RADIATOR_GROUND_CONTACT',
            severity: d !== null && d * scale >= cellMm ? 'info' : 'warning',
            message: `Radiator "${rad.name}" and ground "${gnd.name}" ${near}. A lumped feed needs a clear gap between them along an axis-aligned line, at least about one cell long (~${cellMm.toFixed(3)} mm estimated).`,
            fix: 'For a monopole, end the radiator a small gap (e.g. 0.5–1 mm) above the ground surface instead of passing it through the ground.',
            bodyIds: [rad.id, gnd.id],
          });
          continue;
        }
        const bothDielectric = ra === 'dielectric' && rb === 'dielectric';
        const samePriority = assignments[a.id].priority === assignments[b.id].priority;
        out.push({
          code: 'POSSIBLE_OVERLAP',
          severity: bothDielectric && samePriority ? 'warning' : 'info',
          message: bothDielectric
            ? `Dielectrics "${a.name}" and "${b.name}" may overlap (bounding boxes intersect)${samePriority ? ' and have the same priority, so the overlap would be ambiguous' : ''}.`
            : isConductor(ra) && isConductor(rb)
              ? `Conductors "${a.name}" and "${b.name}" may overlap; overlapping conductors are electrically joined.`
              : `"${a.name}" and "${b.name}" may overlap; the conductor takes precedence over the dielectric.`,
          fix: bothDielectric && samePriority ? 'Give one of them a higher priority. Validate confirms overlaps cell by cell.' : undefined,
          bodyIds: [a.id, b.id],
        });
        continue;
      }
      // Small gaps between conductors of different roles can merge on the grid.
      if (isConductor(ra) && isConductor(rb) && boxDistance(a.bbox, b.bbox) * scale < cellMm && gapPairs < MAX_GAP_PAIRS) {
        gapPairs++;
        const d = approxMeshDistance(a, b);
        if (d !== null && d * scale > 0 && d * scale < cellMm && ra !== rb)
          out.push({ code: 'SMALL_GAP', severity: 'warning', message: `Gap between "${a.name}" and "${b.name}" is about ${(d * scale).toFixed(3)} mm, below the background cell (~${cellMm.toFixed(3)} mm); only a cell or two will resolve it.`, fix: 'The mesher puts grid lines on solid and sheet faces, which keeps such gaps open; check that the gap is intended (Validate reports DC paths between the feed terminals).', bodyIds: [a.id, b.id] });
      }
    }
  }

  // Feed.
  let port: PortEvaluation | null = null;
  if (s.port) {
    port = evaluatePort(model, s.port, assignments, scale);
    if (port.geometry) port.diagnostics.push(...portFeedDiagnostics(port.geometry, cellMm));
    out.push(...port.diagnostics);
  } else {
    out.push({ code: 'NO_PORT', severity: 'warning', message: 'No feed is defined.', fix: 'Use the Feed step to pick the signal and reference terminals.' });
  }

  const order = { error: 0, warning: 1, info: 2 };
  out.sort((x, y) => order[x.severity] - order[y.severity]);
  return { diagnostics: out, classes, cellMm, port };
}

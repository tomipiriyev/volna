// Feed (lumped port) definition and validation.
//
// A port is an axis-aligned line at a lateral position. Its terminals are
// found by intersecting that line with the signal and reference bodies: the
// gap runs from the reference surface to the signal surface that face each
// other across `anchor`. Sign convention (docs/ports.md): V = phi_signal -
// phi_reference, and positive current flows from the source into the signal
// terminal.
import { axisLine, lineHits, otherAxes } from './geometry';
import { isConductor } from './classify';
import type { Assignment, Axis, CadBody, CadModel, Diagnostic, PortDef, PortGeometry, Vec3 } from './types';

export const DEFAULT_Z0 = 50;
const GRAZING_COS = Math.cos((45 * Math.PI) / 180);

export interface PortEvaluation {
  geometry: PortGeometry | null;
  diagnostics: Diagnostic[];
}

function pointOnLine(axis: Axis, lateral: [number, number], t: number): Vec3 {
  const { origin } = axisLine(axis, lateral);
  origin[axis] = t;
  return origin;
}

/** Suggests an axis and lateral position from two picked points and the signal face normal. */
export function suggestPort(
  signalPoint: Vec3,
  referencePoint: Vec3,
  signalFaceAxis: Axis | null,
): { axis: Axis; lateral: [number, number]; anchor: number } {
  const ad = signalPoint.map((v, i) => Math.abs(v - referencePoint[i]));
  const axis: Axis = signalFaceAxis ?? (ad.indexOf(Math.max(...ad)) as Axis);
  const [u, v] = otherAxes(axis);
  return {
    axis,
    lateral: [signalPoint[u], signalPoint[v]],
    anchor: (signalPoint[axis] + referencePoint[axis]) / 2,
  };
}

export function evaluatePort(
  model: CadModel,
  port: PortDef,
  assignments: Record<string, Assignment>,
  scale: number,
): PortEvaluation {
  const diags: Diagnostic[] = [];
  const err = (code: string, message: string, fix?: string, bodyIds?: string[]): PortEvaluation => ({
    geometry: null,
    diagnostics: [...diags, { code, severity: 'error', message, fix, bodyIds }],
  });
  const sig = model.bodies.find((b) => b.id === port.signal.bodyId);
  const ref = model.bodies.find((b) => b.id === port.reference.bodyId);
  if (!sig || !ref) return err('PORT_BODY_MISSING', 'A feed terminal refers to a body that is not in the model.', 'Pick the terminals again.');
  if (sig.id === ref.id)
    return err('PORT_SAME_BODY', 'Signal and reference terminals are on the same body; the source would be shorted.', 'Pick the reference terminal on a different conductor (e.g. the ground).', [sig.id]);
  for (const [b, label] of [[sig, 'Signal'], [ref, 'Reference']] as const) {
    const role = assignments[b.id]?.role;
    if (!isConductor(role))
      return err('PORT_NOT_CONDUCTOR', `${label} terminal body "${b.name}" is not assigned a conductor role.`, 'Assign it as radiator, ground or passive conductor.', [b.id]);
  }
  if (assignments[sig.id]?.role !== 'radiator')
    diags.push({ code: 'PORT_SIGNAL_ROLE', severity: 'warning', message: `Signal terminal "${sig.name}" is not a radiating conductor.`, bodyIds: [sig.id] });
  if (assignments[ref.id]?.role !== 'ground' && assignments[ref.id]?.role !== 'radiator')
    diags.push({ code: 'PORT_REFERENCE_ROLE', severity: 'info', message: `Reference terminal "${ref.name}" is a passive conductor; usually it is the ground or the other dipole arm.`, bodyIds: [ref.id] });

  const { origin, dir } = axisLine(port.axis, port.lateral);
  const sh = lineHits(sig, origin, dir);
  const rh = lineHits(ref, origin, dir);
  if (sh.length === 0) return err('PORT_MISSES_SIGNAL', `The feed line does not reach the signal body "${sig.name}".`, 'Move the feed line laterally onto the terminal faces.', [sig.id]);
  if (rh.length === 0) return err('PORT_MISSES_REFERENCE', `The feed line does not reach the reference body "${ref.name}".`, 'Move the feed line laterally onto the terminal faces.', [ref.id]);

  // Nearest signal surface on either side of the anchor; the reference surface must be on the other side.
  const a = port.anchor;
  const nearest = (hits: typeof sh, side: 1 | -1) =>
    hits.filter((h) => (h.t - a) * side >= 0).sort((x, y) => Math.abs(x.t - a) - Math.abs(y.t - a))[0];
  let best: { s: (typeof sh)[0]; r: (typeof rh)[0]; dir: 1 | -1 } | null = null;
  for (const side of [1, -1] as const) {
    const s = nearest(sh, side), r = nearest(rh, (-side) as 1 | -1);
    if (s && r && (!best || Math.abs(s.t - r.t) < Math.abs(best.s.t - best.r.t))) best = { s, r, dir: side };
  }
  if (!best)
    return err('PORT_NO_GAP', 'The signal and reference bodies do not face each other across the feed point along this axis.', 'Check the feed axis and the anchor position between the terminals.', [sig.id, ref.id]);
  const gapModel = Math.abs(best.s.t - best.r.t);
  if (gapModel <= 1e-9)
    return err('PORT_ZERO_GAP', 'The terminals touch along the feed line: there is no gap for the source.', 'Leave a physical gap between the conductors at the feed.', [sig.id, ref.id]);

  // The gap must not run inside a closed terminal body (odd number of crossings
  // before the midpoint). Open sheets have no inside, so parity does not apply.
  const mid = (best.s.t + best.r.t) / 2;
  const inside = (b: CadBody, hits: typeof sh) => b.topology.closed && hits.filter((h) => h.t < mid).length % 2 === 1;
  if (inside(sig, sh) || inside(ref, rh))
    return err('PORT_INSIDE_CONDUCTOR', 'The feed gap lies inside a terminal conductor.', 'Move the anchor into the space between the conductors.', [sig.id, ref.id]);

  // Terminal surfaces should face the feed axis, not be grazed by it.
  for (const [h, b] of [[best.s, sig], [best.r, ref]] as const) {
    if (Math.abs(h.normal[port.axis]) < GRAZING_COS)
      return err('PORT_OBLIQUE', `The feed line meets "${b.name}" at more than 45° from its surface normal (oblique feed).`, 'Feeds must be perpendicular to the terminal faces; choose a different axis or face.', [b.id]);
  }

  // Any other conductor crossing the gap shorts the source.
  const lo = Math.min(best.s.t, best.r.t), hi = Math.max(best.s.t, best.r.t);
  for (const b of model.bodies) {
    if (b.id === sig.id || b.id === ref.id || !isConductor(assignments[b.id]?.role)) continue;
    const hits = lineHits(b, origin, dir);
    const crosses = hits.some((h) => h.t > lo && h.t < hi) || inside(b, hits);
    if (crosses) return err('PORT_SHORTED', `Conductor "${b.name}" crosses the feed gap and would short the source.`, 'Move the feed or reassign that body.', [b.id]);
  }

  return {
    geometry: {
      start: pointOnLine(port.axis, port.lateral, best.r.t),
      end: pointOnLine(port.axis, port.lateral, best.s.t),
      gap: gapModel * scale,
      direction: best.dir,
    },
    diagnostics: diags,
  };
}

export function portFeedDiagnostics(geom: PortGeometry, cellMm: number): Diagnostic[] {
  if (geom.gap < cellMm)
    return [
      {
        code: 'PORT_GAP_UNRESOLVED',
        severity: 'info',
        message: `Feed gap ${geom.gap.toFixed(3)} mm is smaller than the estimated cell size (~${cellMm.toFixed(3)} mm); the mesher refines along the feed (at least 2 cells across the gap), which shortens the time step.`,
      },
    ];
  return [];
}

export const bodyName = (b: CadBody | undefined) => b?.name ?? '(missing body)';

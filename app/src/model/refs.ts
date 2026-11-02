// Stable references to CAD entities. Body ids are deterministic for a given
// file and importer; fingerprints (area, centroid, bbox, face count) confirm
// identity and allow re-matching when the file or importer changes.
import type { Assignment, BodyRef, CadBody, CadModel, FaceRef, Fingerprint } from './types';

export function bodyRef(b: CadBody): BodyRef {
  return { bodyId: b.id, fingerprint: b.fingerprint };
}

export function faceRef(b: CadBody, faceIndex: number): FaceRef {
  const f = b.faces[faceIndex];
  return { ...bodyRef(b), faceIndex, faceFingerprint: { area: f.area, centroid: f.centroid } };
}

export function fingerprintMatches(a: Fingerprint, b: Fingerprint, relTol = 1e-4): boolean {
  if ((a.faceCount ?? -1) !== (b.faceCount ?? -1)) return false;
  const scale = Math.max(
    1e-9,
    ...[0, 1, 2].map((k) => a.bbox.max[k] - a.bbox.min[k]),
  );
  if (Math.abs(a.area - b.area) > relTol * Math.max(a.area, b.area)) return false;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.centroid[k] - b.centroid[k]) > relTol * scale) return false;
    if (Math.abs(a.bbox.min[k] - b.bbox.min[k]) > relTol * scale) return false;
    if (Math.abs(a.bbox.max[k] - b.bbox.max[k]) > relTol * scale) return false;
  }
  return true;
}

export interface Rematch {
  /** Saved body id -> body id in the current model. */
  map: Map<string, string>;
  /** Saved ids whose body could not be found by id or fingerprint. */
  orphans: string[];
  /** Saved ids that were found only by fingerprint (id changed). */
  remapped: string[];
}

/** Resolves saved references against a freshly imported model. */
export function rematchRefs(model: CadModel, refs: BodyRef[]): Rematch {
  const byId = new Map(model.bodies.map((b) => [b.id, b]));
  const used = new Set<string>();
  const map = new Map<string, string>();
  const orphans: string[] = [], remapped: string[] = [];
  // Exact id + fingerprint first, then fingerprint-only for the rest.
  for (const r of refs) {
    const b = byId.get(r.bodyId);
    if (b && fingerprintMatches(b.fingerprint, r.fingerprint)) {
      map.set(r.bodyId, b.id);
      used.add(b.id);
    }
  }
  for (const r of refs) {
    if (map.has(r.bodyId)) continue;
    const candidate = model.bodies.find((b) => !used.has(b.id) && fingerprintMatches(b.fingerprint, r.fingerprint));
    if (candidate) {
      map.set(r.bodyId, candidate.id);
      used.add(candidate.id);
      remapped.push(r.bodyId);
    } else orphans.push(r.bodyId);
  }
  return { map, orphans, remapped };
}

export function remapAssignments(
  saved: { ref: BodyRef; assignment: Assignment }[],
  match: Rematch,
): Record<string, Assignment> {
  const out: Record<string, Assignment> = {};
  for (const s of saved) {
    const id = match.map.get(s.ref.bodyId);
    if (id) out[id] = { ...s.assignment };
  }
  return out;
}

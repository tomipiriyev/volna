// Versioned project file (.antsim): a ZIP holding project.json and, by
// default, the original STEP bytes as model.step. Without the embedded STEP
// the user must supply a file with the same SHA-256 when opening. Optional
// (added within v1, ignored by older readers): simulation settings and saved
// results as results/<id>.json (the solver's results JSON; JSON numbers
// round-trip doubles exactly).
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { bodyRef } from './refs';
import type { Assignment, BodyRef, CadModel, FrequencySettings, LengthUnit, Material, PortDef, Vec3 } from './types';
import type { ResultsJson } from '../sim/results';
import type { SimSettings } from '../sim/simStore';

/** Metadata of a saved result; the data is results/<id>.json. */
export interface SavedResultMeta {
  id: string;
  label: string;
  /** SHA-256 of the problem JSON the result was computed from. */
  hash: string;
  finishedAt: number;
  lossless: boolean;
  center: Vec3;
}

export interface SavedResult extends SavedResultMeta {
  results: ResultsJson;
}

export const PROJECT_FORMAT = 'antsim-project';
export const PROJECT_FORMAT_VERSION = 1;
export const APP_VERSION = '0.1.0';

export interface ProjectFileV1 {
  format: typeof PROJECT_FORMAT;
  formatVersion: 1;
  appVersion: string;
  savedAt: string;
  importer: { id: string; version: string };
  source: { fileName: string; sha256: string; embedded: boolean };
  units: { override: LengthUnit | null; confirmed: boolean };
  assignments: { ref: BodyRef; assignment: Assignment }[];
  materials: Material[];
  port: PortDef | null;
  frequency: FrequencySettings;
  simulation?: SimSettings;
  results?: SavedResultMeta[];
}

export interface ProjectContent {
  model: CadModel;
  stepBytes: Uint8Array;
  units: { override: LengthUnit | null; confirmed: boolean };
  assignments: Record<string, Assignment>;
  materials: Material[];
  port: PortDef | null;
  frequency: FrequencySettings;
  simulation?: SimSettings;
  results?: SavedResult[];
}

export function buildProjectJson(c: ProjectContent, embedStep: boolean): ProjectFileV1 {
  const byId = new Map(c.model.bodies.map((b) => [b.id, b]));
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    importer: c.model.importer,
    source: { fileName: c.model.fileName, sha256: c.model.sourceSha256, embedded: embedStep },
    units: c.units,
    assignments: Object.entries(c.assignments)
      .filter(([id]) => byId.has(id))
      .map(([id, assignment]) => ({ ref: bodyRef(byId.get(id)!), assignment })),
    materials: c.materials,
    port: c.port,
    frequency: c.frequency,
    ...(c.simulation ? { simulation: c.simulation } : {}),
    ...(c.results?.length ? { results: c.results.map(({ results: _r, ...meta }) => meta) } : {}),
  };
}

export function writeProjectZip(c: ProjectContent, embedStep = true): Uint8Array {
  const json = buildProjectJson(c, embedStep);
  const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(json, null, 2)) };
  if (embedStep) files['model.step'] = c.stepBytes;
  for (const r of c.results ?? []) files[`results/${r.id}.json`] = strToU8(JSON.stringify(r.results));
  return zipSync(files, { level: 6 });
}

export interface ReadProject {
  project: ProjectFileV1;
  stepBytes: Uint8Array | null;
  results: SavedResult[];
  /** Saved results whose data file is missing or unreadable. */
  droppedResults: number;
}

export function readProjectZip(bytes: Uint8Array): ReadProject {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('Not a project file (expected a .antsim ZIP archive).');
  }
  const raw = files['project.json'];
  if (!raw) throw new Error('Project archive has no project.json.');
  const project = migrateProject(JSON.parse(strFromU8(raw)));
  const results: SavedResult[] = [];
  let droppedResults = 0;
  for (const meta of project.results ?? []) {
    const data = files[`results/${meta.id}.json`];
    try {
      const parsed = data ? (JSON.parse(strFromU8(data)) as ResultsJson) : null;
      if (parsed?.ok && Array.isArray(parsed.farField)) results.push({ ...meta, results: parsed });
      else droppedResults++;
    } catch {
      droppedResults++;
    }
  }
  return { project, stepBytes: files['model.step'] ?? null, results, droppedResults };
}

/** Upgrades older project JSON to the current format; rejects unknown or newer versions. */
export function migrateProject(json: unknown): ProjectFileV1 {
  const j = json as { format?: string; formatVersion?: number };
  if (j?.format !== PROJECT_FORMAT) throw new Error('Not a Volna Antenna Simulation project (format marker missing).');
  if (typeof j.formatVersion !== 'number') throw new Error('Project file has no format version.');
  if (j.formatVersion > PROJECT_FORMAT_VERSION)
    throw new Error(`Project format v${j.formatVersion} is newer than this app supports (v${PROJECT_FORMAT_VERSION}).`);
  // v1 is the first format; future versions add migration steps here (v1 -> v2 -> ...).
  return json as ProjectFileV1;
}

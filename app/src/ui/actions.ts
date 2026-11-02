// File-level actions: STEP import, project open and save.
import { create } from 'zustand';
import { importStep } from '../cad/cadClient';
import { sha256Hex } from '../cad/occtImport';
import { readProjectZip, writeProjectZip } from '../model/projectFile';
import { rematchRefs, remapAssignments } from '../model/refs';
import { useProject, useUi } from '../model/store';
import { DEFAULT_SIM_SETTINGS, useSim } from '../sim/simStore';
import type { CadStage } from '../workers/cadProtocol';

interface ActivityState {
  busy: string | null;
  error: string | null;
  notice: string | null;
  cancel: (() => void) | null;
  set(p: Partial<Omit<ActivityState, 'set'>>): void;
}

export const useActivity = create<ActivityState>()((set) => ({
  busy: null,
  error: null,
  notice: null,
  cancel: null,
  set: (p) => set(p),
}));

const STAGE_LABEL: Record<CadStage, string> = {
  'loading-kernel': 'Loading CAD kernel…',
  parsing: 'Parsing STEP and tessellating…',
  analyzing: 'Analyzing geometry…',
};

const ACCEPTED = /\.(step|stp)$/i;

async function runImport(fileName: string, bytes: Uint8Array) {
  const act = useActivity.getState();
  const job = importStep(fileName, bytes, (stage) => act.set({ busy: STAGE_LABEL[stage] }));
  act.set({ busy: 'Reading file…', error: null, notice: null, cancel: job.cancel });
  try {
    return await job.promise;
  } finally {
    useActivity.getState().set({ busy: null, cancel: null });
  }
}

export async function importStepFile(file: File) {
  const act = useActivity.getState();
  if (!ACCEPTED.test(file.name)) return act.set({ error: `${file.name}: expected a .step or .stp file.` });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { model, seconds } = await runImport(file.name, bytes);
    useProject.getState().setModel(model, bytes);
    useSim.getState().reset();
    useUi.getState().resetView();
    useUi.getState().setStep('import');
    act.set({ notice: `Imported ${file.name}: ${model.bodies.length} bodies in ${seconds.toFixed(2)} s.` });
  } catch (e) {
    act.set({ error: `Import failed: ${(e as Error).message}` });
  }
}

export function saveProject(embedStep = true, includeResults = true) {
  const p = useProject.getState();
  const sim = useSim.getState();
  if (!p.model || !p.stepBytes) return;
  const zip = writeProjectZip(
    {
      model: p.model,
      stepBytes: p.stepBytes,
      units: { override: p.units.override, confirmed: p.units.confirmed },
      assignments: p.assignments,
      materials: p.materials,
      port: p.port,
      frequency: p.freq,
      simulation: sim.settings,
      results: includeResults ? sim.history.map(({ id, label, hash, finishedAt, lossless, center, results }) => ({ id, label, hash, finishedAt, lossless, center, results })) : [],
    },
    embedStep,
  );
  const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = p.model.fileName.replace(ACCEPTED, '') + '.antsim';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Opens a project. If the STEP is not embedded, `stepFile` must be supplied;
 * a SHA-256 mismatch is reported, and assignments are re-matched by geometry.
 */
export async function openProjectFile(file: File, stepFile?: File) {
  const act = useActivity.getState();
  try {
    const { project, stepBytes: embedded, results, droppedResults } = readProjectZip(new Uint8Array(await file.arrayBuffer()));
    let stepBytes = embedded;
    if (!stepBytes) {
      if (!stepFile) return act.set({ error: `This project does not embed its STEP file. Open it together with "${project.source.fileName}".` });
      stepBytes = new Uint8Array(await stepFile.arrayBuffer());
    }
    const warnings: string[] = [];
    if ((await sha256Hex(stepBytes)) !== project.source.sha256)
      warnings.push('The STEP file differs from the one the project was saved with; assignments were re-matched by geometry.');
    const { model } = await runImport(project.source.fileName, stepBytes);
    const refs = [...project.assignments.map((a) => a.ref), ...(project.port ? [project.port.signal, project.port.reference] : [])];
    const match = rematchRefs(model, refs);
    let port = project.port;
    if (port) {
      const s = match.map.get(port.signal.bodyId), r = match.map.get(port.reference.bodyId);
      if (s && r) {
        const sb = model.bodies.find((b) => b.id === s)!, rb = model.bodies.find((b) => b.id === r)!;
        port = { ...port, signal: { bodyId: s, fingerprint: sb.fingerprint }, reference: { bodyId: r, fingerprint: rb.fingerprint } };
      } else {
        port = null;
        warnings.push('The feed terminals could not be found in the model; the feed was removed.');
      }
    }
    if (match.orphans.length) warnings.push(`${match.orphans.length} assignment(s) refer to bodies that no longer exist and were dropped.`);
    if (match.remapped.length) warnings.push(`${match.remapped.length} body reference(s) were re-matched by geometry.`);
    if (droppedResults) warnings.push(`${droppedResults} saved result(s) could not be read and were skipped.`);
    useProject.getState().restore({
      model,
      stepBytes,
      units: { declared: model.units, override: project.units.override, confirmed: project.units.confirmed },
      assignments: remapAssignments(project.assignments, match),
      materials: project.materials,
      port,
      freq: project.frequency,
    });
    // Saved results never count as current by key; validating the project
    // makes them current when it reproduces the same problem (same hash).
    useSim.getState().reset(
      { ...DEFAULT_SIM_SETTINGS, ...project.simulation, mesh: { ...DEFAULT_SIM_SETTINGS.mesh, ...project.simulation?.mesh } },
      results.map((r) => ({ ...r, key: '', source: 'file' as const })),
    );
    useUi.getState().resetView();
    useUi.getState().setStep(results.length ? 'results' : 'assign');
    act.set({ notice: `Opened project ${file.name}.`, error: warnings.length ? warnings.join(' ') : null });
  } catch (e) {
    act.set({ error: `Could not open project: ${(e as Error).message}` });
  }
}

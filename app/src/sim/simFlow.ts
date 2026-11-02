// Orchestrates Mesh -> Validate -> Simulate: grid planning (main thread, pure
// TS), simulation tessellation (CAD worker), problem building, and the solver
// worker (prepare-only validation, then the run). A fresh solver worker is used
// per validation and per run and terminated afterwards, which releases its
// wasm memory (wasm heaps never shrink).
import { tessellateForSimulation } from '../cad/cadClient';
import { sha256Hex } from '../cad/occtImport';
import { unitScale, type ProjectSnapshot } from '../model/diagnostics';
import { useProject } from '../model/store';
import type { Capabilities } from '../platform/capabilities';
import { simDeflection } from './estimate';
import { blockingIssues, buildSimulation, planMesh, type MeshPlan } from './problemBuilder';
import { isLossless } from './reliability';
import type { ResultsJson } from './results';
import { SolverClient, SolverError, type SolveHandle } from './solverClient';
import { inputKey, useSim } from './simStore';

let activeRun: SolveHandle | null = null;

function snapshot(): ProjectSnapshot | null {
  const p = useProject.getState();
  if (!p.model) return null;
  return { model: p.model, units: p.units, assignments: p.assignments, materials: p.materials, port: p.port, freq: p.freq };
}

export function currentKey(): string {
  return inputKey(useProject.getState().revision, useSim.getState().settingsVersion);
}

/** Plans the grid for the current inputs (instant). Returns null and records blockers if it cannot. */
export function meshProject(): MeshPlan | null {
  const s = snapshot();
  if (!s) return null;
  const blockers = blockingIssues(s);
  if (blockers.length) {
    useSim.setState({ blockers, meshPlan: null });
    return null;
  }
  try {
    const plan = planMesh(s, useSim.getState().settings.mesh);
    useSim.setState({ blockers: [], meshPlan: { key: currentKey(), plan }, error: null });
    return plan;
  } catch (e) {
    useSim.setState({ blockers: [{ code: 'MESH_FAILED', severity: 'error', message: (e as Error).message }], meshPlan: null });
    return null;
  }
}

function freshMeshPlan(): MeshPlan | null {
  const m = useSim.getState().meshPlan;
  return m && m.key === currentKey() ? m.plan : meshProject();
}

/** Tessellates for simulation, builds the problem and prepares it in the solver (no time stepping). */
export async function validateProject(caps: Capabilities): Promise<boolean> {
  const key = currentKey();
  const s = snapshot();
  const meshPlan = freshMeshPlan();
  const bytes = useProject.getState().stepBytes;
  if (!s || !meshPlan) return false;
  if (!bytes) {
    useSim.setState({ error: 'The original STEP data is not available; re-import the file.' });
    return false;
  }
  const settings = useSim.getState().settings;
  useSim.setState({ busy: { what: 'validate', stage: 'Tessellating for simulation…' }, error: null });
  let client: SolverClient | null = null;
  try {
    const minCell = Math.min(...meshPlan.mesh.minCell);
    const deflection = simDeflection(minCell, unitScale(s.units));
    const tess = await tessellateForSimulation(bytes, deflection);
    const sim = new Map(tess.bodies.map((b) => [b.id, { positions: b.positions, indices: b.indices }]));
    useSim.setState({ busy: { what: 'validate', stage: 'Building the problem…' } });
    const plan = buildSimulation(s, sim, settings.mesh, undefined, meshPlan);
    Object.assign(plan.problem, { termination: { energyDb: settings.energyDb, maxSteps: settings.maxSteps } });
    const problemJson = JSON.stringify(plan.problem);
    const hash = await sha256Hex(new TextEncoder().encode(problemJson));
    useSim.setState({ busy: { what: 'validate', stage: 'Voxelizing and checking in the solver…' } });
    client = await SolverClient.create(caps.threads, caps.threadsReason);
    const v = await client.validate(problemJson, { memoryLimitBytes: settings.memoryLimitMb * 1024 ** 2 });
    if (currentKey() !== key) throw new Error('The project changed during validation; validate again.');
    useSim.setState({
      validation: { key, plan, problemJson, hash, info: v.info, pecSegments: v.pecSegments, nsPerCellStep: v.nsPerCellStep, tessellation: { triangles: tess.triangles, seconds: tess.seconds, deflection } },
    });
    return !hasErrors();
  } catch (e) {
    useSim.setState({ error: (e as Error).message, validation: null });
    return false;
  } finally {
    client?.terminate();
    useSim.setState({ busy: null });
  }
}

/** Errors in the current validation (plan diagnostics or solver diagnostics). */
export function hasErrors(): boolean {
  const v = useSim.getState().validation;
  if (!v) return true;
  return v.plan.diagnostics.some((d) => d.severity === 'error') || v.info.report.diagnostics.some((d) => d.severity === 'error');
}

/** Runs the current problem, validating first if the inputs changed. */
export async function runProject(caps: Capabilities): Promise<void> {
  if (useSim.getState().busy) return;
  let v = useSim.getState().validation;
  if (!v || v.key !== currentKey()) {
    if (!(await validateProject(caps))) return;
    v = useSim.getState().validation!;
  }
  if (hasErrors()) {
    useSim.setState({ error: 'Validation reported errors; fix them before running.' });
    return;
  }
  const { key, hash, problemJson, plan } = v;
  const backend = useSim.getState().backend;
  useSim.setState({ busy: { what: 'run', stage: 'Starting the solver…' }, error: null, progress: null, prepared: null, eta: null, gpuFailed: false });
  const decay: { t: number; db: number }[] = [];
  let client: SolverClient | null = null;
  try {
    client = await SolverClient.create(caps.threads, caps.threadsReason);
    const cpuLabel = `Running on the CPU (${client.info.variant === 'mt' ? `${client.info.maxThreads} threads` : 'single thread'})`;
    useSim.setState({ busy: { what: 'run', stage: backend === 'webgpu' ? 'Preparing WebGPU…' : cpuLabel } });
    const lose = Number(new URLSearchParams(globalThis.location?.search ?? '').get('gpuLoseDevice'));
    activeRun = client.solve(problemJson, {
      memoryLimitBytes: useSim.getState().settings.memoryLimitMb * 1024 ** 2,
      patterns: true,
      backend,
      debugLoseDeviceAfter: lose > 0 ? lose : undefined,
      onPrepared: (prepared) =>
        useSim.setState({ prepared, busy: { what: 'run', stage: prepared.backend === 'webgpu' ? `Running on WebGPU (${prepared.gpuAdapter})` : cpuLabel } }),
      onProgress: (progress) => {
        decay.push({ t: progress.elapsedSeconds, db: progress.energyDb });
        useSim.setState({ progress, eta: remainingSeconds(decay, progress.targetDb) });
      },
    });
    const results = JSON.parse(await activeRun.promise) as ResultsJson;
    const st = plan.mesh.structure;
    const fileName = useProject.getState().model?.fileName ?? 'model';
    useSim.getState().addResult({
      id: `run-${Date.now().toString(36)}`,
      key,
      hash,
      results,
      finishedAt: Date.now(),
      label: `${fileName} · ${new Date().toLocaleTimeString()}`,
      lossless: isLossless(plan.problem as { materials?: { sigma?: number; type?: string }[] }),
      center: [0, 1, 2].map((a) => 0.5 * (st.min[a] + st.max[a])) as [number, number, number],
      source: 'run',
    });
  } catch (e) {
    const cancelled = e instanceof SolverError && e.code === 'CANCELLED';
    const gpuFailed = backend === 'webgpu' && e instanceof SolverError && e.code.startsWith('GPU_');
    useSim.setState({ error: cancelled ? 'Run cancelled.' : (e as Error).message, gpuFailed });
  } finally {
    activeRun = null;
    client?.terminate();
    useSim.setState({ busy: null });
  }
}

/**
 * Remaining time from the recent energy decay: a least-squares line through the
 * samples of the last 40% of the elapsed time, once the field has started to
 * decay (below -3 dB). Null while the trend is flat or rising.
 */
export function remainingSeconds(samples: { t: number; db: number }[], targetDb: number): number | null {
  const last = samples[samples.length - 1];
  if (!last || last.db > -3 || last.db <= targetDb) return null;
  const pts = samples.filter((p) => p.t >= 0.6 * last.t && p.db <= -3);
  if (pts.length < 5) return null;
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n, md = pts.reduce((a, p) => a + p.db, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.db - md);
    den += (p.t - mt) ** 2;
  }
  const slope = den > 0 ? num / den : 0; // dB per second
  return slope < 0 ? (targetDb - last.db) / slope : null;
}

export function cancelRun() {
  activeRun?.cancel();
}

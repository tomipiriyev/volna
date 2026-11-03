// Right-panel content for the Mesh, Validate and Simulate steps. State lives in
// sim/simStore.ts; the work is done by sim/simFlow.ts.
import { useEffect } from 'react';
import { useProject } from '../model/store';
import type { Diagnostic } from '../model/types';
import type { Capabilities } from '../platform/capabilities';
import { estimateRunTime, formatDuration, timeStep } from '../sim/estimate';
import { estimateMemory, formatBytes, type ProblemJson } from '../sim/memoryEstimate';
import { minS11 } from '../sim/results';
import { farFieldAvail } from '../sim/reliability';
import { useUi } from '../model/store';
import { AvailText } from './ResultsView';
import { cancelRun, meshProject, runProject, validateProject } from '../sim/simFlow';
import { inputKey, resultIsCurrent, selectedResult, useSim, type GridPlane, type SimResult } from '../sim/simStore';
import type { SolverBackend, SolverDiagnostic } from '../workers/protocol';

const ICON = { error: '⛔', warning: '⚠', info: 'ℹ' } as const;
const AXES = ['x', 'y', 'z'];
const mm = (v: number) => `${v.toPrecision(4)} mm`;

function useKey() {
  const revision = useProject((s) => s.revision);
  const settingsVersion = useSim((s) => s.settingsVersion);
  return inputKey(revision, settingsVersion);
}

function DiagList({ items, testId }: { items: (Diagnostic | SolverDiagnostic)[]; testId?: string }) {
  if (!items.length) return null;
  return (
    <ul className="diagnostics compact" data-testid={testId}>
      {items.map((d, i) => (
        <li key={i} className={d.severity} data-code={d.code}>
          <span className="sev">{ICON[d.severity]}</span>
          <span>
            {d.message}
            {'fix' in d && d.fix && <span className="muted"> — {d.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NumberField({ label, value, onChange, min, max, step, testId }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; testId?: string }) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------- Mesh

export function MeshPanel() {
  const key = useKey();
  const sim = useSim();
  const freq = useProject((s) => s.freq);
  const port = useProject((s) => s.port);
  const m = sim.settings.mesh;
  const plan = sim.meshPlan?.key === key ? sim.meshPlan.plan : null;

  // Planning is pure TypeScript and fast: keep the preview in step with the inputs.
  useEffect(() => {
    if (sim.meshPlan?.key !== key) meshProject();
  }, [key, sim.meshPlan?.key]);

  const mesh = plan?.mesh;
  const memory = mesh
    ? estimateMemory({ grid: { x: mesh.lines[0], y: mesh.lines[1], z: mesh.lines[2] }, pml: { cells: m.pmlCells }, port: port ?? undefined, farField: { frequencies: freq.farField, marginCells: m.farFieldMarginCells }, termination: { maxSteps: sim.settings.maxSteps } } as ProblemJson)
    : null;

  return (
    <>
      <section className="card" data-testid="mesh-panel">
        <h3>Mesh</h3>
        <div className="grid2">
          <NumberField label="Max grading ratio" value={m.maxRatio} min={1.05} max={2} step={0.05} onChange={(maxRatio) => sim.setMeshSettings({ maxRatio })} />
          <NumberField label="Padding (λ at f min)" value={m.paddingWavelengths} min={0.1} max={1} step={0.05} onChange={(paddingWavelengths) => sim.setMeshSettings({ paddingWavelengths })} />
          <NumberField label="PML cells" value={m.pmlCells} min={4} max={20} step={1} onChange={(pmlCells) => sim.setMeshSettings({ pmlCells })} />
          <NumberField label="Cell limit (millions)" value={m.maxCells / 1e6} min={0.1} max={100} step={0.5} onChange={(v) => sim.setMeshSettings({ maxCells: Math.round(v * 1e6) })} />
        </div>
        <label className="check" title="Curved or oblique conductors use their true open lengths and areas in the cells they cut, instead of staircases. Takes about 24 % more time steps.">
          <input type="checkbox" checked={m.conformal} onChange={(e) => sim.setMeshSettings({ conformal: e.target.checked })} data-testid="mesh-conformal" />
          Conformal conductors
        </label>
        <p className="small muted">
          Background cell λ/{freq.cellsPerWavelength} at f max (set on the Frequency step), finer in dielectrics (λ/√εr), across thin
          slabs ({m.minSlabCells}+ cells), at the feed ({m.feedGapCells}+ cells across the gap) and on conductor faces. Neighbouring
          cells differ by at most the grading ratio.
        </p>
        <button type="button" onClick={() => meshProject()} data-testid="mesh-generate">
          Regenerate
        </button>
        <DiagList items={sim.blockers} testId="mesh-blockers" />
      </section>
      {mesh && plan && (
        <section className="card" data-testid="mesh-stats">
          <h3>Grid</h3>
          <table className="kv small">
            <tbody>
              <tr>
                <td>Cells</td>
                <td className={mesh.cells > m.maxCells ? 'error' : undefined} data-testid="mesh-cells">
                  {mesh.cells.toLocaleString()} ({mesh.lines.map((l) => l.length - 1).join(' × ')}, incl. {m.pmlCells} PML cells per side)
                </td>
              </tr>
              {AXES.map((a, i) => (
                <tr key={a}>
                  <td>{a} cells</td>
                  <td>
                    {mm(mesh.minCell[i])} … {mm(mesh.maxCell[i])}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Background cell</td>
                <td>{mm(mesh.backgroundCell)}</td>
              </tr>
              <tr>
                <td>Time step</td>
                <td>{(timeStep(mesh.lines) * 1e12).toFixed(3)} ps (Courant 0.99; 0.8 if conductors cut grid cells)</td>
              </tr>
              {memory && (
                <tr>
                  <td>Memory</td>
                  <td className={memory.total > sim.settings.memoryLimitMb * 1024 ** 2 ? 'error' : undefined}>
                    about {formatBytes(memory.total)} (limit {sim.settings.memoryLimitMb} MB)
                  </td>
                </tr>
              )}
              <tr>
                <td>Domain</td>
                <td>
                  {AXES.map((a, i) => `${a} ${mesh.domain.min[i].toFixed(1)}…${mesh.domain.max[i].toFixed(1)}`).join(', ')} mm
                </td>
              </tr>
            </tbody>
          </table>
          <DiagList items={plan.diagnostics} testId="mesh-diagnostics" />
          <h4>Preview</h4>
          <div className="row small">
            <label className="check">
              Grid plane
              <select value={sim.overlay.grid} onChange={(e) => sim.setOverlay({ grid: e.target.value as GridPlane })} data-testid="grid-plane">
                <option value="auto">through the feed (auto)</option>
                <option value="xy">xy</option>
                <option value="xz">xz</option>
                <option value="yz">yz</option>
                <option value="off">off</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={sim.overlay.boxes} onChange={(e) => sim.setOverlay({ boxes: e.target.checked })} /> Boxes
            </label>
          </div>
          <p className="small muted">
            <span className="swatch" style={{ background: '#ff5c5c' }} /> outer boundary (PML inside) <span className="swatch" style={{ background: '#8a97a6' }} /> structure + padding{' '}
            <span className="swatch" style={{ background: '#3ddc84' }} /> NF2FF box
          </p>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Validate

export function ValidatePanel({ caps }: { caps: Capabilities | null }) {
  const key = useKey();
  const sim = useSim();
  const freq = useProject((s) => s.freq);
  const v = sim.validation;
  const current = v?.key === key;
  const busy = sim.busy?.what === 'validate';

  const diags = current && v ? [...v.plan.diagnostics, ...v.info.report.diagnostics] : [];
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;
  const time = current && v ? estimateRunTime(v.plan.mesh.lines, freq.fMin, freq.fMax, sim.settings.maxSteps, v.nsPerCellStep, v.info.report.conformal ? 0.8 : 0.99) : null;

  return (
    <>
      <section className="card" data-testid="validate-panel">
        <h3>Validate</h3>
        <p className="small muted">
          Tessellates the STEP model for simulation, voxelizes it onto the grid in the solver (conductors as PEC edges, dielectrics
          per cell), places the port edges and checks overlaps, feed contact and DC paths. Nothing is time-stepped.
        </p>
        <button type="button" onClick={() => caps && validateProject(caps)} disabled={!caps || !!sim.busy} data-testid="validate-run">
          {busy ? 'Validating…' : current ? 'Validate again' : 'Validate'}
        </button>
        {sim.busy && (
          <p className="busy small">
            <span className="spinner" /> {sim.busy.stage}
          </p>
        )}
        {v && !current && !busy && <p className="warn small">The inputs changed since the last validation; validate again.</p>}
        {sim.error && !sim.busy && <p className="error small" data-testid="validate-error">{sim.error}</p>}
        <DiagList items={sim.blockers} />
      </section>
      {current && v && (
        <section className="card" data-testid="validate-report">
          <h3>
            {errors ? <span className="error">{errors} error{errors > 1 ? 's' : ''}</span> : <span className="ok">Ready to simulate</span>}
            {warnings > 0 && <span className="warn"> · {warnings} warning{warnings > 1 ? 's' : ''}</span>}
          </h3>
          <DiagList items={diags} testId="validate-diagnostics" />
          <table className="kv small">
            <thead>
              <tr>
                <td>Object</td>
                <td>Representation</td>
              </tr>
            </thead>
            <tbody>
              {v.info.report.objects.map((o) => (
                <tr key={o.name}>
                  <td>{o.name}</td>
                  <td>
                    {o.kind},{' '}
                    {o.conductor
                      ? o.material === 'pec'
                        ? `${o.pecEdges.toLocaleString()} PEC edges`
                        : `${o.material}: ${o.pecEdges.toLocaleString()} conductor edges, ${o.lossyEdges.toLocaleString()} on the surface with metal loss`
                      : `${o.cells.toLocaleString()} cells of ${o.material}`}
                    {o.snapDistance > 0 && `, moved ${(o.snapDistance * 1e3).toFixed(3)} mm onto the grid`}
                  </td>
                </tr>
              ))}
              {v.info.report.conformal && (
                <tr>
                  <td>Conformal conductors</td>
                  <td data-testid="conformal-report">
                    {v.info.report.conformal.cutFaces.toLocaleString()} cut faces, {v.info.report.conformal.cappedFaces.toLocaleString()} small ones capped for stability
                  </td>
                </tr>
              )}
              <tr>
                <td>Signal–reference DC path</td>
                <td>{v.info.report.dcConnected === null ? '—' : v.info.report.dcConnected ? 'connected (see warning)' : 'none'}</td>
              </tr>
              <tr>
                <td>Port edges</td>
                <td>{v.info.portSegments.length / 6}</td>
              </tr>
              <tr>
                <td>Tessellation</td>
                <td>
                  {v.tessellation.triangles.toLocaleString()} triangles, chord ≤ {v.tessellation.deflection.toPrecision(2)} mm ({v.tessellation.seconds.toFixed(2)} s)
                </td>
              </tr>
              <tr>
                <td>Memory</td>
                <td>
                  {formatBytes(v.info.memoryBytes)} allocated (estimate {formatBytes(v.info.estimate.total)}, limit {sim.settings.memoryLimitMb} MB)
                </td>
              </tr>
              <tr>
                <td>Threads</td>
                <td>{v.info.threads}</td>
              </tr>
              {time && Number.isFinite(time.minSeconds) && (
                <tr>
                  <td>Run time (estimate)</td>
                  <td data-testid="time-estimate">
                    at least {formatDuration(time.minSeconds)} ({time.minSteps.toLocaleString()} steps: pulse + 2 domain transits); up to{' '}
                    {formatDuration(time.maxSeconds)} at the {time.maxSteps.toLocaleString()}-step cap. Resonant antennas ring well past the minimum.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row small">
            <label className="check">
              <input type="checkbox" checked={sim.overlay.pec} onChange={(e) => sim.setOverlay({ pec: e.target.checked })} /> Show PEC edges
            </label>
            <span className="muted">
              <span className="swatch" style={{ background: '#ff9f1c' }} /> PEC edges (thinned to 200k) <span className="swatch" style={{ background: '#ff3df2' }} /> port edges
            </span>
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Simulate

export function SimulatePanel({ caps }: { caps: Capabilities | null }) {
  const key = useKey();
  const sim = useSim();
  const running = sim.busy?.what === 'run';
  const p = sim.progress;
  const energyFrac = p ? Math.min(1, Math.max(0, p.energyDb / p.targetDb)) : 0;
  const result = sim.history[0] ?? null;
  const current = resultIsCurrent(result, sim.validation, key);

  return (
    <>
      <section className="card" data-testid="simulate-panel">
        <h3>Simulate</h3>
        <div className="grid2">
          <NumberField label="Stop at field energy (dB)" value={sim.settings.energyDb} min={-90} max={-30} step={5} onChange={(energyDb) => sim.setSettings({ energyDb })} />
          <NumberField label="Step cap" value={sim.settings.maxSteps} min={1000} max={2_000_000} step={1000} onChange={(maxSteps) => sim.setSettings({ maxSteps })} />
          <NumberField label="Memory limit (MB)" value={sim.settings.memoryLimitMb} min={64} max={3800} step={64} onChange={(memoryLimitMb) => sim.setSettings({ memoryLimitMb })} />
          <label className="field">
            Time loop on
            <select value={sim.backend} onChange={(e) => sim.setBackend(e.target.value as SolverBackend)} disabled={!!sim.busy} data-testid="sim-backend">
              <option value="cpu">CPU (wasm)</option>
              <option value="webgpu" disabled={!caps?.webgpu.available}>
                WebGPU{caps?.webgpu.available ? (caps.webgpu.adapter ? ` (${caps.webgpu.adapter.vendor} ${caps.webgpu.adapter.architecture})`.replace(' ()', '') : '') : ' (unavailable)'}
              </option>
            </select>
          </label>
        </div>
        {sim.backend === 'webgpu' && (
          <p className="small muted">
            The GPU runs the same update equations in single precision and matches the CPU solver to about 1e-6 (Solver tab → GPU self-test). Setup and
            post-processing stay on the CPU.
          </p>
        )}
        <div className="row">
          <button type="button" onClick={() => caps && runProject(caps)} disabled={!caps || !!sim.busy} data-testid="sim-run">
            {running ? 'Running…' : 'Run simulation'}
          </button>
          {running && (
            <button type="button" onClick={cancelRun} data-testid="sim-cancel">
              Cancel
            </button>
          )}
        </div>
        {sim.busy && (
          <p className="busy small">
            <span className="spinner" /> {sim.busy.stage}
          </p>
        )}
        {running && p && (
          <div className="progress" data-testid="sim-progress">
            <div className="bar">
              <div style={{ width: `${(100 * energyFrac).toFixed(1)}%` }} />
            </div>
            <span className="small">
              step {p.step.toLocaleString()} / {p.maxSteps.toLocaleString()} · energy {p.energyDb.toFixed(1)} dB (stops at {p.targetDb} dB) · {p.mcellsPerSec.toFixed(0)} Mcells/s ·{' '}
              {formatDuration(p.elapsedSeconds)}
              <span data-testid="sim-eta">{sim.eta !== null ? ` · about ${formatDuration(sim.eta)} left (estimate from the energy decay)` : ' · time left: estimating once the field decays'}</span>
            </span>
          </div>
        )}
        {sim.error && !sim.busy && <p className="error small" data-testid="sim-error">{sim.error}</p>}
        {sim.gpuFailed && !sim.busy && (
          <button
            type="button"
            onClick={() => {
              sim.setBackend('cpu');
              if (caps) void runProject(caps);
            }}
            data-testid="sim-run-cpu"
          >
            Run on the CPU instead
          </button>
        )}
      </section>
      {result && <LatestRun result={result} current={current} />}
    </>
  );
}

function LatestRun({ result, current }: { result: SimResult; current: boolean }) {
  const r = result.results;
  const best = r.port ? minS11(r.port) : null;
  const sel = useSim((s) => selectedResult(s));
  return (
    <section className={`card${current ? '' : ' stale'}`} data-testid="sim-results">
      <h3>
        Latest run {!current && <span className="badge warn" data-testid="stale-badge">stale — inputs changed</span>}
      </h3>
      {r.run.terminatedBy !== 'energy' && (
        <p className="warn small">
          The run stopped at the step cap with field energy {r.run.finalEnergyDb.toFixed(1)} dB: spectra are truncated and the results are flagged
          unreliable. Raise the step cap.
        </p>
      )}
      <table className="kv small">
        <tbody>
          {best && (
            <tr>
              <td>|S11| minimum</td>
              <td data-testid="s11-min">
                {best.db.toFixed(2)} dB at {(best.f / 1e9).toFixed(4)} GHz
              </td>
            </tr>
          )}
          {r.farField.map((f) => {
            const a = farFieldAvail(r, f, result.lossless);
            return (
              <tr key={f.frequency}>
                <td>{(f.frequency / 1e9).toFixed(3)} GHz</td>
                <td data-testid="ff-row">
                  D <AvailText a={a.directivityDbi} fmt={(v) => `${v.toFixed(2)} dBi`} /> · G <AvailText a={a.gainDbi} fmt={(v) => `${v.toFixed(2)} dBi`} />
                </td>
              </tr>
            );
          })}
          <tr>
            <td>Run</td>
            <td>
              {r.run.steps.toLocaleString()} steps ({r.run.terminatedBy}), {formatDuration(r.run.seconds)}, {r.run.mcellsPerSec.toFixed(0)} Mcells/s{' '}
              <span data-testid="run-backend">{r.run.backend === 'webgpu' ? 'on WebGPU' : `on ${r.run.threads} CPU thread${r.run.threads === 1 ? '' : 's'}`}</span>
            </td>
          </tr>
        </tbody>
      </table>
      {r.warnings.length > 0 && (
        <ul className="notes small warn">
          {r.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => {
          if (sel?.id !== result.id) useSim.getState().selectResult(result.id);
          useUi.getState().setStep('results');
        }}
        data-testid="open-results"
      >
        Open results
      </button>
    </section>
  );
}

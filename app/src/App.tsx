import { useEffect, useState } from 'react';
import { useProject, useUi } from './model/store';
import { detectCapabilities, type Capabilities } from './platform/capabilities';
import { BenchmarkPanel } from './ui/BenchmarkPanel';
import { CapabilityReport } from './ui/CapabilityReport';
import { DiagnosticsPanel, diagnosticCounts } from './ui/DiagnosticsPanel';
import { FeedPanel } from './ui/FeedPanel';
import { ActivityBanner, FileActions } from './ui/FileActions';
import { FrequencyPanel } from './ui/FrequencyPanel';
import { ModelTree } from './ui/ModelTree';
import { MeshPanel, SimulatePanel, ValidatePanel } from './ui/SimPanels';
import { inputKey, resultIsCurrent, selectedResult, useSim } from './sim/simStore';
import { ResultsDashboard, ResultsPanel } from './ui/ResultsView';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { SolverSelfTest } from './ui/SolverSelfTest';
import { UnitsPanel } from './ui/UnitsPanel';
import { useDiagnostics } from './ui/useDiagnostics';
import { WorkflowStepper, type StepKey } from './ui/WorkflowStepper';
import { ViewportPanel } from './viewport/ViewportPanel';

type BottomTab = 'results' | 'diagnostics' | 'solver';

export function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [tab, setTab] = useState<BottomTab>('diagnostics');
  const model = useProject((s) => s.model);
  const port = useProject((s) => s.port);
  const units = useProject((s) => s.units);
  const assignments = useProject((s) => s.assignments);
  const step = useUi((s) => s.step);
  const setStep = useUi((s) => s.setStep);
  const { result } = useDiagnostics();
  const revision = useProject((s) => s.revision);
  const sim = useSim();
  const key = inputKey(revision, sim.settingsVersion);
  const latest = sim.history[0] ?? null;
  const shown = selectedResult(sim);
  // The results dashboard takes the bottom panel on the Results step.
  useEffect(() => {
    if (step === 'results') setTab('results');
    else setTab((t) => (t === 'results' ? 'diagnostics' : t));
  }, [step]);

  useEffect(() => {
    let alive = true;
    detectCapabilities().then((c) => alive && setCaps(c));
    return () => {
      alive = false;
    };
  }, []);

  const counts = diagnosticCounts(result?.diagnostics ?? []);
  const portErrors = result?.port?.diagnostics.some((d) => d.severity === 'error') ?? false;
  const status: Partial<Record<StepKey, 'ok' | 'warning' | 'error'>> = model
    ? {
        import: units.confirmed ? 'ok' : 'warning',
        assign: model.bodies.every((b) => assignments[b.id]) ? 'ok' : 'warning',
        feed: !port ? 'warning' : portErrors ? 'error' : 'ok',
        frequency: 'ok',
        ...(sim.meshPlan?.key === key ? { mesh: sim.meshPlan.plan.mesh.cells > sim.settings.mesh.maxCells ? 'error' : 'ok' } : {}),
        ...(sim.validation?.key === key ? { validate: validationStatus(sim.validation) } : {}),
        ...(latest ? { simulate: resultIsCurrent(latest, sim.validation, key) ? (latest.results.run.terminatedBy === 'energy' ? 'ok' : 'warning') : 'warning' } : {}),
        ...(shown ? { results: resultIsCurrent(shown, sim.validation, key) ? 'ok' : 'warning' } : {}),
      }
    : {};

  return (
    <div className={`app${tab === 'results' ? ' results-mode' : ''}`}>
      <header className="topbar">
        <h1 className="brand">
          Volna<span className="brand-sub">Antenna Simulation</span>
        </h1>
        <FileActions />
        <WorkflowStepper active={step} onSelect={setStep} hasModel={!!model} status={status} />
      </header>
      <ActivityBanner />
      <aside className="panel left">
        <h2>Model</h2>
        <ModelTree />
      </aside>
      <main className="viewport-host">
        <ViewportPanel />
      </main>
      <aside className="panel right">
        {step === 'import' && (
          <>
            <UnitsPanel />
            <section className="card">
              <h3>Environment</h3>
              <CapabilityReport caps={caps} />
            </section>
          </>
        )}
        {step === 'assign' && <PropertiesPanel />}
        {step === 'feed' && <FeedPanel />}
        {step === 'frequency' && <FrequencyPanel />}
        {step === 'mesh' && <MeshPanel />}
        {step === 'validate' && <ValidatePanel caps={caps} />}
        {step === 'simulate' && <SimulatePanel caps={caps} />}
        {step === 'results' && <ResultsPanel />}
      </aside>
      <section className="panel bottom">
        <div className="tabs" role="tablist">
          {step === 'results' && (
            <button type="button" role="tab" className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')} data-testid="tab-results">
              Results
            </button>
          )}
          <button type="button" role="tab" className={tab === 'diagnostics' ? 'on' : ''} onClick={() => setTab('diagnostics')} data-testid="tab-diagnostics">
            Diagnostics
            {counts.error > 0 && <span className="count error">{counts.error}</span>}
            {counts.warning > 0 && <span className="count warn">{counts.warning}</span>}
          </button>
          <button type="button" role="tab" className={tab === 'solver' ? 'on' : ''} onClick={() => setTab('solver')}>
            Solver
          </button>
        </div>
        {tab === 'results' ? (
          <ResultsDashboard />
        ) : tab === 'diagnostics' ? (
          <DiagnosticsPanel />
        ) : (
          <>
            <SolverSelfTest caps={caps} />
            <h3 className="subhead">Solver validation</h3>
            <BenchmarkPanel caps={caps} />
          </>
        )}
      </section>
    </div>
  );
}

function validationStatus(v: NonNullable<ReturnType<typeof useSim.getState>['validation']>): 'ok' | 'warning' | 'error' {
  const all = [...v.plan.diagnostics, ...v.info.report.diagnostics];
  return all.some((d) => d.severity === 'error') ? 'error' : all.some((d) => d.severity === 'warning') ? 'warning' : 'ok';
}

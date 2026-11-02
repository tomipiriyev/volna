import { useState } from 'react';
import type { Capabilities } from '../platform/capabilities';
import { SolverClient, type SolverInfo } from '../sim/solverClient';
import type { BenchmarkResult } from '../workers/protocol';

// Runs the C++ cavity benchmark in the solver worker. This is a throughput
// and plumbing check (worker, wasm variant selection, threads), not an
// antenna simulation.
export function SolverSelfTest({ caps }: { caps: Capabilities | null }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<SolverInfo | null>(null);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!caps) return;
    setBusy(true);
    setError(null);
    setResult(null);
    let client: SolverClient | null = null;
    try {
      client = await SolverClient.create(caps.threads, caps.threadsReason);
      setInfo({ ...client.info });
      setResult(await client.benchmark(64, 60));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // Recycle the worker after every job so wasm memory is released.
      client?.terminate();
      setBusy(false);
    }
  }

  return (
    <div className="selftest" data-testid="selftest">
      <div className="row">
        <button type="button" onClick={run} disabled={!caps || busy} data-testid="run-selftest">
          {busy ? 'Running…' : 'Run solver self-test'}
        </button>
        <span className="muted">PEC cavity, 64³ cells, 60 steps — measures throughput, not an antenna result.</span>
      </div>
      {info && (
        <p data-testid="solver-variant">
          Solver build <b>{info.variant === 'mt' ? 'multi-thread' : 'single-thread'}</b> v{info.version}, up to{' '}
          {info.maxThreads} thread{info.maxThreads === 1 ? '' : 's'}
          {info.fallbackReason && <span className="muted"> — single-thread because {info.fallbackReason}</span>}
        </p>
      )}
      {result && (
        <p data-testid="selftest-result">
          {result.mcellsPerSec.toFixed(0)} Mcells/s on {result.threads} thread{result.threads === 1 ? '' : 's'} (
          {result.nsPerCellStep.toFixed(2)} ns per cell-step, {(result.seconds * 1000).toFixed(0)} ms). Energy ratio{' '}
          {(result.energyEnd / result.energyStart).toFixed(6)} (lossless cavity; should stay near 1).
        </p>
      )}
      {error && (
        <p className="error" data-testid="selftest-error">
          {error}
        </p>
      )}
    </div>
  );
}

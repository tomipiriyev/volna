import { unitScale } from '../model/diagnostics';
import { otherAxes } from '../model/geometry';
import { DEFAULT_Z0, suggestPort } from '../model/port';
import { bodyRef } from '../model/refs';
import { useProject, useUi } from '../model/store';
import type { Axis, PortDef } from '../model/types';
import { useDiagnostics } from './useDiagnostics';

function NumberField({ label, value, onChange, step = 0.001, unit, testId }: { label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string; testId?: string }) {
  return (
    <label className="field">
      {label}
      <span className="row tight">
        <input type="number" step={step} value={Number(value.toPrecision(10))} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} data-testid={testId} />
        {unit && <span className="muted">{unit}</span>}
      </span>
    </label>
  );
}

export function FeedPanel() {
  const model = useProject((s) => s.model);
  const port = useProject((s) => s.port);
  const units = useProject((s) => s.units);
  const setPort = useProject((s) => s.setPort);
  const picks = useUi((s) => s.feedPicks);
  const pickMode = useUi((s) => s.pickMode);
  const selection = useUi((s) => s.selection);
  const { result } = useDiagnostics();
  if (!model) return null;
  const selectedFace = selection.bodyId !== null && selection.faceIndex !== null ? selection : null;

  /** Uses the tree/viewport face selection as a terminal, picking the face centroid. */
  function takeSelection(which: 'signal' | 'reference') {
    if (!selectedFace) return;
    const b = model!.bodies.find((x) => x.id === selectedFace.bodyId);
    const f = b?.faces[selectedFace.faceIndex!];
    if (!b || !f) return;
    useUi.getState().setFeedPick(which, { bodyId: b.id, faceIndex: f.index, point: [...f.centroid] });
  }
  const scale = unitScale(units);
  const name = (id: string | undefined) => model.bodies.find((b) => b.id === id)?.name ?? '—';
  const pe = result?.port;
  const update = (p: Partial<PortDef>) => port && setPort({ ...port, ...p });

  function createFromPicks() {
    const s = picks.signal!, r = picks.reference!;
    const sb = model!.bodies.find((b) => b.id === s.bodyId)!, rb = model!.bodies.find((b) => b.id === r.bodyId)!;
    const sug = suggestPort(s.point, r.point, sb.faces[s.faceIndex]?.axisAligned ?? null);
    setPort({ signal: bodyRef(sb), reference: bodyRef(rb), ...sug, z0: port?.z0 ?? DEFAULT_Z0, amplitude: port?.amplitude ?? 1 });
  }

  function centerOnSignalFace() {
    if (!port || !picks.signal) return;
    const sb = model!.bodies.find((b) => b.id === port.signal.bodyId);
    const f = sb?.faces[picks.signal.faceIndex];
    if (!f) return;
    const [u, v] = otherAxes(port.axis);
    update({ lateral: [f.centroid[u], f.centroid[v]] });
  }

  const [u, v] = port ? otherAxes(port.axis) : [0, 1];
  const errors = pe?.diagnostics.filter((d) => d.severity !== 'info') ?? [];

  return (
    <section className="card" data-testid="feed-panel">
      <h3>Feed (single lumped port)</h3>
      <div className="row">
        <button type="button" className={pickMode === 'feed-signal' ? 'on' : ''} onClick={() => useUi.getState().setPickMode('feed-signal')} data-testid="pick-signal">
          Pick signal
        </button>
        <button type="button" className={pickMode === 'feed-reference' ? 'on' : ''} onClick={() => useUi.getState().setPickMode('feed-reference')} data-testid="pick-reference">
          Pick reference
        </button>
      </div>
      <div className="row small">
        <span className="muted">or use the face selected in the tree:</span>
        <button type="button" className="link" disabled={selectedFace === null} onClick={() => takeSelection('signal')} data-testid="use-selection-signal">
          as signal
        </button>
        <button type="button" className="link" disabled={selectedFace === null} onClick={() => takeSelection('reference')} data-testid="use-selection-reference">
          as reference
        </button>
      </div>
      <table className="kv small">
        <tbody>
          <tr>
            <td><span className="dot sig" /> Signal pick</td>
            <td data-testid="signal-pick">{picks.signal ? `${name(picks.signal.bodyId)}, face ${picks.signal.faceIndex + 1}` : '—'}</td>
          </tr>
          <tr>
            <td><span className="dot ref" /> Reference pick</td>
            <td data-testid="reference-pick">{picks.reference ? `${name(picks.reference.bodyId)}, face ${picks.reference.faceIndex + 1}` : '—'}</td>
          </tr>
        </tbody>
      </table>
      <div className="row">
        <button type="button" disabled={!picks.signal || !picks.reference} onClick={createFromPicks} data-testid="create-feed">
          {port ? 'Rebuild feed from picks' : 'Create feed from picks'}
        </button>
        {port && (
          <button type="button" onClick={() => setPort(null)}>
            Remove feed
          </button>
        )}
      </div>

      {port && (
        <>
          <p className="small">
            Signal <b>{name(port.signal.bodyId)}</b> · reference <b>{name(port.reference.bodyId)}</b>
          </p>
          <label className="field">
            Feed axis
            <select value={port.axis} onChange={(e) => update({ axis: Number(e.target.value) as Axis })} data-testid="feed-axis">
              <option value={0}>x</option>
              <option value={1}>y</option>
              <option value={2}>z</option>
            </select>
          </label>
          <div className="grid2">
            <NumberField label={`Line ${'xyz'[u]}`} unit="mm" value={port.lateral[0] * scale} onChange={(x) => update({ lateral: [x / scale, port.lateral[1]] })} testId="feed-lat-u" />
            <NumberField label={`Line ${'xyz'[v]}`} unit="mm" value={port.lateral[1] * scale} onChange={(x) => update({ lateral: [port.lateral[0], x / scale] })} testId="feed-lat-v" />
          </div>
          <NumberField label={`Gap anchor (${'xyz'[port.axis]})`} unit="mm" value={port.anchor * scale} onChange={(x) => update({ anchor: x / scale })} />
          <button type="button" className="link" onClick={centerOnSignalFace} disabled={!picks.signal}>
            Center line on the picked signal face
          </button>
          <div className="grid2">
            <NumberField label="Reference impedance Z₀" unit="Ω" step={1} value={port.z0} onChange={(z0) => z0 > 0 && update({ z0 })} />
            <NumberField label="Source amplitude" unit="V" step={0.1} value={port.amplitude} onChange={(amplitude) => amplitude > 0 && update({ amplitude })} />
          </div>
          {pe?.geometry && (
            <table className="kv small" data-testid="feed-geometry">
              <tbody>
                <tr>
                  <td>Gap length</td>
                  <td data-testid="feed-gap">{pe.geometry.gap.toFixed(4)} mm</td>
                </tr>
                <tr>
                  <td>Direction (ref → signal)</td>
                  <td>{pe.geometry.direction > 0 ? '+' : '−'}{'xyz'[port.axis]}</td>
                </tr>
                <tr>
                  <td>Gap ends</td>
                  <td className="muted">
                    {pe.geometry.start.map((c) => (c * scale).toFixed(3)).join(', ')} → {pe.geometry.end.map((c) => (c * scale).toFixed(3)).join(', ')}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {errors.map((d, i) => (
            <p key={i} className={d.severity === 'error' ? 'error small' : 'warn small'} data-testid="feed-issue">
              {d.message} {d.fix && <span className="muted">{d.fix}</span>}
            </p>
          ))}
        </>
      )}
      <details className="small">
        <summary>Source model and conventions</summary>
        <ul className="notes">
          <li>Resistive voltage source (Thevenin EMF V<sub>s</sub>, internal resistance R<sub>s</sub> = Z₀) on the Yee edges spanning the gap; the source impedance is included in the simulation.</li>
          <li>V = φ<sub>signal</sub> − φ<sub>reference</sub>, the line integral of −E across the gap; positive current flows from the source into the signal terminal (∮H·dl around the gap edge).</li>
          <li>Z<sub>in</sub> = V/I and S11 = (Z<sub>in</sub> − Z₀)/(Z<sub>in</sub> + Z₀) for real Z₀, with the reference plane at the gap; there is no de-embedding.</li>
          <li>The discretized port edges are shown on the Validate step.</li>
        </ul>
      </details>
    </section>
  );
}

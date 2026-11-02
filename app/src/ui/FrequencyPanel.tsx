import { useState } from 'react';
import { estimatedCellMm, maxAssignedEpsR } from '../model/classify';
import { lossFitFrequency, lossValidity, materialSigma, validateMaterial } from '../model/materials';
import { useProject } from '../model/store';
import type { Material, MaterialLoss } from '../model/types';

const GHz = 1e9;

function GhzField({ label, value, onChange, testId }: { label: string; value: number; onChange: (hz: number) => void; testId?: string }) {
  return (
    <label className="field">
      {label}
      <span className="row tight">
        <input type="number" step={0.01} min={0} value={Number((value / GHz).toPrecision(8))} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber * GHz)} data-testid={testId} />
        <span className="muted">GHz</span>
      </span>
    </label>
  );
}

export function FrequencyPanel() {
  const freq = useProject((s) => s.freq);
  const setFreq = useProject((s) => s.setFreq);
  const assignments = useProject((s) => s.assignments);
  const materials = useProject((s) => s.materials);
  const [ffText, setFfText] = useState(freq.farField.map((f) => f / GHz).join(', '));
  const [ffError, setFfError] = useState<string | null>(null);
  const cell = estimatedCellMm(freq, maxAssignedEpsR(assignments, materials));

  function applyFarField(text: string) {
    setFfText(text);
    const vals = text.split(/[,\s]+/).filter(Boolean).map(Number);
    if (vals.some((v) => !Number.isFinite(v))) return setFfError('Enter numbers in GHz separated by commas.');
    if (vals.length > 5) return setFfError('At most 5 far-field frequencies (each adds memory for the near-field accumulators).');
    const hz = vals.map((v) => v * GHz);
    if (hz.some((f) => f < freq.fMin || f > freq.fMax)) return setFfError('Far-field frequencies must lie inside the band.');
    setFfError(null);
    setFreq({ ...freq, farField: hz });
  }

  return (
    <>
      <section className="card" data-testid="frequency-panel">
        <h3>Frequency</h3>
        <div className="grid2">
          <GhzField label="f min" value={freq.fMin} onChange={(fMin) => setFreq({ ...freq, fMin })} testId="fmin" />
          <GhzField label="f max" value={freq.fMax} onChange={(fMax) => setFreq({ ...freq, fMax })} testId="fmax" />
        </div>
        <label className="field">
          Far-field frequencies
          <span className="row tight">
            <input value={ffText} onChange={(e) => applyFarField(e.target.value)} data-testid="farfield" />
            <span className="muted">GHz</span>
          </span>
        </label>
        {ffError && <p className="error small">{ffError}</p>}
        <label className="field">
          Cells per wavelength (at f max, in the densest dielectric)
          <input
            type="number"
            min={10}
            max={60}
            step={1}
            value={freq.cellsPerWavelength}
            onChange={(e) => e.target.valueAsNumber >= 10 && setFreq({ ...freq, cellsPerWavelength: Math.round(e.target.valueAsNumber) })}
          />
        </label>
        <p className="small">
          Estimated cell size <b data-testid="est-cell">~{cell.toFixed(3)} mm</b>. The mesher (Mesh step) refines locally around
          features, sheets and the feed; this estimate only drives the preview checks.
        </p>
        <p className="muted small">
          Excitation: a Gaussian-modulated sinusoid centred in the band, about −20 dB at the band edges. One run gives
          S11 across the whole band.
        </p>
      </section>
      <MaterialsCard materials={materials} fMin={freq.fMin} fMax={freq.fMax} used={usedMaterialIds(assignments)} />
    </>
  );
}

function usedMaterialIds(assignments: Record<string, { role: string; materialId?: string }>): Set<string> {
  return new Set(Object.values(assignments).filter((a) => a.role === 'dielectric' && a.materialId).map((a) => a.materialId!));
}

function lossText(m: Material) {
  switch (m.loss.kind) {
    case 'none':
      return 'lossless';
    case 'conductivity':
      return `σ = ${m.loss.sigma.toPrecision(3)} S/m`;
    case 'tanDelta':
      return `tanδ = ${m.loss.tanDelta} (specified at ${(m.loss.fRef / GHz).toPrecision(4)} GHz)`;
  }
}

function MaterialsCard({ materials, fMin, fMax, used }: { materials: Material[]; fMin: number; fMax: number; used: Set<string> }) {
  const fFit = lossFitFrequency(fMin, fMax);
  const upsert = useProject((s) => s.upsertMaterial);
  const [draft, setDraft] = useState({ name: '', epsR: 2.2, kind: 'tanDelta' as MaterialLoss['kind'], tanDelta: 0.001, fRef: (fMin + fMax) / 2, sigma: 0 });
  const [error, setError] = useState<string | null>(null);

  function add() {
    const loss: MaterialLoss =
      draft.kind === 'none' ? { kind: 'none' } : draft.kind === 'conductivity' ? { kind: 'conductivity', sigma: draft.sigma } : { kind: 'tanDelta', tanDelta: draft.tanDelta, fRef: draft.fRef };
    const m: Material = { id: `custom-${Date.now().toString(36)}`, name: draft.name.trim() || `Custom εr ${draft.epsR}`, epsR: draft.epsR, loss };
    const err = validateMaterial(m);
    if (err) return setError(err);
    setError(null);
    upsert(m);
  }

  return (
    <section className="card" data-testid="materials">
      <h3>Dielectric materials</h3>
      <ul className="materials">
        {materials.map((m) => {
          const v = lossValidity(m, fMin, fMax);
          const inUse = used.has(m.id);
          return (
            <li key={m.id} className={inUse ? 'in-use' : undefined}>
              <b>{m.name}</b>
              {inUse && <span className="badge">in use</span>}
              <span className="muted">
                {' '}
                εr {m.epsR}, {lossText(m)}
                {m.loss.kind !== 'none' && `, σ_sim = ${materialSigma(m, fFit).toPrecision(3)} S/m`}
              </span>
              {v && (
                <span className={v.ok || !inUse ? 'muted small block' : 'warn small block'}>
                  Effective tanδ {v.atMin.toExponential(2)} at f min … {v.atMax.toExponential(2)} at f max
                  {!v.ok && ` (up to ${(100 * v.maxDeviation).toFixed(0)}% off at the band edges)`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <details>
        <summary>How loss is modelled</summary>
        <p className="small">
          The time-domain solver represents dielectric loss as a constant conductivity σ, which makes the loss tangent fall as
          1/f across the band: tanδ(f) = σ / (2π f ε₀ εr). The entered tanδ is assumed to hold in the simulated band (laminate
          loss tangents are roughly constant over a decade), and σ is fitted at the band centre, √(f_min·f_max) ={' '}
          {(fFit / GHz).toPrecision(4)} GHz, so it is exact there and drifts toward the band edges. A warning appears for
          materials in use when the drift exceeds 25%. Magnetic materials and dispersive (Debye/Lorentz) models are not
          implemented.
        </p>
      </details>
      <h4>Add material</h4>
      <div className="grid2">
        <label className="field">
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          εr
          <input type="number" step={0.01} min={1} value={draft.epsR} onChange={(e) => setDraft({ ...draft, epsR: e.target.valueAsNumber })} />
        </label>
        <label className="field">
          Loss
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as MaterialLoss['kind'] })}>
            <option value="none">Lossless</option>
            <option value="tanDelta">tanδ at f_ref</option>
            <option value="conductivity">Conductivity σ</option>
          </select>
        </label>
        {draft.kind === 'tanDelta' && (
          <>
            <label className="field">
              tanδ
              <input type="number" step={0.0001} min={0} value={draft.tanDelta} onChange={(e) => setDraft({ ...draft, tanDelta: e.target.valueAsNumber })} />
            </label>
            <GhzField label="specified at" value={draft.fRef} onChange={(fRef) => setDraft({ ...draft, fRef })} />
          </>
        )}
        {draft.kind === 'conductivity' && (
          <label className="field">
            σ (S/m)
            <input type="number" step={0.001} min={0} value={draft.sigma} onChange={(e) => setDraft({ ...draft, sigma: e.target.valueAsNumber })} />
          </label>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      <button type="button" onClick={add}>
        Add material
      </button>
    </section>
  );
}

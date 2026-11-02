// Results step: controls and run history (right panel) and the dashboard
// (bottom panel): port plots, polar cuts, peak quantities with availability,
// and exports. Display settings only change what is drawn; exports always
// carry the solver's raw numbers (sim/exportCsv.ts).
import { useMemo, useRef, useState } from 'react';
import { useProject } from '../model/store';
import { csvExports } from '../sim/exportCsv';
import {
  azimuthCut,
  colormap,
  dominantLudwigRef,
  elevationCut,
  frontToBack,
  hpbw,
  patternOf,
  patternValues,
  QUANTITY_LABEL,
  unitLabel,
  type Cut,
  type Ludwig3Ref,
  type Polarization,
  type Quantity,
} from '../sim/pattern';
import { farFieldAvail, portSampleCaveats, type Avail } from '../sim/reliability';
import { matchedBand, minS11, seriesResonance, type FarFieldJson, type ResultsJson } from '../sim/results';
import { inputKey, resultIsCurrent, selectedResult, useSim, type ResultView, type SimResult } from '../sim/simStore';
import { LinePlot } from './plots/LinePlot';
import { PolarPlot, type PolarSeries } from './plots/PolarPlot';
import { download, safeName, svgToPngBlob, svgToString } from './plots/exportImage';

const GHz = (f: number) => `${(f / 1e9).toFixed(4)} GHz`;
const dbi = (v: number) => `${v.toFixed(2)} dBi`;

export function AvailText<T>({ a, fmt, testId }: { a: Avail<T>; fmt: (v: T) => string; testId?: string }) {
  if (a.state === 'unavailable')
    return (
      <span className="unavail" data-testid={testId} data-state="unavailable">
        — <span className="muted small">({a.reason})</span>
      </span>
    );
  return (
    <span className={a.state === 'unreliable' ? 'warn' : undefined} title={a.state === 'unreliable' ? `Unreliable: ${a.reason}` : undefined} data-testid={testId} data-state={a.state}>
      {fmt(a.value)}
      {a.state === 'unreliable' && <span className="small"> ⚠ unreliable: {a.reason}</span>}
    </span>
  );
}

const POL_LABEL: Record<Polarization, string> = { total: 'Total', theta: 'E_θ', phi: 'E_φ', co: 'Co-pol (Ludwig-3)', cross: 'Cross-pol (Ludwig-3)' };

/** Everything derived from the selected result and view, memoized for the panels and the viewport. */
export function useResultData() {
  const sim = useSim();
  const revision = useProject((s) => s.revision);
  const key = inputKey(revision, sim.settingsVersion);
  const result = selectedResult(sim);
  const view = sim.view;
  return useMemo(() => {
    if (!result) return null;
    const r = result.results;
    const ffIndex = Math.min(view.freqIndex, Math.max(r.farField.length - 1, 0));
    const ff: FarFieldJson | undefined = r.farField[ffIndex];
    const avail = ff ? farFieldAvail(r, ff, result.lossless) : null;
    const pattern = ff ? patternOf(ff) : null;
    let factor: Avail<number> = { state: 'ok', value: 1 };
    if (avail && ff) {
      if (view.quantity === 'gain') factor = avail.gainFactor;
      else if (view.quantity === 'realizedGain') factor = avail.realizedFactor;
      else if (view.quantity === 'normalized') factor = { state: 'ok', value: 1 / ff.directivity };
    }
    const ref: Ludwig3Ref = view.ludwigRef !== 'auto' ? view.ludwigRef : pattern && ff ? dominantLudwigRef(pattern, ff.beamThetaDeg, ff.beamPhiDeg) : 'y';
    const pols: Polarization[] = view.polarization === 'total' ? ['total'] : view.polarization === 'theta' || view.polarization === 'phi' ? ['theta', 'phi'] : ['co', 'cross'];
    const values = pattern && factor.state !== 'unavailable' ? patternValues(pattern, factor.value, view.polarization, ref) : null;
    const seriesValues = pattern && factor.state !== 'unavailable' ? pols.map((p) => ({ pol: p, values: p === view.polarization && values ? values : patternValues(pattern, factor.value, p, ref) })) : [];
    const total = pattern ? patternValues(pattern, 1, 'total') : null;
    const elev = pattern ? seriesValues.map((s) => ({ pol: s.pol, cut: elevationCut(pattern, s.values, view.elevationPhi) })) : [];
    const azim = pattern ? seriesValues.map((s) => ({ pol: s.pol, cut: azimuthCut(pattern, s.values, view.azimuthTheta) })) : [];
    const sel = (cuts: { pol: Polarization; cut: Cut }[]) => cuts.find((c) => c.pol === view.polarization)?.cut ?? null;
    const elevSel = sel(elev), azimSel = sel(azim);
    return {
      result,
      results: r,
      current: resultIsCurrent(result, sim.validation, key),
      ffIndex,
      ff,
      avail,
      pattern,
      factor,
      values,
      ludwigRef: ref,
      elev,
      azim,
      hpbwElev: elevSel ? hpbw(elevSel) : null,
      hpbwAzim: azimSel ? hpbw(azimSel) : null,
      elevPhiUsed: elevSel?.fixedDeg ?? view.elevationPhi,
      azimThetaUsed: azimSel?.fixedDeg ?? view.azimuthTheta,
      frontToBack: pattern && total && ff ? frontToBack(pattern, total, ff.beamThetaDeg, ff.beamPhiDeg) : null,
    };
  }, [result, view, sim.validation, key]);
}

export type ResultData = NonNullable<ReturnType<typeof useResultData>>;

// ---------------------------------------------------------------- right panel

export function ResultsPanel() {
  const sim = useSim();
  const data = useResultData();
  const v = sim.view;
  const set = sim.setView;
  if (!data)
    return (
      <section className="card" data-testid="results-panel">
        <h3>Results</h3>
        <p className="muted small">No results yet. Run a simulation on the Simulate step, or open a project saved with results.</p>
      </section>
    );
  const r = data.results;
  const stem = safeName(data.result.label);
  return (
    <>
      <section className="card" data-testid="results-panel">
        <h3>Display</h3>
        <label className="field">
          Far-field frequency
          <select value={data.ffIndex} onChange={(e) => set({ freqIndex: Number(e.target.value) })} data-testid="result-freq" disabled={!r.farField.length}>
            {r.farField.map((f, i) => (
              <option key={f.frequency} value={i}>
                {GHz(f.frequency)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            Quantity
            <select value={v.quantity} onChange={(e) => set({ quantity: e.target.value as Quantity })} data-testid="result-quantity">
              {(Object.keys(QUANTITY_LABEL) as Quantity[]).map((q) => (
                <option key={q} value={q}>
                  {QUANTITY_LABEL[q]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Polarization
            <select value={v.polarization} onChange={(e) => set({ polarization: e.target.value as Polarization })} data-testid="result-pol">
              {(Object.keys(POL_LABEL) as Polarization[]).map((p) => (
                <option key={p} value={p}>
                  {POL_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          {(v.polarization === 'co' || v.polarization === 'cross') && (
            <label className="field">
              Ludwig-3 reference
              <select value={v.ludwigRef} onChange={(e) => set({ ludwigRef: e.target.value as Ludwig3Ref | 'auto' })} data-testid="ludwig-ref">
                <option value="auto">auto ({data.ludwigRef}-polarized at the beam)</option>
                <option value="y">y-polarized</option>
                <option value="x">x-polarized</option>
              </select>
            </label>
          )}
          <label className="field">
            Scale
            <select value={v.db ? 'db' : 'lin'} onChange={(e) => set({ db: e.target.value === 'db' })} data-testid="result-scale">
              <option value="db">dB</option>
              <option value="lin">linear</option>
            </select>
          </label>
          {v.db && (
            <label className="field">
              Display range (dB)
              <input type="number" min={10} max={80} step={5} value={v.rangeDb} onChange={(e) => e.target.valueAsNumber >= 10 && e.target.valueAsNumber <= 80 && set({ rangeDb: e.target.valueAsNumber })} data-testid="result-range" />
            </label>
          )}
          <label className="field">
            Elevation cut φ (°)
            <input type="number" min={0} max={358} step={2} value={v.elevationPhi} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ elevationPhi: e.target.valueAsNumber })} data-testid="cut-phi" />
          </label>
          <label className="field">
            Azimuth cut θ (°)
            <input type="number" min={0} max={180} step={2} value={v.azimuthTheta} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ azimuthTheta: e.target.valueAsNumber })} data-testid="cut-theta" />
          </label>
        </div>
        <div className="row small">
          {data.ff && (
            <button type="button" onClick={() => set({ elevationPhi: data.ff!.beamPhiDeg, azimuthTheta: data.ff!.beamThetaDeg })}>
              Cuts through the beam
            </button>
          )}
          <label className="check">
            <input type="checkbox" checked={v.show3d} onChange={(e) => set({ show3d: e.target.checked })} data-testid="show-3d" /> 3D pattern
          </label>
        </div>
        {v.show3d && data.pattern && (
          <div className="small muted">
            <div className="colorbar" style={{ background: colorbarCss() }} />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{v.db ? `peak − ${v.rangeDb} dB` : '0'}</span>
              <span>peak</span>
            </div>
          </div>
        )}
        <p className="small muted">
          The display range clips plots and the 3D surface only; exported files always contain the full solver data. θ is measured from +z, φ from +x
          toward +y. Ludwig-3 (boresight +z): with a y reference, co = E_θ sin φ + E_φ cos φ and cross = E_θ cos φ − E_φ sin φ; an x reference swaps
          them. Normalized patterns are relative to the peak of the total pattern.
        </p>
      </section>
      <section className="card">
        <h3>Export</h3>
        <div className="row">
          {csvExports(r, stem, v).map((f) => (
            <button key={f.fileName} type="button" onClick={() => download(f.content, f.fileName, 'text/csv')} data-testid={`export-${f.fileName.replace(stem + '_', '').split(/[._]/)[0]}`}>
              {f.fileName.replace(stem + '_', '')}
            </button>
          ))}
        </div>
        <p className="small muted">Raw solver values (exact doubles), units and conventions in the header lines. Plot images: SVG/PNG buttons on each plot.</p>
      </section>
      <History />
    </>
  );
}

function colorbarCss() {
  const toHex = (c: number) => {
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(s, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  const stops = Array.from({ length: 6 }, (_, i) => {
    const [r, g, b] = colormap(i / 5);
    return `#${toHex(r)}${toHex(g)}${toHex(b)} ${i * 20}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function History() {
  const sim = useSim();
  const revision = useProject((s) => s.revision);
  const key = inputKey(revision, sim.settingsVersion);
  const sel = selectedResult(sim);
  if (!sim.history.length) return null;
  return (
    <section className="card" data-testid="run-history">
      <h3>Run history</h3>
      <ul className="history">
        {sim.history.map((h: SimResult) => {
          const current = resultIsCurrent(h, sim.validation, key);
          return (
            <li key={h.id} className={h.id === sel?.id ? 'on' : undefined}>
              <button type="button" className="link" onClick={() => sim.selectResult(h.id)} data-testid="history-item">
                {h.label}
              </button>
              <span className={`badge${current ? '' : ' warn'}`}>{current ? 'current' : h.source === 'file' ? 'from file — validate to compare' : 'stale'}</span>
              <span className="muted small">
                {' '}
                {h.results.run.steps.toLocaleString()} steps{h.results.run.terminatedBy === 'energy' ? '' : ' (capped)'}
              </span>
              <button type="button" className="link" onClick={() => sim.removeResult(h.id)} title="Remove from history" aria-label="Remove from history">
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <p className="small muted">The last {8} runs are kept in this session; saving the project stores them too.</p>
    </section>
  );
}

// ---------------------------------------------------------------- dashboard

export function ResultsDashboard() {
  const data = useResultData();
  const view = useSim((s) => s.view);
  if (!data) return <p className="muted placeholder">Results appear here after a simulation.</p>;
  return (
    <div className="dashboard" data-testid="results-dashboard">
      {!data.current && (
        <p className="warn small banner-inline" data-testid="results-stale">
          {data.result.source === 'file'
            ? 'These results come from the project file. Validate the project to check that they match the current inputs.'
            : 'Stale: the inputs changed after this run. Run again for current results.'}
        </p>
      )}
      <div className="dash-grid">
        <SummaryCard data={data} view={view} />
        <PortCard data={data} view={view} />
        <PatternCard data={data} view={view} kind="elevation" />
        <PatternCard data={data} view={view} kind="azimuth" />
      </div>
    </div>
  );
}

function PlotExport({ svg, name }: { svg: React.RefObject<SVGSVGElement | null>; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="plot-export">
      <button type="button" className="link" onClick={() => svg.current && download(svgToString(svg.current), `${name}.svg`, 'image/svg+xml')} data-testid={`svg-${name.split('_').pop()}`}>
        SVG
      </button>
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={async () => {
          if (!svg.current) return;
          setBusy(true);
          try {
            download(await svgToPngBlob(svg.current), `${name}.png`);
          } finally {
            setBusy(false);
          }
        }}
        data-testid={`png-${name.split('_').pop()}`}
      >
        PNG
      </button>
    </span>
  );
}

/** Contiguous runs of flagged samples as frequency spans, padded by half a sample step on each side. */
function spans(flags: string[], f: number[]): [number, number][] {
  const out: [number, number][] = [];
  const mid = (i: number) => (i <= 0 ? f[0] : i >= f.length ? f[f.length - 1] : 0.5 * (f[i - 1] + f[i]));
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    out.push([mid(i), mid(j + 1)]);
    i = j;
  }
  return out;
}

function PortCard({ data, view }: { data: ResultData; view: ResultView }) {
  const set = useSim((s) => s.setView);
  const ref = useRef<SVGSVGElement>(null);
  const p = data.results.port;
  const stem = safeName(data.result.label);
  if (!p)
    return (
      <section className="card">
        <h3>Port</h3>
        <p className="unavail small">— (the problem has no port)</p>
      </section>
    );
  const f = p.frequencies;
  const mag = f.map((_, i) => Math.hypot(p.s11Re[i], p.s11Im[i]));
  const markers = data.results.farField.map((x, i) => ({ x: x.frequency, active: i === data.ffIndex }));
  const shaded = spans(portSampleCaveats(data.results, p), f);
  const s11db = mag.map((m) => 20 * Math.log10(m));
  return (
    <section className="card" data-testid="port-card">
      <h3 className="row tight">
        <span className="seg" role="group">
          {(['s11', 'vswr', 'zin'] as const).map((k) => (
            <button key={k} type="button" className={view.portPlot === k ? 'on' : ''} onClick={() => set({ portPlot: k })} data-testid={`port-plot-${k}`}>
              {k === 's11' ? '|S11|' : k === 'vswr' ? 'VSWR' : 'Z_in'}
            </button>
          ))}
        </span>
        <PlotExport svg={ref} name={`${stem}_${view.portPlot}`} />
      </h3>
      {view.portPlot === 's11' && (
        <LinePlot ref={ref} series={[{ label: '|S11|', x: f, y: s11db, cls: 'trace' }]} xLabel="frequency (GHz)" yLabel={`|S11| (dB, Z₀ = ${p.z0} Ω)`} xScale={1e9} yMax={0} yMin={Math.min(-30, Math.floor(Math.min(...s11db) / 10) * 10)} markers={markers} hlines={[{ y: -10, label: '−10 dB' }]} shaded={shaded} testId="plot-s11" />
      )}
      {view.portPlot === 'vswr' && (
        <LinePlot ref={ref} series={[{ label: 'VSWR', x: f, y: mag.map((m) => (m < 1 ? (1 + m) / (1 - m) : NaN)), cls: 'trace' }]} xLabel="frequency (GHz)" yLabel="VSWR" xScale={1e9} yMin={1} yMax={10} markers={markers} hlines={[{ y: 2, label: 'VSWR 2' }]} shaded={shaded} testId="plot-vswr" />
      )}
      {view.portPlot === 'zin' && (
        <LinePlot
          ref={ref}
          series={[
            { label: 'R', x: f, y: p.zinRe, cls: 'trace' },
            { label: 'X', x: f, y: p.zinIm, cls: 'trace2' },
          ]}
          xLabel="frequency (GHz)"
          yLabel="Z_in (Ω)"
          xScale={1e9}
          markers={markers}
          hlines={[{ y: p.z0, label: `Z₀ = ${p.z0} Ω` }]}
          shaded={shaded}
          testId="plot-zin"
        />
      )}
      <p className="small muted">Dashed lines: far-field frequencies (bold: selected). Shaded: unreliable samples (weak excitation, capped run or |S11| &gt; 1). Hover for values.</p>
    </section>
  );
}

function PatternCard({ data, view, kind }: { data: ResultData; view: ResultView; kind: 'elevation' | 'azimuth' }) {
  const ref = useRef<SVGSVGElement>(null);
  const stem = safeName(data.result.label);
  const title = kind === 'elevation' ? `Elevation cut, φ = ${data.elevPhiUsed.toFixed(0)}° / ${((data.elevPhiUsed + 180) % 360).toFixed(0)}°` : `Azimuth cut, θ = ${data.azimThetaUsed.toFixed(0)}°`;
  let body: React.ReactNode;
  if (!data.ff) body = <p className="unavail small">— (no far-field frequencies were requested)</p>;
  else if (!data.pattern) body = <p className="unavail small">— (the results carry no pattern data)</p>;
  else if (data.factor.state === 'unavailable')
    body = (
      <p className="unavail small" data-testid="pattern-unavailable">
        — {QUANTITY_LABEL[view.quantity]} unavailable ({data.factor.reason})
      </p>
    );
  else {
    const cuts = kind === 'elevation' ? data.elev : data.azim;
    const series: PolarSeries[] = cuts.map((c, i) => ({ label: c.pol === 'total' ? 'total' : POL_LABEL[c.pol].replace(' (Ludwig-3)', ''), cut: c.cut, cls: i === 0 ? 'trace' : 'trace2' }));
    const w = kind === 'elevation' ? data.hpbwElev : data.hpbwAzim;
    body = (
      <>
        <PolarPlot ref={ref} series={series} db={view.db} rangeDb={view.rangeDb} unit={unitLabel(view.quantity, view.db)} title={`${QUANTITY_LABEL[view.quantity]} · ${GHz(data.ff.frequency)}`} testId={`polar-${kind}`} />
        <p className="small" data-testid={`hpbw-${kind}`}>
          HPBW ({POL_LABEL[view.polarization]}): {w === null ? <span className="muted">— (no −3 dB points in this cut)</span> : `${w.toFixed(1)}°`}
          {kind === 'elevation' && <span className="muted"> · right half φ = {data.elevPhiUsed.toFixed(0)}°, θ = 0 at top</span>}
          {kind === 'azimuth' && <span className="muted"> · φ = 0 (+x) at right, counter-clockwise</span>}
        </p>
        {data.factor.state === 'unreliable' && <p className="warn small">⚠ unreliable: {data.factor.reason}</p>}
      </>
    );
  }
  return (
    <section className="card" data-testid={`${kind}-card`}>
      <h3 className="row tight">
        <span>{title}</span>
        {data.pattern && data.factor.state !== 'unavailable' && <PlotExport svg={ref} name={`${stem}_${kind}`} />}
      </h3>
      {body}
    </section>
  );
}

function SummaryCard({ data, view }: { data: ResultData; view: ResultView }) {
  const r: ResultsJson = data.results;
  const p = r.port;
  const best = p ? minS11(p) : null;
  const res = p ? seriesResonance(p) : null;
  const band = p ? matchedBand(p, -10) : null;
  const a = data.avail;
  const ff = data.ff;
  const pct = (v: number) => `${(100 * v).toFixed(1)} %`;
  const watt = (v: number) => `${v.toExponential(3)} W`;
  return (
    <section className="card summary" data-testid="results-summary">
      <h3>Summary {ff && <span className="muted">· {GHz(ff.frequency)}</span>}</h3>
      <table className="kv small">
        <tbody>
          {p && best && (
            <tr>
              <td>|S11| minimum</td>
              <td data-testid="sum-s11min">
                {best.db.toFixed(2)} dB at {GHz(best.f)}
              </td>
            </tr>
          )}
          {p && (
            <tr>
              <td>−10 dB band</td>
              <td data-testid="sum-band">
                {band ? `${band.openLo ? '≤ ' : ''}${GHz(band.fLo)} … ${band.openHi ? '≥ ' : ''}${GHz(band.fHi)} (${(100 * (band.fHi - band.fLo) / (0.5 * (band.fHi + band.fLo))).toFixed(1)} %)` : <span className="unavail">— (|S11| never below −10 dB)</span>}
              </td>
            </tr>
          )}
          {res && (
            <tr>
              <td>Series resonance</td>
              <td>
                {GHz(res.f)}, R = {res.r.toFixed(2)} Ω
              </td>
            </tr>
          )}
          {ff && a ? (
            <>
              <tr>
                <td>Directivity</td>
                <td>
                  <AvailText a={a.directivityDbi} fmt={dbi} testId="sum-d" />
                </td>
              </tr>
              <tr>
                <td>Gain</td>
                <td>
                  <AvailText a={a.gainDbi} fmt={dbi} testId="sum-g" />
                </td>
              </tr>
              <tr>
                <td>Realized gain</td>
                <td>
                  <AvailText a={a.realizedGainDbi} fmt={dbi} testId="sum-gr" />
                </td>
              </tr>
              <tr>
                <td>Radiation efficiency</td>
                <td>
                  <AvailText a={a.efficiency} fmt={pct} testId="sum-eff" />
                </td>
              </tr>
              <tr>
                <td>P_rad (far field / Poynting box)</td>
                <td>
                  <AvailText a={a.pRad} fmt={watt} /> / <AvailText a={a.pRadPoynting} fmt={watt} />
                </td>
              </tr>
              <tr>
                <td>P_accepted / P_incident</td>
                <td>
                  <AvailText a={a.pAcc} fmt={watt} /> / <AvailText a={a.pInc} fmt={watt} />
                </td>
              </tr>
              <tr>
                <td>|S11| / Z_in here</td>
                <td>
                  <AvailText a={a.s11Db} fmt={(v) => `${v.toFixed(2)} dB`} />
                  {ff.zinRe !== undefined && ff.zinIm !== undefined && ` / ${ff.zinRe.toFixed(2)} ${ff.zinIm < 0 ? '−' : '+'} j${Math.abs(ff.zinIm).toFixed(2)} Ω`}
                </td>
              </tr>
              <tr>
                <td>Main beam</td>
                <td>
                  θ {ff.beamThetaDeg.toFixed(0)}°, φ {ff.beamPhiDeg.toFixed(0)}° · F/B {data.frontToBack === null || !Number.isFinite(data.frontToBack) ? '—' : `${data.frontToBack.toFixed(1)} dB`}
                </td>
              </tr>
              <tr>
                <td>HPBW (elev. φ {data.elevPhiUsed.toFixed(0)}° / azim. θ {data.azimThetaUsed.toFixed(0)}°)</td>
                <td>
                  {data.hpbwElev === null ? '—' : `${data.hpbwElev.toFixed(1)}°`} / {data.hpbwAzim === null ? '— (omnidirectional)' : `${data.hpbwAzim.toFixed(1)}°`}
                </td>
              </tr>
            </>
          ) : (
            <tr>
              <td>Far field</td>
              <td className="unavail">— (no far-field frequencies were requested)</td>
            </tr>
          )}
          <tr>
            <td>Run</td>
            <td>
              {r.run.steps.toLocaleString()} steps ({r.run.terminatedBy}, {r.run.finalEnergyDb.toFixed(1)} dB), {r.run.seconds.toFixed(1)} s,{' '}
              {r.run.backend === 'webgpu' ? 'WebGPU' : `${r.run.threads} CPU thread${r.run.threads === 1 ? '' : 's'}`}
            </td>
          </tr>
        </tbody>
      </table>
      {r.farField.length > 1 && <FrequencyTable data={data} view={view} />}
      <p className="small muted">
        PEC conductors (no metal loss). Efficiency = P_rad / P_accepted includes dielectric loss. Realized gain assumes a matched {p?.z0 ?? 50} Ω source at the
        port gap.
      </p>
    </section>
  );
}

function FrequencyTable({ data }: { data: ResultData; view: ResultView }) {
  const set = useSim((s) => s.setView);
  return (
    <table className="kv small freq-table" data-testid="freq-table">
      <thead>
        <tr>
          <td>f</td>
          <td>D</td>
          <td>G</td>
          <td>G_r</td>
          <td>η</td>
        </tr>
      </thead>
      <tbody>
        {data.results.farField.map((f, i) => {
          const a = farFieldAvail(data.results, f, data.result.lossless);
          const cell = (x: Avail<number>, fmt: (v: number) => string) => (x.state === 'unavailable' ? <span title={x.reason}>—</span> : <span className={x.state === 'unreliable' ? 'warn' : undefined} title={x.state === 'unreliable' ? x.reason : undefined}>{fmt(x.value)}{x.state === 'unreliable' ? ' ⚠' : ''}</span>);
          return (
            <tr key={f.frequency} className={i === data.ffIndex ? 'on' : undefined} onClick={() => set({ freqIndex: i })}>
              <td>{(f.frequency / 1e9).toFixed(3)}</td>
              <td>{cell(a.directivityDbi, (v) => v.toFixed(2))}</td>
              <td>{cell(a.gainDbi, (v) => v.toFixed(2))}</td>
              <td>{cell(a.realizedGainDbi, (v) => v.toFixed(2))}</td>
              <td>{cell(a.efficiency, (v) => `${(100 * v).toFixed(1)}%`)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

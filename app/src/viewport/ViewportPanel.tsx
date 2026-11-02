import { useEffect, useMemo, useRef, useState } from 'react';
import { useDiagnostics } from '../ui/useDiagnostics';
import { unitScale } from '../model/diagnostics';
import { useProject, useUi } from '../model/store';
import { boxSize } from '../model/geometry';
import { ROLE_HEX, UNASSIGNED_HEX, roleOpacity, srgbHexToLinear } from './style';
import type { BodyStyle, PickHit, SimOverlay, Viewport } from './Viewport';
import { inputKey, useSim, type GridPlane } from '../sim/simStore';
import type { MeshResult } from '../sim/mesher';
import { patternMesh } from '../sim/pattern';
import { useResultData } from '../ui/ResultsView';

const forceWebGL = new URLSearchParams(location.search).has('webgl');

export function ViewportPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const [status, setStatus] = useState<{ kind: 'loading' | 'ready' | 'error' | 'lost'; message?: string }>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const [hover, setHover] = useState<PickHit | null>(null);

  const model = useProject((s) => s.model);
  const units = useProject((s) => s.units);
  const assignments = useProject((s) => s.assignments);
  const ui = useUi();
  const { result } = useDiagnostics();
  const scale = unitScale(units);

  // Create (or re-create after device loss) the renderer; three.js loads lazily here.
  // Each renderer gets its own canvas: a WebGL context lost by a disposed
  // renderer cannot be reused, and StrictMode mounts effects twice in development.
  useEffect(() => {
    let alive = true;
    let instance: Viewport | null = null;
    const canvas = document.createElement('canvas');
    canvas.dataset.testid = 'viewport-canvas';
    hostRef.current!.prepend(canvas);
    setStatus({ kind: 'loading' });
    (async () => {
      try {
        const { Viewport } = await import('./Viewport');
        instance = await Viewport.create(
          canvas,
          {
            onPick: (hit) => handlePick(hit),
            onHover: (hit) => setHover(hit),
            onDeviceLost: (message) => setStatus({ kind: 'lost', message }),
          },
          { forceWebGL },
        );
        if (!alive) return instance.dispose();
        setVp(instance);
        setStatus({ kind: 'ready' });
      } catch (e) {
        if (alive) setStatus({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      alive = false;
      instance?.dispose();
      canvas.remove();
      setVp(null);
    };
  }, [generation]);

  useEffect(() => {
    if (!vp) return;
    vp.setModel(model ? model.bodies : []);
  }, [vp, model]);

  useEffect(() => vp?.setScale(scale), [vp, scale, model]);

  const styles = useMemo(() => {
    const m = new Map<string, BodyStyle>();
    if (!model) return m;
    for (const b of model.bodies) {
      const role = assignments[b.id]?.role;
      const color = role ? srgbHexToLinear(ROLE_HEX[role]) : (b.color ?? srgbHexToLinear(UNASSIGNED_HEX));
      const visible = !ui.hidden.has(b.id) && (ui.isolated === null || ui.isolated === b.id);
      m.set(b.id, { color, opacity: roleOpacity(role, ui.xray), visible });
    }
    return m;
  }, [model, assignments, ui.hidden, ui.isolated, ui.xray]);

  useEffect(() => vp?.setStyles(styles), [vp, styles]);
  useEffect(
    () => vp?.setHighlight({ bodyId: ui.selection.bodyId, faceIndex: ui.selection.faceIndex, hoverBodyId: hover?.bodyId ?? null }),
    [vp, ui.selection, hover, styles],
  );
  useEffect(() => vp?.setClip(ui.clip), [vp, ui.clip, model]);

  const portGeom = result?.port?.geometry ?? null;
  useEffect(
    () => vp?.setFeed(portGeom ? { start: portGeom.start, end: portGeom.end } : null, {
      signal: ui.feedPicks.signal?.point,
      reference: ui.feedPicks.reference?.point,
    }),
    [vp, portGeom, ui.feedPicks, model],
  );

  // Simulation previews on the Mesh / Validate / Simulate steps.
  const sim = useSim();
  const revision = useProject((s) => s.revision);
  const key = inputKey(revision, sim.settingsVersion);
  const simStep = ui.step === 'mesh' || ui.step === 'validate' || ui.step === 'simulate';
  const meshPlan = sim.meshPlan?.key === key ? sim.meshPlan.plan : null;
  const validation = sim.validation?.key === key ? sim.validation : null;
  const simOverlay = useMemo<SimOverlay | null>(() => {
    if (!simStep || !meshPlan) return null;
    const m = meshPlan.mesh;
    const L = m.lines;
    const first = (a: number) => L[a][0], last = (a: number) => L[a][L[a].length - 1];
    const boxes: SimOverlay['boxes'] = [];
    if (sim.overlay.boxes) {
      boxes.push({ min: [first(0), first(1), first(2)], max: [last(0), last(1), last(2)], color: 0xff5c5c, opacity: 0.7 });
      boxes.push({ min: m.domain.min, max: m.domain.max, color: 0x8a97a6, opacity: 0.6 });
      boxes.push({ min: m.nf2ffBox.min, max: m.nf2ffBox.max, color: 0x3ddc84, opacity: 0.8 });
    }
    return {
      boxes,
      grid: gridPlane(m, sim.overlay.grid, meshPlan.feed.axis, meshPlan.feed.start),
      pec: sim.overlay.pec && validation ? validation.pecSegments : undefined,
      port: validation ? new Float32Array(validation.info.portSegments) : undefined,
    };
  }, [simStep, meshPlan, validation, sim.overlay]);
  useEffect(() => vp?.setSimOverlay(simOverlay), [vp, simOverlay]);

  // 3D radiation pattern on the Results step, sized to the model.
  const resultData = useResultData();
  const view = sim.view;
  const patternOverlay = useMemo(() => {
    if (ui.step !== 'results' || !view.show3d || !resultData?.pattern || !resultData.values || !model) return null;
    const diag = Math.hypot(...boxSize(model.bbox)) * scale;
    const m = patternMesh(resultData.pattern, resultData.values, { db: view.db, rangeDb: view.rangeDb, radius: 0.45 * diag });
    return { ...m, center: resultData.result.center };
  }, [ui.step, view.show3d, view.db, view.rangeDb, resultData, model, scale]);
  useEffect(() => vp?.setPattern(patternOverlay), [vp, patternOverlay]);

  const size = model ? boxSize(model.bbox).map((v) => v * scale) : null;

  return (
    <div className="viewport" data-testid="viewport" ref={hostRef}>
      <div className="vp-toolbar">
        <button type="button" onClick={() => vp?.fit()} disabled={!model} title="Fit model in view">
          Fit
        </button>
        <div className="seg" role="group" aria-label="Selection mode">
          {(['body', 'face'] as const).map((m) => (
            <button key={m} type="button" className={ui.selectMode === m ? 'on' : ''} onClick={() => ui.setSelectMode(m)}>
              {m === 'body' ? 'Bodies' : 'Faces'}
            </button>
          ))}
        </div>
        <button type="button" className={ui.xray ? 'on' : ''} onClick={() => ui.setXray(!ui.xray)} title="Make all bodies translucent">
          X-ray
        </button>
        <button type="button" className={ui.clip.enabled ? 'on' : ''} onClick={() => ui.setClip({ enabled: !ui.clip.enabled })} data-testid="clip-toggle">
          Clip
        </button>
        {ui.clip.enabled && (
          <>
            <select value={ui.clip.axis} onChange={(e) => ui.setClip({ axis: Number(e.target.value) as 0 | 1 | 2 })} aria-label="Clip axis">
              <option value={0}>x</option>
              <option value={1}>y</option>
              <option value={2}>z</option>
            </select>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={ui.clip.position}
              onChange={(e) => ui.setClip({ position: Number(e.target.value) })}
              aria-label="Clip position"
            />
            <button type="button" onClick={() => ui.setClip({ flip: !ui.clip.flip })} title="Keep the other side">
              Flip
            </button>
          </>
        )}
        {(ui.isolated || ui.hidden.size > 0) && (
          <button type="button" onClick={() => { ui.setIsolated(null); useUi.setState({ hidden: new Set() }); }}>
            Show all
          </button>
        )}
      </div>
      <div className="vp-status">
        {status.kind === 'ready' && vp && <span className="badge" data-testid="backend">{vp.backend === 'webgpu' ? 'WebGPU' : 'WebGL2 fallback'}</span>}
        {size && (
          <span className="badge" data-testid="dims">
            {size.map((v) => v.toFixed(2)).join(' × ')} mm
          </span>
        )}
      </div>
      {ui.pickMode !== 'select' && (
        <div className="vp-hint">
          Click the <b>{ui.pickMode === 'feed-signal' ? 'signal' : 'reference'}</b> terminal face.{' '}
          <button type="button" onClick={() => ui.setPickMode('select')}>Cancel</button>
        </div>
      )}
      {!model && status.kind === 'ready' && <div className="vp-empty">Open a STEP file (.step, .stp) to begin.</div>}
      {status.kind === 'loading' && <div className="vp-empty">Starting renderer…</div>}
      {status.kind === 'error' && <div className="vp-empty error">Renderer failed to start: {status.message}</div>}
      {status.kind === 'lost' && (
        <div className="vp-empty error">
          GPU device lost ({status.message}).{' '}
          <button type="button" onClick={() => setGeneration((g) => g + 1)}>Restart viewport</button>
        </div>
      )}
    </div>
  );
}

function handlePick(hit: PickHit | null) {
  const ui = useUi.getState();
  const model = useProject.getState().model;
  if (ui.pickMode === 'select') {
    if (!hit) return ui.select(null);
    return ui.select(hit.bodyId, ui.selectMode === 'face' ? hit.faceIndex : null);
  }
  if (!hit || !model) return;
  const body = model.bodies.find((b) => b.id === hit.bodyId);
  if (!body) return;
  const pick = { bodyId: hit.bodyId, faceIndex: hit.faceIndex, point: hit.point };
  if (ui.pickMode === 'feed-signal') {
    ui.setFeedPick('signal', pick);
    ui.setPickMode(ui.feedPicks.reference ? 'select' : 'feed-reference');
  } else {
    ui.setFeedPick('reference', pick);
    ui.setPickMode('select');
  }
}

/** Grid lines on one plane through the feed point, as segments (mm). */
function gridPlane(m: MeshResult, plane: GridPlane, feedAxis: number, at: [number, number, number]): Float32Array | undefined {
  if (plane === 'off') return undefined;
  const pair: Record<Exclude<GridPlane, 'auto' | 'off'>, [number, number]> = { xy: [0, 1], xz: [0, 2], yz: [1, 2] };
  const [u, v] = plane === 'auto' ? ([feedAxis, (feedAxis + 1) % 3].sort() as [number, number]) : pair[plane];
  const w = 3 - u - v;
  const L = m.lines;
  const out: number[] = [];
  const pt = (pu: number, pv: number) => {
    const p = [0, 0, 0];
    p[u] = pu;
    p[v] = pv;
    p[w] = at[w];
    out.push(...p);
  };
  const [u0, u1, v0, v1] = [L[u][0], L[u][L[u].length - 1], L[v][0], L[v][L[v].length - 1]];
  for (const x of L[u]) (pt(x, v0), pt(x, v1));
  for (const y of L[v]) (pt(u0, y), pt(u1, y));
  return new Float32Array(out);
}

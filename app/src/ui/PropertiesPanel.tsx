import { isConductor, type GeomClass } from '../model/classify';
import { unitScale } from '../model/diagnostics';
import { boxSize } from '../model/geometry';
import { useProject, useUi } from '../model/store';
import { lossFitFrequency } from '../model/materials';
import { METALS, metalPreset, skinDepth, surfaceResistance } from '../model/metals';
import type { Assignment, Role, SheetCurrent } from '../model/types';
import { ROLE_LABEL } from '../viewport/style';
import { useDiagnostics } from './useDiagnostics';

const ROLES: Role[] = ['radiator', 'ground', 'passiveConductor', 'dielectric', 'excluded'];

function describeClass(c: GeomClass | undefined) {
  if (!c) return '—';
  switch (c.type) {
    case 'solid':
      return `Solid, ${c.thicknessCells.toFixed(1)} cells thick${c.marginal ? ' (marginal)' : ''}`;
    case 'sheet':
      return `Sheet ⟂${'xyz'[c.axis]} (${c.zeroThickness ? 'zero thickness' : `${c.thickness.toFixed(3)} mm`})`;
    case 'wire':
      return `Thin wire along ${'xyz'[c.axis]}, Ø ${c.diameter.toFixed(3)} mm`;
    case 'slab':
      return `Thin layer ⟂${'xyz'[c.axis]} (${c.thickness.toFixed(3)} mm), refined by the mesher`;
    case 'unsupported':
      return `Unsupported: ${c.reason}`;
  }
}

const CUSTOM = 'custom';

/** Conductor material (PEC or a metal), and for metal sheets the faces carrying current. */
function ConductorFields({ bodyId, a, cls }: { bodyId: string; a: Assignment; cls: GeomClass | undefined }) {
  const freq = useProject((s) => s.freq);
  const { setConductor, setSheetCurrent } = useProject.getState();
  const c = a.conductor;
  const preset = metalPreset(c);
  const value = c?.kind === 'metal' ? (preset?.id ?? CUSTOM) : 'pec';
  const fFit = lossFitFrequency(freq.fMin, freq.fMax);
  const choose = (id: string) => {
    if (id === 'pec') return setConductor(bodyId, { kind: 'pec' });
    const m = METALS.find((x) => x.id === id);
    setConductor(bodyId, m ? { kind: 'metal', name: m.name, sigma: m.sigma } : { kind: 'metal', name: 'Custom metal', sigma: c?.kind === 'metal' ? c.sigma : 1e7 });
  };
  return (
    <>
      <label className="field">
        Conductor
        <select value={value} onChange={(e) => choose(e.target.value)} data-testid="conductor-select">
          <option value="pec">PEC (lossless)</option>
          {METALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} (σ {m.sigma.toExponential(2)} S/m)
            </option>
          ))}
          <option value={CUSTOM}>Custom conductivity…</option>
        </select>
      </label>
      {value === CUSTOM && c?.kind === 'metal' && (
        <label className="field">
          Conductivity (S/m)
          <input
            type="number"
            min={0}
            step="any"
            defaultValue={c.sigma}
            onChange={(e) => {
              const sigma = Number(e.target.value);
              if (sigma > 0) setConductor(bodyId, { kind: 'metal', name: 'Custom metal', sigma });
            }}
            data-testid="conductor-sigma"
          />
        </label>
      )}
      {c?.kind === 'metal' && cls?.type === 'sheet' && (
        <label className="field">
          Current flows on
          <select value={a.sheetCurrent ?? 'both'} onChange={(e) => setSheetCurrent(bodyId, e.target.value as SheetCurrent)} data-testid="sheet-current-select">
            <option value="both">Both faces (free-standing or printed strip, small ground)</option>
            <option value="one">One face (patch over a ground plane, microstrip)</option>
          </select>
        </label>
      )}
      {c?.kind === 'metal' ? (
        <p className="muted small" data-testid="conductor-info">
          Surface resistance {(1e3 * surfaceResistance(c.sigma, fFit)).toPrecision(3)} mΩ, skin depth {(1e6 * skinDepth(c.sigma, fFit)).toPrecision(3)} µm at{' '}
          {(fFit / 1e9).toFixed(3)} GHz (band centre). The loss is applied on the conductor's surface
          {cls?.type === 'wire' && `, using the wire's ${cls.round ? 'diameter' : 'perimeter-equivalent diameter'} of ${(2 * cls.lossRadius).toFixed(3)} mm`}
          {cls?.type === 'solid' && cls.roundWire && `, as a round wire of ${(2 * cls.roundWire.radius).toFixed(3)} mm diameter`}.
          {cls?.type === 'sheet' && ' The sheet is modelled with zero thickness, so the solver cannot tell which face carries the current: choose it above (one face gives twice the loss of both).'}
        </p>
      ) : (
        <p className="muted small">Modelled as a perfect electric conductor (PEC), with no loss. All conductors carry induced currents; the role guides the feed setup.</p>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const model = useProject((s) => s.model);
  const assignments = useProject((s) => s.assignments);
  const materials = useProject((s) => s.materials);
  const units = useProject((s) => s.units);
  const { assignRole, setMaterial, setPriority } = useProject.getState();
  const selection = useUi((s) => s.selection);
  const { result } = useDiagnostics();
  if (!model) return null;
  const body = model.bodies.find((b) => b.id === selection.bodyId);
  if (!body) return <p className="muted placeholder">Select a body in the tree or viewport to assign its role.</p>;
  const scale = unitScale(units);
  const a = assignments[body.id];
  const face = selection.faceIndex !== null ? body.faces[selection.faceIndex] : null;
  const size = boxSize(body.bbox).map((v) => v * scale);
  const t = body.topology;
  return (
    <section className="card" data-testid="properties">
      <h3>{body.name}</h3>
      {body.path.length > 0 && <p className="muted small">{body.path.join(' › ')}</p>}
      <label className="field">
        Role
        <select
          value={a?.role ?? ''}
          onChange={(e) => assignRole([body.id], (e.target.value || null) as Role | null)}
          data-testid="role-select"
        >
          <option value="">Unassigned</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {a && isConductor(a.role) && <ConductorFields bodyId={body.id} a={a} cls={result?.classes[body.id]} />}
      {a?.role === 'dielectric' && (
        <>
          <label className="field">
            Material
            <select value={a.materialId ?? ''} onChange={(e) => setMaterial(body.id, e.target.value)} data-testid="material-select">
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Overlap priority
            <input type="number" step={1} value={a.priority} onChange={(e) => setPriority(body.id, Math.round(Number(e.target.value)))} />
          </label>
          <p className="muted small">Where dielectrics overlap, the higher priority wins; conductors always override dielectrics.</p>
        </>
      )}
      <table className="kv small">
        <tbody>
          <tr>
            <td>Size</td>
            <td>{size.map((v) => v.toFixed(3)).join(' × ')} mm</td>
          </tr>
          <tr>
            <td>Topology</td>
            <td>
              {t.closed ? 'closed' : <span className="warn">open ({t.boundaryEdges} boundary edges)</span>}, {body.faces.length} faces
            </td>
          </tr>
          {t.volume !== null && (
            <tr>
              <td>Volume</td>
              <td>{(t.volume * scale ** 3).toPrecision(5)} mm³</td>
            </tr>
          )}
          <tr>
            <td>Grid class (est.)</td>
            <td data-testid="geom-class">{describeClass(result?.classes[body.id])}</td>
          </tr>
          {result && (
            <tr>
              <td>Estimated cell</td>
              <td>~{result.cellMm.toFixed(3)} mm</td>
            </tr>
          )}
        </tbody>
      </table>
      {face && (
        <div className="subcard" data-testid="face-props">
          <h4>Face {face.index + 1}</h4>
          <table className="kv small">
            <tbody>
              <tr>
                <td>Area</td>
                <td>{(face.area * scale * scale).toPrecision(5)} mm²</td>
              </tr>
              <tr>
                <td>Surface</td>
                <td>{face.planar ? (face.axisAligned !== null ? `planar, normal ±${'xyz'[face.axisAligned]}` : 'planar, oblique') : 'curved'}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">Face-level conductor assignment (planar axis-aligned faces as PEC sheets) is not implemented yet; assign whole bodies.</p>
        </div>
      )}
    </section>
  );
}

import { unitScale } from '../model/diagnostics';
import { boxSize } from '../model/geometry';
import { useProject } from '../model/store';
import { UNIT_LABEL, type LengthUnit } from '../model/types';

const UNITS: LengthUnit[] = ['um', 'mm', 'cm', 'm', 'mil', 'in', 'ft'];

export function UnitsPanel() {
  const model = useProject((s) => s.model);
  const units = useProject((s) => s.units);
  const setUnits = useProject((s) => s.setUnits);
  if (!model) return null;
  const declared = units.declared.unit;
  const effective = units.override ?? declared ?? 'mm';
  const size = boxSize(model.bbox).map((v) => v * unitScale(units));
  return (
    <section className="card" data-testid="units-panel">
      <h3>Units</h3>
      <table className="kv">
        <tbody>
          <tr>
            <td>Declared in file</td>
            <td data-testid="declared-unit">{declared ? UNIT_LABEL[declared] : <span className="warn">none / ambiguous</span>}</td>
          </tr>
          {units.declared.found.length > 0 && (
            <tr>
              <td>Unit entities</td>
              <td className="muted">{units.declared.found.join(', ')}</td>
            </tr>
          )}
          <tr>
            <td>Coordinates are in</td>
            <td>
              <select
                value={effective}
                onChange={(e) => {
                  const u = e.target.value as LengthUnit;
                  setUnits(u === (declared ?? 'mm') ? null : u, false);
                }}
                data-testid="unit-select"
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                    {u === declared ? ' (declared)' : ''}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <td>Model size</td>
            <td data-testid="model-size">{size.map((v) => v.toFixed(3)).join(' × ')} mm</td>
          </tr>
        </tbody>
      </table>
      {units.declared.note && <p className="muted small">{units.declared.note}</p>}
      {units.override && (
        <p className="warn small">
          Overriding the declaration: coordinates are scaled by {unitScale(units).toPrecision(6)}.
        </p>
      )}
      <div className="row">
        <button type="button" onClick={() => setUnits(units.override, true)} disabled={units.confirmed} data-testid="confirm-units">
          {units.confirmed ? 'Units confirmed' : 'Confirm units'}
        </button>
      </div>
    </section>
  );
}

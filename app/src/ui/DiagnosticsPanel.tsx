import { useUi } from '../model/store';
import { useDiagnostics } from './useDiagnostics';

const ICON = { error: '⛔', warning: '⚠', info: 'ℹ' } as const;

export function DiagnosticsPanel() {
  const { result } = useDiagnostics();
  if (!result) return <p className="muted placeholder">Diagnostics appear after a model is imported.</p>;
  const list = result.diagnostics;
  if (list.length === 0) return <p className="ok">No issues found.</p>;
  return (
    <ul className="diagnostics" data-testid="diagnostics">
      {list.map((d, i) => (
        <li key={i} className={d.severity} data-code={d.code}>
          <button type="button" onClick={() => d.bodyIds?.[0] && useUi.getState().select(d.bodyIds[0])} disabled={!d.bodyIds?.length}>
            <span className="sev">{ICON[d.severity]}</span>
            <span>
              {d.message}
              {d.fix && <span className="muted"> — {d.fix}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function diagnosticCounts(list: { severity: string }[]) {
  return {
    error: list.filter((d) => d.severity === 'error').length,
    warning: list.filter((d) => d.severity === 'warning').length,
  };
}

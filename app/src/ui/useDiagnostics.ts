import { useMemo } from 'react';
import { computeDiagnostics, type DiagnosticsResult } from '../model/diagnostics';
import { useProject } from '../model/store';

/** Diagnostics for the current project, recomputed when any input changes. */
export function useDiagnostics(): { result: DiagnosticsResult | null } {
  const model = useProject((s) => s.model);
  const units = useProject((s) => s.units);
  const assignments = useProject((s) => s.assignments);
  const materials = useProject((s) => s.materials);
  const port = useProject((s) => s.port);
  const freq = useProject((s) => s.freq);
  const result = useMemo(
    () => (model ? computeDiagnostics({ model, units, assignments, materials, port, freq }) : null),
    [model, units, assignments, materials, port, freq],
  );
  return { result };
}

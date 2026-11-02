// Guided workflow. Steps that are not implemented yet are rendered disabled
// and labelled with the milestone that delivers them; they never look usable.

export type StepKey = 'import' | 'assign' | 'feed' | 'frequency' | 'mesh' | 'validate' | 'simulate' | 'results';

interface StepDef {
  key: StepKey;
  label: string;
  /** Milestone that implements the step; undefined once available. */
  plannedFor?: string;
}

export const STEPS: StepDef[] = [
  { key: 'import', label: 'Import' },
  { key: 'assign', label: 'Assign' },
  { key: 'feed', label: 'Feed' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'mesh', label: 'Mesh' },
  { key: 'validate', label: 'Validate' },
  { key: 'simulate', label: 'Simulate' },
  { key: 'results', label: 'Results' },
];

export function WorkflowStepper({
  active,
  onSelect,
  hasModel = false,
  status = {},
}: {
  active?: StepKey;
  onSelect?: (k: StepKey) => void;
  hasModel?: boolean;
  status?: Partial<Record<StepKey, 'ok' | 'warning' | 'error'>>;
}) {
  return (
    <ol className="stepper" aria-label="Workflow">
      {STEPS.map((s, i) => {
        const planned = s.plannedFor !== undefined;
        const disabled = planned || (!hasModel && s.key !== 'import');
        const st = status[s.key];
        return (
          <li key={s.key}>
            <button
              type="button"
              className={`step${active === s.key ? ' active' : ''}${st ? ` st-${st}` : ''}`}
              disabled={disabled}
              onClick={() => onSelect?.(s.key)}
              title={planned ? `Planned — ${s.plannedFor}` : s.label}
            >
              <span className="step-index">{i + 1}</span>
              <span>{s.label}</span>
              {planned && <span className="badge planned">{s.plannedFor}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

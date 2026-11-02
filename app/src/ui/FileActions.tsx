import { useRef, useState } from 'react';
import { useProject } from '../model/store';
import { useSim } from '../sim/simStore';
import { importStepFile, openProjectFile, saveProject, useActivity } from './actions';

export function FileActions() {
  const stepInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const hasModel = useProject((s) => s.model !== null);
  const [embed, setEmbed] = useState(true);
  const [withResults, setWithResults] = useState(true);
  const hasResults = useSim((s) => s.history.length > 0);
  const busy = useActivity((s) => s.busy);
  const cancel = useActivity((s) => s.cancel);

  return (
    <div className="file-actions">
      <button type="button" onClick={() => stepInput.current?.click()} disabled={!!busy} data-testid="open-step">
        Open STEP…
      </button>
      <input
        ref={stepInput}
        type="file"
        accept=".step,.stp,.STEP,.STP"
        hidden
        data-testid="step-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importStepFile(f);
        }}
      />
      <button type="button" onClick={() => projectInput.current?.click()} disabled={!!busy} title="Select a .antsim file (and its .step file if it was saved without one)">
        Open project…
      </button>
      <input
        ref={projectInput}
        type="file"
        accept=".antsim,.step,.stp"
        multiple
        hidden
        data-testid="project-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          const proj = files.find((f) => f.name.endsWith('.antsim'));
          const step = files.find((f) => /\.(step|stp)$/i.test(f.name));
          if (proj) void openProjectFile(proj, step);
          else useActivity.getState().set({ error: 'Select a .antsim project file.' });
        }}
      />
      <button type="button" onClick={() => saveProject(embed, withResults)} disabled={!hasModel || !!busy} data-testid="save-project">
        Save project
      </button>
      <label className="check" title="Embed the original STEP file in the project">
        <input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} /> embed STEP
      </label>
      {hasResults && (
        <label className="check" title="Store the run history (results with patterns) in the project">
          <input type="checkbox" checked={withResults} onChange={(e) => setWithResults(e.target.checked)} data-testid="save-results" /> results
        </label>
      )}
      {busy && (
        <span className="busy" data-testid="busy">
          <span className="spinner" /> {busy}
          {cancel && (
            <button type="button" className="link" onClick={cancel}>
              cancel
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function ActivityBanner() {
  const error = useActivity((s) => s.error);
  const notice = useActivity((s) => s.notice);
  if (!error && !notice) return null;
  return (
    <div className={`banner ${error ? 'error' : 'ok'}`} data-testid="banner">
      <span>{error ?? notice}</span>
      <button type="button" className="link" onClick={() => useActivity.getState().set({ error: null, notice: null })}>
        dismiss
      </button>
    </div>
  );
}

// Simulation state for the Mesh -> Validate -> Simulate steps. Not saved in the
// project file. Every derived artefact carries the key of the inputs it was
// built from (project revision + settings version), so stale artefacts are
// recognised and never shown as current; results also carry the SHA-256 of
// their problem JSON, so re-meshing identical inputs makes them current again.
import { create } from 'zustand';
import type { PreparedInfo, RunProgress, SolverBackend } from '../workers/protocol';
import { DEFAULT_MESH_SETTINGS, type MeshSettings } from './mesher';
import type { MeshPlan, SimulationPlan } from './problemBuilder';
import type { ResultsJson } from './results';
import type { Diagnostic, Vec3 } from '../model/types';
import type { Ludwig3Ref, Polarization, Quantity } from './pattern';

export interface SimSettings {
  mesh: MeshSettings; // cellsPerWavelength comes from the frequency settings
  memoryLimitMb: number;
  energyDb: number;
  maxSteps: number;
}

export const DEFAULT_SIM_SETTINGS: SimSettings = { mesh: DEFAULT_MESH_SETTINGS, memoryLimitMb: 1024, energyDb: -60, maxSteps: 200_000 };

export type GridPlane = 'auto' | 'xy' | 'xz' | 'yz' | 'off';

export interface Validation {
  key: string;
  plan: SimulationPlan;
  problemJson: string;
  hash: string;
  info: PreparedInfo;
  pecSegments: Float32Array;
  nsPerCellStep: number;
  tessellation: { triangles: number; seconds: number; deflection: number };
}

export interface SimResult {
  id: string;
  /** Input key at run time; '' for results loaded from a project file (never current by key). */
  key: string;
  hash: string;
  results: ResultsJson;
  finishedAt: number;
  label: string;
  /** No conductive material: P_rad > P_acc is then numerical error. */
  lossless: boolean;
  /** Structure centre (mm), where the 3D pattern is drawn. */
  center: Vec3;
  source: 'run' | 'file';
}

export interface ResultView {
  freqIndex: number;
  quantity: Quantity;
  polarization: Polarization;
  /** 'auto': the axis with the stronger co-polar field at the main beam. */
  ludwigRef: Ludwig3Ref | 'auto';
  db: boolean;
  /** Display range below the peak (dB); values below are clipped on screen only. */
  rangeDb: number;
  elevationPhi: number;
  azimuthTheta: number;
  show3d: boolean;
  portPlot: 's11' | 'vswr' | 'zin';
}

export const DEFAULT_VIEW: ResultView = {
  freqIndex: 0,
  quantity: 'directivity',
  polarization: 'total',
  ludwigRef: 'auto',
  db: true,
  rangeDb: 40,
  elevationPhi: 0,
  azimuthTheta: 90,
  show3d: true,
  portPlot: 's11',
};

export const MAX_HISTORY = 8;

interface SimState {
  settings: SimSettings;
  settingsVersion: number;
  meshPlan: { key: string; plan: MeshPlan } | null;
  /** Blocking issues or a mesher error from the last attempt. */
  blockers: Diagnostic[];
  validation: Validation | null;
  busy: { what: 'validate' | 'run'; stage: string } | null;
  error: string | null;
  progress: RunProgress | null;
  /** Remaining run time extrapolated from the energy decay (s), or null before it can be estimated. */
  eta: number | null;
  prepared: PreparedInfo | null;
  /** Run history, newest first. */
  history: SimResult[];
  selectedId: string | null;
  view: ResultView;
  overlay: { grid: GridPlane; boxes: boolean; pec: boolean };
  /** Time-loop backend (a session preference: it does not change the problem, so results stay current). */
  backend: SolverBackend;
  /** The last run failed on the GPU; the panel offers the CPU instead. */
  gpuFailed: boolean;

  setSettings(p: Partial<SimSettings>): void;
  setBackend(b: SolverBackend): void;
  setMeshSettings(p: Partial<MeshSettings>): void;
  setOverlay(p: Partial<SimState['overlay']>): void;
  addResult(r: SimResult): void;
  selectResult(id: string): void;
  removeResult(id: string): void;
  setView(p: Partial<ResultView>): void;
  /** Clears everything derived from a model (new import or project). */
  reset(settings?: SimSettings, history?: SimResult[]): void;
}

export const useSim = create<SimState>()((set) => ({
  settings: DEFAULT_SIM_SETTINGS,
  settingsVersion: 0,
  meshPlan: null,
  blockers: [],
  validation: null,
  busy: null,
  error: null,
  progress: null,
  eta: null,
  prepared: null,
  history: [],
  selectedId: null,
  view: DEFAULT_VIEW,
  overlay: { grid: 'auto', boxes: true, pec: true },
  backend: 'cpu',
  gpuFailed: false,
  setBackend: (backend) => set({ backend, gpuFailed: false }),
  setSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p }, settingsVersion: s.settingsVersion + 1 })),
  setMeshSettings: (p) => set((s) => ({ settings: { ...s.settings, mesh: { ...s.settings.mesh, ...p } }, settingsVersion: s.settingsVersion + 1 })),
  setOverlay: (p) => set((s) => ({ overlay: { ...s.overlay, ...p } })),
  addResult: (r) =>
    set((s) => ({ history: [r, ...s.history.filter((h) => h.id !== r.id)].slice(0, MAX_HISTORY), selectedId: r.id, view: { ...s.view, freqIndex: 0 } })),
  selectResult: (id) => set((s) => ({ selectedId: id, view: { ...s.view, freqIndex: 0 } })),
  removeResult: (id) =>
    set((s) => {
      const history = s.history.filter((h) => h.id !== id);
      return { history, selectedId: s.selectedId === id ? (history[0]?.id ?? null) : s.selectedId };
    }),
  setView: (p) => set((s) => ({ view: { ...s.view, ...p } })),
  reset: (settings, history = []) =>
    set((s) => ({
      settings: settings ?? s.settings,
      settingsVersion: s.settingsVersion + 1,
      meshPlan: null,
      blockers: [],
      validation: null,
      error: null,
      progress: null,
      eta: null,
      prepared: null,
      history: history.slice(0, MAX_HISTORY),
      selectedId: history[0]?.id ?? null,
      view: { ...s.view, freqIndex: 0 },
    })),
}));

/** The result chosen in the history (the newest by default). */
export function selectedResult(s: { history: SimResult[]; selectedId: string | null }): SimResult | null {
  return s.history.find((h) => h.id === s.selectedId) ?? s.history[0] ?? null;
}

export const inputKey = (revision: number, settingsVersion: number) => `${revision}:${settingsVersion}`;

/** Whether a result describes the current inputs. */
export function resultIsCurrent(result: SimResult | null, validation: Validation | null, key: string): boolean {
  if (!result) return false;
  return result.key === key || (validation?.key === key && validation.hash === result.hash);
}

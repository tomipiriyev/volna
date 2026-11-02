// Application state: `useProject` holds what is saved in a project file;
// `useUi` holds view state (selection, visibility, tools) that is not saved.
import { create } from 'zustand';
import { BUILTIN_MATERIALS } from './materials';
import type { Assignment, CadModel, ConductorSpec, FrequencySettings, LengthUnit, Material, PortDef, Role, SheetCurrent, UnitState } from './types';
import { CONDUCTOR_ROLES } from './types';
import type { StepKey } from '../ui/WorkflowStepper';

export const DEFAULT_FREQ: FrequencySettings = { fMin: 1.5e9, fMax: 3.5e9, farField: [2.4e9], cellsPerWavelength: 20 };

interface ProjectState {
  model: CadModel | null;
  stepBytes: Uint8Array | null;
  units: UnitState;
  assignments: Record<string, Assignment>;
  materials: Material[];
  port: PortDef | null;
  freq: FrequencySettings;
  /** Increments on every project change; results will carry it to detect staleness. */
  revision: number;

  setModel(model: CadModel, stepBytes: Uint8Array): void;
  restore(p: Omit<ProjectState, keyof ProjectActions | 'revision'>): void;
  setUnits(override: LengthUnit | null, confirmed: boolean): void;
  assignRole(bodyIds: string[], role: Role | null): void;
  setMaterial(bodyId: string, materialId: string): void;
  setPriority(bodyId: string, priority: number): void;
  setConductor(bodyId: string, conductor: ConductorSpec): void;
  setSheetCurrent(bodyId: string, sheetCurrent: SheetCurrent): void;
  upsertMaterial(m: Material): void;
  setPort(port: PortDef | null): void;
  setFreq(freq: FrequencySettings): void;
}
type ProjectActions = Pick<
  ProjectState,
  'setModel' | 'restore' | 'setUnits' | 'assignRole' | 'setMaterial' | 'setPriority' | 'setConductor' | 'setSheetCurrent' | 'upsertMaterial' | 'setPort' | 'setFreq'
>;

const bump = (s: { revision: number }) => ({ revision: s.revision + 1 });

export const useProject = create<ProjectState>()((set) => ({
  model: null,
  stepBytes: null,
  units: { declared: { unit: null, found: [] }, override: null, confirmed: false },
  assignments: {},
  materials: BUILTIN_MATERIALS,
  port: null,
  freq: DEFAULT_FREQ,
  revision: 0,

  setModel: (model, stepBytes) =>
    set((s) => ({
      model,
      stepBytes,
      units: { declared: model.units, override: null, confirmed: false },
      assignments: {},
      port: null,
      ...bump(s),
    })),
  restore: (p) => set((s) => ({ ...p, ...bump(s) })),
  setUnits: (override, confirmed) => set((s) => ({ units: { ...s.units, override, confirmed }, ...bump(s) })),
  assignRole: (bodyIds, role) =>
    set((s) => {
      const assignments = { ...s.assignments };
      for (const id of bodyIds) {
        if (role === null) delete assignments[id];
        else {
          const prev = assignments[id];
          const conductor = CONDUCTOR_ROLES.includes(role);
          assignments[id] = {
            role,
            priority: prev?.priority ?? 0,
            materialId: role === 'dielectric' ? (prev?.materialId ?? s.materials[0]?.id) : undefined,
            ...(conductor && prev?.conductor ? { conductor: prev.conductor } : {}),
            ...(conductor && prev?.sheetCurrent ? { sheetCurrent: prev.sheetCurrent } : {}),
          };
        }
      }
      return { assignments, ...bump(s) };
    }),
  setMaterial: (bodyId, materialId) =>
    set((s) => {
      const a = s.assignments[bodyId];
      if (!a) return {};
      return { assignments: { ...s.assignments, [bodyId]: { ...a, materialId } }, ...bump(s) };
    }),
  setConductor: (bodyId, conductor) =>
    set((s) => {
      const a = s.assignments[bodyId];
      if (!a) return {};
      const { conductor: _c, ...rest } = a;
      return { assignments: { ...s.assignments, [bodyId]: conductor.kind === 'pec' ? rest : { ...rest, conductor } }, ...bump(s) };
    }),
  setSheetCurrent: (bodyId, sheetCurrent) =>
    set((s) => {
      const a = s.assignments[bodyId];
      if (!a) return {};
      const { sheetCurrent: _f, ...rest } = a;
      return { assignments: { ...s.assignments, [bodyId]: sheetCurrent === 'both' ? rest : { ...rest, sheetCurrent } }, ...bump(s) };
    }),
  setPriority: (bodyId, priority) =>
    set((s) => {
      const a = s.assignments[bodyId];
      if (!a) return {};
      return { assignments: { ...s.assignments, [bodyId]: { ...a, priority } }, ...bump(s) };
    }),
  upsertMaterial: (m) =>
    set((s) => {
      const i = s.materials.findIndex((x) => x.id === m.id);
      const materials = i >= 0 ? s.materials.map((x, k) => (k === i ? m : x)) : [...s.materials, m];
      return { materials, ...bump(s) };
    }),
  setPort: (port) => set((s) => ({ port, ...bump(s) })),
  setFreq: (freq) => set((s) => ({ freq, ...bump(s) })),
}));

export type PickMode = 'select' | 'feed-signal' | 'feed-reference';
export interface FeedPick {
  bodyId: string;
  faceIndex: number;
  point: [number, number, number];
}

export interface ClipState {
  enabled: boolean;
  axis: 0 | 1 | 2;
  /** Position as a fraction of the model extent along the axis. */
  position: number;
  flip: boolean;
}

interface UiState {
  step: StepKey;
  selection: { bodyId: string | null; faceIndex: number | null };
  selectMode: 'body' | 'face';
  hidden: Set<string>;
  isolated: string | null;
  xray: boolean;
  clip: ClipState;
  pickMode: PickMode;
  feedPicks: { signal: FeedPick | null; reference: FeedPick | null };
  setStep(step: StepKey): void;
  select(bodyId: string | null, faceIndex?: number | null): void;
  setSelectMode(m: 'body' | 'face'): void;
  toggleHidden(bodyId: string): void;
  setIsolated(bodyId: string | null): void;
  setXray(on: boolean): void;
  setClip(c: Partial<ClipState>): void;
  setPickMode(m: PickMode): void;
  setFeedPick(which: 'signal' | 'reference', p: FeedPick | null): void;
  resetView(): void;
}

export const useUi = create<UiState>()((set) => ({
  step: 'import',
  selection: { bodyId: null, faceIndex: null },
  selectMode: 'body',
  hidden: new Set(),
  isolated: null,
  xray: false,
  clip: { enabled: false, axis: 2, position: 0.5, flip: false },
  pickMode: 'select',
  feedPicks: { signal: null, reference: null },
  setStep: (step) => set({ step, pickMode: 'select' }),
  select: (bodyId, faceIndex = null) => set({ selection: { bodyId, faceIndex } }),
  setSelectMode: (selectMode) => set({ selectMode }),
  toggleHidden: (id) =>
    set((s) => {
      const hidden = new Set(s.hidden);
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      return { hidden };
    }),
  setIsolated: (isolated) => set({ isolated }),
  setXray: (xray) => set({ xray }),
  setClip: (c) => set((s) => ({ clip: { ...s.clip, ...c } })),
  setPickMode: (pickMode) => set({ pickMode }),
  setFeedPick: (which, p) => set((s) => ({ feedPicks: { ...s.feedPicks, [which]: p } })),
  resetView: () =>
    set({
      selection: { bodyId: null, faceIndex: null },
      hidden: new Set(),
      isolated: null,
      pickMode: 'select',
      feedPicks: { signal: null, reference: null },
    }),
}));

import { describe, expect, it } from 'vitest';
import { classifyBody, estimatedCellMm } from '../src/model/classify';
import { computeDiagnostics, unitScale, type ProjectSnapshot } from '../src/model/diagnostics';
import { approxMeshDistance } from '../src/model/geometry';
import { BUILTIN_MATERIALS, effectiveTanDelta, lossFitFrequency, lossValidity, materialSigma } from '../src/model/materials';
import { evaluatePort } from '../src/model/port';
import { readProjectZip, writeProjectZip, migrateProject } from '../src/model/projectFile';
import { bodyRef, rematchRefs, remapAssignments } from '../src/model/refs';
import { metalBandValidity, metalPreset, METALS, skinDepth, surfaceResistance } from '../src/model/metals';
import { DEFAULT_FREQ, useProject } from '../src/model/store';
import type { Assignment, CadModel, PortDef, UnitState } from '../src/model/types';
import { analyzeBody } from '../src/cad/meshAnalysis';
import type { CadBody } from '../src/model/types';
import { bodyByName, fixtureBytes, loadFixture } from './helpers/fixtures';

const confirmedMm: UnitState = { declared: { unit: 'mm', found: ['MILLIMETRE'] }, override: null, confirmed: true };

function snapshot(model: CadModel, assignments: Record<string, Assignment>, port: PortDef | null = null): ProjectSnapshot {
  return { model, units: confirmedMm, assignments, materials: BUILTIN_MATERIALS, port, freq: DEFAULT_FREQ };
}

const conductor = (role: Assignment['role']): Assignment => ({ role, priority: 0 });

function makePort(signal: CadBody, reference: CadBody, overrides: Partial<PortDef> = {}): PortDef {
  return { signal: bodyRef(signal), reference: bodyRef(reference), axis: 2, lateral: [0, 0], anchor: 0, z0: 50, amplitude: 1, ...overrides };
}

function dipolePort(m: CadModel, overrides: Partial<PortDef> = {}): PortDef {
  return makePort(bodyByName(m, 'arm_top'), bodyByName(m, 'arm_bottom'), overrides);
}

/** Open single-quad body from 4 corners (two triangles), for synthetic feed cases. */
function quadBody(id: string, corners: number[][]): CadBody {
  const positions = Float32Array.from(corners.flat());
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const a = analyzeBody(positions, indices, [{ first: 0, last: 1 }]);
  return { id, name: id, path: [], positions, indices, featureEdges: a.featureEdges, faces: a.faces, bbox: a.bbox, topology: a.topology, fingerprint: a.fingerprint };
}

describe('materials', () => {
  it('fits sigma at the band centre and reports the 1/f drift across the band', () => {
    const m = BUILTIN_MATERIALS.find((x) => x.id === 'ro4003c')!; // tan(delta) 0.0027 specified at 10 GHz
    const fFit = lossFitFrequency(0.5e9, 1.5e9);
    expect(fFit).toBeCloseTo(Math.sqrt(0.75) * 1e9, 0);
    // sigma = 2 pi f_fit eps0 epsR tan(delta): exact tan(delta) at the band centre, not 10x too lossy.
    expect(materialSigma(m, fFit)).toBeCloseTo(2 * Math.PI * fFit * 8.8541878128e-12 * 3.38 * 0.0027, 15);
    expect(effectiveTanDelta(m, fFit, fFit)).toBeCloseTo(0.0027, 12);
    const wide = lossValidity(m, 0.5e9, 1.5e9)!;
    expect(wide.atMin / 0.0027).toBeCloseTo(Math.sqrt(3), 6); // f_fit / f_min
    expect(wide.ok).toBe(false);
    expect(lossValidity(m, 0.9e9, 1.1e9)!.ok).toBe(true);
    expect(materialSigma({ ...m, loss: { kind: 'conductivity', sigma: 0.01 } }, fFit)).toBe(0.01);
  });
});

describe('classification', () => {
  it('estimates the cell size from f_max, epsR and cells per wavelength', () => {
    expect(estimatedCellMm({ ...DEFAULT_FREQ, fMax: 3e9, cellsPerWavelength: 20 }, 1)).toBeCloseTo(4.9965, 3);
    expect(estimatedCellMm({ ...DEFAULT_FREQ, fMax: 3e9, cellsPerWavelength: 20 }, 4)).toBeCloseTo(2.498, 3);
  });

  it('classifies patch copper as sheets, the substrate as a solid', async () => {
    const m = await loadFixture('patch_fr4.step');
    expect(classifyBody(bodyByName(m, 'patch'), 1, 0.5)).toMatchObject({ type: 'sheet', axis: 2, zeroThickness: false });
    expect(classifyBody(bodyByName(m, 'ground'), 1, 0.5)).toMatchObject({ type: 'sheet', axis: 2 });
    expect(classifyBody(bodyByName(m, 'substrate'), 1, 0.5)).toMatchObject({ type: 'solid', marginal: false });
    // At a coarse background cell the substrate is a slab to refine, not a sheet or an error.
    expect(classifyBody(bodyByName(m, 'substrate'), 1, 2.3, 'dielectric')).toMatchObject({ type: 'slab', axis: 2 });
    expect(classifyBody(bodyByName(m, 'substrate'), 1, 2.3, 'radiator')).toMatchObject({ type: 'sheet', axis: 2 });
    const zs = await loadFixture('patch_sheets.step');
    expect(classifyBody(bodyByName(zs, 'patch_sheet'), 1, 0.5)).toMatchObject({ type: 'sheet', zeroThickness: true });
  });

  it('classifies thin wires, tilted plates and open shells', async () => {
    const m = await loadFixture('thin_features.step');
    expect(classifyBody(bodyByName(m, 'thin_wire'), 1, 0.5)).toMatchObject({ type: 'wire', axis: 0 });
    expect(classifyBody(bodyByName(m, 'tilted_plate'), 1, 0.5).type).toBe('unsupported');
    const o = await loadFixture('open_shell.step');
    expect(classifyBody(bodyByName(o, 'open_box'), 1, 0.5).type).toBe('unsupported');
    const d = await loadFixture('dipole.step');
    // Dipole arm (r = 1 mm, t = 2V/A ~ 0.97 mm): solid at 0.4 mm cells, wire at 3 mm cells.
    expect(classifyBody(bodyByName(d, 'arm_top'), 1, 0.4)).toMatchObject({ type: 'solid' });
    expect(classifyBody(bodyByName(d, 'arm_top'), 1, 3)).toMatchObject({ type: 'wire', axis: 2 });
  });
});

describe('metal conductors', () => {
  it('skin depth, surface resistance and the band validity of the constant-R_s model', () => {
    const cu = METALS.find((x) => x.id === 'copper')!;
    expect(skinDepth(cu.sigma, 1e9)).toBeCloseTo(2.0898e-6, 9);
    expect(surfaceResistance(cu.sigma, 1e9)).toBeCloseTo(1 / (cu.sigma * skinDepth(cu.sigma, 1e9)), 12);
    const v = metalBandValidity(1.5e9, 3.5e9);
    expect(v.fFit).toBeCloseTo(lossFitFrequency(1.5e9, 3.5e9), 3);
    expect(v.atMin).toBeCloseTo(Math.sqrt(v.fFit / 1.5e9) - 1, 12); // model too lossy below f_fit
    expect(v.atMax).toBeLessThan(0); // too little loss above it
    expect(v.ok).toBe(true);
    expect(metalBandValidity(0.5e9, 4e9).ok).toBe(false);
    expect(metalPreset({ kind: 'metal', name: 'Silver', sigma: 6.3e7 })?.id).toBe('silver');
    expect(metalPreset({ kind: 'metal', name: 'Custom metal', sigma: 1e6 })).toBeUndefined();
  });

  it('classifies round and square wires with their loss radius', async () => {
    const d = await loadFixture('dipole.step');
    const round = classifyBody(bodyByName(d, 'arm_top'), 1, 3);
    expect(round).toMatchObject({ type: 'wire', round: true });
    expect(round.type === 'wire' && round.lossRadius).toBeCloseTo(1, 2);
    expect(classifyBody(bodyByName(d, 'arm_top'), 1, 0.9)).toMatchObject({ type: 'solid', roundWire: { axis: 2 } });
    const sq = await loadFixture('dipole_square.step');
    const square = classifyBody(bodyByName(sq, 'arm_top'), 1, 10);
    expect(square).toMatchObject({ type: 'wire', round: false });
    expect(square.type === 'wire' && square.lossRadius).toBeCloseTo(20 / (2 * Math.PI), 2); // 5 x 5 mm: perimeter 20 mm
  });

  it('keeps the conductor across conductor roles and reports the band note', async () => {
    const m = await loadFixture('dipole.step');
    const top = bodyByName(m, 'arm_top');
    useProject.setState({ assignments: {} });
    const { assignRole, setConductor, setSheetCurrent } = useProject.getState();
    assignRole([top.id], 'radiator');
    setConductor(top.id, { kind: 'metal', name: 'Silver', sigma: 6.3e7 });
    setSheetCurrent(top.id, 'one');
    assignRole([top.id], 'ground');
    expect(useProject.getState().assignments[top.id]).toMatchObject({ role: 'ground', conductor: { name: 'Silver' }, sheetCurrent: 'one' });
    setConductor(top.id, { kind: 'pec' });
    expect('conductor' in useProject.getState().assignments[top.id]).toBe(false);
    assignRole([top.id], 'dielectric');
    expect(useProject.getState().assignments[top.id].sheetCurrent).toBeUndefined();
    const a = { [top.id]: { role: 'radiator', priority: 0, conductor: { kind: 'metal', name: 'Copper', sigma: 5.8e7 } } as Assignment };
    const band = computeDiagnostics(snapshot(m, a)).diagnostics.find((x) => x.code === 'METAL_LOSS_BAND');
    expect(band?.severity).toBe('info');
    expect(computeDiagnostics(snapshot(m, a)).diagnostics.some((x) => x.code === 'METAL_CURVED')).toBe(false); // round wire
  });
});

describe('feed', () => {
  it('finds the 1 mm dipole gap between the arm caps', async () => {
    const m = await loadFixture('dipole.step');
    const a = { [bodyByName(m, 'arm_top').id]: conductor('radiator'), [bodyByName(m, 'arm_bottom').id]: conductor('radiator') };
    const ev = evaluatePort(m, dipolePort(m), a, 1);
    expect(ev.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(ev.geometry!.gap).toBeCloseTo(1, 6);
    expect(ev.geometry!.start[2]).toBeCloseTo(-0.5, 6);
    expect(ev.geometry!.end[2]).toBeCloseTo(0.5, 6);
    expect(ev.geometry!.direction).toBe(1);
    // The unit override scales the physical gap (file says mm, user says inch).
    expect(evaluatePort(m, dipolePort(m), a, 25.4).geometry!.gap).toBeCloseTo(25.4, 4);
  });

  it('finds the substrate-thickness gap for the patch from ground to patch', async () => {
    for (const [file, sig, ref] of [['patch_fr4.step', 'patch', 'ground'], ['patch_sheets.step', 'patch_sheet', 'ground_sheet']]) {
      const m = await loadFixture(file);
      const a = { [bodyByName(m, sig).id]: conductor('radiator'), [bodyByName(m, ref).id]: conductor('ground') };
      const port = makePort(bodyByName(m, sig), bodyByName(m, ref), { lateral: [-6, 0], anchor: 0.8 });
      const ev = evaluatePort(m, port, a, 1);
      expect(ev.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(ev.geometry!.gap).toBeCloseTo(1.524, 5);
    }
  });

  it('rejects same-body terminals, non-conductors, missed lines, oblique feeds and zero gaps', async () => {
    const m = await loadFixture('dipole.step');
    const top = bodyByName(m, 'arm_top'), bottom = bodyByName(m, 'arm_bottom');
    const a = { [top.id]: conductor('radiator'), [bottom.id]: conductor('radiator') };
    const code = (p: PortDef, asg = a) => evaluatePort(m, p, asg, 1).diagnostics.find((d) => d.severity === 'error')?.code;
    expect(code(dipolePort(m, { reference: bodyRef(top) }))).toBe('PORT_SAME_BODY');
    expect(code(dipolePort(m), { [top.id]: conductor('radiator'), [bottom.id]: { role: 'dielectric', priority: 0 } })).toBe('PORT_NOT_CONDUCTOR');
    expect(code(dipolePort(m, { lateral: [5, 0] }))).toBe('PORT_MISSES_SIGNAL');
    // A line along x at z = 10 only meets the top arm.
    expect(code(dipolePort(m, { axis: 0, lateral: [0.2, 10] }))).toBe('PORT_MISSES_REFERENCE');

    // Oblique: the signal sheet is tilted 60 deg from the feed axis.
    const c = Math.cos(Math.PI / 3), sn = Math.sin(Math.PI / 3);
    const tilted = quadBody('tilted', [[-5, -5 * c, 2 - 5 * sn], [5, -5 * c, 2 - 5 * sn], [5, 5 * c, 2 + 5 * sn], [-5, 5 * c, 2 + 5 * sn]]);
    const flat = quadBody('flat', [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
    const synth: CadModel = { ...m, bodies: [tilted, flat] };
    const sa = { tilted: conductor('radiator'), flat: conductor('ground') };
    const obl = evaluatePort(synth, makePort(tilted, flat, { anchor: 1 }), sa, 1);
    expect(obl.diagnostics.find((d) => d.severity === 'error')?.code).toBe('PORT_OBLIQUE');

    // Zero gap: two sheets in the same plane along the feed line.
    const flat2 = quadBody('flat2', [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
    const zg = evaluatePort({ ...m, bodies: [flat2, flat] }, makePort(flat2, flat, { anchor: 0 }), { flat2: conductor('radiator'), flat: conductor('ground') }, 1);
    expect(zg.diagnostics.find((d) => d.severity === 'error')?.code).toBe('PORT_ZERO_GAP');

    // Overlapping solids: the anchor sits inside both bodies.
    const touching = await loadFixture('overlap_dielectrics.step');
    const [da, db] = touching.bodies;
    const ta = { [da.id]: conductor('radiator'), [db.id]: conductor('ground') };
    expect(evaluatePort(touching, makePort(da, db, { lateral: [15, 10], anchor: 3.5 }), ta, 1).diagnostics.find((d) => d.severity === 'error')?.code).toMatch(/PORT_(INSIDE_CONDUCTOR|NO_GAP)/);
  });

  it('detects a conductor shorting the gap', async () => {
    const m = await loadFixture('monopole_ground.step');
    const mono = bodyByName(m, 'monopole'), gnd = bodyByName(m, 'ground_plane');
    const a = { [mono.id]: conductor('radiator'), [gnd.id]: conductor('ground') };
    const port = makePort(mono, gnd, { anchor: 0.5 });
    const ok = evaluatePort(m, port, a, 1);
    expect(ok.geometry!.gap).toBeCloseTo(1, 6);
    expect(ok.geometry!.direction).toBe(1);
    // Swapped terminals: same 1 mm gap, signal now below, direction -z.
    const swapped = evaluatePort(m, makePort(gnd, mono, { anchor: 0.5 }), a, 1);
    expect(swapped.geometry!.direction).toBe(-1);
    // A conductor sheet across the gap shorts the source.
    const shim = quadBody('shim', [[-5, -5, 0.5], [5, -5, 0.5], [5, 5, 0.5], [-5, 5, 0.5]]);
    const shorted = evaluatePort({ ...m, bodies: [...m.bodies, shim] }, port, { ...a, shim: conductor('passiveConductor') }, 1);
    expect(shorted.diagnostics.find((d) => d.severity === 'error')?.code).toBe('PORT_SHORTED');
  });
});

describe('diagnostics', () => {
  it('lists unassigned bodies, missing feed and unconfirmed units', async () => {
    const m = await loadFixture('dipole.step');
    const r = computeDiagnostics({ ...snapshot(m, {}), units: { ...confirmedMm, confirmed: false } });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === 'UNASSIGNED')).toHaveLength(2);
    expect(codes).toContain('NO_PORT');
    expect(codes).toContain('UNITS_UNCONFIRMED');
  });

  it('flags open shells as errors once assigned, and sheets as dielectric errors', async () => {
    const o = await loadFixture('open_shell.step');
    const box = bodyByName(o, 'open_box');
    const r = computeDiagnostics(snapshot(o, { [box.id]: conductor('passiveConductor') }));
    expect(r.diagnostics.find((d) => d.code === 'OPEN_SURFACE')?.severity).toBe('error');
    const s = await loadFixture('patch_sheets.step');
    const sheet = bodyByName(s, 'patch_sheet');
    const rs = computeDiagnostics(snapshot(s, { [sheet.id]: { role: 'dielectric', materialId: 'fr4', priority: 0 } }));
    expect(rs.diagnostics.find((d) => d.code === 'ZERO_THICKNESS_SHEET')?.severity).toBe('error');
  });

  it('warns about ambiguous dielectric overlaps until priorities differ', async () => {
    const m = await loadFixture('overlap_dielectrics.step');
    const [a, b] = m.bodies;
    const d = (pa: number, pb: number) =>
      computeDiagnostics(snapshot(m, { [a.id]: { role: 'dielectric', materialId: 'fr4', priority: pa }, [b.id]: { role: 'dielectric', materialId: 'ptfe', priority: pb } }))
        .diagnostics.find((x) => x.code === 'POSSIBLE_OVERLAP')!;
    expect(d(0, 0).severity).toBe('warning');
    expect(d(1, 0).severity).toBe('info');
  });

  it('explains radiator/ground contact in terms of the feed gap', async () => {
    const m = await loadFixture('overlap_dielectrics.step');
    const [a, b] = m.bodies;
    const d = computeDiagnostics(snapshot(m, { [a.id]: conductor('radiator'), [b.id]: conductor('ground') })).diagnostics.find((x) => x.code === 'RADIATOR_GROUND_CONTACT')!;
    expect(d.severity).toBe('warning');
    expect(d.message).toMatch(/touch or overlap/);
    expect(d.fix).toMatch(/gap/);
    // The monopole fixture has a 1 mm gap and separate bounding boxes: no contact warning.
    const mono = await loadFixture('monopole_ground.step');
    const codes = computeDiagnostics(snapshot(mono, { [mono.bodies[0].id]: conductor('ground'), [mono.bodies[1].id]: conductor('radiator') })).diagnostics.map((x) => x.code);
    expect(codes).not.toContain('RADIATOR_GROUND_CONTACT');
  });

  it('computes the unit override scale relative to the declared unit', () => {
    expect(unitScale({ declared: { unit: 'mm', found: [] }, override: 'in', confirmed: true })).toBeCloseTo(25.4);
    expect(unitScale({ declared: { unit: 'in', found: [] }, override: 'mm', confirmed: true })).toBeCloseTo(1 / 25.4);
    expect(unitScale({ declared: { unit: 'in', found: [] }, override: null, confirmed: true })).toBe(1);
  });

  it('measures the dipole arm gap as 1 mm', async () => {
    const m = await loadFixture('dipole.step');
    expect(approxMeshDistance(bodyByName(m, 'arm_top'), bodyByName(m, 'arm_bottom'))).toBeCloseTo(1, 6);
  });
});

describe('project file', () => {
  it('round-trips assignments, materials, port and units with the embedded STEP', async () => {
    const m = await loadFixture('dipole.step');
    const top = bodyByName(m, 'arm_top'), bottom = bodyByName(m, 'arm_bottom');
    const content = {
      model: m,
      stepBytes: fixtureBytes('dipole.step'),
      units: { override: null, confirmed: true },
      assignments: { [top.id]: conductor('radiator'), [bottom.id]: conductor('radiator') },
      materials: BUILTIN_MATERIALS,
      port: dipolePort(m),
      frequency: DEFAULT_FREQ,
    };
    const zip = writeProjectZip(content, true);
    const back = readProjectZip(zip);
    expect(back.stepBytes).toEqual(content.stepBytes);
    expect(back.project.source.sha256).toBe(m.sourceSha256);
    expect(back.project.port).toEqual(content.port);
    // Re-import and re-match by id + fingerprint.
    const m2 = await loadFixture('dipole.step');
    const match = rematchRefs(m2, back.project.assignments.map((a) => a.ref));
    expect(match.orphans).toEqual([]);
    expect(remapAssignments(back.project.assignments, match)).toEqual(content.assignments);
  });

  it('re-matches by fingerprint when ids change, and reports orphans', async () => {
    const m = await loadFixture('dipole.step');
    const refs = m.bodies.map((b) => ({ ...bodyRef(b), bodyId: `old-${b.id}` }));
    const match = rematchRefs(m, refs);
    expect(match.remapped).toHaveLength(2);
    const other = await loadFixture('monopole_ground.step');
    expect(rematchRefs(other, refs).orphans).toHaveLength(2);
  });

  it('rejects foreign or newer formats', () => {
    expect(() => readProjectZip(new Uint8Array([1, 2, 3]))).toThrow(/Not a project/);
    expect(() => migrateProject({ format: 'antsim-project', formatVersion: 99 })).toThrow(/newer/);
    expect(() => migrateProject({ hello: 1 })).toThrow(/format marker/);
  });
});

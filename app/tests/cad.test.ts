import { describe, expect, it } from 'vitest';
import { analyzeBody, weldVertices } from '../src/cad/meshAnalysis';
import { parseStepUnits } from '../src/cad/stepUnits';
import { bodyByName, fixtureBytes, loadFixture } from './helpers/fixtures';

describe('STEP unit parser', () => {
  it('reads SI millimetres', () => {
    expect(parseStepUnits(fixtureBytes('dipole.step'))).toMatchObject({ unit: 'mm' });
  });

  it('reads conversion-based inch and ignores its SI base unit', () => {
    const u = parseStepUnits(fixtureBytes('dipole_inch.step'));
    expect(u.unit).toBe('in');
    expect(u.found).toEqual(['INCH']);
  });

  it('handles metre, mixed and missing declarations', () => {
    const wrap = (data: string) => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;`;
    expect(parseStepUnits(wrap("#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );")).unit).toBe('m');
    const mixed = parseStepUnits(
      wrap(
        "#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n#2 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );",
      ),
    );
    expect(mixed.unit).toBeNull();
    expect(mixed.note).toMatch(/more than one/);
    expect(parseStepUnits(wrap("#1 = PRODUCT('x;y','a','',(#2));")).unit).toBeNull();
  });
});

describe('mesh analysis', () => {
  // Unit cube as 12 triangles with per-face (unwelded) vertices, like OCCT output.
  function cube(dropTop = false) {
    const quads = [
      [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], // z=0, normal -z
      [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // z=1, normal +z
      [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // y=0
      [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // y=1
      [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // x=0
      [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], // x=1
    ].filter((_, i) => !(dropTop && i === 1));
    const pos: number[] = [], idx: number[] = [], ranges: { first: number; last: number }[] = [];
    quads.forEach((q, f) => {
      const base = pos.length / 3;
      q.forEach((v) => pos.push(...v));
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      ranges.push({ first: 2 * f, last: 2 * f + 1 });
    });
    return analyzeBody(Float32Array.from(pos), Uint32Array.from(idx), ranges);
  }

  it('welds identical positions, including -0 and +0', () => {
    const c = weldVertices(Float32Array.from([0, 0, 0, 1, 2, 3, -0, 0, 0, 1, 2, 3]));
    expect([...c]).toEqual([0, 1, 0, 1]);
  });

  it('recognizes a closed, outward-oriented cube', () => {
    const a = cube();
    expect(a.topology.closed).toBe(true);
    expect(a.topology.volume).toBeCloseTo(1, 6);
    expect(a.topology.area).toBeCloseTo(6, 6);
    expect(a.topology.characteristicThickness).toBeCloseTo(1 / 3, 6);
    expect(a.faces.every((f) => f.planar && f.axisAligned !== null)).toBe(true);
    // 12 cube edges are B-rep face boundaries; the 6 quad diagonals are not.
    expect(a.featureEdges.length / 2).toBe(12);
  });

  it('flags an open box', () => {
    const a = cube(true);
    expect(a.topology.closed).toBe(false);
    expect(a.topology.boundaryEdges).toBe(4);
    expect(a.topology.volume).toBeNull();
  });
});

describe('fixture import (occt-import-js)', () => {
  it('converts the inch fixture to the same millimetre geometry as the mm fixture', async () => {
    const mm = await loadFixture('dipole.step');
    const inch = await loadFixture('dipole_inch.step');
    expect(inch.units.unit).toBe('in');
    for (let a = 0; a < 3; a++) {
      expect(inch.bbox.min[a]).toBeCloseTo(mm.bbox.min[a], 3);
      expect(inch.bbox.max[a]).toBeCloseTo(mm.bbox.max[a], 3);
    }
    expect(mm.bbox.max[2] - mm.bbox.min[2]).toBeCloseTo(59, 3);
  });

  it('keeps names, colors and closed solids for the dipole', async () => {
    const m = await loadFixture('dipole.step');
    const arm = bodyByName(m, 'arm_top');
    expect(arm.color).toBeDefined();
    expect(arm.topology.closed).toBe(true);
    expect(arm.faces.length).toBe(3); // side + 2 caps
    // Cylinder r=1, h=29: tessellated volume is slightly below pi r^2 h.
    expect(arm.topology.volume!).toBeGreaterThan(0.97 * Math.PI * 29);
    expect(arm.topology.volume!).toBeLessThan(Math.PI * 29);
  });

  it('reports zero-thickness sheets as open planar axis-aligned bodies', async () => {
    const m = await loadFixture('patch_sheets.step');
    const sheet = bodyByName(m, 'patch_sheet');
    expect(sheet.topology.closed).toBe(false);
    expect(sheet.faces).toHaveLength(1);
    expect(sheet.faces[0].axisAligned).toBe(2);
    expect(sheet.bbox.max[2] - sheet.bbox.min[2]).toBe(0);
    expect(bodyByName(m, 'substrate').topology.closed).toBe(true);
  });

  it('reports the open shell', async () => {
    const m = await loadFixture('open_shell.step');
    const b = bodyByName(m, 'open_box');
    expect(b.topology.closed).toBe(false);
    expect(b.topology.boundaryEdges).toBeGreaterThan(0);
  });

  it('measures thin features through the characteristic thickness', async () => {
    const m = await loadFixture('thin_features.step');
    const plate = bodyByName(m, 'tilted_plate');
    expect(plate.topology.characteristicThickness!).toBeCloseTo(0.035, 3);
    expect(plate.faces.filter((f) => f.axisAligned !== null).length).toBe(2); // only the x-normal end faces
    const wire = bodyByName(m, 'thin_wire');
    expect(wire.topology.characteristicThickness!).toBeGreaterThan(0.09);
    expect(wire.topology.characteristicThickness!).toBeLessThan(0.1);
  });

  it('preserves the nested assembly tree with baked instance transforms', async () => {
    const m = await loadFixture('assembly_nested.step');
    const top = m.root.children[0];
    expect(top.name).toBe('antenna_assembly');
    expect(top.children.map((c) => c.name)).toEqual(['pcb', 'radome', 'standoff', 'standoff']);
    const sub = bodyByName(m, 'pcb_substrate');
    expect(sub.path).toEqual(['antenna_assembly', 'pcb']);
    // pcb is rotated 90 deg about z: its 40 x 20 footprint becomes 20 x 40.
    expect(sub.bbox.max[0] - sub.bbox.min[0]).toBeCloseTo(20, 3);
    expect(sub.bbox.max[1] - sub.bbox.min[1]).toBeCloseTo(40, 3);
    const ids = m.bodies.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces deterministic body ids and fingerprints', async () => {
    const a = await loadFixture('patch_fr4.step');
    const b = await loadFixture('patch_fr4.step');
    expect(a.bodies.map((x) => x.id)).toEqual(b.bodies.map((x) => x.id));
    expect(a.bodies.map((x) => x.fingerprint)).toEqual(b.bodies.map((x) => x.fingerprint));
    expect(a.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

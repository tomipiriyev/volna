// Writes the M3 STEP validation cases through the app's own import and
// problem-building code (loaded with Vite's SSR loader, so the TypeScript runs
// unchanged):
//
//   node validation/cases/make_step_cases.mjs
//
//   patch_step       openEMS "Simple Patch Antenna" built from
//                    validation/fixtures/step/patch_fr4.step (35 um copper
//                    solids snapped to sheets, dielectric substrate mesh)
//   patch_step_prim  the same problem with every CAD object replaced by its
//                    bounding box (identical grid); openEMS runs this one
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const server = await createServer({ root: join(ROOT, 'app'), configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
const load = (p) => server.ssrLoadModule(join(ROOT, p));
try {
  const fx = await load('app/tests/helpers/fixtures.ts');
  const { primitiveTwin } = await load('app/tests/helpers/primitive.ts');
  const { buildSimulation } = await load('app/src/sim/problemBuilder.ts');
  const { convertOcctResult } = await load('app/src/cad/occtImport.ts');
  const { bodyRef } = await load('app/src/model/refs.ts');
  const { BUILTIN_MATERIALS } = await load('app/src/model/materials.ts');

  const name = 'patch_fr4.step';
  const model = await fx.loadFixture(name);
  const by = (n) => fx.bodyByName(model, n);
  const assignments = {
    [by('substrate').id]: { role: 'dielectric', materialId: 'openems-patch', priority: 0 },
    [by('patch').id]: { role: 'radiator', priority: 0 },
    [by('ground').id]: { role: 'ground', priority: 0 },
  };
  const port = { signal: bodyRef(by('patch')), reference: bodyRef(by('ground')), axis: 2, lateral: [-6, 0], anchor: 0.762, z0: 50, amplitude: 1 };
  const freq = { fMin: 1e9, fMax: 3e9, farField: [2.3e9, 2.35e9, 2.4e9], cellsPerWavelength: 20 };
  const snapshot = { model, units: { declared: model.units, override: null, confirmed: true }, assignments, materials: BUILTIN_MATERIALS, port, freq };

  // Simulation tessellation exactly as cad.worker's 'tessellate' request does it.
  const occt = await require('occt-import-js')();
  const res = occt.ReadStepFile(fx.fixtureBytes(name), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.05, angularDeflection: 0.2 });
  const simModel = convertOcctResult(res, { fileName: '', sha256: '', units: { unit: null, found: [] } });
  const sim = new Map(simModel.bodies.map((b) => [b.id, { positions: b.positions, indices: b.indices }]));

  const plan = buildSimulation(snapshot, sim);
  if (plan.diagnostics.some((d) => d.severity === 'error')) throw new Error(JSON.stringify(plan.diagnostics));
  Object.assign(plan.problem, { name: 'patch_step', termination: { energyDb: -70, maxSteps: 400000 } });
  const write = (dir, p) => writeFileSync(join(ROOT, 'validation/cases', dir, 'problem.json'), JSON.stringify(p));
  write('patch_step', plan.problem);
  write('patch_step_prim', { ...primitiveTwin(plan, model), name: 'patch_step_prim' });
  console.log(`patch_step: ${plan.mesh.cells.toLocaleString()} cells, lines ${plan.mesh.lines.map((l) => l.length).join(' x ')}, min cell ${Math.min(...plan.mesh.minCell).toFixed(3)} mm`);
  for (const d of plan.diagnostics) console.log(`  ${d.severity}: ${d.message}`);
} finally {
  await server.close();
}

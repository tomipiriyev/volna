// Loads STEP fixtures through occt-import-js under Node, the same conversion
// path the CAD worker uses.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { convertOcctResult, DISPLAY_TESSELLATION, sha256Hex, type OcctResult } from '../../src/cad/occtImport';
import { parseStepUnits } from '../../src/cad/stepUnits';
import type { CadModel } from '../../src/model/types';

const require = createRequire(import.meta.url);
export const FIXTURES = resolve(import.meta.dirname, '../../../validation/fixtures/step');

type Occt = { ReadStepFile(bytes: Uint8Array, params: object | null): OcctResult };
let occt: Promise<Occt> | null = null;

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

export async function loadFixture(name: string): Promise<CadModel> {
  occt ??= (require('occt-import-js') as () => Promise<Occt>)();
  const bytes = fixtureBytes(name);
  const result = (await occt).ReadStepFile(bytes, DISPLAY_TESSELLATION);
  return convertOcctResult(result, { fileName: name, sha256: await sha256Hex(bytes), units: parseStepUnits(bytes) });
}

export function bodyByName(model: CadModel, name: string) {
  const b = model.bodies.find((x) => x.name === name);
  if (!b) throw new Error(`no body named ${name}; have ${model.bodies.map((x) => x.name).join(', ')}`);
  return b;
}

// Reads the declared length unit(s) from a STEP file's DATA section.
//
// occt-import-js converts geometry to millimetres but does not report what
// the file declared, so the declaration is parsed here. Two forms are common:
//   ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )
//   ( CONVERSION_BASED_UNIT('INCH',#12) LENGTH_UNIT() NAMED_UNIT(#13) )
// A conversion-based unit refers to an SI base unit through a
// LENGTH_MEASURE_WITH_UNIT; such referenced SI units are not declarations.
import type { DeclaredUnits, LengthUnit } from '../model/types';

const SI_PREFIX: Record<string, LengthUnit | undefined> = {
  '.MICRO.': 'um',
  '.MILLI.': 'mm',
  '.CENTI.': 'cm',
  $: 'm',
};

const CONVERSION_NAMES: Record<string, LengthUnit | undefined> = {
  INCH: 'in',
  IN: 'in',
  FOOT: 'ft',
  FT: 'ft',
  MIL: 'mil',
  THOU: 'mil',
  MILLIMETRE: 'mm',
  MILLIMETER: 'mm',
  CENTIMETRE: 'cm',
  CENTIMETER: 'cm',
  METRE: 'm',
  METER: 'm',
};

/**
 * Calls fn(id, body) for every "#id = body;" entity. Linear scan that skips
 * ';' inside quoted strings (STEP escapes quotes by doubling them).
 */
export function forEachStepEntity(text: string, fn: (id: string, body: string) => void): void {
  const n = text.length;
  let i = text.indexOf('DATA;');
  if (i < 0) return;
  while (i < n) {
    const hash = text.indexOf('#', i);
    if (hash < 0) return;
    let j = hash + 1;
    while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
    const id = text.slice(hash + 1, j);
    while (j < n && (text[j] === ' ' || text[j] === '\r' || text[j] === '\n' || text[j] === '\t')) j++;
    if (!id || text[j] !== '=') {
      i = j + 1;
      continue;
    }
    const start = j + 1;
    let k = start;
    let inString = false;
    for (; k < n; k++) {
      const c = text[k];
      if (c === "'") inString = !inString; // doubled quotes toggle twice
      else if (c === ';' && !inString) break;
    }
    fn(id, text.slice(start, k).trim());
    i = k + 1;
  }
}

export function parseStepUnits(input: Uint8Array | string): DeclaredUnits {
  const text = typeof input === 'string' ? input : new TextDecoder('latin1').decode(input);
  const lengthUnits = new Map<string, string>();
  const measures = new Map<string, string>(); // LENGTH_MEASURE_WITH_UNIT bodies
  forEachStepEntity(text, (id, body) => {
    if (!body.includes('UNIT')) return;
    const b = body.replace(/\s+/g, ' ');
    if (/LENGTH_UNIT\s*\(\s*\)/i.test(b)) lengthUnits.set(id, b);
    else if (/LENGTH_MEASURE_WITH_UNIT/i.test(b)) measures.set(id, b);
  });

  const referencedBases = new Set<string>();
  for (const body of lengthUnits.values()) {
    const conv = body.match(/CONVERSION_BASED_UNIT\s*\(\s*'[^']*'\s*,\s*#(\d+)/i);
    const base = conv && measures.get(conv[1])?.match(/,\s*#(\d+)\s*\)\s*$/);
    if (base) referencedBases.add(base[1]);
  }

  const found = new Set<string>();
  const units = new Set<LengthUnit>();
  for (const [id, body] of lengthUnits) {
    const conv = body.match(/CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/i);
    if (conv) {
      const name = conv[1].trim().toUpperCase();
      found.add(name);
      const u = CONVERSION_NAMES[name];
      if (u) units.add(u);
      continue;
    }
    if (referencedBases.has(id)) continue;
    const si = body.match(/SI_UNIT\s*\(\s*([^,]+?)\s*,\s*\.METRE\.\s*\)/i);
    if (si) {
      const prefix = si[1].trim().toUpperCase();
      found.add(prefix === '$' ? 'METRE' : `${prefix.replace(/\./g, '')}METRE`);
      const u = SI_PREFIX[prefix];
      if (u) units.add(u);
    }
  }

  const foundList = [...found].sort();
  if (units.size === 1) return { unit: [...units][0], found: foundList };
  if (units.size > 1)
    return { unit: null, found: foundList, note: 'The file declares more than one length unit; confirm the unit.' };
  if (foundList.length)
    return { unit: null, found: foundList, note: `Unrecognized length unit (${foundList.join(', ')}); confirm the unit.` };
  return { unit: null, found: [], note: 'No length unit found in the file; the importer assumed millimetres.' };
}

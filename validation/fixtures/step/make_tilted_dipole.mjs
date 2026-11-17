// Writes dipole_tilted.step from dipole.step (FreeCAD is not needed): each arm is rotated
// 30 degrees about y around the centre of its cap at the gap, so the two caps stay centred
// on the z axis 1 mm apart and a z-axis feed still meets both, while the arms run off the
// grid axes (thin round wires on an oblique path).
//
//   node validation/fixtures/step/make_tilted_dipole.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, 'dipole.step'), 'utf8');
const ent = new Map();
for (const m of text.matchAll(/^#(\d+)\s*=\s*([\s\S]*?);\s*$/gm)) ent.set(+m[1], m[2]);
const refs = (id) => [...(ent.get(id) ?? '').matchAll(/#(\d+)/g)].map((m) => +m[1]);
const below = (root) => {
  const seen = new Set([root]);
  for (const stack = [root]; stack.length; ) for (const r of refs(stack.pop())) if (!seen.has(r)) seen.add(r), stack.push(r);
  return seen;
};
const breps = [...ent].filter(([, v]) => v.startsWith('MANIFOLD_SOLID_BREP')).map(([k]) => k);
if (breps.length !== 2) throw new Error(`expected two solids, found ${breps.length}`);
const a = (30 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
const rot = ([x, y, z]) => [c * x + s * z, y, -s * x + c * z];
const fmt = (v) => `(${v.map((x) => (Math.abs(x) < 1e-15 ? '0.' : x.toPrecision(15).replace(/0+$/, '').replace(/\.$/, '.'))).join(',')})`;
const out = new Map(ent);
for (const b of breps) {
  const ids = below(b);
  const zs = [...ids].filter((i) => ent.get(i).startsWith('CARTESIAN_POINT')).map((i) => +ent.get(i).match(/\(([^()]*)\)\s*\)$/)[1].split(',')[2]);
  const pivot = [0, 0, Math.max(...zs) > 0 ? 0.5 : -0.5]; // the arm's cap at the gap
  for (const i of ids) {
    const v = ent.get(i);
    const m = v.match(/^(CARTESIAN_POINT|DIRECTION)\(('[^']*'),\(([^()]*)\)\)$/);
    if (!m) continue;
    const p = m[3].split(',').map(Number);
    const q = m[1] === 'DIRECTION' ? rot(p) : rot(p.map((x, k) => x - pivot[k])).map((x, k) => x + pivot[k]);
    out.set(i, `${m[1]}(${m[2]},${fmt(q)})`);
  }
}
const body = text.replace(/^#(\d+)\s*=\s*([\s\S]*?);\s*$/gm, (_, id) => `#${id} = ${out.get(+id)};`).replace(/FILE_NAME\('[^']*'/, "FILE_NAME('dipole_tilted.step'");
writeFileSync(join(here, 'dipole_tilted.step'), body);
console.log('wrote dipole_tilted.step');

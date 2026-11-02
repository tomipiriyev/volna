// Copies occt-import-js (LGPL-2.1) into app/public/vendor/ so it ships as
// separate, replaceable files instead of being bundled into app code. The
// Emscripten loader is a UMD script; an ES module copy is made by appending
// a default export, so the CAD worker can import() it at runtime.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const src = dirname(require.resolve('occt-import-js/package.json'));
const { version } = JSON.parse(readFileSync(resolve(src, 'package.json'), 'utf8'));
const out = resolve(import.meta.dirname, '../app/public/vendor/occt-import-js');
mkdirSync(out, { recursive: true });

for (const f of ['occt-import-js.wasm', 'license.occt-import-js.txt', 'license.occt.txt']) copyFileSync(resolve(src, 'dist', f), resolve(out, f));
const loader = readFileSync(resolve(src, 'dist/occt-import-js.js'), 'utf8');
writeFileSync(
  resolve(out, 'occt-import-js.mjs'),
  `// occt-import-js ${version} (LGPL-2.1), unmodified loader + ES module export. Source: https://github.com/kovacsv/occt-import-js\n${loader}\nexport default occtimportjs;\n`,
);
writeFileSync(resolve(out, 'VERSION'), `${version}\n`);
console.log(`vendored occt-import-js ${version} -> app/public/vendor/occt-import-js`);

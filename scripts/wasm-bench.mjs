// Runs the cavity benchmark in the wasm builds under Node and prints JSON,
// so wasm throughput and results can be compared with `antsim_cli bench`.
//   node scripts/wasm-bench.mjs [n=96] [steps=60]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const n = Number(process.argv[2] ?? 96);
const steps = Number(process.argv[3] ?? 60);
const dir = resolve(import.meta.dirname, '../app/public/wasm');

for (const variant of ['st', 'mt']) {
  const { default: create } = await import(pathToFileURL(`${dir}/antsim-${variant}.js`).href);
  const mod = await create();
  const threads = variant === 'mt' ? mod.maxThreads() : 1;
  const out = mod.runBenchmark(n, steps, threads);
  if (!out.ok) {
    console.error(`${variant}: ${out.error}`);
    process.exitCode = 1;
    continue;
  }
  const r = out.result;
  console.log(JSON.stringify({
    variant, version: mod.version(), threadsEnabled: mod.threadsEnabled(), n: r.n, steps: r.steps,
    threads: r.threads, seconds: +r.seconds.toFixed(6), mcellsPerSec: +r.mcellsPerSec.toFixed(2),
    energyRatio: +(r.energyEnd / r.energyStart).toFixed(6),
  }));
  // Pthread workers keep Node alive; exit once both variants have run.
}
process.exit(process.exitCode ?? 0);

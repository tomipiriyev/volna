# Volna Antenna Simulation

Volna Antenna Simulation is a browser-based antenna simulator. You import a STEP model, assign
electromagnetic roles, define a feed, and run an FDTD solve. The solver is C++
compiled to WebAssembly and runs in a Web Worker. Results include S11, input
impedance, directivity, gain and radiation patterns. Everything runs locally
in the browser; there is no server.

**Use it online: <https://tomipiriyev.github.io/volna/>** (Chrome or Edge recommended).

> **Status: M5 (all planned milestones), plus conductor loss and conformal
> conductors.** These work and are tested:
> - STEP import, viewport, roles, feed tool, diagnostics and project files (M1a)
> - a C++ FDTD solver with CPML, PMC/PEC boundaries, a lumped port and a
>   near-to-far-field transform, natively and as wasm in a worker with
>   progress and cancel (M2)
> - meshing and simulating the imported model (M3)
> - results: plots, polar cuts, 3D pattern, availability flags, exact CSV
>   and image export, and run history (M4)
> - an optional WebGPU time loop (M5). It matches the CPU solver to about
>   1e-6 and is 3–6× faster on an Apple M1. The CPU solver remains the
>   default and the fallback.
>
> The solver is validated against analytical cases and against openEMS on
> identical grids, including a patch antenna imported from STEP and the
> pattern cuts; see
> [validation/report/validation-report.md](validation/report/validation-report.md).
> See [CHANGELOG.md](CHANGELOG.md), [docs/results.md](docs/results.md),
> [docs/gpu.md](docs/gpu.md), [docs/physics.md](docs/physics.md) and
> [docs/limitations.md](docs/limitations.md).

## Requirements

- Node ≥ 22, npm
- CMake ≥ 3.24 and a C++20 compiler (for the native build and tests)
- Emscripten 6.0.13 (for the wasm build): `./scripts/setup-emsdk.sh` installs
  it into `~/emsdk`. emsdk needs Python ≥ 3.10.
- Optional: Playwright Chromium (`npx playwright install chromium`) for e2e
  tests, and openEMS (built natively) for generating validation reference data.

`./scripts/check-env.sh` reports what is installed.

## Commands

```bash
npm install           # also vendors occt-import-js into app/public/vendor/
npm run wasm          # build antsim-st/mt wasm into app/public/wasm (needs emsdk)
npm run dev           # http://localhost:5173 (cross-origin isolated)
npm run typecheck
npm test              # vitest (includes the wasm module under Node)
npm run native        # native C++ build + doctest suite (from cpp/ presets)
npm run e2e           # production builds + Playwright (isolated, non-isolated, GitHub Pages)
node scripts/wasm-bench.mjs 96 60   # wasm throughput under Node
build/native-release/antsim_cli run validation/cases/dipole/problem.json --out results.json
node validation/cases/make_step_cases.mjs           # rebuild the STEP patch cases with the app's own code
node validation/run_validation.mjs --rerun --wasm   # full validation (openEMS references committed)
```

To run the native benchmark directly:

```bash
cd cpp && cmake --preset native-release && cmake --build --preset native-release
../build/native-release/antsim_cli bench 96 60
```

## Layout

| Path | Contents |
|---|---|
| `app/` | Vite + React + TypeScript UI, workers, (later) viewport, plots, project model |
| `cpp/` | C++20 solver core, embind bindings, native CLI, doctest tests |
| `validation/` | STEP fixtures and their generator (M1a); benchmark cases and openEMS references (M2); STEP-built patch cases (M3) |
| `docs/` | Architecture, physics, results and exports, GPU backend, deployment, limitations |
| `scripts/` | Environment check, emsdk setup, wasm build, benchmarks |
| `deploy/` | Sample server configuration with the required headers |

## Licensing

Volna Antenna Simulation is released under the [MIT License](LICENSE).

Third-party components are listed in [LICENSES/THIRD_PARTY.md](LICENSES/THIRD_PARTY.md).
The STEP importer (occt-import-js and Open CASCADE, from M1a) is LGPL-2.1. It is
shipped as a separate, replaceable wasm module.

# Changelog

## Open-source release (2026-11-02)

### Added
- The project is named **Volna Antenna Simulation** and released under the MIT
  License.
- **GitHub Pages:** `.github/workflows/pages.yml` builds and publishes the app
  from `main`. `npm run build:pages` builds for the `/volna/` subfolder, and a
  service worker supplies the cross-origin isolation headers Pages cannot set,
  so the multi-threaded solver works there (docs/deployment.md).

### Verification
- `app/e2e/pages.spec.ts`, against a local server with no isolation headers: the
  page isolates itself, runs multi-threaded and loads the solver and the STEP
  importer from the subfolder; with service workers blocked it falls back to one
  thread.

## Conductor loss (2026-10-29)

### Added
- **Metal conductors.** Every conductor body is PEC (as before, the default)
  or a metal: silver, copper, gold, aluminium, brass, tin, stainless steel
  (304), or a custom conductivity. Metals are voxelized like PEC; their
  surface edges carry the skin-effect surface resistance R_s = √(πfμ₀/σ),
  evaluated at the band centre (docs/physics.md, "Conductor loss").
- **Geometry-aware loss:**
  - solid surfaces use R_s per face;
  - zero-thickness sheets use the sheet's CAD thickness and a "current flows
    on both faces / one face" choice, and their rims get half the width;
  - thin wires use the round wire's resistance per length with the CAD
    radius (Bessel form, valid from DC to a ≫ δ);
  - straight round wires voxelized as solids are calibrated to the round
    wire's resistance per length with a static solve of their staircase
    cross-section (the uncalibrated rule overstates their loss by 60–70%).
- **Solver input:** `"type": "metal"` materials with `conductivity`; wire
  `radius`, sheet `thickness` and `currentFaces`, mesh `wire` hints, and
  `metalLossFrequency` (docs/problem-format.md). The prepare report lists the
  lossy surface edges per object, with R_s and the skin depth.
- **App:** a Conductor choice in the properties of conductor bodies (with
  R_s and δ at the band centre), round-wire recognition in the
  classification, and diagnostics for the √f band error (`METAL_LOSS_BAND`),
  curved metal surfaces (`METAL_CURVED`), skin depths that are not small
  next to the cells (`METAL_SKIN_DEPTH`) and exposed edges without a loss
  model (`METAL_EDGES_UNMODELLED`). Efficiency and gain now include conductor
  loss; the energy-balance check treats metals as lossy.
- **Project files** store the conductor and sheet-current choice on each
  assignment (optional fields within format v1; PEC projects build the same
  problem JSON as before, so saved results stay current).

### Changed
- Metal surface edges use exponential update coefficients
  (ca = exp(−σΔt/ε₀)): the averaged form gives ca ≈ −1 at these
  conductivities, a barely damped mode that alternates every step.

### Verification
- `ctest`: lossy parallel-plate resonator Q against ωμ₀h/(2R_s) within 0.03%
  (solid plates, sheets on one face, sheets on both faces); round rods 4 and
  8 cells across dissipate R'I² within 0.9% (cylinders and meshes marked as
  wires); formula limits and continuity.
- `vitest`: problem builder output for metals (and unchanged PEC problems);
  a STEP dipole with resistive arms loses 6.41% against 6.48% for exact
  cylinder twins.

### Known limitations
- One R_s for the band (√f error at the band edges, reported); no surface
  roughness, plating or magnetic metals; no separate loss breakdown.
- Zero-thickness sheets need the right "current faces" choice, and pass a
  small fraction of the field (only relevant in closed resonant enclosures).
- Curved metal surfaces other than straight round wires: loss overstated by
  up to ~70% (warned).

## M5 — WebGPU time loop (2026-10-26)

### Added
- **WGSL kernels** (`app/src/gpu/fdtd.wgsl`), mirroring the C++ step order:
  - H and E updates with packed 16-bit material ids;
  - CPML ψ corrections per slab;
  - the lumped source from a precomputed waveform buffer, and the V/I
    probes;
  - NF2FF running DFTs with an exact u32 phase (twiddles once per step),
    per-chunk f32 sums folded into Kahan totals;
  - energy reduction, and GPU-side termination with the C++ criteria.
- **Driver** (`app/src/gpu/gpuFdtd.ts`):
  - Negotiates device limits and refuses oversized problems with
    `GPU_LIMITS`.
  - Uploads once and keeps buffers resident.
  - Keeps two chunks in flight, reading 32 bytes of state per chunk.
  - Reads the series and accumulators back at the end.
  - Reports device loss as `GPU_DEVICE_LOST`.
- **C++ API for external time loops:**
  - `Solver::gpuLayoutJson`, `gpuFloats`, `gpuUints`, `fieldSnapshot`,
    `importRun` and `releaseTimeLoopStorage`;
  - `Cpml::slabInfo` and `profiles`;
  - `Nf2ff::faceInfo`, `exportAcc` and `importAcc`;
  - wasm bindings for all of them;
  - `Results.backend` in the results JSON.
- **App:**
  - a "Time loop on: CPU / WebGPU" choice on the Simulate step;
  - "Run on the CPU instead" after a GPU failure;
  - a backend label in the results.
  - In the Solver tab: a WebGPU option for the validation dipole, "GPU
    self-test" (1000 steps, all fields vs the C++ solver) and "GPU vs CPU,
    complete runs" (Z_in, D, steps, timing).
- **Docs:** `docs/gpu.md`.

### Verification (run 2026-10-26, Apple M1, Chrome new headless with Metal)
| Check | Result |
|---|---|
| `ctest` | 26 test cases. New: an imported external run post-processes bit-identically to the CPU run; layout and packing checks |
| `npm test` | 63 / 63. New: wasm export bindings and malformed-import rejection |
| `node validation/run_validation.mjs --rerun --wasm` | 65 / 65 (CPU results unchanged) |
| Fields after 1000 steps, GPU vs C++ | dipole ‖ΔE‖/‖E‖ 8.6e-7, ‖ΔH‖/‖H‖ 9.7e-7; patch 4.3e-7 / 1.9e-7 (tolerance 1e-4) |
| Complete runs, GPU vs C++ | identical step counts (3,150 and 23,652); max \|ΔZ_in\|/\|Z_in\| ≤ 1e-6; max ΔD < 1e-4 dB (tolerances 0.5% and 0.02 dB) |
| Speed, complete runs | dipole 9.7–13.1 s → 2.0–2.3 s (×4.2–6.4); patch 109–116 s → 37.1 s (×3.1) |
| `npx playwright test` | 17 / 17 (8.8 min), including the M5 spec: self-test, complete runs, WebGPU run through the app, device-lost fallback to the CPU |

### Deviations from the plan
- Port V and I are recorded per step on the GPU and transformed on the CPU
  in double precision, rather than accumulated as DFTs on the GPU. That is
  cheaper and more accurate.
- PMC boundaries, used only by the TEM benchmark, are not implemented on
  the GPU; those problems are refused with `GPU_UNSUPPORTED`.

### Known limitations
- See `docs/gpu.md` and `docs/limitations.md`.
- The GPU path still allocates the CPU field arrays during setup, so peak
  wasm memory is that of a CPU run.
- Speedups depend on the GPU and the grid shape; only an Apple M1 was
  measured.
- The CPU solver stays the default backend.

## M4 — Results, diagnostics and export (2026-10-26)

### Added
- **Results step** (`app/src/ui/ResultsView.tsx`):
  - **Port plots:** |S11|, VSWR and Z_in over the band, with far-field
    frequency markers, shaded unreliable samples and a hover readout.
  - **Polar cuts:** elevation and azimuth, with HPBW.
  - **Summary:** D, G, G_realized, efficiency, both P_rad values, P_acc,
    P_inc, the −10 dB band, series resonance, beam direction and
    front-to-back.
  - **Display controls:**
    - quantity: D, G, G_realized or normalized, labelled dBi or
      dB (normalized);
    - polarization: total, E_θ/E_φ or Ludwig-3 co/cross with an x, y or
      auto reference;
    - dB or linear, with a display range that clips the display only;
    - cut angles, with a "through the beam" shortcut.
  - **3D pattern overlay** in the viewport.
- **Analysis** (`app/src/sim/pattern.ts`): pattern components, cuts, HPBW,
  front-to-back and the 3D surface.
- **Availability** (`app/src/sim/reliability.ts`): every quantity is
  available, unreliable (⚠ with reason) or unavailable ("—" with reason).
  The rules cover the step cap, weak excitation, a far-field vs Poynting
  mismatch, no port, P_acc ≤ 0, |S11| > 1 and energy balance in lossless
  models.
- **Exports:**
  - port, far-field summary and pattern CSVs (exact doubles; units and
    conventions in the header lines);
  - SVG and PNG of every plot, with styles inlined.
- **Run history:** the last 8 runs, current/stale per run. They are saved
  in project files as `results/<id>.json` along with the simulation
  settings. Saved results become current after a validation that
  reproduces the same problem hash.
- **Run ETA** from the energy-decay trend.
- **Docs:** `docs/results.md`, which covers definitions, conventions,
  availability rules and file formats.

### Verification (run 2026-10-26, Apple M1)
| Check | Result |
|---|---|
| `ctest` | 25 test cases, 1089 assertions passed (C++ unchanged in M4) |
| `npm test` | 62 / 62. New: pattern cuts, HPBW, F/B, Ludwig-3 identities and auto reference, CSV round-trip exactness (synthetic and native dipole), exports unchanged by display settings, project round trip with results, availability rules, a server-rendered dashboard showing "—" with reasons, ETA, −10 dB band |
| `node validation/run_validation.mjs --rerun --wasm` | 65 / 65. New: dipole E-plane HPBW 78.10° (78 ± 2°); φ = 0 cuts vs openEMS within 0.03 / 0.10 / 0.12 dB (dipole / monopole / patch, tolerance 0.3 dB) |
| `npx playwright test` | 14 / 14, including the M4 results spec: plots, modes, byte-identical CSV after changing display settings, SVG/PNG, and a project saved with results that becomes current after Validate |

### Changed
- The Simulate step shows a compact latest-run summary; plots moved to
  Results.
- e2e runs on one worker, so that 8-thread browser simulations in
  different spec files do not compete for cores.

### Known limitations
- See `docs/limitations.md` ("Results").
- HPBW and F/B resolution is limited by the 2° far-field grid (about ±1°).
- There is no 3D viewport image export.
- Results from a project file need a validation before they count as
  current.

## M3 — STEP → simulation (2026-10-25)

### Added
- **C++ voxelizer** (`cpp/src/geometry/voxelize.cpp`):
  - `mesh` and `sheet` problem objects (base64 typed arrays)
  - PEC 50% edge-coverage rule with offset rays; dielectric cells by centre
  - sheet footprint snapping
  - cell-level dielectric overlap errors, priority resolution
  - DC-path and floating-port checks; per-object mesh report
- **Graded mesher** (`app/src/sim/mesher.ts`): fixed lines on feed ends,
  faces, sheets and wires; refinement regions; geometric grading.
  Thin conductors that span 2+ local cells are re-meshed as solids.
- **Problem builder** (`planMesh` / `buildSimulation`).
- **App:** Mesh, Validate and Simulate steps.
  - Grid/PML/NF2FF and PEC/port edge previews in the viewport
  - simulation tessellation in the CAD worker
  - prepare-only validation with a measured run-time estimate
  - run with progress and cancel; results summary with an S11 plot
  - stale-result marking by input key and problem hash
- **Validation:** STEP patch (`make_step_cases.mjs`) vs openEMS on the same
  grid, and its primitive twin.

### Verification (run 2026-10-25, Apple M1)
| Check | Result |
|---|---|
| `ctest` | 25 test cases, 1089 assertions passed |
| `npm test` | 44 / 44 (incl. STEP pipeline: square dipole vs `dipole_sq_h2.5` and patch vs primitive twin bitwise identical; cylinder dipole end to end) |
| `node validation/run_validation.mjs --rerun --wasm` | 52 / 52 (incl. native vs wasm). Patch from STEP vs openEMS: f_res 2.3401 GHz in both; Z_in ≤ 0.18%; D ≤ 0.009 dB; efficiency ≤ 0.002 |
| `npm run e2e` | 13 / 13: M3 patch end to end in the browser and cancel; M0–M2 specs. Two older expectations were updated for M3: Simulate is no longer a planned step, and the feed-gap note is info now. |

### Known limitations
- See `docs/limitations.md`.
- The STEP monopole fixture is not compared with the M2 programmatic
  monopole; its geometry differs. Equality is shown for the square dipole
  and the patch.
- Face-level conductor assignment is not implemented.
- There is no run ETA; elapsed time is shown.
- Results are not saved in project files.

## M2 — Validated FDTD solver core: native, wasm and in the browser (2026-10-25)

### Added (C++, `cpp/`)
- **Problem format** (`docs/problem-format.md`):
  - JSON with rectilinear or uniform grids
  - PEC and dielectric boxes and cylinders; zero-extent boxes become sheets
    and wires
  - lumped port and excitation band
  - far-field frequencies and settings
  - termination criteria
  - The parser names the offending field in every error.
- **Boundaries:** per-face PEC, PMC (image-theory face update) or CPML
  (Roden–Gedney CFS form, applied as a correction inside the slabs only, one
  fork/join per axis).
- **Rasterization:**
  - PEC: inclusive edge rule, so sheets and wires map exactly
  - dielectrics: cell-centre material with area-weighted ε and σ on edges
- **Lumped port:**
  - semi-implicit resistive voltage source (Piket-May et al.)
  - series and parallel edges
  - voltage averaged over lines; current from ∮H·dl at the middle edge
  - exact half-step timing in the DFT
  - errors for shorted or on-face ports; warnings for floating terminals
- **Excitation and termination:** Gaussian-modulated sine with analytic
  spectrum, DC-free. Energy-based termination with a deterministic parallel
  energy sum. Low-excitation frequencies are flagged.
- **NF2FF:**
  - running DFTs on a Huygens box, with components integrated at their own
    Yee sample points
  - radiation vectors with separable phase factors, parallel over directions
  - P_rad by Gauss–Legendre quadrature and by the Poynting flux through the
    box
  - D, G, G_realized, efficiency and main-beam direction
  - patterns with complex E_θ and E_φ
- **Run control and outputs:**
  - `Solver` class: prepare, chunked step, finish
  - memory estimate before allocation
  - results JSON
  - `antsim_cli run problem.json`
- **Wasm API:** `Solver.prepare/step/finish/release` and `estimate()`, with
  JSON in and out and a memory limit checked before allocating. The builds
  are now 292 KB (single-thread) and 306 KB (multi-thread).

### Added (app)
- **Solver worker:** chunked solves (about 100 ms per chunk), progress events
  (step, energy dB vs target, Mcells/s), and cancel between chunks with a
  terminate fallback. C++ error codes such as `MEMORY_LIMIT` and
  `OUT_OF_MEMORY` are propagated.
- **Memory estimate:** a TypeScript mirror of the C++ estimate, tested equal
  for every validation case.
- **Solver tab:** a validation benchmark that runs the λ/2 dipole in the
  browser and compares it with the native and openEMS results.

### Added (validation, `validation/`)
- A case generator with graded explicit grids (`cases/make_cases.py`), an
  openEMS runner for the same problem format (`openems/run_problem.py`), the
  validation runner and report (`run_validation.mjs`,
  `report/validation-report.md`), and tolerances. See `docs/validation.md`.

### Verification (run 2026-10-25, Apple M1)

| Check | Result |
|---|---|
| `ctest` (native) | 18 test cases, 1028 assertions passed |
| TEM line \|Z_in\| vs η₀h/(2W) | 0.010% worst over 1–10 GHz |
| Short dipole (0.11λ) | D = 1.783 dBi (ideal 1.761); sin²θ RMS 0.37%; P_rad far field / Poynting / P_acc within 0.02% |
| ST vs MT (8 threads) | bitwise identical: fields, port series, far field |
| `node validation/run_validation.mjs --rerun --wasm` | **39 / 39 checks passed** |
| Dipole vs openEMS (same grid) | Z_in ≤ 0.17% over 0.5–1.5 GHz; f_res 0.9446 GHz in both (0.005%); D 2.155 vs 2.160 dBi |
| Monopole on 1λ ground vs openEMS | Z_in ≤ 0.09%; f_res 0.9688 GHz in both; D 3.600 dBi in both |
| Dipole physics | L/λ = 0.465 at X = 0; R = 72.2 Ω; D(0.95 GHz) = 2.155 dBi; P_rad/P_acc = 1.0005 |
| PML 8 → 16 cells; clearance doubled | Z_in changes 0.006% and 0.19%; D ≤ 0.014 dB |
| Mesh refinement (square arms, 2.5 / 1.25 / 0.833 mm) | f_res 0.9163 → 0.9140 → 0.9124 GHz; finest pair 0.18%; D 2.180 / 2.177 / 2.173 dBi |
| Native vs wasm ST (Node) | Z_in difference 2.9e-15 |
| `npm test` | 36 / 36 (incl. wasm memory-estimate mirror, MEMORY_LIMIT, wasm TEM solve) |
| `npx playwright test` | 11 / 11: dipole solved in the browser with MT and ST builds matching native; cancel works |

Throughput, measured and machine-dependent. These runs overlapped with
macOS background scans, so treat the numbers as ±30%.

| | Mcells/s |
|---|---|
| Cavity benchmark 96³, native ST / 8 threads | 204 / 576 |
| Cavity benchmark 96³, wasm ST / MT (Node) | 162 / 325 |
| Validation dipole (222k cells, NF2FF, 3150 steps), native 8 threads | 156 (4.5 s) |
| Same, browser pane MT 8 threads | 78 (9.0 s) |
| Same, wasm ST in Node | about 40 (17.6 s) |

### Fixed during verification
- **Band-edge truncation.** The end criterion at −50 dB truncated band-edge
  spectra by about 2%, and that showed up as an apparent PML sensitivity. The
  default is now −60 dB and the validation cases use −70 dB; the truncation
  is quantified in the report.
- **CPML race.** Merging all CPML slabs into one parallel round raced at
  PML edges and corners, where two slabs update the same field. It is now
  grouped per axis, and a test caught the regression.

### Known limitations
- See `docs/limitations.md`, section "Solver (M2)".
- The monopole cross-check covers a 1λ ground only. The 2λ variant in the
  plan was not run, to keep openEMS runtimes short.
- Oblique-incidence PML performance is shown through the antenna sensitivity
  runs, not by a separate point-source reflection test.

## M1a — Stage 1 app: STEP import and model setup (2026-10-25)

### Added
- **STEP import** in a CAD worker using occt-import-js 0.0.23.
  - It is vendored as separate LGPL files under `vendor/` and loaded only
    on the first import.
  - Names, colors and the assembly hierarchy are preserved, with instance
    transforms baked in.
  - Body ids are deterministic and carry fingerprints for re-matching.
- **STEP unit parser** (`stepUnits.ts`) for SI prefixes and conversion-based
  inch, foot and mil units, plus a Units panel to confirm or override.
- **Tessellation analysis** per body:
  - welding
  - open, non-manifold and inconsistently oriented edges
  - degenerate triangles
  - enclosed volume
  - characteristic thickness 2V/A
  - per-face area, centroid, normal, planarity and axis alignment
  - B-rep face boundary lines for display
- **Geometry classification** against an estimated background cell:
  - solid (or marginal solid)
  - zero-thickness or thin conductor sheet
  - thin wire
  - thin dielectric slab (refined by the mesher)
  - unsupported, with a fix suggestion
- **Viewport** (three.js r186 `WebGPURenderer`; automatic WebGL2 fallback,
  forced with `?webgl`):
  - orbit, pan, zoom, fit; axes and model dimensions
  - body and face picking, with a BVH that preserves triangle order
  - hover; hide, isolate and X-ray
  - clipping plane (`ClippingGroup`) on any axis, with flip
  - role colors; feed and pick markers
  - on-demand rendering
  - device-loss recovery (a fresh canvas per renderer)
  - three.js is loaded as a lazy chunk
- **Model tree** with assembly nodes, bodies, on-demand face lists, and
  visibility and isolate toggles.
- **Roles:** radiator, ground, passive conductor, dielectric, excluded.
  Dielectrics have a material and an overlap priority.
- **Materials:** built-in and custom materials with εr, σ or tanδ at f_ref.
  The constant-σ model's effective tanδ is shown at the band edges, with a
  warning above ±25%.
- **Feed tool:**
  - pick terminals in the viewport, or take faces from the tree
  - axis-aligned line, terminals found by ray-casting through the bodies
  - adjustable lateral position, Z₀ and amplitude
  - gap length and direction displayed
  - errors: same body, non-conductor, missed terminal, no facing gap, zero
    gap, gap inside a conductor, oblique feed, shorted gap
  - warning: gap below the cell
- **Frequency settings:** band, up to 5 far-field frequencies, cells per
  wavelength, estimated cell size.
- **Diagnostics panel:**
  - units
  - unassigned bodies
  - open, non-manifold, inverted or thin geometry
  - possible overlaps and ambiguous dielectric priorities
  - small gaps between conductors
  - loss-tangent drift
  - feed issues
- **Project files** (`.antsim` ZIP, format v1). The STEP is embedded by
  default. On reload, references re-match by id and fingerprint, and a
  changed STEP file triggers a warning.
- **STEP fixture generator** (FreeCAD, headless) producing 9 fixtures. See
  `validation/fixtures/step/README.md`.
- Docs: `docs/ports.md`, `docs/project-format.md`, `docs/limitations.md`.

### Fixed during verification
- three-mesh-bvh's default BVH build reorders the index buffer in place. That
  broke face picking and highlighting, and it mutated the model's index
  array. The fix is the `indirect` BVH mode on a copied index buffer; the e2e
  cylinder-face test caught it.
- WebGL2 fallback: StrictMode's double effect made two renderers share one
  canvas, and disposing one lost the other's context. Each renderer now gets
  its own canvas.
- Thin dielectric substrates were classified as sheets (an error) at coarse
  cells. They are now slabs that the mesher refines across.

### Verification (run 2026-10-25)

| Check | Result |
|---|---|
| `npm test` (vitest, incl. fixtures through occt-import-js) | 32/32 passed |
| `npx playwright test` (production build, headless Chromium → WebGL2 path) | 8/8 passed |
| `npm run typecheck` (app, worker, node configs, TypeScript 7.0) | pass |
| `ctest --preset native-release` | 11 test cases passed (C++ unchanged) |
| Manual, browser pane (Chromium 152, WebGPU) | Patch imported, roles assigned, feed picked in the viewport (gap 1.524 mm at x = −6), clipping on y at 0.5. The WebGL2 fallback renders and clips the nested assembly. |

The e2e tests check:
- import with names, units and dimensions
- inch declaration and unit override
- a click on the cylinder side selects the whole B-rep face (area 175–183 mm²)
- the patch feed from tree faces is 1.5240 mm, with a same-body rejection
- save → reload → roles, material and feed restored

Measured, not promised:
- Import of `patch_fr4.step` took 0.43–0.80 s in the browser, including the
  first kernel load.
- Bundles: main 297 KB (96 KB gz); viewport chunk 883 KB (242 KB gz), lazy;
  CAD worker 7 KB; OCCT wasm 7.6 MB (3.1 MB gz), lazy; solver wasm 61/74 KB.

### Known limitations
- See `docs/limitations.md`. In short:
  - no B-rep validity check
  - assembly instances flattened
  - classification is an estimate until the Stage 3 mesher exists
  - overlaps are bounding-box-only
  - feeds are axis-aligned only
  - face-level role assignment and DC-path detection come in Stage 3
- UI responsiveness during import follows from running the parse in a worker.
  Main-thread long tasks were not measured.

## M0 — Scaffold and toolchain (2026-10-25)

### Added
- Repository layout:
  - `app/`: Vite 8, React 19, TypeScript 7.
  - `cpp/`: C++20 with CMake presets `native-debug`, `native-release`,
    `wasm-st` and `wasm-mt`.
  - `scripts/`, `docs/`, `deploy/`.
- Emscripten 6.0.13 via emsdk (`scripts/setup-emsdk.sh`); Python ≥ 3.10 is
  selected automatically.
- C++ core:
  - Rectilinear grid with CFL timestep.
  - Fork/join thread pool.
  - Yee E and H update kernels with a 16-bit per-edge material table (PEC,
    vacuum, lossy dielectric).
  - Discrete energy.
  - Cavity throughput benchmark.
  - `antsim_cli`.
- Wasm builds `antsim-st` (60 KB) and `antsim-mt` (74 KB, pthreads), loaded
  by `solver.worker.ts`. The MT build is used only when the page is
  cross-origin isolated; otherwise the single-thread build runs and the UI
  states the reason.
- Capability report covering secure context, isolation, SharedArrayBuffer,
  wasm SIMD and exceptions, and the WebGPU adapter with its limits.
- Workspace shell with the workflow stepper. Unimplemented steps are disabled
  and labelled with their milestone.
- COOP/COEP headers for dev and preview, a `preview:noiso` mode, and deploy
  samples (`app/public/_headers`, `deploy/nginx.conf`).

### Verification (run 2026-10-25 on Apple M1, 8 GB, macOS 26.5)

| Check | Result |
|---|---|
| `ctest --preset native-release` | 11 test cases, 919 assertions passed |
| TM110 cavity resonance vs discrete Yee dispersion relation | measured = predicted to < 1e-4 relative; below the continuum value 1.05993e10 Hz, as the discrete relation predicts |
| ∇·H after 200 steps on a graded grid | < 1e-5 relative (float32 round-off) |
| ST vs MT (8 threads) fields after 40 steps | bitwise identical |
| `npm run typecheck` (app, worker, node configs) | pass |
| `npm test` (vitest, wasm ST under Node) | 3/3 passed |
| `npx playwright test` (production build) | 3/3 passed: isolated → multi-thread; non-isolated → single-thread with reason; planned steps disabled |

Throughput (96³ cells, 60 steps, PEC cavity). These numbers are measured,
not promised, and depend on the machine:

| Build | Threads | Mcells/s |
|---|---|---|
| native | 1 | 229 |
| native | 8 | 755 |
| wasm ST (Node 24) | 1 | 195 |
| wasm MT (Node 24) | 8 | 397 |
| wasm MT (browser pane, Chromium 152, 64³ cells) | 8 | 334 |

The wasm and native runs give the same energy ratio, 1.000782, to 6 digits.

WebGPU in the browser pane reports an Apple metal-3 adapter with
maxBufferSize and maxStorageBufferBindingSize of 4 GiB. Headless Playwright
Chromium does not expose WebGPU, and the report shows the reason.

### Known limitations
- No STEP import, viewport, absorbing boundary, port or far field yet (M1a–M3).
- The wasm MT build warns that `-pthread` combined with `ALLOW_MEMORY_GROWTH`
  makes JS heap access slower. The solver touches the heap from JS only to
  copy results, so the impact is expected to be small; it has not been
  measured yet.
- Multi-thread scaling in wasm (397 vs 195 Mcells/s on 8 threads) is lower
  than native (755 vs 229). Profiling is planned for M2. The M1 has 4
  performance and 4 efficiency cores.

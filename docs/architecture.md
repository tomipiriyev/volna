# Architecture

## Solver choice: FDTD on a rectilinear Yee grid

Three approaches were compared for STEP-imported antennas in a browser:
FDTD, surface integral equations / MoM, and FEM with an open-region
boundary. FDTD was chosen:

- **CAD tolerance.** Voxelizing onto a grid tolerates imperfect CAD. MoM needs
  a clean conformal surface mesh, and FEM needs a conformal tetrahedral mesh;
  a tetrahedral mesher in wasm is the largest risk of all three.
- **Dielectrics** are a per-edge coefficient. In MoM, finite substrates need
  volume or PMCHWT formulations.
- **Memory** grows as O(N), about 30 B per cell. MoM is dense O(N²): 10k
  unknowns ≈ 1.6 GB in complex double.
- **Bandwidth.** One transient run gives the full S11 sweep.
- **GPU fit.** The update is a stencil, which suits f32 WGSL compute.
- **Validation.** openEMS uses the same formulation, so identical-grid
  comparisons are possible.

Known weaknesses are mitigated or documented:
- **Staircasing and thin features:** explicit sheet and wire snapping rules.
- **Fine features in large domains:** a graded rectilinear grid.
- **Long runs for high-Q structures:** energy-based termination with
  diagnostics.

## Modules

| Module | Responsibility | Thread |
|---|---|---|
| `app/src/platform` | Feature detection: secure context, isolation, SAB, wasm SIMD/EH, WebGPU | main |
| `app/src/model` | Project data model, stable CAD references, save format (M1a) | main |
| `app/src/cad` + `workers/cad.worker.ts` | STEP import and tessellation via occt-import-js (M1a) | CAD worker |
| `app/src/viewport` | three.js WebGPURenderer (WebGL2 fallback), picking, overlays (M1a) | main |
| `app/src/sim` | Graded mesher, problem builder, estimates, simulation flow and state (M3); pattern analysis, availability rules, CSV export (M4); solver client | main |
| `app/src/ui/ResultsView.tsx`, `ui/plots` | Results step: SVG line and polar plots, image export, run history (M4) | main |
| `workers/solver.worker.ts` | wasm variant selection, prepare-only validation, chunked runs with progress and cancel, GPU runs and GPU self-tests | solver worker |
| `app/src/gpu` | WebGPU time loop: WGSL kernels and the buffer/dispatch driver (M5) | solver worker (GPU) |
| `cpp/` | Grid, Yee kernels, materials, CPML, ports, NF2FF (M2+) | solver worker (+ pthreads) |

Rendering and electromagnetic computation are separate. The display
tessellation is never used as the simulation mesh.

## STEP to simulation (M3)

1. **Mesh** (main thread, instant). `planMesh`:
   - classifies bodies against the background cell;
   - snaps the feed onto thin-wire axes;
   - generates the graded grid (`sim/mesher.ts`);
   - reclassifies thin conductors that span 2 or more local cells as solids,
     then regenerates the grid.
2. **Validate.**
   1. The CAD worker re-reads the STEP bytes with an absolute chord
      deviation of a tenth of the smallest cell.
   2. `buildSimulation` emits mesh, sheet and wire objects plus the port as
      problem JSON (base64 typed arrays).
   3. A fresh solver worker measures the cost per cell-step (64³ cavity),
      then calls `prepare()`: voxelization, port, DC path and overlap checks.
      It returns the mesh report, port edges and thinned PEC edges for the
      viewport, then is terminated.
3. **Simulate.** Another fresh worker runs the same problem JSON in chunks
   of about 100 ms. Progress and cancel go through the existing protocol.

Every artefact is tagged with the inputs it came from: project revision
plus simulation-settings version. Results also carry the SHA-256 of their
problem JSON. A result is shown as current only if one of these holds:

- its key matches the current inputs, or
- the current validation produced the same problem hash.

Otherwise it is marked stale.

## GPU backend (M5)

With the WebGPU backend selected, the solver worker still prepares the
problem in wasm, then hands the time loop to `app/src/gpu`:

1. Export the layout and arrays.
2. Upload them once.
3. Run the kernels, with termination decided on the GPU.
4. Read back the port series and NF2FF sums.
5. Import them into the C++ solver for the usual post-processing.

Details and measurements are in [gpu.md](gpu.md).

## Solver kernel (implemented in M0)

`cpp/src/fdtd/yee.cpp` implements the Yee update on a rectilinear grid.

- **Grid and field layout.** Per-axis node arrays, with primary and dual
  inverse spacings. Fields are float32 structure-of-arrays with the k index
  contiguous.
- **Coefficients.** Each E edge has a 16-bit material index into a table of
  (ca, cb) coefficients. Index 0 is PEC and index 1 is vacuum.
- **Threading.** x-slab decomposition on a fork/join pool. Partitioning is
  static, so single-thread and multi-thread fields are bitwise identical
  (tested).
- **Timestep.** Δt = S / (c₀ √(Σ 1/Δmin²)), with S ≤ 1 enforced.
- **Native builds** use `-ffp-contract=off` so native results can be compared
  with wasm, which has no FMA contraction.

## Worker and wasm plumbing

- **Two builds.** Emscripten produces `antsim-st` (no threads) and
  `antsim-mt` (pthreads; pool = min(cores, 8), matching `kMaxThreads`). Both
  are ES modules in `app/public/wasm/`. The solver worker loads them at
  runtime with a dynamic `import()`, so Vite never bundles the Emscripten
  glue.
- **Build selection.** The client picks MT only when
  `crossOriginIsolated && SharedArrayBuffer`. If MT fails to start, it falls
  back to ST and records the reason.
- **Error handling.** C++ exceptions are caught in the bindings and returned
  as `{ok:false, error}`. Worker crashes reject pending promises.
- **Cleanup.** The worker is terminated after each job to release wasm
  memory, because a wasm heap cannot shrink.

## Conventions (fixed now, used from M2)

- SI units internally; mm in the UI.
- Time-harmonic convention e^{jωt} with peak phasors, so P = ½ Re(V I*).
- Spherical angles: θ from +z, φ from +x toward +y.

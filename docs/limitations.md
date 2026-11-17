# Limitations

This page tracks what the current version does **not** do, or does only
approximately. Each milestone updates it.

## STEP import (occt-import-js 0.0.23)

- **No B-rep validity check.** `BRepCheck` is not exposed. Topology checks
  run on the display tessellation: open edges, non-manifold edges,
  inconsistent orientation, degenerate triangles and inverted volume. These
  detect open shells and broken solids, but not every B-rep defect.
- **Original unit.** The importer does not report the file's unit, so it is
  read from the STEP unit entities (`stepUnits.ts`). The user must confirm
  it, or override it when the declaration is wrong.
- **Assembly instances** are flattened: transforms are baked into world
  coordinates, and each instance becomes its own body. Names and colors are
  kept.
- **Surface types** (plane, cylinder, …) are not exposed. Planarity and axis
  alignment are inferred from triangle normals, within 0.5°.
- **No progress or cancel inside the parse.** Parsing and tessellation are
  one synchronous call in the CAD worker. Progress is per stage, and cancel
  terminates the worker.
- **Not maintained upstream.** occt-import-js has had no release since
  2024-12. M1b plans an in-house OCCT 7.9.3 build behind the same interface.

## Geometry to grid (M3)

- **Classification** happens in two passes. Solid, sheet, wire, slab and
  unsupported are first judged against the background cell (λ_min / cells
  per wavelength in the densest assigned dielectric). After meshing, a
  conductor "wire" or thick "sheet" that spans at least 2 *local* cells
  (for example, near the refined feed) is voxelized as a solid instead, and
  the grid is regenerated with its faces as grid lines. The reverse change
  never happens.
- **Curved and oblique conductors** use conformal faces by default (see
  physics.md): in closed cavities, frequency errors are about 20–50× below
  staircasing, with a measured convergence order of about 1.3, not 2, and 24% more
  time steps. In antennas the gain is consistency: results stop depending on the
  orientation and converge smoothly. The feed gap and conductor edges still leave
  about 0.5–3% in f_res on a top-hat dipole at λ/190–λ/770, with or without
  conformal faces. Check convergence for any design you depend on. Features smaller
  than about two cells are still poorly resolved, and nothing refines automatically.
- **Staircasing remains** for dielectrics (whole cells, by cell centre), for sheet
  outlines, and for conductors when conformal mode is turned off (edges at least
  50% inside). Those surfaces carry an O(Δ) geometry error. Axis-aligned faces
  are exact, because the mesher puts grid lines on every solid's bounding-box
  faces; without conformal mode, faces inside the box (steps, holes) are not
  snapped.
- **Thin conductor plates** (axis-aligned, thinner than a cell) become
  zero-thickness PEC sheets. They snap to a feed end, then to an existing
  grid line, then to their mid-plane, and the snap distance is reported.
  The sheet outline is staircased to whole edges.
- **Thin axis-aligned wires** are single lines of PEC edges on the wire axis. Their
  effective radius follows the cell size, not the CAD radius.
- **Thin round wires on any other path** (bent, coiled or tilted; Ø below about
  two cells) are thin-wire chains with their true radius (physics.md, "Thin
  wires"). The centreline and radius come from the tessellation: two flat end caps
  of area about πr² are required, and the result must fit the surface to ±25% of r
  and match the volume to 10%, or the body stays unsupported. Measured errors: a
  dipole's resonance moves by up to 0.12% with its angle to the grid, and its
  resistance by up to 2.7%. A small loop's inductance is 2.1% above the thin-ring
  formula. Refining the grid lowers the resonance, roughly first-order: −2.0%
  and then −1.1% per halving of the cells near a vertical monopole, and about 4% in
  the extrapolated limit. Treat absolute resonances on coarse grids as a few per
  cent high, and check convergence. No comparison against NEC or openEMS has been
  made yet. The model
  assumes the wire is thinner than the grid's own line radius, 0.2–0.7 cell. Where
  it is not, typically next to a feed on a grid line in fine cells, the in-cell
  term is held at a minimum (`WIRE_THICK`), and those segments act thinner than
  they are. A feed on a wire must sit at one of the wire's ends and span whole
  grid edges. Wires run on the CPU only.
- **Thin oblique or curved conductors that are not round wires** (tilted plates,
  thin-walled shells), and open surfaces that are not flat and axis-aligned, are
  rejected.
- **Sub-cell dielectrics** (dielectric bodies thinner than a cell that are not
  axis-aligned layers, such as SMD parts) are voxelized at cell centres, so each
  fills only the cells whose centre it contains, often none. They do not refine
  the grid. Small ones with open or defective surfaces are left out. One
  `SUBCELL_DIELECTRIC` warning lists them all; exclude them, or refine the mesh if
  they matter.
- **Overlaps.** Dielectric overlaps are confirmed cell by cell in the
  solver; equal priorities are an error. Conductors always win over
  dielectrics, and touching conductors are joined.
- **Simulation tessellation** uses a chord deviation of a tenth of the
  smallest cell (0.002–0.5 mm). Coarser display tessellation is never used
  for simulation.
- **Face-level role assignment** (a planar face as a PEC sheet) is not
  implemented; assign whole bodies.
- **Gap distances** in the pre-mesh checks use a vertex-to-triangle
  approximation and can overestimate edge-to-edge gaps. After meshing, the
  Validate step's DC-path check between the feed terminals is
  authoritative.

## Mesher (M3)

- The graded mesher (`app/src/sim/mesher.ts`) places fixed lines on feed
  ends, solid faces, sheet planes and wire axes, and fills the gaps with
  geometric grading. Refinement regions cover dielectrics (λ/√εr), thin
  slabs (3 cells), the feed (2 cells across the gap, ±2 cells laterally)
  and conductor solids (2 cells). Region edges also become fixed lines.
  Around thin wires on bent or oblique paths, cells are capped at 8 wire radii
  ("Cells near thin wires" on the Mesh step), and those region edges are not fixed
  lines. Fewer radii refine there, but below about 5 the wire becomes thicker than
  the grid's own line and is clamped (`WIRE_THICK`). A feed on a thin
  wire gets no lateral refinement.
- Fixed lines closer than 5% of the local cell are merged (nearly coincident CAD
  faces, such as a board outline and its ground plane a few µm apart); the feed's
  own lines always survive. A gap narrower than that between two conductors closes.
- The smallest cell sets the time step for the whole domain, so very thin
  gaps or slabs make runs long. The mesher notes cells below 1/50 of the
  background cell.
- There is no automatic convergence study; refine (cells per wavelength)
  and compare yourself.

## Feed

- Single port, axis-aligned only. Terminals are derived by casting the feed
  line through the bodies. On a thin wire (bent or oblique), the feed snaps onto
  the wire's nearest end and drives the wire there.
- DC paths between the terminals are found on the voxelized grid (Validate
  step). They are a warning, not an error, because folded dipoles, loops
  and PIFAs have one on purpose.
- Port edges inside a lossy dielectric keep the permittivity but not the
  conductivity there, as in openEMS's lumped port; a warning reports how
  many edges this affects.

## Materials

- **Conductor loss** uses one surface resistance, R_s at √(f_min·f_max).
  The true R_s grows as √f, so the loss is off by √(f_fit/f) − 1 elsewhere:
  ±10% for a 1.5:1 band, ±21% for 2.2:1. The surface reactance is not
  modelled, nor are surface roughness, plating layers or magnetic metals
  (nickel, ferritic steel: μ = μ₀ is assumed). Good conductors only: when
  the skin depth is not small next to the cells, model the material as a
  lossy dielectric.
- **Zero-thickness metal sheets** carry one current for both faces. Choose
  the faces it flows on: a patch over its ground plane, or a microstrip,
  has it on one face; free-standing or printed strips and small ground
  planes on both. The wrong choice halves or doubles that sheet's loss. A
  zero-thickness resistive sheet also passes a fraction ~2R/η₀ of the field
  (a real sheet thicker than δ blocks it); this only matters in closed,
  resonant enclosures.
- **Curved metal surfaces** get exact surface loss in conformal mode. With it
  turned off, staircase corners concentrate the current, which overstates their
  loss by up to about 70% (straight round wires are calibrated instead, and other
  parts get a warning).

## Solver

- **Uniform Courant limit.** The timestep uses the uniform-grid limit with
  the smallest cell on each axis. It is safe for graded grids but
  conservative. Very small cells, such as a 0.1 mm metal thickness, shorten
  the step for the whole domain.
- **CPML** has κ = 1 and α = 0 by default. Structures must not extend into
  the PML, except PEC lines that end in it. Keep at least about λ/4 at f_min
  between the structure and the PML.
- **Far field** needs CPML on all six faces. There are no symmetry or
  infinite-ground planes yet.
- **Termination.** The default end criterion is −60 dB. Band-edge
  frequencies, where the excitation is −20 dB, are the first to suffer from
  truncation: at −50 dB, Z_in shifts by about 2% there.
- **Single port.** No mode or waveguide ports. The reference plane is the
  gap.
- **Wire models** are lines of PEC edges whose effective radius scales with
  the cell. Use solid conductors at least 2 cells across when the wire
  radius matters.
- **Multi-thread scaling in wasm** is limited on small grids by per-phase
  fork/join synchronization (about 10 rounds per step). The 222k-cell
  dipole runs at about 78 Mcells/s on 8 threads in the browser, against
  about 156 natively.

## Not implemented yet

- Infinite ground, multiport, waveguide and coax ports, periodic
  boundaries: out of scope for the MVP.
- GPU backend limits (M5): PMC boundaries run on the CPU only. The GPU path
  still allocates the CPU field arrays during setup, so peak wasm memory is
  that of a CPU run. Throughput depends strongly on the GPU and the grid
  shape. See [gpu.md](gpu.md).

## Results (M4)

- **Pattern resolution.** Patterns are sampled on the solver's θ/φ grid (2°
  by default). Cut angles snap to the nearest sample, and HPBW and
  front-to-back use linear-in-dB interpolation or nearest samples. That is
  good to a fraction of the grid step, about ±1° for HPBW. Peak D, G and
  G_r come from the solver's own maximum on that grid.
- **Reference axis.** Ludwig-3 is defined about +z. For antennas whose beam
  is not near +z (such as a z-directed dipole), the θ/φ components are
  usually more meaningful.
- **Loss breakdown.** Efficiency includes conductor and dielectric loss
  together; they are not reported separately.
- **Session-only history.** The run history lives in the browser session
  (8 runs) unless the project is saved with results. Results from a project
  file become current only after a validation reproduces the same problem
  hash.
- **No 3D export.** Image export covers the 2D plots, not the 3D viewport.

## Browser

- Multi-threaded solving requires cross-origin isolation. Otherwise the
  single-thread build runs.
- WebGPU is optional. three.js falls back to WebGL2 automatically, and
  `?webgl` forces the fallback.
- Playwright's default headless shell has no WebGPU, so most e2e tests
  exercise the WebGL2 rendering path. The M5 spec uses Chromium's new
  headless mode (`channel: 'chromium'`), which exposes the real GPU, for the
  WebGPU solver.

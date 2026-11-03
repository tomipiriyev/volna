# FDTD formulation (as implemented, M2–M3)

The solver is a standard Yee FDTD on a rectilinear grid. This page states
what the code does, including its approximations. The code lives in
`cpp/src/fdtd`, `cpp/src/nf2ff` and `cpp/src/api/solver.cpp`.

## Grid and fields

- **Grid.** Node coordinates are per axis and strictly increasing; cell
  sizes may vary (rectilinear grid).
- **Field placement.**

  | Component | Position |
  |---|---|
  | Ex | (i+½, j, k) |
  | Ey | (i, j+½, k) |
  | Ez | (i, j, k+½) |
  | Hx | (i, j+½, k+½) |
  | Hy | (i+½, j, k+½) |
  | Hz | (i+½, j+½, k) |

- **Precision.** Fields are float32. DFT accumulators and post-processing
  are float64.
- **Derivatives.** The H update uses primary spacings Δ_i. The E update uses
  dual spacings Δ*_i = (Δ_{i−1} + Δ_i)/2, or a half cell at domain faces.
- **Timestep.** Δt = S / (c₀ √(Δx_min⁻² + Δy_min⁻² + Δz_min⁻²)), with
  S = 0.99 by default; S > 1 is rejected. This is the uniform-grid Courant
  limit evaluated with the smallest cells, which is conservative for graded
  grids.

## Materials

- **E update.** Each E edge carries a 16-bit material index into a table of
  update coefficients:
  E ← ca·E + cb·(∇×H), with ca = (1 − s)/(1 + s), cb = (Δt/ε)/(1 + s), and
  s = σΔt/(2ε).
- **Index 0 is PEC**, with ca = cb = 0, so E stays at zero. Metal surface
  edges have their own entries (see [Conductor loss](#conductor-loss-metals)).
- **Dielectrics.** Each cell gets the material of the highest-priority
  object containing its centre. Edge ε and σ are the area-weighted averages
  of the four cells around the edge. This is first-order accurate at
  interfaces that do not coincide with grid planes.
- **PEC.** For primitives, an edge is PEC when it lies entirely within the
  object, boundaries included. A box with zero extent along one axis is
  therefore a sheet (tangential edges on a grid plane), and zero extent
  along two axes gives a wire (one line of edges). PEC overrides
  dielectrics.
- **Triangle meshes (M3).** Rays along each edge line are intersected with
  the mesh, using a top-left tie rule for edges and vertices and winding
  numbers for inside intervals.
  - A PEC mesh marks an edge when at least 50% of its length is inside. The
    covered length is the union over four rays offset slightly around the
    edge line, so grid-aligned faces count as inside. A grid-aligned box
    mesh then matches the box primitive exactly.
  - Dielectric meshes are sampled at cell centres, like primitives.
  - Sheet meshes snap to the nearest grid plane. An in-plane edge is PEC
    when both ends and its midpoint fall inside the triangle footprint.
  - Details and overlap rules: [problem-format.md](problem-format.md).
- **Magnetic materials.** Not implemented; μ = μ₀ everywhere.

## Conformal conductors

With `"conformal": true` (the app turns it on when a conductor has curved or
oblique faces), conductors that do not sit on grid lines keep their true shape
inside the cells they cut, instead of becoming staircases. This is the
Dey-Mittra scheme.

- **Edges.** An edge partly inside a conductor stays active, and records its open
  length l. Stretches under 0.1% of an edge are rounded away, so CAD coordinates
  on a grid line create no slivers. Geometry entirely on grid lines has no partly
  covered edges and runs bitwise identically to the standard update.
- **Faces.** The H update of a face touching such an edge uses the open lengths
  and the open area A: μA dH/dt = −Σ±l_i E_i. A comes from the polygon of open
  edge stretches, joined by chords where the surface crosses the face. E updates
  are unchanged. The bulk kernels are untouched: a sparse pass after them corrects
  only the cut faces, as H ← c₀H + Σc_i E_i, on the CPU and the GPU alike.
- **Stability.** Small cut faces would need a much shorter time step. Instead the
  Courant number becomes 0.8 when anything is cut (24% more steps than 0.99),
  and faces with dt²c²Σ(l_i/(A·dual_i)) above 3 have their coefficients capped.
  The largest eigenvalue of the whole update is then measured by power iteration
  from the cut faces' edges, and the cap tightens if it exceeds 3.98 (leapfrog
  needs it below 4), so the time step never has to depend on the smallest cut.
- **Metal loss on the true surface.** On a metal's chord the tangential E is
  E_s = R_s H_b, with H_b the surface's tangential H across the chord. The face's
  H is H_b·κ, where κ = √(1 − (n·f)²) from the surface normal n and the face
  normal f (floored at 0.2), so μA dH/dt gains −l_c R_s H/κ, a semi-implicit
  damping of H. Each family of parallel faces tiles the same surface, and the
  three components add to |H|², which makes the dissipated power R_s|H_t|²dS
  exact for any surface orientation. No round-wire calibration is needed. Where a
  grid line is tangent to a round body the surface runs along a fully covered
  edge, and that edge's faces carry the loss, with the chord along the edge.

Accuracy, from `cpp/tests/test_conformal.cpp` (exact answers, Courant 0.8):

| Case | Staircase | Conformal |
|---|---|---|
| Circular cavity TM010, f error, a/h = 10, 20, 40 | −3.76, −1.92, −0.95 % | −0.13, −0.06, −0.02 % |
| Rectangular cavity TM110 rotated 10–73°, f error, 1 mm cells (24 × 16 mm) | −3.6 to −5.0 % | −0.16 to −0.21 % |
| Spherical cavity, f error, a/h = 12, 24 | −4.38, −2.18 % | −0.09, −0.03 % |
| Wall between grid lines (any position), f error | snaps to a line, up to 1.7 % | −0.035 % (grid dispersion) |
| Circular cavity metal walls, Q (exact 199.66) | 160.3 | 197.7 |
| Rotated cavity metal walls at 0, 30, 45°, Q (exact 102.94) | not run | 102.79, 102.32, 102.75 |
| Coaxial rod 4 and 8 cells across, Q (exact 53.96) | not run | off the grid 53.93, 53.89; tangent lines 52.83, 54.48 |

The frequency error falls about 2.3–2.8× per halving of the cell, an observed
order of about 1.3: better than the staircase's first order, but not second order,
because capped faces keep a small first-order term. Three rotated cavities ran
200,000 steps with no growth. After 1000 steps the GPU fields of a conformal metal
dipole match the CPU to 6e-7 (relative L2).

The total energy used for termination counts cut H faces at their full volume, so
in a closed cavity it swings by some percent over a period. That only affects the
stopping test, which compares it over tens of dB.

**What this means for antennas.** A dipole with 40 × 40 × 5 mm metal top-hats,
rotated 45° about its feed axis, against its axis-aligned twin on the same grid
lines (f_res, one-off run at 0.625 mm, the rest in the validation report):

| Cell | Axis-aligned twin | Rotated, conformal (gap to twin) | Rotated, staircase (gap to twin) |
|---|---|---|---|
| 2.5 mm | 0.6177 GHz | 0.6213 GHz (+0.59%) | 0.6282 GHz (+1.70%) |
| 1.25 mm | 0.6149 GHz | 0.6167 GHz (+0.29%) | 0.6095 GHz (−0.87%) |
| 0.625 mm | 0.6125 GHz | 0.6130 GHz (+0.08%) | 0.6145 GHz (+0.33%) |

Conformal results converge smoothly to the twin's and hardly depend on the angle,
while staircase results jump and change sign, so refining does not reliably help
and one mesh cannot be trusted. All three columns are still about 0.5–3% above the
extrapolated answer (about 0.610 GHz) at these grids: that remaining error comes
from the feed gap and the plate edges, which conformal faces do not address, and
the twin has it too. On a slender round dipole, whose resonance follows its length
and feed gap rather than its surface shape, conformal faces change f_res little
(staircase +0.68%, conformal +0.82% at 2.5 mm against the finest conformal run).
There the gain is the surface loss, not the resonance.

Not conformal: dielectrics (still whole cells), zero-thickness sheets (outlines
staircased to whole edges) and thin-wire lines.

## Conductor loss (metals)

A conductor is PEC or a **metal** with conductivity σ. Metal objects are
voxelized exactly like PEC. Their interior edges stay PEC; each edge on the
conductor's surface instead carries the skin-effect surface resistance.

- **Surface resistance.** R_s = √(πfμ₀/σ) = 1/(σδ), with skin depth
  δ = 1/√(πfμ₀σ). The time-domain model uses one value, evaluated at
  f_fit = √(f_min·f_max) (as for dielectric loss, or at `metalLossFrequency`).
  The true R_s grows as √f, so elsewhere in the band the model's loss is off
  by √(f_fit/f) − 1 (too high below f_fit, too low above). The app reports
  this and warns above ±25%. The surface reactance X_s = R_s (internal
  inductance) is not modelled; for good conductors it is negligible next to
  the external inductance.
- **Per-edge relation.** Ampère's law on the dual face of a surface edge,
  σ_e E A = I, is made to give E = R I/w: I is the current through the dual
  face (area A), w the conductor surface width inside it, R the resistance
  per square. So σ_e = (Σ w_h/R_h)/A over the four half-lines from the edge:
  - a half-line between a conductor cell and an empty cell is a solid
    surface, R = R_s;
  - a half-line on a conductor face between two empty cells is a
    zero-thickness sheet. "Current on both faces" gives
    R = Re[(γ/2σ) coth(γt/2)] → R_s/2, "one face" gives
    R = Re[(γ/σ) coth(γt)] → R_s, with γ = (1 + j)/δ and the sheet's CAD
    thickness t (0: thick). Both tend to the DC value 1/(σt) for t ≪ δ.
    Sheet rims get half the width, so their current density, and loss, is
    higher (as in openEMS's conducting-sheet model);
  - a line of edges (thin wire) uses the round wire's resistance per length,
    R' = Re[γ I₀(γa)/(2πaσ I₁(γa))], from R_s/(2πa) (a ≫ δ) to 1/(πa²σ)
    (a ≪ δ), with the wire's CAD radius (or the radius of a circle with its
    perimeter): σ_e = 1/(R'A).
- **Round wires, without conformal faces.** A straight round wire voxelized as a solid (cylinder
  primitives at least two diameters long; meshes the app recognises as round
  wires) becomes a staircase whose convex corners and one-cell fins
  concentrate the current. The rule above would then overstate its loss by
  about 60–70% (measured, 4–8 cells across). Instead its axial surface edges
  get E = R'·I_total: a static (TEM) solve of the cross-section on the grid
  (A = 1 on the wire's axial conductor nodes, Laplace outside) gives each
  edge's share I_e/I_total, and its resistance per length is
  R'·I_total/I_e. The loss per length is then the round wire's R'·I_total².
  Transverse edges that stick half out of the wire (the 50% rule) are left
  out of the solve: they lie in single grid planes and H passes between
  them, which a driven test confirms.
- **Update coefficients.** σ_e·Δt/ε₀ is in the thousands, where the averaged
  coefficients above give ca ≈ −1, a barely damped mode that flips sign
  every step. Metal edges use exponential time stepping instead:
  ca = exp(−σ_eΔt/ε₀), cb = (1 − ca)/σ_e, so E = (∇×H)/σ_e.
- **Checks.** A warning when δ exceeds a tenth of the smallest cell (the
  model assumes a good conductor; model resistive materials as lossy
  dielectrics), and for exposed metal edges without a loss model (bodies
  thinner than a cell that are neither sheets nor wires with a radius).

Validation (`cpp/tests/test_metal.cpp`):

| Case | Result |
|---|---|
| Parallel-plate resonator, solid plates, Q vs ωμ₀h/(2R_s) | 198.55 vs 198.61 |
| Same with sheets, current on one face | 198.58 |
| Same with sheets, current on both faces (expected 2×) | 397.17 vs 397.22 |
| Round rod (4 and 8 cells across) in a coaxial line, Σσ_eE²V / R'I² | cylinder 1.002 / 1.007, mesh marked as wire 1.003 / 1.009 (uncalibrated surface rule: 1.72 / 1.60) |
| R_s, δ, sheet and wire formulas: limits and continuity | exact |

The STEP pipeline test (`app/tests/pipeline.test.ts`) runs a dipole of
1 mm-radius resistive arms (σ = 10⁴ S/m) and finds 6.41% loss against 6.48%
for exact cylinder twins on the same grid.

## Boundaries

- **Face types.** Each face is PEC, PMC or CPML.
- **PEC** keeps tangential E on the face at zero.
- **PMC** updates tangential E on the face with tangential H at the wall set
  to zero (image theory) and a half-cell dual spacing.
- **CPML** follows Roden & Gedney (2000) in CFS form with κ = 1:
  - ψ ← bψ + c·∂F/∂a
  - b = exp(−(σ + α)Δt/ε₀)
  - c = σ/(σ + α)·(b − 1)
  - σ(ρ) = σ_max (ρ/d)^m, with m = 3 and σ_max = 0.8(m+1)/(η₀Δ)
  - α(ρ) = α_max (1 − ρ/d), with α_max = 0 by default
  - default thickness 8 cells, backed by PEC

  The correction runs after the bulk update, only inside the slabs.
  Structures must not enter the PML except PEC. A TEM line terminated by the
  PML shows |Z| within 0.01% of the analytical value
  (`test_solver.cpp`).

## Lumped port (resistive voltage source)

The port is a set of edges along its axis inside the box
[start, stop]: N edges in series and M parallel lines. The implicit model is
from Piket-May, Taflove & Baron (1994).

- **Edge values.** Each parallel line has resistance R·A_tot/A_m, split
  equally over its N series edges, where A_m is the line's dual area. Each
  series edge carries an EMF of V_s/N.
- **Update for a source edge** (length Δ, dual area A, edge resistance R_e,
  EMF V_e):
  - β = ΔtΔ/(2R_e εA)
  - E^{n+1} = (1−β)/(1+β)·E^n + Δt/(ε(1+β))·(∇×H)^{n+½} − Δt/(εR_e A(1+β))·V_e g((n+½)Δt)

  This follows from I = (V_s + EΔ)/R_e, the current through the source from
  the reference side to the signal side.
- **Voltage.** V = −Σ E·Δ along the line, at t = nΔt. With several parallel
  lines, V is averaged with weights A_m/A_tot.
- **Current.** I = Σ_m (∇×H)_axis·A_m at the middle series edge, which is
  the loop integral of H right-handed about the axis. It is sampled at
  t = (n+½)Δt. Positive current flows from the source into the signal
  terminal.
- **Phasors.** V(f) and I(f) are DFTs of the recorded series at their exact
  sample times. Then Z_in = V/I, S11 = (Z_in − Z₀)/(Z_in + Z₀),
  P_acc = ½Re(VI*) and P_inc = |V + Z₀I|²/(8Z₀).
- **Errors.** A port edge inside PEC or on a PEC face is an error. A port
  end that touches no conductor gives a warning.

## Excitation and termination

- **Pulse.** g(t) = exp(−((t−t₀)/τ)²) sin(2πf₀(t−t₀)), with
  f₀ = (f_min + f_max)/2 and τ = √(ln 10)/(πf_c), where f_c = (f_max − f_min)/2.
  The spectrum is therefore −20 dB at the band edges. The pulse is DC-free,
  and t₀ = 3.717τ.
- **Stopping.** Every ~½ period at f_max, the solver computes the total field
  energy (deterministic, independent of thread count). The run stops once the
  pulse has passed and the energy is below `energyDb` relative to its peak.
  The default is −60 dB; the validation cases use −70 dB. At −50 dB,
  truncating the DFT changes Z_in by 1–2% at the band edges, where the
  excitation is weak (see the validation report).
- **Step cap.** Hitting `maxSteps` marks the results unreliable.
- **Low-excitation flag.** Frequencies where the excitation spectrum is
  below −40 dB of its peak are flagged.

## Near field to far field

- **Huygens box.** The faces are node planes `marginCells` inside the PML
  interface (default 4). They must cross vacuum only; otherwise setup fails.
  A box needs CPML on all six faces.
- **Sampling.** On a face with normal â, the tangential components are
  sampled where they live:
  - E_p and the plane average of H_q at (p half, q node)
  - E_q and the plane average of H_p at (p node, q half)

  Here (p, q) are the cyclic successors of a. The equivalent currents are
  J = n̂×H and M = −n̂×E. Each component is integrated over its own sample
  points with its own areas, so E and H never need to be co-located.
- **Radiation vectors.** N and L use e^{jk r'·r̂} with separable phase
  factors. Following Balanis, with e^{jωt}:
  - E_θ = −jk/(4π)·(L_φ + ηN_θ)
  - E_φ = jk/(4π)·(L_θ − ηN_φ)
  - U = |rE|²/(2η)
- **Radiated power.** P_rad uses Gauss–Legendre quadrature in cos θ (default
  48 points) times uniform φ (96 points). It is cross-checked against
  ½Re∮(E×H*)·n̂ dS on the same box.
- **Gain quantities.**
  - Directivity D = 4πU_max/P_rad
  - Gain G = 4πU_max/P_acc
  - Realized gain G_r = 4πU_max/P_inc
  - Efficiency η = P_rad/P_acc

  U_max comes from the display grid (default 2°).
- **Angles.** θ is measured from +z, and φ from +x toward +y. The phase
  origin is the coordinate origin.

## Threads and reproducibility

- **Threading.** x-slab decomposition with static partitioning. Reductions
  (energy) use per-slab partial sums combined in a fixed order. Single-thread
  and multi-thread runs are bitwise identical, including the port series and
  the far field (`test_solver.cpp`).
- **Native vs wasm.** Native builds use `-ffp-contract=off`, so they match
  wasm builds to about 1e-15 (validation report).

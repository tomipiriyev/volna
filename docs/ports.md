# Feed (lumped port)

The first release supports a single lumped port. This page documents the
model; the solver implements it in M2.

## Definition (implemented, M1a)

A port is an **axis-aligned line**, defined by:
- its axis (x, y or z)
- a lateral position (the coordinates on the other two axes)
- an anchor coordinate near the gap

The signal and reference terminals are bodies with conductor roles. The
terminal points are found by intersecting the line with both bodies. The gap
runs from the reference surface to the signal surface that face each other
across the anchor.

The terminals can be picked in the viewport, or taken from faces selected in
the model tree, in which case the face centroid is used. The suggested axis is
the normal of the signal face when that face is planar and axis-aligned.

### Validation

| Check | Result |
|---|---|
| Both terminals on the same body | Error: the source would be shorted |
| A terminal body without a conductor role | Error |
| The line misses a terminal body | Error |
| No facing surfaces across the anchor | Error |
| Zero gap (terminals touch) | Error |
| Gap inside a closed terminal body | Error |
| Feed meets a terminal surface more than 45° from its normal | Error (oblique feed) |
| Another conductor crosses the gap | Error (shorted) |
| Gap shorter than the estimated cell | Warning: the mesher must refine along the feed axis |
| Signal body is not a radiating conductor | Warning |

Checks that need the grid run at Stage 3:
- A DC path between the terminals, which is expected for PIFA, loop and
  folded dipoles.
- Snapping changing the gap by more than 10%.

## Source model (M2)

- **Source.** A resistive voltage source (Thevenin EMF Vs with internal
  resistance Rs = Z₀, default 50 Ω) on the Yee edges spanning the gap. It
  uses the semi-implicit lumped-element formulation of Piket-May, Taflove and
  Baron (1994). For N edges in series, each edge gets Rs/N and Vs/N.
- **Source impedance.** Included. It damps resonances and shortens runs.
- **Voltage.** V = φ_signal − φ_reference = −Σ E·Δl along the line from the
  reference to the signal terminal. It is sampled at integer time steps.
- **Current.** I = ∮ H·dl around the middle gap edge, right-handed about the
  reference→signal direction. It is sampled at half steps, and each DFT uses
  its exact sample times. Positive current flows from the source into the
  signal terminal, so a passive antenna has Re Z_in > 0; a unit test enforces
  this sign.
- **Phasor convention.** e^{jωt} with peak phasors, so P = ½ Re(V I*).

## Derived quantities

| Quantity | Definition |
|---|---|
| Z_in | V / I |
| S11 | (Z_in − Z₀) / (Z_in + Z₀), for real Z₀ |
| Incident and reflected waves | a = (V + Z₀ I) / (2√Z₀), b = (V − Z₀ I) / (2√Z₀) |
| P_inc | \|a\|² / 2 |
| P_acc | ½ Re(V I*) = P_inc (1 − \|S11\|²), an identity for real Z₀ |
| Consistency check | P_inc should equal \|Vs\|² / (8 Rs) |
| VSWR | (1 + \|S11\|) / (1 − \|S11\|) |

**Realized gain.** G_realized = G · (1 − |S11|²) holds when all of these are
true:
- single port
- real Z₀
- source impedance equal to Z₀, so P_inc is the available power
- S11 and P_inc defined at the same reference plane
- mismatch is the only loss between the source and the antenna

## Reference plane and limitations

- The reference plane is the gap itself, and there is no de-embedding. The
  gap capacitance and the local feed geometry are part of Z_in.
- A coax probe is modelled only as a gap between the probe and the ground.
  There are no coax or waveguide ports.
- Feeds are axis-aligned only. Sheet ports with parallel edges are used only
  for the TEM-line benchmark.

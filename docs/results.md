# Results: definitions, conventions and exports (M4)

All numbers come from the solver's results JSON. The app derives patterns,
cuts and summaries from it, and never changes the stored data for display.

## Quantities

| Quantity | Definition |
|---|---|
| Z_in | V/I at the lumped port. The reference plane is the gap. |
| S11 | (Z_in − Z₀)/(Z_in + Z₀), with a real Z₀ (default 50 Ω) |
| VSWR | (1 + \|S11\|)/(1 − \|S11\|). Not defined for \|S11\| ≥ 1. |
| −10 dB band | The band around the \|S11\| minimum where \|S11\| < −10 dB. Crossings are interpolated in dB. If the band reaches an edge of the simulated band, it is shown with ≤ or ≥. |
| Series resonance | The zero crossing of Im Z_in closest to the \|S11\| minimum |
| P_acc, P_inc | ½ Re(V I*) and \|V + Z₀I\|²/(8Z₀), for the DFT-scaled source. Only ratios are meaningful. |
| P_rad | Far-field quadrature (Gauss–Legendre in cos θ × uniform φ). Cross-checked against the Poynting flux through the Huygens box. |
| Directivity D(θ, φ) | 4πU/P_rad. The peak value is reported in dBi. |
| Gain G | 4πU/P_acc = D · P_rad/P_acc |
| Realized gain G_r | 4πU/P_inc = D · P_rad/P_inc, for a matched Z₀ source at the gap |
| Radiation efficiency | P_rad/P_acc. Includes conductor loss (metals) and dielectric loss; PEC conductors are lossless. |
| Normalized pattern | D(θ, φ)/D_max of the total pattern, in "dB (normalized)", never dBi |
| HPBW | Width of the lobe that contains the cut's maximum, between the −3 dB points on both sides, interpolated linearly in dB. Cuts are closed circles. A cut that never drops 3 dB has no HPBW. |
| Front-to-back | D at the main beam (θ_b, φ_b) over D at (180° − θ_b, φ_b + 180°), at the nearest grid samples, total polarization |

## Conventions

- **Angles.** θ is measured from +z and φ from +x toward +y. The far-field
  grid uses 2° by default (`farField.thetaStep/phiStep`). Cut angles snap to
  the nearest grid sample, and the angle actually used is shown.
- **Phasors.** r·E is stored as peak phasors with e^{jωt}; the e^{−jkr}
  factor is removed.
- **Polarization.** A component takes the fraction |E_c|²/(|E_θ|² + |E_φ|²)
  of the total directivity.
  - E_θ and E_φ are the spherical components.
  - **Ludwig-3** uses boresight +z.
    - Reference y: co = E_θ sin φ + E_φ cos φ, and cross = E_θ cos φ − E_φ sin φ.
    - Reference x: co = E_θ cos φ − E_φ sin φ, and cross = E_θ sin φ + E_φ cos φ.
    - "Auto" picks the reference whose co-polar field is stronger at the main
      beam. For the openEMS patch, which is fed along x, that is x.
- **Polar plots.**
  - **Elevation cuts** put θ = 0 (+z) at the top. The right half is
    φ = φ₀ and the left half φ₀ + 180°.
  - **Azimuth cuts** put φ = 0 (+x) on the right and run counter-clockwise.
- **3D pattern.** The surface is drawn around the structure centre. In dB
  the radius grows linearly from (peak − range) to the peak; in linear
  scale the radius is proportional to the value. The colour follows the
  radius.

## Display versus data

The display range ("peak − N dB") and the dB/linear choice clip and scale
plots and the 3D surface only. Exports never receive them. A unit test
exports with different display settings and compares the bytes, and an e2e
test re-downloads the port CSV after changing them.

## Availability

Every peak quantity is one of three states:

- **Available.**
- **Unreliable:** shown with ⚠ and the reason.
- **Unavailable:** shown as "—" with the reason.

The rules are in `app/src/sim/reliability.ts`:

| Condition | Effect |
|---|---|
| Run stopped at the step cap | All spectra and far-field quantities are unreliable (truncated DFT) |
| Excitation below −40 dB of its peak at the frequency | Unreliable |
| P_rad (far field) and P_rad (Poynting box) differ by more than 5% | Far-field quantities are unreliable |
| No port | Gain, realized gain, efficiency, P_acc, P_inc and S11 are unavailable |
| P_acc ≤ 0 | Gain and efficiency are unavailable |
| P_inc ≤ 0 | Realized gain is unavailable |
| \|S11\| > 1 | The passive-port check failed: unreliable |
| Lossless model (no σ anywhere) and P_rad > 1.05 P_acc | Energy-balance error: gain and efficiency are unreliable |

Port samples that are unreliable are shaded in the port plots and listed in
the `reliability` column of the port CSV.

## Exports

**CSV.** Raw columns are written with JavaScript's shortest round-trip
number formatting. Parsing a field gives back exactly the double in the
results JSON, which in turn is the C++ value; tests check this against the
native solver's output. Header lines starting with `#` give units and
conventions. Unavailable values are empty fields.

- `<name>_port.csv` has these columns, over the port frequencies:
  - `frequency_Hz`
  - `zin_re_ohm`, `zin_im_ohm`
  - `s11_re`, `s11_im`
  - `p_acc_W`, `p_inc_W`
  - `source_dB`
  - derived: `s11_dB`, `vswr`
  - `reliability`
- `<name>_farfield.csv` has one row per far-field frequency:
  - D, G and G_r in dBi
  - efficiency
  - both P_rad values, P_acc and P_inc
  - beam θ and φ
  - S11 in dB
  - source level
- `<name>_pattern_<f>GHz.csv` has one row per grid direction:
  - `theta_deg`, `phi_deg`
  - `directivity_lin` (total)
  - E_θ and E_φ real and imaginary parts

**Plot images.** Each plot card has SVG and PNG buttons. The SVG has the
on-screen styles inlined, plus a background, so it renders outside the app.
The PNG is rasterized from it at 3× scale. Hover readouts are left out.

## Run history

The last 8 runs of a session are kept. One is selected at a time.

- **Current:** a run is current when its input key matches the current
  inputs, or when the latest validation produced the same problem hash.
- **Stale:** otherwise it is marked stale.
- **New model:** importing a new model or opening a project clears the
  history. Results saved in a project come back with it; see
  [project-format.md](project-format.md).

## Validation of the pattern code

`node validation/run_validation.mjs` loads `app/src/sim/pattern.ts`, the
code the UI uses, and checks it against two references:

- **The thin half-wave dipole's 78° HPBW.** The validation dipole gives
  78.10° at 0.95 GHz.
- **openEMS φ = 0 cuts,** where the reference is within 20 dB of its peak:
  dipole 0.03 dB, monopole 0.10 dB, patch 0.12 dB, all against a 0.3 dB
  tolerance.

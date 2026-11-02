# Validation report (M2–M4)

Generated 2026-10-26T02:25:16.546Z by `node validation/run_validation.mjs --rerun --wasm`.

**65 / 65 checks passed.** Tolerances: `validation/tolerances.json`. Reference solver: openEMS 0.37 on identical grid lines.

## vs openEMS: dipole

| Check | Value | Limit | Result |
|---|---|---|---|
| max |ΔZin| / |Zin| over band | 0.172 % | < 3.000 % | pass |
| f_res 0.9446 GHz vs 0.9446 GHz | 0.005 % | < 1.000 % | pass |
| D at 0.9500 GHz: 2.155 vs 2.160 dBi | 0.005 dB | < 0.1 dB | pass |
| P_rad/P_acc at 0.9500 GHz: 1.0005 vs 1.0003 | 0.0002 | < 0.02 | pass |
| D at 1.0000 GHz: 2.204 vs 2.210 dBi | 0.006 dB | < 0.1 dB | pass |
| P_rad/P_acc at 1.0000 GHz: 1.0007 vs 1.0000 | 0.0008 | < 0.02 | pass |

## vs openEMS: monopole

| Check | Value | Limit | Result |
|---|---|---|---|
| max |ΔZin| / |Zin| over band | 0.093 % | < 3.000 % | pass |
| f_res 0.9688 GHz vs 0.9688 GHz | 0.003 % | < 1.000 % | pass |
| D at 1.0000 GHz: 3.600 vs 3.600 dBi | 0.000 dB | < 0.1 dB | pass |
| P_rad/P_acc at 1.0000 GHz: 0.9995 vs 0.9968 | 0.0027 | < 0.02 | pass |

## dipole physics

| Check | Value | Limit | Result |
|---|---|---|---|
| L / λ at series resonance | 0.4648 | 0.46 – 0.49 | pass |
| R at series resonance | 72.17 Ω | 60 – 75 Ω | pass |
| D at 0.95 GHz (thin λ/2 dipole: 2.15 dBi) | 2.155 dBi | 2.15 ± 0.15 dBi | pass |
| energy balance P_rad/P_acc at 0.9500 GHz | 1.0005 | 1 ± 0.02 | pass |
| P_rad far field / Poynting box at 0.9500 GHz | 1.00039 | 1 ± 0.01 | pass |
| energy balance P_rad/P_acc at 1.0000 GHz | 1.0007 | 1 ± 0.02 | pass |
| P_rad far field / Poynting box at 1.0000 GHz | 1.00090 | 1 ± 0.01 | pass |

## boundary sensitivity

| Check | Value | Limit | Result |
|---|---|---|---|
| dipole_pml16: max |ΔZin|/|Zin| vs base | 0.006 % | < 0.500 % | pass |
| dipole_pml16: ΔD at 0.9500 GHz | 0.000 dB | < 0.05 dB | pass |
| dipole_pml16: ΔD at 1.0000 GHz | 0.000 dB | < 0.05 dB | pass |
| dipole_pad2: max |ΔZin|/|Zin| vs base | 0.189 % | < 0.500 % | pass |
| dipole_pad2: ΔD at 0.9500 GHz | 0.010 dB | < 0.05 dB | pass |
| dipole_pad2: ΔD at 1.0000 GHz | 0.014 dB | < 0.05 dB | pass |

## mesh refinement

| Check | Value | Limit | Result |
|---|---|---|---|
| h = 2.500 mm: f_res 0.9163 GHz, D 2.180 dBi (222,180 cells) | — | info | info |
| h = 1.250 mm: f_res 0.9140 GHz, D 2.177 dBi (489,888 cells) | — | info | info |
| h = 0.833 mm: f_res 0.9124 GHz, D 2.173 dBi (770,356 cells) | — | info | info |
| finest pair Δf_res | 0.182 % | < 0.500 % | pass |
| finest pair ΔD (0.95 GHz) | 0.004 dB | < 0.05 dB | pass |
| observed convergence order of f_res | below 0.2 (monotone, slow) | info (PEC edges and the feed gap are field singularities, so convergence is slower than O(h²)) | info |

## angular resolution

| Check | Value | Limit | Result |
|---|---|---|---|
| P_rad quadrature 12×24 vs 96×192 at 0.9500 GHz | 0.000 dB | < 0.01 dB | pass |
| P_rad quadrature 48×96 vs 96×192 at 0.9500 GHz | 0.000 dB | < 0.01 dB | pass |
| D on 5° vs 1° display grid at 0.9500 GHz | 0.000 dB | < 0.05 dB | pass |
| P_rad quadrature 12×24 vs 96×192 at 1.0000 GHz | 0.000 dB | < 0.01 dB | pass |
| P_rad quadrature 48×96 vs 96×192 at 1.0000 GHz | 0.000 dB | < 0.01 dB | pass |
| D on 5° vs 1° display grid at 1.0000 GHz | 0.000 dB | < 0.05 dB | pass |

## termination

| Check | Value | Limit | Result |
|---|---|---|---|
| dipole Zin, end criterion -50 dB (2520 steps) vs -70 dB (3150 steps) | 2.344 % | info (band edges, where the excitation is -20 dB) | info |

## STEP patch vs openEMS

| Check | Value | Limit | Result |
|---|---|---|---|
| STEP-built vs primitive twin (same grid): max |ΔZin|/|Zin| | 0.00e+0 | < 1e-9 | pass |
| PEC edges STEP vs twin: 3116 vs 3116 | 0 | = 0 | pass |
| f_res (|S11| min) 2.3401 GHz (-27.5 dB) vs 2.3401 GHz (-27.5 dB) | 0.000 % | < 1.500 % | pass |
| max |ΔZin| / |Zin| over band | 0.181 % | < 5.000 % | pass |
| D at 2.3000 GHz: 6.677 vs 6.668 dBi | 0.009 dB | < 0.3 dB | pass |
| radiation efficiency at 2.3000 GHz: 0.9679 vs 0.9666 | 0.0013 | < 0.03 | pass |
| D at 2.3500 GHz: 6.759 vs 6.751 dBi | 0.009 dB | < 0.3 dB | pass |
| radiation efficiency at 2.3500 GHz: 0.9691 vs 0.9675 | 0.0016 | < 0.03 | pass |
| D at 2.4000 GHz: 6.824 vs 6.816 dBi | 0.008 dB | < 0.3 dB | pass |
| radiation efficiency at 2.4000 GHz: 0.9703 vs 0.9684 | 0.0019 | < 0.03 | pass |
| P_rad far field / Poynting box at 2.3000 GHz | 1.00017 | 1 ± 0.01 | pass |
| P_rad far field / Poynting box at 2.3500 GHz | 1.00011 | 1 ± 0.01 | pass |
| P_rad far field / Poynting box at 2.4000 GHz | 1.00005 | 1 ± 0.01 | pass |

## pattern metrics

| Check | Value | Limit | Result |
|---|---|---|---|
| dipole E-plane HPBW at 0.95 GHz (thin λ/2 dipole: 78°) | 78.10° | 78 ± 2° | pass |
| dipole φ = 0 cut vs openEMS at 0.9500 GHz (within 20 dB of peak) | 0.030 dB | < 0.3 dB | pass |
| dipole at 0.9500 GHz: HPBW φ=0 78.1°, φ=90 78.1°, F/B 0.0 dB | — | info | info |
| dipole φ = 0 cut vs openEMS at 1.0000 GHz (within 20 dB of peak) | 0.033 dB | < 0.3 dB | pass |
| dipole at 1.0000 GHz: HPBW φ=0 76.8°, φ=90 76.8°, F/B 0.0 dB | — | info | info |
| monopole φ = 0 cut vs openEMS at 1.0000 GHz (within 20 dB of peak) | 0.104 dB | < 0.3 dB | pass |
| monopole at 1.0000 GHz: HPBW φ=0 61.4°, φ=90 61.4°, F/B 10.4 dB | — | info | info |
| patch_step φ = 0 cut vs openEMS at 2.3000 GHz (within 20 dB of peak) | 0.117 dB | < 0.3 dB | pass |
| patch_step at 2.3000 GHz: HPBW φ=0 90.4°, φ=90 89.9°, F/B 14.3 dB | — | info | info |
| patch_step φ = 0 cut vs openEMS at 2.3500 GHz (within 20 dB of peak) | 0.120 dB | < 0.3 dB | pass |
| patch_step at 2.3500 GHz: HPBW φ=0 89.7°, φ=90 88.7°, F/B 14.9 dB | — | info | info |
| patch_step φ = 0 cut vs openEMS at 2.4000 GHz (within 20 dB of peak) | 0.120 dB | < 0.3 dB | pass |
| patch_step at 2.4000 GHz: HPBW φ=0 89.0°, φ=90 87.7°, F/B 15.6 dB | — | info | info |

## native vs wasm

| Check | Value | Limit | Result |
|---|---|---|---|
| dipole Zin, wasm ST (20.2 s, 3150 steps vs 3150) | 2.91e-15 | < 0.00001 | pass |
| D at 0.9500 GHz | 0.00e+0 | < 0.00001 dB | pass |
| D at 1.0000 GHz | 4.44e-16 | < 0.00001 dB | pass |


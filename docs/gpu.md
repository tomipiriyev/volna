# WebGPU time loop (M5)

The GPU backend replaces only the FDTD time loop. Everything else stays in
the C++ solver, compiled to wasm:

- grid, voxelization and material table;
- PML profiles, port setup and NF2FF box checks;
- post-processing: port DFTs, Z_in and S11, the far-field transform,
  P_rad, and the results JSON.

So a GPU result goes through exactly the same code as a CPU result, and
results from either backend have the same problem hash.

## Flow

1. `Solver.prepare()` (wasm) builds the problem as for a CPU run.
2. `gpuLayout()` and `gpuArray(name)` export everything the loop needs:
   - dimensions and dt;
   - packed 16-bit material ids and the (ca, cb, εr) table;
   - per-axis spacings;
   - CPML slabs and their (b, c) profiles;
   - port edges and lines;
   - NF2FF faces with accumulator offsets;
   - the source waveform g((n + ½)Δt) for every step.
3. `releaseTimeLoopStorage()` frees the CPU field and ψ arrays.
4. `app/src/gpu/gpuFdtd.ts` uploads once and runs `app/src/gpu/fdtd.wgsl`.
5. `gpuFinish()` imports the outcome (`Solver::importRun`):
   - the step count and termination reason;
   - the V and I series, at (n+1)Δt and (n+½)Δt;
   - the NF2FF accumulators, in `Nf2ff::exportAcc()` layout with the Δt
     factor included.

   It then calls `finish()`. A native test imports a CPU run into a fresh
   solver and checks that the post-processed results are bit-identical.

## Kernels (per step, in the C++ order)

1. `updateH`
2. `cpmlH`: one dispatch per slab, in face order. Corners get the
   per-axis corrections in the same order as the CPU.
3. `portCurrent`
4. `twiddle`: cos/sin of the DFT phase of this step, for every frequency
5. `nf2ff` (H)
6. `updateE`
7. `cpmlE`
8. `portVoltage`: source injection, then V
9. `nf2ff` (E)
10. `advance`

After each chunk of `checkEvery` steps (the C++ value):

- `fold` moves the chunk's DFT sums into Kahan-compensated totals.
- `energy` reduces the field energy into per-workgroup partials.
- `energyCheck` applies the C++ termination rule: peak tracking; stop at
  ≤ target dB once the pulse is over; stop at the step cap. It sets a done
  flag in the state buffer.

**Pipelining.** Once the flag is set, every step kernel is a no-op. The
host therefore keeps two chunks in flight and only reads 32 bytes of state
per chunk, and the run still stops at the step the C++ loop would.

**Buffers.** Fields are one storage buffer (6N floats). Bindings stay within
the WebGPU defaults: 7 storage buffers and 2 uniforms per stage, with
per-dispatch parameters at a dynamic uniform offset.

## Precision

- **Fields** are float32 on both backends. Metal may contract `a·b + c`
  into FMA, while the native build uses `-ffp-contract=off`, so the
  backends agree to rounding rather than bit for bit.
- **DFT phase.** The phase is an exact u32 fraction of a turn per half
  step. That quantizes the frequency by Δt⁻¹·2⁻³² (a few hundred Hz). Sums
  run per chunk in f32 and are then folded into Kahan totals. With
  ≤ 1000 steps per chunk, the f32 error stays near 1e-6 even if the compiler
  weakens the compensation.
- **Port V and I** are computed per step in f32 and stored per step. Their
  DFT runs on the CPU in double.
- **Energy** for termination is summed in f32 in units of ε₀·mm³. Only its
  ratio to the peak matters.

## Conformal conductors

The `cutFaces` kernel runs right after the bulk H update, as on the CPU: for each
cut face, H ← c₀H + Σc_i E_i. `Solver::gpuUints("cutIdx")` gives the flat `F`
indices of H and its four edges (stored in `META`), and `gpuFloats("cutCoef")` the
five coefficients (stored in `C`). The self-test and the complete-run comparison
include a conformal metal dipole.

## Measured (2026-10-26, Apple M1, Chrome new headless, Metal)

The Solver tab's "GPU self-test" and "GPU vs CPU, complete runs" buttons
produce these numbers. `app/e2e/m5-webgpu.spec.ts` checks them.

| Check | λ/2 dipole (222,180 cells) | STEP patch (390,400 cells) | Tolerance |
|---|---|---|---|
| Fields after 1000 steps, ‖ΔE‖/‖E‖ | 8.6e-7 | 4.3e-7 | 1e-4 |
| Fields after 1000 steps, ‖ΔH‖/‖H‖ | 9.7e-7 | 1.9e-7 | 1e-4 |
| Complete run: steps (CPU / GPU) | 3,150 / 3,150 | 23,652 / 23,652 | — |
| Complete run: max \|ΔZ_in\|/\|Z_in\| over the band | < 1e-6 | 1e-6 | 0.5% |
| Complete run: max ΔD | < 1e-4 dB | < 1e-4 dB | 0.02 dB |
| Throughput, 1000 steps (CPU 8 threads → WebGPU) | 51–82 → 306–404 Mcells/s | 67–91 → 231–266 Mcells/s | — |
| Complete run, CPU → WebGPU | 9.7–13.1 s → 2.0–2.3 s (×4.2–6.4) | 109–116 s → 37.1 s (×3.1) | — |

The ranges span the runs made while developing and testing. The CPU
timing in the browser varies more than the GPU's: background load, and
whether the e2e runs alone. The final patch time includes the pipelined
termination. Before that, waiting for every energy value cost about 45 ms
per check and gave 42–46 s.

The patch gains less than the dipole. It has three far-field frequencies on
a larger Huygens box, and its many short k-rows (62 nodes) use the
64-thread workgroups less well. A flat 1D dispatch was tried and was slower
because of the index arithmetic, so it was reverted.

Differences are relative to the norm of the whole E or H field. Hz of a
z-directed dipole is physically zero and holds only rounding noise, so
comparing it with itself would mean nothing. The patch has every component
present and checks Hz properly.

## Limits and failure handling

- **Device limits.** The device is requested with
  `maxStorageBufferBindingSize` and `maxBufferSize` large enough for the
  largest buffer (normally the fields, 24 bytes per node). If the adapter
  offers less, the run is refused with `GPU_LIMITS`, the size needed and the
  adapter limit.
- **Device loss.** If the device is lost mid-run, the run stops with
  `GPU_DEVICE_LOST`. The Simulate panel then offers "Run on the CPU
  instead". The e2e exercises this with the test hook `?gpuLoseDevice=N`,
  which destroys the device after N steps.
- **PMC faces** (used only by the TEM benchmark) are not implemented on the
  GPU; such problems are refused with `GPU_UNSUPPORTED`.
- **CPU memory.** The CPU still allocates its field arrays during
  `prepare()` and frees them right after the upload. Peak wasm memory is
  therefore the same as for a CPU run.
- **Availability.** WebGPU needs a secure context and a supporting browser.
  Without it the option is disabled with the reason, and the CPU solver
  always works.
- **Testing.** Playwright's default headless shell has no WebGPU adapter.
  The M5 spec uses `channel: 'chromium'` (new headless), which exposes the
  real GPU. SwiftShader, Chrome's CPU implementation of WebGPU, can be
  enabled with `--enable-unsafe-webgpu` but is slow.

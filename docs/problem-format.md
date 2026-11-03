# Solver problem format (JSON)

The native CLI (`antsim_cli run problem.json`) and the wasm
`Solver.prepare()` both read this format, and so does the openEMS
cross-check runner (`validation/openems/run_problem.py`). Coordinates are in
drawing units; `unit` converts them to metres. The parser lives in
`cpp/src/api/problem.cpp`; it rejects unknown materials, bad ranges and
malformed JSON with a message that names the field.

```jsonc
{
  "unit": 0.001,                          // metres per drawing unit
  "grid": { "x": [...], "y": [...], "z": [...] },   // node lines, strictly increasing
  //  or  { "uniform": { "min": [x,y,z], "max": [x,y,z], "cell": 1.0 | [dx,dy,dz] } }
  "boundaries": "cpml",                   // or 6 entries: xmin xmax ymin ymax zmin zmax (cpml | pec | pmc)
  "pml": { "cells": 8, "order": 3, "sigmaFactor": 1, "alphaMax": 0 },
  "materials": [ { "name": "sub", "epsR": 3.38, "sigma": 0.0005 },
                 { "name": "copper", "type": "metal", "conductivity": 5.8e7 } ],
  "objects": [
    { "type": "box", "material": "pec", "min": [x,y,z], "max": [x,y,z], "priority": 0 },
    { "type": "cylinder", "material": "sub", "axis": "z", "center": [x,y], "radius": r, "range": [z0,z1] },
    { "type": "mesh", "material": "pec" | "<name>", "name": "arm", "priority": 0,
      "positions": "<base64 float32 LE>" | [x,y,z, ...], "indices": "<base64 uint32 LE>" | [i,j,k, ...] },
    { "type": "sheet", "material": "pec", "name": "patch", "axis": 2, "coord": 1.524,
      "thickness": 0.035, "currentFaces": 1,    // metal sheets only
      "positions": ..., "indices": ... },
    { "type": "box", "material": "copper", "min": [0,0,0], "max": [0,0,30], "radius": 0.5 },   // metal wire
    { "type": "mesh", "material": "copper", "wire": { "axis": 2, "radius": 0.45 }, "positions": ..., "indices": ... }
  ],
  "port": { "start": [x,y,z], "stop": [x,y,z], "axis": "z", "resistance": 50, "amplitude": 1 },
  "excitation": { "fMin": 0.5e9, "fMax": 1.5e9 },
  "metalLossFrequency": 0,                // Hz for the metal surface resistance; 0 = sqrt(fMin fMax)
  "conformal": false,                     // conductors off the grid lines: conformal faces, not staircases
  "portFrequencies": 401,
  "farField": { "frequencies": [1e9], "marginCells": 4, "thetaStep": 2, "phiStep": 2, "quadTheta": 48, "quadPhi": 96 },
  "termination": { "energyDb": -60, "maxSteps": 200000 },
  "courant": 0.99,
  "threads": 0
}
```

## Notes

- **Material names.** `pec` is reserved for the perfect conductor; `vacuum`
  is reserved too. Names must be unique.
- **Conformal.** With `conformal`, meshes, cylinders and boxes with volume keep
  their true shape in the cells they cut (docs/physics.md). If anything is cut,
  the Courant number becomes at most 0.8. The results' mesh report gains
  `conformal` with the cut faces, capped faces and the update's largest eigenvalue.
- **Metals.** `"type": "metal"` with a positive `conductivity` (S/m) makes a
  conductor with skin-effect loss (docs/physics.md, "Conductor loss"); it is
  voxelized like `pec`. A metal wire box (zero extent on two axes) needs its
  physical `radius`. A metal sheet takes an optional `thickness` (default 0:
  thick compared with the skin depth) and `currentFaces` (2: both faces,
  default; 1: one face). A mesh that is a straight round wire may give
  `"wire": {"axis", "radius"}`, and cylinder primitives at least two
  diameters long count as round wires; without `conformal` their loss is calibrated to the round
  wire's resistance per length. Sheets must be `pec` or a metal.
- **Degenerate boxes.** A box with min = max on one axis is a sheet, and on
  two axes a wire. Both must lie on grid lines to have any effect.
- **Port placement.** `start` is the reference side and `stop` the signal
  side along `axis`. Both must lie on grid lines. A port spanning a range
  across its axis, as in the TEM benchmark, becomes a sheet port of parallel
  lines.
- **Far field.** Needs CPML on all six faces. The NF2FF box sits
  `marginCells` inside the PML on every face and must not intersect the
  structure.

## Triangle-mesh objects (M3)

`mesh` and `sheet` objects carry a triangle mesh in drawing units, either as
JSON arrays or as base64 of little-endian float32 positions and uint32
indices (the app sends base64). The voxelizer
(`cpp/src/geometry/voxelize.cpp`) needs:

- **`mesh`**: a closed, consistently oriented surface (inside-out meshes are
  accepted; the winding sign is detected). Several shells may overlap.
  - **PEC**: an edge is PEC when at least half of its length lies inside the
    solid. Coverage is the union of four rays offset by 10⁻³ of the edge
    tolerance around the edge line, so faces lying exactly on grid lines
    count as inside. A box mesh rasterizes exactly like the `box`
    primitive.
  - **Dielectric**: a cell takes the material when its centre is inside;
    edge permittivity is the average of the four adjacent cells, as for
    primitives.
- **`sheet`**: a zero-thickness PEC sheet on the plane `axis` = `coord`,
  which must be within half a cell of a grid line (it is snapped to the
  nearest one, and the distance is reported). The triangles give the
  footprint: an in-plane edge is PEC when both ends and its midpoint lie
  inside the footprint. Only PEC sheets are allowed.

Overlap rules: PEC always wins. Dielectric cells claimed by two objects of
equal `priority` produce a `DIELECTRIC_OVERLAP` error; otherwise the higher
priority wins. Every object reports its PEC edge or cell count, and an
object that rasterizes to nothing gets an `OBJECT_EMPTY` warning.

## Results JSON

`run`:
- `steps`, `dt`, `finalEnergyDb`
- `terminatedBy`: `energy` or `maxSteps`
- `cells`, `memoryBytes`, `seconds`, `threads`, `mcellsPerSec`

`port` (one array per quantity, over the port frequencies):
- `frequencies`
- `zinRe`, `zinIm`
- `s11Re`, `s11Im`
- `pAcc`, `pInc`
- `sourceDb`

`farField[]` (one entry per far-field frequency):
- `pRad` (quadrature) and `pRadPoynting`
- `directivityDbi`, `gainDbi`, `realizedGainDbi`, `efficiency`
- `beamThetaDeg`, `beamPhiDeg`
- `s11Db`
- optional patterns: `thetaDeg`, `phiDeg`, `directivityPattern` (linear,
  theta-major) and complex `eTheta*` / `ePhi*`

`warnings`: a list of strings.

`mesh` (voxelization report, also returned by the wasm `prepare()` as
`report`):
- `objects[]`: `name`, `kind`, `material`, `pecEdges`, `cells`,
  `snapDistance` (metres)
- `overlaps[]`: `a`, `b`, `cells`
- `pecEdges`, `minCell`, `maxCell` (metres)
- `dcConnected`: whether the port's two terminals are joined by PEC edges
  (`null` without a port)
- `diagnostics[]`: `code`, `severity` (`info`, `warning`, `error`) and
  `message`. Codes: `SHEET_SNAPPED`, `OBJECT_EMPTY`, `DIELECTRIC_OVERLAP`,
  `PORT_FLOATING`, `PORT_DC_PATH`.

All phasors use e^{jωt} with peak amplitudes, scaled by the DFT time step.
Ratios such as Z_in, S11, D, G and efficiency are independent of that
scaling.

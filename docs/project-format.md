# Project file format (`.antsim`)

A project is a ZIP archive containing:

| Entry | Contents |
|---|---|
| `project.json` | Project data (below), UTF-8 JSON |
| `model.step` | The original STEP bytes, unmodified. Present unless the user saved without embedding. |
| `results/<id>.json` | Optional (M4): one saved result each, the solver's results JSON including patterns. |

## Version 1 (`formatVersion: 1`)

```jsonc
{
  "format": "antsim-project",
  "formatVersion": 1,
  "appVersion": "0.1.0",
  "savedAt": "2026-10-25T16:00:00.000Z",
  "importer": { "id": "occt-import-js", "version": "0.0.23" },
  "source": { "fileName": "patch_fr4.step", "sha256": "…", "embedded": true },
  "units": { "override": null, "confirmed": true },          // override: "mm" | "in" | … | null
  "assignments": [
    { "ref": { "bodyId": "b:0:1", "fingerprint": { "area": …, "centroid": […], "bbox": {…}, "faceCount": 6 } },
      "assignment": { "role": "dielectric", "materialId": "openems-patch", "priority": 0 } },
    { "ref": {…},
      // Optional on conductors (absent = PEC, and sheet current on both faces):
      "assignment": { "role": "radiator", "priority": 0, "conductor": { "kind": "metal", "name": "Silver", "sigma": 6.3e7 }, "sheetCurrent": "one" } }
  ],
  "materials": [ { "id": "…", "name": "…", "epsR": 3.38, "loss": { "kind": "tanDelta", "tanDelta": 0.001, "fRef": 2.45e9 } } ],
  "port": { "signal": {…ref}, "reference": {…ref}, "axis": 2, "lateral": [-6, 0], "anchor": 0.78, "z0": 50, "amplitude": 1 },
  "frequency": { "fMin": 1.5e9, "fMax": 3.5e9, "farField": [2.4e9], "cellsPerWavelength": 20 },
  // Optional, added in M4 within v1 (older readers ignore them):
  "simulation": { "mesh": { "maxRatio": 1.3, "paddingWavelengths": 0.25, "pmlCells": 8, … }, "memoryLimitMb": 1024, "energyDb": -60, "maxSteps": 200000 },
  "results": [ { "id": "run-…", "label": "patch_fr4.step · 16:20:11", "hash": "<SHA-256 of the problem JSON>",
                 "finishedAt": 1761400000000, "lossless": false, "center": [0, 0, 0.8] } ]
}
```

## Stable references

- **Body ids.** An id is `b:<node path>:<mesh index>`. It is deterministic
  for a given file and importer version.
- **Fingerprints.** Each reference also stores a fingerprint: surface area,
  centroid, bounding box and face count, in imported millimetres.

When a project opens:
1. A reference resolves if its id exists and the fingerprint matches within a
   relative tolerance of 1e-4.
2. Otherwise the app looks for an unused body with a matching fingerprint.
   This covers a re-exported or reordered STEP file, or a changed importer.
3. A reference that still doesn't resolve is dropped and reported.

## Embedded vs external STEP

- **Embedded (default).** The project is self-contained and reproducible.
- **External.** The user must select the STEP file together with the
  `.antsim` file.
- **Changed STEP.** In either case, if the SHA-256 of the STEP file differs
  from `source.sha256`, the app warns and re-matches by fingerprint.

## Results (M4)

- **What is saved.** With "results" ticked next to Save project, every run
  in the session history is saved. Each run's metadata goes in
  `project.json`, and its data in `results/<id>.json`: the solver's results
  JSON with port spectra, far-field summaries and full patterns. JSON
  numbers round-trip doubles exactly. The one exception is negative zero,
  which JSON stores as 0.
- **What counts as current.** A result carries the SHA-256 of the problem
  JSON it was computed from.
  - On opening, saved results are listed as "from file". They never count
    as current on their own.
  - Validating the project builds the problem again. If its hash matches,
    the result becomes current.
  - Any difference in geometry, roles, materials, feed, band, mesh or
    simulation settings, or tessellation, keeps it marked stale.
- **Simulation settings** are saved alongside, so an unchanged project
  reproduces the same problem.
- **Sizes.** A 3-frequency run with patterns is about 5 MB of JSON before
  ZIP compression. Untick "results" to save a small project.
- **Unreadable data.** A missing or unreadable result file is skipped with
  a warning; the rest of the project opens.

## Versioning

`migrateProject` accepts every known version and upgrades it step by step.
It rejects files whose `formatVersion` is newer than the app supports.

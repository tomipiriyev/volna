# Third-party components

| Component | Version | License | How it is used |
|---|---|---|---|
| React, React DOM | 19.3 | MIT | UI |
| three.js | 0.186 (r186) | MIT | 3D rendering (from M1a) |
| three-mesh-bvh | 0.9 | MIT | Picking and distance queries (from M1a) |
| zustand | 5 | MIT | Project state (from M1a) |
| fflate | 0.8 | MIT | `.antsim` project ZIP (from M1a) |
| occt-import-js | 0.0.23 | LGPL-2.1 | STEP import. Shipped unmodified as separate files in `vendor/occt-import-js/` (wasm + loader, ES-module export line appended by `scripts/vendor-occt.mjs`), loaded at runtime by the CAD worker. |
| Open CASCADE Technology (inside occt-import-js) | per occt-import-js | LGPL-2.1 with OCCT exception | STEP parsing and tessellation |
| doctest | 2.5.3 | MIT | C++ unit tests (build-time only) |
| Emscripten runtime (generated glue) | 6.0.13 | MIT / UIUC | wasm loader code |

Validation-only tools, which are run natively and never distributed:

| Tool | Version | License |
|---|---|---|
| openEMS | 0.37 | GPL-3.0 |

License texts: `LGPL-2.1-occt-import-js.txt`, `LGPL-2.1-OCCT.txt`. They are
also shipped next to the vendored files.

The LGPL components are not bundled into application code. They are
separate files loaded at runtime, so users can replace them with a modified
build. Source: https://github.com/kovacsv/occt-import-js (release 0.0.23)
and the OCCT revision it pins. This note is not legal advice.

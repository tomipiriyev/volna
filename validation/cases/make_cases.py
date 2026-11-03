"""Writes the M2 validation problems (antsim problem JSON, explicit grid lines).

    python3 validation/cases/make_cases.py

Both antsim and openEMS (validation/openems/run_problem.py) run exactly these
grid lines, objects and port, so differences come from the solvers, not the
discretisation. Geometry uses PEC lines and sheets that map onto Yee edges
unambiguously in both codes.

  dipole    half-wave wire dipole along z, 1-cell (2.5 mm) feed gap, ~1 GHz
  monopole  quarter-wave wire monopole on a 300 x 300 mm (1 lambda) PEC sheet ground

Variants:
  dipole_pml16, dipole_pad2   PML 16 cells / twice the structure-to-PML clearance
                              (absorbing-boundary sensitivity, same geometry)
  dipole_sq_h<h>              dipole with 5 x 5 mm solid square arms at feed-region
                              cells of 2.5, 1.25 and 0.833 mm (mesh refinement; a
                              1D wire would change its effective radius with the
                              cell size, a solid arm keeps its cross-section)
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
F_MIN, F_MAX = 0.5e9, 1.5e9
H_MAX = 10.0  # mm, lambda_min / 20 at 1.5 GHz
RATIO = 1.3


def grow(start, end, h0, h_max=H_MAX, ratio=RATIO):
    """Lines from `start` towards `end` (exclusive of start), steps growing from h0 by `ratio` up to h_max."""
    sgn = 1 if end > start else -1
    out, x, h = [], start, h0
    while True:
        h = min(h * ratio, h_max)
        if abs(end - x) <= h * 1.5:
            out.append(end)
            return out
        x += sgn * h
        out.append(x)


def uniform(a, b, h):
    n = max(1, round((b - a) / h))
    return [a + (b - a) * i / n for i in range(n + 1)]


def axis_lines(fine_lo, fine_hi, h_fine, dom_lo, dom_hi, pml_cells, extra_fixed=()):
    """Fine uniform core, graded to H_MAX out to the domain edge, then PML cells of H_MAX."""
    core = uniform(fine_lo, fine_hi, h_fine)
    hi = grow(fine_hi, dom_hi, h_fine)
    lo = grow(fine_lo, dom_lo, h_fine)
    lines = sorted(set([round(v, 6) for v in lo + core + hi]))
    # Snap extra fixed coordinates (e.g. ground edges) by inserting them and removing close neighbours.
    for f in extra_fixed:
        lines = [v for v in lines if abs(v - f) > 0.3 * H_MAX or abs(v - f) < 1e-9] + [f]
        lines = sorted(set(round(v, 6) for v in lines))
    pml_lo = [lines[0] - H_MAX * (i + 1) for i in range(pml_cells)]
    pml_hi = [lines[-1] + H_MAX * (i + 1) for i in range(pml_cells)]
    return sorted(pml_lo) + lines + pml_hi


def base(name, x, y, z, pml_cells, objects, port, ff):
    return {
        "name": name,
        "unit": 1e-3,
        "grid": {"x": x, "y": y, "z": z},
        "boundaries": "cpml",
        "pml": {"cells": pml_cells},
        "objects": objects,
        "port": port,
        "excitation": {"fMin": F_MIN, "fMax": F_MAX},
        "portFrequencies": 201,
        "farField": {"frequencies": ff, "marginCells": 4, "thetaStep": 2, "phiStep": 2, "quadTheta": 48, "quadPhi": 96},
        "termination": {"energyDb": -70, "maxSteps": 200000},  # strict: band-edge DFT truncation < 0.2 %
        "courant": 0.99,
    }


def dipole(h=2.5, pml=8, pad=110.0):
    # Arms: z in [-72.5, 0] and [2.5, 75] (gap edge 0 .. 2.5); 147.5 mm tip to tip.
    zt, zb = 75.0, -72.5
    x = axis_lines(-2 * h, 2 * h, h, -pad, pad, pml)
    z = axis_lines(zb - 2 * h, zt + 2 * h, h, zb - pad, zt + pad, pml)
    objects = [
        {"type": "box", "material": "pec", "min": [0, 0, zb], "max": [0, 0, 0]},
        {"type": "box", "material": "pec", "min": [0, 0, 2.5], "max": [0, 0, zt]},  # same 2.5 mm gap at every resolution
    ]
    port = {"start": [0, 0, 0], "stop": [0, 0, 2.5], "axis": "z", "resistance": 50, "amplitude": 1}
    return x, x, z, objects, port, [0.95e9, 1.0e9]


def dipole_square(h=2.5, pml=8, pad=110.0):
    zt, zb, a = 75.0, -72.5, 2.5  # arms 5 x 5 mm, same 2.5 mm gap
    x = axis_lines(-(a + 2 * h), a + 2 * h, h, -pad, pad, pml)
    z = axis_lines(zb - 2 * h, zt + 2 * h, h, zb - pad, zt + pad, pml)
    objects = [
        {"type": "box", "material": "pec", "min": [-a, -a, zb], "max": [a, a, 0]},
        {"type": "box", "material": "pec", "min": [-a, -a, 2.5], "max": [a, a, zt]},
    ]
    port = {"start": [0, 0, 0], "stop": [0, 0, 2.5], "axis": "z", "resistance": 50, "amplitude": 1}
    return x, x, z, objects, port, [0.95e9, 1.0e9]


def dipole_round(h=2.5, pml=8, pad=110.0):
    # Round metal arms of radius 3.7 mm, which fall between grid lines at every resolution
    # (the conformal conductor case), same 2.5 mm gap. Conductivity 1e5 S/m makes the loss visible.
    zt, zb, r = 75.0, -72.5, 3.7
    fine = (math.ceil(r / h) + 2) * h  # a whole number of cells, so a grid line runs through the feed
    x = axis_lines(-fine, fine, h, -pad, pad, pml)
    z = axis_lines(zb - 2 * h, zt + 2 * h, h, zb - pad, zt + pad, pml)
    objects = [
        {"type": "cylinder", "material": "metal", "axis": "z", "center": [0, 0], "radius": r, "range": [zb, 0]},
        {"type": "cylinder", "material": "metal", "axis": "z", "center": [0, 0], "radius": r, "range": [2.5, zt]},
    ]
    port = {"start": [0, 0, 0], "stop": [0, 0, 2.5], "axis": "z", "resistance": 50, "amplitude": 1}
    return x, x, z, objects, port, [0.95e9, 1.0e9]


def dipole_hat(h=2.5, pml=8, pad=110.0):
    # Square-arm dipole with 40 x 40 x 5 mm metal top-hats, whose shape sets the resonance. On the
    # grid here (the axis-aligned twin); the validation runner rotates the hats about the feed axis.
    zt, zb, hat, w, tk, fine = 50.0, -47.5, 20.0, 2.5, 5.0, 32.5
    x = axis_lines(-fine, fine, h, -(fine + pad - 30), fine + pad - 30, pml)
    z = axis_lines(zb - tk - 2 * h, zt + tk + 2 * h, h, zb - tk - pad, zt + tk + pad, pml)
    tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
    def plate(z0, z1):
        pts = [c for zz in (z0, z1) for xy in ((-hat, -hat), (hat, -hat), (hat, hat), (-hat, hat)) for c in (*xy, zz)]
        return {"type": "mesh", "material": "metal", "positions": pts, "indices": tris}
    objects = [
        {"type": "box", "material": "metal", "min": [-w, -w, zb], "max": [w, w, 0]},
        {"type": "box", "material": "metal", "min": [-w, -w, 2.5], "max": [w, w, zt]},
        plate(zt, zt + tk),
        plate(zb - tk, zb),
    ]
    port = {"start": [0, 0, 0], "stop": [0, 0, 2.5], "axis": "z", "resistance": 50, "amplitude": 1}
    return x, x, z, objects, port, [0.75e9, 0.85e9]


def monopole(h=2.5, pml=8, pad=110.0):
    g = 150.0  # half side of the 300 mm ground sheet
    zt = 72.5
    x = axis_lines(-2 * h, 2 * h, h, -(g + pad), g + pad, pml, extra_fixed=(-g, g))
    z = axis_lines(-2 * h, zt + 2 * h, h, -pad, zt + pad, pml)
    objects = [
        {"type": "box", "material": "pec", "min": [-g, -g, 0], "max": [g, g, 0]},
        {"type": "box", "material": "pec", "min": [0, 0, 2.5], "max": [0, 0, zt]},
    ]
    port = {"start": [0, 0, 0], "stop": [0, 0, 2.5], "axis": "z", "resistance": 50, "amplitude": 1}
    return x, x, z, objects, port, [1.0e9]


def write(name, parts, pml, **extra):
    x, y, z, objects, port, ff = parts
    d = os.path.join(HERE, name)
    os.makedirs(d, exist_ok=True)
    prob = {**base(name, x, y, z, pml, objects, port, ff), **extra}
    with open(os.path.join(d, "problem.json"), "w") as fh:
        json.dump(prob, fh, indent=1)
    cells = (len(x) - 1) * (len(y) - 1) * (len(z) - 1)
    print(f"{name}: {len(x)} x {len(y)} x {len(z)} lines, {cells:,} cells")


write("dipole", dipole(), 8)
write("dipole_pml16", dipole(pml=16), 16)
write("dipole_pad2", dipole(pad=220.0), 8)
for h, tag in ((2.5, "2.5"), (1.25, "1.25"), (2.5 / 3, "0.833")):
    write(f"dipole_sq_h{tag}", dipole_square(h=h), 8)
for h, tag in ((2.5, "2.5"), (1.25, "1.25"), (2.5 / 3, "0.833")):
    write(f"dipole_round_h{tag}", dipole_round(h=h), 8, conformal=True, materials=[{"name": "metal", "type": "metal", "conductivity": 1e5}])
for h, tag in ((2.5, "2.5"), (1.25, "1.25")):
    write(f"dipole_hat_h{tag}", dipole_hat(h=h), 8, materials=[{"name": "metal", "type": "metal", "conductivity": 1e5}])
write("monopole", monopole(), 8)

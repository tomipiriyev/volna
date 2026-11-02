"""Runs an antsim problem JSON in openEMS (native) and writes reference.json.

    source ~/opt/openEMS/venv/bin/activate
    python validation/openems/run_problem.py validation/cases/dipole/problem.json [out_dir]

Uses exactly the problem's grid lines, objects (boxes/cylinders, PEC or
dielectric), lumped port, excitation band, PML thickness, end criterion and
NF2FF box position (pml + marginCells inside each face), so a comparison with
antsim isolates solver differences. Supports the subset of the format used by
the validation cases.
"""
import json
import os
import sys
import tempfile
import time

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS

prob_path = sys.argv[1]
case_dir = os.path.dirname(os.path.abspath(prob_path))
out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(case_dir, "out")
os.makedirs(out_dir, exist_ok=True)
with open(prob_path) as fh:
    P = json.load(fh)
sim_path = os.path.join(os.environ.get("ANTSIM_OPENEMS_WORK", tempfile.gettempdir()), "antsim_oe_" + P.get("name", "case"))

unit = P.get("unit", 1e-3)
pml = P.get("pml", {}).get("cells", 8)
bnames = {"cpml": f"PML_{pml}", "pml": f"PML_{pml}", "pec": "PEC", "pmc": "PMC"}
bc = P.get("boundaries", "cpml")
bc = [bnames[bc]] * 6 if isinstance(bc, str) else [bnames[b] for b in bc]
f_min, f_max = P["excitation"]["fMin"], P["excitation"]["fMax"]
term = P.get("termination", {})

FDTD = openEMS(NrTS=int(term.get("maxSteps", 200000)), EndCriteria=10 ** (term.get("energyDb", -50) / 10))
FDTD.SetGaussExcite(0.5 * (f_min + f_max), 0.5 * (f_max - f_min))
FDTD.SetBoundaryCond(bc)
CSX = ContinuousStructure()
FDTD.SetCSX(CSX)
mesh = CSX.GetGrid()
mesh.SetDeltaUnit(unit)
lines = {a: np.array(P["grid"][a], dtype=float) for a in "xyz"}
for a in "xyz":
    mesh.SetLines(a, lines[a])

mats = {}
pec = CSX.AddMetal("pec")
for m in P.get("materials", []):
    mats[m["name"]] = CSX.AddMaterial(m["name"], epsilon=m.get("epsR", 1.0), kappa=m.get("sigma", 0.0))
for i, o in enumerate(P.get("objects", [])):
    prop = pec if o.get("material", "pec") == "pec" else mats[o["material"]]
    pri = 10 + o.get("priority", 0) if prop is pec else o.get("priority", 0)
    if o["type"] == "box":
        prop.AddBox(start=o["min"], stop=o["max"], priority=pri)
    elif o["type"] == "cylinder":
        ax = {"x": 0, "y": 1, "z": 2}.get(o["axis"], o["axis"])
        u, v = [a for a in range(3) if a != ax]
        s, e = [0.0] * 3, [0.0] * 3
        s[u] = e[u] = o["center"][0]
        s[v] = e[v] = o["center"][1]
        s[ax], e[ax] = o["range"]
        prop.AddCylinder(start=s, stop=e, radius=o["radius"], priority=pri)
    else:
        raise SystemExit(f"unsupported object type {o['type']}")

port = None
if "port" in P:
    q = P["port"]
    ax = {"x": 0, "y": 1, "z": 2}.get(q["axis"], q["axis"])
    port = FDTD.AddLumpedPort(1, q.get("resistance", 50.0), q["start"], q["stop"], "xyz"[ax], q.get("amplitude", 1.0), priority=5)

ffs = P.get("farField", {}).get("frequencies", [])
nf2ff = None
if ffs:
    margin = P["farField"].get("marginCells", 4)
    start = [float(lines[a][pml + margin]) for a in "xyz"]
    stop = [float(lines[a][len(lines[a]) - 1 - pml - margin]) for a in "xyz"]
    nf2ff = FDTD.CreateNF2FFBox(start=start, stop=stop)

t0 = time.time()
FDTD.Run(sim_path, cleanup=True, verbose=0)
seconds = time.time() - t0

ref = {"solver": "openEMS 0.37", "case": P.get("name"), "seconds": round(seconds, 1),
       "cells": int(np.prod([len(lines[a]) - 1 for a in "xyz"]))}
if port is not None:
    f = np.linspace(f_min, f_max, P.get("portFrequencies", 401))
    port.CalcPort(sim_path, f, ref_impedance=P["port"].get("resistance", 50.0))
    zin = port.uf_tot / port.if_tot
    ref["port"] = {"frequencies": f.tolist(), "zinRe": np.real(zin).tolist(), "zinIm": np.imag(zin).tolist()}
if nf2ff is not None:
    step_t = P["farField"].get("thetaStep", 2.0)
    step_p = P["farField"].get("phiStep", 2.0)
    theta = np.arange(0.0, 180.0 + 1e-9, step_t)
    phi = np.arange(0.0, 360.0 - 1e-9, step_p)
    res = nf2ff.CalcNF2FF(sim_path, ffs, theta, phi, center=[0, 0, 0], read_cached=False)
    pacc = None
    if port is not None:
        port.CalcPort(sim_path, np.array(ffs), ref_impedance=P["port"].get("resistance", 50.0))
        pacc = np.real(port.P_acc)
    ref["farField"] = []
    for n, fq in enumerate(ffs):
        E = res.E_norm[n]
        it, ip = np.unravel_index(np.argmax(E), E.shape)
        entry = {"frequency": fq, "directivityDbi": float(10 * np.log10(res.Dmax[n])), "pRad": float(res.Prad[n]),
                 "beamThetaDeg": float(theta[it]), "beamPhiDeg": float(phi[ip])}
        if pacc is not None:
            entry["pAcc"] = float(pacc[n])
            entry["efficiency"] = float(res.Prad[n] / pacc[n])
        # phi = 0 elevation cut, normalized directivity in dBi, for pattern comparison.
        D = res.Dmax[n] * (E / E.max()) ** 2
        entry["cutPhi0Dbi"] = (10 * np.log10(np.maximum(D[:, 0], 1e-12))).tolist()
        entry["thetaDeg"] = theta.tolist()
        ref["farField"].append(entry)

with open(os.path.join(out_dir, "reference.json"), "w") as fh:
    json.dump(ref, fh)
print(json.dumps({k: v for k, v in ref.items() if k not in ("port",)}, default=str)[:600])

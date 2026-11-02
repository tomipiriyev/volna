"""Generates the STEP test fixtures with FreeCAD (headless).

    /Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd validation/fixtures/step/generate_fixtures.py

Writes *.step next to this script. FreeCAD's headless STEP export keeps names
and units but drops colors, so colors are added afterwards as standard AP214
STYLED_ITEM / COLOUR_RGB entities. The inch fixture is built with inch-valued
coordinates and its length unit rewritten to CONVERSION_BASED_UNIT('INCH').
Dimensions are in millimetres unless stated. See README.md for each fixture's
purpose and the diagnostics it should produce.
"""
import os
import re

import FreeCAD as App
import Import
import Part

OUT = os.path.dirname(os.path.abspath(__file__))
V = App.Vector

COPPER = (0.85, 0.50, 0.20)
FR4 = (0.20, 0.55, 0.30)
GREY = (0.60, 0.60, 0.65)
BLUE = (0.25, 0.45, 0.85)


# ----------------------------------------------------------------------------
# STEP post-processing
# ----------------------------------------------------------------------------
ENTITY = re.compile(r"#(\d+)\s*=\s*(.*?);\s*\n", re.S)
SOLID_TYPES = ("MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "SHELL_BASED_SURFACE_MODEL")


def _parse(text):
    data = text[text.index("DATA;") : text.index("ENDSEC;", text.index("DATA;"))]
    ents = {}
    for m in ENTITY.finditer(data):
        body = m.group(2).strip()
        etype = body.split("(", 1)[0].strip() if not body.startswith("(") else "COMPLEX"
        ents[int(m.group(1))] = (etype, body)
    return ents


def _refs(body):
    return [int(r) for r in re.findall(r"#(\d+)", body)]


def _append(text, lines):
    end = text.rindex("ENDSEC;")
    return text[:end] + "".join(line + "\n" for line in lines) + text[end:]


def add_colors(path, colors):
    """colors: {product name: (r, g, b)} applied to the solids/shells of each product."""
    text = open(path).read()
    ents = _parse(text)
    nxt = max(ents) + 1
    styled, context, lines, matched = [], None, [], set()

    def find(etypes, ref):
        return [i for i, (t, b) in ents.items() if t in etypes and ref in _refs(b)]

    for pid, (t, b) in ents.items():
        if t != "PRODUCT":
            continue
        name = re.match(r"PRODUCT\s*\(\s*'([^']*)'", b).group(1)
        if name not in colors:
            continue
        reps = []
        pdf_types = ("PRODUCT_DEFINITION_FORMATION", "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE")
        for pdf in find(pdf_types, pid):
            for pd in find(("PRODUCT_DEFINITION",), pdf):
                for pds in find(("PRODUCT_DEFINITION_SHAPE",), pd):
                    for sdr in find(("SHAPE_DEFINITION_REPRESENTATION",), pds):
                        reps.append(_refs(ents[sdr][1])[-1])
        # Follow plain shape-representation relationships (not assembly placements).
        for rep in list(reps):
            for rid, (rt, rb) in ents.items():
                if rt == "SHAPE_REPRESENTATION_RELATIONSHIP" and rep in _refs(rb):
                    reps += [r for r in _refs(rb) if r != rep and r not in reps]
        items = []
        for rep in reps:
            context = _refs(ents[rep][1])[-1]
            items += [r for r in _refs(ents[rep][1]) if ents.get(r, ("",))[0] in SOLID_TYPES]
        if items:
            matched.add(name)
        r, g, bl = colors[name]
        for item in items:
            c, fac, fa, sfa, ss, su, psa, si = range(nxt, nxt + 8)
            nxt += 8
            lines += [
                f"#{c} = COLOUR_RGB('',{r:.4f},{g:.4f},{bl:.4f});",
                f"#{fac} = FILL_AREA_STYLE_COLOUR('',#{c});",
                f"#{fa} = FILL_AREA_STYLE('',(#{fac}));",
                f"#{sfa} = SURFACE_STYLE_FILL_AREA(#{fa});",
                f"#{ss} = SURFACE_SIDE_STYLE('',(#{sfa}));",
                f"#{su} = SURFACE_STYLE_USAGE(.BOTH.,#{ss});",
                f"#{psa} = PRESENTATION_STYLE_ASSIGNMENT((#{su}));",
                f"#{si} = STYLED_ITEM('color',(#{psa}),#{item});",
            ]
            styled.append(si)
    missing = set(colors) - matched
    if missing:
        raise RuntimeError(f"{path}: no solid or shell found for {sorted(missing)}")
    lines.append(
        f"#{nxt} = MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',("
        + ",".join(f"#{s}" for s in styled)
        + f"),#{context});"
    )
    open(path, "w").write(_append(text, lines))


def convert_unit_to_inch(path):
    """Rewrites the millimetre length unit as a conversion-based inch unit."""
    text = open(path).read()
    ents = _parse(text)
    mm = [i for i, (_, b) in ents.items() if re.search(r"LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*SI_UNIT\(\.MILLI\.,\.METRE\.\)", b)]
    if not mm:
        raise RuntimeError("no millimetre length unit found")
    nxt = max(ents) + 1
    lmwu, dims, base = nxt, nxt + 1, nxt + 2
    # Every representation context carries its own unit entity; rewrite all.
    for uid in mm:
        text = re.sub(
            rf"#{uid}\s*=\s*\(\s*LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*SI_UNIT\(\.MILLI\.,\.METRE\.\)\s*\)\s*;",
            f"#{uid} = ( CONVERSION_BASED_UNIT('INCH',#{lmwu}) LENGTH_UNIT() NAMED_UNIT(#{dims}) );",
            text,
        )
    text = _append(
        text,
        [
            f"#{lmwu} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#{base});",
            f"#{dims} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);",
            f"#{base} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );",
        ],
    )
    open(path, "w").write(text)


# ----------------------------------------------------------------------------
# Model helpers
# ----------------------------------------------------------------------------
def feature(doc, name, shape, parent=None):
    obj = doc.addObject("Part::Feature", name)
    obj.Shape = shape
    obj.Label = name
    if parent is not None:
        parent.addObject(obj)
    return obj


def export(doc, objs, filename, colors=None, inch=False):
    doc.recompute()
    path = os.path.join(OUT, filename)
    Import.export(objs, path)
    if colors:
        add_colors(path, colors)
    if inch:
        convert_unit_to_inch(path)
    App.closeDocument(doc.Name)
    print(f"wrote {filename}")


def box(dx, dy, dz, x, y, z):
    return Part.makeBox(dx, dy, dz, V(x, y, z))


def zcyl(r, z0, h, x=0.0, y=0.0):
    return Part.makeCylinder(r, h, V(x, y, z0), V(0, 0, 1))


# ----------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------
def dipole(filename="dipole.step", s=1.0, inch=False):
    """Center-fed dipole for ~2.4 GHz: two r=1 arms of 29 mm, 1 mm gap at the origin."""
    doc = App.newDocument("fx_dipole")
    a = feature(doc, "arm_top", zcyl(1.0 * s, 0.5 * s, 29.0 * s))
    b = feature(doc, "arm_bottom", zcyl(1.0 * s, -29.5 * s, 29.0 * s))
    export(doc, [a, b], filename, {"arm_top": COPPER, "arm_bottom": COPPER}, inch=inch)


def dipole_square():
    """Dipole with solid 5 x 5 mm square arms: z in [-72.5, 0] and [2.5, 75] (validation case dipole_sq_*)."""
    doc = App.newDocument("fx_dipole_square")
    a = feature(doc, "arm_top", box(5, 5, 72.5, -2.5, -2.5, 2.5))
    b = feature(doc, "arm_bottom", box(5, 5, 72.5, -2.5, -2.5, -72.5))
    export(doc, [a, b], "dipole_square.step", {"arm_top": COPPER, "arm_bottom": COPPER})


def monopole():
    """Quarter-wave monopole (r=1, h=29) 1 mm above a 125 x 125 x 1 mm ground plate."""
    doc = App.newDocument("fx_monopole")
    g = feature(doc, "ground_plane", box(125, 125, 1, -62.5, -62.5, -1))
    m = feature(doc, "monopole", zcyl(1.0, 1.0, 29.0))
    export(doc, [g, m], "monopole_ground.step", {"ground_plane": GREY, "monopole": COPPER})


def patch():
    """openEMS 'Simple Patch Antenna' geometry with 35 um copper solids.

    Substrate 60 x 60 x 1.524 (epsR 3.38), patch 32 (x) x 40 (y), ground 60 x 60.
    The feed is a lumped port from ground to patch at x = -6, y = 0.
    """
    doc = App.newDocument("fx_patch")
    sub = feature(doc, "substrate", box(60, 60, 1.524, -30, -30, 0))
    gnd = feature(doc, "ground", box(60, 60, 0.035, -30, -30, -0.035))
    pat = feature(doc, "patch", box(32, 40, 0.035, -16, -20, 1.524))
    export(doc, [sub, gnd, pat], "patch_fr4.step", {"substrate": FR4, "ground": COPPER, "patch": COPPER})


def patch_sheets():
    """Same patch with zero-thickness copper: patch and ground are planar faces, not solids."""
    doc = App.newDocument("fx_patch_sheets")
    sub = feature(doc, "substrate", box(60, 60, 1.524, -30, -30, 0))
    gnd = feature(doc, "ground_sheet", Part.makePlane(60, 60, V(-30, -30, 0)))
    pat = feature(doc, "patch_sheet", Part.makePlane(32, 40, V(-16, -20, 1.524)))
    export(doc, [sub, gnd, pat], "patch_sheets.step", {"substrate": FR4})


def assembly():
    """Nested assembly with a rotated sub-assembly and two linked instances of one part."""
    doc = App.newDocument("fx_assembly")
    top = doc.addObject("App::Part", "antenna_assembly")
    pcb = doc.addObject("App::Part", "pcb")
    top.addObject(pcb)
    feature(doc, "pcb_substrate", box(40, 20, 1.6, -20, -10, 0), pcb)
    feature(doc, "trace", box(30, 2, 0.035, -15, -1, 1.6), pcb)
    pcb.Placement = App.Placement(V(0, 0, 2), App.Rotation(V(0, 0, 1), 90))
    shell = box(50, 30, 12, -25, -15, -2).cut(box(48, 28, 11, -24, -14, -1))
    feature(doc, "radome", shell, top)
    standoff = feature(doc, "standoff", zcyl(1.5, -2, 4))
    standoff.Visibility = False
    for i, x in enumerate((-8.0, 8.0)):
        link = doc.addObject("App::Link", f"standoff_{i + 1}")
        link.LinkedObject = standoff
        link.Placement = App.Placement(V(x, 0, 0), App.Rotation())
        top.addObject(link)
    export(doc, [top], "assembly_nested.step", {"radome": BLUE, "pcb_substrate": FR4, "trace": COPPER})


def open_shell():
    """A box with its top face removed: an open shell, not a solid."""
    doc = App.newDocument("fx_open_shell")
    faces = Part.makeBox(10, 10, 10).Faces
    top = max(faces, key=lambda f: f.CenterOfMass.z)
    shell = Part.Shell([f for f in faces if not f.isSame(top)])
    o = feature(doc, "open_box", shell)
    export(doc, [o], "open_shell.step")


def overlapping_dielectrics():
    """Two dielectric blocks whose volumes overlap (ambiguous material without priority)."""
    doc = App.newDocument("fx_overlap")
    a = feature(doc, "dielectric_a", box(20, 20, 5, 0, 0, 0))
    b = feature(doc, "dielectric_b", box(20, 20, 5, 10, 0, 2))
    export(doc, [a, b], "overlap_dielectrics.step", {"dielectric_a": FR4, "dielectric_b": BLUE})


def unsupported_thin():
    """A 35 um plate tilted 30 deg about x (oblique sheet) and an r=0.1 mm wire along x."""
    doc = App.newDocument("fx_thin")
    plate = box(30, 20, 0.035, -15, -10, 0)
    plate.rotate(V(0, 0, 0), V(1, 0, 0), 30)
    p = feature(doc, "tilted_plate", plate)
    w = feature(doc, "thin_wire", Part.makeCylinder(0.1, 20, V(-10, 0, 10), V(1, 0, 0)))
    export(doc, [p, w], "thin_features.step", {"tilted_plate": COPPER})


# freecadcmd may evaluate the file more than once; generate only once per process.
if not getattr(App, "_antsim_fixtures_done", False):
    App._antsim_fixtures_done = True
    dipole()
    dipole("dipole_inch.step", s=1 / 25.4, inch=True)
    dipole_square()
    monopole()
    patch()
    patch_sheets()
    assembly()
    open_shell()
    overlapping_dielectrics()
    unsupported_thin()

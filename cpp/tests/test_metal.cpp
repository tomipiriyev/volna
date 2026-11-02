#include "doctest.h"

#include "antsim/constants.hpp"
#include "antsim/metal.hpp"
#include "antsim/problem.hpp"
#include "antsim/solver.hpp"

#include <cmath>
#include <map>
#include <vector>

using namespace antsim;

namespace {

ObjectSpec box(std::array<double, 3> lo, std::array<double, 3> hi, const std::string& material) {
    ObjectSpec o;
    o.kind = ObjectSpec::Kind::Box;
    o.min = lo;
    o.max = hi;
    o.material = material;
    return o;
}

// Rectangular sheet object on the plane z = zc covering [x0, x1] x [y0, y1].
ObjectSpec sheet(double x0, double x1, double y0, double y1, double zc, const std::string& material, int faces) {
    ObjectSpec o;
    o.kind = ObjectSpec::Kind::Sheet;
    o.material = material;
    o.axis = 2;
    o.coord = zc;
    o.sheetFaces = faces;
    o.positions = {float(x0), float(y0), float(zc), float(x1), float(y0), float(zc), float(x1), float(y1), float(zc), float(x0), float(y1), float(zc)};
    o.indices = {0, 1, 2, 0, 2, 3};
    return o;
}

MaterialSpec metal(const std::string& name, double sigma) {
    MaterialSpec m;
    m.name = name;
    m.metal = true;
    m.conductivity = sigma;
    return m;
}

// 12^3 closed PEC box of 1 mm cells, no port.
Problem smallBox() {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(12, 12, 12, 1, 1, 1);
    p.boundaries.fill(Boundary::Pec);
    p.fMin = 1e9;
    p.fMax = 4e9;
    p.metalLossFrequency = 2e9;
    return p;
}

double sigmaAt(const YeeFields& f, int c, int i, int j, int k) { return f.materials.sigma[f.M(c)[f.idx(i, j, k)]]; }

} // namespace

TEST_CASE("skin-effect formulas: limits, identities and continuity") {
    const double cu = 5.8e7, f = 1e9;
    const double d = skinDepth(cu, f), rs = surfaceResistance(cu, f);
    CHECK(d == doctest::Approx(2.0897e-6).epsilon(1e-3)); // copper at 1 GHz
    CHECK(rs == doctest::Approx(1.0 / (cu * d)).epsilon(1e-12));
    // Sheets: thick limits (R_s / 2 with both faces, R_s with one) and the DC limit 1 / (sigma t).
    CHECK(sheetResistance(cu, f, 0, 2) == doctest::Approx(0.5 * rs));
    CHECK(sheetResistance(cu, f, 0, 1) == doctest::Approx(rs));
    CHECK(sheetResistance(cu, f, 60 * d, 2) == doctest::Approx(0.5 * rs).epsilon(1e-9));
    CHECK(sheetResistance(cu, f, 60 * d, 1) == doctest::Approx(rs).epsilon(1e-9));
    for (int faces : {1, 2}) CHECK(sheetResistance(cu, f, 0.01 * d, faces) == doctest::Approx(1.0 / (cu * 0.01 * d)).epsilon(1e-4));
    // Wires: thick limit R_s / (2 pi a) (1 + delta / 2a), i.e. R_ac / R_dc = a / 2 delta + 1 / 4, the DC limit, and no jump where the
    // power series hands over to the asymptotic expansion (a = 10 delta).
    const double aThick = 500 * d;
    CHECK(wireResistance(cu, f, aThick) == doctest::Approx(rs / (2 * PI * aThick) * (1 + d / (2 * aThick))).epsilon(1e-6));
    const double aThin = 0.01 * d;
    CHECK(wireResistance(cu, f, aThin) == doctest::Approx(1.0 / (PI * aThin * aThin * cu)).epsilon(1e-4));
    const double lo = wireResistance(cu, f, 10 * d * (1 - 1e-9)), hi = wireResistance(cu, f, 10 * d * (1 + 1e-9));
    CHECK(std::abs(lo / hi - 1) < 2e-4);
}

TEST_CASE("metal problem JSON: types, radius and sheet options") {
    const char* ok = R"({"grid":{"x":[0,1,2,3],"y":[0,1,2,3],"z":[0,1,2,3]},"excitation":{"fMin":1e9,"fMax":2e9},
        "materials":[{"name":"cu","type":"metal","conductivity":5.8e7}],
        "objects":[{"type":"box","material":"cu","min":[1,1,0],"max":[1,1,3],"radius":0.2},
                   {"type":"sheet","material":"cu","axis":2,"coord":1,"thickness":0.035,"currentFaces":1,
                    "positions":[0,0,1,1,0,1,1,1,1],"indices":[0,1,2]}]})";
    const Problem p = parseProblem(ok);
    REQUIRE(p.materials.size() == 1);
    CHECK(p.materials[0].metal);
    CHECK(p.objects[0].radius == doctest::Approx(0.2));
    CHECK(p.objects[1].thickness == doctest::Approx(0.035));
    CHECK(p.objects[1].sheetFaces == 1);
    const char* noRadius = R"({"grid":{"x":[0,1,2],"y":[0,1,2],"z":[0,1,2]},"excitation":{"fMin":1e9,"fMax":2e9},
        "materials":[{"name":"cu","type":"metal","conductivity":5.8e7}],"objects":[{"type":"box","material":"cu","min":[1,1,0],"max":[1,1,2]}]})";
    CHECK_THROWS_WITH_AS(parseProblem(noRadius), doctest::Contains("radius"), std::invalid_argument);
    const char* dielectricSheet = R"({"grid":{"x":[0,1,2],"y":[0,1,2],"z":[0,1,2]},"excitation":{"fMin":1e9,"fMax":2e9},
        "materials":[{"name":"fr4","epsR":4.3}],"objects":[{"type":"sheet","material":"fr4","axis":2,"coord":1,"positions":[0,0,1,1,0,1,1,1,1],"indices":[0,1,2]}]})";
    CHECK_THROWS_WITH_AS(parseProblem(dielectricSheet), doctest::Contains("conductors"), std::invalid_argument);
    const char* badSigma = R"({"grid":{"x":[0,1],"y":[0,1],"z":[0,1]},"excitation":{"fMin":1e9,"fMax":2e9},
        "materials":[{"name":"cu","type":"metal","conductivity":0}]})";
    CHECK_THROWS_AS(parseProblem(badSigma), std::invalid_argument);
}

TEST_CASE("metal surfaces: surface edges are lossy, interior edges stay PEC") {
    Problem p = smallBox();
    p.materials.push_back(metal("cu", 5.8e7));
    p.objects.push_back(box({4, 4, 4}, {6, 6, 6}, "cu")); // 2 x 2 x 2 cells
    Solver s(p);
    const YeeFields& f = s.fields();
    int lossy = 0, pec = 0;
    for (int c = 0; c < 3; ++c)
        for (auto m : f.M(c)) {
            lossy += f.materials.isConductor(m) && f.materials.sigma[m] > 0;
            pec += m == EdgeMaterialTable::kPec;
        }
    CHECK(lossy == 4 * (2 * 2 + 2 * 2 + 2 * 2)); // every edge on the surface of a 2 x 2 x 2 box
    CHECK(pec == 6);                              // the six edges through its centre
    CHECK(f.mx[f.idx(4, 5, 5)] == EdgeMaterialTable::kPec);
    // Ampere on a surface edge gives E = R_s I / w; for a flat face and for a box edge
    // alike, w = 1 mm in its 1 mm x 1 mm dual face, so sigma = 1 / (R_s * 1 mm).
    const double rs = surfaceResistance(5.8e7, 2e9);
    CHECK(sigmaAt(f, 0, 4, 5, 6) == doctest::Approx(1.0 / (rs * 1e-3)).epsilon(2e-4)); // middle of the top face
    CHECK(sigmaAt(f, 0, 4, 4, 4) == doctest::Approx(1.0 / (rs * 1e-3)).epsilon(2e-4)); // box edge
    // The port and DC-path checks still see the metal as a conductor.
    p.hasPort = true;
    p.port.start = {5, 5, 4};
    p.port.stop = {5, 5, 5};
    p.port.axis = 2;
    CHECK_THROWS_WITH_AS(Solver{p}, doctest::Contains("inside a conductor"), std::invalid_argument);
}

TEST_CASE("metal sheets and wires: both faces, one face, rims, wire radius") {
    Problem p = smallBox();
    p.materials.push_back(metal("cu", 5.8e7));
    p.objects.push_back(sheet(2, 6, 2, 6, 3, "cu", 2));
    p.objects.push_back(sheet(2, 6, 2, 6, 8, "cu", 1));
    ObjectSpec w = box({9, 9, 2}, {9, 9, 10}, "cu");
    w.radius = 0.25;
    p.objects.push_back(w);
    Solver s(p);
    const YeeFields& f = s.fields();
    const double rs = surfaceResistance(5.8e7, 2e9);
    CHECK(sigmaAt(f, 0, 3, 4, 3) == doctest::Approx(2.0 / (rs * 1e-3)).epsilon(2e-4)); // both faces: R = R_s / 2
    CHECK(sigmaAt(f, 0, 3, 2, 3) == doctest::Approx(1.0 / (rs * 1e-3)).epsilon(2e-4)); // rim: half the width
    CHECK(sigmaAt(f, 0, 3, 4, 8) == doctest::Approx(1.0 / (rs * 1e-3)).epsilon(2e-4)); // one face: R = R_s
    const double rWire = wireResistance(5.8e7, 2e9, 0.25e-3);
    CHECK(sigmaAt(f, 2, 9, 9, 5) == doctest::Approx(1.0 / (rWire * 1e-6)).epsilon(2e-4)); // E = R' I
}

// Closed parallel-plate resonator: lossy plates at z = z0 and z0 + h, PEC walls at
// both x ends, PMC side walls. Its lowest TEM mode loses power only in the plates,
// so Q = omega mu0 h / (2 R) exactly, with R the resistance per square the model
// uses on the inner faces. The energy decay rate of that mode gives Q.
namespace {

double resonatorQ(Problem p, double* omegaOut) {
    Solver s(p);
    const YeeFields& sf = s.fields();
    YeeFields g(sf.grid(), p.courant);
    std::array<bool, 6> pmc{};
    for (int i = 0; i < 6; ++i) pmc[i] = p.boundaries[i] == Boundary::Pmc;
    g.setPmcFaces(pmc);
    g.mx = sf.mx;
    g.my = sf.my;
    g.mz = sf.mz;
    g.materials = sf.materials;
    const int nx = g.nx();
    const double lx = g.grid().x.back() - g.grid().x.front(), dx = lx / nx;
    for (int i = 1; i < nx; ++i)
        for (int j = 0; j <= g.ny(); ++j)
            for (int k = 2; k < 6; ++k) g.ez[g.idx(i, j, k)] = static_cast<float>(std::sin(PI * i / nx));
    const double dt = g.dt();
    const double omega = 2.0 / dt * std::asin(C0 * dt / dx * std::sin(PI / nx / 2.0)); // discrete TEM mode
    ThreadPool pool(2);
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    int m = 0;
    for (int step = 0; step < 24000; ++step) {
        g.updateH(pool);
        g.updateE(pool);
        if (step >= 4000 && step % 40 == 0) {
            const double t = step * dt, y = std::log(g.energy(&pool));
            sx += t;
            sy += y;
            sxx += t * t;
            sxy += t * y;
            ++m;
        }
    }
    const double slope = (m * sxy - sx * sy) / (m * sxx - sx * sx); // d ln W / dt = -omega / Q
    if (omegaOut) *omegaOut = omega;
    return -omega / slope;
}

Problem resonator() {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(60, 2, 8, 1, 1, 1);
    p.boundaries = {Boundary::Pec, Boundary::Pec, Boundary::Pmc, Boundary::Pmc, Boundary::Pec, Boundary::Pec};
    p.fMin = 2e9;
    p.fMax = 3e9;
    p.metalLossFrequency = C0 / (2 * 0.06);
    p.materials.push_back(metal("m", 2.5e5));
    return p;
}

} // namespace

TEST_CASE("lossy parallel-plate resonator: Q = omega mu0 h / (2 R_s), solid plates and sheets") {
    const double rs = surfaceResistance(2.5e5, C0 / (2 * 0.06)), h = 4e-3;
    double omega = 0;

    Problem solid = resonator();
    solid.objects.push_back(box({0, 0, 0}, {60, 2, 2}, "m")); // plates two cells thick, inner faces at z = 2 and 6
    solid.objects.push_back(box({0, 0, 6}, {60, 2, 8}, "m"));
    const double qSolid = resonatorQ(solid, &omega);
    const double qExpected = omega * MU0 * h / (2 * rs);
    MESSAGE("solid plates: Q " << qSolid << ", expected " << qExpected);
    CHECK(qSolid == doctest::Approx(qExpected).epsilon(0.01));

    // Zero-thickness sheets leave thin TEM regions between them and the outer walls,
    // resonant at the same frequency, and a resistive sheet passes a fraction ~2R/eta0
    // of the field. PEC walls halfway along those regions detune them, so only the
    // sheet loss remains.
    auto sheets = [&](int faces) {
        Problem p = resonator();
        p.objects.push_back(sheet(0, 60, 0, 2, 2, "m", faces));
        p.objects.push_back(sheet(0, 60, 0, 2, 6, "m", faces));
        p.objects.push_back(box({30, 0, 0}, {30, 2, 2}, "pec"));
        p.objects.push_back(box({30, 0, 6}, {30, 2, 8}, "pec"));
        return p;
    };
    const double qOne = resonatorQ(sheets(1), nullptr);
    MESSAGE("sheets, current on one face: Q " << qOne);
    CHECK(qOne == doctest::Approx(qExpected).epsilon(0.01));

    const double qTwo = resonatorQ(sheets(2), nullptr);
    MESSAGE("sheets, current on both faces: Q " << qTwo << " (model: R = R_s / 2)");
    CHECK(qTwo == doctest::Approx(2 * qExpected).epsilon(0.01));

    // The PEC plates of the same resonator keep their energy.
    Problem pec = resonator();
    pec.objects.push_back(box({0, 0, 0}, {60, 2, 2}, "pec"));
    pec.objects.push_back(box({0, 0, 6}, {60, 2, 8}, "pec"));
    CHECK(resonatorQ(pec, nullptr) > 1e5);
}

// Round rod (staircased, a few cells across) on the axis of a PEC box, shorted at
// both ends: a coaxial line, driven through a probe at its middle (lumped port in
// series with a wire to the box) with a pulse that stays below the box's higher
// modes, so the rod carries TEM current. Away from the probe, the power the rod's
// axial metal edges dissipate, sum(sigma E^2 V), must equal R' I^2 of the smooth
// round wire, with I the current in the rod's metal edges. The general surface
// rule overstates it (current crowds on the staircase corners and fins); the
// round-wire calibration removes that.
namespace {

double coaxLossRatio(const ObjectSpec& rod, double cell, double radius) {
    const int nx = 40, nt = 20, ip = nx / 2, skip = 8; // cells either side of the probe left out
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(nx, nt, nt, cell, cell, cell);
    p.boundaries.fill(Boundary::Pec);
    const double f0 = C0 / (2 * nx * cell * 1e-3);
    p.fMin = 0.7 * f0;
    p.fMax = 1.3 * f0;
    p.metalLossFrequency = f0;
    p.materials.push_back(metal("cu", 5.8e7));
    p.objects.push_back(rod);
    const double top = 10 * cell + radius; // rod surface on the +z side (a grid line in these cases)
    p.objects.push_back(box({ip * cell, 10 * cell, top + cell}, {ip * cell, 10 * cell, nt * cell}, "pec"));
    p.hasPort = true;
    p.port.start = {ip * cell, 10 * cell, top};
    p.port.stop = {ip * cell, 10 * cell, top + cell};
    p.port.axis = 2;
    p.maxSteps = 60000;
    p.energyEndDb = -50;
    Solver s(p);
    const YeeFields& g = s.fields();
    const double d = cell * 1e-3;
    std::vector<std::pair<std::size_t, double>> axial; // rod axial metal edges away from the probe: index, sigma * volume
    for (int i = 0; i < nx; ++i) {
        if (std::abs(i - ip) <= skip) continue;
        for (int j = 0; j <= nt; ++j)
            for (int k = 0; k <= nt; ++k) {
                const auto m = g.mx[g.idx(i, j, k)];
                if (g.materials.isConductor(m) && g.materials.sigma[m] > 0) axial.push_back({g.idx(i, j, k), g.materials.sigma[m] * d * d * d});
            }
    }
    const int a = 10 - static_cast<int>(radius / cell) - 3, b = 10 + static_cast<int>(radius / cell) + 3;
    const double rWire = wireResistance(5.8e7, f0, radius * 1e-3);
    double pDiss = 0, pWire = 0;
    while (!s.state().done) {
        s.step(1);
        for (const auto& [q, sv] : axial) pDiss += sv * double(g.ex[q]) * double(g.ex[q]);
        for (int i = 0; i < nx; ++i) {
            if (std::abs(i - ip) <= skip) continue;
            double cur = 0; // current in the rod's metal edges (Ampere on each dual face)
            for (int j = a; j <= b; ++j)
                for (int k = a; k <= b; ++k)
                    if (g.materials.isConductor(g.mx[g.idx(i, j, k)])) cur += g.curlH(0, i, j, k) * d * d;
            pWire += rWire * cur * cur * d;
        }
    }
    return pDiss / pWire;
}

// Closed triangle mesh of a z-faceted cylinder along x (64 sides).
ObjectSpec meshRod(double yc, double zc, double r, double x0, double x1) {
    ObjectSpec o;
    o.kind = ObjectSpec::Kind::Mesh;
    o.material = "cu";
    const int m = 64;
    for (double x : {x0, x1})
        for (int i = 0; i < m; ++i) {
            const double t = 2 * PI * i / m;
            o.positions.insert(o.positions.end(), {float(x), float(yc + r * std::cos(t)), float(zc + r * std::sin(t))});
        }
    o.positions.insert(o.positions.end(), {float(x0), float(yc), float(zc), float(x1), float(yc), float(zc)});
    const std::uint32_t c0 = 2 * m, c1 = 2 * m + 1;
    for (int i = 0; i < m; ++i) {
        const std::uint32_t a = i, b = (i + 1) % m, a1 = m + i, b1 = m + (i + 1) % m;
        o.indices.insert(o.indices.end(), {a, b, b1, a, b1, a1, c0, b, a, c1, a1, b1});
    }
    return o;
}

} // namespace

TEST_CASE("round metal rods: the loss per length is the round wire's R' I^2 at any resolution") {
    for (double cell : {0.25, 0.125}) {
        ObjectSpec cyl;
        cyl.kind = ObjectSpec::Kind::Cylinder;
        cyl.material = "cu";
        cyl.axis = 0;
        cyl.center = {10 * cell, 10 * cell};
        cyl.radius = 0.5;
        cyl.range = {0, 40 * cell};
        const double c = coaxLossRatio(cyl, cell, 0.5);
        ObjectSpec hinted = meshRod(10 * cell, 10 * cell, 0.5, 0, 40 * cell);
        hinted.wireAxis = 0;
        hinted.radius = 0.5;
        const double h = coaxLossRatio(hinted, cell, 0.5);
        const double plain = coaxLossRatio(meshRod(10 * cell, 10 * cell, 0.5, 0, 40 * cell), cell, 0.5);
        MESSAGE("rod 1 mm across " << 1.0 / cell << " cells, dissipated / (R' I^2): cylinder " << c << ", mesh marked as wire " << h
                                   << ", mesh with the general surface rule " << plain);
        CHECK(plain > 1.3); // what the calibration corrects
        CHECK(c == doctest::Approx(1.0).epsilon(0.03));
        CHECK(h == doctest::Approx(1.0).epsilon(0.03));
    }
}

#include "doctest.h"

#include "antsim/constants.hpp"
#include "antsim/excitation.hpp"
#include "antsim/problem.hpp"
#include "antsim/solver.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <complex>
#include <cstring>
#include <stdexcept>

using namespace antsim;

namespace {

ObjectSpec pecBox(std::array<double, 3> lo, std::array<double, 3> hi) {
    ObjectSpec o;
    o.kind = ObjectSpec::Kind::Box;
    o.min = lo;
    o.max = hi;
    return o;
}

Results runToEnd(Solver& s) {
    while (!s.state().done) s.step(500);
    return s.finish();
}

// Parallel-plate TEM line along x: PEC plates at z = 0 and z = h (domain z faces),
// PMC side walls at y = 0 and y = W, CPML at both x ends. A sheet port across the
// whole cross-section at the centre plane sees two matched half-lines in parallel.
Problem temLine(int ny, int nz, int nxHalf, int threads = 0) {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(2 * nxHalf, ny, nz, 1, 1, 1, -nxHalf, 0, 0);
    p.boundaries = {Boundary::Cpml, Boundary::Cpml, Boundary::Pmc, Boundary::Pmc, Boundary::Pec, Boundary::Pec};
    p.hasPort = true;
    p.port.start = {0, 0, 0};
    p.port.stop = {0, static_cast<double>(ny), static_cast<double>(nz)};
    p.port.axis = 2;
    p.port.resistance = 50;
    p.fMin = 1e9;
    p.fMax = 10e9;
    p.portFrequencies = 46;
    p.energyEndDb = -60;
    p.maxSteps = 20000;
    p.threads = threads;
    return p;
}

// Short z-directed wire dipole (PEC lines) with a one-edge port at the centre.
Problem shortDipole(int half, int threads = 0) {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(2 * half, 2 * half, 2 * half, 1, 1, 1, -half, -half, -half);
    p.objects.push_back(pecBox({0, 0, -5}, {0, 0, 0}));
    p.objects.push_back(pecBox({0, 0, 1}, {0, 0, 6}));
    p.hasPort = true;
    p.port.start = {0, 0, 0};
    p.port.stop = {0, 0, 1};
    p.port.axis = 2;
    p.fMin = 1e9;
    p.fMax = 4e9;
    p.portFrequencies = 31;
    p.farField.frequencies = {3e9};
    p.farField.thetaStep = 5;
    p.farField.phiStep = 15;
    p.farField.quadTheta = 24;
    p.farField.quadPhi = 24;
    p.energyEndDb = -50;
    p.maxSteps = 20000;
    p.threads = threads;
    return p;
}

} // namespace

TEST_CASE("Gaussian pulse spectrum matches a sampled DFT") {
    const auto g = GaussianPulse::forBand(1e9, 3e9);
    CHECK(std::abs(g.spectrum(g.f0 + g.fc)) / g.spectrumPeak() == doctest::Approx(0.1).epsilon(1e-3));
    CHECK(std::abs(g.spectrum(0.0)) < 1e-12 * g.spectrumPeak()); // DC-free
    const double dt = 1e-12;
    for (double f : {1e9, 2e9, 3e9}) {
        std::complex<double> s = 0;
        for (int n = 0; n * dt < g.endTime(); ++n) s += g(n * dt) * std::polar(dt, -2 * PI * f * n * dt);
        CHECK(std::abs(s - g.spectrum(f)) / g.spectrumPeak() < 1e-6);
    }
}

TEST_CASE("problem JSON parsing and validation") {
    const char* ok = R"({
      "unit": 0.001,
      "grid": {"uniform": {"min": [-10,-10,-10], "max": [10,10,10], "cell": 1}},
      "boundaries": "cpml",
      "materials": [{"name": "sub", "epsR": 3.38, "sigma": 0.001}],
      "objects": [{"type": "box", "min": [-5,-5,0], "max": [5,5,0]},
                  {"type": "cylinder", "axis": "z", "center": [0,0], "radius": 2, "range": [1,4], "material": "sub"}],
      "port": {"start": [0,0,-1], "stop": [0,0,0], "axis": "z"},
      "excitation": {"fMin": 1e9, "fMax": 3e9},
      "farField": {"frequencies": [2e9]}
    })";
    const Problem p = parseProblem(ok);
    CHECK(p.grid.nx() == 20);
    CHECK(p.objects.size() == 2);
    CHECK(p.objects[1].kind == ObjectSpec::Kind::Cylinder);
    CHECK(p.hasPort);
    CHECK_THROWS_WITH_AS(parseProblem("{"), doctest::Contains("invalid JSON"), std::invalid_argument);
    CHECK_THROWS_WITH_AS(parseProblem(R"({"grid":{"uniform":{"min":[0,0,0],"max":[1,1,1],"cell":1}},"excitation":{"fMin":2,"fMax":1}})"),
                         doctest::Contains("excitation"), std::invalid_argument);
    CHECK_THROWS_WITH_AS(parseProblem(R"({"grid":{"uniform":{"min":[0,0,0],"max":[1,1,1],"cell":1}},"excitation":{"fMin":1,"fMax":2},
                                          "objects":[{"type":"box","material":"nope","min":[0,0,0],"max":[1,1,1]}]})"),
                         doctest::Contains("unknown material"), std::invalid_argument);
}

TEST_CASE("PEC sheets and wires rasterize onto the expected edges") {
    Problem p;
    p.grid = RectGrid::uniform(20, 20, 20, 1, 1, 1);
    p.boundaries.fill(Boundary::Pec);
    p.fMin = 1e9;
    p.fMax = 2e9;
    p.objects.push_back(pecBox({5, 5, 10}, {9, 7, 10})); // 4 x 2 sheet at z = 10
    p.objects.push_back(pecBox({15, 15, 2}, {15, 15, 8})); // wire along z
    Solver s(p);
    const auto& f = s.fields();
    int ex = 0, ey = 0, ez = 0;
    for (std::size_t q = 0; q < f.nodeCount(); ++q) {
        ex += f.mx[q] == EdgeMaterialTable::kPec;
        ey += f.my[q] == EdgeMaterialTable::kPec;
        ez += f.mz[q] == EdgeMaterialTable::kPec;
    }
    CHECK(ex == 4 * 3); // 4 edges along x on each of the 3 y-lines
    CHECK(ey == 2 * 5); // 2 edges along y on each of the 5 x-lines
    CHECK(ez == 6);     // the wire's 6 z-edges
    CHECK(f.mz[f.idx(15, 15, 2)] == EdgeMaterialTable::kPec);
    CHECK(f.mz[f.idx(15, 15, 8)] != EdgeMaterialTable::kPec);
}

TEST_CASE("port errors are reported, not silently accepted") {
    Problem p = shortDipole(20);
    p.farField.frequencies.clear();
    p.port.start = {0, 0, 2}; // inside the upper arm
    p.port.stop = {0, 0, 3};
    CHECK_THROWS_WITH_AS(Solver{p}, doctest::Contains("inside a conductor"), std::invalid_argument);
    p.port.start = {0.5, 0, 0}; // off the grid lines
    p.port.stop = {0.5, 0, 1};
    CHECK_THROWS_WITH_AS(Solver{p}, doctest::Contains("grid lines"), std::invalid_argument);
}

TEST_CASE("TEM line: sheet port measures eta0 h / (2 W) and a positive resistance") {
    const int ny = 4, nz = 4, nxHalf = 40;
    Solver s(temLine(ny, nz, nxHalf));
    const Results r = runToEnd(s);
    REQUIRE(r.run.terminatedBy == "energy");
    const double zExpected = ETA0 * nz / (2.0 * ny); // two matched half-lines in parallel
    double worstMag = 0, worstRe = 1e9;
    for (std::size_t k = 0; k < r.port.f.size(); ++k) {
        const auto z = r.port.zin[k];
        worstMag = std::max(worstMag, std::abs(std::abs(z) / zExpected - 1.0));
        worstRe = std::min(worstRe, z.real());
        // Identity for real Z0: P_acc = P_inc (1 - |S11|^2).
        CHECK(r.port.pAcc[k] == doctest::Approx(r.port.pInc[k] * (1.0 - std::norm(r.port.s11[k]))).epsilon(1e-9));
    }
    MESSAGE("TEM |Zin| worst deviation from " << zExpected << " ohm: " << 100 * worstMag << " %");
    CHECK(worstMag < 0.02);
    CHECK(worstRe > 0); // sign convention: passive load has Re(Zin) > 0
}

TEST_CASE("short dipole: directivity 1.5, sin^2 pattern, energy balance") {
    Solver s(shortDipole(36));
    const Results r = runToEnd(s);
    REQUIRE(r.run.terminatedBy == "energy");
    REQUIRE(r.farField.size() == 1);
    const auto& ff = r.farField[0];
    const double dDb = 10 * std::log10(ff.directivity);
    MESSAGE("short dipole: D = " << dDb << " dBi, Prad(ff) = " << ff.pRad << ", Prad(box) = " << ff.pRadBox
                                 << ", Pacc = " << ff.pAcc << ", efficiency = " << ff.efficiency);
    CHECK(std::abs(dDb - 10 * std::log10(1.5)) < 0.05);
    CHECK(std::abs(ff.pRad / ff.pRadBox - 1.0) < 0.01);
    CHECK(std::abs(ff.efficiency - 1.0) < 0.02);
    // Pattern: U(theta)/Umax vs sin^2(theta), phi = 0 cut.
    const auto& g = ff.grid;
    double se = 0;
    int n = 0;
    for (std::size_t it = 0; it < g.theta.size(); ++it) {
        const double u = g.U[it * g.phi.size()] / ff.uMax;
        const double s2 = std::pow(std::sin(g.theta[it]), 2);
        se += (u - s2) * (u - s2);
        ++n;
    }
    const double rms = std::sqrt(se / n);
    MESSAGE("short dipole sin^2 pattern RMS error " << rms);
    CHECK(rms < 0.01);
    CHECK(std::abs(ff.beamTheta - PI / 2) < 0.1);
}

TEST_CASE("full solver: single- and multi-threaded runs are bitwise identical") {
    const int nt = maxThreads();
    if (nt == 1) return;
    auto run = [](int threads) {
        Problem p = shortDipole(20, threads);
        p.farField.frequencies = {3e9};
        p.maxSteps = 300;
        Solver s(p);
        while (!s.state().done) s.step(100);
        std::vector<float> ez = s.fields().ez;
        Results r = s.finish();
        return std::make_pair(ez, r);
    };
    const auto [a, ra] = run(1);
    const auto [b, rb] = run(nt);
    CHECK(std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0);
    REQUIRE(ra.port.zin.size() == rb.port.zin.size());
    for (std::size_t k = 0; k < ra.port.zin.size(); ++k) CHECK(ra.port.zin[k] == rb.port.zin[k]);
    CHECK(ra.farField[0].pRad == rb.farField[0].pRad);
}

TEST_CASE("external time loop: exported layout and imported runs post-process like the CPU run") {
    Problem p = shortDipole(20);
    p.maxSteps = 2000;
    Solver a(p);
    while (!a.state().done) a.step(500);
    const auto& st = a.state();
    Solver b(p);
    // Layout and arrays describe the prepared problem.
    const auto layout = nlohmann::json::parse(b.gpuLayoutJson());
    CHECK(layout["nx"] == 40);
    CHECK(layout["port"]["edges"].size() == 1);
    CHECK(layout["nf2ff"]["faces"].size() == 6);
    CHECK(layout["cpml"].size() == 6);
    const auto mz = b.gpuUints("mz");
    const auto& f = b.fields();
    CHECK(mz.size() == (f.nodeCount() + 1) / 2);
    for (std::size_t q = 0; q < f.nodeCount(); q += 997) CHECK(((mz[q / 2] >> (16 * (q % 2))) & 0xFFFF) == f.mz[q]);
    CHECK(b.gpuFloats("waveform").size() == 2000);
    CHECK(b.gpuFloats("invDd2").size() == f.invDd[2].size());
    const std::size_t accLen = a.nf2ffAccumulators().size();
    CHECK(accLen > 0);

    Solver::RunImport imp;
    imp.steps = st.step;
    imp.energyDb = st.energyDb;
    imp.terminatedBy = st.terminatedBy;
    imp.seconds = 1.0;
    imp.voltage = a.voltageSeries();
    imp.current = a.currentSeries();
    imp.nf2ffAcc = a.nf2ffAccumulators();
    b.releaseTimeLoopStorage();
    b.importRun(imp);
    const Results ra = a.finish(), rb = b.finish();
    CHECK(rb.backend == "webgpu");
    CHECK(rb.run.step == ra.run.step);
    REQUIRE(ra.port.zin.size() == rb.port.zin.size());
    for (std::size_t k = 0; k < ra.port.zin.size(); ++k) CHECK(ra.port.zin[k] == rb.port.zin[k]);
    CHECK(ra.farField[0].pRad == rb.farField[0].pRad);
    CHECK(ra.farField[0].directivity == rb.farField[0].directivity);

    Solver::RunImport bad = imp;
    bad.voltage.pop_back();
    Solver c(p);
    CHECK_THROWS_WITH_AS(c.importRun(bad), doctest::Contains("series length"), std::invalid_argument);
    bad = imp;
    bad.nf2ffAcc.pop_back();
    CHECK_THROWS_WITH_AS(c.importRun(bad), doctest::Contains("NF2FF import"), std::invalid_argument);
}

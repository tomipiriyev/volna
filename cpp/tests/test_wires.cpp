// Thin wires (cpp/src/api/wires.cpp): parsing, and a fed wire dipole that runs stably.
#include "doctest.h"

#include "antsim/problem.hpp"
#include "antsim/solver.hpp"

#include <array>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "antsim/constants.hpp"

using namespace antsim;

TEST_CASE("thin wires: a centre-fed wire dipole at an angle runs stably") {
    const char* json = R"({"unit":0.001,"grid":{"uniform":{"min":[-60,-60,-90],"max":[60,60,90],"cell":2.5}},
        "objects":[{"type":"wire","radius":0.2,"points":[0,0,2.5, 30,0,52]},{"type":"wire","radius":0.2,"points":[0,0,0, -30,0,-52]}],
        "port":{"start":[0,0,0],"stop":[0,0,2.5],"axis":"z","resistance":50},
        "excitation":{"fMin":0.5e9,"fMax":1.5e9},"portFrequencies":51,"termination":{"energyDb":-40,"maxSteps":20000}})";
    Solver s(parseProblem(json));
    CHECK(s.meshReport().wireSegments > 30);
    CHECK(s.meshReport().stabilityEigenvalue <= 3.98);
    while (!s.state().done) s.step(1000);
    CHECK(s.state().terminatedBy == "energy");
    const Results r = s.finish();
    double worst = 0;
    for (const auto& z : r.port.zin) worst = std::max(worst, std::abs(z));
    CHECK(std::isfinite(worst));
    MESSAGE("segments " << s.meshReport().wireSegments << ", eigenvalue " << s.meshReport().stabilityEigenvalue << ", steps " << s.state().step);
}

namespace {

struct Resonance {
    double f = 0, r = 0;
    long long segments = 0;
};

// First series resonance (Im Z_in rising through zero) of a thin-wire dipole fed by a one-cell
// gap along z at the origin (the feed runs over whole grid edges), its arms of length `arm`
// leaving the gap's ends along unit direction d and -d.
Resonance wireDipole(std::array<double, 3> d, double cell, double arm = 70, double radius = 0.2) {
    auto list = [](std::array<double, 3> a, std::array<double, 3> b) {
        char buf[256];
        std::snprintf(buf, sizeof buf, "%.9g,%.9g,%.9g, %.9g,%.9g,%.9g", a[0], a[1], a[2], b[0], b[1], b[2]);
        return std::string(buf);
    };
    auto v3 = [](std::array<double, 3> a) {
        char buf[128];
        std::snprintf(buf, sizeof buf, "[%.9g,%.9g,%.9g]", a[0], a[1], a[2]);
        return std::string(buf);
    };
    const std::array<double, 3> top = {0, 0, cell}, bottom = {0, 0, 0};
    auto from = [&](std::array<double, 3> o, double s) { return std::array<double, 3>{o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]}; };
    const std::string json = std::string(R"({"unit":0.001,"grid":{"uniform":{"min":[-100,-100,-130],"max":[100,100,130],"cell":)") + std::to_string(cell) +
                             R"(}},"objects":[{"type":"wire","radius":)" + std::to_string(radius) + R"(,"points":[)" + list(top, from(top, arm)) +
                             R"(]},{"type":"wire","radius":)" + std::to_string(radius) + R"(,"points":[)" + list(bottom, from(bottom, -arm)) +
                             R"(]}],"port":{"start":)" + v3(bottom) + R"(,"stop":)" + v3(top) +
                             R"(,"axis":"z","resistance":50},"excitation":{"fMin":0.6e9,"fMax":1.4e9},"portFrequencies":401,"termination":{"energyDb":-50,"maxSteps":40000}})";
    Solver s(parseProblem(json));
    while (!s.state().done) s.step(2000);
    const Results r = s.finish();
    Resonance out;
    out.segments = s.meshReport().wireSegments;
    for (std::size_t i = 1; i < r.port.f.size(); ++i) {
        const double x0 = r.port.zin[i - 1].imag(), x1 = r.port.zin[i].imag();
        if (x0 < 0 && x1 >= 0) {
            const double t = -x0 / (x1 - x0);
            out.f = r.port.f[i - 1] + t * (r.port.f[i] - r.port.f[i - 1]);
            out.r = r.port.zin[i - 1].real() + t * (r.port.zin[i].real() - r.port.zin[i - 1].real());
            break;
        }
    }
    return out;
}

} // namespace

TEST_CASE("thin wires: a dipole's resonance and resistance do not depend on its angle to the grid") {
    const double cell = 2.5;
    const Resonance ref = wireDipole({0, 0, 1}, cell);
    REQUIRE(ref.f > 0);
    MESSAGE("aligned on a grid line: f_res " << ref.f / 1e9 << " GHz, R " << ref.r << " ohm, " << ref.segments << " segments");
    const double s30 = std::sin(PI / 6), c30 = std::cos(PI / 6), s45 = std::sin(PI / 4), c45 = std::cos(PI / 4);
    struct Variant {
        const char* name;
        std::array<double, 3> d;
    } variants[] = {
        {"tilted 30 degrees", {s30, 0, c30}},
        {"tilted 45 degrees, azimuth 30", {s45 * c30, s45 * s30, c45}},
    };
    for (const auto& v : variants) {
        const Resonance r = wireDipole(v.d, cell);
        MESSAGE(std::string(v.name) << ": f_res " << r.f / 1e9 << " GHz (" << 100 * (r.f / ref.f - 1) << " %), R " << r.r << " ohm (" << 100 * (r.r / ref.r - 1) << " %)");
        CHECK(std::abs(r.f / ref.f - 1) < 0.01);
        CHECK(std::abs(r.r / ref.r - 1) < 0.03);
    }
}

namespace {

// Grid lines: uniform `h` over [-core, core], then cells growing by 1.25 up to `hmax`, out to +-span.
std::string gradedLines(double h, double core, double hmax, double span) {
    std::vector<double> up = {0};
    double x = 0, d = h;
    while (x < span) {
        if (x >= core) d = std::min(d * 1.25, hmax);
        x += d;
        up.push_back(x);
    }
    std::string s = "[";
    for (std::size_t i = up.size(); i-- > 1;) s += std::to_string(-up[i]) + ",";
    for (std::size_t i = 0; i < up.size(); ++i) s += std::to_string(up[i]) + (i + 1 < up.size() ? "," : "]");
    return s;
}

// Low-frequency inductance (Im Z / omega, averaged over 80-160 MHz) of a circular thin-wire loop of
// radius b in the vertical plane at azimuth `az`, fed by a one-cell gap along z at the loop's side.
double loopInductance(double b, double a, double h, double az) {
    const double ca = std::cos(az), sa = std::sin(az);
    // Loop centre: b from the gap line, in the plane; the gap spans z = 0..h on the grid line x = y = 0.
    auto at = [&](double rho, double z) { return std::array<double, 3>{rho * ca, rho * sa, z}; };
    std::string pts;
    auto add = [&](std::array<double, 3> p) {
        char buf[96];
        std::snprintf(buf, sizeof buf, "%s%.9g,%.9g,%.9g", pts.empty() ? "" : ", ", p[0], p[1], p[2]);
        pts += buf;
    };
    add(at(0, h));
    const double d0 = std::asin(0.5 * h / b);
    const int n = 400;
    for (int i = 0; i <= n; ++i) {
        const double th = PI - d0 - (2 * PI - 2 * d0) * i / n; // from just above the gap, round the far side, to just below
        add(at(b + b * std::cos(th), 0.5 * h + b * std::sin(th)));
    }
    add(at(0, 0));
    const std::string g = gradedLines(h, b + 4 * h + 2 * b, 40, 450);
    const std::string json = std::string(R"({"unit":0.001,"grid":{"x":)") + g + R"(,"y":)" + g + R"(,"z":)" + g + R"(},"objects":[{"type":"wire","radius":)" +
                             std::to_string(a) + R"(,"points":[)" + pts + R"(]}],"port":{"start":[0,0,0],"stop":[0,0,)" + std::to_string(h) +
                             R"(],"axis":"z","resistance":50},"excitation":{"fMin":0.05e9,"fMax":0.4e9},"portFrequencies":351,"termination":{"energyDb":-50,"maxSteps":60000}})";
    Solver s(parseProblem(json));
    while (!s.state().done) s.step(5000);
    const Results r = s.finish();
    double sum = 0;
    int cnt = 0;
    for (std::size_t i = 0; i < r.port.f.size(); ++i)
        if (r.port.f[i] >= 0.08e9 && r.port.f[i] <= 0.16e9) sum += r.port.zin[i].imag() / (2 * PI * r.port.f[i]), ++cnt;
    return sum / cnt;
}

} // namespace

TEST_CASE("thin wires: a small circular loop has the inductance of a thin wire ring, at any azimuth") {
    // L = mu0 b (ln(8 b / a) - 2) for a thin circular ring; at 80-160 MHz the loop is 0.03-0.07
    // wavelengths around, where the low-frequency formula holds to well under 1 %.
    const double b = 20, a = 0.2, h = 2.5;
    const double exact = MU0 * b * 1e-3 * (std::log(8 * b / a) - 2);
    for (double az : {0.0, PI / 6}) {
        const double L = loopInductance(b, a, h, az);
        MESSAGE("loop b = 20 mm, a = 0.2 mm, azimuth " << az * 180 / PI << " deg: L " << L * 1e9 << " nH vs " << exact * 1e9 << " nH (" << 100 * (L / exact - 1) << " %)");
        CHECK(std::abs(L / exact - 1) < 0.03);
    }
}

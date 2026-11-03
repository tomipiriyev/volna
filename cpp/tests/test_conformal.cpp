// Conformal conductors against exact answers: shapes that do not sit on the grid
// (circular, rotated and spherical cavities, an offset wall), in staircase and
// conformal mode, with their resonances, stability and surface loss.
#include "doctest.h"

#include "antsim/constants.hpp"
#include "antsim/metal.hpp"
#include "antsim/problem.hpp"
#include "antsim/solver.hpp"

#include <array>
#include <cmath>
#include <functional>
#include <vector>

using namespace antsim;

namespace {

// ---------------------------------------------------------------- closed meshes
struct Tri {
    std::vector<float> p;
    std::vector<std::uint32_t> i;
    std::uint32_t add(double x, double y, double z) {
        p.insert(p.end(), {float(x), float(y), float(z)});
        return static_cast<std::uint32_t>(p.size() / 3 - 1);
    }
    void tri(std::uint32_t a, std::uint32_t b, std::uint32_t c, bool flip) {
        if (flip) std::swap(b, c);
        i.insert(i.end(), {a, b, c});
    }
};

// Prism over a counterclockwise polygon in (x, y), from z0 to z1, outward unless `flip`.
void addPrism(Tri& m, const std::vector<std::array<double, 2>>& poly, double z0, double z1, bool flip) {
    const std::uint32_t n = static_cast<std::uint32_t>(poly.size()), base = static_cast<std::uint32_t>(m.p.size() / 3);
    for (double z : {z0, z1})
        for (const auto& q : poly) m.add(q[0], q[1], z);
    double cx = 0, cy = 0;
    for (const auto& q : poly) cx += q[0] / n, cy += q[1] / n;
    const std::uint32_t c0 = m.add(cx, cy, z0), c1 = m.add(cx, cy, z1);
    for (std::uint32_t k = 0; k < n; ++k) {
        const std::uint32_t a = base + k, b = base + (k + 1) % n, a1 = a + n, b1 = b + n;
        m.tri(a, b, b1, flip);
        m.tri(a, b1, a1, flip);
        m.tri(c0, b, a, flip);
        m.tri(c1, a1, b1, flip);
    }
}

std::vector<std::array<double, 2>> rectangle(double x0, double y0, double x1, double y1) { return {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}; }

std::vector<std::array<double, 2>> circle(double cx, double cy, double r, int sides) {
    std::vector<std::array<double, 2>> v;
    // Inscribed polygon with the area of the circle, so the facets do not shrink the shape.
    const double rr = r * std::sqrt(2 * PI / (sides * std::sin(2 * PI / sides)));
    for (int k = 0; k < sides; ++k) v.push_back({cx + rr * std::cos(2 * PI * k / sides), cy + rr * std::sin(2 * PI * k / sides)});
    return v;
}

void addSphere(Tri& m, double cx, double cy, double cz, double r, int stacks, int slices, bool flip) {
    const std::uint32_t base = static_cast<std::uint32_t>(m.p.size() / 3);
    for (int a = 0; a <= stacks; ++a)
        for (int b = 0; b < slices; ++b) {
            const double th = PI * a / stacks, ph = 2 * PI * b / slices;
            m.add(cx + r * std::sin(th) * std::cos(ph), cy + r * std::sin(th) * std::sin(ph), cz + r * std::cos(th));
        }
    auto at = [&](int a, int b) { return base + static_cast<std::uint32_t>(a * slices + (b + slices) % slices); };
    for (int a = 0; a < stacks; ++a)
        for (int b = 0; b < slices; ++b) {
            m.tri(at(a, b), at(a + 1, b), at(a + 1, b + 1), flip);
            m.tri(at(a, b), at(a + 1, b + 1), at(a, b + 1), flip);
        }
}

ObjectSpec meshObject(const Tri& m, const std::string& material) {
    ObjectSpec o;
    o.kind = ObjectSpec::Kind::Mesh;
    o.material = material;
    o.positions = m.p;
    o.indices = m.i;
    return o;
}

MaterialSpec metal(const std::string& name, double sigma) {
    MaterialSpec m;
    m.name = name;
    m.metal = true;
    m.conductivity = sigma;
    return m;
}

double besselJ0(double x) { // power series, for the small arguments used here
    double s = 0, t = 1;
    for (int k = 0; k < 40; ++k) {
        s += t;
        t *= -(x * x / 4) / ((k + 1) * (k + 1));
    }
    return s;
}

// ---------------------------------------------------------------- running a cavity
struct Cavity {
    std::unique_ptr<Solver> s;
    std::unique_ptr<YeeFields> g;
    ThreadPool pool{2};
    explicit Cavity(const Problem& p) {
        s = std::make_unique<Solver>(p);
        g = std::make_unique<YeeFields>(s->fields()); // grid, dt, materials, walls and cut faces
    }
    // Sets E_z on every updated, non-conductor edge from fn(x, y, z in metres at the edge centre).
    void initEz(const std::function<double(double, double, double)>& fn) {
        const RectGrid& gr = g->grid();
        for (int i = 1; i < g->nx(); ++i)
            for (int j = 1; j < g->ny(); ++j)
                for (int k = 0; k < g->nz(); ++k) {
                    const std::size_t q = g->idx(i, j, k);
                    if (g->materials.isConductor(g->mz[q])) continue;
                    g->ez[q] = static_cast<float>(fn(gr.x[i], gr.y[j], 0.5 * (gr.z[k] + gr.z[k + 1])));
                }
    }
    std::size_t centre(double x, double y, int k) const {
        const RectGrid& gr = g->grid();
        const int i = static_cast<int>(std::lower_bound(gr.x.begin(), gr.x.end(), x) - gr.x.begin());
        const int j = static_cast<int>(std::lower_bound(gr.y.begin(), gr.y.end(), y) - gr.y.begin());
        return g->idx(i, j, k);
    }
    // Frequency of the strongest spectral line of E_z at `probe` within +-span of fGuess:
    // the signal is mixed down around it and Hann-windowed, then the peak is located on a
    // grid and refined by golden-section search on the (smooth) windowed spectrum.
    double resonance(std::size_t probe, double fGuess, double span, int steps) {
        std::vector<double> x(steps);
        for (int n = 0; n < steps; ++n) {
            g->updateH(pool);
            g->updateE(pool);
            x[n] = g->ez[probe];
        }
        const double dt = g->dt();
        auto power = [&](double f) {
            double re = 0, im = 0;
            for (int n = 0; n < steps; ++n) {
                const double w = (0.5 - 0.5 * std::cos(2 * PI * n / steps)) * x[n], ph = 2 * PI * f * dt * n;
                re += w * std::cos(ph);
                im += w * std::sin(ph);
            }
            return re * re + im * im;
        };
        const int m = 400;
        const double f0 = fGuess * (1 - span), df = 2 * span * fGuess / m;
        std::vector<double> scan(m + 1);
        for (int k = 0; k <= m; ++k) scan[k] = power(f0 + k * df);
        // The largest local maximum (not the band edge, where a neighbouring line's skirt can be higher).
        int best = -1;
        for (int k = 1; k < m; ++k)
            if (scan[k] >= scan[k - 1] && scan[k] >= scan[k + 1] && (best < 0 || scan[k] > scan[best])) best = k;
        if (best < 0) return std::nan("");
        double lo = f0 + (best - 1) * df, hi = f0 + (best + 1) * df;
        const double phi = 0.5 * (std::sqrt(5.0) - 1);
        double c = hi - phi * (hi - lo), d = lo + phi * (hi - lo), pc = power(c), pd = power(d);
        for (int it = 0; it < 30; ++it) {
            if (pc > pd) {
                hi = d, d = c, pd = pc, c = hi - phi * (hi - lo), pc = power(c);
            } else {
                lo = c, c = d, pc = pd, d = lo + phi * (hi - lo), pd = power(d);
            }
        }
        return 0.5 * (lo + hi);
    }
    // Magnetic energy (uniform weights) averaged over one period of `per` steps: a static
    // field left by an imperfect start has no H, and the average removes the 2 w swing.
    double magneticOverPeriod(int per) {
        double sum = 0;
        for (int n = 0; n < per; ++n) {
            g->updateH(pool);
            g->updateE(pool);
            for (const auto* h : {&g->hx, &g->hy, &g->hz})
                for (float v : *h) sum += static_cast<double>(v) * v;
        }
        return sum / per;
    }
    // Q from the decay of the mode at angular frequency w, fitted over `periods` periods.
    double qFactor(double w, int per, int skip, int periods) {
        for (int n = 0; n < skip * per; ++n) {
            g->updateH(pool);
            g->updateE(pool);
        }
        double sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (int m = 0; m < periods; ++m) {
            const double t = m * per * g->dt(), y = std::log(magneticOverPeriod(per));
            sx += t, sy += y, sxx += t * t, sxy += t * y;
        }
        return -w / ((periods * sxy - sx * sy) / (periods * sxx - sx * sx));
    }
};

Problem cavityProblem(const RectGrid& g, const ObjectSpec& body, bool conformal, double fA, double fB) {
    Problem p;
    p.unit = 1e-3;
    p.grid = g;
    p.boundaries.fill(Boundary::Pec);
    p.objects.push_back(body);
    p.conformal = conformal;
    p.fMin = fA;
    p.fMax = fB;
    return p;
}

// A cylindrical cavity of radius a (mm) along z with its axis off the grid lines:
// PEC around it, flat PEC end caps. TM010: k a = 2.40483.
const double kX01 = 2.404825557695773;
Problem circularCavity(double a, int cellsPerRadius, bool conformal, const std::string& material = "pec") {
    const double h = a / cellsPerRadius;
    const int n = 2 * cellsPerRadius + 6;
    const double cx = 0.5 * n * h + 0.37 * h, cy = 0.5 * n * h + 0.21 * h;
    Tri m;
    addPrism(m, rectangle(-h, -h, (n + 1) * h, (n + 1) * h), -3 * h, 5 * h, false);
    addPrism(m, circle(cx, cy, a, 256), -2 * h, 4 * h, true);
    const double f = kX01 * C0 / (2 * PI * a * 1e-3);
    return cavityProblem(RectGrid::uniform(n, n, 2, h, h, h), meshObject(m, material), conformal, 0.8 * f, 1.2 * f);
}

} // namespace

TEST_CASE("conformal: circular cavity TM010 converges to the exact resonance, much closer than staircasing") {
    const double a = 10, f = kX01 * C0 / (2 * PI * a * 1e-3);
    double errS[3], errC[3];
    const int cells[3] = {10, 20, 40};
    for (int v = 0; v < 3; ++v) {
        for (int conformal = 0; conformal < 2; ++conformal) {
            Problem p = circularCavity(a, cells[v], conformal);
            Cavity c(p);
            const double h = a / cells[v], n = 2 * cells[v] + 6;
            const double cx = (0.5 * n * h + 0.37 * h) * 1e-3, cy = (0.5 * n * h + 0.21 * h) * 1e-3;
            c.initEz([&](double x, double y, double) { return besselJ0(kX01 * std::hypot(x - cx, y - cy) / (a * 1e-3)); });
            const int steps = static_cast<int>(60.0 / (f * c.g->dt()));
            const double fm = c.resonance(c.centre(cx, cy, 0), f, 0.08, steps);
            (conformal ? errC : errS)[v] = fm / f - 1;
            if (conformal) MESSAGE("a/h " << cells[v] << ": cut faces " << c.s->meshReport().cutFaces << ", capped " << c.s->meshReport().cappedFaces << ", eigenvalue " << c.s->meshReport().stabilityEigenvalue);
        }
        MESSAGE("TM010 a/h " << cells[v] << ": staircase " << 100 * errS[v] << " %, conformal " << 100 * errC[v] << " %");
    }
    CHECK(std::abs(errC[1]) < 0.001);
    CHECK(std::abs(errC[2]) < 0.0004);
    CHECK(std::abs(errC[1]) * 10 < std::abs(errS[1]));
    CHECK(std::abs(errC[2]) * 10 < std::abs(errS[2]));
    CHECK(std::abs(errS[1] / errS[2]) < 2.2);  // staircasing: first order
    CHECK(std::abs(errC[1] / errC[2]) > 2.2);  // measured order about 1.3
}

namespace {
// A rectangular cavity a x b (mm) rotated by `deg` about z. TM110: f = c/2 sqrt(1/a^2 + 1/b^2).
struct Rotated {
    Problem p;
    double cx, cy, f;
    std::function<double(double, double, double)> mode;
};
Rotated rotatedCavity(double a, double b, double deg, double h, bool conformal, const std::string& material = "pec") {
    const double th = deg * PI / 180, ct = std::cos(th), st = std::sin(th);
    const double wx = a * ct + b * st, wy = a * st + b * ct;
    const int nx = static_cast<int>(wx / h) + 6, ny = static_cast<int>(wy / h) + 6;
    const double cx = 0.5 * nx * h + 0.31 * h, cy = 0.5 * ny * h + 0.17 * h;
    std::vector<std::array<double, 2>> poly;
    for (const auto& q : rectangle(-a / 2, -b / 2, a / 2, b / 2)) poly.push_back({cx + ct * q[0] - st * q[1], cy + st * q[0] + ct * q[1]});
    Tri m;
    addPrism(m, rectangle(-h, -h, (nx + 1) * h, (ny + 1) * h), -3 * h, 5 * h, false);
    addPrism(m, poly, -2 * h, 4 * h, true);
    const double f = 0.5 * C0 * std::hypot(1 / (a * 1e-3), 1 / (b * 1e-3));
    Rotated r{cavityProblem(RectGrid::uniform(nx, ny, 2, h, h, h), meshObject(m, material), conformal, 0.8 * f, 1.2 * f), cx * 1e-3, cy * 1e-3, f, {}};
    const double cxm = cx * 1e-3, cym = cy * 1e-3, am = a * 1e-3, bm = b * 1e-3;
    r.mode = [=](double x, double y, double) {
        const double u = ct * (x - cxm) + st * (y - cym), v = -st * (x - cxm) + ct * (y - cym);
        if (std::abs(u) > am / 2 || std::abs(v) > bm / 2) return 0.0;
        return std::cos(PI * u / am) * std::cos(PI * v / bm);
    };
    return r;
}
} // namespace

TEST_CASE("conformal: rotated rectangular cavity keeps the exact TM110 resonance at any angle") {
    double worstS = 0, worstC = 0;
    for (double deg : {10.0, 30.0, 45.0, 73.0}) {
        double err[2];
        for (int conformal = 0; conformal < 2; ++conformal) {
            Rotated r = rotatedCavity(24, 16, deg, 1.0, conformal);
            Cavity c(r.p);
            c.initEz(r.mode);
            const int steps = static_cast<int>(60.0 / (r.f * c.g->dt()));
            err[conformal] = c.resonance(c.centre(r.cx, r.cy, 0), r.f, 0.08, steps) / r.f - 1;
        }
        MESSAGE("TM110 rotated " << deg << " deg, 24 x 16 mm, 1 mm cells: staircase " << 100 * err[0] << " %, conformal " << 100 * err[1] << " %");
        worstS = std::max(worstS, std::abs(err[0]));
        worstC = std::max(worstC, std::abs(err[1]));
    }
    CHECK(worstC < 0.003);
    CHECK(worstC * 10 < worstS);
}

TEST_CASE("conformal: spherical cavity (curved in all three directions)") {
    const double a = 12, f = 2.74370 * C0 / (2 * PI * a * 1e-3); // lowest TM mode, k a = 2.7437
    double err[2][2];
    const double hs[2] = {1.0, 0.5};
    for (int v = 0; v < 2; ++v)
        for (int conformal = 0; conformal < 2; ++conformal) {
            const double h = hs[v];
            const int n = static_cast<int>(2 * a / h) + 6;
            const double cx = 0.5 * n * h + 0.29 * h, cy = 0.5 * n * h + 0.13 * h, cz = 0.5 * n * h + 0.41 * h;
            Tri m;
            addPrism(m, rectangle(-h, -h, (n + 1) * h, (n + 1) * h), -h, (n + 1) * h, false);
            addSphere(m, cx, cy, cz, a, 96, 192, true);
            Cavity c(cavityProblem(RectGrid::uniform(n, n, n, h, h, h), meshObject(m, "pec"), conformal, 0.8 * f, 1.2 * f));
            const double xm = cx * 1e-3, ym = cy * 1e-3, zm = cz * 1e-3, w = 0.35 * a * 1e-3;
            c.initEz([&](double x, double y, double z) { return std::exp(-((x - xm) * (x - xm) + (y - ym) * (y - ym) + (z - zm) * (z - zm)) / (w * w)); });
            const int steps = static_cast<int>(40.0 / (f * c.g->dt()));
            const int kc = static_cast<int>(cz / h);
            err[v][conformal] = c.resonance(c.centre(xm, ym, kc), f, 0.06, steps) / f - 1;
            if (conformal) MESSAGE("sphere h " << h << ": cut faces " << c.s->meshReport().cutFaces << ", capped " << c.s->meshReport().cappedFaces << ", eigenvalue " << c.s->meshReport().stabilityEigenvalue);
        }
    MESSAGE("sphere a = 12 mm, h 1 mm: staircase " << 100 * err[0][0] << " %, conformal " << 100 * err[0][1] << " %; h 0.5 mm: staircase " << 100 * err[1][0] << " %, conformal " << 100 * err[1][1] << " %");
    CHECK(std::abs(err[1][1]) < 0.001);
    CHECK(std::abs(err[1][1]) * 10 < std::abs(err[1][0]));
}

TEST_CASE("conformal: a wall between grid lines sits at its true position") {
    // TEM resonator between a PEC wall at x = 0 and a box face at x = L, not on a grid line.
    double worst = 0;
    for (double frac : {0.1, 0.25, 0.5, 0.75, 0.9}) {
        const double L = 30 + frac, f = C0 / (2 * L * 1e-3);
        Problem p;
        p.unit = 1e-3;
        p.grid = RectGrid::uniform(34, 2, 4, 1, 1, 1);
        p.boundaries = {Boundary::Pec, Boundary::Pec, Boundary::Pmc, Boundary::Pmc, Boundary::Pec, Boundary::Pec};
        ObjectSpec wall;
        wall.kind = ObjectSpec::Kind::Box;
        wall.min = {L, 0, 0};
        wall.max = {34, 2, 4};
        p.objects.push_back(wall);
        p.conformal = true;
        p.fMin = 0.8 * f;
        p.fMax = 1.2 * f;
        Cavity c(p);
        for (int i = 1; i <= 30; ++i)
            for (int j = 0; j <= 2; ++j)
                for (int k = 0; k < 4; ++k) c.g->ez[c.g->idx(i, j, k)] = static_cast<float>(std::sin(PI * i / L));
        const int steps = static_cast<int>(80.0 / (f * c.g->dt()));
        const double err = c.resonance(c.g->idx(15, 1, 1), f, 0.05, steps) / f - 1;
        MESSAGE("wall at " << L << " mm (1 mm cells): resonance error " << 100 * err << " %, capped " << c.s->meshReport().cappedFaces);
        worst = std::max(worst, std::abs(err));
    }
    // A staircased wall would snap to the nearest line: up to 0.5 / 30 = 1.7 %.
    CHECK(worst < 0.001);
}

TEST_CASE("conformal: long runs stay stable, and the eigenvalue check holds") {
    for (double deg : {7.0, 33.0, 61.0}) {
        Rotated r = rotatedCavity(17.3, 11.9, deg, 1.0, true);
        Cavity c(r.p);
        CHECK(c.s->meshReport().stabilityEigenvalue <= 3.98);
        c.initEz(r.mode);
        const int per = static_cast<int>(1.0 / (r.f * c.g->dt()));
        const double w0 = c.magneticOverPeriod(4 * per);
        for (int n = 0; n < 200000; ++n) {
            c.g->updateH(c.pool);
            c.g->updateE(c.pool);
        }
        const double w1 = c.magneticOverPeriod(4 * per);
        MESSAGE(deg << " deg: eigenvalue " << c.s->meshReport().stabilityEigenvalue << ", capped " << c.s->meshReport().cappedFaces << " of " << c.s->meshReport().cutFaces << ", magnetic energy after 200000 steps / before " << w1 / w0);
        CHECK(w1 / w0 == doctest::Approx(1.0).epsilon(0.02));
    }
}

TEST_CASE("conformal: geometry on the grid lines is bitwise identical to the standard update") {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(40, 40, 60, 1, 1, 1, -20, -20, -30);
    ObjectSpec top;
    top.kind = ObjectSpec::Kind::Box;
    top.min = {-2, -2, 1};
    top.max = {2, 2, 20};
    ObjectSpec bottom = top;
    bottom.min = {-2, -2, -20};
    bottom.max = {2, 2, 0};
    p.objects = {top, bottom};
    p.hasPort = true;
    p.port.start = {0, 0, 0};
    p.port.stop = {0, 0, 1};
    p.port.axis = 2;
    p.fMin = 2e9;
    p.fMax = 6e9;
    p.portFrequencies = 11;
    p.maxSteps = 800;
    Problem q = p;
    q.conformal = true;
    Solver a(p), b(q);
    CHECK(b.fields().cutFaces.empty());
    while (!a.state().done) a.step(200);
    while (!b.state().done) b.step(200);
    CHECK(a.fields().ez == b.fields().ez);
    CHECK(a.fields().hy == b.fields().hy);
}

TEST_CASE("conformal: curved and oblique metal walls lose exactly the surface's power") {
    // Circular cavity TM010 with lossless end caps: Q = 2.40483 eta0 / (2 R_s).
    const double a = 10, f = kX01 * C0 / (2 * PI * a * 1e-3), sigma = 8800;
    const double rs = surfaceResistance(sigma, f), qExact = kX01 * ETA0 / (2 * rs);
    double q[2];
    for (int conformal = 0; conformal < 2; ++conformal) {
        Problem p = circularCavity(a, 20, conformal, "m");
        p.materials.push_back(metal("m", sigma));
        p.metalLossFrequency = f;
        Cavity c(p);
        const double h = a / 20, n = 46;
        const double cx = (0.5 * n * h + 0.37 * h) * 1e-3, cy = (0.5 * n * h + 0.21 * h) * 1e-3;
        c.initEz([&](double x, double y, double) { return besselJ0(kX01 * std::hypot(x - cx, y - cy) / (a * 1e-3)); });
        const int per = static_cast<int>(1.0 / (f * c.g->dt()));
        q[conformal] = c.qFactor(2 * PI * f, per, 10, 100);
    }
    MESSAGE("TM010 metal walls: exact Q " << qExact << ", staircase surface rule " << q[0] << ", conformal " << q[1]);
    CHECK(q[1] == doctest::Approx(qExact).epsilon(0.03));

    // Rotated rectangular cavity TM110: Q = w mu0 a b (a^2 + b^2) / (4 R_s (a^3 + b^3)).
    for (double deg : {0.0, 30.0, 45.0}) {
        const double A = 24e-3, B = 16e-3;
        Rotated r = rotatedCavity(24, 16, deg, 0.5, true, "m");
        const double w = 2 * PI * r.f, sig = 3000, rsr = surfaceResistance(sig, r.f);
        const double qR = w * MU0 * A * B * (A * A + B * B) / (4 * rsr * (A * A * A + B * B * B));
        r.p.materials.push_back(metal("m", sig));
        r.p.metalLossFrequency = r.f;
        Cavity c(r.p);
        c.initEz(r.mode);
        const int per = static_cast<int>(1.0 / (r.f * c.g->dt()));
        const double qm = c.qFactor(w, per, 10, 50);
        MESSAGE("TM110 metal walls rotated " << deg << " deg: exact Q " << qR << ", conformal " << qm);
        CHECK(qm == doctest::Approx(qR).epsilon(0.03));
    }
}

TEST_CASE("conformal: a thin round rod in a round coaxial resonator") {
    // TEM between a rod of radius a and a tube of radius b, shorted at both ends:
    // Q = w mu0 ln(b / a) / (R_s (1 / a + 1 / b)). `tangent`: the axis on a grid node and whole
    // cells to the rim, so grid lines touch both surfaces, as the app's mesher makes them do.
    const double a = 1.0, b = 4.0, L = 20.0, f = C0 / (2 * L * 1e-3), sigma = 2e4;
    const double rs = surfaceResistance(sigma, f);
    const double qExact = 2 * PI * f * MU0 * std::log(b / a) / (rs * (1 / (a * 1e-3) + 1 / (b * 1e-3)));
    for (double h : {0.5, 0.25})
        for (bool tangent : {false, true}) {
            const int n = static_cast<int>(2 * b / h) + 6, nz = static_cast<int>(L / h);
            const double c0x = 0.5 * n * h + (tangent ? 0 : 0.33 * h), c0y = 0.5 * n * h + (tangent ? 0 : 0.19 * h);
            Tri m;
            addPrism(m, rectangle(-h, -h, (n + 1) * h, (n + 1) * h), -3 * h, L + 3 * h, false);
            addPrism(m, circle(c0x, c0y, b, 128), -2 * h, L + 2 * h, true);
            addPrism(m, circle(c0x, c0y, a, 128), -h, L + h, false);
            Problem p = cavityProblem(RectGrid::uniform(n, n, nz, h, h, h), meshObject(m, "m"), true, 0.8 * f, 1.2 * f);
            p.materials.push_back(metal("m", sigma));
            p.metalLossFrequency = f;
            Cavity c(p);
            // TEM start: radial E ~ 1/r, sin(pi z / L); E_x and E_y live at z nodes.
            const RectGrid& g = c.g->grid();
            const double cx = c0x * 1e-3, cy = c0y * 1e-3;
            for (int i = 0; i <= n; ++i)
                for (int j = 0; j <= n; ++j)
                    for (int k = 1; k < nz; ++k) {
                        const double sz = std::sin(PI * k / nz);
                        const double xm = 0.5 * (g.x[std::min(i, n - 1)] + g.x[std::min(i + 1, n)]), ym = 0.5 * (g.y[std::min(j, n - 1)] + g.y[std::min(j + 1, n)]);
                        const double rx = std::hypot(xm - cx, g.y[j] - cy), ry = std::hypot(g.x[i] - cx, ym - cy);
                        if (i < n && rx > a * 1e-3 && rx < b * 1e-3 && !c.g->materials.isConductor(c.g->mx[c.g->idx(i, j, k)])) c.g->ex[c.g->idx(i, j, k)] = static_cast<float>((xm - cx) / (rx * rx) * sz * 1e-3);
                        if (j < n && ry > a * 1e-3 && ry < b * 1e-3 && !c.g->materials.isConductor(c.g->my[c.g->idx(i, j, k)])) c.g->ey[c.g->idx(i, j, k)] = static_cast<float>((ym - cy) / (ry * ry) * sz * 1e-3);
                    }
            const int per = static_cast<int>(1.0 / (f * c.g->dt()));
            const double qm = c.qFactor(2 * PI * f, per, 4, 30);
            MESSAGE("coax rod " << 2 * a / h << " cells across, " << std::string(tangent ? "grid lines tangent" : "off the grid") << ": exact Q " << qExact << ", conformal " << qm << ", capped " << c.s->meshReport().cappedFaces << " of " << c.s->meshReport().cutFaces);
            CHECK(qm == doctest::Approx(qExact).epsilon(0.06));
        }
}

#include "doctest.h"

#include "antsim/benchmark.hpp"
#include "antsim/constants.hpp"
#include "antsim/yee.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <random>
#include <vector>

using namespace antsim;

namespace {

// Discrete divergence of H at cell centers, max over the domain.
double maxDivH(const YeeFields& f) {
    double m = 0.0;
    for (int i = 0; i < f.nx(); ++i)
        for (int j = 0; j < f.ny(); ++j)
            for (int k = 0; k < f.nz(); ++k) {
                const auto q = f.idx(i, j, k);
                const double div = (f.hx[q + f.sx()] - f.hx[q]) / f.d[0][i] +
                                   (f.hy[q + f.sy()] - f.hy[q]) / f.d[1][j] + (f.hz[q + 1] - f.hz[q]) / f.d[2][k];
                m = std::max(m, std::abs(div));
            }
    return m;
}

double maxAbsH(const YeeFields& f) {
    double m = 0.0;
    for (const auto* v : {&f.hx, &f.hy, &f.hz})
        for (float x : *v) m = std::max(m, static_cast<double>(std::abs(x)));
    return m;
}

void randomInteriorE(YeeFields& f, unsigned seed) {
    std::mt19937 rng(seed);
    std::uniform_real_distribution<float> u(-1.0f, 1.0f);
    for (int i = 0; i <= f.nx(); ++i)
        for (int j = 0; j <= f.ny(); ++j)
            for (int k = 0; k <= f.nz(); ++k) {
                const auto q = f.idx(i, j, k);
                // Only edges that the update touches (tangential boundary E stays 0).
                if (i < f.nx() && j > 0 && j < f.ny() && k > 0 && k < f.nz()) f.ex[q] = u(rng);
                if (j < f.ny() && i > 0 && i < f.nx() && k > 0 && k < f.nz()) f.ey[q] = u(rng);
                if (k < f.nz() && i > 0 && i < f.nx() && j > 0 && j < f.ny()) f.ez[q] = u(rng);
            }
}

} // namespace

TEST_CASE("H stays divergence-free to float32 round-off") {
    RectGrid g = RectGrid::uniform(12, 10, 9, 1e-3, 1e-3, 1e-3);
    g.y = {0, 0.8e-3, 1.8e-3, 3.0e-3, 4.1e-3, 5.0e-3, 6.2e-3, 7.0e-3, 8.1e-3, 9.0e-3, 10.0e-3}; // graded
    YeeFields f(g, 0.99);
    randomInteriorE(f, 7);
    ThreadPool pool(1);
    for (int s = 0; s < 200; ++s) {
        f.updateH(pool);
        f.updateE(pool);
    }
    const double scale = maxAbsH(f) / g.minSpacing(0);
    REQUIRE(scale > 0.0);
    CHECK(maxDivH(f) / scale < 1e-5);
}

TEST_CASE("TM110 cavity resonance matches the discrete Yee dispersion relation") {
    // Anisotropic uniform spacing; the TM110 sine profile is an exact discrete
    // eigenmode, so its frequency must follow
    //   sin(w dt/2) = c dt sqrt(sum_a (sin(k_a d_a/2)/d_a)^2).
    const int nx = 20, ny = 16, nz = 6;
    const double dx = 1e-3, dy = 1.25e-3, dz = 2e-3;
    YeeFields f(RectGrid::uniform(nx, ny, nz, dx, dy, dz), 0.99);
    seedTm110(f);
    ThreadPool pool(maxThreads());

    const double dt = f.dt();
    const double a = nx * dx, b = ny * dy;
    const double kx = PI / a, ky = PI / b;
    const double sx = std::sin(kx * dx / 2) / dx, sy = std::sin(ky * dy / 2) / dy;
    const double wDiscrete = 2.0 / dt * std::asin(C0 * dt * std::sqrt(sx * sx + sy * sy));
    const double fDiscrete = wDiscrete / (2 * PI);
    const double fContinuum = C0 / 2.0 * std::sqrt(1 / (a * a) + 1 / (b * b));

    const auto probe = f.idx(nx / 2, ny / 2, nz / 2);
    std::vector<double> crossings;
    double prev = f.ez[probe];
    const int steps = 6000;
    for (int s = 1; s <= steps; ++s) {
        f.updateH(pool);
        f.updateE(pool);
        const double cur = f.ez[probe];
        if ((prev < 0) != (cur < 0)) crossings.push_back((s - 1 + prev / (prev - cur)) * dt);
        prev = cur;
    }
    REQUIRE(crossings.size() > 20);
    const double fMeasured = (crossings.size() - 1) / (2.0 * (crossings.back() - crossings.front()));
    MESSAGE("TM110 measured " << fMeasured << " Hz, discrete " << fDiscrete << " Hz, continuum " << fContinuum
                              << " Hz");
    CHECK(std::abs(fMeasured / fDiscrete - 1.0) < 1e-4);
    // Sanity: the measured frequency is the discrete one, which is below the continuum value.
    CHECK(fMeasured < fContinuum);
}

TEST_CASE("lossless cavity conserves energy; lossy medium dissipates it") {
    YeeFields f(RectGrid::uniform(10, 10, 4, 1e-3, 1e-3, 1e-3), 0.99);
    seedTm110(f);
    ThreadPool pool(1);
    // E and H are half a step apart, so the naive energy sum oscillates at
    // twice the mode frequency (about +-sin(w dt/2), ~12% on this coarse grid).
    // What must hold is that it neither grows nor decays: compare the peak over
    // an early window with the peak over a late window, each several periods long.
    auto windowPeak = [&](int steps) {
        double hi = 0.0;
        for (int s = 0; s < steps; ++s) {
            f.updateH(pool);
            f.updateE(pool);
            hi = std::max(hi, f.energy());
        }
        return hi;
    };
    const double early = windowPeak(200);
    windowPeak(2000);
    const double late = windowPeak(200);
    CHECK(std::abs(late / early - 1.0) < 1e-3);

    YeeFields g(RectGrid::uniform(10, 10, 4, 1e-3, 1e-3, 1e-3), 0.99);
    const auto lossy = g.materials.add(2.0, 0.5, g.dt());
    std::fill(g.mx.begin(), g.mx.end(), lossy);
    std::fill(g.my.begin(), g.my.end(), lossy);
    std::fill(g.mz.begin(), g.mz.end(), lossy);
    seedTm110(g);
    const double g0 = g.energy();
    for (int s = 0; s < 500; ++s) {
        g.updateH(pool);
        g.updateE(pool);
    }
    CHECK(g.energy() < 0.5 * g0);
}

TEST_CASE("PEC edges stay exactly zero") {
    YeeFields f(RectGrid::uniform(8, 8, 8, 1e-3, 1e-3, 1e-3), 0.99);
    randomInteriorE(f, 3);
    const auto q = f.idx(4, 4, 3);
    f.mz[q] = EdgeMaterialTable::kPec;
    f.ez[q] = 0.0f;
    ThreadPool pool(1);
    for (int s = 0; s < 50; ++s) {
        f.updateH(pool);
        f.updateE(pool);
    }
    CHECK(f.ez[q] == 0.0f);
}

TEST_CASE("single- and multi-threaded updates are bitwise identical") {
    const int n = maxThreads();
    if (n == 1) return;
    auto run = [](int threads) {
        YeeFields f(RectGrid::uniform(17, 13, 11, 1e-3, 1e-3, 1e-3), 0.99);
        randomInteriorE(f, 11);
        ThreadPool pool(threads);
        for (int s = 0; s < 40; ++s) {
            f.updateH(pool);
            f.updateE(pool);
        }
        return f;
    };
    const auto a = run(1), b = run(n);
    for (auto pa : {&YeeFields::ex, &YeeFields::ey, &YeeFields::ez, &YeeFields::hx, &YeeFields::hy, &YeeFields::hz}) {
        const auto& va = a.*pa;
        const auto& vb = b.*pa;
        CHECK(std::memcmp(va.data(), vb.data(), va.size() * sizeof(float)) == 0);
    }
    CHECK(a.energy() == b.energy());
}

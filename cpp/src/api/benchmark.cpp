#include "antsim/benchmark.hpp"
#include "antsim/constants.hpp"
#include "antsim/yee.hpp"

#include <chrono>
#include <cmath>
#include <stdexcept>

namespace antsim {

void seedTm110(YeeFields& f) {
    const auto& g = f.grid();
    const double a = g.x.back() - g.x.front(), b = g.y.back() - g.y.front();
    for (int i = 1; i < f.nx(); ++i) {
        const double sx = std::sin(PI * (g.x[i] - g.x.front()) / a);
        for (int j = 1; j < f.ny(); ++j) {
            const double v = sx * std::sin(PI * (g.y[j] - g.y.front()) / b);
            for (int k = 0; k < f.nz(); ++k) f.ez[f.idx(i, j, k)] = static_cast<float>(v);
        }
    }
}

BenchmarkResult runCavityBenchmark(int n, int steps, int threads) {
    if (n < 4 || n > 1024) throw std::invalid_argument("benchmark cube size must be in [4, 1024]");
    if (steps < 1) throw std::invalid_argument("benchmark needs at least 1 step");
    YeeFields f(RectGrid::uniform(n, n, n, 1e-3, 1e-3, 1e-3), 0.99);
    seedTm110(f);
    ThreadPool pool(threads);

    BenchmarkResult r;
    r.n = n;
    r.steps = steps;
    r.threads = threads;
    r.energyStart = f.energy();
    const auto t0 = std::chrono::steady_clock::now();
    for (int s = 0; s < steps; ++s) {
        f.updateH(pool);
        f.updateE(pool);
    }
    const auto t1 = std::chrono::steady_clock::now();
    r.seconds = std::chrono::duration<double>(t1 - t0).count();
    r.energyEnd = f.energy();
    const double cellSteps = static_cast<double>(n) * n * n * steps;
    r.mcellsPerSec = cellSteps / r.seconds / 1e6;
    r.nsPerCellStep = r.seconds / cellSteps * 1e9;
    return r;
}

} // namespace antsim

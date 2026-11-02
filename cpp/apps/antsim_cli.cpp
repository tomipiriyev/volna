// antsim_cli: native driver for the C++ solver core.
//   antsim_cli version
//   antsim_cli bench [n=64] [steps=50] [threads=max]
//   antsim_cli run problem.json [--out results.json] [--no-patterns] [--threads N]
#include "antsim/benchmark.hpp"
#include "antsim/problem.hpp"
#include "antsim/solver.hpp"
#include "antsim/threadpool.hpp"
#include "antsim/version.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fstream>
#include <sstream>
#include <string>

namespace {

int run(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: antsim_cli run problem.json [--out results.json] [--no-patterns] [--threads N]\n");
        return 2;
    }
    std::ifstream in(argv[2]);
    if (!in) {
        std::fprintf(stderr, "error: cannot read %s\n", argv[2]);
        return 1;
    }
    std::stringstream ss;
    ss << in.rdbuf();
    antsim::Problem p = antsim::parseProblem(ss.str());
    std::string out;
    bool patterns = true;
    for (int i = 3; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
        else if (!std::strcmp(argv[i], "--no-patterns")) patterns = false;
        else if (!std::strcmp(argv[i], "--threads") && i + 1 < argc) p.threads = std::atoi(argv[++i]);
    }
    const auto est = antsim::estimateMemory(p);
    std::fprintf(stderr, "grid %d x %d x %d = %lld cells, estimated memory %.1f MB\n", p.grid.nx(), p.grid.ny(), p.grid.nz(),
                 est.cells, est.total() / 1048576.0);
    antsim::Solver solver(p);
    for (const auto& w : solver.warnings()) std::fprintf(stderr, "warning: %s\n", w.c_str());
    std::fprintf(stderr, "dt %.4g s, %d threads\n", solver.dt(), solver.threads());
    auto last = std::chrono::steady_clock::now();
    while (!solver.state().done) {
        const auto st = solver.step(200);
        const auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last).count() > 2.0 || st.done) {
            std::fprintf(stderr, "step %lld  energy %.1f dB (target %.0f)\n", st.step, st.energyDb, st.targetDb);
            last = now;
        }
    }
    const auto r = solver.finish();
    std::fprintf(stderr, "done: %lld steps, %s, %.2f s, %.0f Mcells/s\n", r.run.step, r.run.terminatedBy.c_str(), r.seconds,
                 r.seconds > 0 ? r.cells * static_cast<double>(r.run.step) / r.seconds / 1e6 : 0.0);
    for (const auto& f : r.farField)
        std::fprintf(stderr, "  %.4f GHz: D %.3f dBi, Prad(ff) %.4g, Prad(box) %.4g, Pacc %.4g, efficiency %.4f\n", f.f / 1e9,
                     10 * std::log10(f.directivity), f.pRad, f.pRadBox, f.pAcc, f.efficiency);
    const std::string json = r.toJson(patterns);
    if (out.empty()) std::printf("%s\n", json.c_str());
    else {
        std::ofstream o(out);
        o << json;
    }
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 2 || std::strcmp(argv[1], "version") == 0) {
            std::printf("{\"version\":\"%s\",\"maxThreads\":%d}\n", antsim::kVersion, antsim::maxThreads());
            return 0;
        }
        if (std::strcmp(argv[1], "bench") == 0) {
            const int n = argc > 2 ? std::atoi(argv[2]) : 64;
            const int steps = argc > 3 ? std::atoi(argv[3]) : 50;
            const int threads = argc > 4 ? std::atoi(argv[4]) : antsim::maxThreads();
            const auto r = antsim::runCavityBenchmark(n, steps, threads);
            std::printf("{\"n\":%d,\"steps\":%d,\"threads\":%d,\"seconds\":%.6f,\"mcellsPerSec\":%.2f,"
                        "\"nsPerCellStep\":%.4f,\"energyRatio\":%.6f}\n",
                        r.n, r.steps, r.threads, r.seconds, r.mcellsPerSec, r.nsPerCellStep, r.energyEnd / r.energyStart);
            return 0;
        }
        if (std::strcmp(argv[1], "run") == 0) return run(argc, argv);
        std::fprintf(stderr, "unknown command '%s' (use: version | bench | run)\n", argv[1]);
        return 2;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}

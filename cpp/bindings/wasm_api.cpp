// Embind surface of the solver. C++ exceptions never cross into JS: every
// entry point catches and reports {ok:false, error} instead. Problems and
// results travel as JSON strings, which avoids exposing wasm heap views whose
// lifetime would end when memory grows.
#include "antsim/benchmark.hpp"
#include "antsim/problem.hpp"
#include "antsim/solver.hpp"
#include "antsim/threadpool.hpp"
#include "antsim/version.hpp"

#include <emscripten/bind.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <memory>
#include <new>
#include <string>

using namespace emscripten;
using nlohmann::json;

namespace {

std::string errorJson(const std::string& msg) { return json{{"ok", false}, {"error", msg}}.dump(); }

template <class F>
std::string guarded(F&& f) {
    try {
        return f();
    } catch (const std::bad_alloc&) {
        return errorJson("OUT_OF_MEMORY: allocation failed (reduce the grid or raise the memory limit)");
    } catch (const std::exception& e) {
        return errorJson(e.what());
    }
}

json estimateJson(const antsim::MemoryEstimate& m) {
    return {{"cells", m.cells},           {"fields", m.fields},         {"materials", m.materials},
            {"cpml", m.cpml},             {"nf2ff", m.nf2ff},           {"portSeries", m.portSeries},
            {"rasterTemp", m.rasterTemp}, {"total", m.total()}};
}

class WasmSolver {
public:
    std::string prepare(const std::string& problemJson, double memoryLimitBytes) {
        return guarded([&] {
            solver_.reset();
            const antsim::Problem p = antsim::parseProblem(problemJson);
            const auto est = antsim::estimateMemory(p);
            if (memoryLimitBytes > 0 && static_cast<double>(est.total()) > memoryLimitBytes)
                return errorJson("MEMORY_LIMIT: the run needs about " + std::to_string(est.total() / 1048576) +
                                 " MB, above the configured limit of " +
                                 std::to_string(static_cast<long long>(memoryLimitBytes / 1048576)) + " MB");
            solver_ = std::make_unique<antsim::Solver>(p);
            const auto& g = solver_->fields();
            return json{{"ok", true},
                        {"cells", static_cast<long long>(g.nx()) * g.ny() * g.nz()},
                        {"grid", {g.nx(), g.ny(), g.nz()}},
                        {"dt", solver_->dt()},
                        {"maxSteps", solver_->state().maxSteps},
                        {"threads", solver_->threads()},
                        {"memoryBytes", solver_->memoryBytes()},
                        {"estimate", estimateJson(est)},
                        {"warnings", solver_->warnings()},
                        {"report", json::parse(antsim::meshReportJson(solver_->meshReport(), solver_->diagnostics()))},
                        {"portSegments", solver_->portSegments()}}
                .dump();
        });
    }

    std::string step(int maxSteps) {
        return guarded([&] {
            if (!solver_) return errorJson("no problem prepared");
            const auto s = solver_->step(maxSteps);
            return json{{"ok", true},           {"step", s.step},         {"maxSteps", s.maxSteps},
                        {"time", s.time},       {"energyDb", s.energyDb}, {"targetDb", s.targetDb},
                        {"done", s.done},       {"terminatedBy", s.terminatedBy}}
                .dump();
        });
    }

    std::string finish(bool patterns) {
        return guarded([&] {
            if (!solver_) return errorJson("no problem prepared");
            return solver_->finish().toJson(patterns);
        });
    }

    /// PEC edges of the prepared grid as a Float32Array of segments (6 floats each,
    /// drawing units), thinned to at most maxSegments. Copied out of the heap.
    val pecSegments(int maxSegments) {
        if (!solver_) return val::null();
        const std::vector<float> s = solver_->pecSegments(static_cast<std::size_t>(std::max(maxSegments, 1)));
        return val::global("Float32Array").new_(typed_memory_view(s.size(), s.data()));
    }

    // ---- WebGPU backend: the prepared solver exports its layout and arrays, the
    // GPU runs the time loop, and gpuFinish imports the outcome for post-processing.
    std::string gpuLayout() {
        return guarded([&] {
            if (!solver_) return errorJson("no problem prepared");
            json j = json::parse(solver_->gpuLayoutJson());
            j["ok"] = true;
            return j.dump();
        });
    }

    /// Float32Array (or Uint32Array for mx/my/mz/cutIdx) copy, or null with the error in lastError().
    val gpuArray(const std::string& name) {
        try {
            if (!solver_) throw std::invalid_argument("no problem prepared");
            if (name == "mx" || name == "my" || name == "mz" || name == "cutIdx") {
                const auto v = solver_->gpuUints(name);
                return val::global("Uint32Array").new_(typed_memory_view(v.size(), v.data()));
            }
            const auto v = solver_->gpuFloats(name);
            return val::global("Float32Array").new_(typed_memory_view(v.size(), v.data()));
        } catch (const std::exception& e) {
            lastError_ = e.what();
            return val::null();
        }
    }

    val fieldSnapshot(int comp) {
        try {
            if (!solver_) throw std::invalid_argument("no problem prepared");
            const auto v = solver_->fieldSnapshot(comp);
            return val::global("Float32Array").new_(typed_memory_view(v.size(), v.data()));
        } catch (const std::exception& e) {
            lastError_ = e.what();
            return val::null();
        }
    }

    /// Frees CPU field/PML storage once the arrays are on the GPU.
    void releaseTimeLoopStorage() {
        if (solver_) solver_->releaseTimeLoopStorage();
    }

    /// run: {steps, energyDb, terminatedBy, seconds}; voltage/current/nf2ff: Float64Array.
    std::string gpuFinish(const std::string& runJson, val voltage, val current, val nf2ff, bool patterns) {
        return guarded([&] {
            if (!solver_) return errorJson("no problem prepared");
            const json r = json::parse(runJson);
            antsim::Solver::RunImport imp;
            imp.steps = r.at("steps").get<long long>();
            imp.energyDb = r.at("energyDb").get<double>();
            imp.terminatedBy = r.at("terminatedBy").get<std::string>();
            imp.seconds = r.at("seconds").get<double>();
            imp.voltage = convertJSArrayToNumberVector<double>(voltage);
            imp.current = convertJSArrayToNumberVector<double>(current);
            imp.nf2ffAcc = convertJSArrayToNumberVector<double>(nf2ff);
            solver_->importRun(std::move(imp));
            return solver_->finish().toJson(patterns);
        });
    }

    std::string lastError() const { return lastError_; }

    void release() { solver_.reset(); }

private:
    std::unique_ptr<antsim::Solver> solver_;
    std::string lastError_;
};

struct WasmBenchmarkResult {
    bool ok = false;
    std::string error;
    antsim::BenchmarkResult result;
};

std::string version() { return antsim::kVersion; }
bool threadsEnabled() { return ANTSIM_THREADS != 0; }

WasmBenchmarkResult runBenchmark(int n, int steps, int threads) {
    WasmBenchmarkResult out;
    try {
        out.result = antsim::runCavityBenchmark(n, steps, threads);
        out.ok = true;
    } catch (const std::bad_alloc&) {
        out.error = "OUT_OF_MEMORY: benchmark allocation failed";
    } catch (const std::exception& e) {
        out.error = e.what();
    }
    return out;
}

std::string estimate(const std::string& problemJson) {
    return guarded([&] {
        json j = estimateJson(antsim::estimateMemory(antsim::parseProblem(problemJson)));
        j["ok"] = true;
        return j.dump();
    });
}

} // namespace

EMSCRIPTEN_BINDINGS(antsim) {
    value_object<antsim::BenchmarkResult>("BenchmarkResult")
        .field("n", &antsim::BenchmarkResult::n)
        .field("steps", &antsim::BenchmarkResult::steps)
        .field("threads", &antsim::BenchmarkResult::threads)
        .field("seconds", &antsim::BenchmarkResult::seconds)
        .field("mcellsPerSec", &antsim::BenchmarkResult::mcellsPerSec)
        .field("nsPerCellStep", &antsim::BenchmarkResult::nsPerCellStep)
        .field("energyStart", &antsim::BenchmarkResult::energyStart)
        .field("energyEnd", &antsim::BenchmarkResult::energyEnd);
    value_object<WasmBenchmarkResult>("WasmBenchmarkResult")
        .field("ok", &WasmBenchmarkResult::ok)
        .field("error", &WasmBenchmarkResult::error)
        .field("result", &WasmBenchmarkResult::result);
    function("version", &version);
    function("threadsEnabled", &threadsEnabled);
    function("maxThreads", &antsim::maxThreads);
    function("runBenchmark", &runBenchmark);
    function("estimate", &estimate);
    class_<WasmSolver>("Solver")
        .constructor<>()
        .function("prepare", &WasmSolver::prepare)
        .function("step", &WasmSolver::step)
        .function("finish", &WasmSolver::finish)
        .function("pecSegments", &WasmSolver::pecSegments)
        .function("gpuLayout", &WasmSolver::gpuLayout)
        .function("gpuArray", &WasmSolver::gpuArray)
        .function("fieldSnapshot", &WasmSolver::fieldSnapshot)
        .function("releaseTimeLoopStorage", &WasmSolver::releaseTimeLoopStorage)
        .function("gpuFinish", &WasmSolver::gpuFinish)
        .function("lastError", &WasmSolver::lastError)
        .function("release", &WasmSolver::release);
}

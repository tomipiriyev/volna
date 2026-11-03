#pragma once

#include "antsim/cpml.hpp"
#include "antsim/excitation.hpp"
#include "antsim/nf2ff.hpp"
#include "antsim/problem.hpp"
#include "antsim/threadpool.hpp"
#include "antsim/voxelize.hpp"
#include "antsim/yee.hpp"

#include <complex>
#include <cstddef>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace antsim {

struct MemoryEstimate {
    long long cells = 0;
    std::size_t fields = 0, materials = 0, cpml = 0, nf2ff = 0, portSeries = 0, rasterTemp = 0;
    std::size_t total() const { return fields + materials + cpml + nf2ff + portSeries + rasterTemp; }
};

/// Memory the solver will allocate for this problem (before allocating it).
MemoryEstimate estimateMemory(const Problem& p);

struct RunState {
    long long step = 0, maxSteps = 0;
    double time = 0;          // s
    double energyDb = 0;      // relative to the peak so far
    double targetDb = -50;
    bool done = false;
    std::string terminatedBy; // "energy" | "maxSteps" | "" while running
};

struct Diagnostic {
    std::string code, severity, message; // severity: "error" blocks a run in the app
};

struct ObjectReport {
    std::string name, kind, material;
    long long pecEdges = 0, cells = 0;
    double snapDistance = 0; // sheets: distance from the requested plane to the grid plane (m)
    bool conductor = false;  // pec or a metal
    long long lossyEdges = 0; // metal surface edges carrying the conductor loss
};

struct MeshReport {
    std::vector<ObjectReport> objects;
    struct Overlap {
        std::string a, b;
        long long cells;
    };
    std::vector<Overlap> overlaps;  // dielectrics sharing cells at equal priority
    int dcConnected = -1;           // -1 unknown, 0 no, 1 yes (port terminals joined by conductors)
    long long pecEdgesTotal = 0;
    double minCell = 0, maxCell = 0; // m
    // Conformal mode: faces cut by conductors, those capped for stability, and the
    // largest eigenvalue of the update (stable below 4).
    long long cutFaces = 0, cappedFaces = 0;
    double stabilityEigenvalue = 0;
};

struct PortResult {
    std::vector<double> f;
    std::vector<std::complex<double>> V, I, zin, s11;
    std::vector<double> pAcc, pInc, sourceDb;
    double z0 = 50;
};

struct FarFieldResult {
    double f = 0;
    double pRad = 0, pRadBox = 0, pAcc = 0, pInc = 0;
    std::complex<double> zin, s11;
    double uMax = 0, directivity = 0, gain = 0, realizedGain = 0, efficiency = 0;
    double beamTheta = 0, beamPhi = 0; // radians
    double sourceDb = 0;
    FarFieldGrid grid;
};

struct Results {
    RunState run;
    double dt = 0;
    long long cells = 0;
    std::size_t memoryBytes = 0;
    double seconds = 0;
    int threads = 1;
    bool hasPort = false;
    std::string backend = "cpu"; // "cpu" or "webgpu" (time loop run elsewhere, see Solver::importRun)
    PortResult port;
    std::vector<FarFieldResult> farField;
    std::vector<std::string> warnings;
    std::vector<Diagnostic> diagnostics;
    MeshReport mesh;
    std::string toJson(bool includePatterns = true) const;
};

std::string meshReportJson(const MeshReport& m, const std::vector<Diagnostic>& d);

// One FDTD run: prepare() rasterizes and allocates, step() advances in chunks
// (so a caller can report progress and cancel between chunks), finish()
// post-processes. Errors are std::invalid_argument with a user-facing message.
class Solver {
public:
    explicit Solver(const Problem& p);
    ~Solver();

    RunState step(long long maxChunk);
    const RunState& state() const { return state_; }
    Results finish();

    const YeeFields& fields() const { return *f_; }
    std::size_t memoryBytes() const;
    double dt() const { return f_->dt(); }
    int threads() const { return pool_->size(); }
    const std::vector<std::string>& warnings() const { return warnings_; }
    const std::vector<Diagnostic>& diagnostics() const { return diags_; }
    const MeshReport& meshReport() const { return report_; }
    /// PEC edges as line segments (x0 y0 z0 x1 y1 z1, drawing units), at most maxSegments
    /// (evenly subsampled beyond that), for previews.
    std::vector<float> pecSegments(std::size_t maxSegments) const;
    /// Port edges as line segments (drawing units).
    std::vector<float> portSegments() const;

    /// Port voltage/current spectra at arbitrary frequencies (DFT of the recorded series).
    void portSpectrum(const std::vector<double>& f, std::vector<std::complex<double>>& V,
                      std::vector<std::complex<double>>& I) const;

    // ---- External time loop (WebGPU backend). The prepared solver describes its
    // grid, materials, PML, port and NF2FF box; the external loop runs the same
    // update equations and hands back what post-processing needs.
    /// JSON layout: dimensions, dt, termination, PML slabs, port edges/lines, NF2FF faces.
    std::string gpuLayoutJson() const;
    /// Named float arrays: ca cb epsR invD0-2 invDd0-2 d0-2 dd0-2 cpmlProfE cpmlProfH waveform.
    std::vector<float> gpuFloats(const std::string& name) const;
    /// Named uint arrays: mx my mz (two 16-bit material ids per word, low half first).
    std::vector<std::uint32_t> gpuUints(const std::string& name) const;
    /// Copy of one field component (0-2: Ex Ey Ez, 3-5: Hx Hy Hz), node-sized.
    std::vector<float> fieldSnapshot(int comp) const;
    struct RunImport {
        long long steps = 0;
        double energyDb = 0;
        std::string terminatedBy;
        double seconds = 0;
        std::string backend = "webgpu";
        std::vector<double> voltage, current; // V at (n+1) dt, I at (n+1/2) dt
        std::vector<double> nf2ffAcc;         // Nf2ff::exportAcc() layout
    };
    /// Adopts the result of an external time loop; finish() then post-processes it.
    void importRun(RunImport r);
    /// Frees field and PML state once the time loop runs elsewhere (finish() does not need it).
    void releaseTimeLoopStorage();
    const std::vector<double>& voltageSeries() const { return vSeries_; }
    const std::vector<double>& currentSeries() const { return iSeries_; }
    std::vector<double> nf2ffAccumulators() const;

private:
    // A metal object's placeholder material: its edges are marked with `id` (PEC-like)
    // until applyMetalLoss() gives the surface edges their conductivity.
    struct MetalTag {
        std::uint16_t id;
        const MaterialSpec* metal;
        ObjectSpec o; // in metres
        int report;
    };
    // Conformal mode: an edge partly inside a conductor stays active, with its covered
    // stretches (metres from the edge's start), the sum of the surface's outward unit
    // normals where the edge crosses it, and the conductor's tag.
    struct PartialEdge {
        std::vector<Interval> covered;
        std::array<double, 3> normal{};
        std::uint16_t owner = EdgeMaterialTable::kPec;
    };
    std::uint64_t edgeKey(int c, std::size_t at) const { return static_cast<std::uint64_t>(c) * f_->nodeCount() + at; }
    bool inConductor(int c, std::size_t at) const; // conductor edge, or one at least half covered
    void resolvePartialEdges();
    void buildCutFaces();
    double updateEigenvalue();

    void rasterize();
    void applyMetalLoss(const std::vector<MetalTag>& tags);
    void setupPort();
    void setupFarField();
    void recordCurrent();
    void recordVoltage();
    void checkDcPath();
    void diag(const std::string& code, const std::string& severity, const std::string& message);

    Problem p_;
    std::unique_ptr<ThreadPool> pool_;
    std::unique_ptr<YeeFields> f_;
    std::unique_ptr<Cpml> cpml_;
    std::unique_ptr<Nf2ff> nf2ff_;
    GaussianPulse pulse_;
    RunState state_;
    double peakEnergy_ = 0;
    long long checkEvery_ = 1;
    double wallSeconds_ = 0;
    std::string backend_ = "cpu";
    std::vector<std::string> warnings_;
    std::vector<Diagnostic> diags_;
    MeshReport report_;
    std::unordered_map<std::uint64_t, PartialEdge> partial_;
    std::map<std::uint16_t, double> metalRs_; // metal tag -> surface resistance (ohm)
    // Conformal: metal conductor edges on the surface beside a cut cell -> their tag. Where the
    // surface runs exactly along such an edge (a grid line tangent to a round body), its
    // faces carry the loss, with the chord along the edge.
    std::unordered_map<std::uint64_t, std::uint16_t> surfaceEdges_;

    struct PortEdge {
        std::size_t at;
        double length; // m
        float source;  // E += source * g(t)
        int line;
    };
    std::vector<PortEdge> portEdges_;
    struct PortLine {
        int ijk[3];    // middle series edge (current probe)
        double area;   // dual area (m^2)
        double weight; // area / total area (voltage averaging)
    };
    std::vector<PortLine> portLines_;
    std::size_t portEnds_[2] = {0, 0}; // node indices at the reference and signal ends
    std::vector<double> vSeries_, iSeries_; // V at (n+1) dt, I at (n+1/2) dt
};

} // namespace antsim

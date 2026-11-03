#pragma once

#include "antsim/grid.hpp"
#include "antsim/threadpool.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace antsim {

// Per-edge E-field update coefficients, indexed by a 16-bit material id:
//   E <- ca * E + cb * curl(H),  ca = (1 - s)/(1 + s), cb = (dt/eps)/(1 + s), s = sigma*dt/(2 eps).
// Index 0 is PEC (ca = cb = 0, E stays 0); index 1 is vacuum. Conductor entries
// (PEC and the surface edges of metals) are flagged, so geometry checks treat a
// lossy metal edge as part of its conductor.
struct EdgeMaterialTable {
    std::vector<float> ca, cb;
    std::vector<double> epsR, sigma; // kept for energy/diagnostics
    std::vector<std::uint8_t> conductor;

    static constexpr std::uint16_t kPec = 0;
    static constexpr std::uint16_t kVacuum = 1;

    void reset(double dt); // PEC + vacuum only
    std::uint16_t add(double epsR, double sigma, double dt);
    /// Metal surface edge: vacuum permittivity plus the effective conductivity, with
    /// exponential coefficients ca = exp(-sigma dt / eps0), cb = (1 - ca) / sigma.
    std::uint16_t addMetal(double sigma, double dt);
    /// Entry with explicit coefficients (port edges, PEC-like placeholders).
    std::uint16_t addRaw(float ca, float cb, double epsR, double sigma, bool conductor);
    bool isConductor(std::uint16_t id) const { return conductor[id] != 0; }
    std::size_t size() const { return ca.size(); }
};

// A face cut by a conductor in conformal mode. Its H is corrected after the bulk
// update: H <- c[0] H + sum(c[i + 1] E_i), which replaces the full cell lengths and
// area of the bulk update by the open ones (Solver::buildCutFaces).
struct CutFace {
    std::size_t hq;      // node index of H
    std::size_t eq[4];   // node indices of the four contour edges
    float c[5];
    std::uint8_t hc;     // H component
    std::uint8_t ec[4];  // E components
};

// Yee-grid field storage (structure of arrays, float32). Every component uses
// node-sized arrays (nx+1)*(ny+1)*(nz+1) with k contiguous, so neighbor
// offsets are the same for all components; the few unused entries stay 0.
//   Ex(i+1/2, j, k)  Ey(i, j+1/2, k)  Ez(i, j, k+1/2)
//   Hx(i, j+1/2, k+1/2)  Hy(i+1/2, j, k+1/2)  Hz(i+1/2, j+1/2, k)
// Outer faces are PEC (tangential E stays 0; a CPML is backed by PEC) unless
// marked PMC, in which case tangential E on the face is updated with the
// tangential H at the wall taken as 0 (image theory, half-cell dual spacing).
class YeeFields {
public:
    YeeFields(const RectGrid& grid, double courant);

    /// Face order: xmin, xmax, ymin, ymax, zmin, zmax.
    void setPmcFaces(const std::array<bool, 6>& pmc) { pmc_ = pmc; }
    const std::array<bool, 6>& pmcFaces() const { return pmc_; }

    std::vector<float>& E(int c) { return c == 0 ? ex : c == 1 ? ey : ez; }
    std::vector<float>& H(int c) { return c == 0 ? hx : c == 1 ? hy : hz; }
    const std::vector<float>& E(int c) const { return c == 0 ? ex : c == 1 ? ey : ez; }
    const std::vector<float>& H(int c) const { return c == 0 ? hx : c == 1 ? hy : hz; }
    std::vector<std::uint16_t>& M(int c) { return c == 0 ? mx : c == 1 ? my : mz; }
    const std::vector<std::uint16_t>& M(int c) const { return c == 0 ? mx : c == 1 ? my : mz; }
    int n(int axis) const { return axis == 0 ? nx_ : axis == 1 ? ny_ : nz_; }
    std::size_t stride(int axis) const { return axis == 0 ? sx_ : axis == 1 ? sy_ : 1; }

    /// (curl H) component `c` at the E edge with node indices (i, j, k), H outside
    /// the domain taken as 0 and dual spacings as stored. Used where the bulk
    /// kernel does not run: PMC faces, port current probes, diagnostics.
    double curlH(int c, int i, int j, int k) const;

    /// Whether E component c at node indices (i, j, k) is updated (not on a PEC face).
    bool eActive(int c, int i, int j, int k) const;

    const RectGrid& grid() const { return grid_; }
    double dt() const { return dt_; }
    int nx() const { return nx_; }
    int ny() const { return ny_; }
    int nz() const { return nz_; }
    std::size_t sx() const { return sx_; }
    std::size_t sy() const { return sy_; }
    std::size_t idx(int i, int j, int k) const { return i * sx_ + j * sy_ + static_cast<std::size_t>(k); }
    std::size_t nodeCount() const { return n_; }

    std::vector<float> ex, ey, ez, hx, hy, hz;
    std::vector<std::uint16_t> mx, my, mz; // material id per E edge
    EdgeMaterialTable materials;
    std::vector<CutFace> cutFaces; // empty unless conductors cut grid faces

    void updateH(ThreadPool& pool); // bulk kernel plus cut faces
    void updateE(ThreadPool& pool); // bulk kernel plus PMC face planes

    // Discrete electromagnetic energy 0.5*sum(eps |E|^2 dV + mu0 |H|^2 dV)
    // (E and H are half a step apart, so this is a diagnostic, not an exact
    // invariant). Per-i partial sums in double, combined in i order, so the
    // value does not depend on the thread count.
    double energy(ThreadPool* pool = nullptr) const;

    // Bytes held by field, material and spacing arrays.
    std::size_t memoryBytes() const;

    // Primary (cell) and dual (cell-center to cell-center) inverse spacings.
    std::vector<float> invD[3], invDd[3];
    std::vector<double> d[3], dd[3];

private:
    void applyCutFaces(ThreadPool& pool);
    void updatePmcFaces();
    double energySlab(int i) const;

    std::array<bool, 6> pmc_{};
    RectGrid grid_;
    double dt_;
    int nx_, ny_, nz_;
    std::size_t sx_, sy_, n_;
    float chH_; // dt / mu0
};

} // namespace antsim

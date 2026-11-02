#pragma once

#include "antsim/problem.hpp"
#include "antsim/threadpool.hpp"
#include "antsim/yee.hpp"

#include <array>
#include <cstddef>
#include <vector>

namespace antsim {

// Convolutional PML (Roden & Gedney 2000, CFS form with kappa = 1) applied as
// a correction after the bulk updates, only inside the PML slabs:
//   psi <- b psi + c dF/da,   b = exp(-(sigma + alpha) dt / eps0),
//   c = sigma / (sigma + alpha) (b - 1).
// sigma(rho) = sigma_max (rho/d)^m, alpha(rho) = alpha_max (1 - rho/d), with
// rho the depth into the PML; sigma_max = factor * 0.8 (m+1) / (eta0 * delta).
// The outermost face behind each PML is PEC. kappa = 1 keeps the bulk kernel
// unchanged; structures must not extend into the PML except PEC.
class Cpml {
public:
    Cpml(YeeFields& f, const std::array<Boundary, 6>& bc, const PmlParams& p);

    void correctH(ThreadPool& pool);
    void correctE(ThreadPool& pool);
    std::size_t memoryBytes() const;
    bool active() const { return !slabs_.empty(); }
    /// Number of PML cells on face `face` (0 if that face is not CPML).
    int cells(int face) const { return cells_[face]; }

    /// Slab layout for an external time loop (the WebGPU backend). Offsets are in
    /// (b, c) pairs for the profiles and in elements for the psi arrays, which hold
    /// the slabs one after another in this order; psiEp/psiEq (and psiHp/psiHq)
    /// share the same layout.
    struct SlabInfo {
        int axis, lo, hi, nE, nH;
        std::size_t planeE, profE, profH, psiE, psiH;
    };
    std::vector<SlabInfo> slabInfo() const;
    /// Profiles of all slabs, interleaved (b, c) per node (E) or half node (H).
    std::vector<float> profiles(bool electric) const;
    /// Frees the psi arrays (after their state has moved to another backend).
    void releaseState();

private:
    struct Slab {
        int axis = 0;
        int lo = 0, hi = 0;       // E nodes [lo, hi], H half-nodes [lo, hi - 1] along `axis`
        std::vector<float> bE, cE; // per node in [lo, hi]
        std::vector<float> bH, cH; // per half node in [lo, hi - 1]
        std::vector<float> psiEp, psiEq, psiHp, psiHq; // p, q = cyclic successors of axis
        std::size_t planeE = 0;    // (n_p + 1) (n_q + 1) entries per node plane
    };

    YeeFields& f_;
    std::array<int, 6> cells_{};
    std::vector<Slab> slabs_;
};

} // namespace antsim

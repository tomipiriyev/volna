#pragma once

#include "antsim/threadpool.hpp"
#include "antsim/yee.hpp"

#include <array>
#include <complex>
#include <cstddef>
#include <vector>

namespace antsim {

using cd = std::complex<double>;

struct FarFieldGrid {
    std::vector<double> theta, phi; // radians; samples are theta-major: index it * nphi + ip
    std::vector<cd> eTheta, ePhi;   // r * E (peak phasors, e^{jwt}, phase factor e^{-jkr} removed)
    std::vector<double> U;          // radiation intensity, W/sr (per the DFT-scaled source)
};

// Near-field to far-field transform on a closed Huygens box whose faces are
// Yee node planes. Running DFTs of the tangential fields are accumulated at
// the exact sample times (E at n dt, H at (n + 1/2) dt); H is averaged across
// each face plane. Equivalent currents J = n x H and M = -n x E are integrated
// with the radiation vectors N and L (Balanis, e^{jwt} convention):
//   E_theta = -j k / (4 pi) (L_phi + eta N_theta),  E_phi = j k / (4 pi) (L_theta - eta N_phi)
//   U = |r E|^2 / (2 eta).
class Nf2ff {
public:
    /// Box faces at node indices lo[a] and hi[a] on each axis.
    Nf2ff(const YeeFields& f, std::array<int, 3> lo, std::array<int, 3> hi, std::vector<double> freqs);

    void accumulateH(long long n, ThreadPool& pool); // H^{n+1/2}
    void accumulateE(long long n, ThreadPool& pool); // E^{n+1}

    const std::vector<double>& frequencies() const { return freqs_; }
    /// Far field at frequency index fi on a list of directions.
    FarFieldGrid farField(int fi, const std::vector<double>& theta, const std::vector<double>& phi,
                          ThreadPool& pool) const;
    /// Radiated power by Gauss-Legendre quadrature in cos(theta) x uniform phi.
    double radiatedPower(int fi, int nTheta, int nPhi, ThreadPool& pool) const;
    /// Real power flowing out through the box: 0.5 Re closed-integral (E x H*) . n dS.
    double poyntingPower(int fi) const;
    std::size_t memoryBytes() const;

    /// Face layout for an external time loop (the WebGPU backend). Offsets count
    /// complex accumulator entries in exportAcc() order: per face Ep, Hq, Eq, Hp;
    /// entry (sample * nf + f). b-samples: p half x q node (nb = (B1-B0)(C1-C0+1));
    /// c-samples: p node x q half (nc = (B1-B0+1)(C1-C0)).
    struct FaceInfo {
        int a, side, plane, B0, B1, C0, C1;
        std::size_t nb, nc, offEp, offHq, offEq, offHp;
    };
    std::vector<FaceInfo> faceInfo() const;
    /// All accumulators (including the dt factor), re/im interleaved, in FaceInfo order.
    std::vector<double> exportAcc() const;
    /// Replaces the accumulators with values in exportAcc() layout.
    void importAcc(const std::vector<double>& acc);
    std::array<int, 3> lo() const { return lo_; }
    std::array<int, 3> hi() const { return hi_; }

private:
    struct Face {
        int a = 0, side = 1, plane = 0; // normal axis, outward sign, node index
        int B0 = 0, B1 = 0, C0 = 0, C1 = 0; // node ranges along p = (a+1)%3 and q = (a+2)%3
        double X = 0;                      // plane coordinate (m)
        std::vector<double> wB, wC;        // sample areas: b-samples (p half, q node), c-samples (p node, q half)
        // Accumulators [sample * nf + f]: b-samples hold E_p and H_q, c-samples E_q and H_p.
        std::vector<cd> Ep, Hq, Eq, Hp;
        int nbP() const { return B1 - B0; }   // p half count for b-samples
        int nbQ() const { return C1 - C0 + 1; }
        int ncP() const { return B1 - B0 + 1; }
        int ncQ() const { return C1 - C0; }
    };
    void accumulate(bool electric, long long n, ThreadPool& pool);
    void radiationVectors(int fi, double theta, double phi, cd N[3], cd L[3]) const;

    const YeeFields& f_;
    std::array<int, 3> lo_, hi_;
    std::vector<double> freqs_;
    std::vector<Face> faces_;
    struct Row {
        int face, jp;
    };
    std::vector<Row> rows_;
};

/// Gauss-Legendre nodes and weights on [-1, 1].
void gaussLegendre(int n, std::vector<double>& x, std::vector<double>& w);

} // namespace antsim

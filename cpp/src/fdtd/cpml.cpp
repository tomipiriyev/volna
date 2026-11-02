#include "antsim/cpml.hpp"
#include "antsim/constants.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace antsim {

namespace {

void profile(double rho, double depth, const PmlParams& p, double sigmaMax, double dt, float& b, float& c) {
    const double r = std::clamp(rho / depth, 0.0, 1.0);
    const double sigma = sigmaMax * std::pow(r, p.order);
    const double alpha = p.alphaMax * (1.0 - r);
    if (sigma <= 0.0) {
        b = 1.0f;
        c = 0.0f;
        return;
    }
    const double bb = std::exp(-(sigma + alpha) * dt / EPS0);
    b = static_cast<float>(bb);
    c = static_cast<float>(sigma / (sigma + alpha) * (bb - 1.0));
}

} // namespace

Cpml::Cpml(YeeFields& f, const std::array<Boundary, 6>& bc, const PmlParams& p) : f_(f) {
    const auto& g = f.grid();
    for (int face = 0; face < 6; ++face) {
        if (bc[face] != Boundary::Cpml) continue;
        const int a = face / 2;
        const bool high = face % 2;
        const int n = f.n(a);
        const int np = p.cells;
        if (2 * np + 2 > n) throw std::invalid_argument("domain too small for the PML on axis " + std::string(1, "xyz"[a]));
        cells_[face] = np;
        const auto& x = g.nodes(a);
        const double xIface = high ? x[n - np] : x[np];
        const double depth = std::abs(high ? x[n] - xIface : xIface - x[0]);
        const double sigmaMax = p.sigmaFactor * 0.8 * (p.order + 1.0) / (ETA0 * depth / np);

        Slab s;
        s.axis = a;
        // E nodes strictly inside the PML (the outer face is PEC, the interface has sigma = 0).
        s.lo = high ? n - np + 1 : 1;
        s.hi = high ? n - 1 : np - 1;
        const int hLo = high ? n - np : 0, hHi = high ? n - 1 : np - 1; // half nodes
        for (int i = s.lo; i <= s.hi; ++i) {
            float b, c;
            profile(std::abs(x[i] - xIface), depth, p, sigmaMax, f.dt(), b, c);
            s.bE.push_back(b);
            s.cE.push_back(c);
        }
        for (int i = hLo; i <= hHi; ++i) {
            float b, c;
            profile(std::abs(0.5 * (x[i] + x[i + 1]) - xIface), depth, p, sigmaMax, f.dt(), b, c);
            s.bH.push_back(b);
            s.cH.push_back(c);
        }
        // Store the H range in lo/hi of the H profile via its size; remember the start.
        const int pAx = (a + 1) % 3, qAx = (a + 2) % 3;
        s.planeE = static_cast<std::size_t>(f.n(pAx) + 1) * (f.n(qAx) + 1);
        s.psiEp.assign(s.bE.size() * s.planeE, 0.0f);
        s.psiEq.assign(s.bE.size() * s.planeE, 0.0f);
        s.psiHp.assign(s.bH.size() * s.planeE, 0.0f);
        s.psiHq.assign(s.bH.size() * s.planeE, 0.0f);
        // Encode the H half-node start in the sign-free slot: hLo = lo - 1 (low side: 0 = 1 - 1;
        // high side: n - np = (n - np + 1) - 1). Both cases satisfy hLo == lo - 1.
        if (hLo != s.lo - 1 || hHi != s.hi) throw std::logic_error("unexpected PML index layout");
        slabs_.push_back(std::move(s));
    }
}

void Cpml::correctE(ThreadPool& pool) {
    // One fork/join per axis. Slabs of different axes overlap at PML edges and
    // corners (the same field gets both corrections), so they run one after
    // another; the low and high slab of one axis are disjoint.
    for (int ax = 0; ax < 3; ++ax) {
    if (std::none_of(slabs_.begin(), slabs_.end(), [&](const Slab& sl) { return sl.axis == ax; })) continue;
    pool.run([&](int tid, int nt) {
    for (auto& s : slabs_) {
        if (s.axis != ax) continue;
        const int a = s.axis, pAx = (a + 1) % 3, qAx = (a + 2) % 3;
        const int np_ = f_.n(pAx), nq = f_.n(qAx);
        const std::size_t sa = f_.stride(a);
        auto& Ep = f_.E(pAx);
        auto& Eq = f_.E(qAx);
        const auto& Hp = f_.H(pAx);
        const auto& Hq = f_.H(qAx);
        const auto& Mp = f_.M(pAx);
        const auto& Mq = f_.M(qAx);
        const float* cb = f_.materials.cb.data();
        {
            const auto [j0, j1] = ThreadPool::range(0, np_ + 1, tid, nt);
            for (int li = 0; li <= s.hi - s.lo; ++li) {
                const int i = s.lo + li;
                const float b = s.bE[li], c = s.cE[li];
                if (c == 0.0f) continue;
                const float inv = f_.invDd[a][i];
                for (int jp = j0; jp < j1; ++jp) {
                    for (int jq = 0; jq <= nq; ++jq) {
                        int ijk[3];
                        ijk[a] = i;
                        ijk[pAx] = jp;
                        ijk[qAx] = jq;
                        const std::size_t at = f_.idx(ijk[0], ijk[1], ijk[2]);
                        const std::size_t ps = li * s.planeE + static_cast<std::size_t>(jp) * (nq + 1) + jq;
                        // E_p gets -dH_q/da, E_q gets +dH_p/da.
                        if (jp < np_ && f_.eActive(pAx, ijk[0], ijk[1], ijk[2])) {
                            const float d = (Hq[at] - Hq[at - sa]) * inv;
                            s.psiEp[ps] = b * s.psiEp[ps] + c * d;
                            Ep[at] -= cb[Mp[at]] * s.psiEp[ps];
                        }
                        if (jq < nq && f_.eActive(qAx, ijk[0], ijk[1], ijk[2])) {
                            const float d = (Hp[at] - Hp[at - sa]) * inv;
                            s.psiEq[ps] = b * s.psiEq[ps] + c * d;
                            Eq[at] += cb[Mq[at]] * s.psiEq[ps];
                        }
                    }
                }
            }
        }
    }
    });
    }
}

void Cpml::correctH(ThreadPool& pool) {
    const float ch = static_cast<float>(f_.dt() / MU0);
    for (int ax = 0; ax < 3; ++ax) {
    if (std::none_of(slabs_.begin(), slabs_.end(), [&](const Slab& sl) { return sl.axis == ax; })) continue;
    pool.run([&](int tid, int nt) {
    for (auto& s : slabs_) {
        if (s.axis != ax) continue;
        const int a = s.axis, pAx = (a + 1) % 3, qAx = (a + 2) % 3;
        const int np_ = f_.n(pAx), nq = f_.n(qAx);
        const std::size_t sa = f_.stride(a);
        const auto& Ep = f_.E(pAx);
        const auto& Eq = f_.E(qAx);
        auto& Hp = f_.H(pAx);
        auto& Hq = f_.H(qAx);
        const int hLo = s.lo - 1;
        {
            const auto [j0, j1] = ThreadPool::range(0, np_ + 1, tid, nt);
            for (int li = 0; li < static_cast<int>(s.bH.size()); ++li) {
                const int i = hLo + li;
                const float b = s.bH[li], c = s.cH[li];
                if (c == 0.0f) continue;
                const float inv = f_.invD[a][i];
                for (int jp = j0; jp < j1; ++jp) {
                    for (int jq = 0; jq <= nq; ++jq) {
                        int ijk[3];
                        ijk[a] = i;
                        ijk[pAx] = jp;
                        ijk[qAx] = jq;
                        const std::size_t at = f_.idx(ijk[0], ijk[1], ijk[2]);
                        const std::size_t ps = li * s.planeE + static_cast<std::size_t>(jp) * (nq + 1) + jq;
                        // H_p (node along p, half along q) gets +dE_q/da; H_q (half along p) gets -dE_p/da.
                        if (jq < nq) {
                            const float d = (Eq[at + sa] - Eq[at]) * inv;
                            s.psiHp[ps] = b * s.psiHp[ps] + c * d;
                            Hp[at] += ch * s.psiHp[ps];
                        }
                        if (jp < np_) {
                            const float d = (Ep[at + sa] - Ep[at]) * inv;
                            s.psiHq[ps] = b * s.psiHq[ps] + c * d;
                            Hq[at] -= ch * s.psiHq[ps];
                        }
                    }
                }
            }
        }
    }
    });
    }
}

std::vector<Cpml::SlabInfo> Cpml::slabInfo() const {
    std::vector<SlabInfo> out;
    std::size_t profE = 0, profH = 0, psiE = 0, psiH = 0;
    for (const auto& s : slabs_) {
        const SlabInfo info{s.axis, s.lo, s.hi, static_cast<int>(s.bE.size()), static_cast<int>(s.bH.size()), s.planeE, profE, profH, psiE, psiH};
        out.push_back(info);
        profE += s.bE.size();
        profH += s.bH.size();
        psiE += s.bE.size() * s.planeE;
        psiH += s.bH.size() * s.planeE;
    }
    return out;
}

std::vector<float> Cpml::profiles(bool electric) const {
    std::vector<float> out;
    for (const auto& s : slabs_) {
        const auto& b = electric ? s.bE : s.bH;
        const auto& c = electric ? s.cE : s.cH;
        for (std::size_t i = 0; i < b.size(); ++i) {
            out.push_back(b[i]);
            out.push_back(c[i]);
        }
    }
    return out;
}

void Cpml::releaseState() {
    for (auto& s : slabs_)
        for (auto* v : {&s.psiEp, &s.psiEq, &s.psiHp, &s.psiHq}) std::vector<float>().swap(*v);
}

std::size_t Cpml::memoryBytes() const {
    std::size_t b = 0;
    for (const auto& s : slabs_)
        b += (s.psiEp.size() + s.psiEq.size() + s.psiHp.size() + s.psiHq.size()) * sizeof(float);
    return b;
}

} // namespace antsim

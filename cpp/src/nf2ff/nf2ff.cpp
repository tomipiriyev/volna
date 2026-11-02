#include "antsim/nf2ff.hpp"
#include "antsim/constants.hpp"

#include <cmath>
#include <stdexcept>
#include <string>

namespace antsim {

void gaussLegendre(int n, std::vector<double>& x, std::vector<double>& w) {
    x.assign(n, 0.0);
    w.assign(n, 0.0);
    for (int i = 0; i < (n + 1) / 2; ++i) {
        double z = std::cos(PI * (i + 0.75) / (n + 0.5)), pp = 0;
        for (int it = 0; it < 100; ++it) {
            double p1 = 1.0, p2 = 0.0;
            for (int j = 1; j <= n; ++j) {
                const double p3 = p2;
                p2 = p1;
                p1 = ((2.0 * j - 1.0) * z * p2 - (j - 1.0) * p3) / j;
            }
            pp = n * (z * p1 - p2) / (z * z - 1.0);
            const double z1 = z;
            z = z1 - p1 / pp;
            if (std::abs(z - z1) < 1e-15) break;
        }
        x[i] = -z;
        x[n - 1 - i] = z;
        w[i] = w[n - 1 - i] = 2.0 / ((1.0 - z * z) * pp * pp);
    }
}

Nf2ff::Nf2ff(const YeeFields& f, std::array<int, 3> lo, std::array<int, 3> hi, std::vector<double> freqs)
    : f_(f), lo_(lo), hi_(hi), freqs_(std::move(freqs)) {
    for (int a = 0; a < 3; ++a)
        if (!(lo[a] >= 1 && hi[a] <= f.n(a) - 1 && hi[a] - lo[a] >= 2))
            throw std::invalid_argument("NF2FF box must lie inside the domain with at least 2 cells per axis");
    const int nf = static_cast<int>(freqs_.size());
    const auto& g = f.grid();
    // Dual length of node k within [k0, k1] (half cells at the box edges).
    auto trimmedDual = [](const std::vector<double>& x, int k, int k0, int k1) {
        const double lo = k > k0 ? 0.5 * (x[k] - x[k - 1]) : 0.0;
        const double hi = k < k1 ? 0.5 * (x[k + 1] - x[k]) : 0.0;
        return lo + hi;
    };
    for (int a = 0; a < 3; ++a) {
        for (int side : {-1, 1}) {
            Face fc;
            fc.a = a;
            fc.side = side;
            fc.plane = side < 0 ? lo[a] : hi[a];
            fc.X = g.nodes(a)[fc.plane];
            const int p = (a + 1) % 3, q = (a + 2) % 3;
            fc.B0 = lo[p];
            fc.B1 = hi[p];
            fc.C0 = lo[q];
            fc.C1 = hi[q];
            const auto& xp = g.nodes(p);
            const auto& xq = g.nodes(q);
            for (int jp = fc.B0; jp < fc.B1; ++jp)
                for (int jq = fc.C0; jq <= fc.C1; ++jq) fc.wB.push_back((xp[jp + 1] - xp[jp]) * trimmedDual(xq, jq, fc.C0, fc.C1));
            for (int jp = fc.B0; jp <= fc.B1; ++jp)
                for (int jq = fc.C0; jq < fc.C1; ++jq) fc.wC.push_back(trimmedDual(xp, jp, fc.B0, fc.B1) * (xq[jq + 1] - xq[jq]));
            fc.Ep.assign(fc.wB.size() * nf, cd(0, 0));
            fc.Hq.assign(fc.wB.size() * nf, cd(0, 0));
            fc.Eq.assign(fc.wC.size() * nf, cd(0, 0));
            fc.Hp.assign(fc.wC.size() * nf, cd(0, 0));
            const int face = static_cast<int>(faces_.size());
            for (int jp = fc.B0; jp <= fc.B1; ++jp) rows_.push_back({face, jp});
            faces_.push_back(std::move(fc));
        }
    }
}

std::vector<Nf2ff::FaceInfo> Nf2ff::faceInfo() const {
    std::vector<FaceInfo> out;
    const std::size_t nf = freqs_.size();
    std::size_t off = 0;
    for (const auto& fc : faces_) {
        FaceInfo fi{fc.a, fc.side, fc.plane, fc.B0, fc.B1, fc.C0, fc.C1, fc.wB.size(), fc.wC.size(), 0, 0, 0, 0};
        fi.offEp = off;
        off += fc.wB.size() * nf;
        fi.offHq = off;
        off += fc.wB.size() * nf;
        fi.offEq = off;
        off += fc.wC.size() * nf;
        fi.offHp = off;
        off += fc.wC.size() * nf;
        out.push_back(fi);
    }
    return out;
}

std::vector<double> Nf2ff::exportAcc() const {
    std::vector<double> out;
    for (const auto& fc : faces_)
        for (const auto* v : {&fc.Ep, &fc.Hq, &fc.Eq, &fc.Hp})
            for (const cd& c : *v) {
                out.push_back(c.real());
                out.push_back(c.imag());
            }
    return out;
}

void Nf2ff::importAcc(const std::vector<double>& acc) {
    std::size_t need = 0;
    for (const auto& fc : faces_) need += 2 * (fc.Ep.size() + fc.Hq.size() + fc.Eq.size() + fc.Hp.size());
    if (acc.size() != need) throw std::invalid_argument("NF2FF import: expected " + std::to_string(need) + " values, got " + std::to_string(acc.size()));
    std::size_t k = 0;
    for (auto& fc : faces_)
        for (auto* v : {&fc.Ep, &fc.Hq, &fc.Eq, &fc.Hp})
            for (cd& c : *v) {
                c = cd(acc[k], acc[k + 1]);
                k += 2;
            }
}

void Nf2ff::accumulateH(long long n, ThreadPool& pool) { accumulate(false, n, pool); }
void Nf2ff::accumulateE(long long n, ThreadPool& pool) { accumulate(true, n, pool); }

void Nf2ff::accumulate(bool electric, long long n, ThreadPool& pool) {
    const double dt = f_.dt();
    const double t = electric ? (n + 1) * dt : (n + 0.5) * dt;
    const int nf = static_cast<int>(freqs_.size());
    std::vector<cd> ph(nf);
    for (int i = 0; i < nf; ++i) ph[i] = std::polar(dt, -2.0 * PI * freqs_[i] * t);
    pool.run([&](int tid, int nt) {
        const auto [r0, r1] = ThreadPool::range(0, static_cast<int>(rows_.size()), tid, nt);
        for (int r = r0; r < r1; ++r) {
            Face& fc = faces_[rows_[r].face];
            const int jp = rows_[r].jp;
            const int a = fc.a, p = (a + 1) % 3, q = (a + 2) % 3;
            const std::size_t sa = f_.stride(a);
            auto at = [&](int jpp, int jq) {
                int ijk[3];
                ijk[a] = fc.plane;
                ijk[p] = jpp;
                ijk[q] = jq;
                return f_.idx(ijk[0], ijk[1], ijk[2]);
            };
            // b-samples: E_p (p half) and H_q averaged across the plane.
            if (jp < fc.B1) {
                std::size_t s = static_cast<std::size_t>(jp - fc.B0) * fc.nbQ();
                for (int jq = fc.C0; jq <= fc.C1; ++jq, ++s) {
                    const std::size_t i = at(jp, jq);
                    const double v = electric ? f_.E(p)[i] : 0.5 * (f_.H(q)[i] + f_.H(q)[i - sa]);
                    cd* acc = electric ? &fc.Ep[s * nf] : &fc.Hq[s * nf];
                    for (int k = 0; k < nf; ++k) acc[k] += v * ph[k];
                }
            }
            // c-samples: E_q (q half) and H_p averaged across the plane.
            std::size_t s = static_cast<std::size_t>(jp - fc.B0) * fc.ncQ();
            for (int jq = fc.C0; jq < fc.C1; ++jq, ++s) {
                const std::size_t i = at(jp, jq);
                const double v = electric ? f_.E(q)[i] : 0.5 * (f_.H(p)[i] + f_.H(p)[i - sa]);
                cd* acc = electric ? &fc.Eq[s * nf] : &fc.Hp[s * nf];
                for (int k = 0; k < nf; ++k) acc[k] += v * ph[k];
            }
        }
    });
}

void Nf2ff::radiationVectors(int fi, double theta, double phi, cd N[3], cd L[3]) const {
    const int nf = static_cast<int>(freqs_.size());
    const double k = 2.0 * PI * freqs_[fi] / C0;
    const double rh[3] = {std::sin(theta) * std::cos(phi), std::sin(theta) * std::sin(phi), std::cos(theta)};
    const auto& g = f_.grid();
    for (int c = 0; c < 3; ++c) N[c] = L[c] = cd(0, 0);
    std::vector<cd> pq;
    for (const Face& fc : faces_) {
        const int a = fc.a, p = (a + 1) % 3, q = (a + 2) % 3;
        const auto& xp = g.nodes(p);
        const auto& xq = g.nodes(q);
        const cd pa = std::polar(1.0, k * rh[a] * fc.X);
        const double s = fc.side;
        // b-samples: J_p = -s H_q, M_q = -s E_p at (p half, q node).
        pq.resize(fc.nbQ());
        for (int jq = fc.C0; jq <= fc.C1; ++jq) pq[jq - fc.C0] = std::polar(1.0, k * rh[q] * xq[jq]);
        cd sumJ(0, 0), sumM(0, 0);
        std::size_t smp = 0;
        for (int jp = fc.B0; jp < fc.B1; ++jp) {
            cd rowJ(0, 0), rowM(0, 0);
            for (int jq = 0; jq < fc.nbQ(); ++jq, ++smp) {
                const double w = fc.wB[smp];
                rowJ += fc.Hq[smp * nf + fi] * (w * pq[jq]);
                rowM += fc.Ep[smp * nf + fi] * (w * pq[jq]);
            }
            const cd pp = std::polar(1.0, k * rh[p] * 0.5 * (xp[jp] + xp[jp + 1]));
            sumJ += rowJ * pp;
            sumM += rowM * pp;
        }
        N[p] += -s * pa * sumJ;
        L[q] += -s * pa * sumM;
        // c-samples: J_q = s H_p, M_p = s E_q at (p node, q half).
        pq.resize(fc.ncQ());
        for (int jq = fc.C0; jq < fc.C1; ++jq) pq[jq - fc.C0] = std::polar(1.0, k * rh[q] * 0.5 * (xq[jq] + xq[jq + 1]));
        sumJ = sumM = cd(0, 0);
        smp = 0;
        for (int jp = fc.B0; jp <= fc.B1; ++jp) {
            cd rowJ(0, 0), rowM(0, 0);
            for (int jq = 0; jq < fc.ncQ(); ++jq, ++smp) {
                const double w = fc.wC[smp];
                rowJ += fc.Hp[smp * nf + fi] * (w * pq[jq]);
                rowM += fc.Eq[smp * nf + fi] * (w * pq[jq]);
            }
            const cd pp = std::polar(1.0, k * rh[p] * xp[jp]);
            sumJ += rowJ * pp;
            sumM += rowM * pp;
        }
        N[q] += s * pa * sumJ;
        L[p] += s * pa * sumM;
    }
}

FarFieldGrid Nf2ff::farField(int fi, const std::vector<double>& theta, const std::vector<double>& phi,
                             ThreadPool& pool) const {
    FarFieldGrid out;
    out.theta = theta;
    out.phi = phi;
    const std::size_t nd = theta.size() * phi.size();
    out.eTheta.assign(nd, cd(0, 0));
    out.ePhi.assign(nd, cd(0, 0));
    out.U.assign(nd, 0.0);
    const double k = 2.0 * PI * freqs_[fi] / C0;
    const cd jk4(0.0, k / (4.0 * PI));
    pool.run([&](int tid, int nt) {
        const auto [d0, d1] = ThreadPool::range(0, static_cast<int>(nd), tid, nt);
        for (int d = d0; d < d1; ++d) {
            const double th = theta[d / phi.size()], ph = phi[d % phi.size()];
            cd N[3], L[3];
            radiationVectors(fi, th, ph, N, L);
            const double ct = std::cos(th), st = std::sin(th), cp = std::cos(ph), sp = std::sin(ph);
            const cd Nt = N[0] * ct * cp + N[1] * ct * sp - N[2] * st;
            const cd Np = -N[0] * sp + N[1] * cp;
            const cd Lt = L[0] * ct * cp + L[1] * ct * sp - L[2] * st;
            const cd Lp = -L[0] * sp + L[1] * cp;
            out.eTheta[d] = -jk4 * (Lp + ETA0 * Nt);
            out.ePhi[d] = jk4 * (Lt - ETA0 * Np);
            out.U[d] = (std::norm(out.eTheta[d]) + std::norm(out.ePhi[d])) / (2.0 * ETA0);
        }
    });
    return out;
}

double Nf2ff::radiatedPower(int fi, int nTheta, int nPhi, ThreadPool& pool) const {
    std::vector<double> mu, w;
    gaussLegendre(nTheta, mu, w);
    std::vector<double> th(nTheta), ph(nPhi);
    for (int i = 0; i < nTheta; ++i) th[i] = std::acos(mu[i]);
    for (int j = 0; j < nPhi; ++j) ph[j] = 2.0 * PI * j / nPhi;
    const FarFieldGrid g = farField(fi, th, ph, pool);
    double p = 0.0;
    for (int i = 0; i < nTheta; ++i)
        for (int j = 0; j < nPhi; ++j) p += w[i] * (2.0 * PI / nPhi) * g.U[static_cast<std::size_t>(i) * nPhi + j];
    return p;
}

double Nf2ff::poyntingPower(int fi) const {
    const int nf = static_cast<int>(freqs_.size());
    double p = 0.0;
    for (const Face& fc : faces_) {
        double s = 0.0;
        for (std::size_t i = 0; i < fc.wB.size(); ++i) s += fc.wB[i] * std::real(fc.Ep[i * nf + fi] * std::conj(fc.Hq[i * nf + fi]));
        for (std::size_t i = 0; i < fc.wC.size(); ++i) s -= fc.wC[i] * std::real(fc.Eq[i * nf + fi] * std::conj(fc.Hp[i * nf + fi]));
        p += 0.5 * fc.side * s;
    }
    return p;
}

std::size_t Nf2ff::memoryBytes() const {
    std::size_t b = 0;
    for (const Face& fc : faces_) b += (fc.Ep.size() + fc.Hq.size() + fc.Eq.size() + fc.Hp.size()) * sizeof(cd) + (fc.wB.size() + fc.wC.size()) * sizeof(double);
    return b;
}

} // namespace antsim

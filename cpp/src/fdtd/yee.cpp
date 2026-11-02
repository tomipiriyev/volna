#include "antsim/yee.hpp"
#include "antsim/constants.hpp"

#include <cmath>
#include <stdexcept>

namespace antsim {

void EdgeMaterialTable::reset(double dt) {
    ca.clear();
    cb.clear();
    epsR.clear();
    sigma.clear();
    conductor.clear();
    addRaw(0.0f, 0.0f, 1.0, 0.0, true); // PEC: E is pinned to zero.
    add(1.0, 0.0, dt);                  // vacuum
}

std::uint16_t EdgeMaterialTable::add(double er, double sig, double dt) {
    if (!(er >= 1.0) || !(sig >= 0.0)) throw std::invalid_argument("material needs epsR >= 1 and sigma >= 0");
    const double eps = EPS0 * er;
    const double s = sig * dt / (2.0 * eps);
    return addRaw(static_cast<float>((1.0 - s) / (1.0 + s)), static_cast<float>((dt / eps) / (1.0 + s)), er, sig, false);
}

std::uint16_t EdgeMaterialTable::addMetal(double sig, double dt) {
    // Exponential time stepping: with sigma dt / eps in the thousands, the averaged
    // coefficients above give ca close to -1, a barely damped mode that flips sign
    // every step. Here ca = exp(-sigma dt / eps) -> 0 and E -> curl(H) / sigma.
    if (!(sig > 0.0)) throw std::invalid_argument("metal edge needs sigma > 0");
    const double ca = std::exp(-sig * dt / EPS0);
    return addRaw(static_cast<float>(ca), static_cast<float>((1.0 - ca) / sig), 1.0, sig, true);
}

std::uint16_t EdgeMaterialTable::addRaw(float a, float b, double er, double sig, bool cond) {
    if (ca.size() >= 0xFFFF) throw std::length_error("too many distinct edge materials");
    ca.push_back(a);
    cb.push_back(b);
    epsR.push_back(er);
    sigma.push_back(sig);
    conductor.push_back(cond ? 1 : 0);
    return static_cast<std::uint16_t>(ca.size() - 1);
}

YeeFields::YeeFields(const RectGrid& grid, double courant) : grid_(grid) {
    grid_.validate();
    dt_ = cflTimestep(grid_, courant);
    nx_ = grid_.nx();
    ny_ = grid_.ny();
    nz_ = grid_.nz();
    sy_ = static_cast<std::size_t>(nz_ + 1);
    sx_ = static_cast<std::size_t>(ny_ + 1) * sy_;
    n_ = static_cast<std::size_t>(nx_ + 1) * sx_;

    for (auto* v : {&ex, &ey, &ez, &hx, &hy, &hz}) v->assign(n_, 0.0f);
    for (auto* v : {&mx, &my, &mz}) v->assign(n_, EdgeMaterialTable::kVacuum);
    materials.reset(dt_);

    for (int a = 0; a < 3; ++a) {
        const auto& p = grid_.nodes(a);
        const int n = grid_.cells(a);
        d[a].resize(n);
        invD[a].resize(n);
        for (int i = 0; i < n; ++i) {
            d[a][i] = p[i + 1] - p[i];
            invD[a][i] = static_cast<float>(1.0 / d[a][i]);
        }
        dd[a].resize(n + 1);
        invDd[a].resize(n + 1);
        for (int i = 0; i <= n; ++i) {
            const double lo = i > 0 ? d[a][i - 1] : 0.0;
            const double hi = i < n ? d[a][i] : 0.0;
            dd[a][i] = 0.5 * (lo + hi);
            invDd[a][i] = static_cast<float>(1.0 / dd[a][i]);
        }
    }
    chH_ = static_cast<float>(dt_ / MU0);
}

void YeeFields::updateH(ThreadPool& pool) {
    pool.run([this](int tid, int nt) {
        const auto [i0, i1] = ThreadPool::range(0, nx_ + 1, tid, nt);
        const float ch = chH_;
        const float* __restrict idz = invD[2].data();
        for (int i = i0; i < i1; ++i) {
            for (int j = 0; j < ny_; ++j) { // Hx
                const std::size_t b = idx(i, j, 0);
                const float idy = invD[1][j];
                float* __restrict h = &hx[b];
                const float* __restrict ez0 = &ez[b];
                const float* __restrict ez1 = &ez[b + sy_];
                const float* __restrict ey0 = &ey[b];
                for (int k = 0; k < nz_; ++k)
                    h[k] -= ch * ((ez1[k] - ez0[k]) * idy - (ey0[k + 1] - ey0[k]) * idz[k]);
            }
            if (i == nx_) continue;
            const float idx_ = invD[0][i];
            for (int j = 0; j <= ny_; ++j) { // Hy
                const std::size_t b = idx(i, j, 0);
                float* __restrict h = &hy[b];
                const float* __restrict ex0 = &ex[b];
                const float* __restrict ez0 = &ez[b];
                const float* __restrict ez1 = &ez[b + sx_];
                for (int k = 0; k < nz_; ++k)
                    h[k] -= ch * ((ex0[k + 1] - ex0[k]) * idz[k] - (ez1[k] - ez0[k]) * idx_);
            }
            for (int j = 0; j < ny_; ++j) { // Hz
                const std::size_t b = idx(i, j, 0);
                const float idy = invD[1][j];
                float* __restrict h = &hz[b];
                const float* __restrict ey0 = &ey[b];
                const float* __restrict ey1 = &ey[b + sx_];
                const float* __restrict ex0 = &ex[b];
                const float* __restrict ex1 = &ex[b + sy_];
                for (int k = 0; k <= nz_; ++k)
                    h[k] -= ch * ((ey1[k] - ey0[k]) * idx_ - (ex1[k] - ex0[k]) * idy);
            }
        }
    });
}

bool YeeFields::eActive(int c, int i, int j, int k) const {
    const int idx3[3] = {i, j, k};
    for (int a = 0; a < 3; ++a) {
        if (a == c) {
            if (idx3[a] < 0 || idx3[a] >= n(a)) return false;
            continue;
        }
        if (idx3[a] < 0 || idx3[a] > n(a)) return false;
        if (idx3[a] == 0 && !pmc_[2 * a]) return false;
        if (idx3[a] == n(a) && !pmc_[2 * a + 1]) return false;
    }
    return true;
}

double YeeFields::curlH(int c, int i, int j, int k) const {
    // curl_c = dH_q/dp - dH_p/dq with (p, q) the cyclic successors of c.
    const int p = (c + 1) % 3, q = (c + 2) % 3;
    const int idx3[3] = {i, j, k};
    const std::size_t at = idx(i, j, k);
    // H_q lies at half positions along p (index range [0, n_p - 1]); H_p along q likewise.
    auto diff = [&](const std::vector<float>& h, int axis) {
        const int m = idx3[axis];
        const double hi = m <= n(axis) - 1 ? h[at] : 0.0;
        const double lo = m >= 1 ? h[at - stride(axis)] : 0.0;
        return (hi - lo) * invDd[axis][m];
    };
    return diff(H(q), p) - diff(H(p), q);
}

void YeeFields::updatePmcFaces() {
    // Tangential E on PMC faces: the bulk kernel skips face planes, so update them here.
    for (int face = 0; face < 6; ++face) {
        if (!pmc_[face]) continue;
        const int d = face / 2;
        const int plane = (face % 2) ? n(d) : 0;
        for (int c = 0; c < 3; ++c) {
            if (c == d) continue;
            const int o = 3 - c - d; // the other tangential axis
            auto& e = E(c);
            const auto& m = M(c);
            for (int a = 0; a < n(c); ++a) {
                for (int b = 0; b <= n(o); ++b) {
                    int ijk[3];
                    ijk[d] = plane;
                    ijk[c] = a;
                    ijk[o] = b;
                    if (!eActive(c, ijk[0], ijk[1], ijk[2])) continue;
                    const std::size_t q = idx(ijk[0], ijk[1], ijk[2]);
                    const float curl = static_cast<float>(curlH(c, ijk[0], ijk[1], ijk[2]));
                    e[q] = materials.ca[m[q]] * e[q] + materials.cb[m[q]] * curl;
                }
            }
        }
    }
}

void YeeFields::updateE(ThreadPool& pool) {
    pool.run([this](int tid, int nt) {
        const auto [i0, i1] = ThreadPool::range(0, nx_, tid, nt);
        const float* __restrict ca = materials.ca.data();
        const float* __restrict cb = materials.cb.data();
        const float* __restrict idzd = invDd[2].data();
        for (int i = i0; i < i1; ++i) {
            for (int j = 1; j < ny_; ++j) { // Ex
                const std::size_t b = idx(i, j, 0);
                const float idyd = invDd[1][j];
                float* __restrict e = &ex[b];
                const std::uint16_t* __restrict m = &mx[b];
                const float* __restrict hz0 = &hz[b];
                const float* __restrict hzm = &hz[b - sy_];
                const float* __restrict hy0 = &hy[b];
                for (int k = 1; k < nz_; ++k) {
                    const float curl = (hz0[k] - hzm[k]) * idyd - (hy0[k] - hy0[k - 1]) * idzd[k];
                    e[k] = ca[m[k]] * e[k] + cb[m[k]] * curl;
                }
            }
            if (i == 0) continue;
            const float idxd = invDd[0][i];
            for (int j = 0; j < ny_; ++j) { // Ey
                const std::size_t b = idx(i, j, 0);
                float* __restrict e = &ey[b];
                const std::uint16_t* __restrict m = &my[b];
                const float* __restrict hx0 = &hx[b];
                const float* __restrict hz0 = &hz[b];
                const float* __restrict hzm = &hz[b - sx_];
                for (int k = 1; k < nz_; ++k) {
                    const float curl = (hx0[k] - hx0[k - 1]) * idzd[k] - (hz0[k] - hzm[k]) * idxd;
                    e[k] = ca[m[k]] * e[k] + cb[m[k]] * curl;
                }
            }
            for (int j = 1; j < ny_; ++j) { // Ez
                const std::size_t b = idx(i, j, 0);
                const float idyd = invDd[1][j];
                float* __restrict e = &ez[b];
                const std::uint16_t* __restrict m = &mz[b];
                const float* __restrict hy0 = &hy[b];
                const float* __restrict hym = &hy[b - sx_];
                const float* __restrict hx0 = &hx[b];
                const float* __restrict hxm = &hx[b - sy_];
                for (int k = 0; k < nz_; ++k) {
                    const float curl = (hy0[k] - hym[k]) * idxd - (hx0[k] - hxm[k]) * idyd;
                    e[k] = ca[m[k]] * e[k] + cb[m[k]] * curl;
                }
            }
        }
    });
    if (pmc_[0] || pmc_[1] || pmc_[2] || pmc_[3] || pmc_[4] || pmc_[5]) updatePmcFaces();
}

double YeeFields::energy(ThreadPool* pool) const {
    // Per-i partial sums, combined in i order: identical for any thread count.
    std::vector<double> partial(nx_ + 1, 0.0);
    if (pool) {
        pool->run([&](int tid, int nt) {
            const auto [i0, i1] = ThreadPool::range(0, nx_ + 1, tid, nt);
            for (int i = i0; i < i1; ++i) partial[i] = energySlab(i);
        });
    } else {
        for (int i = 0; i <= nx_; ++i) partial[i] = energySlab(i);
    }
    double total = 0.0;
    for (double p : partial) total += p;
    return 0.5 * total;
}

double YeeFields::energySlab(int i) const {
    {
        double s = 0.0;
        for (int j = 0; j <= ny_; ++j) {
            for (int k = 0; k <= nz_; ++k) {
                const std::size_t q = idx(i, j, k);
                if (i < nx_) {
                    const double ve = d[0][i] * dd[1][j] * dd[2][k];
                    s += EPS0 * materials.epsR[mx[q]] * ex[q] * ex[q] * ve;
                }
                if (j < ny_) {
                    const double ve = dd[0][i] * d[1][j] * dd[2][k];
                    s += EPS0 * materials.epsR[my[q]] * ey[q] * ey[q] * ve;
                }
                if (k < nz_) {
                    const double ve = dd[0][i] * dd[1][j] * d[2][k];
                    s += EPS0 * materials.epsR[mz[q]] * ez[q] * ez[q] * ve;
                }
                if (j < ny_ && k < nz_) s += MU0 * hx[q] * hx[q] * dd[0][i] * d[1][j] * d[2][k];
                if (i < nx_ && k < nz_) s += MU0 * hy[q] * hy[q] * d[0][i] * dd[1][j] * d[2][k];
                if (i < nx_ && j < ny_) s += MU0 * hz[q] * hz[q] * d[0][i] * d[1][j] * dd[2][k];
            }
        }
        return s;
    }
}

std::size_t YeeFields::memoryBytes() const {
    std::size_t bytes = n_ * (6 * sizeof(float) + 3 * sizeof(std::uint16_t));
    for (int a = 0; a < 3; ++a)
        bytes += (invD[a].size() + invDd[a].size()) * sizeof(float) + (d[a].size() + dd[a].size()) * sizeof(double);
    return bytes;
}

} // namespace antsim

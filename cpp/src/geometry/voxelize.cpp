#include "antsim/voxelize.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace antsim {

TriMesh TriMesh::fromFloats(const std::vector<float>& pos, const std::vector<std::uint32_t>& idx, double unit) {
    TriMesh m;
    m.p.resize(pos.size());
    for (std::size_t i = 0; i < pos.size(); ++i) m.p[i] = static_cast<double>(pos[i]) * unit;
    m.idx = idx;
    m.lo.fill(std::numeric_limits<double>::infinity());
    m.hi.fill(-std::numeric_limits<double>::infinity());
    for (std::size_t v = 0; v < m.p.size() / 3; ++v)
        for (int a = 0; a < 3; ++a) {
            m.lo[a] = std::min(m.lo[a], m.p[3 * v + a]);
            m.hi[a] = std::max(m.hi[a], m.p[3 * v + a]);
        }
    double v6 = 0;
    for (std::size_t t = 0; t < m.triangles(); ++t) {
        const double* A = &m.p[3 * idx[3 * t]];
        const double* B = &m.p[3 * idx[3 * t + 1]];
        const double* C = &m.p[3 * idx[3 * t + 2]];
        v6 += A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
    }
    m.signedVolume = v6 / 6.0;
    return m;
}

namespace {

struct Bins {
    double u0, v0, du, dv;
    int nu, nv;
};

// Builds CSR bins of triangle indices over the projected (p, q) bounding box.
Bins buildBins(const TriMesh& m, int p, int q, double grow, std::vector<std::uint32_t>& start, std::vector<std::uint32_t>& tris) {
    Bins b;
    const std::size_t nt = m.triangles();
    const int n = std::clamp(static_cast<int>(std::sqrt(static_cast<double>(nt) / 2.0)), 1, 512);
    b.nu = b.nv = n;
    const double eu = std::max(m.hi[p] - m.lo[p], 1e-12), ev = std::max(m.hi[q] - m.lo[q], 1e-12);
    b.u0 = m.lo[p] - grow * eu;
    b.v0 = m.lo[q] - grow * ev;
    b.du = eu * (1 + 2 * grow) / n;
    b.dv = ev * (1 + 2 * grow) / n;
    auto range = [&](std::size_t t, int& iu0, int& iu1, int& iv0, int& iv1) {
        double umin = 1e300, umax = -1e300, vmin = 1e300, vmax = -1e300;
        for (int k = 0; k < 3; ++k) {
            const double* P = &m.p[3 * m.idx[3 * t + k]];
            umin = std::min(umin, P[p]);
            umax = std::max(umax, P[p]);
            vmin = std::min(vmin, P[q]);
            vmax = std::max(vmax, P[q]);
        }
        const double gu = grow * eu, gv = grow * ev;
        iu0 = std::clamp(static_cast<int>(std::floor((umin - gu - b.u0) / b.du)), 0, n - 1);
        iu1 = std::clamp(static_cast<int>(std::floor((umax + gu - b.u0) / b.du)), 0, n - 1);
        iv0 = std::clamp(static_cast<int>(std::floor((vmin - gv - b.v0) / b.dv)), 0, n - 1);
        iv1 = std::clamp(static_cast<int>(std::floor((vmax + gv - b.v0) / b.dv)), 0, n - 1);
    };
    std::vector<std::uint32_t> count(static_cast<std::size_t>(n) * n + 1, 0);
    for (std::size_t t = 0; t < nt; ++t) {
        int a0, a1, c0, c1;
        range(t, a0, a1, c0, c1);
        for (int i = a0; i <= a1; ++i)
            for (int j = c0; j <= c1; ++j) ++count[static_cast<std::size_t>(i) * n + j + 1];
    }
    for (std::size_t i = 1; i < count.size(); ++i) count[i] += count[i - 1];
    start = count;
    tris.assign(count.back(), 0);
    std::vector<std::uint32_t> fill(count.begin(), count.end() - 1);
    for (std::size_t t = 0; t < nt; ++t) {
        int a0, a1, c0, c1;
        range(t, a0, a1, c0, c1);
        for (int i = a0; i <= a1; ++i)
            for (int j = c0; j <= c1; ++j) tris[fill[static_cast<std::size_t>(i) * n + j]++] = static_cast<std::uint32_t>(t);
    }
    return b;
}

inline double edgeFn(double p0u, double p0v, double p1u, double p1v, double u, double v) {
    return (p1u - p0u) * (v - p0v) - (p1v - p0v) * (u - p0u);
}

inline bool topLeft(double p0u, double p0v, double p1u, double p1v) {
    const double dv = p1v - p0v, du = p1u - p0u;
    return dv < 0 || (dv == 0 && du < 0);
}

} // namespace

AxisRayCaster::AxisRayCaster(const TriMesh& m, int axis) : m_(m), a_(axis), p_((axis + 1) % 3), q_((axis + 2) % 3) {
    if (m.triangles() == 0) throw std::invalid_argument("voxelizer: empty mesh");
    const Bins b = buildBins(m, p_, q_, 1e-9, binStart_, binTris_);
    u0_ = b.u0;
    v0_ = b.v0;
    du_ = b.du;
    dv_ = b.dv;
    nu_ = b.nu;
    nv_ = b.nv;
    sign_ = m.signedVolume < 0 ? -1.0 : 1.0;
    const double span = std::max({m.hi[0] - m.lo[0], m.hi[1] - m.lo[1], m.hi[2] - m.lo[2], 1e-12});
    areaEps_ = 1e-14 * span * span;
}

void AxisRayCaster::intervals(double u, double v, std::vector<Interval>& out) const {
    out.clear();
    const int iu = static_cast<int>(std::floor((u - u0_) / du_)), iv = static_cast<int>(std::floor((v - v0_) / dv_));
    if (iu < 0 || iu >= nu_ || iv < 0 || iv >= nv_) return;
    const std::size_t bin = static_cast<std::size_t>(iu) * nv_ + iv;
    thread_local std::vector<std::pair<double, int>> hits;
    hits.clear();
    for (std::uint32_t k = binStart_[bin]; k < binStart_[bin + 1]; ++k) {
        const std::uint32_t t = binTris_[k];
        const double* A = &m_.p[3 * m_.idx[3 * t]];
        const double* B = &m_.p[3 * m_.idx[3 * t + 1]];
        const double* C = &m_.p[3 * m_.idx[3 * t + 2]];
        const double S = edgeFn(A[p_], A[q_], B[p_], B[q_], C[p_], C[q_]);
        if (std::abs(S) <= areaEps_) continue; // edge-on to the ray
        const double* P0 = A;
        const double* P1 = S > 0 ? B : C;
        const double* P2 = S > 0 ? C : B;
        const double w0 = edgeFn(P1[p_], P1[q_], P2[p_], P2[q_], u, v);
        const double w1 = edgeFn(P2[p_], P2[q_], P0[p_], P0[q_], u, v);
        const double w2 = edgeFn(P0[p_], P0[q_], P1[p_], P1[q_], u, v);
        const bool in0 = w0 > 0 || (w0 == 0 && topLeft(P1[p_], P1[q_], P2[p_], P2[q_]));
        const bool in1 = w1 > 0 || (w1 == 0 && topLeft(P2[p_], P2[q_], P0[p_], P0[q_]));
        const bool in2 = w2 > 0 || (w2 == 0 && topLeft(P0[p_], P0[q_], P1[p_], P1[q_]));
        if (!(in0 && in1 && in2)) continue;
        const double sum = w0 + w1 + w2;
        const double hitAt = (w0 * P0[a_] + w1 * P1[a_] + w2 * P2[a_]) / sum;
        // S > 0: outward normal along +axis, so the ray leaves the solid here (+1).
        const bool exits = (S > 0) == (sign_ > 0);
        hits.emplace_back(hitAt, exits ? 1 : -1);
    }
    std::sort(hits.begin(), hits.end(), [](const auto& x, const auto& y) {
        return x.first < y.first || (x.first == y.first && x.second < y.second); // enters first
    });
    int w = 0;
    double startT = 0;
    for (const auto& [t, s] : hits) {
        if (s < 0) {
            if (w == 0) startT = t;
            ++w;
        } else if (w > 0) {
            --w;
            if (w == 0 && t > startT) out.emplace_back(startT, t);
        }
    }
    mergeIntervals(out);
}

void AxisRayCaster::inclusiveIntervals(double u, double v, double eps, std::vector<Interval>& out) const {
    out.clear();
    thread_local std::vector<Interval> tmp;
    for (int su : {-1, 1})
        for (int sv : {-1, 1}) {
            intervals(u + su * eps, v + sv * eps, tmp);
            out.insert(out.end(), tmp.begin(), tmp.end());
        }
    mergeIntervals(out);
}

Footprint::Footprint(const TriMesh& m, int axis) : m_(m), p_((axis + 1) % 3), q_((axis + 2) % 3) {
    if (m.triangles() == 0) throw std::invalid_argument("voxelizer: empty sheet");
    const Bins b = buildBins(m, p_, q_, 1e-6, binStart_, binTris_);
    u0_ = b.u0;
    v0_ = b.v0;
    du_ = b.du;
    dv_ = b.dv;
    nu_ = b.nu;
    nv_ = b.nv;
}

bool Footprint::contains(double u, double v, double tol) const {
    const int iu = static_cast<int>(std::floor((u - u0_) / du_)), iv = static_cast<int>(std::floor((v - v0_) / dv_));
    if (iu < 0 || iu >= nu_ || iv < 0 || iv >= nv_) return false;
    const std::size_t bin = static_cast<std::size_t>(iu) * nv_ + iv;
    for (std::uint32_t k = binStart_[bin]; k < binStart_[bin + 1]; ++k) {
        const std::uint32_t t = binTris_[k];
        const double* A = &m_.p[3 * m_.idx[3 * t]];
        const double* B = &m_.p[3 * m_.idx[3 * t + 1]];
        const double* C = &m_.p[3 * m_.idx[3 * t + 2]];
        const double S = edgeFn(A[p_], A[q_], B[p_], B[q_], C[p_], C[q_]);
        if (std::abs(S) < 1e-30) continue; // side walls of thin plates project to lines
        const double l0 = edgeFn(B[p_], B[q_], C[p_], C[q_], u, v) / S;
        const double l1 = edgeFn(C[p_], C[q_], A[p_], A[q_], u, v) / S;
        const double l2 = 1.0 - l0 - l1;
        if (l0 >= -tol && l1 >= -tol && l2 >= -tol) return true;
    }
    return false;
}

void mergeIntervals(std::vector<Interval>& v) {
    if (v.size() < 2) return;
    std::sort(v.begin(), v.end());
    std::size_t w = 0;
    for (std::size_t i = 1; i < v.size(); ++i) {
        if (v[i].first <= v[w].second) v[w].second = std::max(v[w].second, v[i].second);
        else v[++w] = v[i];
    }
    v.resize(w + 1);
}

double coveredLength(const std::vector<Interval>& v, double a, double b) {
    double s = 0;
    for (const auto& [lo, hi] : v) {
        if (hi <= a) continue;
        if (lo >= b) break;
        s += std::min(hi, b) - std::max(lo, a);
    }
    return s;
}

} // namespace antsim

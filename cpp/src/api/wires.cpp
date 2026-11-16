// Thin wires at any angle (docs/physics.md, "Thin wires").
//
// A wire is a chain of straight segments with a current I per segment (at half steps,
// like H) and a charge q per node (at whole steps, like E). The grid carries the field;
// the wire adds what the grid cannot resolve, its in-cell inductance and capacitance:
//   (L' l) dI/dt = sum_e w_e E_e - (phi_b - phi_a) [+ V_s - R I],  phi = q / (C' l~)
//   dq/dt = current in - current out
// and its current is deposited into the grid as a current density on the same edges:
//   eps dE_e/dt = curl H - w_e I / V_e.
// One set of weights w_e (length times direction, from interpolation at points along the
// segment) is used both ways, so the field and the wire exchange energy exactly.
// L' = mu/(2 pi) ln(r0/a) and 1/C' = ln(r0/a)/(2 pi eps), where r0 is the effective
// radius of the grid's own picture of a line current with these weights (from a static
// lattice solve, tabulated below) and a the wire's radius.
#include "antsim/constants.hpp"
#include "antsim/metal.hpp"
#include "antsim/solver.hpp"

#include <algorithm>
#include <cmath>
#include <map>

namespace antsim {

namespace {

// r0 / h of a line current spread over the four parallel edges around it by bilinear
// weights, at sub-cell offset (fu, fv) in [0, 0.5] (symmetric), steps of 0.1. Computed by
// solving the discrete 2-D Laplacian (the static limit of the Yee curl-curl) for that
// source and reading A back with the same weights: 0.199 h on a grid line, 0.718 h at
// the cell centre.
constexpr double kR0[6][6] = {
    {0.1985, 0.2634, 0.3282, 0.3840, 0.4219, 0.4354},
    {0.2634, 0.3367, 0.4077, 0.4673, 0.5072, 0.5212},
    {0.3282, 0.4077, 0.4826, 0.5445, 0.5853, 0.5996},
    {0.3840, 0.4673, 0.5445, 0.6072, 0.6483, 0.6626},
    {0.4219, 0.5072, 0.5853, 0.6483, 0.6894, 0.7036},
    {0.4354, 0.5212, 0.5996, 0.6626, 0.7036, 0.7178},
};

double r0OverH(double fu, double fv) {
    fu = std::min(fu, 1.0 - fu) * 10.0;
    fv = std::min(fv, 1.0 - fv) * 10.0;
    const int iu = std::min(static_cast<int>(fu), 4), iv = std::min(static_cast<int>(fv), 4);
    const double tu = fu - iu, tv = fv - iv;
    return (1 - tu) * (1 - tv) * kR0[iu][iv] + tu * (1 - tv) * kR0[iu + 1][iv] + (1 - tu) * tv * kR0[iu][iv + 1] + tu * tv * kR0[iu + 1][iv + 1];
}

// Cell index along an axis containing x (clamped), and the fraction across it.
std::pair<int, double> cellOf(const std::vector<double>& x, double v) {
    const int n = static_cast<int>(x.size()) - 1;
    int i = static_cast<int>(std::upper_bound(x.begin(), x.end(), v) - x.begin()) - 1;
    i = std::clamp(i, 0, n - 1);
    return {i, std::clamp((v - x[i]) / (x[i + 1] - x[i]), 0.0, 1.0)};
}

// Below this ln(r0 / a) the wire is not thin next to the local cells (its radius is
// close to the grid's own effective radius), and the in-cell term is held here.
constexpr double kMinLog = 0.2;
// As in solver.cpp: leapfrog needs the update's largest eigenvalue below 4.
constexpr double kStableEigenvalue = 3.98;

double minSpacingAll(const RectGrid& g) { return std::min({g.minSpacing(0), g.minSpacing(1), g.minSpacing(2)}); }

} // namespace

void Solver::buildWires() {
    YeeFields& f = *f_;
    const RectGrid& g = f.grid();
    const int n[3] = {f.nx(), f.ny(), f.nz()};
    const double unit = p_.unit;
    const double fRef = p_.metalLossFrequency > 0 ? p_.metalLossFrequency : std::sqrt(p_.fMin * p_.fMax);
    auto localCell = [&](const std::array<double, 3>& r) {
        double prod = 1;
        for (int a = 0; a < 3; ++a) prod *= g.nodes(a)[cellOf(g.nodes(a), r[a]).first + 1] - g.nodes(a)[cellOf(g.nodes(a), r[a]).first];
        return std::cbrt(prod);
    };
    auto dist = [](const std::array<double, 3>& a, const std::array<double, 3>& b) {
        return std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
    };
    std::vector<std::array<double, 3>> nodePos;
    struct Pending {
        int a, b;
        double radius, rPerLength;
        bool source;
    };
    std::vector<Pending> segs;
    const std::array<double, 3> portStart = {p_.port.start[0] * unit, p_.port.start[1] * unit, p_.port.start[2] * unit};
    const std::array<double, 3> portStop = {p_.port.stop[0] * unit, p_.port.stop[1] * unit, p_.port.stop[2] * unit};
    const double snapTol = 1e-3 * minSpacingAll(g) + 1e-9;
    int portGround = -1;

    for (const ObjectSpec& o : p_.objects) {
        if (o.kind != ObjectSpec::Kind::Wire) continue;
        const double a = o.radius * unit;
        double rPerLength = 0;
        for (const auto& m : p_.materials)
            if (m.name == o.material && m.metal) rPerLength = wireResistance(m.conductivity, fRef, a);
        std::vector<std::array<double, 3>> pts;
        for (std::size_t i = 0; i + 2 < o.positions.size(); i += 3) pts.push_back({o.positions[i] * unit, o.positions[i + 1] * unit, o.positions[i + 2] * unit});
        // Resample by arc length, about one local cell per segment, keeping the ends.
        std::vector<double> s(pts.size(), 0.0);
        for (std::size_t i = 1; i < pts.size(); ++i) s[i] = s[i - 1] + dist(pts[i - 1], pts[i]);
        auto at = [&](double t) {
            const std::size_t i = std::min<std::size_t>(std::upper_bound(s.begin(), s.end(), t) - s.begin(), pts.size() - 1);
            const std::size_t i0 = i == 0 ? 0 : i - 1;
            const double span = s[i] - s[i0], u = span > 0 ? (t - s[i0]) / span : 0.0;
            return std::array<double, 3>{pts[i0][0] + u * (pts[i][0] - pts[i0][0]), pts[i0][1] + u * (pts[i][1] - pts[i0][1]), pts[i0][2] + u * (pts[i][2] - pts[i0][2])};
        };
        std::vector<double> cuts = {0.0};
        while (s.back() - cuts.back() > 1e-12) {
            const double h = localCell(at(cuts.back()));
            double next = cuts.back() + h;
            if (s.back() - next < 0.5 * h) next = s.back();
            cuts.push_back(std::min(next, s.back()));
        }
        const int first = static_cast<int>(nodePos.size());
        for (double t : cuts) nodePos.push_back(at(t));
        for (std::size_t i = 0; i + 1 < cuts.size(); ++i) segs.push_back({first + static_cast<int>(i), first + static_cast<int>(i) + 1, a, rPerLength, false});
    }
    if (segs.empty()) return;
    // Wire ends that meet are one node.
    std::vector<int> ends;
    for (const auto& sg : segs) ends.push_back(sg.a), ends.push_back(sg.b);
    for (std::size_t i = 0; i < ends.size(); ++i)
        for (std::size_t j = 0; j < i; ++j)
            if (ends[i] != ends[j] && dist(nodePos[ends[i]], nodePos[ends[j]]) < snapTol)
                for (auto& sg : segs) {
                    if (sg.a == ends[i]) sg.a = ends[j];
                    if (sg.b == ends[i]) sg.b = ends[j];
                }
    // The port's delta gap: a source segment from start to stop (positive current into the
    // signal side, like the grid port), joining the wire ends there; a side with no wire is
    // grounded (the reference conductor).
    if (p_.hasPort) {
        auto endAt = [&](const std::array<double, 3>& q) {
            for (const auto& sg : segs)
                for (int e : {sg.a, sg.b})
                    if (dist(nodePos[e], q) < snapTol) return e;
            return -1;
        };
        int a = endAt(portStart), b = endAt(portStop);
        if (a >= 0 || b >= 0) {
            // The gap must own its grid edges: whole edges along the port axis, on a grid line.
            // A sub-cell gap between nodes shares its edges with the wire segments next to it,
            // and they short it out (the field on edges a wire covers is held near zero).
            const int ax = p_.port.axis;
            std::array<double, 3> s0 = portStart, s1 = portStop;
            for (int d = 0; d < 3; ++d) {
                const auto& x = g.nodes(d);
                for (auto* q : {&s0, &s1}) {
                    const auto it = std::min_element(x.begin(), x.end(), [&](double l, double r) { return std::abs(l - (*q)[d]) < std::abs(r - (*q)[d]); });
                    if (std::abs(*it - (*q)[d]) > 1e-4 * minSpacingAll(g) + 1e-12)
                        throw std::invalid_argument("port: a wire feed must start and end on grid nodes (the grid needs lines at the feed ends and through the feed line)");
                    (*q)[d] = *it;
                }
                if (d != ax && s0[d] != s1[d]) throw std::invalid_argument("port: a wire feed must run along the port axis");
            }
            if (s0[ax] == s1[ax]) throw std::invalid_argument("port: start and stop must span at least one grid edge along the port axis");
            if (a >= 0) nodePos[a] = s0;
            if (b >= 0) nodePos[b] = s1;
            if (a < 0) a = portGround = static_cast<int>(nodePos.size()), nodePos.push_back(s0);
            if (b < 0) b = portGround = static_cast<int>(nodePos.size()), nodePos.push_back(s1);
            wirePortSeg_ = static_cast<int>(segs.size());
            segs.push_back({a, b, segs.front().radius, 0.0, true});
        }
    }
    if (segs.empty()) return;

    // Nodes: grounded when they touch a conductor on the grid (or are the port's reference end).
    wireNode_.assign(nodePos.size(), {});
    std::vector<int> degree(nodePos.size(), 0);
    for (const auto& sg : segs) ++degree[sg.a], ++degree[sg.b];
    for (std::size_t i = 0; i < nodePos.size(); ++i) {
        if (degree[i] > 1) continue;
        int ijk[3];
        for (int a = 0; a < 3; ++a) {
            const auto& x = g.nodes(a);
            ijk[a] = static_cast<int>(std::lower_bound(x.begin(), x.end(), nodePos[i][a]) - x.begin());
            if (ijk[a] > 0 && (ijk[a] > n[a] || nodePos[i][a] - x[ijk[a] - 1] < x[ijk[a]] - nodePos[i][a])) --ijk[a];
        }
        bool touches = false;
        for (int c = 0; c < 3 && !touches; ++c)
            for (int s = -1; s <= 0 && !touches; ++s) {
                int e[3] = {ijk[0], ijk[1], ijk[2]};
                e[c] += s;
                if (e[c] < 0 || e[c] >= n[c]) continue;
                touches = inConductor(c, f.idx(e[0], e[1], e[2]));
            }
        wireNode_[i].grounded = touches;
    }
    if (portGround >= 0) wireNode_[portGround].grounded = true;

    // Couplings and the grid's effective radius, per segment.
    wireSeg_.clear();
    wireCouple_.clear();
    std::vector<double> nodeLen(nodePos.size(), 0.0), nodeLog(nodePos.size(), 0.0), nodeEps(nodePos.size(), 0.0);
    for (const auto& sg : segs) {
        WireSegment w;
        w.a = sg.a;
        w.b = sg.b;
        w.source = sg.source;
        w.len = dist(nodePos[sg.a], nodePos[sg.b]);
        w.R = sg.source ? p_.port.resistance : sg.rPerLength * w.len;
        // Split the segment where it crosses grid planes; in each cell, the exact integral of
        // the interpolation along the straight piece (Villasenor-Buneman): along its own axis E_c
        // is constant over the cell, across it is bilinear between nodes, so the weight is the
        // bilinear at the piece's midpoint plus a correction for the piece's slope. With these
        // weights the deposited current is charge-conserving (its grid divergence is the change
        // of the wire's node charges spread trilinearly), so an oblique wire leaves no stray
        // charge on the grid.
        std::vector<double> cuts = {0.0, 1.0};
        for (int a = 0; a < 3; ++a) {
            const double p0 = nodePos[sg.a][a], p1 = nodePos[sg.b][a];
            if (std::abs(p1 - p0) < 1e-15) continue;
            const auto& x = g.nodes(a);
            const auto lo = std::upper_bound(x.begin(), x.end(), std::min(p0, p1));
            for (auto it = lo; it != x.end() && *it < std::max(p0, p1); ++it) cuts.push_back((*it - p0) / (p1 - p0));
        }
        std::sort(cuts.begin(), cuts.end());
        std::map<std::pair<int, std::size_t>, double> acc;
        double logSum = 0, logWeight = 0, epsSum = 0;
        for (std::size_t m = 0; m + 1 < cuts.size(); ++m) {
            if (cuts[m + 1] - cuts[m] < 1e-12) continue;
            std::array<double, 3> mid, del;
            for (int a = 0; a < 3; ++a) {
                del[a] = (cuts[m + 1] - cuts[m]) * (nodePos[sg.b][a] - nodePos[sg.a][a]);
                mid[a] = nodePos[sg.a][a] + 0.5 * (cuts[m] + cuts[m + 1]) * (nodePos[sg.b][a] - nodePos[sg.a][a]);
            }
            int cell[3];
            double frac[3], rel[3];
            for (int a = 0; a < 3; ++a) {
                const auto [i, fr] = cellOf(g.nodes(a), mid[a]);
                cell[a] = i;
                frac[a] = fr;
                rel[a] = del[a] / f.d[a][i];
            }
            const double piece = std::sqrt(del[0] * del[0] + del[1] * del[1] + del[2] * del[2]);
            for (int c = 0; c < 3; ++c) {
                if (std::abs(del[c]) < 1e-15) continue;
                const int u = (c + 1) % 3, v = (c + 2) % 3;
                const double corr = rel[u] * rel[v] / 12.0;
                for (int du = 0; du <= 1; ++du)
                    for (int dv = 0; dv <= 1; ++dv) {
                        int e[3];
                        e[c] = cell[c];
                        e[u] = cell[u] + du;
                        e[v] = cell[v] + dv;
                        if (!f.eActive(c, e[0], e[1], e[2])) continue;
                        const double wt = del[c] * ((du ? frac[u] : 1 - frac[u]) * (dv ? frac[v] : 1 - frac[v]) + (du == dv ? corr : -corr));
                        acc[{c, f.idx(e[0], e[1], e[2])}] += wt;
                    }
                const double tc = del[c] / piece;
                const double h = std::sqrt(f.d[u][cell[u]] * f.d[v][cell[v]]);
                logSum += tc * tc * piece * std::log(r0OverH(frac[u], frac[v]) * h / sg.radius);
                logWeight += tc * tc * piece;
            }
        }
        w.logR0 = logSum / logWeight;
        w.c0 = static_cast<std::uint32_t>(wireCouple_.size());
        for (const auto& [key, wt] : acc) {
            const int c = key.first;
            const std::size_t q = key.second;
            const int ijk[3] = {static_cast<int>(q / f.sx()), static_cast<int>((q % f.sx()) / f.sy()), static_cast<int>(q % f.sy())};
            const int u = (c + 1) % 3, v = (c + 2) % 3;
            const double vol = f.d[c][ijk[c]] * f.dd[u][ijk[u]] * f.dd[v][ijk[v]];
            const auto mat = f.M(c)[q];
            wireCouple_.push_back({q, static_cast<float>(wt), static_cast<float>(f.materials.cb[mat] / vol), static_cast<std::uint8_t>(c)});
            epsSum += std::abs(wt) * f.materials.epsR[mat];
        }
        w.c1 = static_cast<std::uint32_t>(wireCouple_.size());
        double wsum = 0;
        for (auto i = w.c0; i < w.c1; ++i) wsum += std::abs(wireCouple_[i].w);
        const double epsR = wsum > 0 ? epsSum / wsum : 1.0;
        for (int end : {sg.a, sg.b}) {
            nodeLen[end] += 0.5 * w.len;
            nodeLog[end] += 0.5 * w.len * w.logR0;
            nodeEps[end] += 0.5 * w.len * epsR;
        }
        wireSeg_.push_back(w);
    }
    for (std::size_t i = 0; i < nodePos.size(); ++i) {
        if (nodeLen[i] <= 0) { // an end merged into another node: no segment uses it
            wireNode_[i].grounded = true;
            nodeLen[i] = 1, nodeLog[i] = 0, nodeEps[i] = 1;
            continue;
        }
        nodeLog[i] /= nodeLen[i];
        nodeEps[i] /= nodeLen[i];
    }

    // In-cell L' and C' from ln(r0 / a), held at `floorLog` and above (stability, or wires that
    // are not thin next to the local cells), then the update coefficients.
    const double dt = f.dt();
    auto coefficients = [&](double floorLog) {
        long long clamped = 0;
        double minLog = 1e300;
        for (auto& w : wireSeg_) {
            const double lg = std::max(w.logR0, floorLog);
            clamped += w.logR0 < floorLog;
            minLog = std::min(minLog, w.logR0);
            w.L = MU0 / (2 * PI) * lg;
            const double z = w.L * w.len / dt, rt = 0.5 * w.R;
            w.ca = (z - rt) / (z + rt);
            w.cb = 1.0 / (z + rt);
            w.cb0 = 1.0 / z;
        }
        for (std::size_t i = 0; i < nodePos.size(); ++i) {
            const double lg = std::max(nodeLog[i], floorLog);
            wireNode_[i].invC = lg / (2 * PI * EPS0 * nodeEps[i]) / nodeLen[i];
        }
        report_.wireClamped = clamped;
        report_.wireMinLog = minLog;
    };
    wireI_.assign(wireSeg_.size(), 0.0);
    wireQ_.assign(nodePos.size(), 0.0);
    double floorLog = kMinLog, lambda = 0;
    coefficients(floorLog);
    const long long thick = report_.wireClamped;
    for (int attempt = 0; attempt < 10; ++attempt) {
        lambda = updateEigenvalue();
        if (lambda <= kStableEigenvalue) break;
        floorLog *= 1.5;
        coefficients(floorLog);
    }
    report_.wireSegments = static_cast<long long>(wireSeg_.size());
    report_.stabilityEigenvalue = lambda;
    if (lambda > kStableEigenvalue)
        diag("WIRE_UNSTABLE", "error", "the thin-wire update could not be made stable on this grid (eigenvalue " + std::to_string(lambda) + ")");
    if (thick)
        diag("WIRE_THICK", "warning",
             std::to_string(thick) + " wire segments are not thin next to the local cells (radius near the grid's own effective radius, " +
                 "about 0.2-0.7 cell); their in-cell inductance is held at a minimum. Use coarser cells near the wire, or model it as a solid.");
    if (report_.wireClamped > thick)
        diag("WIRE_STABILITY", "info", std::to_string(report_.wireClamped - thick) + " wire segments had their in-cell inductance raised to keep the time step stable");
    diag("WIRES", "info", std::to_string(wireSeg_.size()) + " thin-wire segments" + (wirePortSeg_ >= 0 ? ", fed by the port at the wire's end" : ""));
}

// I^{n+1/2} from E^n and q^n. With `drive`, the source segment adds V_s(n dt) and the port
// records I^{n+1/2} and the gap voltage V(n dt) = V_s - R (I^{n-1/2} + I^{n+1/2}) / 2.
// Without it (the stability check), the update is the lossless one: resistance only damps,
// and leaving it in would understate how strongly a segment couples to the field.
void Solver::wireCurrent(long long n, bool drive) {
    const YeeFields& f = *f_;
    const double vs = drive ? p_.port.amplitude * pulse_(static_cast<double>(n) * f.dt()) : 0.0;
    for (std::size_t k = 0; k < wireSeg_.size(); ++k) {
        const WireSegment& w = wireSeg_[k];
        double v = 0;
        for (auto i = w.c0; i < w.c1; ++i) v += wireCouple_[i].w * f.E(wireCouple_[i].c)[wireCouple_[i].q];
        const double phiA = wireNode_[w.a].grounded ? 0.0 : wireQ_[w.a] * wireNode_[w.a].invC;
        const double phiB = wireNode_[w.b].grounded ? 0.0 : wireQ_[w.b] * wireNode_[w.b].invC;
        v -= phiB - phiA;
        if (w.source) v += vs;
        const double old = wireI_[k];
        wireI_[k] = drive ? w.ca * old + w.cb * v : old + w.cb0 * v;
        if (drive && w.source) {
            iSeries_.push_back(wireI_[k]);
            if (n >= 1) vSeries_.push_back(vs - w.R * 0.5 * (old + wireI_[k]));
        }
    }
}

// E^{n+1} -= cb w I^{n+1/2} / V on the coupled edges (after the bulk E update).
void Solver::wireDeposit() {
    YeeFields& f = *f_;
    for (std::size_t k = 0; k < wireSeg_.size(); ++k) {
        const WireSegment& w = wireSeg_[k];
        const float cur = static_cast<float>(wireI_[k]);
        for (auto i = w.c0; i < w.c1; ++i) f.E(wireCouple_[i].c)[wireCouple_[i].q] -= wireCouple_[i].dep * wireCouple_[i].w * cur;
    }
}

// q^{n+1} from I^{n+1/2}: current runs from node a to node b.
void Solver::wireCharge() {
    const double dt = f_->dt();
    for (std::size_t k = 0; k < wireSeg_.size(); ++k) {
        const WireSegment& w = wireSeg_[k];
        if (!wireNode_[w.a].grounded) wireQ_[w.a] -= dt * wireI_[k];
        if (!wireNode_[w.b].grounded) wireQ_[w.b] += dt * wireI_[k];
    }
}

} // namespace antsim

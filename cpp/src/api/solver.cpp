#include "antsim/solver.hpp"
#include "antsim/constants.hpp"
#include "antsim/metal.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <stdexcept>

namespace antsim {

namespace {

RectGrid toMetres(const RectGrid& g, double unit) {
    RectGrid m = g;
    for (auto* v : {&m.x, &m.y, &m.z})
        for (auto& c : *v) c *= unit;
    return m;
}

/// Node indices whose coordinate lies in [lo - tol, hi + tol]; empty range if none.
std::pair<int, int> nodeRange(const std::vector<double>& x, double lo, double hi, double tol) {
    const auto b = std::lower_bound(x.begin(), x.end(), lo - tol);
    const auto e = std::upper_bound(x.begin(), x.end(), hi + tol);
    return {static_cast<int>(b - x.begin()), static_cast<int>(e - x.begin()) - 1};
}

double minSpacingAll(const RectGrid& g) {
    return std::min({g.minSpacing(0), g.minSpacing(1), g.minSpacing(2)});
}

bool insideCylinder(const ObjectSpec& o, const double pt[3], double tol) {
    const int a = o.axis, u = (a == 0) ? 1 : 0, v = (a == 2) ? 1 : 2;
    const double du = pt[u] - o.center[0], dv = pt[v] - o.center[1];
    return pt[a] >= o.range[0] - tol && pt[a] <= o.range[1] + tol && du * du + dv * dv <= (o.radius + tol) * (o.radius + tol);
}

// Conformal: a covered or open stretch below this fraction of an edge is rounded away, so
// float32 CAD coordinates on a grid line do not create slivers.
constexpr double kCutSnap = 1e-3;
// Leapfrog needs the update's largest eigenvalue below 4; a uniform grid at Courant 0.99 sits at 3.92.
constexpr double kStableEigenvalue = 3.98;
// Courant number when conductors cut faces: 0.8 costs 24 % more steps than 0.99, and leaves
// room for most cut faces uncapped (measured: 0.9 nearly doubles the resonance error).
constexpr double kConformalCourant = 0.8;

std::array<double, 3> objectMin(const ObjectSpec& o) {
    if (o.kind != ObjectSpec::Kind::Cylinder) return o.min; // boxes; meshes and sheets store their bbox here
    std::array<double, 3> m{};
    const int a = o.axis, u = (a == 0) ? 1 : 0, v = (a == 2) ? 1 : 2;
    m[a] = o.range[0];
    m[u] = o.center[0] - o.radius;
    m[v] = o.center[1] - o.radius;
    return m;
}

std::array<double, 3> objectMax(const ObjectSpec& o) {
    if (o.kind != ObjectSpec::Kind::Cylinder) return o.max;
    std::array<double, 3> m{};
    const int a = o.axis, u = (a == 0) ? 1 : 0, v = (a == 2) ? 1 : 2;
    m[a] = o.range[1];
    m[u] = o.center[0] + o.radius;
    m[v] = o.center[1] + o.radius;
    return m;
}

} // namespace

// ------------------------------------------------------------------ memory estimate
MemoryEstimate estimateMemory(const Problem& p) {
    MemoryEstimate m;
    const long long nx = p.grid.nx(), ny = p.grid.ny(), nz = p.grid.nz();
    const long long nodes = (nx + 1) * (ny + 1) * (nz + 1);
    m.cells = nx * ny * nz;
    m.fields = static_cast<std::size_t>(nodes) * 6 * sizeof(float);
    m.materials = static_cast<std::size_t>(nodes) * 3 * sizeof(std::uint16_t);
    // Cell material + owner (dielectric rasterization) and the union-find of the DC-path check.
    m.rasterTemp = static_cast<std::size_t>(m.cells) * 3 + (p.hasPort ? static_cast<std::size_t>(nodes) * 4 : 0);
    const long long n[3] = {nx, ny, nz};
    for (int face = 0; face < 6; ++face) {
        if (p.boundaries[face] != Boundary::Cpml) continue;
        const int a = face / 2, pa = (a + 1) % 3, qa = (a + 2) % 3;
        const long long plane = (n[pa] + 1) * (n[qa] + 1);
        m.cpml += static_cast<std::size_t>((2 * (p.pml.cells - 1) + 2 * p.pml.cells) * plane) * sizeof(float);
    }
    bool allCpml = true;
    for (auto b : p.boundaries) allCpml &= b == Boundary::Cpml;
    if (!p.farField.frequencies.empty() && allCpml) {
        long long box[3];
        for (int a = 0; a < 3; ++a) box[a] = n[a] - 2 * (p.pml.cells + p.farField.marginCells);
        long long samples = 0;
        for (int a = 0; a < 3; ++a) {
            const long long bp = box[(a + 1) % 3], bq = box[(a + 2) % 3];
            samples += 2 * (bp * (bq + 1) + (bp + 1) * bq);
        }
        m.nf2ff = static_cast<std::size_t>(samples) * (2 * p.farField.frequencies.size() * sizeof(std::complex<double>) + sizeof(double));
    }
    m.portSeries = p.hasPort ? static_cast<std::size_t>(p.maxSteps) * 2 * sizeof(double) : 0;
    return m;
}

// ------------------------------------------------------------------ setup
Solver::Solver(const Problem& p) : p_(p) {
    const int threads = p.threads > 0 ? std::min(p.threads, maxThreads()) : maxThreads();
    pool_ = std::make_unique<ThreadPool>(threads);
    std::array<bool, 6> pmc{};
    for (int i = 0; i < 6; ++i) pmc[i] = p.boundaries[i] == Boundary::Pmc;
    f_ = std::make_unique<YeeFields>(toMetres(p.grid, p.unit), p.courant);
    f_->setPmcFaces(pmc);
    rasterize();
    if (!partial_.empty() && p.courant > kConformalCourant) {
        // Cut faces need headroom below the Courant limit; the material table holds dt, so start over.
        partial_.clear();
        metalRs_.clear();
        surfaceEdges_.clear();
        report_ = MeshReport{};
        diags_.clear();
        warnings_.clear();
        f_ = std::make_unique<YeeFields>(toMetres(p.grid, p.unit), kConformalCourant);
        f_->setPmcFaces(pmc);
        rasterize();
    }
    if (p.hasPort) {
        setupPort();
        checkDcPath();
    }
    if (!partial_.empty()) buildCutFaces();
    cpml_ = std::make_unique<Cpml>(*f_, p.boundaries, p.pml);
    setupFarField();
    pulse_ = GaussianPulse::forBand(p.fMin, p.fMax);
    state_.maxSteps = p.maxSteps;
    state_.targetDb = p.energyEndDb;
    checkEvery_ = std::clamp<long long>(std::llround(1.0 / (2.0 * p.fMax * f_->dt())), 1, 1000);
    if (p.hasPort) {
        vSeries_.reserve(static_cast<std::size_t>(std::min<long long>(p.maxSteps, 1 << 22)));
        iSeries_.reserve(vSeries_.capacity());
    }
    if (pulse_.endTime() / f_->dt() > 0.8 * p.maxSteps)
        warnings_.push_back("maxSteps is shorter than the excitation pulse; results will be truncated");
}

Solver::~Solver() = default;

void Solver::diag(const std::string& code, const std::string& severity, const std::string& message) {
    diags_.push_back({code, severity, message});
    if (severity != "info") warnings_.push_back(message);
}

void Solver::rasterize() {
    YeeFields& f = *f_;
    const RectGrid& g = f.grid();
    const double minCell = minSpacingAll(g);
    const double tol = 1e-4 * minCell;
    const double unit = p_.unit;
    const int n[3] = {f.nx(), f.ny(), f.nz()};
    report_.minCell = minCell;
    report_.maxCell = 0;
    for (int a = 0; a < 3; ++a)
        for (double d : f.d[a]) report_.maxCell = std::max(report_.maxCell, d);

    // Objects in metres, sorted by priority (stable: later definitions win ties).
    struct Obj {
        ObjectSpec o;
        std::unique_ptr<TriMesh> mesh;
        int report;
    };
    std::vector<Obj> objs;
    for (const auto& src : p_.objects) {
        Obj ob{src, nullptr, static_cast<int>(report_.objects.size())};
        ObjectSpec& o = ob.o;
        for (int a = 0; a < 3; ++a) {
            o.min[a] *= unit;
            o.max[a] *= unit;
        }
        o.center = {o.center[0] * unit, o.center[1] * unit};
        o.range = {o.range[0] * unit, o.range[1] * unit};
        o.radius *= unit;
        o.coord *= unit;
        if (o.kind == ObjectSpec::Kind::Mesh || o.kind == ObjectSpec::Kind::Sheet) {
            ob.mesh = std::make_unique<TriMesh>(TriMesh::fromFloats(o.positions, o.indices, unit));
            o.min = ob.mesh->lo;
            o.max = ob.mesh->hi;
            o.positions.clear();
            o.indices.clear();
        }
        static const char* kinds[] = {"box", "cylinder", "mesh", "sheet"};
        report_.objects.push_back({o.name.empty() ? std::string(kinds[static_cast<int>(o.kind)]) + " " + std::to_string(ob.report + 1) : o.name,
                                   kinds[static_cast<int>(o.kind)], o.material, 0, 0, 0});
        objs.push_back(std::move(ob));
    }
    std::stable_sort(objs.begin(), objs.end(), [](const Obj& a, const Obj& b) { return a.o.priority < b.o.priority; });
    auto metalOf = [&](const ObjectSpec& o) -> const MaterialSpec* {
        for (const auto& m : p_.materials)
            if (m.name == o.material && m.metal) return &m;
        return nullptr;
    };
    auto isConductor = [&](const ObjectSpec& o) { return o.material == "pec" || metalOf(o) != nullptr; };
    for (auto& ob : objs) report_.objects[ob.report].conductor = isConductor(ob.o);

    // 1. Dielectrics: material per cell (by cell centre), then area-weighted averages on edges.
    const bool anyDielectric = std::any_of(objs.begin(), objs.end(), [&](const Obj& o) { return !isConductor(o.o); });
    if (anyDielectric) {
        if (p_.materials.size() > 250) throw std::invalid_argument("too many materials (max 250)");
        const std::size_t nCells = static_cast<std::size_t>(n[0]) * n[1] * n[2];
        std::vector<std::uint8_t> cell(nCells, 0);
        std::vector<std::int16_t> owner(nCells, -1); // index into objs, for overlap detection
        std::map<std::pair<int, int>, long long> overlap;
        auto cellAt = [&](int i, int j, int k) { return (static_cast<std::size_t>(i) * n[1] + j) * n[2] + k; };
        for (std::size_t oi = 0; oi < objs.size(); ++oi) {
            const ObjectSpec& o = objs[oi].o;
            if (isConductor(o)) continue;
            const int mid = 1 + static_cast<int>(std::find_if(p_.materials.begin(), p_.materials.end(), [&](const MaterialSpec& m) { return m.name == o.material; }) - p_.materials.begin());
            long long marked = 0;
            auto mark = [&](std::size_t c) {
                const int prev = owner[c];
                if (prev >= 0 && prev != static_cast<int>(oi) && objs[prev].o.priority == o.priority) ++overlap[{prev, static_cast<int>(oi)}];
                cell[c] = static_cast<std::uint8_t>(mid);
                owner[c] = static_cast<std::int16_t>(oi);
                ++marked;
            };
            const auto lo = objectMin(o), hi = objectMax(o);
            int r0[3], r1[3];
            for (int a = 0; a < 3; ++a) {
                const auto& x = g.nodes(a);
                r0[a] = 0;
                while (r0[a] < n[a] && 0.5 * (x[r0[a]] + x[r0[a] + 1]) < lo[a] - tol) ++r0[a];
                r1[a] = n[a] - 1;
                while (r1[a] >= 0 && 0.5 * (x[r1[a]] + x[r1[a] + 1]) > hi[a] + tol) --r1[a];
            }
            if (o.kind == ObjectSpec::Kind::Mesh) {
                const AxisRayCaster rc(*objs[oi].mesh, 2);
                std::vector<Interval> iv;
                for (int i = r0[0]; i <= r1[0]; ++i)
                    for (int j = r0[1]; j <= r1[1]; ++j) {
                        rc.intervals(0.5 * (g.x[i] + g.x[i + 1]), 0.5 * (g.y[j] + g.y[j + 1]), iv);
                        for (int k = r0[2]; k <= r1[2]; ++k) {
                            const double zc = 0.5 * (g.z[k] + g.z[k + 1]);
                            if (coveredLength(iv, zc - 1e-12, zc + 1e-12) > 0) mark(cellAt(i, j, k));
                        }
                    }
            } else {
                for (int i = r0[0]; i <= r1[0]; ++i)
                    for (int j = r0[1]; j <= r1[1]; ++j)
                        for (int k = r0[2]; k <= r1[2]; ++k) {
                            if (o.kind == ObjectSpec::Kind::Cylinder) {
                                const double c[3] = {0.5 * (g.x[i] + g.x[i + 1]), 0.5 * (g.y[j] + g.y[j + 1]), 0.5 * (g.z[k] + g.z[k + 1])};
                                if (!insideCylinder(o, c, tol)) continue;
                            }
                            mark(cellAt(i, j, k));
                        }
            }
            report_.objects[objs[oi].report].cells = marked;
        }
        for (const auto& [pr, count] : overlap) {
            const auto& a = report_.objects[objs[pr.first].report].name;
            const auto& b = report_.objects[objs[pr.second].report].name;
            report_.overlaps.push_back({a, b, count});
            diag("DIELECTRIC_OVERLAP", "error",
                 "\"" + a + "\" and \"" + b + "\" share " + std::to_string(count) +
                     " cells at the same priority, so the material there is ambiguous; give one of them a higher priority");
        }
        std::map<std::pair<double, double>, std::uint16_t> table;
        auto materialIndex = [&](double er, double sg) -> std::uint16_t {
            if (er == 1.0 && sg == 0.0) return EdgeMaterialTable::kVacuum;
            const auto key = std::make_pair(er, sg);
            auto it = table.find(key);
            if (it != table.end()) return it->second;
            const auto id = f.materials.add(er, sg, f.dt());
            table.emplace(key, id);
            return id;
        };
        for (int c = 0; c < 3; ++c) {
            const int u = (c + 1) % 3, v = (c + 2) % 3;
            auto& m = f.M(c);
            for (int i = 0; i <= n[0]; ++i)
                for (int j = 0; j <= n[1]; ++j)
                    for (int k = 0; k <= n[2]; ++k) {
                        int ijk[3] = {i, j, k};
                        if (ijk[c] >= n[c]) continue;
                        double er = 0, sg = 0, w = 0;
                        // The four cells around the edge: offsets -1/0 along u and v.
                        for (int du = -1; du <= 0; ++du)
                            for (int dv = -1; dv <= 0; ++dv) {
                                int cc[3] = {i, j, k};
                                cc[u] += du;
                                cc[v] += dv;
                                if (cc[u] < 0 || cc[u] >= n[u] || cc[v] < 0 || cc[v] >= n[v]) continue;
                                const double area = f.d[u][cc[u]] * f.d[v][cc[v]];
                                const int mid = cell[cellAt(cc[0], cc[1], cc[2])];
                                er += area * (mid ? p_.materials[mid - 1].epsR : 1.0);
                                sg += area * (mid ? p_.materials[mid - 1].sigma : 0.0);
                                w += area;
                            }
                        m[f.idx(i, j, k)] = materialIndex(er / w, sg / w);
                    }
        }
    }

    // 2. Conductors (PEC and metals). Boxes and cylinders: an edge is a conductor
    //    edge when it lies entirely within the object (inclusive). Meshes: when at
    //    least half its length is inside the solid, with lines on the surface counted
    //    as inside. Sheets: edges in the sheet plane whose ends and midpoint lie in
    //    the footprint. Metal objects mark their edges with a PEC-like tag first.
    std::vector<MetalTag> metalTags;
    for (auto& ob : objs) {
        const ObjectSpec& o = ob.o;
        if (!isConductor(o)) continue;
        std::uint16_t tag = EdgeMaterialTable::kPec;
        if (const MaterialSpec* metal = metalOf(o)) {
            tag = f.materials.addRaw(0.0f, 0.0f, 1.0, 0.0, true);
            metalTags.push_back({tag, metal, o, ob.report});
            metalRs_[tag] = surfaceResistance(metal->conductivity, p_.metalLossFrequency > 0 ? p_.metalLossFrequency : std::sqrt(p_.fMin * p_.fMax));
        }
        long long marked = 0;
        // Conformal: sorts an edge [x[i], x[i + 1]] of line (jp, jq) by the conductor's merged
        // inside intervals: inside, outside or partly covered, with the normals at its cuts.
        struct Cut {
            int c;
            std::size_t at;
            PartialEdge edge;
        };
        auto sortEdge = [&](int c, const int* ijk, const std::vector<Interval>& iv, double x0, double x1, const auto& normalAt, long long& count, std::vector<Cut>& cuts) {
            const double len = x1 - x0, cov = coveredLength(iv, x0, x1);
            if (cov <= kCutSnap * len) return;
            const std::size_t at = f.idx(ijk[0], ijk[1], ijk[2]);
            if (cov >= (1.0 - kCutSnap) * len) {
                auto& e = f.M(c)[at];
                if (!f.materials.isConductor(e)) ++count;
                e = tag;
                return;
            }
            Cut cut{c, at, {}};
            cut.edge.owner = tag;
            for (const auto& [lo, hi] : iv) {
                if (hi <= x0 || lo >= x1) continue;
                cut.edge.covered.emplace_back(std::max(lo, x0) - x0, std::min(hi, x1) - x0);
                for (double t : {lo, hi})
                    if (t > x0 + kCutSnap * len && t < x1 - kCutSnap * len) {
                        double n[3] = {0, 0, 0};
                        if (normalAt(t, n))
                            for (int a = 0; a < 3; ++a) cut.edge.normal[a] += n[a];
                    }
            }
            cuts.push_back(std::move(cut));
        };
        auto keepCuts = [&](std::vector<Cut>& cuts) {
            for (auto& cut : cuts) {
                PartialEdge& e = partial_[edgeKey(cut.c, cut.at)];
                e.covered.insert(e.covered.end(), cut.edge.covered.begin(), cut.edge.covered.end());
                for (int a = 0; a < 3; ++a) e.normal[a] += cut.edge.normal[a];
                e.owner = cut.edge.owner;
            }
        };
        const bool solid = o.kind == ObjectSpec::Kind::Cylinder ||
                           (o.kind == ObjectSpec::Kind::Box && o.max[0] > o.min[0] && o.max[1] > o.min[1] && o.max[2] > o.min[2]);
        if (p_.conformal && solid) {
            // Boxes and cylinders: exact intervals along each edge line.
            const auto lo = objectMin(o), hi = objectMax(o);
            std::vector<Cut> cuts;
            for (int c = 0; c < 3; ++c) {
                const int pa = (c + 1) % 3, qa = (c + 2) % 3;
                const auto rp = nodeRange(g.nodes(pa), lo[pa], hi[pa], tol), rq = nodeRange(g.nodes(qa), lo[qa], hi[qa], tol);
                const auto& xc = g.nodes(c);
                std::vector<Interval> iv(1);
                for (int jp = rp.first; jp <= rp.second; ++jp)
                    for (int jq = rq.first; jq <= rq.second; ++jq) {
                        double pt[3] = {0, 0, 0};
                        pt[pa] = g.nodes(pa)[jp];
                        pt[qa] = g.nodes(qa)[jq];
                        double centre[3] = {0, 0, 0};
                        double a0 = lo[c], a1 = hi[c];
                        if (o.kind == ObjectSpec::Kind::Cylinder) {
                            const int ax = o.axis, u = ax == 0 ? 1 : 0, v = ax == 2 ? 1 : 2;
                            centre[u] = o.center[0];
                            centre[v] = o.center[1];
                            if (c == ax) {
                                if (!insideCylinder(o, pt, tol) && (pt[u] - centre[u]) * (pt[u] - centre[u]) + (pt[v] - centre[v]) * (pt[v] - centre[v]) > (o.radius + tol) * (o.radius + tol)) continue;
                            } else {
                                if (pt[ax] < o.range[0] - tol || pt[ax] > o.range[1] + tol) continue;
                                const int w = u == c ? v : u;
                                const double dw = pt[w] - centre[w], r2 = o.radius * o.radius - dw * dw;
                                if (r2 <= 0) continue; // a tangent line touches, but is not covered
                                a0 = centre[c] - std::sqrt(r2);
                                a1 = centre[c] + std::sqrt(r2);
                            }
                        }
                        iv[0] = {a0, a1};
                        auto normalAt = [&](double t, double* n) {
                            if (o.kind == ObjectSpec::Kind::Box || (o.kind == ObjectSpec::Kind::Cylinder && c == o.axis)) {
                                n[c] = t > 0.5 * (a0 + a1) ? 1 : -1;
                                return true;
                            }
                            double q[3] = {pt[0], pt[1], pt[2]};
                            q[c] = t;
                            double l2 = 0;
                            for (int a = 0; a < 3; ++a)
                                if (a != o.axis) l2 += (q[a] - centre[a]) * (q[a] - centre[a]);
                            for (int a = 0; a < 3; ++a)
                                if (a != o.axis) n[a] = (q[a] - centre[a]) / std::sqrt(l2);
                            return true;
                        };
                        for (int i = std::max(0, static_cast<int>(std::upper_bound(xc.begin(), xc.end(), a0) - xc.begin()) - 1); i < n[c] && xc[i] < a1; ++i) {
                            int ijk[3];
                            ijk[c] = i;
                            ijk[pa] = jp;
                            ijk[qa] = jq;
                            sortEdge(c, ijk, iv, xc[i], xc[i + 1], normalAt, marked, cuts);
                        }
                    }
            }
            keepCuts(cuts);
        } else if (p_.conformal && o.kind == ObjectSpec::Kind::Mesh) {
            const TriMesh& mesh = *ob.mesh;
            const double eps = 1e-3 * tol;
            for (int c = 0; c < 3; ++c) {
                const int pa = (c + 1) % 3, qa = (c + 2) % 3;
                const AxisRayCaster rc(mesh, c);
                const auto rp = nodeRange(g.nodes(pa), mesh.lo[pa], mesh.hi[pa], tol);
                const auto rq = nodeRange(g.nodes(qa), mesh.lo[qa], mesh.hi[qa], tol);
                const auto& xc = g.nodes(c);
                std::vector<long long> counts(pool_->size(), 0);
                std::vector<std::vector<Cut>> cuts(pool_->size());
                pool_->run([&](int tid, int nt) {
                    const auto [j0, j1] = ThreadPool::range(rp.first, rp.second + 1, tid, nt);
                    std::vector<Interval> iv;
                    for (int jp = j0; jp < j1; ++jp)
                        for (int jq = rq.first; jq <= rq.second; ++jq) {
                            rc.inclusiveIntervals(g.nodes(pa)[jp], g.nodes(qa)[jq], eps, iv);
                            if (iv.empty()) continue;
                            auto normalAt = [&](double t, double* nrm) { return rc.normalAt(g.nodes(pa)[jp], g.nodes(qa)[jq], t, nrm); };
                            const auto rc0 = std::lower_bound(xc.begin(), xc.end(), iv.front().first - tol) - xc.begin();
                            const int i0 = std::max<int>(0, static_cast<int>(rc0) - 1);
                            for (int i = i0; i < n[c] && xc[i] <= iv.back().second + tol; ++i) {
                                int ijk[3];
                                ijk[c] = i;
                                ijk[pa] = jp;
                                ijk[qa] = jq;
                                sortEdge(c, ijk, iv, xc[i], xc[i + 1], normalAt, counts[tid], cuts[tid]);
                            }
                        }
                });
                for (auto cnt : counts) marked += cnt;
                for (auto& per : cuts) keepCuts(per);
            }
        } else if (o.kind == ObjectSpec::Kind::Box || o.kind == ObjectSpec::Kind::Cylinder) {
            const auto lo = objectMin(o), hi = objectMax(o);
            std::pair<int, int> r[3];
            for (int a = 0; a < 3; ++a) r[a] = nodeRange(g.nodes(a), lo[a], hi[a], tol);
            for (int c = 0; c < 3; ++c) {
                auto& m = f.M(c);
                int r0[3], r1[3];
                for (int a = 0; a < 3; ++a) {
                    r0[a] = r[a].first;
                    r1[a] = a == c ? r[a].second - 1 : r[a].second;
                }
                for (int i = r0[0]; i <= r1[0]; ++i)
                    for (int j = r0[1]; j <= r1[1]; ++j)
                        for (int k = r0[2]; k <= r1[2]; ++k) {
                            if (o.kind == ObjectSpec::Kind::Cylinder) {
                                const double p0[3] = {g.x[i], g.y[j], g.z[k]};
                                double p1[3] = {g.x[i], g.y[j], g.z[k]};
                                p1[c] = g.nodes(c)[(c == 0 ? i : c == 1 ? j : k) + 1];
                                if (!insideCylinder(o, p0, tol) || !insideCylinder(o, p1, tol)) continue;
                            }
                            auto& e = m[f.idx(i, j, k)];
                            if (!f.materials.isConductor(e)) ++marked;
                            e = tag;
                        }
            }
        } else if (o.kind == ObjectSpec::Kind::Mesh) {
            const TriMesh& mesh = *ob.mesh;
            const double eps = 1e-3 * tol;
            for (int c = 0; c < 3; ++c) {
                const int pa = (c + 1) % 3, qa = (c + 2) % 3;
                const AxisRayCaster rc(mesh, c);
                const auto rp = nodeRange(g.nodes(pa), mesh.lo[pa], mesh.hi[pa], tol);
                const auto rq = nodeRange(g.nodes(qa), mesh.lo[qa], mesh.hi[qa], tol);
                const auto& xc = g.nodes(c);
                auto& m = f.M(c);
                std::vector<long long> counts(pool_->size(), 0);
                pool_->run([&](int tid, int nt) {
                    const auto [j0, j1] = ThreadPool::range(rp.first, rp.second + 1, tid, nt);
                    std::vector<Interval> iv;
                    for (int jp = j0; jp < j1; ++jp)
                        for (int jq = rq.first; jq <= rq.second; ++jq) {
                            rc.inclusiveIntervals(g.nodes(pa)[jp], g.nodes(qa)[jq], eps, iv);
                            if (iv.empty()) continue;
                            const auto rc0 = std::lower_bound(xc.begin(), xc.end(), iv.front().first - tol) - xc.begin();
                            const int i0 = std::max<int>(0, static_cast<int>(rc0) - 1);
                            for (int i = i0; i < n[c] && xc[i] <= iv.back().second + tol; ++i) {
                                const double len = xc[i + 1] - xc[i];
                                if (coveredLength(iv, xc[i], xc[i + 1]) < 0.5 * len - 1e-12 * len) continue;
                                int ijk[3];
                                ijk[c] = i;
                                ijk[pa] = jp;
                                ijk[qa] = jq;
                                auto& e = m[f.idx(ijk[0], ijk[1], ijk[2])];
                                if (!f.materials.isConductor(e)) ++counts[tid];
                                e = tag;
                            }
                        }
                });
                for (auto cnt : counts) marked += cnt;
            }
        } else { // Sheet
            const int a = o.axis, pa = (a + 1) % 3, qa = (a + 2) % 3;
            const auto& xa = g.nodes(a);
            const int K = static_cast<int>(std::min_element(xa.begin(), xa.end(), [&](double x1, double x2) {
                                               return std::abs(x1 - o.coord) < std::abs(x2 - o.coord);
                                           }) - xa.begin());
            const double snap = std::abs(xa[K] - o.coord);
            report_.objects[ob.report].snapDistance = snap;
            if (snap > tol)
                diag("SHEET_SNAPPED", "warning",
                     "sheet \"" + report_.objects[ob.report].name + "\" moved " + std::to_string(snap * 1e3) +
                         " mm to the nearest grid plane");
            const Footprint fp(*ob.mesh, a);
            const double ftol = 1e-6;
            const auto rp = nodeRange(g.nodes(pa), ob.mesh->lo[pa], ob.mesh->hi[pa], tol);
            const auto rq = nodeRange(g.nodes(qa), ob.mesh->lo[qa], ob.mesh->hi[qa], tol);
            for (int c : {pa, qa}) {
                const int o2 = c == pa ? qa : pa;
                const auto rc = c == pa ? rp : rq;
                const auto ro = c == pa ? rq : rp;
                auto& m = f.M(c);
                for (int i = rc.first; i < rc.second; ++i)
                    for (int j = ro.first; j <= ro.second; ++j) {
                        double pt0[3], pt1[3];
                        pt0[a] = pt1[a] = xa[K];
                        pt0[c] = g.nodes(c)[i];
                        pt1[c] = g.nodes(c)[i + 1];
                        pt0[o2] = pt1[o2] = g.nodes(o2)[j];
                        auto in = [&](const double* pt) { return fp.contains(pt[pa], pt[qa], ftol); };
                        double mid[3] = {0.5 * (pt0[0] + pt1[0]), 0.5 * (pt0[1] + pt1[1]), 0.5 * (pt0[2] + pt1[2])};
                        if (!in(pt0) || !in(pt1) || !in(mid)) continue;
                        int ijk[3];
                        ijk[a] = K;
                        ijk[c] = i;
                        ijk[o2] = j;
                        if (!f.eActive(c, ijk[0], ijk[1], ijk[2])) continue;
                        auto& e = m[f.idx(ijk[0], ijk[1], ijk[2])];
                        if (!f.materials.isConductor(e)) ++marked;
                        e = tag;
                    }
            }
        }
        report_.objects[ob.report].pecEdges = marked;
        report_.pecEdgesTotal += marked;
    }
    for (const auto& r : report_.objects) {
        if ((r.conductor && r.pecEdges == 0) || (!r.conductor && r.cells == 0))
            diag("OBJECT_EMPTY", "warning", "\"" + r.name + "\" produced no " + (r.conductor ? "conductor edges" : "dielectric cells") +
                                                 " on this grid (smaller than a cell, or fully covered by another object)");
    }
    resolvePartialEdges();
    if (!metalTags.empty()) applyMetalLoss(metalTags);
    for (int c = 0; c < 3; ++c)
        for (auto& e : f.E(c)) e = 0.0f;
}

// 3. Metal loss. Each metal edge on the conductor's surface gets the conductivity
//    that turns its Ampere update into E = R I / w: I is the current through the
//    edge's dual face, w the surface width inside that face and R the resistance
//    per square. A dual face holds four half-lines from the edge; a half-line
//    between a conductor cell and an empty cell is a solid surface (R = R_s), one
//    on a conductor face between two empty cells is a sheet (both faces or one,
//    with its thickness), so sheet rims get half the width. Edges with no cells or
//    faces (wires) use the wire's resistance per length. Interior edges stay PEC.
void Solver::applyMetalLoss(const std::vector<MetalTag>& tags) {
    YeeFields& f = *f_;
    const int n[3] = {f.nx(), f.ny(), f.nz()};
    const double fRef = p_.metalLossFrequency > 0 ? p_.metalLossFrequency : std::sqrt(p_.fMin * p_.fMax);
    const auto& pmc = f.pmcFaces();
    std::map<std::uint16_t, std::size_t> tagIndex;
    for (std::size_t t = 0; t < tags.size(); ++t) tagIndex[tags[t].id] = t;

    // Conductor edge test; edges on the PEC outer faces count as conductor.
    auto cond = [&](int c, const int* ijk) {
        for (int a = 0; a < 3; ++a)
            if (ijk[a] < 0 || ijk[a] > n[a] || (a == c && ijk[a] >= n[a])) return false;
        if (!f.eActive(c, ijk[0], ijk[1], ijk[2])) return true;
        return f.materials.isConductor(f.M(c)[f.idx(ijk[0], ijk[1], ijk[2])]);
    };
    // Conductor cells: all twelve edges are conductor edges.
    auto cellAt = [&](int i, int j, int k) { return (static_cast<std::size_t>(i) * n[1] + j) * n[2] + k; };
    std::vector<std::uint8_t> cellCond(static_cast<std::size_t>(n[0]) * n[1] * n[2], 0);
    pool_->run([&](int tid, int nt) {
        const auto [i0, i1] = ThreadPool::range(0, n[0], tid, nt);
        for (int i = i0; i < i1; ++i)
            for (int j = 0; j < n[1]; ++j)
                for (int k = 0; k < n[2]; ++k) {
                    bool all = true;
                    for (int d1 = 0; d1 <= 1 && all; ++d1)
                        for (int d2 = 0; d2 <= 1 && all; ++d2) {
                            const int ex[3] = {i, j + d1, k + d2}, ey[3] = {i + d1, j, k + d2}, ez[3] = {i + d1, j + d2, k};
                            all = cond(0, ex) && cond(1, ey) && cond(2, ez);
                        }
                    cellCond[cellAt(i, j, k)] = all;
                }
    });

    // Cells holding a partly covered edge: their surface loss belongs to the cut faces.
    std::vector<std::uint8_t> cellCut(partial_.empty() ? 0 : cellCond.size(), 0);
    for (const auto& [key, edge] : partial_) {
        const int c = static_cast<int>(key / f.nodeCount());
        std::size_t r = key % f.nodeCount();
        const int ijk[3] = {static_cast<int>(r / f.sx()), static_cast<int>((r % f.sx()) / f.sy()), static_cast<int>(r % f.sy())};
        const int u = (c + 1) % 3, v = (c + 2) % 3;
        for (int du = -1; du <= 0; ++du)
            for (int dv = -1; dv <= 0; ++dv) {
                int q[3] = {ijk[0], ijk[1], ijk[2]};
                q[u] += du;
                q[v] += dv;
                if (q[0] >= 0 && q[1] >= 0 && q[2] >= 0 && q[0] < n[0] && q[1] < n[1] && q[2] < n[2]) cellCut[cellAt(q[0], q[1], q[2])] = 1;
            }
    }

    // Round wires (cylinders, meshes marked as wires) carry their current on a
    // staircase cross-section, where convex corners and one-cell fins concentrate
    // it; a uniform surface rule would then overstate the loss of the smooth wire.
    // Their axial surface edges instead get E = R' I_total: each edge's resistance
    // per length is R' I_total / I_e, with the shares I_e / I_total from a static
    // (TEM) solve of the cross-section on the grid, so the loss per length is the
    // round wire's R' I_total^2 (docs/physics.md).
    struct WireCal {
        int axis = -1;
        std::map<std::pair<int, int>, double> rho; // transverse node -> ohm/m
    };
    std::vector<WireCal> wireCal(tags.size());
    for (std::size_t t = 0; t < tags.size(); ++t) {
        const ObjectSpec& o = tags[t].o;
        // Cylinders count as wires when at least two diameters long (not discs). In
        // conformal mode the cut faces carry the true surface, so no calibration is needed.
        const bool rod = o.kind == ObjectSpec::Kind::Cylinder && o.range[1] - o.range[0] >= 4 * o.radius;
        const int c = rod ? o.axis : o.kind == ObjectSpec::Kind::Mesh ? o.wireAxis : -1;
        if (p_.conformal || c < 0 || !(o.radius > 0)) continue;
        const int u = (c + 1) % 3, v = (c + 2) % 3;
        const auto lo = objectMin(o), hi = objectMax(o);
        const auto& xc = f.grid().nodes(c);
        const int ic = std::clamp(static_cast<int>(std::upper_bound(xc.begin(), xc.end(), 0.5 * (lo[c] + hi[c])) - xc.begin()) - 1, 0, n[c] - 1);
        auto edgeAt = [&](int iu, int iv) {
            int q[3];
            q[c] = ic;
            q[u] = iu;
            q[v] = iv;
            return f.idx(q[0], q[1], q[2]);
        };
        int u0 = n[u], u1 = -1, v0 = n[v], v1 = -1;
        for (int iu = 0; iu <= n[u]; ++iu)
            for (int iv = 0; iv <= n[v]; ++iv)
                if (f.M(c)[edgeAt(iu, iv)] == tags[t].id) {
                    u0 = std::min(u0, iu);
                    u1 = std::max(u1, iu);
                    v0 = std::min(v0, iv);
                    v1 = std::max(v1, iv);
                }
        if (u1 < 0) continue;
        const int margin = std::max(15, 10 * std::max(u1 - u0, v1 - v0));
        const int a0 = std::max(0, u0 - margin), a1 = std::min(n[u], u1 + margin);
        const int b0 = std::max(0, v0 - margin), b1 = std::min(n[v], v1 + margin);
        const int nu = a1 - a0 + 1, nv = b1 - b0 + 1;
        std::vector<double> A(static_cast<std::size_t>(nu) * nv, 0.0);
        std::vector<std::uint8_t> fixedNode(A.size(), 0);
        auto at = [&](int iu, int iv) { return static_cast<std::size_t>(iu - a0) * nv + (iv - b0); };
        for (int iu = a0; iu <= a1; ++iu)
            for (int iv = b0; iv <= b1; ++iv) {
                if (f.M(c)[edgeAt(iu, iv)] == tags[t].id) {
                    A[at(iu, iv)] = 1.0;
                    fixedNode[at(iu, iv)] = 1;
                } else if (iu == a0 || iu == a1 || iv == b0 || iv == b1) {
                    fixedNode[at(iu, iv)] = 1; // A = 0 on the window edge
                }
            }
        // Link weights (dual side / link length) of the discrete Laplacian on the rectilinear grid.
        auto weight = [&](int iu, int iv, int du, int dv) {
            if (du) return f.dd[v][iv] / f.d[u][du > 0 ? iu : iu - 1];
            return f.dd[u][iu] / f.d[v][dv > 0 ? iv : iv - 1];
        };
        const int dirs[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int sweep = 0; sweep < 100000; ++sweep) {
            double change = 0;
            for (int iu = a0 + 1; iu < a1; ++iu)
                for (int iv = b0 + 1; iv < b1; ++iv) {
                    if (fixedNode[at(iu, iv)]) continue;
                    double num = 0, den = 0;
                    for (const auto& d : dirs) {
                        const double w = weight(iu, iv, d[0], d[1]);
                        num += w * A[at(iu + d[0], iv + d[1])];
                        den += w;
                    }
                    double& x = A[at(iu, iv)];
                    const double next = x + 1.9 * (num / den - x);
                    change = std::max(change, std::abs(next - x));
                    x = next;
                }
            if (change < 1e-10) break;
        }
        // Current share of each conductor node: the flux of grad A through its dual face.
        // Only axial conductor edges count: transverse edges half out of the wire (the
        // 50 % rule) lie in single grid planes, and H passes between them.
        std::map<std::pair<int, int>, double> share;
        double total = 0;
        for (int iu = a0 + 1; iu < a1; ++iu)
            for (int iv = b0 + 1; iv < b1; ++iv) {
                if (A[at(iu, iv)] != 1.0 || !fixedNode[at(iu, iv)]) continue;
                double s = 0;
                for (const auto& d : dirs) s += weight(iu, iv, d[0], d[1]) * (1.0 - A[at(iu + d[0], iv + d[1])]);
                if (s > 0) {
                    share[{iu, iv}] = s;
                    total += s;
                }
            }
        if (total <= 0) continue;
        const double rWire = wireResistance(tags[t].metal->conductivity, fRef, o.radius);
        wireCal[t].axis = c;
        const double cap = 100.0 * static_cast<double>(share.size()); // nodes with almost no current stay good conductors
        for (const auto& [node, s] : share) wireCal[t].rho[node] = rWire * std::min(total / s, cap);
    }

    struct Lossy {
        int c;
        std::size_t at;
        double sigma;
        std::size_t tag;
    };
    std::vector<std::vector<Lossy>> found(pool_->size());
    std::vector<std::vector<std::pair<std::uint64_t, std::uint16_t>>> nearCutEdges(pool_->size());
    std::vector<std::vector<long long>> unmodelled(pool_->size(), std::vector<long long>(tags.size(), 0));
    for (int c = 0; c < 3; ++c) {
        const int u = (c + 1) % 3, v = (c + 2) % 3;
        pool_->run([&](int tid, int nt) {
            const auto [i0, i1] = ThreadPool::range(0, n[0] + 1, tid, nt);
            for (int i = i0; i < i1; ++i)
                for (int j = 0; j <= n[1]; ++j)
                    for (int k = 0; k <= n[2]; ++k) {
                        const int ijk[3] = {i, j, k};
                        if (ijk[c] >= n[c]) continue;
                        const std::size_t at = f.idx(i, j, k);
                        const auto it = tagIndex.find(f.M(c)[at]);
                        if (it == tagIndex.end() || !f.eActive(c, i, j, k)) continue;
                        const MetalTag& t = tags[it->second];
                        const double sigma = t.metal->conductivity;
                        const bool sheet = t.o.kind == ObjectSpec::Kind::Sheet;
                        const double rSolid = surfaceResistance(sigma, fRef);
                        const double rSheet = sheet ? sheetResistance(sigma, fRef, t.o.thickness * p_.unit, t.o.sheetFaces) : 0.5 * rSolid;
                        // Cells beyond a PMC (symmetry) wall are mirror images; beyond other
                        // walls they count as empty.
                        auto cellIs = [&](int du, int dv) {
                            int q[3] = {i, j, k};
                            q[u] += du;
                            q[v] += dv;
                            for (int a : {u, v}) {
                                if (q[a] < 0 && pmc[2 * a]) q[a] = 0;
                                if (q[a] >= n[a] && pmc[2 * a + 1]) q[a] = n[a] - 1;
                                if (q[a] < 0 || q[a] >= n[a]) return false;
                            }
                            return cellCond[cellAt(q[0], q[1], q[2])] != 0;
                        };
                        // Face beside the edge in the (c, w) plane, on the cell w + s (s = 0 or -1).
                        auto faceFull = [&](int w, int s) {
                            int e0[3] = {i, j, k}, e1[3] = {i, j, k}, a0[3] = {i, j, k}, a1[3] = {i, j, k};
                            e0[w] += s;
                            e1[w] += s + 1;
                            a0[w] += s;
                            a1[w] += s;
                            a1[c] += 1;
                            return cond(c, e0) && cond(c, e1) && cond(w, a0) && cond(w, a1);
                        };
                        auto cutIs = [&](int du, int dv) {
                            if (cellCut.empty()) return false;
                            int q[3] = {i, j, k};
                            q[u] += du;
                            q[v] += dv;
                            if (q[u] < 0 || q[u] >= n[u] || q[v] < 0 || q[v] >= n[v]) return false;
                            return cellCut[cellAt(q[0], q[1], q[2])] != 0;
                        };
                        double g = 0; // sum of width / resistance per square
                        bool interior = true, nearCut = false;
                        for (int w : {u, v})
                            for (int s : {0, -1}) {
                                const int cw = ijk[w] + s;
                                if (cw < 0 || cw >= n[w]) continue;
                                // The two cells on either side of this half-line.
                                const bool a = w == u ? cellIs(s, -1) : cellIs(-1, s);
                                const bool b = w == u ? cellIs(s, 0) : cellIs(0, s);
                                if (a && b) continue;
                                interior = false;
                                if (w == u ? (cutIs(s, -1) || cutIs(s, 0)) : (cutIs(-1, s) || cutIs(0, s))) {
                                    nearCut = true;
                                    continue;
                                }
                                const double half = 0.5 * f.d[w][cw];
                                if (a != b) g += half / rSolid;
                                else if (faceFull(w, s)) g += half / rSheet;
                            }
                        if (interior) continue;
                        if (nearCut) {
                            nearCutEdges[tid].push_back({edgeKey(c, at), t.id});
                            continue;
                        }
                        const WireCal& wc = wireCal[it->second];
                        if (wc.axis == c) {
                            const auto r = wc.rho.find({ijk[u], ijk[v]});
                            if (r != wc.rho.end()) {
                                found[tid].push_back({c, at, 1.0 / (r->second * f.dd[u][ijk[u]] * f.dd[v][ijk[v]]), it->second});
                                continue;
                            }
                        }
                        if (g == 0) {
                            // A line of edges: a wire box, or a cylinder thinner than a cell.
                            int wireAxis = -1;
                            if (t.o.kind == ObjectSpec::Kind::Cylinder) wireAxis = t.o.axis;
                            if (t.o.kind == ObjectSpec::Kind::Mesh) wireAxis = t.o.wireAxis;
                            if (t.o.kind == ObjectSpec::Kind::Box && t.o.radius > 0)
                                for (int a = 0; a < 3; ++a)
                                    if (t.o.max[a] > t.o.min[a]) wireAxis = a;
                            if (wireAxis != c) {
                                ++unmodelled[tid][it->second];
                                continue;
                            }
                            g = 1.0 / wireResistance(sigma, fRef, t.o.radius);
                        }
                        found[tid].push_back({c, at, g / (f.dd[u][ijk[u]] * f.dd[v][ijk[v]]), it->second});
                    }
        });
    }

    for (const auto& per : nearCutEdges)
        for (const auto& [key, id] : per) surfaceEdges_[key] = id;

    // Conductivities rounded to 1e-4 (relative) so equal geometry shares a table entry.
    std::map<double, std::uint16_t> ids;
    std::vector<long long> lossyCount(tags.size(), 0), unmodelledCount(tags.size(), 0);
    for (const auto& per : found)
        for (const Lossy& l : per) {
            const double sc = std::pow(10.0, std::floor(std::log10(l.sigma)) - 4);
            const double q = std::round(l.sigma / sc) * sc;
            auto it = ids.find(q);
            if (it == ids.end()) it = ids.emplace(q, f.materials.addMetal(q, f.dt())).first;
            f.M(l.c)[l.at] = it->second;
            ++lossyCount[l.tag];
        }
    for (const auto& per : unmodelled)
        for (std::size_t t = 0; t < tags.size(); ++t) unmodelledCount[t] += per[t];
    // Interior and unmodelled edges become plain PEC.
    for (int c = 0; c < 3; ++c)
        for (auto& e : f.M(c))
            if (tagIndex.count(e)) e = EdgeMaterialTable::kPec;

    const double minCell = minSpacingAll(f.grid());
    std::map<const MaterialSpec*, bool> skinWarned;
    auto fmt = [](double v, int prec) {
        char b[48];
        std::snprintf(b, sizeof b, "%.*g", prec, v);
        return std::string(b);
    };
    for (std::size_t t = 0; t < tags.size(); ++t) {
        const MetalTag& tg = tags[t];
        ObjectReport& r = report_.objects[tg.report];
        r.lossyEdges = lossyCount[t];
        for (const auto& [key, edge] : partial_) r.lossyEdges += edge.owner == tg.id;
        const double sigma = tg.metal->conductivity, delta = skinDepth(sigma, fRef);
        diag("METAL_LOSS", "info",
             "\"" + r.name + "\": " + tg.metal->name + " (" + fmt(sigma, 3) + " S/m), R_s " + fmt(1e3 * surfaceResistance(sigma, fRef), 3) +
                 " mOhm and skin depth " + fmt(1e6 * delta, 3) + " um at " + fmt(fRef / 1e6, 4) + " MHz; " + std::to_string(r.lossyEdges) +
                 " surface edges carry the conductor loss");
        if (delta > 0.1 * minCell && !skinWarned[tg.metal]) {
            skinWarned[tg.metal] = true;
            diag("METAL_SKIN_DEPTH", "warning",
                 tg.metal->name + ": the skin depth (" + fmt(1e3 * delta, 3) + " mm) is not small compared with the grid cells (" +
                     fmt(1e3 * minCell, 3) + " mm); the surface-resistance model assumes a good conductor, so model a resistive "
                     "material as a lossy dielectric instead");
        }
        if (unmodelledCount[t])
            diag("METAL_EDGES_UNMODELLED", "warning",
                 "\"" + r.name + "\": " + std::to_string(unmodelledCount[t]) +
                     " exposed edges have no loss model (a body thinner than a cell that is not a sheet or a wire with a radius) and stay lossless");
    }
}

bool Solver::inConductor(int c, std::size_t at) const {
    const YeeFields& f = *f_;
    if (f.materials.isConductor(f.M(c)[at])) return true;
    if (partial_.empty()) return false;
    const auto it = partial_.find(edgeKey(c, at));
    if (it == partial_.end()) return false;
    const int ijk[3] = {static_cast<int>(at / f.sx()), static_cast<int>((at % f.sx()) / f.sy()), static_cast<int>(at % f.sy())};
    const double len = f.d[c][ijk[c]];
    return coveredLength(it->second.covered, 0.0, len) >= 0.5 * len;
}

// Conformal: merges what each object recorded on an edge. Edges that end up (almost)
// fully covered become conductor edges, and nearly free ones plain edges.
void Solver::resolvePartialEdges() {
    YeeFields& f = *f_;
    for (auto it = partial_.begin(); it != partial_.end();) {
        const int c = static_cast<int>(it->first / f.nodeCount());
        const std::size_t at = it->first % f.nodeCount();
        const int ijk[3] = {static_cast<int>(at / f.sx()), static_cast<int>((at % f.sx()) / f.sy()), static_cast<int>(at % f.sy())};
        const double len = f.d[c][ijk[c]];
        PartialEdge& e = it->second;
        mergeIntervals(e.covered);
        const double cov = coveredLength(e.covered, 0.0, len);
        auto& m = f.M(c)[at];
        if (f.materials.isConductor(m) || cov <= kCutSnap * len) {
            it = partial_.erase(it);
        } else if (cov >= (1.0 - kCutSnap) * len) {
            m = e.owner;
            it = partial_.erase(it);
        } else {
            ++it;
        }
    }
}

// Conformal conductors (docs/physics.md): the H update of a cut face uses the open
// lengths l_i of its contour edges and its open area A, with the conductor's surface
// closing the contour along chords between the cuts:
//   mu A dH/dt = -sum(+-l_i E_i) - l_c E_s,  E_s = R_s H / kappa on a metal's chord.
// Faces with a small area would need a much shorter time step; instead their coefficients
// are capped (dt^2 c^2 sum(l_i / (A dual_i)) <= beta) and the largest eigenvalue of the
// whole update is measured, tightening the cap if needed. E updates are unchanged.
void Solver::buildCutFaces() {
    YeeFields& f = *f_;
    const std::size_t nodes = f.nodeCount();
    const int n[3] = {f.nx(), f.ny(), f.nz()};

    // The faces touching a partly covered edge, in a fixed order.
    std::vector<std::uint64_t> keys;
    keys.reserve(4 * partial_.size());
    for (const auto& [key, edge] : partial_) {
        const int c = static_cast<int>(key / nodes);
        const std::size_t at = key % nodes;
        const int ijk[3] = {static_cast<int>(at / f.sx()), static_cast<int>((at % f.sx()) / f.sy()), static_cast<int>(at % f.sy())};
        const int p = (c + 1) % 3, q = (c + 2) % 3;
        // curl_c = dH_q/dp - dH_p/dq. H_q needs a cell along p, and H_p one along q.
        if (ijk[p] < n[p]) keys.push_back(q * nodes + at);
        if (ijk[p] > 0) keys.push_back(q * nodes + at - f.stride(p));
        if (ijk[q] < n[q]) keys.push_back(p * nodes + at);
        if (ijk[q] > 0) keys.push_back(p * nodes + at - f.stride(q));
    }
    for (const auto& [key, tag] : surfaceEdges_) {
        const int c = static_cast<int>(key / nodes);
        const std::size_t at = key % nodes;
        const int ijk[3] = {static_cast<int>(at / f.sx()), static_cast<int>((at % f.sx()) / f.sy()), static_cast<int>(at % f.sy())};
        const int p = (c + 1) % 3, q = (c + 2) % 3;
        if (ijk[p] < n[p]) keys.push_back(q * nodes + at);
        if (ijk[p] > 0) keys.push_back(q * nodes + at - f.stride(p));
        if (ijk[q] < n[q]) keys.push_back(p * nodes + at);
        if (ijk[q] > 0) keys.push_back(p * nodes + at - f.stride(q));
    }
    std::sort(keys.begin(), keys.end());
    keys.erase(std::unique(keys.begin(), keys.end()), keys.end());

    struct Geom {
        std::uint8_t hc, ec[4];
        std::size_t hq, eq[4];
        double len[4], stdWeight[4], dualPerp[4]; // open length, 1 / cell, dual spacing across the edge
        int sign[4];
        double area, chord, rs, kappa;
    };
    std::vector<Geom> geoms;
    geoms.reserve(keys.size());
    for (std::uint64_t key : keys) {
        const int h = static_cast<int>(key / nodes);
        const std::size_t at = key % nodes;
        const int ijk[3] = {static_cast<int>(at / f.sx()), static_cast<int>((at % f.sx()) / f.sy()), static_cast<int>(at % f.sy())};
        const int p = (h + 1) % 3, q = (h + 2) % 3;
        const double dp = f.d[p][ijk[p]], dq = f.d[q][ijk[q]];
        // Contour, counterclockwise in (p, q): bottom E_p, right E_q, top E_p (reversed), left E_q (reversed).
        const std::size_t edgeAt[4] = {at, at + f.stride(p), at + f.stride(q), at};
        const int edgeComp[4] = {p, q, p, q};
        const double x0[4] = {0, dp, dp, 0}, y0[4] = {0, 0, dq, dq};
        const double dirX[4] = {1, 0, -1, 0}, dirY[4] = {0, 1, 0, -1};
        const double edgeLen[4] = {dp, dq, dp, dq};
        std::vector<std::array<double, 4>> segs; // open stretches: x0 y0 x1 y1
        Geom g{};
        g.hc = static_cast<std::uint8_t>(h);
        g.hq = at;
        g.rs = 0;
        std::array<double, 3> normal{};
        bool anyPartial = false;
        double surfaceLen = 0, surfaceRs = 0;
        for (int s = 0; s < 4; ++s) {
            const int c = edgeComp[s];
            g.ec[s] = static_cast<std::uint8_t>(c);
            g.eq[s] = edgeAt[s];
            const int other = c == p ? q : p;
            const int e3[3] = {static_cast<int>(edgeAt[s] / f.sx()), static_cast<int>((edgeAt[s] % f.sx()) / f.sy()), static_cast<int>(edgeAt[s] % f.sy())};
            g.dualPerp[s] = f.dd[other][e3[other]];
            g.stdWeight[s] = 1.0 / (c == p ? dq : dp);
            // H -= ch ((E_q right - E_q left) / d_p - (E_p top - E_p bottom) / d_q)
            g.sign[s] = s == 0 || s == 1 ? 1 : -1;
            const double len = edgeLen[s];
            std::vector<Interval> open; // along the edge, from its start
            if (f.materials.isConductor(f.M(c)[edgeAt[s]]) && f.eActive(c, e3[0], e3[1], e3[2])) {
                // Fully covered, and on the surface if it was recorded so.
                if (const auto se = surfaceEdges_.find(edgeKey(c, edgeAt[s])); se != surfaceEdges_.end()) {
                    surfaceLen += len;
                    if (const auto rs = metalRs_.find(se->second); rs != metalRs_.end()) surfaceRs = rs->second;
                }
            } else if (const auto it = partial_.find(edgeKey(c, edgeAt[s])); it != partial_.end()) {
                anyPartial = true;
                double from = 0;
                for (const auto& [lo, hi] : it->second.covered) {
                    if (lo > from + kCutSnap * len) open.emplace_back(from, lo);
                    from = std::max(from, hi);
                }
                if (from < len - kCutSnap * len) open.emplace_back(from, len);
                for (int a = 0; a < 3; ++a) normal[a] += it->second.normal[a];
                if (g.rs == 0) {
                    const auto rs = metalRs_.find(it->second.owner);
                    if (rs != metalRs_.end()) g.rs = rs->second;
                }
            } else {
                open.emplace_back(0.0, len);
            }
            double free = 0;
            for (const auto& [lo, hi] : open) free += hi - lo;
            g.len[s] = f.eActive(c, e3[0], e3[1], e3[2]) ? free : 0.0; // E stays 0 on the PEC outer faces
            // Walk counterclockwise: edges 2 and 3 run against their axes.
            const bool reversed = s >= 2;
            if (reversed) std::reverse(open.begin(), open.end());
            for (const auto& [lo, hi] : open) {
                const double a0 = reversed ? len - hi : lo, a1 = reversed ? len - lo : hi;
                segs.push_back({x0[s] + dirX[s] * a0, y0[s] + dirY[s] * a0, x0[s] + dirX[s] * a1, y0[s] + dirY[s] * a1});
            }
        }
        // Open area by the shoelace formula, with chords between open stretches.
        double twice = 0, chord = 0;
        for (std::size_t i = 0; i < segs.size(); ++i) {
            const auto& a = segs[i];
            const auto& b = segs[(i + 1) % segs.size()];
            twice += a[0] * a[3] - a[2] * a[1] + a[2] * b[1] - b[0] * a[3];
            chord += std::hypot(b[0] - a[2], b[1] - a[3]);
        }
        g.area = 0.5 * std::abs(twice);
        g.chord = chord;
        if (!anyPartial) {
            // No cut in this face: the surface runs along its metal edges. Full area, chords along them.
            if (segs.empty() || surfaceLen == 0) continue;
            g.area = dp * dq;
            g.chord = surfaceLen;
            g.rs = surfaceRs;
        }
        // kappa: the surface's tangent across the chord, projected on the face normal. H of the
        // face is that tangential H times kappa, so E_s = R_s H / kappa (exact loss per surface area).
        const double nn = std::sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
        const double nh = nn > 0 ? normal[h] / nn : 0.0;
        g.kappa = std::clamp(std::sqrt(std::max(0.0, 1.0 - nh * nh)), 0.2, 1.0);
        geoms.push_back(g);
    }

    const double dt = f.dt();
    const double chBulk = static_cast<double>(static_cast<float>(dt / MU0));
    auto build = [&](double beta) {
        long long capped = 0;
        f.cutFaces.clear();
        f.cutFaces.reserve(geoms.size());
        for (const Geom& g : geoms) {
            CutFace cf{};
            cf.hc = g.hc;
            cf.hq = g.hq;
            for (int s = 0; s < 4; ++s) {
                cf.ec[s] = g.ec[s];
                cf.eq[s] = g.eq[s];
            }
            double load = 0;
            for (int s = 0; s < 4; ++s) load += g.len[s] / g.dualPerp[s];
            const double areaFull = g.stdWeight[0] > 0 ? 1.0 / (g.stdWeight[0] * g.stdWeight[1]) : 0.0;
            const bool open = g.area > 1e-6 * areaFull;
            double gain = 1.0;
            if (open) {
                const double m = dt * dt * C0 * C0 * load / g.area;
                if (m > beta) {
                    gain = beta / m;
                    ++capped;
                }
            }
            const double alpha = open ? gain * dt * g.rs * g.chord / (2.0 * MU0 * g.area * g.kappa) : 0.0;
            const double cah = (1.0 - alpha) / (1.0 + alpha);
            const double cbh = open ? (dt / MU0) * gain / (g.area * (1.0 + alpha)) : 0.0;
            cf.c[0] = static_cast<float>(open ? cah : 1.0);
            for (int s = 0; s < 4; ++s) {
                const double std_ = chBulk * g.stdWeight[s];
                cf.c[s + 1] = static_cast<float>(g.sign[s] * ((open ? cah : 1.0) * std_ - cbh * g.len[s]));
            }
            f.cutFaces.push_back(cf);
        }
        return capped;
    };
    double beta = 3.0, lambda = 0;
    long long capped = 0;
    for (int attempt = 0; attempt < 8; ++attempt) {
        capped = build(beta);
        lambda = updateEigenvalue();
        if (lambda <= kStableEigenvalue) break;
        beta *= 0.85;
    }
    report_.cutFaces = static_cast<long long>(f.cutFaces.size());
    report_.cappedFaces = capped;
    report_.stabilityEigenvalue = lambda;
    if (lambda > kStableEigenvalue)
        diag("CONFORMAL_UNSTABLE", "error", "the conformal update could not be made stable on this grid (eigenvalue " + std::to_string(lambda) + "); turn off conformal conductors or change the mesh");
    diag("CONFORMAL", "info", std::to_string(report_.cutFaces) + " faces cut by conductors use their true open area; " + std::to_string(capped) + " small ones are capped to keep the time step");
}

// Largest eigenvalue of dt^2 M, with M the E-to-E operator of one time step, by power
// iteration from random values on the cut faces' edges (the modes that can break the
// limit live there). Leapfrog is stable while it stays below 4. Leaves the fields at 0.
double Solver::updateEigenvalue() {
    YeeFields& f = *f_;
    for (int c = 0; c < 3; ++c) std::fill(f.E(c).begin(), f.E(c).end(), 0.0f);
    std::uint32_t seed = 12345;
    for (const CutFace& cf : f.cutFaces)
        for (int s = 0; s < 4; ++s) {
            seed = seed * 1664525u + 1013904223u;
            f.E(cf.ec[s])[cf.eq[s]] = (seed >> 16) & 1u ? 1.0f : -1.0f;
        }
    auto norm = [&]() {
        double sum = 0;
        for (int c = 0; c < 3; ++c)
            for (float v : f.E(c)) sum += static_cast<double>(v) * v;
        return std::sqrt(sum);
    };
    double nx = norm(), lambda = 0;
    for (int iter = 0; iter < 120 && nx > 0; ++iter) {
        for (int c = 0; c < 3; ++c) std::fill(f.H(c).begin(), f.H(c).end(), 0.0f);
        f.updateH(*pool_);
        for (int c = 0; c < 3; ++c) std::fill(f.E(c).begin(), f.E(c).end(), 0.0f);
        f.updateE(*pool_);
        const double ny = norm();
        lambda = ny / nx;
        if (!(ny > 0)) break;
        const float scale = static_cast<float>(1.0 / ny);
        for (int c = 0; c < 3; ++c)
            for (float& v : f.E(c)) v *= scale;
        nx = norm();
    }
    for (int c = 0; c < 3; ++c) {
        std::fill(f.E(c).begin(), f.E(c).end(), 0.0f);
        std::fill(f.H(c).begin(), f.H(c).end(), 0.0f);
    }
    return lambda;
}

void Solver::checkDcPath() {
    // Union-find over grid nodes joined by PEC edges; the port's reference and
    // signal ends are DC-connected if they share a component.
    const YeeFields& f = *f_;
    const std::size_t nodes = f.nodeCount();
    std::vector<std::uint32_t> parent(nodes);
    for (std::size_t i = 0; i < nodes; ++i) parent[i] = static_cast<std::uint32_t>(i);
    auto find = [&](std::uint32_t x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    for (int c = 0; c < 3; ++c) {
        const std::size_t st = f.stride(c);
        for (int i = 0; i <= f.nx(); ++i)
            for (int j = 0; j <= f.ny(); ++j)
                for (int k = 0; k <= f.nz(); ++k) {
                    const int ijk[3] = {i, j, k};
                    if (ijk[c] >= f.n(c)) continue;
                    const std::size_t at = f.idx(i, j, k);
                    if (!inConductor(c, at)) continue;
                    const auto ra = find(static_cast<std::uint32_t>(at)), rb = find(static_cast<std::uint32_t>(at + st));
                    if (ra != rb) parent[ra] = rb;
                }
    }
    const bool joined = find(static_cast<std::uint32_t>(portEnds_[0])) == find(static_cast<std::uint32_t>(portEnds_[1]));
    report_.dcConnected = joined ? 1 : 0;
    if (joined)
        diag("PORT_DC_PATH", "warning",
             "the port's terminals are DC-connected through conductors (expected for PIFA, loop or folded antennas; "
             "unexpected for dipoles, monopoles and patches)");
}

std::vector<float> Solver::pecSegments(std::size_t maxSegments) const {
    const YeeFields& f = *f_;
    const RectGrid& g = f.grid();
    std::size_t total = 0;
    for (int c = 0; c < 3; ++c)
        for (int i = 0; i <= f.nx(); ++i)
            for (int j = 0; j <= f.ny(); ++j)
                for (int k = 0; k <= f.nz(); ++k) {
                    const int ijk[3] = {i, j, k};
                    if (ijk[c] < f.n(c) && inConductor(c, f.idx(i, j, k))) ++total;
                }
    const std::size_t stepEvery = std::max<std::size_t>(1, (total + maxSegments - 1) / std::max<std::size_t>(maxSegments, 1));
    std::vector<float> out;
    out.reserve(std::min(total, maxSegments) * 6);
    std::size_t seen = 0;
    const double inv = 1.0 / p_.unit;
    for (int c = 0; c < 3; ++c)
        for (int i = 0; i <= f.nx(); ++i)
            for (int j = 0; j <= f.ny(); ++j)
                for (int k = 0; k <= f.nz(); ++k) {
                    const int ijk[3] = {i, j, k};
                    if (ijk[c] >= f.n(c) || !inConductor(c, f.idx(i, j, k))) continue;
                    if (seen++ % stepEvery) continue;
                    double a0[3] = {g.x[i], g.y[j], g.z[k]}, a1[3] = {g.x[i], g.y[j], g.z[k]};
                    a1[c] = g.nodes(c)[ijk[c] + 1];
                    for (int d = 0; d < 3; ++d) out.push_back(static_cast<float>(a0[d] * inv));
                    for (int d = 0; d < 3; ++d) out.push_back(static_cast<float>(a1[d] * inv));
                }
    return out;
}

std::vector<float> Solver::portSegments() const {
    const YeeFields& f = *f_;
    const RectGrid& g = f.grid();
    std::vector<float> out;
    const int a = p_.port.axis;
    const double inv = 1.0 / p_.unit;
    for (const auto& e : portEdges_) {
        std::size_t r = e.at;
        const int i = static_cast<int>(r / f.sx());
        r %= f.sx();
        const int j = static_cast<int>(r / f.sy());
        const int k = static_cast<int>(r % f.sy());
        const int ijk[3] = {i, j, k};
        double p0[3] = {g.x[i], g.y[j], g.z[k]}, p1[3] = {g.x[i], g.y[j], g.z[k]};
        p1[a] = g.nodes(a)[ijk[a] + 1];
        for (int d = 0; d < 3; ++d) out.push_back(static_cast<float>(p0[d] * inv));
        for (int d = 0; d < 3; ++d) out.push_back(static_cast<float>(p1[d] * inv));
    }
    return out;
}

void Solver::setupPort() {
    YeeFields& f = *f_;
    const RectGrid& g = f.grid();
    const PortSpec& ps = p_.port;
    const int a = ps.axis, u = (a + 1) % 3, v = (a + 2) % 3;
    const double tol = 1e-4 * minSpacingAll(g);
    std::array<double, 3> lo, hi;
    for (int d = 0; d < 3; ++d) {
        lo[d] = std::min(ps.start[d], ps.stop[d]) * p_.unit;
        hi[d] = std::max(ps.start[d], ps.stop[d]) * p_.unit;
    }
    const auto ra = nodeRange(g.nodes(a), lo[a], hi[a], tol);
    const auto ru = nodeRange(g.nodes(u), lo[u], hi[u], tol);
    const auto rv = nodeRange(g.nodes(v), lo[v], hi[v], tol);
    if (ra.second - ra.first < 1)
        throw std::invalid_argument("port: start and stop must span at least one grid edge along the port axis");
    if (ru.second < ru.first || rv.second < rv.first)
        throw std::invalid_argument("port: the port must lie on grid lines across its axis");
    const int nSeries = ra.second - ra.first;
    const int mid = ra.first + nSeries / 2;
    {
        // End nodes of the central port line (reference end, signal end along the axis).
        int e0[3], e1[3];
        e0[a] = ra.first;
        e1[a] = ra.second;
        e0[u] = e1[u] = (ru.first + ru.second) / 2;
        e0[v] = e1[v] = (rv.first + rv.second) / 2;
        portEnds_[0] = f.idx(e0[0], e0[1], e0[2]);
        portEnds_[1] = f.idx(e1[0], e1[1], e1[2]);
    }

    double areaTotal = 0;
    for (int ju = ru.first; ju <= ru.second; ++ju)
        for (int jv = rv.first; jv <= rv.second; ++jv) areaTotal += f.dd[u][ju] * f.dd[v][jv];

    auto& m = f.M(a);
    const double dt = f.dt();
    int line = 0;
    int lossyEdges = 0;
    std::map<std::pair<float, float>, std::uint16_t> coefIds;
    for (int ju = ru.first; ju <= ru.second; ++ju) {
        for (int jv = rv.first; jv <= rv.second; ++jv, ++line) {
            const double area = f.dd[u][ju] * f.dd[v][jv];
            PortLine pl;
            pl.ijk[a] = mid;
            pl.ijk[u] = ju;
            pl.ijk[v] = jv;
            pl.area = area;
            pl.weight = area / areaTotal;
            portLines_.push_back(pl);
            const double rLine = ps.resistance * areaTotal / area;
            const double rEdge = rLine / nSeries;
            for (int ia = ra.first; ia < ra.second; ++ia) {
                int ijk[3];
                ijk[a] = ia;
                ijk[u] = ju;
                ijk[v] = jv;
                if (!f.eActive(a, ijk[0], ijk[1], ijk[2]))
                    throw std::invalid_argument("port: a port edge lies on a PEC boundary face");
                const std::size_t at = f.idx(ijk[0], ijk[1], ijk[2]);
                if (f.materials.isConductor(m[at]))
                    throw std::invalid_argument("port: a port edge lies inside a conductor, which would short the source");
                partial_.erase(edgeKey(a, at));
                const double eps = EPS0 * f.materials.epsR[m[at]];
                lossyEdges += f.materials.sigma[m[at]] > 0;
                const double len = f.d[a][ia];
                const double beta = dt * len / (2.0 * rEdge * eps * area);
                const float ca = static_cast<float>((1.0 - beta) / (1.0 + beta));
                const float cb = static_cast<float>(dt / (eps * (1.0 + beta)));
                const auto key = std::make_pair(ca, cb);
                auto it = coefIds.find(key);
                if (it == coefIds.end()) it = coefIds.emplace(key, f.materials.addRaw(ca, cb, eps / EPS0, 0.0, false)).first;
                m[at] = it->second;
                const double source = -dt / (eps * rEdge * area * (1.0 + beta)) * (ps.amplitude / nSeries);
                portEdges_.push_back({at, len, static_cast<float>(source), line});
            }
        }
    }
    // Like openEMS's lumped port (which takes priority over the material there), the
    // source edges keep the dielectric's permittivity but not its conductivity.
    if (lossyEdges)
        warnings_.push_back("port: the dielectric conductivity on " + std::to_string(lossyEdges) + " port edge" + (lossyEdges > 1 ? "s is" : " is") +
                            " not applied (the source resistance replaces it there)");
    // Floating-terminal check: the port's end nodes should touch a conductor.
    auto touchesPec = [&](int ia) {
        for (const auto& pl : portLines_) {
            int ijk[3] = {pl.ijk[0], pl.ijk[1], pl.ijk[2]};
            ijk[a] = ia;
            for (int c = 0; c < 3; ++c) {
                for (int s = -1; s <= 0; ++s) {
                    int e[3] = {ijk[0], ijk[1], ijk[2]};
                    e[c] += s;
                    if (e[c] < 0 || e[c] >= f.n(c) || e[0] > f.nx() || e[1] > f.ny() || e[2] > f.nz()) continue;
                    if (inConductor(c, f.idx(e[0], e[1], e[2]))) return true;
                }
            }
        }
        return false;
    };
    if (!touchesPec(ra.first)) diag("PORT_FLOATING", "error", "port: the reference end does not touch a conductor on the grid (floating terminal)");
    if (!touchesPec(ra.second)) diag("PORT_FLOATING", "error", "port: the signal end does not touch a conductor on the grid (floating terminal)");
}

void Solver::setupFarField() {
    if (p_.farField.frequencies.empty()) return;
    for (auto b : p_.boundaries)
        if (b != Boundary::Cpml) {
            warnings_.push_back("far field skipped: it needs CPML on all six faces in this version");
            return;
        }
    std::array<int, 3> lo{}, hi{};
    for (int a = 0; a < 3; ++a) {
        lo[a] = cpml_->cells(2 * a) + p_.farField.marginCells;
        hi[a] = f_->n(a) - cpml_->cells(2 * a + 1) - p_.farField.marginCells;
        if (hi[a] - lo[a] < 2) throw std::invalid_argument("far field: domain too small for the NF2FF box between the PMLs");
    }
    // The box faces must cross vacuum only (no conductor, dielectric or port edges on them).
    const YeeFields& f = *f_;
    for (int a = 0; a < 3; ++a)
        for (int plane : {lo[a], hi[a]}) {
            const int p = (a + 1) % 3, q = (a + 2) % 3;
            for (int c : {p, q})
                for (int jp = lo[p]; jp <= hi[p]; ++jp)
                    for (int jq = lo[q]; jq <= hi[q]; ++jq) {
                        int ijk[3];
                        ijk[a] = plane;
                        ijk[p] = jp;
                        ijk[q] = jq;
                        if (ijk[c] >= (c == p ? hi[p] : hi[q])) continue;
                        if (f.M(c)[f.idx(ijk[0], ijk[1], ijk[2])] != EdgeMaterialTable::kVacuum)
                            throw std::invalid_argument("far field: the NF2FF box (" + std::to_string(p_.farField.marginCells) +
                                                        " cells inside the PML) intersects the structure; enlarge the domain");
                    }
        }
    nf2ff_ = std::make_unique<Nf2ff>(*f_, lo, hi, p_.farField.frequencies);
}

std::size_t Solver::memoryBytes() const {
    return f_->memoryBytes() + cpml_->memoryBytes() + (nf2ff_ ? nf2ff_->memoryBytes() : 0) +
           (vSeries_.capacity() + iSeries_.capacity()) * sizeof(double);
}

// ------------------------------------------------------------------ time stepping
void Solver::recordCurrent() {
    double i = 0;
    for (const auto& pl : portLines_) i += f_->curlH(p_.port.axis, pl.ijk[0], pl.ijk[1], pl.ijk[2]) * pl.area;
    iSeries_.push_back(i);
}

void Solver::recordVoltage() {
    std::vector<double> vLine(portLines_.size(), 0.0);
    const auto& e = f_->E(p_.port.axis);
    for (const auto& pe : portEdges_) vLine[pe.line] -= e[pe.at] * pe.length;
    double v = 0;
    for (std::size_t l = 0; l < portLines_.size(); ++l) v += portLines_[l].weight * vLine[l];
    vSeries_.push_back(v);
}

RunState Solver::step(long long maxChunk) {
    if (state_.done) return state_;
    const auto t0 = std::chrono::steady_clock::now();
    YeeFields& f = *f_;
    ThreadPool& pool = *pool_;
    const double dt = f.dt();
    auto& ea = f.E(p_.hasPort ? p_.port.axis : 0);
    for (long long c = 0; c < maxChunk && !state_.done; ++c) {
        const long long n = state_.step;
        f.updateH(pool);
        cpml_->correctH(pool);
        if (p_.hasPort) recordCurrent();
        if (nf2ff_) nf2ff_->accumulateH(n, pool);

        f.updateE(pool);
        cpml_->correctE(pool);
        if (p_.hasPort) {
            const float g = static_cast<float>(pulse_((n + 0.5) * dt));
            for (const auto& pe : portEdges_) ea[pe.at] += pe.source * g;
            recordVoltage();
        }
        if (nf2ff_) nf2ff_->accumulateE(n, pool);

        state_.step = n + 1;
        state_.time = state_.step * dt;
        if (state_.step % checkEvery_ == 0) {
            const double w = f.energy(&pool);
            peakEnergy_ = std::max(peakEnergy_, w);
            state_.energyDb = (peakEnergy_ > 0 && w > 0) ? 10.0 * std::log10(w / peakEnergy_) : (peakEnergy_ > 0 ? -300.0 : 0.0);
            if (state_.time > pulse_.endTime() && peakEnergy_ > 0 && state_.energyDb <= p_.energyEndDb) {
                state_.done = true;
                state_.terminatedBy = "energy";
            }
        }
        if (!state_.done && state_.step >= p_.maxSteps) {
            state_.done = true;
            state_.terminatedBy = "maxSteps";
        }
    }
    wallSeconds_ += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    return state_;
}

// ------------------------------------------------------------------ post-processing
void Solver::portSpectrum(const std::vector<double>& freqs, std::vector<std::complex<double>>& V,
                          std::vector<std::complex<double>>& I) const {
    const double dt = f_->dt();
    V.assign(freqs.size(), 0.0);
    I.assign(freqs.size(), 0.0);
    for (std::size_t k = 0; k < freqs.size(); ++k) {
        const double w = 2.0 * PI * freqs[k];
        const std::complex<double> rot = std::polar(1.0, -w * dt);
        std::complex<double> pv = std::polar(1.0, -w * dt);       // V_n at (n+1) dt
        std::complex<double> pi = std::polar(1.0, -w * 0.5 * dt); // I_n at (n+1/2) dt
        std::complex<double> sv = 0, si = 0;
        for (std::size_t n = 0; n < vSeries_.size(); ++n) {
            sv += vSeries_[n] * pv;
            si += iSeries_[n] * pi;
            pv *= rot;
            pi *= rot;
            if ((n & 1023) == 1023) { // renormalize the rotating phasors
                pv /= std::abs(pv);
                pi /= std::abs(pi);
            }
        }
        V[k] = sv * dt;
        I[k] = si * dt;
    }
}

// ------------------------------------------------------------------ external time loop
std::string Solver::gpuLayoutJson() const {
    using nlohmann::json;
    const YeeFields& f = *f_;
    json j;
    j["nx"] = f.nx();
    j["ny"] = f.ny();
    j["nz"] = f.nz();
    j["sx"] = f.sx();
    j["sy"] = f.sy();
    j["nodes"] = f.nodeCount();
    j["dt"] = f.dt();
    j["chH"] = f.dt() / MU0;
    j["checkEvery"] = checkEvery_;
    j["maxSteps"] = p_.maxSteps;
    j["energyEndDb"] = p_.energyEndDb;
    j["pulseEnd"] = pulse_.endTime();
    j["materials"] = f.materials.size();
    j["pmc"] = f.pmcFaces();
    j["cells"] = f.grid().cellCount();
    j["cutFaces"] = f.cutFaces.size();
    json slabs = json::array();
    for (const auto& s : cpml_->slabInfo())
        slabs.push_back({{"axis", s.axis}, {"lo", s.lo}, {"hi", s.hi}, {"nE", s.nE}, {"nH", s.nH}, {"planeE", s.planeE},
                         {"profE", s.profE}, {"profH", s.profH}, {"psiE", s.psiE}, {"psiH", s.psiH}});
    j["cpml"] = slabs;
    if (p_.hasPort) {
        json edges = json::array(), lines = json::array();
        for (const auto& e : portEdges_) edges.push_back({{"at", e.at}, {"length", e.length}, {"source", e.source}, {"line", e.line}});
        for (const auto& l : portLines_) lines.push_back({{"ijk", {l.ijk[0], l.ijk[1], l.ijk[2]}}, {"area", l.area}, {"weight", l.weight}});
        j["port"] = {{"axis", p_.port.axis}, {"edges", edges}, {"lines", lines}};
    } else {
        j["port"] = nullptr;
    }
    if (nf2ff_) {
        json faces = json::array();
        for (const auto& fi : nf2ff_->faceInfo())
            faces.push_back({{"a", fi.a}, {"side", fi.side}, {"plane", fi.plane}, {"B0", fi.B0}, {"B1", fi.B1}, {"C0", fi.C0}, {"C1", fi.C1},
                             {"nb", fi.nb}, {"nc", fi.nc}, {"offEp", fi.offEp}, {"offHq", fi.offHq}, {"offEq", fi.offEq}, {"offHp", fi.offHp}});
        j["nf2ff"] = {{"freqs", nf2ff_->frequencies()}, {"faces", faces}};
    } else {
        j["nf2ff"] = nullptr;
    }
    return j.dump();
}

std::vector<float> Solver::gpuFloats(const std::string& name) const {
    const YeeFields& f = *f_;
    auto toF = [](const std::vector<double>& v) { return std::vector<float>(v.begin(), v.end()); };
    if (name == "ca") return f.materials.ca;
    if (name == "cb") return f.materials.cb;
    if (name == "epsR") return toF(f.materials.epsR);
    if (name == "cutCoef") {
        std::vector<float> c;
        c.reserve(5 * f.cutFaces.size());
        for (const CutFace& cf : f.cutFaces) c.insert(c.end(), cf.c, cf.c + 5);
        return c;
    }
    if (name == "cpmlProfE") return cpml_->profiles(true);
    if (name == "cpmlProfH") return cpml_->profiles(false);
    if (name == "waveform") {
        std::vector<float> w(static_cast<std::size_t>(p_.maxSteps));
        for (std::size_t n = 0; n < w.size(); ++n) w[n] = static_cast<float>(pulse_((static_cast<double>(n) + 0.5) * f.dt()));
        return w;
    }
    if (name.size() >= 2 && (name.back() >= '0' && name.back() <= '2')) {
        const int a = name.back() - '0';
        const std::string base = name.substr(0, name.size() - 1);
        if (base == "invD") return f.invD[a];
        if (base == "invDd") return f.invDd[a];
        if (base == "d") return toF(f.d[a]);
        if (base == "dd") return toF(f.dd[a]);
    }
    throw std::invalid_argument("unknown GPU float array '" + name + "'");
}

std::vector<std::uint32_t> Solver::gpuUints(const std::string& name) const {
    if (name == "cutIdx") { // flat indices into E x y z, H x y z: H, then the four edges
        const std::size_t nodes = f_->nodeCount();
        std::vector<std::uint32_t> out;
        out.reserve(5 * f_->cutFaces.size());
        for (const CutFace& cf : f_->cutFaces) {
            out.push_back(static_cast<std::uint32_t>((3u + cf.hc) * nodes + cf.hq));
            for (int s = 0; s < 4; ++s) out.push_back(static_cast<std::uint32_t>(cf.ec[s] * nodes + cf.eq[s]));
        }
        return out;
    }
    if (name != "mx" && name != "my" && name != "mz") throw std::invalid_argument("unknown GPU uint array '" + name + "'");
    const auto& m = f_->M(name[1] - 'x');
    std::vector<std::uint32_t> out((m.size() + 1) / 2, 0);
    for (std::size_t i = 0; i < m.size(); ++i) out[i / 2] |= static_cast<std::uint32_t>(m[i]) << (16 * (i % 2));
    return out;
}

std::vector<float> Solver::fieldSnapshot(int comp) const {
    if (comp < 0 || comp > 5) throw std::invalid_argument("field component must be 0..5");
    return comp < 3 ? f_->E(comp) : f_->H(comp - 3);
}

void Solver::importRun(RunImport r) {
    if (r.steps < 0 || r.steps > p_.maxSteps) throw std::invalid_argument("import: step count out of range");
    if (p_.hasPort && (r.voltage.size() != static_cast<std::size_t>(r.steps) || r.current.size() != static_cast<std::size_t>(r.steps)))
        throw std::invalid_argument("import: port series length does not match the step count");
    if (nf2ff_) nf2ff_->importAcc(r.nf2ffAcc);
    vSeries_ = std::move(r.voltage);
    iSeries_ = std::move(r.current);
    state_.step = r.steps;
    state_.time = r.steps * f_->dt();
    state_.energyDb = r.energyDb;
    state_.done = true;
    state_.terminatedBy = r.terminatedBy;
    wallSeconds_ = r.seconds;
    backend_ = r.backend;
}

void Solver::releaseTimeLoopStorage() {
    YeeFields& f = *f_;
    for (auto* v : {&f.ex, &f.ey, &f.ez, &f.hx, &f.hy, &f.hz}) std::vector<float>().swap(*v);
    cpml_->releaseState();
}

std::vector<double> Solver::nf2ffAccumulators() const { return nf2ff_ ? nf2ff_->exportAcc() : std::vector<double>{}; }

Results Solver::finish() {
    Results r;
    r.run = state_;
    r.backend = backend_;
    r.dt = f_->dt();
    r.cells = f_->grid().cellCount();
    r.memoryBytes = memoryBytes();
    r.seconds = wallSeconds_;
    r.threads = pool_->size();
    r.warnings = warnings_;
    r.diagnostics = diags_;
    r.mesh = report_;
    if (state_.terminatedBy == "maxSteps")
        r.warnings.push_back("stopped at maxSteps before the energy fell to the target: results are unreliable");
    r.hasPort = p_.hasPort;
    const double z0 = p_.port.resistance;
    const double peak = pulse_.spectrumPeak();
    auto portAt = [&](const std::vector<double>& fs, PortResult& out) {
        portSpectrum(fs, out.V, out.I);
        out.f = fs;
        out.z0 = z0;
        out.zin.resize(fs.size());
        out.s11.resize(fs.size());
        out.pAcc.resize(fs.size());
        out.pInc.resize(fs.size());
        out.sourceDb.resize(fs.size());
        for (std::size_t k = 0; k < fs.size(); ++k) {
            out.zin[k] = out.V[k] / out.I[k];
            out.s11[k] = (out.zin[k] - z0) / (out.zin[k] + z0);
            out.pAcc[k] = 0.5 * std::real(out.V[k] * std::conj(out.I[k]));
            out.pInc[k] = std::norm(out.V[k] + z0 * out.I[k]) / (8.0 * z0);
            out.sourceDb[k] = 20.0 * std::log10(std::max(std::abs(pulse_.spectrum(fs[k])) / peak, 1e-300));
        }
    };
    if (p_.hasPort) {
        std::vector<double> fs(p_.portFrequencies);
        for (int k = 0; k < p_.portFrequencies; ++k) fs[k] = p_.fMin + (p_.fMax - p_.fMin) * k / (p_.portFrequencies - 1);
        portAt(fs, r.port);
    }
    if (nf2ff_) {
        const auto& ffs = nf2ff_->frequencies();
        PortResult pf;
        if (p_.hasPort) portAt(ffs, pf);
        const double dth = p_.farField.thetaStep * PI / 180.0, dph = p_.farField.phiStep * PI / 180.0;
        std::vector<double> th, ph;
        for (int i = 0; i * dth <= PI + 1e-9; ++i) th.push_back(std::min(i * dth, PI));
        for (int j = 0; j * dph < 2.0 * PI - 1e-9; ++j) ph.push_back(j * dph);
        for (std::size_t k = 0; k < ffs.size(); ++k) {
            FarFieldResult fr;
            fr.f = ffs[k];
            fr.grid = nf2ff_->farField(static_cast<int>(k), th, ph, *pool_);
            fr.pRad = nf2ff_->radiatedPower(static_cast<int>(k), p_.farField.quadTheta, p_.farField.quadPhi, *pool_);
            fr.pRadBox = nf2ff_->poyntingPower(static_cast<int>(k));
            const auto it = std::max_element(fr.grid.U.begin(), fr.grid.U.end());
            const std::size_t im = static_cast<std::size_t>(it - fr.grid.U.begin());
            fr.uMax = *it;
            fr.beamTheta = th[im / ph.size()];
            fr.beamPhi = ph[im % ph.size()];
            fr.directivity = 4.0 * PI * fr.uMax / fr.pRad;
            fr.sourceDb = 20.0 * std::log10(std::max(std::abs(pulse_.spectrum(fr.f)) / peak, 1e-300));
            if (p_.hasPort) {
                fr.zin = pf.zin[k];
                fr.s11 = pf.s11[k];
                fr.pAcc = pf.pAcc[k];
                fr.pInc = pf.pInc[k];
                fr.gain = 4.0 * PI * fr.uMax / fr.pAcc;
                fr.realizedGain = 4.0 * PI * fr.uMax / fr.pInc;
                fr.efficiency = fr.pRad / fr.pAcc;
            }
            if (fr.sourceDb < -40.0)
                r.warnings.push_back("far field at " + std::to_string(fr.f / 1e9) + " GHz: excitation spectrum below -40 dB; result unreliable");
            r.farField.push_back(std::move(fr));
        }
    }
    return r;
}

std::string Results::toJson(bool includePatterns) const {
    using nlohmann::json;
    auto cplx = [](const std::vector<std::complex<double>>& v, bool re) {
        std::vector<double> o(v.size());
        for (std::size_t i = 0; i < v.size(); ++i) o[i] = re ? v[i].real() : v[i].imag();
        return o;
    };
    json j;
    j["ok"] = true;
    j["run"] = {{"steps", run.step},        {"maxSteps", run.maxSteps},  {"time", run.time},
                {"dt", dt},                 {"finalEnergyDb", run.energyDb}, {"targetDb", run.targetDb},
                {"terminatedBy", run.terminatedBy}, {"cells", cells},   {"memoryBytes", memoryBytes},
                {"seconds", seconds},       {"threads", threads},       {"backend", backend},
                {"mcellsPerSec", seconds > 0 ? static_cast<double>(cells) * run.step / seconds / 1e6 : 0.0}};
    if (hasPort)
        j["port"] = {{"z0", port.z0},
                     {"frequencies", port.f},
                     {"zinRe", cplx(port.zin, true)},
                     {"zinIm", cplx(port.zin, false)},
                     {"s11Re", cplx(port.s11, true)},
                     {"s11Im", cplx(port.s11, false)},
                     {"pAcc", port.pAcc},
                     {"pInc", port.pInc},
                     {"sourceDb", port.sourceDb}};
    j["farField"] = json::array();
    for (const auto& f : farField) {
        json ff = {{"frequency", f.f},
                   {"pRad", f.pRad},
                   {"pRadPoynting", f.pRadBox},
                   {"uMax", f.uMax},
                   {"directivity", f.directivity},
                   {"directivityDbi", 10.0 * std::log10(f.directivity)},
                   {"beamThetaDeg", f.beamTheta * 180.0 / PI},
                   {"beamPhiDeg", f.beamPhi * 180.0 / PI},
                   {"sourceDb", f.sourceDb}};
        if (hasPort) {
            ff["zinRe"] = f.zin.real();
            ff["zinIm"] = f.zin.imag();
            ff["s11Db"] = 20.0 * std::log10(std::abs(f.s11));
            ff["pAcc"] = f.pAcc;
            ff["pInc"] = f.pInc;
            ff["gainDbi"] = 10.0 * std::log10(f.gain);
            ff["realizedGainDbi"] = 10.0 * std::log10(f.realizedGain);
            ff["efficiency"] = f.efficiency;
        }
        if (includePatterns) {
            std::vector<double> thd(f.grid.theta.size()), phd(f.grid.phi.size()), d(f.grid.U.size());
            for (std::size_t i = 0; i < thd.size(); ++i) thd[i] = f.grid.theta[i] * 180.0 / PI;
            for (std::size_t i = 0; i < phd.size(); ++i) phd[i] = f.grid.phi[i] * 180.0 / PI;
            for (std::size_t i = 0; i < d.size(); ++i) d[i] = 4.0 * PI * f.grid.U[i] / f.pRad;
            ff["thetaDeg"] = thd;
            ff["phiDeg"] = phd;
            ff["directivityPattern"] = d; // linear, theta-major
            ff["eThetaRe"] = cplx(f.grid.eTheta, true);
            ff["eThetaIm"] = cplx(f.grid.eTheta, false);
            ff["ePhiRe"] = cplx(f.grid.ePhi, true);
            ff["ePhiIm"] = cplx(f.grid.ePhi, false);
        }
        j["farField"].push_back(ff);
    }
    j["warnings"] = warnings;
    j["mesh"] = json::parse(meshReportJson(mesh, diagnostics));
    return j.dump();
}

std::string meshReportJson(const MeshReport& m, const std::vector<Diagnostic>& d) {
    using nlohmann::json;
    json objs = json::array();
    for (const auto& o : m.objects)
        objs.push_back({{"name", o.name}, {"kind", o.kind}, {"material", o.material}, {"conductor", o.conductor}, {"pecEdges", o.pecEdges},
                        {"lossyEdges", o.lossyEdges}, {"cells", o.cells}, {"snapDistance", o.snapDistance}});
    json ov = json::array();
    for (const auto& o : m.overlaps) ov.push_back({{"a", o.a}, {"b", o.b}, {"cells", o.cells}});
    json diags = json::array();
    for (const auto& x : d) diags.push_back({{"code", x.code}, {"severity", x.severity}, {"message", x.message}});
    json j = {{"objects", objs}, {"overlaps", ov}, {"pecEdges", m.pecEdgesTotal}, {"minCell", m.minCell}, {"maxCell", m.maxCell}, {"diagnostics", diags}};
    j["dcConnected"] = m.dcConnected < 0 ? json(nullptr) : json(m.dcConnected == 1);
    if (m.cutFaces > 0) j["conformal"] = {{"cutFaces", m.cutFaces}, {"cappedFaces", m.cappedFaces}, {"eigenvalue", m.stabilityEigenvalue}};
    return j.dump();
}

} // namespace antsim

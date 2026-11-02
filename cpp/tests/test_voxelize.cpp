#include "doctest.h"

#include "antsim/constants.hpp"
#include "antsim/solver.hpp"
#include "antsim/voxelize.hpp"

#include <cmath>
#include <cstring>
#include <map>

using namespace antsim;

namespace {

struct Mesh {
    std::vector<float> pos;
    std::vector<std::uint32_t> idx;
};

// Axis-aligned box as 12 outward-oriented triangles.
Mesh boxMesh(std::array<double, 3> lo, std::array<double, 3> hi, bool flip = false) {
    Mesh m;
    for (int i = 0; i < 8; ++i) {
        m.pos.push_back(static_cast<float>((i & 1) ? hi[0] : lo[0]));
        m.pos.push_back(static_cast<float>((i & 2) ? hi[1] : lo[1]));
        m.pos.push_back(static_cast<float>((i & 4) ? hi[2] : lo[2]));
    }
    const std::uint32_t f[12][3] = {{0, 2, 1}, {1, 2, 3}, {4, 5, 6}, {5, 7, 6}, {0, 1, 4}, {1, 5, 4},
                                    {2, 6, 3}, {3, 6, 7}, {0, 4, 2}, {2, 4, 6}, {1, 3, 5}, {3, 7, 5}};
    for (const auto& t : f) {
        m.idx.push_back(t[0]);
        m.idx.push_back(flip ? t[2] : t[1]);
        m.idx.push_back(flip ? t[1] : t[2]);
    }
    return m;
}

// Unit-subdivided icosphere of radius r centred at c.
Mesh sphereMesh(double r, std::array<double, 3> c, int subdiv) {
    const double t = (1.0 + std::sqrt(5.0)) / 2.0;
    std::vector<std::array<double, 3>> v = {{-1, t, 0}, {1, t, 0}, {-1, -t, 0}, {1, -t, 0}, {0, -1, t}, {0, 1, t},
                                            {0, -1, -t}, {0, 1, -t}, {t, 0, -1}, {t, 0, 1}, {-t, 0, -1}, {-t, 0, 1}};
    std::vector<std::array<std::uint32_t, 3>> f = {{0, 11, 5}, {0, 5, 1}, {0, 1, 7}, {0, 7, 10}, {0, 10, 11}, {1, 5, 9}, {5, 11, 4},
                                                   {11, 10, 2}, {10, 7, 6}, {7, 1, 8}, {3, 9, 4}, {3, 4, 2}, {3, 2, 6}, {3, 6, 8},
                                                   {3, 8, 9}, {4, 9, 5}, {2, 4, 11}, {6, 2, 10}, {8, 6, 7}, {9, 8, 1}};
    for (auto& p : v) {
        const double l = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        for (auto& x : p) x /= l;
    }
    for (int s = 0; s < subdiv; ++s) {
        std::map<std::pair<std::uint32_t, std::uint32_t>, std::uint32_t> mid;
        auto midpoint = [&](std::uint32_t a, std::uint32_t b) {
            const auto key = std::make_pair(std::min(a, b), std::max(a, b));
            auto it = mid.find(key);
            if (it != mid.end()) return it->second;
            std::array<double, 3> p{};
            for (int k = 0; k < 3; ++k) p[k] = v[a][k] + v[b][k];
            const double l = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
            for (auto& x : p) x /= l;
            v.push_back(p);
            return mid[key] = static_cast<std::uint32_t>(v.size() - 1);
        };
        std::vector<std::array<std::uint32_t, 3>> nf;
        for (const auto& tri : f) {
            const auto a = midpoint(tri[0], tri[1]), b = midpoint(tri[1], tri[2]), cc = midpoint(tri[2], tri[0]);
            nf.push_back({tri[0], a, cc});
            nf.push_back({tri[1], b, a});
            nf.push_back({tri[2], cc, b});
            nf.push_back({a, b, cc});
        }
        f = nf;
    }
    Mesh m;
    for (const auto& p : v)
        for (int k = 0; k < 3; ++k) m.pos.push_back(static_cast<float>(c[k] + r * p[k]));
    for (const auto& tri : f)
        for (auto i : tri) m.idx.push_back(i);
    return m;
}

// Flat disc (triangle fan) of radius r in the plane z = z0.
Mesh discMesh(double r, double z0, int segments) {
    Mesh m;
    m.pos = {0, 0, static_cast<float>(z0)};
    for (int s = 0; s < segments; ++s) {
        const double a = 2 * PI * s / segments;
        m.pos.push_back(static_cast<float>(r * std::cos(a)));
        m.pos.push_back(static_cast<float>(r * std::sin(a)));
        m.pos.push_back(static_cast<float>(z0));
    }
    for (int s = 0; s < segments; ++s) {
        m.idx.push_back(0);
        m.idx.push_back(1 + s);
        m.idx.push_back(1 + (s + 1) % segments);
    }
    return m;
}

Problem emptyProblem(int n, double cell, double origin) {
    Problem p;
    p.unit = 1e-3;
    p.grid = RectGrid::uniform(n, n, n, cell, cell, cell, origin, origin, origin);
    p.boundaries.fill(Boundary::Pec);
    p.fMin = 1e9;
    p.fMax = 2e9;
    return p;
}

ObjectSpec meshObject(const Mesh& m, const std::string& material, ObjectSpec::Kind kind = ObjectSpec::Kind::Mesh) {
    ObjectSpec o;
    o.kind = kind;
    o.material = material;
    o.positions = m.pos;
    o.indices = m.idx;
    return o;
}

ObjectSpec boxObject(std::array<double, 3> lo, std::array<double, 3> hi) {
    ObjectSpec o;
    o.min = lo;
    o.max = hi;
    return o;
}

long long countPec(const YeeFields& f) {
    long long n = 0;
    for (int c = 0; c < 3; ++c)
        for (auto m : f.M(c)) n += m == EdgeMaterialTable::kPec;
    return n;
}

bool sameMaterials(const YeeFields& a, const YeeFields& b) {
    for (int c = 0; c < 3; ++c)
        if (std::memcmp(a.M(c).data(), b.M(c).data(), a.M(c).size() * sizeof(std::uint16_t))) return false;
    return true;
}

} // namespace

TEST_CASE("ray caster: shared edges counted once, inside-out meshes handled") {
    const Mesh b = boxMesh({0, 0, 0}, {2, 2, 2});
    for (bool flip : {false, true}) {
        const Mesh mm = flip ? boxMesh({0, 0, 0}, {2, 2, 2}, true) : b;
        const TriMesh tm = TriMesh::fromFloats(mm.pos, mm.idx, 1.0);
        CHECK((tm.signedVolume > 0) == !flip);
        for (int a = 0; a < 3; ++a) {
            AxisRayCaster rc(tm, a);
            std::vector<Interval> iv;
            // Through the face diagonal (shared triangle edge), through the centre, through a corner.
            for (auto uv : {std::array<double, 2>{1.0, 1.0}, std::array<double, 2>{0.5, 1.5}, std::array<double, 2>{0.0, 0.0}}) {
                rc.intervals(uv[0], uv[1], iv);
                double len = 0;
                for (const auto& [lo, hi] : iv) len += hi - lo;
                if (uv[0] == 0.0) CHECK(len <= 2.0 + 1e-12); // on the boundary: either side is acceptable
                else CHECK(len == doctest::Approx(2.0));
            }
            rc.inclusiveIntervals(0.0, 0.0, 1e-9, iv); // corner line: inclusive rule counts it
            REQUIRE(iv.size() == 1);
            CHECK(iv[0].second - iv[0].first == doctest::Approx(2.0));
            rc.intervals(3.0, 1.0, iv);
            CHECK(iv.empty());
        }
    }
}

TEST_CASE("mesh box aligned to the grid rasterizes exactly like the box primitive") {
    Problem a = emptyProblem(20, 1, -10), b = a;
    a.objects.push_back(boxObject({-3, -2, -5}, {4, 2, 6}));
    b.objects.push_back(meshObject(boxMesh({-3, -2, -5}, {4, 2, 6}), "pec"));
    Solver sa(a), sb(b);
    CHECK(countPec(sa.fields()) > 0);
    CHECK(sameMaterials(sa.fields(), sb.fields()));
    CHECK(sb.meshReport().objects[0].pecEdges == countPec(sb.fields()));
}

TEST_CASE("offset mesh box follows the 50 % coverage rule") {
    Problem p = emptyProblem(10, 1, 0);
    p.objects.push_back(meshObject(boxMesh({2.3, 2.3, 2.3}, {7.7, 7.7, 7.7}), "pec"));
    Solver s(p);
    const auto& f = s.fields();
    CHECK(f.mx[f.idx(2, 3, 3)] == EdgeMaterialTable::kPec); // [2,3]: 70 % inside
    CHECK(f.mx[f.idx(7, 3, 3)] == EdgeMaterialTable::kPec); // [7,8]: 70 % inside
    CHECK(f.mx[f.idx(1, 3, 3)] != EdgeMaterialTable::kPec); // outside
    CHECK(f.mx[f.idx(3, 2, 3)] != EdgeMaterialTable::kPec); // line y = 2 is outside the box (2 < 2.3)
    CHECK(f.my[f.idx(3, 2, 3)] == EdgeMaterialTable::kPec); // y edge [2,3] at x=3: 70 % inside
}

TEST_CASE("mesh sphere dielectric volume converges with the grid") {
    const double R = 6.0;
    double prevErr = 1;
    for (int n : {16, 32}) {
        const double cell = 16.0 / n;
        Problem p = emptyProblem(n, cell, -8);
        p.materials.push_back({"sub", 4.0, 0.0});
        p.objects.push_back(meshObject(sphereMesh(R, {0.1, -0.2, 0.05}, 4), "sub"));
        Solver s(p);
        const double vol = s.meshReport().objects[0].cells * cell * cell * cell;
        const double err = std::abs(vol / (4.0 / 3.0 * PI * R * R * R) - 1.0);
        MESSAGE("sphere n=" << n << " volume error " << 100 * err << " %");
        CHECK(err < prevErr);
        prevErr = err;
    }
    CHECK(prevErr < 0.03);
}

TEST_CASE("rectangular sheet mesh equals the zero-thickness box sheet; disc footprint stays inside its circle") {
    Problem a = emptyProblem(20, 1, -10), b = a;
    a.objects.push_back(boxObject({-6, -4, 2}, {5, 3, 2}));
    Mesh rect;
    rect.pos = {-6, -4, 2, 5, -4, 2, 5, 3, 2, -6, 3, 2};
    rect.idx = {0, 1, 2, 0, 2, 3};
    ObjectSpec sh = meshObject(rect, "pec", ObjectSpec::Kind::Sheet);
    sh.axis = 2;
    sh.coord = 2;
    b.objects.push_back(sh);
    Solver sa(a), sb(b);
    CHECK(sameMaterials(sa.fields(), sb.fields()));

    Problem c = emptyProblem(20, 1, -10);
    ObjectSpec disc = meshObject(discMesh(7.0, 0.0, 256), "pec", ObjectSpec::Kind::Sheet);
    disc.axis = 2;
    disc.coord = 0.0;
    c.objects.push_back(disc);
    Solver sc(c);
    const auto& f = sc.fields();
    const RectGrid& g = f.grid();
    long long bad = 0, good = 0;
    for (int i = 0; i < f.nx(); ++i)
        for (int j = 0; j <= f.ny(); ++j) {
            if (f.mx[f.idx(i, j, 10)] != EdgeMaterialTable::kPec) continue;
            ++good;
            for (double x : {g.x[i], g.x[i + 1]})
                if (std::hypot(x, g.y[j]) > 7.0e-3 + 1e-9) ++bad;
        }
    CHECK(good > 100);
    CHECK(bad == 0);
    CHECK(sc.meshReport().objects[0].snapDistance == doctest::Approx(0.0));
}

TEST_CASE("overlapping dielectrics at equal priority are reported as errors") {
    Problem p = emptyProblem(20, 1, -10);
    p.materials.push_back({"a", 2.0, 0.0});
    p.materials.push_back({"b", 3.0, 0.0});
    p.objects.push_back(meshObject(boxMesh({-5, -5, -5}, {2, 5, 5}), "a"));
    p.objects.push_back(meshObject(boxMesh({0, -5, -5}, {5, 5, 5}), "b"));
    {
        Solver s(p);
        REQUIRE(s.meshReport().overlaps.size() == 1);
        CHECK(s.meshReport().overlaps[0].cells == 2 * 10 * 10);
        CHECK(std::any_of(s.diagnostics().begin(), s.diagnostics().end(), [](const Diagnostic& d) { return d.code == "DIELECTRIC_OVERLAP" && d.severity == "error"; }));
    }
    p.objects[1].priority = 1; // explicit priority resolves the ambiguity
    Solver s(p);
    CHECK(s.meshReport().overlaps.empty());
}

TEST_CASE("DC path between port terminals is detected") {
    auto dipole = [](bool bridged) {
        Problem p = emptyProblem(24, 1, -12);
        p.objects.push_back(boxObject({0, 0, -8}, {0, 0, 0}));
        p.objects.push_back(boxObject({0, 0, 1}, {0, 0, 9}));
        if (bridged) {
            p.objects.push_back(boxObject({0, 0, -8}, {3, 0, -8}));
            p.objects.push_back(boxObject({3, 0, -8}, {3, 0, 9}));
            p.objects.push_back(boxObject({0, 0, 9}, {3, 0, 9}));
        }
        p.hasPort = true;
        p.port.start = {0, 0, 0};
        p.port.stop = {0, 0, 1};
        p.port.axis = 2;
        return p;
    };
    Solver open(dipole(false)), loop(dipole(true));
    CHECK(open.meshReport().dcConnected == 0);
    CHECK(loop.meshReport().dcConnected == 1);
    CHECK(std::any_of(loop.diagnostics().begin(), loop.diagnostics().end(), [](const Diagnostic& d) { return d.code == "PORT_DC_PATH"; }));
    // A port that touches no conductor is an error.
    Problem floating = dipole(false);
    floating.port.start = {5, 5, 0};
    floating.port.stop = {5, 5, 1};
    Solver fl(floating);
    CHECK(std::any_of(fl.diagnostics().begin(), fl.diagnostics().end(), [](const Diagnostic& d) { return d.code == "PORT_FLOATING" && d.severity == "error"; }));
}

#include "antsim/problem.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstring>
#include <stdexcept>

namespace antsim {

using json = nlohmann::json;

namespace {

[[noreturn]] void fail(const std::string& field, const std::string& what) {
    throw std::invalid_argument("problem." + field + ": " + what);
}

std::array<double, 3> vec3(const json& j, const std::string& field) {
    if (!j.is_array() || j.size() != 3) fail(field, "expected [x, y, z]");
    return {j[0].get<double>(), j[1].get<double>(), j[2].get<double>()};
}

int axisOf(const json& j, const std::string& field) {
    if (j.is_number_integer()) {
        const int a = j.get<int>();
        if (a >= 0 && a <= 2) return a;
    } else if (j.is_string()) {
        const auto s = j.get<std::string>();
        if (s == "x") return 0;
        if (s == "y") return 1;
        if (s == "z") return 2;
    }
    fail(field, "expected 0/1/2 or \"x\"/\"y\"/\"z\"");
}

Boundary boundaryOf(const json& j, const std::string& field) {
    const auto s = j.get<std::string>();
    if (s == "cpml" || s == "pml") return Boundary::Cpml;
    if (s == "pec") return Boundary::Pec;
    if (s == "pmc") return Boundary::Pmc;
    fail(field, "unknown boundary '" + s + "' (cpml, pec, pmc)");
}

template <class T>
T get(const json& j, const char* key, T fallback) {
    return j.contains(key) ? j.at(key).get<T>() : fallback;
}

std::vector<std::uint8_t> base64Decode(const std::string& in, const std::string& field) {
    static const std::string tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<std::uint8_t> out;
    out.reserve(in.size() * 3 / 4);
    unsigned acc = 0;
    int bits = 0;
    for (char c : in) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        const auto pos = tbl.find(c);
        if (pos == std::string::npos) fail(field, "invalid base64 data");
        acc = (acc << 6) | static_cast<unsigned>(pos);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return out;
}

/// Numeric array given either as a JSON array or as base64 of little-endian values.
template <class T>
std::vector<T> numberArray(const json& j, const std::string& field) {
    if (j.is_array()) return j.get<std::vector<T>>();
    if (!j.is_string()) fail(field, "expected an array or a base64 string");
    const auto bytes = base64Decode(j.get<std::string>(), field);
    if (bytes.size() % sizeof(T)) fail(field, "base64 length is not a multiple of the element size");
    std::vector<T> v(bytes.size() / sizeof(T));
    std::memcpy(v.data(), bytes.data(), bytes.size());
    return v;
}

} // namespace

Problem parseProblem(const std::string& text) {
    json j;
    try {
        j = json::parse(text);
    } catch (const json::parse_error& e) {
        throw std::invalid_argument(std::string("problem: invalid JSON: ") + e.what());
    }
    try {
        Problem p;
        p.unit = get(j, "unit", 1e-3);
        if (!(p.unit > 0)) fail("unit", "must be positive");

        if (!j.contains("grid")) fail("grid", "missing");
        const auto& g = j.at("grid");
        if (g.contains("uniform")) {
            const auto& u = g.at("uniform");
            const auto lo = vec3(u.at("min"), "grid.uniform.min"), hi = vec3(u.at("max"), "grid.uniform.max");
            std::array<double, 3> cell{};
            if (u.at("cell").is_number()) cell.fill(u.at("cell").get<double>());
            else cell = vec3(u.at("cell"), "grid.uniform.cell");
            std::array<int, 3> n{};
            for (int a = 0; a < 3; ++a) {
                if (!(hi[a] > lo[a]) || !(cell[a] > 0)) fail("grid.uniform", "needs max > min and cell > 0");
                n[a] = static_cast<int>(std::lround((hi[a] - lo[a]) / cell[a]));
                if (std::abs(n[a] * cell[a] - (hi[a] - lo[a])) > 1e-9 * (hi[a] - lo[a]))
                    fail("grid.uniform", "extent must be a whole number of cells on every axis");
            }
            p.grid = RectGrid::uniform(n[0], n[1], n[2], cell[0], cell[1], cell[2], lo[0], lo[1], lo[2]);
        } else {
            p.grid.x = g.at("x").get<std::vector<double>>();
            p.grid.y = g.at("y").get<std::vector<double>>();
            p.grid.z = g.at("z").get<std::vector<double>>();
        }
        p.grid.validate();

        if (j.contains("boundaries")) {
            const auto& b = j.at("boundaries");
            if (b.is_string()) p.boundaries.fill(boundaryOf(b, "boundaries"));
            else {
                if (!b.is_array() || b.size() != 6) fail("boundaries", "expected 6 entries (xmin xmax ymin ymax zmin zmax)");
                for (int i = 0; i < 6; ++i) p.boundaries[i] = boundaryOf(b[i], "boundaries");
            }
        }
        if (j.contains("pml")) {
            const auto& m = j.at("pml");
            p.pml.cells = get(m, "cells", p.pml.cells);
            p.pml.order = get(m, "order", p.pml.order);
            p.pml.sigmaFactor = get(m, "sigmaFactor", p.pml.sigmaFactor);
            p.pml.alphaMax = get(m, "alphaMax", p.pml.alphaMax);
            if (p.pml.cells < 4 || p.pml.cells > 32) fail("pml.cells", "must be 4..32");
        }

        for (const auto& m : get(j, "materials", json::array())) {
            MaterialSpec ms;
            ms.name = m.at("name").get<std::string>();
            if (ms.name == "pec" || ms.name == "vacuum") fail("materials", "'" + ms.name + "' is reserved");
            const auto type = get<std::string>(m, "type", "dielectric");
            if (type == "metal") {
                ms.metal = true;
                ms.conductivity = m.at("conductivity").get<double>();
                if (!(ms.conductivity > 0)) fail("materials." + ms.name + ".conductivity", "must be positive (use \"pec\" for a perfect conductor)");
            } else if (type == "dielectric") {
                ms.epsR = get(m, "epsR", 1.0);
                ms.sigma = get(m, "sigma", 0.0);
                if (!(ms.epsR >= 1.0) || !(ms.sigma >= 0.0)) fail("materials." + ms.name, "needs epsR >= 1 and sigma >= 0");
            } else {
                fail("materials." + ms.name + ".type", "unknown '" + type + "' (dielectric, metal)");
            }
            for (const auto& prev : p.materials)
                if (prev.name == ms.name) fail("materials", "duplicate name '" + ms.name + "'");
            p.materials.push_back(ms);
        }

        for (const auto& o : get(j, "objects", json::array())) {
            ObjectSpec os;
            const auto type = o.at("type").get<std::string>();
            os.material = get<std::string>(o, "material", "pec");
            os.name = get<std::string>(o, "name", "");
            os.priority = get(o, "priority", 0);
            if (type == "box") {
                os.kind = ObjectSpec::Kind::Box;
                os.min = vec3(o.at("min"), "objects.box.min");
                os.max = vec3(o.at("max"), "objects.box.max");
                for (int a = 0; a < 3; ++a)
                    if (os.max[a] < os.min[a]) fail("objects.box", "max must be >= min on every axis");
                os.radius = get(o, "radius", 0.0);
                if (!(os.radius >= 0)) fail("objects.box.radius", "must be positive");
            } else if (type == "cylinder") {
                os.kind = ObjectSpec::Kind::Cylinder;
                os.axis = axisOf(o.at("axis"), "objects.cylinder.axis");
                const auto c = o.at("center").get<std::vector<double>>();
                const auto r = o.at("range").get<std::vector<double>>();
                if (c.size() != 2 || r.size() != 2) fail("objects.cylinder", "center and range need 2 values");
                os.center = {c[0], c[1]};
                os.range = {std::min(r[0], r[1]), std::max(r[0], r[1])};
                os.radius = o.at("radius").get<double>();
                if (!(os.radius > 0)) fail("objects.cylinder.radius", "must be positive");
            } else if (type == "mesh" || type == "sheet") {
                os.kind = type == "mesh" ? ObjectSpec::Kind::Mesh : ObjectSpec::Kind::Sheet;
                os.positions = numberArray<float>(o.at("positions"), "objects." + type + ".positions");
                os.indices = numberArray<std::uint32_t>(o.at("indices"), "objects." + type + ".indices");
                if (os.positions.size() % 3 || os.indices.size() % 3 || os.indices.empty())
                    fail("objects." + type, "positions and indices must hold whole triangles");
                const std::size_t nv = os.positions.size() / 3;
                for (auto i : os.indices)
                    if (i >= nv) fail("objects." + type + ".indices", "index out of range");
                if (os.kind == ObjectSpec::Kind::Mesh && o.contains("wire")) {
                    const auto& w = o.at("wire");
                    os.wireAxis = axisOf(w.at("axis"), "objects.mesh.wire.axis");
                    os.radius = w.at("radius").get<double>();
                    if (!(os.radius > 0)) fail("objects.mesh.wire.radius", "must be positive");
                }
                if (os.kind == ObjectSpec::Kind::Sheet) {
                    os.axis = axisOf(o.at("axis"), "objects.sheet.axis");
                    os.coord = o.at("coord").get<double>();
                    os.thickness = get(o, "thickness", 0.0);
                    os.sheetFaces = get(o, "currentFaces", 2);
                    if (!(os.thickness >= 0)) fail("objects.sheet.thickness", "must be zero or positive");
                    if (os.sheetFaces != 1 && os.sheetFaces != 2) fail("objects.sheet.currentFaces", "must be 1 or 2");
                }
            } else {
                fail("objects.type", "unknown '" + type + "' (box, cylinder, mesh, sheet)");
            }
            if (os.material != "pec") {
                const MaterialSpec* mat = nullptr;
                for (const auto& m : p.materials)
                    if (m.name == os.material) mat = &m;
                if (!mat) fail("objects.material", "unknown material '" + os.material + "'");
                if (os.kind == ObjectSpec::Kind::Sheet && !mat->metal) fail("objects.sheet.material", "sheets must be conductors (pec or a metal)");
                if (mat->metal && os.kind == ObjectSpec::Kind::Box) {
                    int zero = 0;
                    for (int a = 0; a < 3; ++a) zero += os.max[a] == os.min[a];
                    if (zero >= 2 && !(os.radius > 0))
                        fail("objects.box.radius", "a metal wire needs its radius for the conductor loss");
                }
            }
            p.objects.push_back(os);
        }

        if (j.contains("port")) {
            const auto& q = j.at("port");
            p.hasPort = true;
            p.port.start = vec3(q.at("start"), "port.start");
            p.port.stop = vec3(q.at("stop"), "port.stop");
            p.port.axis = axisOf(q.at("axis"), "port.axis");
            p.port.resistance = get(q, "resistance", 50.0);
            p.port.amplitude = get(q, "amplitude", 1.0);
            if (!(p.port.resistance > 0)) fail("port.resistance", "must be positive");
        }

        if (!j.contains("excitation")) fail("excitation", "missing (fMin, fMax)");
        p.fMin = j.at("excitation").at("fMin").get<double>();
        p.fMax = j.at("excitation").at("fMax").get<double>();
        if (!(p.fMin > 0 && p.fMax > p.fMin)) fail("excitation", "needs 0 < fMin < fMax");
        p.conformal = get(j, "conformal", false);
        p.metalLossFrequency = get(j, "metalLossFrequency", 0.0);
        if (!(p.metalLossFrequency >= 0)) fail("metalLossFrequency", "must be zero (band centre) or positive");
        p.portFrequencies = get(j, "portFrequencies", p.portFrequencies);
        if (p.portFrequencies < 2 || p.portFrequencies > 100000) fail("portFrequencies", "must be 2..100000");

        if (j.contains("farField")) {
            const auto& f = j.at("farField");
            p.farField.frequencies = get(f, "frequencies", std::vector<double>{});
            p.farField.marginCells = get(f, "marginCells", p.farField.marginCells);
            p.farField.thetaStep = get(f, "thetaStep", p.farField.thetaStep);
            p.farField.phiStep = get(f, "phiStep", p.farField.phiStep);
            p.farField.quadTheta = get(f, "quadTheta", p.farField.quadTheta);
            p.farField.quadPhi = get(f, "quadPhi", p.farField.quadPhi);
            if (p.farField.frequencies.size() > 8) fail("farField.frequencies", "at most 8");
            for (double fr : p.farField.frequencies)
                if (!(fr > 0)) fail("farField.frequencies", "must be positive");
            if (!(p.farField.thetaStep > 0 && p.farField.thetaStep <= 30 && p.farField.phiStep > 0 && p.farField.phiStep <= 30))
                fail("farField", "angular steps must be in (0, 30] degrees");
            if (p.farField.quadTheta < 8 || p.farField.quadPhi < 8) fail("farField", "quadrature needs at least 8 points per angle");
        }

        if (j.contains("termination")) {
            const auto& t = j.at("termination");
            p.energyEndDb = get(t, "energyDb", p.energyEndDb);
            p.maxSteps = get(t, "maxSteps", p.maxSteps);
            if (!(p.energyEndDb < 0)) fail("termination.energyDb", "must be negative");
            if (p.maxSteps < 1) fail("termination.maxSteps", "must be positive");
        }
        p.courant = get(j, "courant", p.courant);
        p.threads = get(j, "threads", p.threads);
        return p;
    } catch (const json::exception& e) {
        throw std::invalid_argument(std::string("problem: ") + e.what());
    }
}

} // namespace antsim

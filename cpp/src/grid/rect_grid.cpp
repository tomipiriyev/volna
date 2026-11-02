#include "antsim/grid.hpp"
#include "antsim/constants.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace antsim {

int RectGrid::cells(int axis) const { return static_cast<int>(nodes(axis).size()) - 1; }

const std::vector<double>& RectGrid::nodes(int axis) const {
    switch (axis) {
        case 0: return x;
        case 1: return y;
        case 2: return z;
        default: throw std::invalid_argument("axis must be 0, 1 or 2");
    }
}

double RectGrid::minSpacing(int axis) const {
    const auto& n = nodes(axis);
    double m = std::numeric_limits<double>::infinity();
    for (std::size_t i = 1; i < n.size(); ++i) m = std::min(m, n[i] - n[i - 1]);
    return m;
}

void RectGrid::validate() const {
    static const char* names[] = {"x", "y", "z"};
    for (int a = 0; a < 3; ++a) {
        const auto& n = nodes(a);
        if (n.size() < 2)
            throw std::invalid_argument(std::string("grid axis ") + names[a] + " needs at least 2 nodes");
        for (std::size_t i = 1; i < n.size(); ++i) {
            if (!(n[i] > n[i - 1]) || !std::isfinite(n[i]))
                throw std::invalid_argument(std::string("grid axis ") + names[a] +
                                            " must be finite and strictly increasing");
        }
    }
}

RectGrid RectGrid::uniform(int nx, int ny, int nz, double dx, double dy, double dz, double x0, double y0,
                           double z0) {
    if (nx < 1 || ny < 1 || nz < 1) throw std::invalid_argument("uniform grid needs >= 1 cell per axis");
    RectGrid g;
    auto fill = [](std::vector<double>& v, int n, double d, double o) {
        v.resize(n + 1);
        for (int i = 0; i <= n; ++i) v[i] = o + d * i;
    };
    fill(g.x, nx, dx, x0);
    fill(g.y, ny, dy, y0);
    fill(g.z, nz, dz, z0);
    g.validate();
    return g;
}

double cflTimestep(const RectGrid& grid, double courant) {
    if (!(courant > 0.0) || courant > 1.0)
        throw std::invalid_argument("Courant number must satisfy 0 < S <= 1");
    grid.validate();
    double s = 0.0;
    for (int a = 0; a < 3; ++a) {
        const double d = grid.minSpacing(a);
        s += 1.0 / (d * d);
    }
    return courant / (C0 * std::sqrt(s));
}

} // namespace antsim

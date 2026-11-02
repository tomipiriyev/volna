#pragma once

#include <vector>

namespace antsim {

// Rectilinear (tensor-product) grid. Node coordinates in meters, strictly
// increasing, at least 2 nodes per axis. Cell i spans [x[i], x[i+1]].
struct RectGrid {
    std::vector<double> x, y, z;

    int cells(int axis) const;
    int nx() const { return cells(0); }
    int ny() const { return cells(1); }
    int nz() const { return cells(2); }
    const std::vector<double>& nodes(int axis) const;
    double minSpacing(int axis) const;
    long long cellCount() const { return 1LL * nx() * ny() * nz(); }

    // Throws std::invalid_argument when the grid is malformed.
    void validate() const;

    static RectGrid uniform(int nx, int ny, int nz, double dx, double dy, double dz,
                            double x0 = 0.0, double y0 = 0.0, double z0 = 0.0);
};

// CFL-limited timestep for vacuum (the fastest medium in the model):
//   dt = S / (c0 * sqrt(1/dx_min^2 + 1/dy_min^2 + 1/dz_min^2)),  0 < S <= 1.
double cflTimestep(const RectGrid& grid, double courant);

} // namespace antsim

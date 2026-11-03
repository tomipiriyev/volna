#pragma once

#include <array>
#include <cstdint>
#include <utility>
#include <vector>

namespace antsim {

// Triangle mesh in metres.
struct TriMesh {
    std::vector<double> p;          // xyz per vertex
    std::vector<std::uint32_t> idx; // three per triangle
    std::array<double, 3> lo{}, hi{};
    double signedVolume = 0;        // < 0 for inside-out meshes

    static TriMesh fromFloats(const std::vector<float>& pos, const std::vector<std::uint32_t>& idx, double unit);
    std::size_t triangles() const { return idx.size() / 3; }
};

using Interval = std::pair<double, double>;

// Inside intervals of a closed mesh along lines parallel to `axis`, at
// transverse coordinates (u, v) on the axes p = (axis+1)%3, q = (axis+2)%3.
// Triangles are binned on the (p, q) plane. A shared triangle edge belongs to
// exactly one triangle (top-left rule), and intervals follow the winding
// number, so nested and touching shells are handled.
class AxisRayCaster {
public:
    AxisRayCaster(const TriMesh& m, int axis);
    /// Sorted, merged inside intervals along the axis at (u, v).
    void intervals(double u, double v, std::vector<Interval>& out) const;
    /// Union of the intervals of four rays offset by +-eps on both transverse axes:
    /// a line lying on the surface counts as inside (inclusive rule).
    void inclusiveIntervals(double u, double v, double eps, std::vector<Interval>& out) const;
    /// Outward unit normal of the surface where the ray at (u, v) crosses nearest to `t`
    /// along the axis; false if the ray hits nothing.
    bool normalAt(double u, double v, double t, double n[3]) const;
    int axis() const { return a_; }

private:
    const TriMesh& m_;
    int a_, p_, q_;
    double u0_ = 0, v0_ = 0, du_ = 1, dv_ = 1;
    int nu_ = 1, nv_ = 1;
    std::vector<std::uint32_t> binStart_, binTris_; // CSR bins
    double sign_ = 1;                               // -1 for inside-out meshes
    double areaEps_ = 0;
};

// Inclusive point-in-footprint test for a sheet: triangles projected along `axis`.
class Footprint {
public:
    Footprint(const TriMesh& m, int axis);
    bool contains(double u, double v, double tol) const;

private:
    const TriMesh& m_;
    int p_, q_;
    double u0_ = 0, v0_ = 0, du_ = 1, dv_ = 1;
    int nu_ = 1, nv_ = 1;
    std::vector<std::uint32_t> binStart_, binTris_;
};

/// Union of sorted interval lists.
void mergeIntervals(std::vector<Interval>& v);

/// Covered length of [a, b] by sorted, merged intervals.
double coveredLength(const std::vector<Interval>& v, double a, double b);

} // namespace antsim

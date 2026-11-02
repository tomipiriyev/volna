#pragma once

#include "antsim/grid.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace antsim {

// Solver input. Coordinates are in drawing units; `unit` converts them to
// metres. Primitive geometry only (Stage 2); Stage 3 adds voxelized meshes.
enum class Boundary { Cpml, Pec, Pmc };

struct PmlParams {
    int cells = 8;
    double order = 3.0;       // polynomial grading m
    double sigmaFactor = 1.0; // sigma_max = factor * 0.8 (m + 1) / (eta0 * delta)
    double alphaMax = 0.0;    // CFS alpha at the inner interface (S/m), graded linearly to 0
};

struct MaterialSpec {
    std::string name;
    double epsR = 1.0;
    double sigma = 0.0; // S/m
    // A metal is a conductor with finite conductivity. Its objects are voxelized
    // like PEC; their surface edges carry the skin-effect surface resistance
    // (docs/physics.md, "Conductor loss"). epsR and sigma do not apply.
    bool metal = false;
    double conductivity = 0.0; // S/m, metals only
};

// Geometry objects. "pec" is the reserved perfect-conductor material; a metal
// material (finite conductivity) is voxelized the same way.
//  Box       axis-aligned; zero extent along one axis is a sheet, along two a wire
//  Cylinder  axis-aligned
//  Mesh      closed triangle mesh (voxelized: PEC edges by >= 50 % coverage,
//            dielectric cells by centre)
//  Sheet     zero-thickness conductor on the grid plane `axis` = `coord`, with the
//            footprint given by triangles projected onto that plane
// For metal loss, a wire box gives its physical `radius` (its edges carry the
// wire's resistance per length), a mesh that is a round wire its `wireAxis` and
// `radius` (as cylinders, it is calibrated to the round wire's resistance), and a
// sheet its `thickness` (0: thick compared with the skin depth) and `sheetFaces`,
// the faces its current flows on.
struct ObjectSpec {
    enum class Kind { Box, Cylinder, Mesh, Sheet } kind = Kind::Box;
    std::string material = "pec";
    std::string name;
    int priority = 0;
    std::array<double, 3> min{}, max{}; // box
    int axis = 2;                        // cylinder axis, or sheet normal
    std::array<double, 2> center{};      // cylinder centre on the other two axes (ascending order)
    double radius = 0;                   // cylinder radius, or a metal wire box's radius
    std::array<double, 2> range{};       // cylinder extent along its axis
    double coord = 0;                    // sheet plane coordinate
    int wireAxis = -1;                   // mesh: a round metal wire along this axis (with `radius`)
    double thickness = 0;                // metal sheet thickness (drawing units)
    int sheetFaces = 2;                  // metal sheet: 2 = current on both faces, 1 = on one face
    std::vector<float> positions;        // mesh/sheet vertices (drawing units)
    std::vector<std::uint32_t> indices;  // mesh/sheet triangles
};

// Lumped resistive voltage source. The port edges are all `axis`-directed
// Yee edges inside the box [start, stop]. `start` is on the reference side,
// `stop` on the signal side along `axis`.
struct PortSpec {
    std::array<double, 3> start{}, stop{};
    int axis = 2;
    double resistance = 50.0;
    double amplitude = 1.0; // source EMF, V
};

struct FarFieldSpec {
    std::vector<double> frequencies; // Hz
    int marginCells = 4;             // box distance from the PML interface (cells)
    double thetaStep = 2.0, phiStep = 2.0; // display grid, degrees
    int quadTheta = 48, quadPhi = 96;      // Gauss-Legendre (cos theta) x uniform phi, for P_rad
};

struct Problem {
    double unit = 1e-3;
    RectGrid grid; // in drawing units on input; converted to metres by the solver
    std::array<Boundary, 6> boundaries{Boundary::Cpml, Boundary::Cpml, Boundary::Cpml,
                                       Boundary::Cpml, Boundary::Cpml, Boundary::Cpml};
    PmlParams pml;
    std::vector<MaterialSpec> materials;
    std::vector<ObjectSpec> objects;
    bool hasPort = false;
    PortSpec port;
    double fMin = 0, fMax = 0; // excitation band (Hz); Gaussian spectrum -20 dB at the edges
    double metalLossFrequency = 0; // Hz at which metal surface resistance is evaluated; 0 = sqrt(fMin fMax)
    int portFrequencies = 401;
    FarFieldSpec farField;
    double energyEndDb = -60.0; // -50 dB truncates band-edge spectra by ~1-2 % (validation report)
    long long maxSteps = 200000;
    double courant = 0.99;
    int threads = 0; // 0 = all available
};

// Parses the JSON problem format (docs/problem-format.md). Throws
// std::invalid_argument with a message naming the offending field.
Problem parseProblem(const std::string& json);

} // namespace antsim

#pragma once

namespace antsim {

// Skin-effect quantities for good conductors (docs/physics.md, "Conductor loss").
// sigma in S/m, f in Hz, lengths in metres.

/// Skin depth delta = 1 / sqrt(pi f mu0 sigma).
double skinDepth(double sigma, double f);

/// Surface resistance of a conductor thick compared with delta: R_s = sqrt(pi f mu0 / sigma).
double surfaceResistance(double sigma, double f);

/// Resistance per square seen by the total current of a sheet of thickness t
/// (0: thick). faces = 2: current split equally between both faces,
/// Re[(gamma / 2 sigma) coth(gamma t / 2)] -> R_s / 2; faces = 1: current on one
/// face, Re[(gamma / sigma) coth(gamma t)] -> R_s; both -> 1 / (sigma t) for t << delta.
double sheetResistance(double sigma, double f, double t, int faces);

/// Resistance per length of a round wire of radius a,
/// Re[gamma I0(gamma a) / (2 pi a sigma I1(gamma a))], gamma = (1 + j) / delta:
/// R_s / (2 pi a) for a >> delta, 1 / (pi a^2 sigma) for a << delta.
double wireResistance(double sigma, double f, double a);

} // namespace antsim

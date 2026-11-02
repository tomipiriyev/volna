#pragma once

namespace antsim {

// SI constants (CODATA 2018). MU0 is the measured value, not 4*pi*1e-7.
inline constexpr double C0 = 299792458.0;            // m/s
inline constexpr double MU0 = 1.25663706212e-6;      // H/m
inline constexpr double EPS0 = 1.0 / (MU0 * C0 * C0); // F/m
inline constexpr double ETA0 = MU0 * C0;             // ohm
inline constexpr double PI = 3.14159265358979323846;

} // namespace antsim

#include "antsim/metal.hpp"
#include "antsim/constants.hpp"

#include <cmath>
#include <complex>

namespace antsim {

namespace {

std::complex<double> coth(std::complex<double> z) {
    if (z.real() > 20) return 1.0;
    const auto e = std::exp(-2.0 * z);
    return (1.0 + e) / (1.0 - e);
}

} // namespace

double skinDepth(double sigma, double f) { return 1.0 / std::sqrt(PI * f * MU0 * sigma); }

double surfaceResistance(double sigma, double f) { return std::sqrt(PI * f * MU0 / sigma); }

double sheetResistance(double sigma, double f, double t, int faces) {
    const double rs = surfaceResistance(sigma, f);
    if (!(t > 0)) return faces == 2 ? 0.5 * rs : rs;
    const double d = skinDepth(sigma, f);
    const std::complex<double> g(1.0 / d, 1.0 / d);
    return (faces == 2 ? g / (2.0 * sigma) * coth(g * t / 2.0) : g / sigma * coth(g * t)).real();
}

double wireResistance(double sigma, double f, double a) {
    // I0(x) / I1(x) by power series up to a = 10 delta, asymptotic expansion above
    // (third term 3 / (8 x^2); the next one is below 2e-4 there).
    const double d = skinDepth(sigma, f);
    const std::complex<double> x(a / d, a / d), g(1.0 / d, 1.0 / d);
    std::complex<double> ratio;
    if (a / d > 10) {
        ratio = 1.0 + 1.0 / (2.0 * x) + 3.0 / (8.0 * x * x);
    } else {
        const auto q = x * x / 4.0;
        std::complex<double> i0 = 0, i1 = 0, t0 = 1, t1 = 1;
        for (int k = 0; k < 80; ++k) {
            i0 += t0;
            i1 += t1;
            t0 *= q / static_cast<double>((k + 1) * (k + 1));
            t1 *= q / static_cast<double>((k + 1) * (k + 2));
        }
        ratio = i0 / (x / 2.0 * i1);
    }
    return (g / (2.0 * PI * a * sigma) * ratio).real();
}

} // namespace antsim

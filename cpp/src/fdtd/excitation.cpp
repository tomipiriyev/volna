#include "antsim/excitation.hpp"
#include "antsim/constants.hpp"

#include <cmath>
#include <stdexcept>

namespace antsim {

GaussianPulse GaussianPulse::forBand(double fMin, double fMax) {
    if (!(fMin > 0 && fMax > fMin)) throw std::invalid_argument("excitation band needs 0 < fMin < fMax");
    GaussianPulse g;
    g.f0 = 0.5 * (fMin + fMax);
    g.fc = 0.5 * (fMax - fMin);
    // |G| ~ exp(-(pi tau (f - f0))^2): 0.1 (-20 dB) at f - f0 = fc.
    g.tau = std::sqrt(std::log(10.0)) / (PI * g.fc);
    g.t0 = g.tau * std::sqrt(std::log(1e6));
    return g;
}

double GaussianPulse::operator()(double t) const {
    const double u = t - t0;
    return std::exp(-(u / tau) * (u / tau)) * std::sin(2.0 * PI * f0 * u);
}

std::complex<double> GaussianPulse::spectrum(double f) const {
    // FT of exp(-t^2/tau^2) is tau sqrt(pi) exp(-(pi f tau)^2); the sine carrier
    // shifts it to +-f0 with factor 1/(2j); the delay t0 adds exp(-j 2 pi f t0).
    const double a = tau * std::sqrt(PI) / 2.0;
    const double gp = std::exp(-std::pow(PI * tau * (f - f0), 2));
    const double gm = std::exp(-std::pow(PI * tau * (f + f0), 2));
    const std::complex<double> delay = std::polar(1.0, -2.0 * PI * f * t0);
    return delay * std::complex<double>(0.0, -a * (gp - gm));
}

double GaussianPulse::spectrumPeak() const { return std::abs(spectrum(f0)); }

} // namespace antsim

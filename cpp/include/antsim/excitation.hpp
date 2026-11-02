#pragma once

#include <complex>

namespace antsim {

// Gaussian-modulated sine g(t) = exp(-((t - t0)/tau)^2) sin(2 pi f0 (t - t0)).
// The sine (not cosine) carrier makes g odd about t0, so it has no DC content.
// tau is set so the amplitude spectrum is 20 dB below its peak at f0 +- fc;
// t0 = 3.717 tau puts the envelope at 1e-6 at t = 0.
struct GaussianPulse {
    double f0 = 0, fc = 0, tau = 0, t0 = 0;

    static GaussianPulse forBand(double fMin, double fMax);
    double operator()(double t) const;
    /// Analytic Fourier transform G(f) = integral g(t) exp(-j 2 pi f t) dt.
    std::complex<double> spectrum(double f) const;
    /// Peak of |G| over all frequencies (at ~f0).
    double spectrumPeak() const;
    /// Time after which the pulse is negligible (envelope < 1e-6).
    double endTime() const { return 2.0 * t0; }
};

} // namespace antsim

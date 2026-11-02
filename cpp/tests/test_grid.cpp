#include "doctest.h"

#include "antsim/constants.hpp"
#include "antsim/grid.hpp"

#include <cmath>
#include <stdexcept>

using namespace antsim;

TEST_CASE("uniform grid geometry") {
    const auto g = RectGrid::uniform(10, 20, 30, 1e-3, 2e-3, 0.5e-3, -5e-3);
    CHECK(g.nx() == 10);
    CHECK(g.ny() == 20);
    CHECK(g.nz() == 30);
    CHECK(g.cellCount() == 6000);
    CHECK(g.x.front() == doctest::Approx(-5e-3));
    CHECK(g.x.back() == doctest::Approx(5e-3));
    CHECK(g.minSpacing(1) == doctest::Approx(2e-3));
}

TEST_CASE("CFL timestep matches the closed form") {
    const double d = 1e-3;
    const auto g = RectGrid::uniform(4, 4, 4, d, d, d);
    CHECK(cflTimestep(g, 1.0) == doctest::Approx(d / (C0 * std::sqrt(3.0))).epsilon(1e-12));
    CHECK(cflTimestep(g, 0.5) == doctest::Approx(0.5 * d / (C0 * std::sqrt(3.0))).epsilon(1e-12));

    // Rectilinear: the smallest spacing on each axis limits the step.
    RectGrid r = g;
    r.y = {0.0, 1e-3, 1.25e-3, 2.25e-3};
    const double s = 1.0 / (d * d) + 1.0 / (0.25e-3 * 0.25e-3) + 1.0 / (d * d);
    CHECK(cflTimestep(r, 0.99) == doctest::Approx(0.99 / (C0 * std::sqrt(s))).epsilon(1e-12));
}

TEST_CASE("invalid grids and Courant numbers are rejected") {
    const auto g = RectGrid::uniform(2, 2, 2, 1e-3, 1e-3, 1e-3);
    CHECK_THROWS_AS(cflTimestep(g, 1.01), std::invalid_argument);
    CHECK_THROWS_AS(cflTimestep(g, 0.0), std::invalid_argument);
    RectGrid bad = g;
    bad.z = {0.0, 1e-3, 1e-3};
    CHECK_THROWS_AS(bad.validate(), std::invalid_argument);
    bad.z = {0.0};
    CHECK_THROWS_AS(bad.validate(), std::invalid_argument);
}

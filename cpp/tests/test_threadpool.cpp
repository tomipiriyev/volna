#include "doctest.h"

#include "antsim/threadpool.hpp"

#include <atomic>
#include <stdexcept>
#include <vector>

using namespace antsim;

TEST_CASE("static ranges partition the interval exactly") {
    for (int n = 1; n <= 8; ++n) {
        int expected = 3;
        for (int t = 0; t < n; ++t) {
            const auto [lo, hi] = ThreadPool::range(3, 20, t, n);
            CHECK(lo == expected);
            CHECK(hi >= lo);
            expected = hi;
        }
        CHECK(expected == 20);
    }
}

TEST_CASE("pool runs every thread exactly once per call") {
    const int n = maxThreads();
    ThreadPool pool(n);
    std::vector<int> hits(n, 0);
    for (int rep = 0; rep < 100; ++rep)
        pool.run([&](int tid, int nt) {
            CHECK(nt == n);
            hits[tid] += 1;
        });
    for (int h : hits) CHECK(h == 100);
}

TEST_CASE("exceptions from any thread propagate to the caller") {
    const int n = maxThreads();
    ThreadPool pool(n);
    CHECK_THROWS_AS(pool.run([&](int tid, int nt) {
        if (tid == nt - 1) throw std::runtime_error("boom");
    }),
                    std::runtime_error);
    // The pool remains usable afterwards.
    std::atomic<int> count{0};
    pool.run([&](int, int) { count.fetch_add(1); });
    CHECK(count.load() == n);
}

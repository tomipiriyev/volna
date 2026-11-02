#pragma once

#include <atomic>
#include <exception>
#include <functional>
#include <thread>
#include <utility>
#include <vector>

namespace antsim {

// Upper bound on worker threads. Must match the wasm pthread pool size
// (Math.min(navigator.hardwareConcurrency, 8)); creating more threads than
// the pool holds would block inside a worker.
inline constexpr int kMaxThreads = 8;

// Number of threads available to the solver: 1 in single-thread builds.
int maxThreads();

// Fixed-size fork/join pool. run(fn) executes fn(tid, n) on all n threads
// (the caller is thread 0) and returns when every thread has finished.
// Work partitioning is static, so results are deterministic for a given n.
class ThreadPool {
public:
    explicit ThreadPool(int nThreads);
    ~ThreadPool();
    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    int size() const { return n_; }
    void run(const std::function<void(int, int)>& fn);

    // Contiguous block [begin, end) of the range assigned to thread tid.
    static std::pair<int, int> range(int begin, int end, int tid, int n);

private:
    void workerLoop(int tid);

    int n_;
    std::vector<std::thread> workers_;
    const std::function<void(int, int)>* job_ = nullptr;
    std::atomic<unsigned> generation_{0};
    std::atomic<int> remaining_{0};
    std::atomic<bool> stop_{false};
    std::vector<std::exception_ptr> errors_;
};

} // namespace antsim

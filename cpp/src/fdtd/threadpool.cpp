#include "antsim/threadpool.hpp"

#include <algorithm>
#include <stdexcept>

namespace antsim {

int maxThreads() {
#if ANTSIM_THREADS
    const unsigned hw = std::thread::hardware_concurrency();
    return std::clamp(static_cast<int>(hw == 0 ? 1 : hw), 1, kMaxThreads);
#else
    return 1;
#endif
}

ThreadPool::ThreadPool(int nThreads) : n_(nThreads) {
    if (n_ < 1) throw std::invalid_argument("ThreadPool needs at least 1 thread");
#if !ANTSIM_THREADS
    if (n_ != 1) throw std::invalid_argument("this build has no thread support; use 1 thread");
#endif
    if (n_ > kMaxThreads) throw std::invalid_argument("ThreadPool size exceeds kMaxThreads");
    errors_.resize(n_);
    for (int t = 1; t < n_; ++t) workers_.emplace_back([this, t] { workerLoop(t); });
}

ThreadPool::~ThreadPool() {
    stop_.store(true);
    generation_.fetch_add(1);
    generation_.notify_all();
    for (auto& w : workers_) w.join();
}

std::pair<int, int> ThreadPool::range(int begin, int end, int tid, int n) {
    const int len = std::max(0, end - begin);
    const int base = len / n, rem = len % n;
    const int lo = begin + tid * base + std::min(tid, rem);
    return {lo, lo + base + (tid < rem ? 1 : 0)};
}

void ThreadPool::workerLoop(int tid) {
    unsigned seen = 0;
    for (;;) {
        generation_.wait(seen);
        seen = generation_.load();
        if (stop_.load()) return;
        try {
            (*job_)(tid, n_);
        } catch (...) {
            errors_[tid] = std::current_exception();
        }
        if (remaining_.fetch_sub(1) == 1) remaining_.notify_one();
    }
}

void ThreadPool::run(const std::function<void(int, int)>& fn) {
    if (n_ == 1) {
        fn(0, 1);
        return;
    }
    job_ = &fn;
    remaining_.store(n_ - 1);
    generation_.fetch_add(1);
    generation_.notify_all();
    try {
        fn(0, n_);
    } catch (...) {
        errors_[0] = std::current_exception();
    }
    for (int r = remaining_.load(); r != 0; r = remaining_.load()) remaining_.wait(r);
    job_ = nullptr;
    for (auto& e : errors_) {
        if (e) {
            auto err = e;
            std::fill(errors_.begin(), errors_.end(), nullptr);
            std::rethrow_exception(err);
        }
    }
}

} // namespace antsim

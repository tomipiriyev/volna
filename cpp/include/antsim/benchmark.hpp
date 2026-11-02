#pragma once

namespace antsim {

struct BenchmarkResult {
    int n = 0;          // cube edge in cells
    int steps = 0;
    int threads = 0;
    double seconds = 0;
    double mcellsPerSec = 0; // million cell-updates (E and H) per second
    double nsPerCellStep = 0;
    double energyStart = 0, energyEnd = 0;
};

// Lossless PEC cube (n^3 cells, 1 mm spacing) seeded with the TM110 mode,
// stepped `steps` times. Measures solver throughput on this machine; the
// energy ratio is a sanity check (it should stay close to 1).
BenchmarkResult runCavityBenchmark(int n, int steps, int threads);

// Seeds the TM110 cavity mode Ez = sin(pi x/a) sin(pi y/b) (uniform in z).
class YeeFields;
void seedTm110(YeeFields& f);

} // namespace antsim

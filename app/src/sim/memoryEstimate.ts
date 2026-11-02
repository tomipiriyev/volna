// Memory the solver will allocate for a problem, computed before allocating.
// Mirrors antsim::estimateMemory (cpp/src/api/solver.cpp); a test checks that
// both give identical numbers for the validation cases.

export interface ProblemJson {
  grid: { x: number[]; y: number[]; z: number[] } | { uniform: { min: number[]; max: number[]; cell: number | number[] } };
  boundaries?: string | string[];
  pml?: { cells?: number };
  port?: unknown;
  farField?: { frequencies?: number[]; marginCells?: number };
  termination?: { maxSteps?: number };
}

export interface MemoryEstimate {
  cells: number;
  fields: number;
  materials: number;
  cpml: number;
  nf2ff: number;
  portSeries: number;
  rasterTemp: number;
  total: number;
}

function cellCounts(g: ProblemJson['grid']): [number, number, number] {
  if ('uniform' in g) {
    const cell = Array.isArray(g.uniform.cell) ? g.uniform.cell : [g.uniform.cell, g.uniform.cell, g.uniform.cell];
    return [0, 1, 2].map((a) => Math.round((g.uniform.max[a] - g.uniform.min[a]) / cell[a])) as [number, number, number];
  }
  return [g.x.length - 1, g.y.length - 1, g.z.length - 1];
}

export function estimateMemory(p: ProblemJson): MemoryEstimate {
  const n = cellCounts(p.grid);
  const nodes = (n[0] + 1) * (n[1] + 1) * (n[2] + 1);
  const cells = n[0] * n[1] * n[2];
  const bc = typeof p.boundaries === 'string' || p.boundaries === undefined ? Array(6).fill(p.boundaries ?? 'cpml') : p.boundaries;
  const pml = p.pml?.cells ?? 8;
  const isPml = (b: string) => b === 'cpml' || b === 'pml';
  let cpml = 0;
  for (let face = 0; face < 6; face++) {
    if (!isPml(bc[face])) continue;
    const a = Math.floor(face / 2), pa = (a + 1) % 3, qa = (a + 2) % 3;
    cpml += (2 * (pml - 1) + 2 * pml) * (n[pa] + 1) * (n[qa] + 1) * 4;
  }
  let nf2ff = 0;
  const freqs = p.farField?.frequencies ?? [];
  if (freqs.length && bc.every(isPml)) {
    const margin = p.farField?.marginCells ?? 4;
    const box = n.map((v) => v - 2 * (pml + margin));
    let samples = 0;
    for (let a = 0; a < 3; a++) {
      const bp = box[(a + 1) % 3], bq = box[(a + 2) % 3];
      samples += 2 * (bp * (bq + 1) + (bp + 1) * bq);
    }
    nf2ff = samples * (2 * freqs.length * 16 + 8);
  }
  const est = {
    cells,
    fields: nodes * 6 * 4,
    materials: nodes * 3 * 2,
    cpml,
    nf2ff,
    portSeries: p.port ? (p.termination?.maxSteps ?? 200000) * 2 * 8 : 0,
    // Cell material + owner (dielectric rasterization) and the DC-path union-find.
    rasterTemp: cells * 3 + (p.port ? nodes * 4 : 0),
    total: 0,
  };
  est.total = est.fields + est.materials + est.cpml + est.nf2ff + est.portSeries + est.rasterTemp;
  return est;
}

export function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

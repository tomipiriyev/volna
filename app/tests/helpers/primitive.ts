// Primitive-geometry twin of a STEP-built problem: every mesh or sheet object is
// replaced by the box (or zero-thickness box) of its body's bounding box, on the
// same grid. For box-shaped CAD this is the same geometry, so running both
// isolates the CAD path (tessellation, voxelizer, sheet footprint) from the
// physics, and the twin can be run in openEMS, which has no mesh objects.
import type { CadModel, Vec3 } from '../../src/model/types';
import type { SimulationPlan } from '../../src/sim/problemBuilder';

type Obj = { type: string; name: string; material: string; priority?: number; axis?: number; coord?: number; min?: Vec3; max?: Vec3 };

export function primitiveTwin(plan: SimulationPlan, model: CadModel, scale = 1): Record<string, unknown> {
  const objects = (plan.problem.objects as Obj[]).map((o) => {
    if (o.type === 'box') return o;
    const b = model.bodies.find((x) => x.name === o.name);
    if (!b) throw new Error(`no body for object ${o.name}`);
    const min = b.bbox.min.map((v) => v * scale) as Vec3, max = b.bbox.max.map((v) => v * scale) as Vec3;
    if (o.type === 'sheet') min[o.axis!] = max[o.axis!] = o.coord!;
    const out: Obj = { type: 'box', name: o.name, material: o.material, min, max };
    if (o.priority !== undefined) out.priority = o.priority;
    return out;
  });
  return { ...plan.problem, name: `${plan.problem.name as string} (primitive twin)`, objects };
}

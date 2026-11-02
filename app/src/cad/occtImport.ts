// Converts occt-import-js output into the project's CadModel. Shared by the
// CAD worker and Node tests, so it has no DOM or worker dependencies.
import type { Box3, CadBody, CadModel, CadNode, DeclaredUnits, Vec3 } from '../model/types';
import { analyzeBody } from './meshAnalysis';

export const IMPORTER = { id: 'occt-import-js', version: '0.0.23' } as const;

/** Display tessellation: relative chord deviation and ~20 deg angular deviation. */
export const DISPLAY_TESSELLATION = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.35,
} as const;

// Shape of occt-import-js results (from its js-interface.cpp).
export interface OcctMesh {
  name: string;
  color?: number[];
  brep_faces: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
}
export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}
export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

const vec3 = (c: number[] | null | undefined): Vec3 | undefined => (c ? [c[0], c[1], c[2]] : undefined);

export function convertOcctResult(
  result: OcctResult,
  meta: { fileName: string; sha256: string; units: DeclaredUnits },
): CadModel {
  if (!result.success) throw new Error('STEP import failed: the file could not be read or contains no shapes');
  const bodies: CadBody[] = [];

  const walk = (node: OcctNode, path: number[], names: string[]): CadNode => {
    const nodeNames = node.name ? [...names, node.name] : names;
    const bodyIds = node.meshes.map((meshIndex, k) => {
      const m = result.meshes[meshIndex];
      const positions = Float32Array.from(m.attributes.position.array);
      const indices = Uint32Array.from(m.index.array);
      const normals = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : undefined;
      const ranges = m.brep_faces.map((f) => ({ first: f.first, last: f.last, color: vec3(f.color) }));
      const a = analyzeBody(positions, indices, ranges);
      const id = `b:${path.join('.')}:${k}`;
      bodies.push({
        id,
        name: m.name || node.name || `Body ${bodies.length + 1}`,
        path: nodeNames,
        color: vec3(m.color),
        positions,
        normals,
        indices,
        featureEdges: a.featureEdges,
        faces: a.faces,
        bbox: a.bbox,
        topology: a.topology,
        fingerprint: a.fingerprint,
      });
      return id;
    });
    return {
      name: node.name,
      bodyIds,
      children: node.children.map((c, i) => walk(c, [...path, i], nodeNames)),
    };
  };

  const root = walk(result.root, [], []);
  if (bodies.length === 0) throw new Error('STEP import produced no tessellated bodies');
  return {
    importer: { ...IMPORTER },
    fileName: meta.fileName,
    sourceSha256: meta.sha256,
    root,
    bodies,
    bbox: unionBoxes(bodies.map((b) => b.bbox)),
    units: meta.units,
  };
}

export function unionBoxes(boxes: Box3[]): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], b.min[a]);
      max[a] = Math.max(max[a], b.max[a]);
    }
  return { min, max };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

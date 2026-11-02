// Display colors per role. Kept free of three.js so the main bundle can use
// it without loading the renderer. Colors are converted to linear RGB, the
// space three.js shades in.
import type { Role, Vec3 } from '../model/types';

export const ROLE_HEX: Record<Role, string> = {
  radiator: '#e8833a',
  ground: '#8fa3ba',
  passiveConductor: '#d4b13f',
  dielectric: '#3fa36b',
  excluded: '#5b6168',
};

export const ROLE_LABEL: Record<Role, string> = {
  radiator: 'Radiating conductor',
  ground: 'Ground conductor',
  passiveConductor: 'Passive conductor',
  dielectric: 'Dielectric',
  excluded: 'Excluded',
};

export const UNASSIGNED_HEX = '#b9c0c8';

export function srgbHexToLinear(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

export function roleOpacity(role: Role | undefined, xray: boolean): number {
  if (role === 'excluded') return 0.15;
  if (role === 'dielectric') return xray ? 0.25 : 0.55;
  return xray ? 0.35 : 1;
}

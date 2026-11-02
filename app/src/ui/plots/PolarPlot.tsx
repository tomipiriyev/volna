// Polar pattern cut (SVG). Elevation cuts put theta = 0 (+z) at the top with
// psi increasing clockwise (right half: phi0, left half: phi0 + 180);
// azimuth cuts put phi = 0 (+x) on the right, counter-clockwise. In dB the
// radius spans [top - range, top]; values below the range are drawn at the
// centre (display clipping only; exports never see it).
import { forwardRef } from 'react';
import type { Cut } from '../../sim/pattern';
import { niceTicks } from './LinePlot';

export interface PolarSeries {
  label: string;
  cut: Cut;
  cls: string;
}

export interface PolarPlotProps {
  series: PolarSeries[];
  db: boolean;
  rangeDb: number;
  unit: string;
  title: string;
  testId?: string;
}

const S = 300, C = 150, RAD = 112;

export const PolarPlot = forwardRef<SVGSVGElement, PolarPlotProps>(function PolarPlot({ series, db, rangeDb, unit, title, testId }, ref) {
  if (!series.length) return null;
  const kind = series[0].cut.kind;
  const all = series.flatMap((s) => s.cut.values).filter((v) => v > 0);
  const vmax = all.length ? Math.max(...all) : 1;
  const top = db ? Math.ceil((10 * Math.log10(vmax)) / 5) * 5 : vmax;
  const bottom = db ? top - rangeDb : 0;
  const radius = (v: number) => {
    if (db) {
      const d = v > 0 ? 10 * Math.log10(v) : -Infinity;
      return RAD * Math.min(Math.max((d - bottom) / (top - bottom), 0), 1);
    }
    return RAD * Math.min(Math.max(v / top, 0), 1);
  };
  const xy = (angleDeg: number, r: number): [number, number] => {
    const a = (angleDeg * Math.PI) / 180;
    return kind === 'elevation' ? [C + r * Math.sin(a), C - r * Math.cos(a)] : [C + r * Math.cos(a), C - r * Math.sin(a)];
  };
  const rings = db ? niceTicks(bottom, top, rangeDb > 30 ? 4 : 3).filter((t) => t > bottom) : niceTicks(0, top, 4).filter((t) => t > 0);
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30);
  const angleLabel = (a: number) => {
    if (kind === 'azimuth') return `${a}°`;
    const psi = a > 180 ? a - 360 : a;
    return `${Math.abs(psi)}°`;
  };
  return (
    <svg ref={ref} className="plot polar" viewBox={`0 0 ${S} ${S + 16}`} role="img" aria-label={title} data-testid={testId}>
      <text x={C} y={12} textAnchor="middle" className="title">
        {title}
      </text>
      <g transform="translate(0 10)">
        {rings.map((t) => (
          <g key={t}>
            <circle className="grid" cx={C} cy={C} r={db ? (RAD * (t - bottom)) / (top - bottom) : (RAD * t) / top} fill="none" />
            <text x={C + 3} y={C - (db ? (RAD * (t - bottom)) / (top - bottom) : (RAD * t) / top) - 2} className="note">
              {+t.toPrecision(3)}
            </text>
          </g>
        ))}
        <circle className="grid strong-edge" cx={C} cy={C} r={RAD} fill="none" />
        {spokes.map((a) => {
          const [x, y] = xy(a, RAD);
          const [lx, ly] = xy(a, RAD + 12);
          return (
            <g key={a}>
              <line className="grid" x1={C} y1={C} x2={x} y2={y} />
              <text x={lx} y={ly + 3} textAnchor="middle">
                {angleLabel(a)}
              </text>
            </g>
          );
        })}
        {series.map((s) => (
          <polygon key={s.label} className={`${s.cls} area`} points={s.cut.angleDeg.map((a, i) => xy(a, radius(s.cut.values[i])).map((v) => v.toFixed(1)).join(',')).join(' ')} />
        ))}
        <text x={4} y={S - 4} className="note">
          {unit}
          {db && `, ${rangeDb} dB range`}
        </text>
        {series.length > 1 &&
          series.map((s, i) => (
            <g key={`lg${s.label}`}>
              <line className={s.cls} x1={S - 70} x2={S - 58} y1={S - 26 + 11 * i} y2={S - 26 + 11 * i} />
              <text x={S - 54} y={S - 23 + 11 * i}>
                {s.label}
              </text>
            </g>
          ))}
      </g>
    </svg>
  );
});

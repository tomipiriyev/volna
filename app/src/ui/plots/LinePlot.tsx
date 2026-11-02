// Frequency-domain line plot (SVG). Several series share one y axis; vertical
// markers flag far-field frequencies, shaded spans mark unreliable samples,
// and hovering shows the values at the nearest frequency.
import { forwardRef, useState } from 'react';

export interface Series {
  label: string;
  x: number[];
  y: number[];
  cls: string; // CSS class for the stroke colour (trace, trace2, ...)
}

export interface LinePlotProps {
  series: Series[];
  xLabel: string;
  yLabel: string;
  xScale?: number; // divide x for display (1e9 -> GHz)
  yMin?: number;
  yMax?: number;
  markers?: { x: number; active?: boolean }[];
  hlines?: { y: number; label: string }[];
  /** [x0, x1] spans of unreliable samples. */
  shaded?: [number, number][];
  testId?: string;
}

const W = 380, H = 220, L = 42, R = 8, T = 12, B = 30;

export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : String(+v.toPrecision(4)));

export const LinePlot = forwardRef<SVGSVGElement, LinePlotProps>(function LinePlot({ series, xLabel, yLabel, xScale = 1, yMin, yMax, markers = [], hlines = [], shaded = [], testId }, ref) {
  const [hover, setHover] = useState<number | null>(null);
  const xs = series[0]?.x ?? [];
  if (!xs.length) return null;
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const finite = series.flatMap((s) => s.y.filter(Number.isFinite));
  let lo = yMin ?? Math.min(...finite), hi = yMax ?? Math.max(...finite);
  if (!(hi > lo)) (lo -= 1, (hi += 1));
  const xSpan = x1 - x0 || 1; // a single sample still gets an axis
  const px = (x: number) => L + ((x - x0) / xSpan) * (W - L - R);
  const py = (y: number) => T + (1 - (Math.min(Math.max(y, lo), hi) - lo) / (hi - lo)) * (H - T - B);
  const path = (s: Series) => {
    let d = '', pen = false;
    s.x.forEach((x, i) => {
      const y = s.y[i];
      if (!Number.isFinite(y)) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const xv = x0 + ((sx - L) / (W - L - R)) * xSpan;
    let best = 0;
    xs.forEach((x, i) => {
      if (Math.abs(x - xv) < Math.abs(xs[best] - xv)) best = i;
    });
    setHover(sx >= L && sx <= W - R ? best : null);
  };
  const xt = niceTicks(x0 / xScale, (x0 + xSpan) / xScale, 6), yt = niceTicks(lo, hi, 5);
  return (
    <svg ref={ref} className="plot line" viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${yLabel} versus ${xLabel}`} data-testid={testId}>
      {shaded.map(([a, b], i) => (
        <rect key={i} className="shade" x={px(a)} y={T} width={Math.max(px(b) - px(a), 1)} height={H - T - B} />
      ))}
      {yt.map((t) => (
        <g key={`y${t}`}>
          <line className="grid" x1={L} x2={W - R} y1={py(t)} y2={py(t)} />
          <text x={L - 4} y={py(t) + 3} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {xt.map((t) => (
        <g key={`x${t}`}>
          <line className="grid" x1={px(t * xScale)} x2={px(t * xScale)} y1={T} y2={H - B} />
          <text x={px(t * xScale)} y={H - B + 12} textAnchor="middle">
            {fmt(t)}
          </text>
        </g>
      ))}
      {hlines.map((h) => (
        <g key={h.label}>
          <line className="grid strong" x1={L} x2={W - R} y1={py(h.y)} y2={py(h.y)} />
          <text x={W - R - 2} y={py(h.y) - 3} textAnchor="end" className="note">
            {h.label}
          </text>
        </g>
      ))}
      {markers.map((m) => (
        <line key={m.x} className={m.active ? 'marker active' : 'marker'} x1={px(m.x)} x2={px(m.x)} y1={T} y2={H - B} />
      ))}
      {series.map((s) => (
        <path key={s.label} d={path(s)} className={s.cls} />
      ))}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle">
        {xLabel}
      </text>
      <text x={10} y={(T + H - B) / 2} textAnchor="middle" transform={`rotate(-90 10 ${(T + H - B) / 2})`}>
        {yLabel}
      </text>
      {series.length > 1 &&
        series.map((s, i) => (
          <g key={`lg${s.label}`}>
            <line className={s.cls} x1={W - R - 70} x2={W - R - 56} y1={T + 8 + 11 * i} y2={T + 8 + 11 * i} />
            <text x={W - R - 52} y={T + 11 + 11 * i}>
              {s.label}
            </text>
          </g>
        ))}
      {hover !== null && (
        <g data-export="skip" className="hover">
          <line className="marker active" x1={px(xs[hover])} x2={px(xs[hover])} y1={T} y2={H - B} />
          <text x={L + 4} y={T + 9}>
            {fmt(xs[hover] / xScale)} · {series.map((s) => `${series.length > 1 ? `${s.label} ` : ''}${Number.isFinite(s.y[hover]) ? fmt(s.y[hover]) : '—'}`).join(' · ')}
          </text>
        </g>
      )}
    </svg>
  );
});

/**
 * Hand-rolled SVG chart generation — no new dependency, following the same "build SVG by hand"
 * pattern already used by `src/render/svg/document.ts`. Restrained engineering-chart aesthetic:
 * black axes/text on white, one muted accent color for the data series, light gray gridlines, no
 * external fonts/gradients/shadows. Only covers the one memory-vs-size chart the report needs —
 * not a general-purpose charting library.
 */

const ACCENT = '#2563eb';
const GRID_COLOR = '#e5e7eb';
const AXIS_COLOR = '#000000';
const TEXT_COLOR = '#000000';
const FONT = 'system-ui, sans-serif';

const MARGIN = { top: 56, right: 32, bottom: 56, left: 72 };
const GRID_LINE_COUNT = 5;

export interface LineChartPoint {
  x: number;
  y: number;
  label?: string;
}

interface LineChartOptions {
  title: string;
  xLabel: string;
  yLabel: string;
  points: LineChartPoint[];
  width?: number;
  height?: number;
}

/** Round a bound outward to a "nice" number so gridline labels aren't awkward fractions. */
function niceBound(value: number, roundUp: boolean): number {
  if (value === 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(value)));
  const normalized = value / magnitude;
  const niceNormalized = roundUp ? Math.ceil(normalized * 10) / 10 : Math.floor(normalized * 10) / 10;
  return niceNormalized * magnitude;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderLineChart(opts: LineChartOptions): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 400;
  const { points } = opts;

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMinRaw = Math.min(...xs);
  const xMaxRaw = Math.max(...xs);
  const yMinRaw = Math.min(0, ...ys);
  const yMaxRaw = Math.max(...ys);

  const xMin = xMinRaw;
  const xMax = xMaxRaw === xMinRaw ? xMaxRaw + 1 : xMaxRaw;
  const yMin = niceBound(yMinRaw, false);
  const yMaxPadded = yMaxRaw + (yMaxRaw - yMin) * 0.1 || 1;
  const yMax = niceBound(yMaxPadded, true) || 1;

  const scaleX = (x: number) => MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const scaleY = (y: number) => MARGIN.top + plotHeight - ((y - yMin) / (yMax - yMin)) * plotHeight;

  const svgParts: string[] = [];
  svgParts.push(
    `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">`,
  );
  svgParts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`);

  // Chart title.
  svgParts.push(
    `<text x="${width / 2}" y="28" text-anchor="middle" font-size="16" font-weight="600" fill="${TEXT_COLOR}">${escapeXml(opts.title)}</text>`,
  );

  // Horizontal gridlines + y-axis value labels.
  for (let i = 0; i <= GRID_LINE_COUNT; i += 1) {
    const value = yMin + ((yMax - yMin) * i) / GRID_LINE_COUNT;
    const y = scaleY(value);
    svgParts.push(
      `<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${width - MARGIN.right}" y2="${y.toFixed(1)}" stroke="${GRID_COLOR}" stroke-width="1" />`,
    );
    svgParts.push(
      `<text x="${MARGIN.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${TEXT_COLOR}">${formatAxisValue(value)}</text>`,
    );
  }

  // X-axis ticks — one per data point (the sweep has few enough points that this stays legible).
  for (const point of points) {
    const x = scaleX(point.x);
    svgParts.push(
      `<line x1="${x.toFixed(1)}" y1="${MARGIN.top}" x2="${x.toFixed(1)}" y2="${height - MARGIN.bottom}" stroke="${GRID_COLOR}" stroke-width="1" />`,
    );
    svgParts.push(
      `<text x="${x.toFixed(1)}" y="${height - MARGIN.bottom + 20}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${formatAxisValue(point.x)}</text>`,
    );
  }

  // Axes.
  svgParts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${height - MARGIN.bottom}" stroke="${AXIS_COLOR}" stroke-width="1.5" />`,
  );
  svgParts.push(
    `<line x1="${MARGIN.left}" y1="${height - MARGIN.bottom}" x2="${width - MARGIN.right}" y2="${height - MARGIN.bottom}" stroke="${AXIS_COLOR}" stroke-width="1.5" />`,
  );

  // Axis titles.
  svgParts.push(
    `<text x="${MARGIN.left + plotWidth / 2}" y="${height - 12}" text-anchor="middle" font-size="12" fill="${TEXT_COLOR}">${escapeXml(opts.xLabel)}</text>`,
  );
  svgParts.push(
    `<text x="16" y="${MARGIN.top + plotHeight / 2}" text-anchor="middle" font-size="12" fill="${TEXT_COLOR}" transform="rotate(-90 16 ${MARGIN.top + plotHeight / 2})">${escapeXml(opts.yLabel)}</text>`,
  );

  // Data series: connected polyline + point markers + per-point value labels.
  const polylinePoints = points.map((p) => `${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`).join(' ');
  svgParts.push(`<polyline points="${polylinePoints}" fill="none" stroke="${ACCENT}" stroke-width="2" />`);
  for (const point of points) {
    const x = scaleX(point.x);
    const y = scaleY(point.y);
    svgParts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${ACCENT}" />`);
    const labelText = point.label ?? formatAxisValue(point.y);
    svgParts.push(
      `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="${TEXT_COLOR}">${escapeXml(labelText)}</text>`,
    );
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}

function formatAxisValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

/**
 * Plots JS heap vs. node count directly from whatever workload results a normal run already
 * produced (2 points for `perf`, 3 for `perf:stress`) — no separate scaling sweep needed.
 */
export function renderMemoryChart(
  workloads: { name: string; nodeCount: number; jsHeapUsedMiB: number }[],
): string {
  return renderLineChart({
    title: 'JS heap vs. diagram size',
    xLabel: 'Node count',
    yLabel: 'JS heap (MiB)',
    points: workloads.map((w) => ({
      x: w.nodeCount,
      y: w.jsHeapUsedMiB,
      label: `${w.jsHeapUsedMiB.toFixed(1)} MiB`,
    })),
  });
}

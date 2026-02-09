import { CIRCLE_CIRCUMFERENCE, SCALES } from './constants';

/**
 * Types
 */
export type SegmentInput = {
  type: 'dash' | 'gap';
  duration: number; // milliseconds
};

export type SegmentLength = {
  type: 'dash' | 'gap';
  length: number; // length in SVG stroke units (integer)
};

export type AnalysisResult = {
  complexity: number; // number of segments
  dashGapRatio: number; // count(dash) / count(gap) (gap treated as 1 when zero)
  avgDashLength: number; // normalized by total (0..1)
  avgGapLength: number; // normalized by total (0..1)
};

/**
 * Simple seeded RNG (mulberry32)
 * Returns a function that produces uniform floats in [0,1)
 */
export function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    // integer math operations deliberately used for deterministic 32-bit behavior
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random HSL color string
 */
export function randomColor(): string {
  return `hsl(${Math.floor(Math.random() * 360)}, 80%, 55%)`;
}

/**
 * Convert a viewport (client) mouse/pointer event to SVG coordinates.
 * Works with MouseEvent, PointerEvent, Touch (use first touch) etc.
 */
export function toSvgPoint(
  svg: SVGSVGElement,
  evt: PointerEvent
): { x: number; y: number } {
  const pt = svg.createSVGPoint();

  // PointerEvent provides clientX/clientY for mouse, touch, and pen inputs.
  pt.x = (evt as PointerEvent).clientX;
  pt.y = (evt as PointerEvent).clientY;

  // matrixTransform can throw if svg has no CTM; assume well-formed SVG in DOM.
  // Using non-null assertion because consumer ensures svg is attached.
  // If needed, callers should wrap in try/catch.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const transformed = pt.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: transformed.x, y: transformed.y };
}

/**
 * Build an SVG stroke-dasharray string from recorded segments.
 *
 * segments: array of recorded segments with raw durations (ms)
 * liveType/liveDuration: an optional currently-active segment (while holding)
 * totalDurationMs: total recorded duration in ms for normalization (must be > 0)
 *
 * Returns a string suitable for `element.setAttribute('stroke-dasharray', str)`
 */
export function buildDashArray(
  segments: SegmentInput[],
  liveType: 'dash' | 'gap' | null,
  liveDuration: number,
  totalDurationMs: number
): string {
  if (totalDurationMs <= 0) return `0 ${CIRCLE_CIRCUMFERENCE}`;

  const scale = CIRCLE_CIRCUMFERENCE / totalDurationMs;
  const all: SegmentInput[] = segments.slice();
  if (liveDuration > 0 && liveType) {
    all.push({ type: liveType, duration: liveDuration });
  }
  if (all.length === 0) return `0 ${CIRCLE_CIRCUMFERENCE}`;

  // Convert durations to SVG lengths, ensuring each is at least 1
  const lens = all.map((s) => Math.max(1, Math.round(s.duration * scale)));
  const out: number[] = [];

  // SVG dasharray expects dash,gap,dash,gap...
  // If the first recorded segment is a gap, we must add an initial `0` dash
  if (all[0].type === 'gap') {
    out.push(0, lens[0]);
    for (let i = 1; i < lens.length; i++) out.push(lens[i]);
  } else {
    for (let i = 0; i < lens.length; i++) out.push(lens[i]);
  }

  return out.join(' ');
}

/**
 * Analyze segments (where each segment already has a 'length' field)
 * and return summary metrics used by the synthesizer.
 */
export function analyzeSegments(
  segments: SegmentLength[],
  totalLength: number
): AnalysisResult {
  const counts = { dash: 0, gap: 0 };
  const sumLengths = { dash: 0, gap: 0 };

  for (const seg of segments) {
    if (seg.type === 'dash') {
      counts.dash++;
      sumLengths.dash += seg.length;
    } else {
      counts.gap++;
      sumLengths.gap += seg.length;
    }
  }

  const avgDash = sumLengths.dash / (counts.dash || 1);
  const avgGap = sumLengths.gap / (counts.gap || 1);

  return {
    complexity: segments.length,
    dashGapRatio: counts.dash / (counts.gap || 1),
    avgDashLength: avgDash / (totalLength || 1),
    avgGapLength: avgGap / (totalLength || 1),
  };
}

/**
 * Choose a scale (array of frequencies) based on analysis.
 */
export function chooseScale(analysis: AnalysisResult): number[] {
  // Simple rule set reused from the original implementation
  if (analysis.complexity <= 4) return SCALES.pentatonic;
  return analysis.dashGapRatio > 1 ? SCALES.major : SCALES.minor;
}

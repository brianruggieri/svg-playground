/**
 * svg-playground/js/humanize.ts
 *
 * Humanization helpers for small microtiming and velocity perturbations.
 *
 * These functions are deterministic when passed a seeded RNG (fn => [0,1)).
 * They are intentionally small and tunable; the UI or per-circle state can provide
 * `HumanizeOptions` to control intensity, swing, and groove template usage.
 *
 * Exports:
 *  - HumanizeOptions
 *  - defaultHumanizeOptions
 *  - humanizeSegmentTiming
 *  - humanizeVelocity
 *  - simpleGrooveFromSegments
 */

/* ----------------------------- Types ------------------------------------- */

export type HumanizeOptions = {
  // Maximum absolute jitter applied to start times, in milliseconds.
  // Jitter is triangularly distributed in [-timingJitterMs, +timingJitterMs].
  timingJitterMs?: number;

  // Fractional velocity jitter (e.g. 0.12 means +/-12%).
  velocityJitter?: number;

  // Swing amount 0..1. Simple alternating long-short applied to subdivisions.
  swing?: number;

  // Global scale for all perturbations 0..1.
  intensity?: number;

  // Whether to apply a simple groove template instead of raw jitter.
  useGrooveTemplate?: boolean;

  // Groove template: array of offsets (ms) for a target subdivision.
  // e.g. [0, -10, +10, 0] shifts timing of subdivision events
  grooveTemplateMs?: number[];
};

/* ------------------------- Default options ------------------------------- */

export const defaultHumanizeOptions: Required<
  Pick<
    HumanizeOptions,
    | 'timingJitterMs'
    | 'velocityJitter'
    | 'swing'
    | 'intensity'
    | 'useGrooveTemplate'
    | 'grooveTemplateMs'
  >
> = {
  timingJitterMs: 8,
  velocityJitter: 0.08,
  swing: 0.0,
  intensity: 1.0,
  useGrooveTemplate: false,
  grooveTemplateMs: [],
};

/* -------------------------- Helper utilities ----------------------------- */

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

// Triangular distribution in [-1..+1], by summing two uniforms and subtracting 1.
function triDist(rng: () => number): number {
  return rng() + rng() - 1;
}

// Convert a ms value to seconds
function msToSec(ms: number): number {
  return ms / 1000;
}

/* ------------------------ Groove helper ---------------------------------- */

/**
 * Given an array of segments (durations in ms) produce a simple groove template:
 * This tries to align subdivisions and generate small offsets for each subdivision.
 *
 * This is intentionally lightweight: it returns an array of offsets (ms) whose
 * length equals `targetSubdivisionCount` and can be applied repeatedly.
 */
export function simpleGrooveFromSegments(
  segmentsMs: number[],
  targetSubdivisionCount: number
): number[] {
  if (targetSubdivisionCount <= 0) return [];
  if (!segmentsMs || segmentsMs.length === 0)
    return new Array(targetSubdivisionCount).fill(0);

  // Compute average segment length and use that to create a subtle alternating groove
  const avg =
    segmentsMs.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) /
      segmentsMs.length || 0;

  // Basic alternating swing pattern scaled by average (very small).
  const maxOffset = Math.min(20, Math.max(2, avg * 0.02)); // clamp to [2ms..20ms]
  const out: number[] = new Array(targetSubdivisionCount).fill(0);
  for (let i = 0; i < targetSubdivisionCount; i++) {
    // simple alternating long-short: even indices negative, odd positive
    out[i] = (i % 2 === 0 ? -0.4 : 0.4) * maxOffset;
  }
  return out;
}

/* --------------------- Core humanize functions --------------------------- */

/**
 * Humanize a segment's start time and duration.
 *
 * Parameters:
 *  - startTimeSec: strict (grid) start time in seconds
 *  - durationSec: strict (grid) duration in seconds
 *  - segIndex: index of the segment in the rotation (0..N-1)
 *  - beatPos: heuristic beat strength / position: 0 = strongest (downbeat),
 *             larger values -> weaker positions. This is a number in [0..1+] used to scale jitter.
 *  - opts: humanize options (may omit fields; defaults applied)
 *  - rng: random function returning [0,1)
 *
 * Returns:
 *  - startTimeSec: adjusted start time (seconds)
 *  - durationSec: adjusted duration (seconds)
 *
 * Notes:
 *  - This function does not perform scheduling clamps against audioCtx.currentTime;
 *    callers should clamp if necessary.
 */
export function humanizeSegmentTiming(
  startTimeSec: number,
  durationSec: number,
  segIndex: number,
  beatPos: number,
  opts: HumanizeOptions,
  rng: () => number
): { startTimeSec: number; durationSec: number } {
  const cfg = { ...defaultHumanizeOptions, ...opts };
  const intensity = clamp(cfg.intensity ?? 1, 0, 1);

  // Max jitter in seconds, scaled by intensity
  const maxJitterSec = msToSec(cfg.timingJitterMs) * intensity;

  // Stronger beats should jitter less. beatScale in (0.4 .. 1]
  const beatScale = clamp(1 - Math.min(1, beatPos) * 0.6, 0.4, 1);

  // Triangular jitter centered at 0
  let jitterSec = triDist(rng) * maxJitterSec * beatScale;

  // Optionally apply swing: simple alternating subdivision elongation/compression
  if (cfg.swing && cfg.swing > 0) {
    // Apply swing only to segments that are subdivisions (heuristic: every-other)
    if (segIndex % 2 === 1) {
      jitterSec += cfg.swing * 0.5 * durationSec * intensity;
    } else {
      jitterSec -= cfg.swing * 0.5 * durationSec * intensity;
    }
  }

  // Groove template overrides jitter if configured
  if (
    cfg.useGrooveTemplate &&
    cfg.grooveTemplateMs &&
    cfg.grooveTemplateMs.length > 0
  ) {
    const idx = segIndex % cfg.grooveTemplateMs.length;
    jitterSec = msToSec(cfg.grooveTemplateMs[idx]) * intensity;
  }

  // Ensure we don't create negative durations
  const adjStart = startTimeSec + jitterSec;
  const durationJitterFactor = 1 + triDist(rng) * 0.02 * intensity; // small dur variation
  const adjDuration = Math.max(0.005, durationSec * durationJitterFactor);

  return { startTimeSec: adjStart, durationSec: adjDuration };
}

/**
 * Compute velocity multiplier given a base velocity/gain.
 *
 * - base: the base gain multiplier (1.0 = default)
 * - segIndex: segment index for deterministic variation
 * - beatPos: 0 = strong, larger = weaker
 * - opts: humanize options
 * - rng: random function
 *
 * Returns multiplier to multiply the base by (>= 0.01)
 */
export function humanizeVelocity(
  base: number,
  segIndex: number,
  beatPos: number,
  opts: HumanizeOptions,
  rng: () => number
): number {
  const cfg = { ...defaultHumanizeOptions, ...opts };
  const intensity = clamp(cfg.intensity ?? 1, 0, 1);

  // Random jitter in [-velocityJitter, +velocityJitter]
  const jitterRange = cfg.velocityJitter * intensity;
  const jitter = (rng() - 0.5) * 2 * jitterRange;

  // Beat accent: stronger beats slightly louder (downbeats)
  const beatBoost = 1 + (1 - clamp(beatPos, 0, 1)) * 0.08 * intensity;

  // Small pair accent: every 4th event slightly louder
  const pairAccent = segIndex % 4 === 0 ? 1.04 : 1.0;

  const out = Math.max(0.01, base * (1 + jitter) * beatBoost * pairAccent);
  return out;
}

/* ------------------------ Export convenience ----------------------------- */

export default {
  defaultHumanizeOptions,
  humanizeSegmentTiming,
  humanizeVelocity,
  simpleGrooveFromSegments,
};

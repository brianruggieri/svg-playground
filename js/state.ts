/**
 * svg-playground/js/state.ts
 *
 * A small, typed WeakMap-based manager for per-circle runtime state.
 *
 * The original code attached ad-hoc properties to SVG elements (e.g. `circle._loopTimeout`).
 * That pattern is convenient but undermines TypeScript safety. This module centralizes that
 * runtime state in a typed WeakMap and exposes helper functions to read/update/cleanup state
 * for a given `SVGCircleElement`.
 *
 * Usage:
 *  - Call `ensureCircleState(circle, {...})` early (e.g. when creating the circle) to seed
 *    required fields (`pos`, `rng`) or the module will create sensible defaults.
 *  - Use `setX / getX` helpers to read or modify parts of the state.
 *  - Call `deleteState(circle)` to stop/clear timers/oscillators and remove the state entry.
 */

import type { SegmentInput } from './utils';

export type CirclePos = { x: number; y: number };

export type CircleState = {
  // Core, present fields
  pos: CirclePos;
  rng: () => number;

  // Optional runtime handles
  loopTimeout?: number | null;
  segments?: SegmentInput[]; // recorded segments during hold
  holdDuration?: number; // milliseconds
  scheduledUntil?: number | null; // audioContext.currentTime up to which we've scheduled
  scale?: number; // vertical-drag size multiplier (1 = default); bigger = lower pitch
};

/** WeakMap storing the state per circle element. */
const stateMap = new WeakMap<SVGCircleElement, CircleState>();

/** Create or return existing state for a circle. */
export function ensureCircleState(
  circle: SVGCircleElement,
  init?: Partial<CircleState>
): CircleState {
  const st = stateMap.get(circle);
  if (st) {
    // merge provided initial values if present
    if (init) {
      Object.assign(st, init);
    }
    return st;
  }

  const defaultRng = () => Math.random();
  const newState: CircleState = {
    pos: init?.pos ?? { x: 0, y: 0 },
    rng: init?.rng ?? defaultRng,
    loopTimeout: init?.loopTimeout ?? null,
    segments: init?.segments ?? [],
    holdDuration: init?.holdDuration,
    scheduledUntil: init?.scheduledUntil ?? null,
    scale: init?.scale ?? 1,
  };
  stateMap.set(circle, newState);
  return newState;
}

/** Return the state (or undefined) for a circle. */
export function getCircleState(
  circle: SVGCircleElement
): CircleState | undefined {
  return stateMap.get(circle);
}

/** Delete state without cleanup (useful if you are sure nothing needs stopping). */
export function unsetCircleState(circle: SVGCircleElement): void {
  stateMap.delete(circle);
}

/* ----------------------- Pos & RNG helpers ----------------------- */

export function setPos(circle: SVGCircleElement, pos: CirclePos): void {
  const st = ensureCircleState(circle);
  st.pos = pos;
}

export function getPos(circle: SVGCircleElement): CirclePos | undefined {
  return stateMap.get(circle)?.pos;
}

export function setRng(circle: SVGCircleElement, rng: () => number): void {
  const st = ensureCircleState(circle);
  st.rng = rng;
}

export function getRng(circle: SVGCircleElement): (() => number) | undefined {
  return stateMap.get(circle)?.rng;
}

/* ----------------------- Scale (vertical-drag size) ----------------------- */

export function setScale(circle: SVGCircleElement, scale: number): void {
  const st = ensureCircleState(circle);
  st.scale = scale;
}

export function getScale(circle: SVGCircleElement): number {
  return stateMap.get(circle)?.scale ?? 1;
}

/* ----------------------- Segments & Hold ----------------------- */

export function setSegments(
  circle: SVGCircleElement,
  segs: SegmentInput[]
): void {
  const st = ensureCircleState(circle);
  st.segments = segs;
}

export function getSegments(circle: SVGCircleElement): SegmentInput[] {
  return stateMap.get(circle)?.segments ?? [];
}

export function pushSegment(circle: SVGCircleElement, seg: SegmentInput): void {
  const st = ensureCircleState(circle);
  st.segments = st.segments ?? [];
  st.segments.push(seg);
}

export function setHoldDuration(circle: SVGCircleElement, ms: number): void {
  const st = ensureCircleState(circle);
  st.holdDuration = ms;
}

export function getHoldDuration(circle: SVGCircleElement): number | undefined {
  return stateMap.get(circle)?.holdDuration;
}

/* ----------------------- Loop timeout helpers ----------------------- */

export function setLoopTimeout(circle: SVGCircleElement, id: number): void {
  const st = ensureCircleState(circle);
  st.loopTimeout = id;
}

export function getLoopTimeout(
  circle: SVGCircleElement
): number | null | undefined {
  return stateMap.get(circle)?.loopTimeout;
}

export function clearLoopTimeout(circle: SVGCircleElement): void {
  const st = stateMap.get(circle);
  if (!st) return;
  if (typeof st.loopTimeout === 'number') {
    // Defensive: try clearing both timeout and interval (some environments store either)
    try {
      clearTimeout(st.loopTimeout);
    } catch {
      // ignore
    }
    try {
      clearInterval(st.loopTimeout);
    } catch {
      // ignore
    }
    st.loopTimeout = null;
  }
}

/* ----------------------- Scheduling helpers ----------------------- */

export function setScheduledUntil(
  circle: SVGCircleElement,
  t: number | null
): void {
  const st = ensureCircleState(circle);
  st.scheduledUntil = t;
}

export function getScheduledUntil(
  circle: SVGCircleElement
): number | null | undefined {
  return stateMap.get(circle)?.scheduledUntil;
}

/* ----------------------- Full cleanup ----------------------- */

/**
 * Stop the loop scheduler and remove the state entry. Notes already handed to
 * the worklet engine ring out on their own (the lookahead is only ~0.1s).
 * ponytail: add engine.allNotesOff if tails get long.
 */
export function deleteState(circle: SVGCircleElement): void {
  clearLoopTimeout(circle);
  stateMap.delete(circle);
}

/* ----------------------- Utilities ----------------------- */

/** Return the current number of tracked circles (for testing/debugging). */
export function trackedCount(): number {
  // WeakMap doesn't provide a size API; return -1 to indicate unknown in production.
  // If you want an exact count, consider maintaining a parallel Set.
  return -1;
}

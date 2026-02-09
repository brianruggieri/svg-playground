/**
 * svg-playground/js/state.ts
 *
 * A small, typed WeakMap-based manager for per-circle runtime state.
 *
 * The original code attached ad-hoc properties to SVG elements (e.g. `circle._liveAudioNodes`,
 * `circle._loopTimeout`, `circle._activeOscillators`, etc.). That pattern is convenient but
 * undermines TypeScript safety. This module centralizes that runtime state in a typed WeakMap
 * and exposes helper functions to read/update/cleanup state for a given `SVGCircleElement`.
 *
 * Usage:
 *  - Call `ensureCircleState(circle, {...})` early (e.g. when creating the circle) to seed
 *    required fields (`pos`, `rng`) or the module will create sensible defaults.
 *  - Use `setX / getX` helpers to read or modify parts of the state.
 *  - Call `deleteState(circle)` to stop/clear timers/oscillators and remove the state entry.
 */

import type { LiveAudioNodes } from './audio';
import type { SegmentInput } from './utils';

export type CirclePos = { x: number; y: number };

export type ActiveOscillatorRecord = {
  osc: OscillatorNode;
  gain?: GainNode | null; // per-oscillator gain node (if present)
  baseGain?: number; // computed base gain used for this voice (for recalculation)
};

export type CircleState = {
  // Core, present fields
  pos: CirclePos;
  rng: () => number;

  // Optional runtime handles
  liveAudioNodes?: LiveAudioNodes | null;
  loopTimeout?: number | null;
  // Store richer records for active oscillators so we can update per-voice gain in-flight.
  activeOscillators?: ActiveOscillatorRecord[]; // oscillators + optional gain nodes created for scheduled notes
  segments?: SegmentInput[]; // recorded segments during hold
  holdDuration?: number; // milliseconds
  scheduledUntil?: number | null; // audioContext.currentTime up to which we've scheduled
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
    liveAudioNodes: init?.liveAudioNodes ?? null,
    loopTimeout: init?.loopTimeout ?? null,
    // accept provided activeOscillators if present (compatible shape) or default to empty array
    activeOscillators: init?.activeOscillators ?? [],
    segments: init?.segments ?? [],
    holdDuration: init?.holdDuration,
    scheduledUntil: init?.scheduledUntil ?? null,
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

/* ----------------------- Live Audio Nodes ----------------------- */

export function setLiveAudioNodes(
  circle: SVGCircleElement,
  nodes: LiveAudioNodes | null
): void {
  const st = ensureCircleState(circle);
  st.liveAudioNodes = nodes;
}

export function getLiveAudioNodes(
  circle: SVGCircleElement
): LiveAudioNodes | null | undefined {
  return stateMap.get(circle)?.liveAudioNodes;
}

/**
 * Best-effort stop & disconnect of LiveAudioNodes.
 * This does not attempt advanced scheduling/fades — audio modules may provide
 * more graceful fade functions. This helper is defensive and swallows errors.
 */
export function stopAndClearLiveAudioNodes(circle: SVGCircleElement): void {
  const st = stateMap.get(circle);
  const nodes = st?.liveAudioNodes;
  if (!nodes) return;

  try {
    for (const osc of nodes.oscillators) {
      try {
        osc.stop();
      } catch {
        // ignore
      }
      try {
        osc.disconnect();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    nodes.filter.disconnect();
  } catch {
    // ignore
  }
  try {
    nodes.gain.disconnect();
  } catch {
    // ignore
  }
  try {
    nodes.panner.disconnect();
  } catch {
    // ignore
  }

  if (st) st.liveAudioNodes = null;
}

/* ----------------------- Active oscillators ----------------------- */

export function addActiveOscillator(
  circle: SVGCircleElement,
  osc: OscillatorNode,
  gainNode?: GainNode | null,
  baseGain?: number
): void {
  const st = ensureCircleState(circle);
  st.activeOscillators = st.activeOscillators ?? [];
  st.activeOscillators.push({ osc, gain: gainNode ?? null, baseGain });
}

export function getActiveOscillators(
  circle: SVGCircleElement
): ActiveOscillatorRecord[] {
  return stateMap.get(circle)?.activeOscillators ?? [];
}

/** Stop and clear any active oscillators recorded for this circle. */
export function stopAndClearActiveOscillators(circle: SVGCircleElement): void {
  const st = stateMap.get(circle);
  const arr = st?.activeOscillators;
  if (!arr || arr.length === 0) return;

  for (const rec of arr) {
    try {
      // stop oscillator (best-effort)
      rec.osc.stop();
    } catch {
      // ignore
    }
    try {
      // disconnect oscillator -> gain (if present) and gain -> rest
      if (rec.gain) {
        try {
          rec.gain.disconnect();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    try {
      rec.osc.disconnect();
    } catch {
      // ignore
    }
  }
  if (st) st.activeOscillators = [];
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
 * Stop/clear timers, oscillators, audio nodes and remove state entry.
 * This is a safe cleanup routine that attempts to leave no running resources.
 */
export function deleteState(circle: SVGCircleElement): void {
  // clear timeout
  clearLoopTimeout(circle);
  // stop live nodes
  stopAndClearLiveAudioNodes(circle);
  // stop active oscillators
  stopAndClearActiveOscillators(circle);
  // finally remove state entry
  stateMap.delete(circle);
}

/* ----------------------- Utilities ----------------------- */

/** Return the current number of tracked circles (for testing/debugging). */
export function trackedCount(): number {
  // WeakMap doesn't provide a size API; return -1 to indicate unknown in production.
  // If you want an exact count, consider maintaining a parallel Set.
  return -1;
}

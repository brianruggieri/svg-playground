export const CIRCLE_RADIUS = 60;
export const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

// Lookahead window (seconds) for scheduling notes ahead of playback.
// The scheduler should ensure notes are scheduled up to audioCtx.currentTime + LOOP_SCHEDULE_AHEAD_SEC.
export const LOOP_SCHEDULE_AHEAD_SEC = 0.1;

// How frequently (ms) the scheduler task should run to maintain the lookahead window.
// This should be less than LOOP_SCHEDULE_AHEAD_SEC * 1000 to avoid gaps.
export const SCHEDULER_INTERVAL_MS = 50;

// Vertical-drag pitch/size control (drag up = bigger circle + lower pitch).
// One octave of size (a 2x/0.5x scale) per this many pixels of vertical drag.
export const DRAG_PX_PER_OCTAVE = 220;
export const SCALE_MIN = 0.4;
export const SCALE_MAX = 2.4;

export type ScaleName = 'pentatonic' | 'major' | 'minor';

export const SCALES: Record<ScaleName, number[]> = {
  pentatonic: [220, 247, 277, 330, 370],
  major: [220, 247, 277, 294, 330, 370, 415, 440],
  minor: [220, 233, 277, 294, 330, 349, 415, 440],
} as const;

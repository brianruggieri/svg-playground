export const CIRCLE_RADIUS = 60;
export const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

export const LIVE_AUDIO_FADE_SEC = 0.05;
// Lookahead window (seconds) for scheduling notes ahead of playback.
// The scheduler should ensure notes are scheduled up to audioCtx.currentTime + LOOP_SCHEDULE_AHEAD_SEC.
export const LOOP_SCHEDULE_AHEAD_SEC = 0.1;

// How frequently (ms) the scheduler task should run to maintain the lookahead window.
// This should be less than LOOP_SCHEDULE_AHEAD_SEC * 1000 to avoid gaps.
export const SCHEDULER_INTERVAL_MS = 50;

// Short release time (seconds) applied to note gains to avoid clicks when notes stop.
export const NOTE_RELEASE_SEC = 0.06;

// Small slack added to oscillator stop time (seconds) after the release completes to ensure ramps finish.
export const NOTE_STOP_SLACK_SEC = 0.08;

// Minimum allowed note duration (seconds).
// This prevents extremely short scheduled notes (e.g. from very small dash segments)
// from being shorter than envelope/attack times and therefore effectively inaudible.
export const MIN_NOTE_DURATION_SEC = 0.04;

// Minimum absolute attack time (seconds). Attack will be adapted to note duration
// (see audio scheduling code) but should never be smaller than this value.
export const MIN_ATTACK_SEC = 0.008;

// Per-voice gain normalization factor applied before summing multiple harmonic voices.
// Typical usage in the synth is to scale each voice by `1 / Math.sqrt(harmonics)`
// to keep the summed level roughly constant as the number of voices changes.
// This constant provides a small global multiplier for fine tuning overall per-voice level.
export const PER_VOICE_GAIN_MULTIPLIER = 1.0;

export type ScaleName = 'pentatonic' | 'major' | 'minor';

export const SCALES: Record<ScaleName, number[]> = {
  pentatonic: [220, 247, 277, 330, 370],
  major: [220, 247, 277, 294, 330, 370, 415, 440],
  minor: [220, 233, 277, 294, 330, 349, 415, 440],
} as const;

export const CIRCLE_RADIUS = 60;
export const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

export const LIVE_AUDIO_FADE_SEC = 0.05;
export const LOOP_SCHEDULE_AHEAD_SEC = 0.05;

export type ScaleName = "pentatonic" | "major" | "minor";

export const SCALES: Record<ScaleName, number[]> = {
  pentatonic: [220, 247, 277, 330, 370],
  major: [220, 247, 277, 294, 330, 370, 415, 440],
  minor: [220, 233, 277, 294, 330, 349, 415, 440],
} as const;

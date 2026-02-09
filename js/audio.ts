/**
 * svg-playground/js/audio.ts
 *
 * Audio engine for Dash‑Synced Generative Audio Circles
 *
 * Exports:
 * - createAudioContext(): AudioContext
 * - playRichTone(...)
 * - createLiveAudio(...)
 * - fadeAndCleanupLiveAudio(...)
 * - loopCircleAudio(...)
 *
 * This file is written in TypeScript and depends on `./constants` and `./utils`.
 */

import {
  LIVE_AUDIO_FADE_SEC,
  LOOP_SCHEDULE_AHEAD_SEC,
} from "./constants";
import {
  analyzeSegments,
  chooseScale,
  SegmentLength,
} from "./utils";

/* -------------------------------------------------------------------------- */
/* Types and small helpers                                                     */
/* -------------------------------------------------------------------------- */

export type LiveAudioNodes = {
  gain: GainNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  oscillators: (OscillatorNode | AudioBufferSourceNode)[];
};

export interface CircleWithState extends SVGCircleElement {
  // Required runtime fields used by the app
  _pos: { x: number; y: number };
  _rng: () => number;

  // Optional audio/state handles
  _activeOscillators?: OscillatorNode[];
  _liveAudioNodes?: LiveAudioNodes | null;
  _loopTimeout?: number | null;
  _holdDuration?: number; // milliseconds
  _segments?: Array<{ type: string; duration: number }>;
}

/* -------------------------------------------------------------------------- */
/* Audio helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create (or return) an AudioContext. Caller can also supply one.
 */
export function createAudioContext(): AudioContext {
  return new (window.AudioContext || (window as any).webkitAudioContext)();
}

/**
 * Play a short rich tone scheduled at `startTime` for `duration`.
 *
 * - freq: base frequency (Hz)
 * - pan: stereo pan (-1..1)
 * - duration: seconds
 * - yFactor: normalized vertical position (0..1) used to scale gain/filter
 * - startTime: audioCtx.currentTime + offset (seconds)
 * - rng: seeded RNG function (returns 0..1)
 * - circle: the SVG circle instance (used to track active oscillators)
 * - analysis: result from analyzeSegments(...) to influence timbre
 */
export function playRichTone(
  audioCtx: AudioContext,
  freq: number,
  pan: number,
  duration: number,
  yFactor: number,
  startTime: number,
  rng: () => number,
  circle: CircleWithState,
  analysis: ReturnType<typeof analyzeSegments>,
): void {
  // Gain envelope (volume)
  const gain = audioCtx.createGain();
  const baseGain = 0.1 + yFactor * 0.3;
  gain.gain.value = baseGain;

  // Determine harmonic count from complexity
  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  const detunes = Array.from({ length: harmonics }, (_, i) =>
    i * 5 * (rng() > 0.5 ? 1 : -1),
  );

  // Short segments -> sharper attack, long segments -> smoother
  const attackTime = Math.max(0.001, (analysis.avgDashLength || 0) * 0.1);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(baseGain, startTime + attackTime);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  // base cutoff influenced by pan (horizontal) and yFactor (vertical)
  filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan });

  // Connect filter -> gain -> panner -> destination
  filter.connect(gain);
  gain.connect(panner);
  panner.connect(audioCtx.destination);

  // Create harmonic oscillators and schedule them
  detunes.forEach((detune) => {
    const osc = audioCtx.createOscillator();
    // Choose waveform based on average dash length
    osc.type = analysis.avgDashLength > 0.2 ? "sine" : "triangle";
    osc.frequency.value = freq * (1 + detune / 1200);
    osc.connect(filter);
    osc.start(startTime);
    osc.stop(startTime + duration);

    // Track active oscillators on the circle for cleanup
    circle._activeOscillators = circle._activeOscillators || [];
    circle._activeOscillators.push(osc);
  });
}

/**
 * Create live audio nodes that play while the user holds Space.
 * Returns a LiveAudioNodes object that the caller should store on the circle.
 */
export function createLiveAudio(
  audioCtx: AudioContext,
  circle: CircleWithState,
  analysis: ReturnType<typeof analyzeSegments>,
  noteScale: number[],
): LiveAudioNodes {
  const x = circle._pos.x;
  const y = circle._pos.y;
  const pan = (x / window.innerWidth) * 2 - 1;
  const yFactor = y / window.innerHeight;

  const noteIndex = Math.floor(circle._rng() * noteScale.length);
  const baseFreq = noteScale[noteIndex];

  const mainGain = audioCtx.createGain();
  mainGain.gain.value = 0.1 + yFactor * 0.3;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan });
  filter.connect(mainGain);
  mainGain.connect(panner);
  panner.connect(audioCtx.destination);

  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  const detunes = Array.from({ length: harmonics }, (_, i) =>
    i * 5 * (circle._rng() > 0.5 ? 1 : -1),
  );

  const oscillators: OscillatorNode[] = detunes.map((detune) => {
    const osc = audioCtx.createOscillator();
    osc.type = analysis.avgDashLength > 0.2 ? "sine" : "triangle";
    osc.frequency.value = baseFreq * (1 + detune / 1200);
    osc.connect(filter);
    osc.start();
    return osc;
  });

  const nodes: LiveAudioNodes = {
    gain: mainGain,
    filter,
    panner,
    oscillators,
  };

  return nodes;
}

/**
 * Fade out and cleanup live audio nodes attached to a circle.
 * This function will schedule a small fade and then stop/disconnect nodes.
 */
export function fadeAndCleanupLiveAudio(
  audioCtx: AudioContext,
  circle: CircleWithState,
): void {
  const nodes = circle._liveAudioNodes;
  if (!nodes) return;

  const now = audioCtx.currentTime;
  try {
    nodes.gain.gain.linearRampToValueAtTime(0, now + LIVE_AUDIO_FADE_SEC);
  } catch {
    // ignore if scheduling fails
  }

  // Delay slightly more than the fade duration to ensure ramp completes
  window.setTimeout(() => {
    const n = circle._liveAudioNodes;
    if (!n) return;
    try {
      n.oscillators.forEach((osc) => {
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
      });
    } catch {
      // ignore
    }
    try {
      n.filter.disconnect();
    } catch {}
    try {
      n.gain.disconnect();
    } catch {}
    try {
      n.panner.disconnect();
    } catch {}
    circle._liveAudioNodes = null;
  }, Math.round(LIVE_AUDIO_FADE_SEC * 1000) + 20);
}

/**
 * Convert a circle's stroke-dasharray into a sequence of segments (lengths),
 * analyze them and schedule looping playback. The function stores a timeout
 * identifier on `circle._loopTimeout` so it can be cancelled later.
 */
export function loopCircleAudio(
  audioCtx: AudioContext,
  circle: CircleWithState,
): void {
  const rotationPeriod = (circle._holdDuration || 1000) / 1000; // seconds
  const dashAttr = circle.getAttribute("stroke-dasharray") || "";
  const dashArray = dashAttr
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n) && isFinite(n));

  if (dashArray.length === 0) return;

  const totalLength = dashArray.reduce((a, b) => a + b, 0) || 1;
  const segmentsLoop: SegmentLength[] = dashArray.map((len, i) => ({
    type: i % 2 === 0 ? "dash" : "gap",
    length: len,
  }));

  const analysis = analyzeSegments(segmentsLoop, totalLength);
  const scale = chooseScale(analysis);

  const x = circle._pos.x;
  const y = circle._pos.y;
  const pan = (x / window.innerWidth) * 2 - 1;
  const yFactor = y / window.innerHeight;

  function scheduleLoopAhead(): void {
    let t = audioCtx.currentTime + LOOP_SCHEDULE_AHEAD_SEC;

    segmentsLoop.forEach((seg) => {
      const dur = (seg.length / totalLength) * rotationPeriod;
      if (seg.type === "dash" && dur > 0) {
        const noteIndex = Math.floor(circle._rng() * scale.length);
        const freq = scale[noteIndex] * (0.995 + circle._rng() * 0.01);
        try {
          playRichTone(
            audioCtx,
            freq,
            pan,
            dur,
            yFactor,
            t,
            circle._rng,
            circle,
            analysis,
          );
        } catch {
          // Ignore playback scheduling errors for robustness
        }
      }
      t += dur;
    });

    // schedule next loop (subtract schedule-ahead so loops chain cleanly)
    const delayMs = Math.max(50, Math.round((rotationPeriod - LOOP_SCHEDULE_AHEAD_SEC) * 1000));
    // store timeout id so it can be cleared by callers
    circle._loopTimeout = window.setTimeout(scheduleLoopAhead, delayMs);
  }

  // Start scheduling
  scheduleLoopAhead();
}

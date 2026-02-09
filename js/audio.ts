/**
 * svg-playground/js/audio.ts
 *
 * Audio engine for Dash‑Synced Generative Audio Circles
 *
 * This refactor uses the WeakMap-backed `state` module for per-circle runtime
 * handles instead of attaching ad-hoc properties to DOM elements. That keeps
 * TypeScript types precise and avoids `any` casts elsewhere.
 */

import { LIVE_AUDIO_FADE_SEC } from './constants';
import { analyzeSegments, chooseScale, SegmentLength } from './utils';
import {
  ensureCircleState,
  getPos,
  getRng,
  addActiveOscillator,
  setLiveAudioNodes,
  getLiveAudioNodes,
  setLoopTimeout,
  setScheduledUntil,
  clearLoopTimeout,
  stopAndClearLiveAudioNodes,
  getHoldDuration,
} from './state';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type LiveAudioNodes = {
  gain: GainNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  oscillators: OscillatorNode[];
};

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create an AudioContext. Throws if Web Audio API isn't present.
 */
export function createAudioContext(): AudioContext {
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is not available in this environment');
  }
  return new Ctor();
}

/* -------------------------------------------------------------------------- */
/* Synthesis                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Play a short rich tone scheduled at `startTime` for `duration`.
 *
 * Note: `circle` is a plain `SVGCircleElement`. Per-circle runtime data
 * (position, rng, etc.) is read from the `state` module (WeakMap).
 */
export function playRichTone(
  audioCtx: AudioContext,
  freq: number,
  pan: number,
  duration: number,
  yFactor: number,
  startTime: number,
  rng: () => number,
  circle: SVGCircleElement,
  analysis: ReturnType<typeof analyzeSegments>
): void {
  const gain = audioCtx.createGain();
  const baseGain = 0.1 + yFactor * 0.3;
  gain.gain.value = baseGain;

  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  const detunes = Array.from(
    { length: harmonics },
    (_, i) => i * 5 * (rng() > 0.5 ? 1 : -1)
  );

  const attackTime = Math.max(0.001, (analysis.avgDashLength || 0) * 0.1);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(baseGain, startTime + attackTime);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan });

  filter.connect(gain);
  gain.connect(panner);
  panner.connect(audioCtx.destination);

  // Create and schedule oscillators. Track them in the state map via helper.
  detunes.forEach((detune) => {
    const osc = audioCtx.createOscillator();
    osc.type = analysis.avgDashLength > 0.2 ? 'sine' : 'triangle';
    osc.frequency.value = freq * (1 + detune / 1200);
    osc.connect(filter);
    osc.start(startTime);
    osc.stop(startTime + duration);

    // Track on the circle state for later cleanup
    addActiveOscillator(circle, osc);
  });
}

/* -------------------------------------------------------------------------- */
/* Live preview                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Create live audio nodes used during recording preview.
 * Returns a LiveAudioNodes object and stores it in the state map.
 */
export function createLiveAudio(
  audioCtx: AudioContext,
  circle: SVGCircleElement,
  analysis: ReturnType<typeof analyzeSegments>,
  noteScale: number[]
): LiveAudioNodes {
  // Ensure the circle has state and read pos/rng
  ensureCircleState(circle);
  const pos = getPos(circle) ?? { x: 0, y: 0 };
  const rng = getRng(circle) ?? (() => Math.random());

  const x = pos.x;
  const y = pos.y;
  const pan = (x / window.innerWidth) * 2 - 1;
  const yFactor = 1 - y / window.innerHeight;

  const noteIndex = Math.floor(rng() * noteScale.length);
  const baseFreq = noteScale[noteIndex];

  const mainGain = audioCtx.createGain();
  mainGain.gain.value = 0.1 + yFactor * 0.3;

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan });
  filter.connect(mainGain);
  mainGain.connect(panner);
  panner.connect(audioCtx.destination);

  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  const detunes = Array.from(
    { length: harmonics },
    (_, i) => i * 5 * (rng() > 0.5 ? 1 : -1)
  );

  const oscillators: OscillatorNode[] = detunes.map((detune) => {
    const osc = audioCtx.createOscillator();
    osc.type = analysis.avgDashLength > 0.2 ? 'sine' : 'triangle';
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

  // Persist nodes in the state for later fade/cleanup
  setLiveAudioNodes(circle, nodes);
  return nodes;
}

/* -------------------------------------------------------------------------- */
/* Fade / cleanup helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fade out and cleanup live audio nodes attached to a circle.
 * Uses state helpers instead of element-attached properties.
 */
export function fadeAndCleanupLiveAudio(
  audioCtx: AudioContext,
  circle: SVGCircleElement
): void {
  const nodes = getLiveAudioNodes(circle);
  if (!nodes) return;

  const now = audioCtx.currentTime;
  try {
    nodes.gain.gain.linearRampToValueAtTime(0, now + LIVE_AUDIO_FADE_SEC);
  } catch {
    // ignore scheduling failures
  }

  // Delay a bit longer than the fade to ensure the ramp completed
  window.setTimeout(
    () => {
      const n = getLiveAudioNodes(circle);
      if (!n) return;

      try {
        for (const osc of n.oscillators) {
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
        n.filter.disconnect();
      } catch {
        // ignore
      }
      try {
        n.gain.disconnect();
      } catch {
        // ignore
      }
      try {
        n.panner.disconnect();
      } catch {
        // ignore
      }

      // clear stored live nodes in state
      stopAndClearLiveAudioNodes(circle);
    },
    Math.round(LIVE_AUDIO_FADE_SEC * 1000) + 20
  );
}

/* -------------------------------------------------------------------------- */
/* Loop scheduling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Convert a circle's stroke-dasharray into a sequence of segments and schedule looping playback.
 * Scheduling info (scheduledUntil / loopTimeout) is stored in the state map.
 */
export function loopCircleAudio(
  audioCtx: AudioContext,
  circle: SVGCircleElement
): void {
  // Read hold duration from state if present; fallback to 1000ms
  const holdMs = getHoldDuration(circle) ?? 1000;
  const rotationPeriod = holdMs / 1000; // seconds

  const dashAttr = circle.getAttribute('stroke-dasharray') || '';
  const dashArray = dashAttr
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n) && isFinite(n));

  if (dashArray.length === 0) return;

  const totalLength = dashArray.reduce((a, b) => a + b, 0) || 1;
  const segmentsLoop: SegmentLength[] = dashArray.map((len, i) => ({
    type: i % 2 === 0 ? 'dash' : 'gap',
    length: len,
  }));

  const analysis = analyzeSegments(segmentsLoop, totalLength);
  const scale = chooseScale(analysis);

  const pos = getPos(circle) ?? { x: 0, y: 0 };
  const x = pos.x;
  const y = pos.y;
  const pan = (x / window.innerWidth) * 2 - 1;
  const yFactor = 1 - y / window.innerHeight;

  // Clear any previous scheduled loop to avoid duplicates
  clearLoopTimeout(circle);

  // Helper that schedules all dash segments for one rotation starting at startTime.
  const scheduleOneRotation = (startTime: number) => {
    // Debug: report when we start scheduling a rotation
    try {
      console.debug('[loopCircleAudio] scheduleOneRotation start', {
        circle,
        startTime,
        rotationPeriod,
        segments: segmentsLoop.length,
        totalLength,
      });
    } catch {
      /* ignore debug failures */
    }

    let t = startTime;
    for (const seg of segmentsLoop) {
      const dur = (seg.length / totalLength) * rotationPeriod;
      if (seg.type === 'dash' && dur > 0) {
        const rng = getRng(circle) ?? Math.random;
        const noteIndex = Math.floor(rng() * scale.length);
        const freq = scale[noteIndex] * (0.995 + rng() * 0.01);
        try {
          // Debug: log each scheduled note
          try {
            console.debug('[loopCircleAudio] scheduling note', {
              freq: Number(freq.toFixed(2)),
              start: Number(t.toFixed(3)),
              dur: Number(dur.toFixed(3)),
              pan: Number(pan.toFixed(3)),
              circle,
            });
          } catch {
            /* ignore debug failures */
          }

          playRichTone(
            audioCtx,
            freq,
            pan,
            dur,
            yFactor,
            t,
            rng,
            circle,
            analysis
          );
        } catch (err) {
          // ignore scheduling errors but surface a debug message
          try {
            console.warn('[loopCircleAudio] scheduling error', {
              err,
              circle,
              freq,
              t,
              dur,
            });
          } catch {
            /* ignore debug failures */
          }
        }
      }
      t += dur;
    }
    // Persist scheduled horizon (one rotation from startTime)
    setScheduledUntil(circle, t);

    // Debug: report completed scheduling horizon
    try {
      console.debug('[loopCircleAudio] scheduled rotation horizon', {
        circle,
        horizon: t,
      });
    } catch {
      /* ignore debug failures */
    }
  };

  // Schedule immediately for the upcoming rotation, then use setInterval to repeat.
  const now = audioCtx.currentTime;
  const startTime = now + 0.02; // slight offset to allow audio graph to settle
  scheduleOneRotation(startTime);

  // Repeat every rotation period (ms). Use setInterval for steady repetition.
  const intervalMs = Math.max(20, Math.round(rotationPeriod * 1000));
  const id = window.setInterval(() => {
    const s = audioCtx.currentTime + 0.02;
    scheduleOneRotation(s);
  }, intervalMs);

  // Debug: report interval creation
  try {
    console.debug('[loopCircleAudio] setInterval', { circle, intervalMs, id });
  } catch {
    /* ignore debug failures */
  }

  setLoopTimeout(circle, id as unknown as number);
}

/**
 * svg-playground/js/audio.ts
 *
 * Audio for Dash‑Synced Generative Audio Circles.
 *
 * All synthesis lives in the Rust/WASM AudioWorklet engine (js/engine/); this
 * module owns the master output chain, the engine glue, and the lookahead
 * scheduler that turns each circle's dash pattern into engine noteOn events.
 * Per-circle runtime handles live in the WeakMap-backed `state` module.
 */

import {
  LOOP_SCHEDULE_AHEAD_SEC,
  SCHEDULER_INTERVAL_MS,
  SCALES,
} from './constants';
import { analyzeSegments, chooseScale, SegmentLength } from './utils';
import {
  getPos,
  getRng,
  getScale,
  setLoopTimeout,
  setScheduledUntil,
  getScheduledUntil,
  clearLoopTimeout,
  getHoldDuration,
} from './state';
import {
  initEngine,
  type EngineHandle,
  type NoteKind,
  type VoiceProfile,
  type DroneOptions,
} from './engine/engine';
import { humanizeSegmentTiming, humanizeVelocity } from './humanize';
import { getGlowController } from './glow';

/* -------------------------------------------------------------------------- */
/* Master output chain                                                        */
/* -------------------------------------------------------------------------- */

const masterNodesMap = new WeakMap<
  AudioContext,
  { masterGain: GainNode; compressor: DynamicsCompressorNode }
>();

function ensureMasterNodes(audioCtx: AudioContext) {
  const existing = masterNodesMap.get(audioCtx);
  if (existing) return existing;

  const compressor = audioCtx.createDynamicsCompressor();
  const waveshaper = audioCtx.createWaveShaper();
  const masterGain = audioCtx.createGain();

  // More aggressive default compressor settings to provide stronger limiting/headroom.
  // These settings lower the threshold and increase the ratio for clearer peak control.
  try {
    compressor.threshold.value = -24; // lower threshold to catch more peaks
    compressor.knee.value = 0; // hard knee for more decisive limiting
    compressor.ratio.value = 12; // stronger compression
    compressor.attack.value = 0.002; // fast attack to catch transients
    compressor.release.value = 0.06; // relatively fast release for responsiveness
  } catch {
    // If environment doesn't allow param setting, continue with defaults.
  }

  // Slightly lower master gain to provide extra headroom before compression.
  masterGain.gain.value = 0.78;

  // Build a gentle soft-clipping curve for the waveshaper to tame remaining peaks.
  try {
    const curveLen = 16384;
    const curve = new Float32Array(curveLen);
    // Soft tanh-like shaping with moderate intensity
    const k = 2.5;
    for (let i = 0; i < curveLen; i++) {
      const x = (i / (curveLen - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x);
    }
    waveshaper.curve = curve;
    waveshaper.oversample = '4x';
  } catch {
    // ignore if waveshaper not supported
  }

  // compressor -> waveshaper -> masterGain -> destination
  compressor.connect(waveshaper);
  waveshaper.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  const nodes = { masterGain, compressor };
  masterNodesMap.set(audioCtx, nodes);
  return nodes;
}

function getMasterOutput(audioCtx: AudioContext): AudioNode {
  const nodes = masterNodesMap.get(audioCtx) ?? ensureMasterNodes(audioCtx);
  // Route audio into the compressor so all sources share the same limiting stage.
  // Returning the compressor ensures callers connect into the compressor node.
  return nodes.compressor;
}

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

  const ctx = new Ctor();
  // ensure per-AudioContext master output nodes are created and wired
  ensureMasterNodes(ctx);
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Worklet engine glue                                                        */
/* -------------------------------------------------------------------------- */

let engine: EngineHandle | null = null;
let engineInitPromise: Promise<EngineHandle> | null = null;

/**
 * Load the Rust/WASM worklet engine and connect it into the master chain.
 * Safe to call on a suspended context (module loading doesn't need a user
 * gesture); idempotent across repeated calls.
 */
export function initAudioEngine(audioCtx: AudioContext): Promise<EngineHandle> {
  if (engineInitPromise) return engineInitPromise;
  ensureMasterNodes(audioCtx);
  const p: Promise<EngineHandle> = initEngine(audioCtx).then((handle) => {
    // A dispose (or re-init) may have superseded this init while WASM/worklet
    // load was in flight. If so, don't connect or install the stale handle —
    // tear it down instead, or it leaks as an orphaned, never-disposed worklet.
    if (engineInitPromise !== p) {
      handle.dispose();
      return handle;
    }
    handle.node.connect(getMasterOutput(audioCtx));
    engine = handle;
    return handle;
  });
  engineInitPromise = p;
  return p;
}

/** Drive the live drawing drone; no-op until the engine is ready. */
export function setDrone(options: DroneOptions): void {
  engine?.setDrone(options);
}

/**
 * Silence everything immediately: drop notes already scheduled into the worklet
 * (the scheduler runs up to one rotation ahead) and cut sounding voices. Used
 * by the Clear button so long circles don't keep playing after clear.
 */
export function stopAllAudio(): void {
  engine?.allNotesOff();
}

/**
 * Tear down the worklet engine and reset the module singleton so a later
 * `initAudioEngine` re-inits cleanly against its own context. If init is still
 * in flight, dispose once it resolves.
 */
export function disposeAudioEngine(): void {
  if (engine) engine.dispose();
  engine = null;
  // Supersede any in-flight init: nulling the promise makes its .then guard see
  // a changed identity and dispose the orphaned handle itself.
  engineInitPromise = null;
}

/**
 * Flash the glow ring for a circle when its note becomes audible, aligning
 * the DOM update with the audio clock. One dispatch per scheduled note —
 * percussion included.
 */
function notifyGlow(
  audioCtx: AudioContext,
  circle: SVGCircleElement,
  when: number,
  detail: { freq: number; duration: number; intensity: number }
): void {
  const delayMs = Math.max(0, Math.round((when - audioCtx.currentTime) * 1000));
  window.setTimeout(() => {
    if (!circle.isConnected) return;
    getGlowController()?.flash(circle, detail);
  }, delayMs);
}

/**
 * Position → stereo pan (clamped, with the pan-clamped marker attr), vertical
 * brightness factor, and a semitone transpose. Shared by the loop scheduler
 * and the live preview so both voice a circle from the same placement.
 */
function derivePlacement(circle: SVGCircleElement): {
  pan: number;
  yFactor: number;
  semitoneFactor: number;
} {
  const pos = getPos(circle) ?? { x: 0, y: 0 };
  // Defensive clamping so audio mapping remains audible at the edges.
  const x = Math.max(0, Math.min(pos.x ?? 0, window.innerWidth));
  const y = Math.max(0, Math.min(pos.y ?? 0, window.innerHeight));
  // Pan from X, clamped to a reduced range to avoid hard-panned silent cases.
  const PAN_LIMIT = 0.85;
  const rawPan = (x / Math.max(1, window.innerWidth)) * 2 - 1;
  const pan = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, rawPan));
  // Mark the circle when pan was clamped so overlays can indicate the change.
  try {
    if (pan !== rawPan) circle.setAttribute('data-pan-clamped', '1');
    else circle.removeAttribute('data-pan-clamped');
  } catch {
    /* ignore DOM write failures */
  }
  const yNorm = Math.max(0, Math.min(1, y / Math.max(1, window.innerHeight)));
  const yFactor = 1 - yNorm;
  // x maps to a semitone transpose roughly in [-4..+4]; no octave bias so
  // pitches stay lower on average.
  const transposeSemis = Math.round((x / window.innerWidth - 0.5) * 8);
  // Vertical-drag size sets pitch: a bigger circle rings lower, so pitch scales
  // by 1/size (2x size = down an octave).
  const scale = getScale(circle);
  const semitoneFactor =
    Math.pow(2, transposeSemis / 12) / (scale > 0 ? scale : 1);
  return { pan, yFactor, semitoneFactor };
}

/**
 * Audition the loop's voice while drawing: fire one FM `tone` note using the
 * same placement (pan / transpose / brightness) the loop scheduler uses, so
 * holding Space previews the instrument the finished loop will play — not a
 * separate drone. One-shot like every loop note (no note-off); it rings and
 * decays on its own. No-op until the engine is ready.
 */
export function previewLiveNote(
  audioCtx: AudioContext,
  circle: SVGCircleElement
): void {
  if (!engine) return;

  const { pan, yFactor, semitoneFactor } = derivePlacement(circle);
  // Pentatonic root (chooseScale's default for sparse patterns), transposed.
  const scale = SCALES.pentatonic.map((f) => f * semitoneFactor);
  // Higher on screen → higher scale degree.
  const degree = Math.max(
    0,
    Math.min(scale.length - 1, Math.round(yFactor * (scale.length - 1)))
  );
  let freq = scale[degree];
  if (!isFinite(freq) || freq <= 0) freq = 220;
  while (freq > 5000) freq /= 2;
  while (freq < 40) freq *= 2;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const profile: VoiceProfile = {
    spectral: clamp01(0.6 * yFactor + 0.2),
    texture: 0.3,
    motion: 0.5,
    space: Math.abs(pan),
  };

  const when = audioCtx.currentTime + 0.005;
  const velocity = Math.min(1, 0.4 + 0.5 * yFactor);
  const durSec = 1.6; // rings like a long loop tone, then decays

  engine.noteOn({ when, freq, durSec, velocity, pan, kind: 'tone', profile });
  notifyGlow(audioCtx, circle, when, {
    freq,
    duration: durSec,
    intensity: velocity,
  });
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
  const baseScale = chooseScale(analysis);

  const { pan, yFactor, semitoneFactor } = derivePlacement(circle);

  // Build a transposed scale to use for this circle (no octave multiplication)
  const scale = baseScale.map((f) => f * semitoneFactor);

  // Clear any previous scheduled loop to avoid duplicates
  clearLoopTimeout(circle);

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  // Per-circle timbre profile, computed once: the four axes the engine maps
  // to FM index/morph/filter, unison/feedback, envelopes/glide, and
  // pan-spread/delay-send.
  const profile: VoiceProfile = {
    // high on screen + short dashes = bright
    spectral: clamp01(
      0.6 * yFactor + 0.4 * (1 - Math.min(1, analysis.avgDashLength * 4))
    ),
    texture: clamp01(analysis.complexity / 12),
    motion: clamp01(1 / (1 + analysis.dashGapRatio)),
    space: clamp01(Math.abs(pan)),
  };

  // Helper that schedules all dash segments for one rotation starting at startTime.
  const scheduleOneRotation = (startTime: number) => {
    let t = startTime;
    let dashIndex = 0;
    for (const seg of segmentsLoop) {
      const dur = (seg.length / totalLength) * rotationPeriod;
      if (seg.type === 'dash' && dur > 0) {
        // ponytail: notes before engine-ready drop silently (t still advances,
        // so there is no backlog burst once the worklet comes up).
        if (engine) {
          const rng = getRng(circle) ?? Math.random;

          // Map segment length to a scale degree:
          // - normalizedLen in (0..1), where larger values are longer dashes
          // - longer dashes map toward lower indices (closer to tonic)
          const normalizedLen = seg.length / totalLength;
          const baseIndex = Math.round(
            (1 - normalizedLen) * (scale.length - 1)
          );
          const jitterOffset = Math.floor((rng() - 0.5) * 2); // -1, 0, or +1
          let noteIndex = Math.max(
            0,
            Math.min(scale.length - 1, baseIndex + jitterOffset)
          );

          // Extra bias: for relatively long dashes, prefer tonic (index 0)
          if (normalizedLen > 0.25) noteIndex = 0;

          let freq = scale[noteIndex] * (0.995 + rng() * 0.01);
          if (!isFinite(freq) || freq <= 0) freq = 440;
          while (freq < 40) freq *= 2;
          while (freq > 5000) freq /= 2;

          // Duration/position routing: very short dashes hiss, short dashes
          // snap, long dashes anchor — kick on the left half of the canvas,
          // bass tones on the right.
          let kind: NoteKind;
          if (dur < 0.08) {
            kind = 'hat';
          } else if (dur < 0.25) {
            kind = 'snare';
          } else if (pan < 0) {
            kind = 'kick';
          } else {
            kind = 'tone';
            while (freq > 220) freq /= 2; // bass register
          }

          // Deterministic groove: seeded per-circle rng drives micro-timing
          // and velocity so the loop swings the same way every rotation.
          const beatPos = clamp01((t - startTime) / rotationPeriod);
          const baseVel =
            0.35 + 0.45 * yFactor + 0.2 * Math.min(1, normalizedLen * 3);
          const velocity = Math.min(
            1,
            humanizeVelocity(baseVel, dashIndex, beatPos, {}, rng)
          );
          const timing = humanizeSegmentTiming(
            t,
            dur,
            dashIndex,
            beatPos,
            {},
            rng
          );

          engine.noteOn({
            when: timing.startTimeSec,
            freq,
            durSec: timing.durationSec,
            velocity,
            pan,
            kind,
            profile,
          });
          notifyGlow(audioCtx, circle, timing.startTimeSec, {
            freq,
            duration: timing.durationSec,
            intensity: velocity,
          });
        }
        dashIndex++;
      }
      t += dur;
    }
    // Persist scheduled horizon (one rotation from startTime)
    setScheduledUntil(circle, t);
  };

  // Scheduler with lookahead: schedule notes up to audioCtx.currentTime + LOOP_SCHEDULE_AHEAD_SEC.
  const lookahead = LOOP_SCHEDULE_AHEAD_SEC;
  const schedulerIntervalMs = Math.max(20, SCHEDULER_INTERVAL_MS);

  // Initial fill of the lookahead window.
  const now = audioCtx.currentTime;
  const initialStart = now + 0.02; // slight offset to allow audio graph to settle
  scheduleOneRotation(initialStart);

  // Scheduler tick: schedule forward until the lookahead horizon is filled.
  const schedulerTick = () => {
    try {
      const current = audioCtx.currentTime;
      const horizon = current + lookahead;

      // Use the stored scheduledUntil as the starting point; fallback to current.
      let scheduledUntil = getScheduledUntil(circle) ?? current;

      // If nothing scheduled yet, start at current + small offset.
      if (scheduledUntil < current + 0.01) {
        scheduledUntil = current + 0.02;
      }

      // Schedule rotations forward until we reach the horizon.
      while (scheduledUntil < horizon) {
        // Schedule one rotation starting at scheduledUntil
        scheduleOneRotation(scheduledUntil);
        // Each rotation adds rotationPeriod seconds to the scheduled horizon.
        scheduledUntil += rotationPeriod;
      }
    } catch {
      /* ignore scheduler failures to keep UI responsive */
    } finally {
      // Queue next tick and persist its id so it can be cleared on cleanup.
      const tid = window.setTimeout(schedulerTick, schedulerIntervalMs);
      setLoopTimeout(circle, tid as unknown as number);
    }
  };

  // Start the scheduler loop.
  const tid = window.setTimeout(schedulerTick, schedulerIntervalMs);
  setLoopTimeout(circle, tid as unknown as number);
}

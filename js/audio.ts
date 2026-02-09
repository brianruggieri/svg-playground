/**
 * svg-playground/js/audio.ts
 *
 * Audio engine for Dash‑Synced Generative Audio Circles
 *
 * This refactor uses the WeakMap-backed `state` module for per-circle runtime
 * handles instead of attaching ad-hoc properties to DOM elements. That keeps
 * TypeScript types precise and avoids `any` casts elsewhere.
 */

import {
  LIVE_AUDIO_FADE_SEC,
  LOOP_SCHEDULE_AHEAD_SEC,
  SCHEDULER_INTERVAL_MS,
  NOTE_RELEASE_SEC,
  NOTE_STOP_SLACK_SEC,
  MIN_NOTE_DURATION_SEC,
  MIN_ATTACK_SEC,
  PER_VOICE_GAIN_MULTIPLIER,
} from './constants';
import { analyzeSegments, chooseScale, SegmentLength } from './utils';
import {
  ensureCircleState,
  getPos,
  getRng,
  addActiveOscillator,
  getActiveOscillators,
  setLiveAudioNodes,
  getLiveAudioNodes,
  setLoopTimeout,
  setScheduledUntil,
  getScheduledUntil,
  clearLoopTimeout,
  stopAndClearLiveAudioNodes,
  getHoldDuration,
} from './state';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
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

function minFilterFreq(audioCtx: AudioContext, floor = 40): number {
  // Compute a sample-rate-aware minimum frequency to avoid negative/too-low values.
  // Use a small fraction of the sample rate (0.001 * sampleRate) so this matches
  // the overlay's calculation and keeps behavior consistent across the UI and audio.
  // The default `floor` is conservative (40Hz) so very low sample rates still get
  // an audible minimum.
  const sr = (audioCtx && audioCtx.sampleRate) || 44100;
  const srBased = sr * 0.001; // e.g. 44100 -> ~44 Hz
  return Math.max(floor, srBased);
}

// Internal singleton AudioContext used for immediate click feedback when an external
// audioCtx isn't supplied (keeps a single context rather than creating many).
let __clickInternalCtx: AudioContext | null = null;

/**
 * playClickTone
 *
 * Play a short percussive / pitched click tone at the given client coordinates.
 * If `audioCtx` is omitted, an internal singleton AudioContext is created and used.
 *
 * The sound uses the same final master output path (compressor + waveshaper)
 * so preview/onclick tones share consistent processing and headroom with looped notes.
 */
export function playClickTone(
  audioCtx?: AudioContext,
  clientX?: number,
  clientY?: number
): void {
  try {
    const ctx =
      audioCtx ??
      __clickInternalCtx ??
      (__clickInternalCtx = createAudioContext());

    // Best-effort resume to ensure audio will play on platforms that require user activation.
    try {
      void ctx.resume();
    } catch {
      /* ignore resume failures */
    }

    // Ensure master nodes exist for this context
    ensureMasterNodes(ctx);

    // Compute pan and normalized vertical factor robustly and clamp them into safe ranges.
    const panRaw =
      typeof clientX === 'number'
        ? clientX / Math.max(1, window.innerWidth)
        : 0.5;
    // Reduce extreme panning to avoid fully-left/right near-silent cases for some output devices.
    const PAN_LIMIT = 0.85;
    const pan = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, panRaw * 2 - 1));
    const y = typeof clientY === 'number' ? clientY : window.innerHeight / 2;
    const yNorm = Math.max(0, Math.min(1, y / Math.max(1, window.innerHeight)));
    // yFactor: 0 => bottom, 1 => top (higher yields brighter / higher pitches)
    const yFactor = 1 - yNorm;

    // Map vertical position into an exponential frequency range that's reliably audible.
    const fMin = 220; // safe lower bound for perceptible pitch
    const fMax = 880; // safe upper bound for preview tones
    let freq = fMin * Math.pow(fMax / fMin, yFactor);
    // small pan-based tilt but clamped to a safe audible range
    const _minFreqClamp = minFilterFreq(ctx, 60);
    freq = Math.max(_minFreqClamp, Math.min(12000, freq - pan * 30));

    const start = ctx.currentTime + 0.03; // slightly larger offset to let gain ramp engage
    const dur = 0.12; // short, human-recognizable click / tone
    const attack = 0.03; // slightly longer preview attack to avoid spikes
    const release = Math.min(NOTE_RELEASE_SEC, dur * 0.5);

    // Safe base gain (slightly lower than loop voice) to keep preview headroom
    // reduce preview level slightly to avoid transient clipping
    const baseGain = (0.06 + yFactor * 0.18) * 0.8 * 0.7;

    const p = new StereoPannerNode(ctx, { pan });

    // Feature-detect oscillator support. If oscillators are not usable, fallback to a noise-buffer burst.
    let oscSupported = true;
    try {
      const t = ctx.createOscillator();
      t.disconnect();
    } catch {
      oscSupported = false;
    }

    if (oscSupported) {
      // Create two detuned oscillators for a richer click tone
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      oscA.type = 'sine';
      oscB.type = 'triangle';
      oscA.frequency.value = Math.max(40, freq);
      // slight detune on B for warmth
      oscB.frequency.value = Math.max(40, freq * 1.01);

      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = Math.max(minFilterFreq(ctx), 900 + yFactor * 1800);
      filt.Q.value = 0.9;

      const g = ctx.createGain();
      // schedule gain envelope
      try {
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(baseGain, start + attack);
        g.gain.setValueAtTime(baseGain, start + dur - release);
        g.gain.linearRampToValueAtTime(0.0001, start + dur + 0.005);
      } catch {
        // fallback if scheduling denied
        g.gain.value = baseGain;
      }

      // Connect chain: oscA/B -> filt -> gain -> panner -> master
      try {
        oscA.connect(filt);
        oscB.connect(filt);
        filt.connect(g);
        g.connect(p);
        p.connect(getMasterOutput(ctx));
      } catch {
        // Best-effort connections (some environments restrict node wiring)
      }

      // start / stop
      try {
        // Ensure oscillator frequencies are at least a sample-rate-aware minimum
        oscA.frequency.value = Math.max(minFilterFreq(ctx), freq);
        oscB.frequency.value = Math.max(minFilterFreq(ctx), freq * 1.01);

        oscA.start(start);
        oscB.start(start);
        // stop after the tail/stop slack to ensure ramps/tails complete
        const stopAt = start + dur + NOTE_STOP_SLACK_SEC + 0.06;
        oscA.stop(stopAt);
        oscB.stop(stopAt);
      } catch {
        try {
          oscA.start();
          oscB.start();
          oscA.stop(ctx.currentTime + dur + NOTE_STOP_SLACK_SEC);
          oscB.stop(ctx.currentTime + dur + NOTE_STOP_SLACK_SEC);
        } catch {
          // ignore
        }
      }

      // Cleanup: disconnect after a short grace period to allow ramps to finish
      const cleanupMs = Math.round((dur + NOTE_STOP_SLACK_SEC + 0.2) * 1000);
      window.setTimeout(() => {
        try {
          oscA.disconnect();
        } catch {
          /* ignore */
        }
        try {
          oscB.disconnect();
        } catch {
          /* ignore */
        }
        try {
          filt.disconnect();
        } catch {
          /* ignore */
        }
        try {
          g.disconnect();
        } catch {
          /* ignore */
        }
        try {
          p.disconnect();
        } catch {
          /* ignore */
        }
      }, cleanupMs);
    } else {
      // Noise-buffer fallback: short filtered burst
      try {
        const sampleRate = Math.max(22050, ctx.sampleRate || 44100);
        const frameCount = Math.floor(sampleRate * dur);
        const buf = ctx.createBuffer(1, frameCount, sampleRate);
        const data = buf.getChannelData(0);
        // fill with short white noise burst shaped by a quick decay
        for (let i = 0; i < frameCount; i++) {
          // envelope: quick exponential decay
          const env = Math.exp(-3 * (i / frameCount));
          data[i] = (Math.random() * 2 - 1) * 0.6 * env;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = Math.max(
          minFilterFreq(ctx),
          1600 + yFactor * 1200
        );
        filt.Q.value = 0.7;

        const g = ctx.createGain();
        // scale and schedule a gentle fade on the buffer path
        try {
          g.gain.setValueAtTime(baseGain * 0.6, start);
          g.gain.linearRampToValueAtTime(0.0001, start + dur + 0.02);
        } catch {
          g.gain.value = baseGain * 0.6;
        }

        try {
          src.connect(filt);
          filt.connect(g);
          g.connect(p);
          p.connect(getMasterOutput(ctx));
        } catch {
          // ignore connection failures
        }

        try {
          src.start(start);
          src.stop(start + dur + NOTE_STOP_SLACK_SEC);
        } catch {
          try {
            src.start();
            src.stop(ctx.currentTime + dur + NOTE_STOP_SLACK_SEC);
          } catch {
            // ignore
          }
        }

        const cleanupMs = Math.round((dur + NOTE_STOP_SLACK_SEC + 0.15) * 1000);
        window.setTimeout(() => {
          try {
            src.disconnect();
          } catch {
            /* ignore */
          }
          try {
            filt.disconnect();
          } catch {
            /* ignore */
          }
          try {
            g.disconnect();
          } catch {
            /* ignore */
          }
          try {
            p.disconnect();
          } catch {
            /* ignore */
          }
        }, cleanupMs);
      } catch {
        // ignore buffer creation failures
      }
    }
  } catch {
    // If anything fails (e.g., no audio API), silently ignore so page interaction isn't blocked.
  }
}

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
let __compWatcherTid: number | null = null;

/**
 * Apply current global compensation sensitivity to active oscillator/gain records
 * and live preview nodes. This function is idempotent and best-effort (defensive).
 */
export function applyCompensationToActiveOscillators(): void {
  try {
    // Read global sensitivity (set by overlay slider). Keep safe defaults.
    type WindowWithComp = Window & {
      __FILTER_COMPENSATION_SENSITIVITY?: number;
    };
    const w = window as unknown as WindowWithComp;
    const sensitivity = Math.max(
      0,
      Math.min(5, Number(w.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0))
    );

    // Iterate over all circles in the document and update active nodes.
    const circles = Array.from(
      document.querySelectorAll('circle')
    ) as SVGCircleElement[];
    for (const c of circles) {
      try {
        // Update scheduled/active oscillators (recorded in state)
        const recs = getActiveOscillators(c);
        for (const rec of recs) {
          try {
            const base =
              typeof rec.baseGain === 'number' ? rec.baseGain : undefined;
            if (!base) continue;
            const target = base * sensitivity;
            if (rec.gain && rec.gain.gain) {
              // Use the gain node's context for precise scheduling when available.
              const gctx = rec.gain?.context ?? rec.osc?.context;
              const now = gctx?.currentTime;
              if (typeof now === 'number') {
                try {
                  rec.gain.gain.cancelScheduledValues(now);
                } catch {
                  /* ignore */
                }
                try {
                  rec.gain.gain.setValueAtTime(target, now + 0.01);
                } catch {
                  rec.gain.gain.value = target;
                }
              } else {
                try {
                  rec.gain.gain.value = target;
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            // ignore per-record errors
          }
        }
      } catch {
        // ignore per-circle errors for active oscillators
      }

      try {
        // Update live-preview nodes (if present) using stored base gain on mainGain.
        const live = getLiveAudioNodes(c);
        if (live && live.gain) {
          // Narrow the live.gain accessor to a GainNode that may carry a debug/meta property.
          const gainWithMeta = live.gain as
            | (GainNode & { __baseGain?: number })
            | undefined;
          const base = gainWithMeta?.__baseGain ?? undefined;
          if (typeof base === 'number') {
            const ctx = gainWithMeta?.context;
            const now = ctx?.currentTime;
            const target = base * sensitivity;
            if (typeof now === 'number') {
              try {
                live.gain.gain.cancelScheduledValues(now);
              } catch {
                /* ignore */
              }
              try {
                live.gain.gain.setValueAtTime(target, now + 0.01);
              } catch {
                live.gain.gain.value = target;
              }
            } else {
              try {
                live.gain.gain.value = target;
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        // ignore live node errors for this circle
      }
    }
  } catch {
    // swallow all errors to avoid disrupting UI
  }
}

/**
 * Create an AudioContext. Throws if Web Audio API isn't present.
 * Also starts a lightweight watcher that applies compensation sensitivity
 * to currently-playing nodes at an interval so slider changes are audible immediately.
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

  // Start a single global watcher to apply compensation on active nodes so slider
  // changes are reflected immediately. This is a lightweight periodic update.
  try {
    if (__compWatcherTid == null) {
      __compWatcherTid = window.setInterval(() => {
        try {
          applyCompensationToActiveOscillators();
        } catch {
          /* ignore watcher errors */
        }
      }, 200);
    }
  } catch {
    // ignore setInterval failures in restricted environments
  }

  return ctx;
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
  // Sanitize pan / yFactor and base frequency to avoid inaudible / out-of-range values.
  // Reduce extreme panning slightly so voices aren't pushed to fully-left/right which can
  // be effectively inaudible on some devices or with certain routing.
  const PAN_LIMIT = 0.85;
  const panClamped = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, pan));
  // If we had to clamp the incoming pan, mark the element so debug overlays can pick this up.
  try {
    if (panClamped !== pan) circle.setAttribute('data-pan-clamped', '1');
    else circle.removeAttribute('data-pan-clamped');
  } catch {
    /* ignore DOM write failures in constrained contexts */
  }
  const yFactorClamped = Math.max(0, Math.min(1, yFactor));
  const baseFreq = Math.max(40, Math.min(20000, freq));

  const gain = audioCtx.createGain();

  // Compute harmonic count early so we can normalize per-voice amplitude.
  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  // Ensure the raw base gain is in a reasonable audible range.
  const baseGainRaw = Math.max(0.02, 0.1 + yFactorClamped * 0.3);
  // Normalize per-voice level so adding more harmonic voices doesn't linearly increase level.
  let normalizedBaseGain =
    (baseGainRaw / Math.sqrt(Math.max(1, harmonics))) *
    PER_VOICE_GAIN_MULTIPLIER;

  // Compute the raw filter frequency we intend to use and check whether it will be clamped.
  // If the filter would be clamped to the floor, the resulting spectral energy can be
  // much lower; compensate by increasing per-voice gain proportionally to the estimated
  // spectral deficit. The compensation is dynamic (not a fixed multiplier) so it adapts
  // to how far below the floor the computed filter would be.
  const rawFilterFreq = 500 + panClamped * 2000 + yFactorClamped * 3000;
  const minF = minFilterFreq(audioCtx);

  const willFilterBeClamped = rawFilterFreq < minF;
  if (willFilterBeClamped) {
    // Estimate the fractional deficit (how much of the intended bandwidth is lost).
    const deficit = (minF - rawFilterFreq) / Math.max(minF, 1);

    // Map deficit to a compensation factor in a safe range [1.0 .. 2.2].
    // This scaling is intentionally conservative: it restores perceived loudness
    // without creating large peaks that the master compressor/waveshaper must fight.
    const COMP_MIN = 1.0;
    const COMP_MAX = 2.2;

    // Read a runtime sensitivity value from window to allow interactive tuning.
    // We type the window accessor locally to avoid `any` usage elsewhere.
    type WindowWithComp = Window & {
      __FILTER_COMPENSATION_SENSITIVITY?: number;
    };
    const w = window as unknown as WindowWithComp;
    // Sensitivity default = 1.0, clamp to a safe range [0.0 .. 5.0].
    const sensitivity = Math.max(
      0,
      Math.min(5, Number(w.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0))
    );

    // Scale the deficit to produce a smooth factor; the base multiplier of 1.8
    // controls sensitivity, and we further modulate it by the runtime sensitivity.
    const scaled = Math.min(COMP_MAX - COMP_MIN, deficit * 1.8 * sensitivity);
    const compensationFactor = COMP_MIN + scaled;
    normalizedBaseGain *= compensationFactor;

    try {
      circle.setAttribute('data-filter-clamped', '1');
    } catch {
      /* ignore DOM write failures */
    }
  } else {
    try {
      circle.removeAttribute('data-filter-clamped');
    } catch {
      /* ignore DOM write failures */
    }
  }

  // Master gain will act as an envelope (0..1). Per-oscillator gains hold the
  // normalized amplitude so adding harmonics doesn't increase loudness.
  // Set the master gain to a neutral multiplicative value; the realtime envelope
  // below will drive it from near-0 -> 1 -> near-0.
  gain.gain.value = 1.0;

  const detunes = Array.from(
    { length: harmonics },
    (_, i) => i * 5 * (rng() > 0.5 ? 1 : -1)
  );

  // Clamp scheduled duration to a minimum so notes aren't shorter than the envelope.
  const useDuration = Math.max(duration, MIN_NOTE_DURATION_SEC);

  // Adapt attack to the note length: use analysis-informed attack but never exceed
  // a fraction of the note and never go below a minimum sensible attack.
  const attackTime = Math.min(
    Math.max(MIN_ATTACK_SEC, (analysis.avgDashLength || 0) * 0.1),
    useDuration * 0.45
  );

  // Use release computed from the clamped duration to ensure ramps finish before stop.
  const releaseTime = Math.min(useDuration * 0.5, NOTE_RELEASE_SEC);

  // Note end/time bookkeeping uses the clamped duration so ramps and stops align.
  const noteEnd = startTime + useDuration;

  // Master envelope: drive master gain 0 -> 1 -> 0 so the per-oscillator gains
  // determine absolute amplitude and the master node simply shapes the note.
  // Use a tiny non-zero floor to avoid audio artifacts in some engines.
  gain.gain.setValueAtTime(0.0001, startTime);
  try {
    gain.gain.linearRampToValueAtTime(1.0, startTime + attackTime);
    gain.gain.setValueAtTime(1.0, noteEnd - releaseTime);
    gain.gain.linearRampToValueAtTime(0.0001, noteEnd);
  } catch {
    // Fallback for environments that reject precise scheduling: ensure we at least
    // have the master at a sensible level and queue a timeout to silence it later.
    gain.gain.value = 1.0;
    // Schedule a safety timeout to set the master gain back to 0 after noteEnd.
    window.setTimeout(
      () => {
        try {
          gain.gain.value = 0;
        } catch {
          /* ignore */
        }
      },
      Math.max(0, Math.round((noteEnd - audioCtx.currentTime) * 1000))
    );
  }

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  // Use clamped pan/yFactor values so filter frequency is always in a reasonable audible range.
  filter.frequency.value = Math.max(
    minFilterFreq(audioCtx),
    500 + panClamped * 2000 + yFactorClamped * 3000
  );
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan: panClamped });

  // Primary voice path
  filter.connect(gain);
  gain.connect(panner);

  // Per-note tail: short feedback delay + lowpass to provide a decaying tail that persists
  // briefly after oscillators are stopped. This helps mask tail-end clipping.
  const tailLP = audioCtx.createBiquadFilter();
  tailLP.type = 'lowpass';
  tailLP.frequency.value = 1200;

  const tailDelay = audioCtx.createDelay();
  // short delay to create a small echo-like tail
  try {
    // reduced delay time for a tighter, less pronounced tail
    tailDelay.delayTime.value = 0.035;
  } catch {
    // some browsers may restrict immediate parameter setting; ignore
  }

  const tailFeedback = audioCtx.createGain();
  // lower feedback to ensure a smoother, faster-decaying tail and avoid build-up
  tailFeedback.gain.value = 0.28; // feedback < 1 to decay

  const tailGain = audioCtx.createGain();
  // tailGain will be ramped down at note end to create a smooth tail fade

  // feedback loop: tailLP -> tailDelay -> tailFeedback -> tailLP
  tailLP.connect(tailDelay);
  tailDelay.connect(tailFeedback);
  tailFeedback.connect(tailLP);

  // send tail to panner (mixed with main voice)
  tailDelay.connect(tailGain);
  tailGain.connect(panner);

  // route through per-AudioContext master output to allow global compression/mastering
  panner.connect(getMasterOutput(audioCtx));

  // Schedule a detailed note event to fire at the audible `startTime` so visuals
  // align with when the note actually becomes audible. Using a scheduled
  // timeout keeps the visual event in sync with the audio timeline.
  try {
    const cid =
      circle && circle.getAttribute
        ? circle.getAttribute('data-circle-id')
        : null;
    // Use normalizedBaseGain as a proxy for amplitude; scale into [0..1] range for UI.
    const intensity = Math.min(1, Math.max(0, normalizedBaseGain * 1.6));
    const detail = {
      circleId: cid,
      freq: Number(baseFreq.toFixed(2)),
      duration: useDuration,
      intensity,
    };
    // Compute delay from audio context time to align the DOM event with `startTime`
    const delayMs = Math.max(
      0,
      Math.round((startTime - (audioCtx?.currentTime ?? 0)) * 1000)
    );
    const dispatchFn = () => {
      try {
        const ev = new CustomEvent('svg-playground:note', { detail });
        document.dispatchEvent(ev);
      } catch {
        /* ignore dispatch errors */
      }
    };
    // If the event should fire immediately or nearly immediately, dispatch on next tick
    if (delayMs <= 20) {
      window.setTimeout(dispatchFn, 0);
    } else {
      window.setTimeout(dispatchFn, delayMs);
    }
  } catch {
    /* ignore scheduling/dispatch errors */
  }

  // Create and schedule oscillators. Track them in the state map via helper.
  detunes.forEach((detune) => {
    const osc = audioCtx.createOscillator();
    osc.type = analysis.avgDashLength > 0.2 ? 'sine' : 'triangle';
    // Use sanitized baseFreq and detune to set oscillator frequency.
    osc.frequency.value = baseFreq * (1 + detune / 1200);

    // Per-oscillator gain so harmonics sum remains controlled. Use the normalized
    // per-voice level computed earlier (normalizedBaseGain).
    const oscGain = audioCtx.createGain();
    // defensive floor to avoid silent voices
    oscGain.gain.value = Math.max(0.0001, normalizedBaseGain);

    // Connect oscillator through its gain into the shared filter so the filter sees
    // the summed harmonic content while each voice keeps its own amplitude control.
    osc.connect(oscGain);
    oscGain.connect(filter);

    // Start/stop scheduling aligned to note envelope
    try {
      osc.start(startTime);
      // Stop slightly after the release completes to ensure the ramp has time to finish.
      osc.stop(noteEnd + NOTE_STOP_SLACK_SEC + 0.02);
    } catch {
      try {
        osc.start();
        osc.stop(audioCtx.currentTime + useDuration + NOTE_STOP_SLACK_SEC);
      } catch {
        // ignore
      }
    }

    // Track oscillator + gain for later cleanup and real-time gain control
    addActiveOscillator(circle, osc, oscGain, normalizedBaseGain);
  });

  // Schedule tail envelope: keep tail active during note, then fade it out smoothly.
  // Compute tail duration (how long to let feedback decay)
  const tailDuration = Math.max(NOTE_RELEASE_SEC, NOTE_STOP_SLACK_SEC);

  try {
    // initial tail level ~50% of voice base (scaled by yFactor for consistency)
    // slightly lower initial tail level and gentler scaling with y position
    const tailInitial = Math.max(0.01, 0.04 + yFactor * 0.12);
    // ensure tailGain is set for current context
    const nowSched = audioCtx.currentTime;
    tailGain.gain.setValueAtTime(0, nowSched);
    // start tail slightly before note end so feedback network has energy
    tailGain.gain.linearRampToValueAtTime(
      tailInitial,
      noteEnd - Math.min(0.01, tailDuration / 4)
    );
    // at note end, begin a smooth linear ramp to 0 over tailDuration
    tailGain.gain.setValueAtTime(tailInitial, noteEnd);
    tailGain.gain.linearRampToValueAtTime(0, noteEnd + tailDuration);
  } catch {
    // if scheduling fails, set a conservative static gain
    tailGain.gain.value = Math.max(0.01, 0.04 + yFactor * 0.1);
  }

  // Cleanup: disconnect tail nodes after the tail has finished to free resources.
  const cleanupMs = Math.round(
    (tailDuration + NOTE_STOP_SLACK_SEC + 0.05) * 1000
  );
  window.setTimeout(() => {
    try {
      tailDelay.disconnect();
    } catch {
      // ignore errors during tail node cleanup
    }
    try {
      tailFeedback.disconnect();
    } catch {
      // ignore errors during tail node cleanup
    }
    try {
      tailLP.disconnect();
    } catch {
      // ignore errors during tail node cleanup
    }
    try {
      tailGain.disconnect();
    } catch {
      // ignore errors during tail node cleanup
    }
  }, cleanupMs);
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

  // Defensive clamping of position-derived values to ensure audible mapping in edge regions.
  const x = Math.max(0, Math.min(pos.x ?? 0, window.innerWidth));
  const y = Math.max(0, Math.min(pos.y ?? 0, window.innerHeight));
  // Compute pan from X position but clamp to a reduced range to avoid hard-panned silent cases.
  const PAN_LIMIT = 0.85;
  const rawPan = (x / Math.max(1, window.innerWidth)) * 2 - 1;
  const pan = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, rawPan));
  // Mark the circle when we've clamped the pan value so overlays can indicate the change.
  try {
    if (pan !== rawPan) circle.setAttribute('data-pan-clamped', '1');
    else circle.removeAttribute('data-pan-clamped');
  } catch {
    /* ignore DOM write failures */
  }
  const yNorm = Math.max(0, Math.min(1, y / Math.max(1, window.innerHeight)));
  const yFactor = 1 - yNorm;

  const noteIndex = Math.floor(rng() * noteScale.length);
  const baseFreq = noteScale[noteIndex];

  const mainGain = audioCtx.createGain();
  // start silent and ramp in to avoid clicks / clipping
  mainGain.gain.setValueAtTime(0, audioCtx.currentTime);

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.max(
    minFilterFreq(audioCtx),
    500 + pan * 2000 + yFactor * 3000
  );
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan });
  filter.connect(mainGain);
  mainGain.connect(panner);
  // Connect live-preview panner to the master output as well so preview and loop use same final path.
  panner.connect(getMasterOutput(audioCtx));

  const harmonics = 1 + Math.floor(analysis.complexity / 3);
  const detunes = Array.from(
    { length: harmonics },
    (_, i) => i * 5 * (rng() > 0.5 ? 1 : -1)
  );

  // Schedule the live preview start slightly in the future and ramp the gain up.
  // Use a gentler attack and slightly lower preview level to avoid transient clipping.
  const now = audioCtx.currentTime;
  // start a bit further ahead so the gain ramp is in effect before audible energy
  const startAt = now + 0.05;
  // use a minimum preview attack to smooth initial transients (25ms)
  const attackTime = Math.max(0.025, (analysis.avgDashLength || 0) * 0.12);
  const baseGainRaw = 0.08 + yFactor * 0.25;
  // Match playRichTone: scale by 1 / sqrt(harmonics) so multiple voices sum consistently,
  // then reduce preview level to keep headroom for live-generated spikes.
  let scaledBaseGain = (baseGainRaw / Math.sqrt(Math.max(1, harmonics))) * 0.75;
  // enforce a sensible minimum preview gain so positions at the edges remain audible
  scaledBaseGain = Math.max(0.01, scaledBaseGain);

  try {
    mainGain.gain.setValueAtTime(0, now);
    mainGain.gain.linearRampToValueAtTime(scaledBaseGain, startAt + attackTime);
  } catch {
    // ignore scheduling failures; fall back to instantaneous set
    mainGain.gain.value = scaledBaseGain;
  }
  // Persist a baseGain marker on the gain node so runtime compensation can
  // restore/set levels for live preview nodes immediately when sensitivity changes.
  try {
    (mainGain as GainNode & { __baseGain?: number }).__baseGain =
      scaledBaseGain;
  } catch {
    // ignore if property assignment is restricted
  }

  const oscillators: OscillatorNode[] = detunes.map((detune) => {
    const osc = audioCtx.createOscillator();
    osc.type = analysis.avgDashLength > 0.2 ? 'sine' : 'triangle';
    osc.frequency.value = baseFreq * (1 + detune / 1200);
    osc.connect(filter);
    // start scheduled slightly in the future to line up with the gain ramp
    try {
      osc.start(startAt);
    } catch {
      // fallback for environments that disallow scheduled start
      try {
        osc.start();
      } catch {
        /* ignore */
      }
    }
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

  // Delay slightly longer than the fade + note release & stop slack to ensure ramps and oscillator stops complete.
  // Include an extra small safety margin to account for scheduling variability.
  const extraMs = Math.round(
    (NOTE_STOP_SLACK_SEC + NOTE_RELEASE_SEC + 0.02) * 1000
  );
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
    Math.round(LIVE_AUDIO_FADE_SEC * 1000) + extraMs + 20
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
  const baseScale = chooseScale(analysis);

  const pos = getPos(circle) ?? { x: 0, y: 0 };
  // Defensive clamping for looped circles so audio mapping remains audible at edges.
  const x = Math.max(0, Math.min(pos.x ?? 0, window.innerWidth));
  const y = Math.max(0, Math.min(pos.y ?? 0, window.innerHeight));
  // Compute pan from X position but clamp to a reduced range to avoid hard-panned silent cases.
  const PAN_LIMIT = 0.85;
  const rawPan = (x / Math.max(1, window.innerWidth)) * 2 - 1;
  const pan = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, rawPan));
  // Mark the circle when we've clamped the pan value so overlays can indicate the change.
  try {
    if (pan !== rawPan) circle.setAttribute('data-pan-clamped', '1');
    else circle.removeAttribute('data-pan-clamped');
  } catch {
    /* ignore DOM write failures */
  }
  const yNorm = Math.max(0, Math.min(1, y / Math.max(1, window.innerHeight)));
  const yFactor = 1 - yNorm;

  // Use circle position to derive a musical transpose (reduced range) and ignore octave bias:
  // - x maps to a semitone transpose roughly in [-4..+4] (reduced from [-6..+6])
  // - y no longer shifts octave to avoid consistently high pitches
  const transposeSemis = Math.round((x / window.innerWidth - 0.5) * 8);
  // octave shift removed to keep pitches lower on average

  const semitoneFactor = Math.pow(2, transposeSemis / 12);

  // Build a transposed scale to use for this circle (no octave multiplication)
  const scale = baseScale.map((f) => f * semitoneFactor);

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

        // Map segment length to a scale degree:
        // - normalizedLen in (0..1), where larger values are longer dashes
        // - longer dashes map toward lower indices (closer to tonic)
        const normalizedLen = seg.length / totalLength;
        const baseIndex = Math.round((1 - normalizedLen) * (scale.length - 1));
        const jitterOffset = Math.floor((rng() - 0.5) * 2); // -1, 0, or +1
        let noteIndex = Math.max(
          0,
          Math.min(scale.length - 1, baseIndex + jitterOffset)
        );

        // Extra bias: for relatively long dashes, prefer tonic (index 0)
        if (normalizedLen > 0.25) noteIndex = 0;

        let freq = scale[noteIndex] * (0.995 + rng() * 0.01);
        // Clamp scheduled frequency to an audible range to avoid inaudible / subsonic notes
        // (octave-shift if necessary). This prevents "dead" low-frequency notes at certain positions.
        if (!isFinite(freq) || freq <= 0) freq = 440;
        while (freq < 40) freq *= 2;
        while (freq > 5000) freq /= 2;
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

          // NOTE: Event dispatch moved to `playRichTone` so UI receives synth-derived intensity.
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

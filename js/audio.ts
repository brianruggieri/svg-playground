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
import { getGlowController } from './glow';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type VoiceProfile = {
  spectral: number; // 0..1 bright <-> dark
  texture: number; // 0..1 detune/cluster
  motion: number; // 0..1 attack/release/glide
  space: number; // 0..1 stereo/reverb
  presetName?: string;
};

/**
 * Map a normalized 4-axis voice profile into concrete synth-safe parameters.
 * The mapping is intentionally conservative for mobile (caps partials / detune).
 */
export function mapProfileToParams(
  p: VoiceProfile,
  audioCtx: AudioContext,
  isMobile?: boolean
): {
  partialCount: number;
  brightFlag: boolean;
  detuneVoices: number;
  detuneSpreadCents: number;
  attack: number;
  release: number;
  glideMs: number;
  panSpread: number;
  reverbSend: number;
  filterFreq: number;
} {
  const S = Math.max(0, Math.min(1, p.spectral));
  const T = Math.max(0, Math.min(1, p.texture));
  const M = Math.max(0, Math.min(1, p.motion));
  const P = Math.max(0, Math.min(1, p.space));

  const uaMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent || '');
  const mobile = typeof isMobile === 'boolean' ? isMobile : uaMobile;

  const partialCap = mobile ? 8 : 16;
  const partialCount = Math.min(partialCap, 1 + Math.round(6 * S));
  const brightFlag = S > 0.6;

  const detuneVoices = mobile
    ? Math.max(1, Math.round(1 + Math.floor(2 * T)))
    : Math.max(1, Math.round(1 + Math.floor(3 * T)));
  const detuneSpreadCents = T * (mobile ? 12 : 24);

  const attack = 0.006 + 0.174 * M; // 0.006..0.18
  const release = 0.04 + 1.16 * M; // 0.04..1.2
  const glideMs = Math.round(140 * M);

  const panSpread = 0.6 * P;
  const reverbSend = 0.22 * P;

  const sr = audioCtx.sampleRate || 44100;
  const minFilter = Math.max(40, sr * 0.001);
  const filterFreq = Math.max(
    minFilter,
    Math.round(500 + (12000 - 500) * S * (1 - 0.1 * (1 - P)))
  );

  return {
    partialCount,
    brightFlag,
    detuneVoices,
    detuneSpreadCents,
    attack,
    release,
    glideMs,
    panSpread,
    reverbSend,
    filterFreq,
  };
}

/**
 * Return a PeriodicWave cached on the audio context if available; otherwise build one.
 * Key is based on harmonic count and a shape flag. This helper is used by the voice profile
 * pipeline to prefer PeriodicWave synthesis where available for efficient rich timbres.
 */
function getOrCreatePeriodicWave(
  audioCtx: AudioContext,
  harmonics: number,
  bright: boolean
): PeriodicWave | undefined {
  try {
    const ctxAny = audioCtx as unknown as {
      __pwCache?: Map<string, PeriodicWave>;
    };
    let cache = ctxAny.__pwCache;
    if (!cache) {
      cache = new Map();
      ctxAny.__pwCache = cache;
    }
    const key = `h${Math.max(1, harmonics)}_${bright ? 'b' : 's'}`;
    const existing = cache.get(key);
    if (existing) return existing;

    const partialCount = Math.max(1, Math.min(32, harmonics)); // cap partials
    const real = new Float32Array(partialCount + 1);
    const imag = new Float32Array(partialCount + 1);
    for (let i = 1; i <= partialCount; i++) {
      // amplitude falloff; slightly brighter when requested
      const baseAmp = 1 / i;
      const softness = bright ? 1.0 : 0.82;
      real[i] = baseAmp * softness;
      imag[i] = 0;
    }
    const pw = audioCtx.createPeriodicWave(real, imag, {
      disableNormalization: false,
    });
    cache.set(key, pw);
    return pw;
  } catch {
    return undefined;
  }
}

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
 *
 * New: accepts an optional `voiceProfile` that will be mapped via `mapProfileToParams`
 * to influence partial count, detune spread and envelope defaults.
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
  analysis: ReturnType<typeof analyzeSegments>,
  voiceProfile?: VoiceProfile
): void {
  // Sanitize pan / yFactor and base frequency to avoid inaudible / out-of-range values.
  const PAN_LIMIT = 0.85;
  const panClamped = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, pan));
  try {
    if (panClamped !== pan) circle.setAttribute('data-pan-clamped', '1');
    else circle.removeAttribute('data-pan-clamped');
  } catch {
    /* ignore DOM write failures in constrained contexts */
  }
  const yFactorClamped = Math.max(0, Math.min(1, yFactor));
  const baseFreq = Math.max(40, Math.min(20000, freq));

  // Compute harmonic count early so we can normalize per-voice amplitude.
  const baseHarmonics = 1 + Math.floor(analysis.complexity / 3);
  const baseGainRaw = Math.max(0.02, 0.1 + yFactorClamped * 0.3);
  let normalizedBaseGain =
    (baseGainRaw / Math.sqrt(Math.max(1, baseHarmonics))) *
    PER_VOICE_GAIN_MULTIPLIER;

  // If a voiceProfile is provided, map it to concrete params and prefer its periodic wave
  const mapped = voiceProfile
    ? mapProfileToParams(voiceProfile, audioCtx)
    : null;
  const pw =
    (mapped &&
      getOrCreatePeriodicWave(
        audioCtx,
        mapped.partialCount,
        mapped.brightFlag
      )) ??
    getOrCreatePeriodicWave(
      audioCtx,
      baseHarmonics,
      analysis.avgDashLength <= 0.2
    );

  // Compute detune offsets (spread around 0) based on mapped params or analysis-derived harmonics.
  const detuneCount = mapped?.detuneVoices ?? Math.max(1, baseHarmonics);
  const detuneSpread = mapped?.detuneSpreadCents ?? 8;
  const detuneOffsets = Array.from(
    { length: Math.max(1, detuneCount) },
    (_, i) => {
      const n = Math.max(1, detuneCount - 1);
      const pos = n === 0 ? 0 : (i - n / 2) / n; // -0.5..0.5
      const jitter = (rng() - 0.5) * (detuneSpread * 0.25);
      return pos * detuneSpread + jitter;
    }
  );

  // Compute filter / envelope defaults; mapProfile may override attack/release
  const rawFilterFreq = 500 + panClamped * 2000 + yFactorClamped * 3000;
  const minF = minFilterFreq(audioCtx);
  const willFilterBeClamped = rawFilterFreq < minF;
  if (willFilterBeClamped) {
    const deficit = (minF - rawFilterFreq) / Math.max(minF, 1);
    const COMP_MIN = 1.0;
    const COMP_MAX = 2.2;
    type WindowWithComp = Window & {
      __FILTER_COMPENSATION_SENSITIVITY?: number;
    };
    const w = window as unknown as WindowWithComp;
    const sensitivity = Math.max(
      0,
      Math.min(5, Number(w.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0))
    );
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

  // Shared nodes for this note
  const masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  const useDuration = Math.max(duration, MIN_NOTE_DURATION_SEC);
  let attackTime = Math.min(
    Math.max(MIN_ATTACK_SEC, (analysis.avgDashLength || 0) * 0.1),
    useDuration * 0.45
  );
  let releaseTime = Math.min(useDuration * 0.5, NOTE_RELEASE_SEC);

  if (mapped) {
    try {
      attackTime = Math.max(
        MIN_ATTACK_SEC,
        Math.min(useDuration * 0.45, mapped.attack)
      );
      releaseTime = Math.max(
        0.001,
        Math.min(useDuration * 0.5, mapped.release)
      );
    } catch {
      /* ignore mapping errors */
    }
  }

  const noteEnd = startTime + useDuration;

  // Master envelope on the per-note gain
  masterGain.gain.setValueAtTime(0.0001, startTime);
  try {
    masterGain.gain.linearRampToValueAtTime(1.0, startTime + attackTime);
    masterGain.gain.setValueAtTime(1.0, noteEnd - releaseTime);
    masterGain.gain.linearRampToValueAtTime(0.0001, noteEnd);
  } catch {
    masterGain.gain.value = 1.0;
    window.setTimeout(
      () => {
        try {
          masterGain.gain.value = 0;
        } catch {
          /* ignore */
        }
      },
      Math.max(0, Math.round((noteEnd - audioCtx.currentTime) * 1000))
    );
  }

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.max(minFilterFreq(audioCtx), rawFilterFreq);
  filter.Q.value = 1 + (analysis.dashGapRatio || 0) * 5;

  const panner = new StereoPannerNode(audioCtx, { pan: panClamped });

  // route: detuned oscillators -> filter -> masterGain -> panner -> master output
  filter.connect(masterGain);
  masterGain.connect(panner);
  panner.connect(getMasterOutput(audioCtx));

  // Per-note tail network (keeps previous tail behavior)
  const tailLP = audioCtx.createBiquadFilter();
  tailLP.type = 'lowpass';
  tailLP.frequency.value = 1200;

  const tailDelay = audioCtx.createDelay();
  try {
    tailDelay.delayTime.value = 0.035;
  } catch {
    /* ignore */
  }

  const tailFeedback = audioCtx.createGain();
  tailFeedback.gain.value = 0.28;

  const tailGain = audioCtx.createGain();

  tailLP.connect(tailDelay);
  tailDelay.connect(tailFeedback);
  tailFeedback.connect(tailLP);
  tailDelay.connect(tailGain);
  tailGain.connect(panner);

  // Visual dispatch moved to per-voice scheduler (schedulePooledNote primary voice).
  // The visual enqueue is handled when the primary voice is scheduled so glows only
  // appear when audio is actually scheduled/played.

  // Create and schedule individual detuned voices via helper so we can optionally use
  // PeriodicWave or other mapped parameters per voice while keeping the shared filter/master path.
  detuneOffsets.forEach((off, idx) => {
    const f = Math.max(40, baseFreq * (1 + off / 1200));
    schedulePooledNote({
      audioCtx,
      freq: f,
      pan: panClamped,
      duration: useDuration,
      startTime,
      circle,
      analysis,
      periodicWave: pw,
      masterFilter: filter,
      baseGain: normalizedBaseGain,
      // mark primary voice (first detune) so only it enqueues the glow
      isPrimary: idx === 0,
    });
  });

  // Tail envelope scheduling (same behavior as before)
  const tailDuration = Math.max(NOTE_RELEASE_SEC, NOTE_STOP_SLACK_SEC);
  try {
    const tailInitial = Math.max(0.01, 0.04 + yFactorClamped * 0.12);
    const nowSched = audioCtx.currentTime;
    tailGain.gain.setValueAtTime(0, nowSched);
    tailGain.gain.linearRampToValueAtTime(
      tailInitial,
      noteEnd - Math.min(0.01, tailDuration / 4)
    );
    tailGain.gain.setValueAtTime(tailInitial, noteEnd);
    tailGain.gain.linearRampToValueAtTime(0, noteEnd + tailDuration);
  } catch {
    tailGain.gain.value = Math.max(0.01, 0.04 + yFactorClamped * 0.1);
  }

  // Cleanup tail network after it's done
  const cleanupMs = Math.round(
    (tailDuration + NOTE_STOP_SLACK_SEC + 0.05) * 1000
  );
  window.setTimeout(() => {
    try {
      tailDelay.disconnect();
    } catch {
      /* ignore */
    }
    try {
      tailFeedback.disconnect();
    } catch {
      /* ignore */
    }
    try {
      tailLP.disconnect();
    } catch {
      /* ignore */
    }
    try {
      tailGain.disconnect();
    } catch {
      /* ignore */
    }
  }, cleanupMs);
}

/**
 * Schedule a single detuned voice into the provided shared filter/master path.
 * This mirrors the previous per-oscillator scheduling behavior but centralizes
 * per-voice setup so higher-level callers (like playRichTone) can reuse nodes.
 */
function schedulePooledNote(params: {
  audioCtx: AudioContext;
  freq: number;
  pan: number;
  duration: number;
  startTime: number;
  circle: SVGCircleElement;
  analysis: ReturnType<typeof analyzeSegments>;
  periodicWave?: PeriodicWave | undefined;
  masterFilter: BiquadFilterNode;
  baseGain: number;
  isPrimary?: boolean;
}): void {
  try {
    const {
      audioCtx,
      freq,
      startTime,
      duration,
      circle,
      periodicWave,
      masterFilter,
      baseGain,
      isPrimary,
    } = params;

    // If this is the primary voice for the note, enqueue one glow visual now
    // that audio is actually scheduled. Percussion uses the same single-enqueue
    // path in notifyGlowScheduled.
    try {
      if (isPrimary && circle && circle.getAttribute) {
        const cid = circle.getAttribute('data-circle-id');
        const glow = getGlowController();
        if (glow && cid) {
          glow.setAudioContext?.(audioCtx);
          glow.enqueueScheduled?.(cid, startTime);
        }
      }
    } catch {
      // ignore any glow enqueue errors to keep audio scheduling robust
    }

    const useDuration = Math.max(duration, MIN_NOTE_DURATION_SEC);
    const noteEnd = startTime + useDuration;

    const osc = audioCtx.createOscillator();
    // choose a basic waveform; PeriodicWave will override if provided
    osc.type = 'sine';

    // If a PeriodicWave is provided, prefer it for richer timbres without many oscillators
    try {
      if (periodicWave) {
        try {
          osc.setPeriodicWave(periodicWave);
        } catch {
          // ignore (some engines restrict while running)
        }
      }
    } catch {
      // ignore
    }

    try {
      osc.frequency.setValueAtTime(
        Math.max(20, freq),
        Math.max(audioCtx.currentTime, startTime - 0.02)
      );
    } catch {
      try {
        osc.frequency.value = Math.max(20, freq);
      } catch {
        // ignore
      }
    }

    const oscGain = audioCtx.createGain();
    oscGain.gain.value = Math.max(0.0001, baseGain);

    // Connect into the shared filter so per-voice content is processed by the same filter & tail.
    try {
      osc.connect(oscGain);
      oscGain.connect(masterFilter);
    } catch {
      // best-effort connections
    }

    // Start/stop scheduling aligned to note envelope
    try {
      osc.start(startTime);
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
    try {
      addActiveOscillator(circle, osc, oscGain, baseGain);
    } catch {
      // ignore
    }
  } catch {
    // swallow errors to avoid affecting scheduling loop
  }
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
 * Small 808-style instrument helpers integrated with existing scheduling.
 *
 * These helpers are intentionally lightweight and use short-lived oscillators/noise
 * for percussive hits (kick/snare/hat). For bass/sub content we delegate to
 * `playRichTone()` using a conservative `VoiceProfile`.
 *
 * They are safe to call from `loopCircleAudio` and swallow internal errors so
 * scheduling remains robust.
 */
/**
 * Enqueue a single glow flash aligned with a percussion hit's audio start time.
 * Percussion notes are single-voice (no detuned stack like playRichTone), so this
 * is the only glow notification for the note — nothing else flashes for it.
 */
function notifyGlowScheduled(
  audioCtx: AudioContext,
  circle: SVGCircleElement,
  startTime: number
): void {
  try {
    const cid = circle?.getAttribute?.('data-circle-id');
    if (!cid) return;
    const glow = getGlowController();
    if (!glow) return;
    glow.setAudioContext?.(audioCtx);
    glow.enqueueScheduled?.(cid, startTime);
  } catch {
    // ignore glow notification errors to keep audio scheduling robust
  }
}

function play808Kick(
  audioCtx: AudioContext,
  freqBase: number,
  startTime: number,
  dashMs: number,
  circle: SVGCircleElement
) {
  try {
    const start = Math.max(audioCtx.currentTime, startTime);
    notifyGlowScheduled(audioCtx, circle, start);
    const pitchStart = Math.max(60, freqBase * 1.6);
    const pitchEnd = Math.max(30, freqBase * 0.4);
    const dur = Math.max(0.14, Math.min(0.9, dashMs / 1000));
    const pitchDropTime = Math.max(0.06, dur * 0.28);

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    try {
      osc.frequency.setValueAtTime(pitchStart, start);
      osc.frequency.exponentialRampToValueAtTime(
        pitchEnd,
        start + pitchDropTime
      );
    } catch {
      try {
        osc.frequency.value = pitchStart;
      } catch {}
    }

    const g = audioCtx.createGain();
    try {
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(1.0, start + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    } catch {
      g.gain.value = 0.75;
      window.setTimeout(
        () => {
          try {
            g.gain.value = 0;
          } catch {}
        },
        Math.round(dur * 1000)
      );
    }

    // optional sub oscillator for weight
    const sub = audioCtx.createOscillator();
    sub.type = 'sine';
    try {
      sub.frequency.setValueAtTime(Math.max(25, pitchEnd / 2), start);
    } catch {
      try {
        sub.frequency.value = Math.max(25, pitchEnd / 2);
      } catch {}
    }
    const subG = audioCtx.createGain();
    subG.gain.value = 0.18;

    // mild waveshaper
    let shaper: WaveShaperNode | null = null;
    try {
      shaper = audioCtx.createWaveShaper();
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        curve[i] = Math.tanh((i / (n - 1)) * 3 * 2 - 3);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
    } catch {
      shaper = null;
    }

    try {
      osc.connect(g);
      sub.connect(subG);
      subG.connect(g);
      if (shaper) {
        g.connect(shaper);
        shaper.connect(getMasterOutput(audioCtx));
      } else {
        g.connect(getMasterOutput(audioCtx));
      }
    } catch {
      // best-effort connections
    }

    try {
      osc.start(start);
      sub.start(start);
      const stopAt = start + dur + 0.06;
      osc.stop(stopAt);
      sub.stop(stopAt);
    } catch {
      try {
        osc.start();
        sub.start();
        osc.stop(audioCtx.currentTime + dur + 0.06);
        sub.stop(audioCtx.currentTime + dur + 0.06);
      } catch {
        // ignore
      }
    }

    // small click accent
    try {
      const click = audioCtx.createOscillator();
      click.type = 'square';
      const clickG = audioCtx.createGain();
      clickG.gain.setValueAtTime(0.0001, start);
      clickG.gain.linearRampToValueAtTime(0.4, start + 0.006);
      clickG.gain.linearRampToValueAtTime(0.0001, start + 0.02);
      click.frequency.value = 1200 + Math.random() * 200;
      click.connect(clickG);
      clickG.connect(getMasterOutput(audioCtx));
      click.start(start);
      click.stop(start + 0.025);
    } catch {
      /* ignore */
    }

    try {
      addActiveOscillator(circle, osc, g, 1.0);
    } catch {
      /* ignore */
    }
  } catch {
    /* swallow errors */
  }
}

function play808Snare(
  audioCtx: AudioContext,
  startTime: number,
  dashMs: number,
  circle: SVGCircleElement
) {
  try {
    const start = Math.max(audioCtx.currentTime, startTime);
    notifyGlowScheduled(audioCtx, circle, start);
    const dur = Math.max(0.06, Math.min(0.5, dashMs / 1000));

    const bufSize = Math.floor((audioCtx.sampleRate || 44100) * dur);
    const buf = audioCtx.createBuffer(
      1,
      Math.max(1, bufSize),
      audioCtx.sampleRate || 44100
    );
    const data = buf.getChannelData(0);
    for (let i = 0; i < buf.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-6 * (i / buf.length));
    }

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3500 + Math.random() * 1200;
    bp.Q.value = 0.7;

    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    try {
      g.gain.linearRampToValueAtTime(1.0, start + 0.005);
      g.gain.linearRampToValueAtTime(0.0001, start + dur);
    } catch {
      g.gain.value = 0.9;
      window.setTimeout(
        () => {
          try {
            g.gain.value = 0;
          } catch {}
        },
        Math.round(dur * 1000)
      );
    }

    try {
      src.connect(bp);
      bp.connect(g);
      g.connect(getMasterOutput(audioCtx));
    } catch {}
    try {
      src.start(start);
      src.stop(start + dur + 0.02);
    } catch {
      try {
        src.start();
        src.stop(audioCtx.currentTime + dur + 0.02);
      } catch {}
    }

    // tonal body
    try {
      const tone = audioCtx.createOscillator();
      tone.type = 'triangle';
      tone.frequency.value = 160 + Math.random() * 80;
      const tg = audioCtx.createGain();
      tg.gain.setValueAtTime(0.0001, start);
      tg.gain.linearRampToValueAtTime(0.6, start + 0.006);
      tg.gain.linearRampToValueAtTime(0.0001, start + Math.min(0.22, dur));
      tone.connect(tg);
      tg.connect(getMasterOutput(audioCtx));
      tone.start(start);
      tone.stop(start + Math.min(0.22, dur) + 0.03);
    } catch {
      /* ignore */
    }
  } catch {
    /* swallow errors */
  }
}

function play808Hat(
  audioCtx: AudioContext,
  startTime: number,
  dashMs: number,
  circle: SVGCircleElement
) {
  try {
    const start = Math.max(audioCtx.currentTime, startTime);
    notifyGlowScheduled(audioCtx, circle, start);
    const dur = Math.max(0.01, Math.min(0.08, dashMs / 1000));
    const sr = audioCtx.sampleRate || 44100;
    const size = Math.max(1, Math.floor(sr * dur));
    const buf = audioCtx.createBuffer(1, size, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < size; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-10 * (i / size));
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000 + Math.random() * 5000;
    hp.Q.value = 0.4;
    const g = audioCtx.createGain();
    try {
      g.gain.setValueAtTime(1.0, start);
      g.gain.linearRampToValueAtTime(0.0001, start + dur);
    } catch {
      g.gain.value = 0.9;
    }
    try {
      src.connect(hp);
      hp.connect(g);
      g.connect(getMasterOutput(audioCtx));
    } catch {}
    try {
      src.start(start);
      src.stop(start + dur + 0.02);
    } catch {}
  } catch {
    /* swallow */
  }
}

function play808Bass(
  audioCtx: AudioContext,
  freq: number,
  pan: number,
  duration: number,
  startTime: number,
  rng: () => number,
  circle: SVGCircleElement,
  analysis: ReturnType<typeof analyzeSegments>
) {
  try {
    const subProfile: VoiceProfile = {
      spectral: 0.15,
      texture: 0.25,
      motion: 0.35,
      space: 0.05,
      presetName: '808-sub',
    };
    playRichTone(
      audioCtx,
      freq,
      pan,
      duration,
      1 - (circle.getBoundingClientRect().top / window.innerHeight || 0),
      startTime,
      rng,
      circle,
      analysis,
      subProfile
    );
  } catch {
    /* ignore */
  }
}

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
  const _yFactor = 1 - yNorm;

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

          // Map dash duration to 808-style instruments. Short dashes -> hats, mid -> snare,
          // long dashes -> kick or bass based on circle X position. This provides a simple
          // instrument mapping layer on top of existing melodic scheduling.
          try {
            const durMs = dur * 1000;
            const pos = getPos(circle) ?? { x: 0, y: 0 };
            const cx = pos.x ?? 0;
            if (dur < 0.08) {
              // hi-hat
              try {
                play808Hat(audioCtx, t, durMs, circle);
              } catch {
                /* ignore per-instrument errors */
              }
            } else if (dur < 0.25) {
              // snare / clap region
              try {
                play808Snare(audioCtx, t, durMs, circle);
              } catch {
                /* ignore */
              }
            } else {
              // longer notes: choose kick (left side) vs bass (right side)
              try {
                const screenW = window.innerWidth || 0;
                if (cx < screenW * 0.5) {
                  // kick
                  play808Kick(audioCtx, freq, t, durMs, circle);
                } else {
                  // bass: delegate to play808Bass
                  play808Bass(
                    audioCtx,
                    freq,
                    pan,
                    dur,
                    t,
                    rng,
                    circle,
                    analysis
                  );
                }
              } catch {
                /* ignore instrument selection errors */
              }
            }
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

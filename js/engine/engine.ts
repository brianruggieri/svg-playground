/**
 * svg-playground/js/engine/engine.ts
 *
 * Main-thread wrapper around the Rust/WASM AudioWorklet engine — the only
 * API the rest of the app sees. `initEngine` loads the worklet module,
 * compiles the WASM on the main thread (structured-cloneable Module), posts
 * it to the processor, and resolves once the processor reports ready.
 *
 * Takes a BaseAudioContext so the OfflineAudioContext smoke check can use it
 * too; connecting the node into the master chain is the caller's business.
 */

import wasmUrl from './engine.wasm?url';

export type NoteKind = 'tone' | 'kick' | 'snare' | 'hat';

/**
 * Four perceptual axes, all in [0, 1], mapped to synthesis parameters inside
 * the WASM engine (FM index/morph/lowpass, unison/feedback, envelopes/glide,
 * pan spread/delay send).
 */
export interface VoiceProfile {
  spectral: number;
  texture: number;
  motion: number;
  space: number;
}

export interface NoteOptions {
  when: number; // AudioContext time (seconds)
  freq: number;
  durSec: number;
  velocity: number; // 0..1
  pan: number; // -1..1
  kind: NoteKind;
  profile: VoiceProfile;
}

export interface DroneOptions {
  on: boolean;
  freq?: number;
  brightness?: number; // 0..1
}

export interface EngineHandle {
  node: AudioWorkletNode;
  noteCap: number;
  noteOn(o: NoteOptions): void;
  setDrone(o: DroneOptions): void;
  dispose(): void;
}

const KIND_CODE: Record<NoteKind, number> = {
  tone: 0,
  kick: 1,
  snare: 2,
  hat: 3,
};

const DRONE_LEVEL = 0.5;

function isMobile(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  );
}

async function compileWasm(): Promise<WebAssembly.Module> {
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(fetch(wasmUrl));
    } catch {
      // Fall through: some servers mis-type application/wasm.
    }
  }
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  return WebAssembly.compile(bytes);
}

// NaN-safe: Math.min/max propagate NaN, and a single non-finite value reaching
// a voice produces NaN samples that land in the shared ping-pong delay buffer,
// where flush() never clears them — permanently silencing the engine. This ABI
// boundary is the one choke point every note param passes through, so reject
// non-finite here rather than trusting each caller.
const clamp01 = (v: number) =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const finite = (v: number, fallback: number) =>
  Number.isFinite(v) ? v : fallback;

/** Flatten a NoteOptions object into the number-only message the worklet reads. */
function flattenNote(o: NoteOptions) {
  return {
    type: 'noteOn' as const,
    when: finite(o.when, 0),
    kind: KIND_CODE[o.kind],
    freq: finite(o.freq, 440),
    dur: finite(o.durSec, 0.2),
    vel: clamp01(o.velocity),
    pan: Number.isFinite(o.pan) ? Math.max(-1, Math.min(1, o.pan)) : 0,
    s: clamp01(o.profile.spectral),
    t: clamp01(o.profile.texture),
    m: clamp01(o.profile.motion),
    sp: clamp01(o.profile.space),
  };
}

export interface InitEngineOptions {
  // Notes handed to the processor at construction. Needed for an
  // OfflineAudioContext, which does not deliver port messages posted before
  // startRendering(); realtime callers use noteOn() instead.
  notes?: NoteOptions[];
}

export async function initEngine(
  ctx: BaseAudioContext,
  opts: InitEngineOptions = {}
): Promise<EngineHandle> {
  const [module] = await Promise.all([
    compileWasm(),
    ctx.audioWorklet.addModule(
      new URL('./worklet-processor.js', import.meta.url)
    ),
  ]);

  const noteCap = isMobile() ? 12 : 24;

  // The compiled Module (and any offline pre-roll notes) ride in via
  // processorOptions, which the processor constructor reads synchronously —
  // an OfflineAudioContext delivers those before its first render quantum,
  // whereas pre-render port messages are dropped.
  const node = new AudioWorkletNode(ctx, 'svg-playground-engine', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      module,
      voiceCap: noteCap,
      notes: (opts.notes ?? []).map(flattenNote),
    },
  });

  const ready = new Promise<void>((resolve, reject) => {
    node.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; message?: string } | null;
      if (data?.type === 'ready') resolve();
      else if (data?.type === 'error') {
        reject(new Error(data.message ?? 'engine worklet failed'));
      }
    };
  });

  const isOffline =
    typeof OfflineAudioContext !== 'undefined' &&
    ctx instanceof OfflineAudioContext;
  if (isOffline) {
    // The 'ready' reply is only pumped during startRendering(), so blocking on
    // it here would deadlock. The module is already instantiated in the
    // constructor via processorOptions, so resolve immediately.
    node.port.onmessage = null;
  } else {
    await ready;
    node.port.onmessage = null;
  }

  return {
    node,
    noteCap,
    noteOn(o: NoteOptions): void {
      node.port.postMessage(flattenNote(o));
    },
    setDrone(o: DroneOptions): void {
      const now = ctx.currentTime;
      // The bundled DOM lib types AudioParamMap without .get().
      const params = node.parameters as unknown as ReadonlyMap<
        string,
        AudioParam
      >;
      const freq = params.get('droneFreq');
      const bright = params.get('droneBright');
      const level = params.get('droneLevel');
      if (o.freq != null && freq) {
        freq.setTargetAtTime(o.freq, now, 0.03);
      }
      if (o.brightness != null && bright) {
        bright.setTargetAtTime(clamp01(o.brightness), now, 0.03);
      }
      if (level) {
        // ~50ms click-less level ramps; 0 = off.
        level.setTargetAtTime(o.on ? DRONE_LEVEL : 0, now, 0.05);
      }
    },
    dispose(): void {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
      try {
        node.port.close();
      } catch {
        // ignore
      }
    },
  };
}

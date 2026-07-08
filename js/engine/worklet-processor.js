/**
 * svg-playground/js/engine/worklet-processor.js
 *
 * AudioWorklet processor hosting the Rust/WASM synthesis engine.
 *
 * Deliberately dependency-free: AudioWorkletGlobalScope has no fetch or
 * TextDecoder, so the compiled WebAssembly.Module arrives from the main
 * thread via postMessage and is instantiated here. Until the module is
 * ready the processor outputs silence.
 *
 * Note timing: the main thread schedules ahead (0.1 s lookahead), notes
 * arrive as flat-number messages and wait in a time-sorted queue; each
 * process() call starts due notes at their exact frame offset within the
 * 128-frame quantum.
 */

class SvgPlaygroundEngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'droneFreq',
        defaultValue: 220,
        minValue: 20,
        maxValue: 4000,
        automationRate: 'k-rate',
      },
      {
        name: 'droneBright',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'droneLevel',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor(options) {
    super();
    this.wasm = null;
    this.outL = null;
    this.outR = null;
    this.queue = []; // sorted ascending by .when (AudioContext seconds)
    this.port.onmessage = (e) => this.handleMessage(e.data);

    // The compiled Module arrives via processorOptions rather than a port
    // message: processorOptions are available synchronously here in the
    // constructor, which an OfflineAudioContext delivers before its first
    // render quantum (pre-render port messages are not). Any notes passed at
    // construction (used by the offline smoke) are queued the same way.
    const opts = (options && options.processorOptions) || {};
    if (opts.module) {
      this.instantiate(opts.module, opts.voiceCap);
    }
    if (Array.isArray(opts.notes)) {
      for (const n of opts.notes) this.enqueue(n);
    }
  }

  instantiate(module, voiceCap) {
    try {
      // Synchronous instantiation: we already hold a compiled Module with no
      // imports, so there is no async race against offline rendering.
      const ex = new WebAssembly.Instance(module, {}).exports;
      ex.init(sampleRate);
      if (typeof voiceCap === 'number') ex.set_voice_cap(voiceCap);
      // init() allocates (tables, delay lines) and may grow memory, so the
      // output views are created only after it returns.
      this.outL = new Float32Array(ex.memory.buffer, ex.out_l_ptr(), 128);
      this.outR = new Float32Array(ex.memory.buffer, ex.out_r_ptr(), 128);
      this.wasm = ex;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err) });
    }
  }

  enqueue(msg) {
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].when > msg.when) i--;
    q.splice(i, 0, msg);
  }

  handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'module') {
      this.instantiate(msg.module, msg.voiceCap);
    } else if (msg.type === 'noteOn') {
      this.enqueue(msg);
    }
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0];
    if (!this.wasm || !out || out.length === 0) return true;

    const frames = out[0].length;
    const quantumEnd = currentTime + frames / sampleRate;
    while (this.queue.length > 0 && this.queue[0].when < quantumEnd) {
      const n = this.queue.shift();
      const off = Math.max(
        0,
        Math.min(frames - 1, Math.round((n.when - currentTime) * sampleRate))
      );
      this.wasm.note_on(
        off,
        n.kind,
        n.freq,
        n.dur,
        n.vel,
        n.pan,
        n.s,
        n.t,
        n.m,
        n.sp
      );
    }

    this.wasm.set_drone(
      parameters.droneFreq[0],
      parameters.droneBright[0],
      parameters.droneLevel[0]
    );
    this.wasm.process();

    // The audio path never allocates, but recreate the views defensively if
    // the memory ever grew (a grown WebAssembly.Memory detaches old views).
    if (this.outL.length === 0) {
      const ex = this.wasm;
      this.outL = new Float32Array(ex.memory.buffer, ex.out_l_ptr(), 128);
      this.outR = new Float32Array(ex.memory.buffer, ex.out_r_ptr(), 128);
    }

    out[0].set(this.outL.subarray(0, frames));
    if (out.length > 1) out[1].set(this.outR.subarray(0, frames));
    return true;
  }
}

registerProcessor('svg-playground-engine', SvgPlaygroundEngineProcessor);

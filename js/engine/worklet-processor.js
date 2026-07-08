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

    // Preallocated note pool — no allocation, splice, or shift on the audio
    // thread. Each slot is a reused plain object; enqueue copies fields in,
    // process() scans for due notes and frees the slots. A full pool drops the
    // note (a bounded queue is the real-time-safe stance). NOTE_CAP covers the
    // ~0.1 s lookahead across every looping circle with wide margin.
    this.NOTE_CAP = 512;
    this.notes = new Array(this.NOTE_CAP);
    for (let i = 0; i < this.NOTE_CAP; i++) {
      this.notes[i] = {
        active: false,
        when: 0,
        kind: 0,
        freq: 0,
        dur: 0,
        vel: 0,
        pan: 0,
        s: 0,
        t: 0,
        m: 0,
        sp: 0,
      };
    }
    this.noteCount = 0;
    this.dueIdx = new Int32Array(this.NOTE_CAP); // scratch for offset-ordered drain

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
    const slots = this.notes;
    for (let i = 0; i < this.NOTE_CAP; i++) {
      const s = slots[i];
      if (!s.active) {
        s.active = true;
        s.when = msg.when;
        s.kind = msg.kind;
        s.freq = msg.freq;
        s.dur = msg.dur;
        s.vel = msg.vel;
        s.pan = msg.pan;
        s.s = msg.s;
        s.t = msg.t;
        s.m = msg.m;
        s.sp = msg.sp;
        this.noteCount++;
        return;
      }
    }
    // Pool full: drop the note rather than grow (unbounded growth on the audio
    // thread is the thing we are avoiding).
  }

  // Frame offset of a note within the current quantum, clamped to [0, frames).
  offsetOf(when, frames) {
    return Math.max(
      0,
      Math.min(frames - 1, Math.round((when - currentTime) * sampleRate))
    );
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

    if (this.noteCount > 0) {
      const slots = this.notes;
      const due = this.dueIdx;
      let n = 0;
      for (let i = 0; i < this.NOTE_CAP; i++) {
        if (slots[i].active && slots[i].when < quantumEnd) due[n++] = i;
      }
      // Insertion-sort due notes by frame offset ascending so earlier onsets
      // call note_on first and get first pick of voices — a later-in-quantum
      // onset then cannot steal a voice an earlier onset still needs.
      for (let a = 1; a < n; a++) {
        const idx = due[a];
        const key = this.offsetOf(slots[idx].when, frames);
        let b = a - 1;
        while (b >= 0 && this.offsetOf(slots[due[b]].when, frames) > key) {
          due[b + 1] = due[b];
          b--;
        }
        due[b + 1] = idx;
      }
      for (let k = 0; k < n; k++) {
        const s = slots[due[k]];
        this.wasm.note_on(
          this.offsetOf(s.when, frames),
          s.kind,
          s.freq,
          s.dur,
          s.vel,
          s.pan,
          s.s,
          s.t,
          s.m,
          s.sp
        );
        s.active = false;
        this.noteCount--;
      }
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

    // Views and the render quantum are both fixed at 128, so copy directly —
    // subarray() would allocate a fresh view object every quantum on the audio
    // thread (GC pressure). frames is asserted 128 by the AudioWorklet spec.
    out[0].set(this.outL);
    if (out.length > 1) out[1].set(this.outR);
    return true;
  }
}

registerProcessor('svg-playground-engine', SvgPlaygroundEngineProcessor);

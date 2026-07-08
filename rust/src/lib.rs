//! WASM synthesis engine for svg-playground's AudioWorklet.
//!
//! Flat `extern "C"` ABI (f32/u32 scalars only — no wasm-bindgen glue, which
//! assumes TextDecoder/fetch that AudioWorkletGlobalScope lacks). The JS
//! processor calls `process()` once per 128-frame quantum and copies the
//! stereo output from the buffers exposed via `out_l_ptr`/`out_r_ptr`.
//! All allocation happens in `init`; the audio path never allocates.

mod voice;

use core::cell::UnsafeCell;
use voice::{Drone, Kind, PingPong, Tables, Voice, QUANTUM};

pub const MAX_VOICES: usize = 32;
/// Fixed output scale; the main-thread compressor keeps limiting.
const OUTPUT_SCALE: f32 = 0.22;

pub struct Engine {
    sr: f32,
    sr_inv: f32,
    tables: Tables,
    voices: [Voice; MAX_VOICES],
    cap: usize,
    drone: Drone,
    delay: PingPong,
    rng_state: u32,
    out_l: [f32; QUANTUM],
    out_r: [f32; QUANTUM],
    send_l: [f32; QUANTUM],
    send_r: [f32; QUANTUM],
}

impl Engine {
    pub fn new(sample_rate: f32) -> Engine {
        let sr = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate
        } else {
            48000.0
        };
        Engine {
            sr,
            sr_inv: 1.0 / sr,
            tables: Tables::new(),
            voices: [Voice::idle(); MAX_VOICES],
            cap: 24,
            drone: Drone::new(sr),
            delay: PingPong::new(sr),
            rng_state: 0x9e3779b9,
            out_l: [0.0; QUANTUM],
            out_r: [0.0; QUANTUM],
            send_l: [0.0; QUANTUM],
            send_r: [0.0; QUANTUM],
        }
    }

    /// Steal order: free voice → deepest-in-release → oldest.
    fn alloc_voice(&mut self) -> usize {
        let cap = self.cap.min(MAX_VOICES);
        if let Some(i) = self.voices[..cap].iter().position(|v| !v.active) {
            return i;
        }
        let mut best = 0usize;
        let mut best_env = f32::INFINITY;
        let mut found_release = false;
        for (i, v) in self.voices[..cap].iter().enumerate() {
            if v.in_release() && v.env < best_env {
                best = i;
                best_env = v.env;
                found_release = true;
            }
        }
        if found_release {
            return best;
        }
        let mut oldest = 0usize;
        let mut max_age = 0u32;
        for (i, v) in self.voices[..cap].iter().enumerate() {
            if v.age >= max_age {
                max_age = v.age;
                oldest = i;
            }
        }
        oldest
    }

    #[allow(clippy::too_many_arguments)]
    pub fn note_on(
        &mut self,
        offset_frames: u32,
        kind: u32,
        freq: f32,
        dur: f32,
        vel: f32,
        pan: f32,
        spectral: f32,
        texture: f32,
        motion: f32,
        space: f32,
    ) {
        let idx = self.alloc_voice();
        // Borrow (not move) the LCG state so we can persist however many draws
        // this note consumed; advancing by a fixed step would leave the next
        // note a one-step-shifted view of the same stream.
        let mut state = self.rng_state;
        let mut rng = || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (state >> 8) as f32 / 16_777_216.0
        };
        self.voices[idx].note_on(
            self.sr,
            offset_frames,
            Kind::from_u32(kind),
            freq,
            dur,
            vel,
            pan,
            spectral,
            texture,
            motion,
            space,
            &mut rng,
        );
        // Persist the draws this note actually consumed so the next note gets an
        // independent sub-sequence, not a one-step-shifted view.
        self.rng_state = state;
    }

    pub fn set_drone(&mut self, freq: f32, bright: f32, level: f32) {
        self.drone.set_targets(freq, bright, level);
    }

    pub fn process(&mut self) {
        self.out_l = [0.0; QUANTUM];
        self.out_r = [0.0; QUANTUM];
        self.send_l = [0.0; QUANTUM];
        self.send_r = [0.0; QUANTUM];

        let tables = &self.tables;
        for v in self.voices.iter_mut() {
            if v.active {
                v.render(
                    tables,
                    self.sr_inv,
                    &mut self.out_l,
                    &mut self.out_r,
                    &mut self.send_l,
                    &mut self.send_r,
                );
            }
        }

        self.drone.render(
            tables,
            self.sr,
            &mut self.out_l,
            &mut self.out_r,
            &mut self.send_l,
            &mut self.send_r,
        );

        for i in 0..QUANTUM {
            let (dl, dr) = self.delay.process(self.send_l[i], self.send_r[i]);
            self.out_l[i] = (self.out_l[i] + dl) * OUTPUT_SCALE;
            self.out_r[i] = (self.out_r[i] + dr) * OUTPUT_SCALE;
        }
    }
}

/* ------------------------------- Flat ABI --------------------------------- */

struct EngineCell(UnsafeCell<Option<Engine>>);
// SAFETY: the worklet's audio thread is the only caller; WASM here is
// single-threaded by construction.
unsafe impl Sync for EngineCell {}

static ENGINE: EngineCell = EngineCell(UnsafeCell::new(None));

fn with_engine<R>(f: impl FnOnce(&mut Engine) -> R) -> Option<R> {
    let slot = unsafe { &mut *ENGINE.0.get() };
    slot.as_mut().map(f)
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let slot = unsafe { &mut *ENGINE.0.get() };
    *slot = Some(Engine::new(sample_rate));
}

#[no_mangle]
pub extern "C" fn set_voice_cap(n: u32) {
    with_engine(|e| e.cap = (n as usize).clamp(1, MAX_VOICES));
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn note_on(
    offset_frames: u32,
    kind: u32,
    freq: f32,
    dur: f32,
    vel: f32,
    pan: f32,
    spectral: f32,
    texture: f32,
    motion: f32,
    space: f32,
) {
    with_engine(|e| {
        e.note_on(
            offset_frames,
            kind,
            freq,
            dur,
            vel,
            pan,
            spectral,
            texture,
            motion,
            space,
        )
    });
}

#[no_mangle]
pub extern "C" fn set_drone(freq: f32, bright: f32, level: f32) {
    with_engine(|e| e.set_drone(freq, bright, level));
}

#[no_mangle]
pub extern "C" fn out_l_ptr() -> *const f32 {
    with_engine(|e| e.out_l.as_ptr()).unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn out_r_ptr() -> *const f32 {
    with_engine(|e| e.out_r.as_ptr()).unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn process() {
    with_engine(|e| e.process());
}

/* --------------------------------- Tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use super::voice::NUM_TABLES;

    /// A phase that makes wrap() round to exactly 1.0f32 (tiny negatives, which
    /// phase modulation produces) must not index past the guard on the last
    /// morph table. Without the clamp in Tables::lookup this panics (OOB read),
    /// which under panic=abort permanently kills the worklet audio thread.
    #[test]
    fn wavetable_lookup_survives_phase_wrap_to_one() {
        let tables = Tables::new();
        let last = (NUM_TABLES - 1) as f32;
        for &ph in &[-1.0e-8f32, -2.0e-8, -2.5e-8, -1.0e-9, -0.0] {
            let v = tables.morph(last, ph);
            assert!(v.is_finite(), "morph({last}, {ph}) not finite: {v}");
        }
        // Ordinary phase still resolves.
        assert!(tables.morph(last, 0.5).is_finite());
    }

    /// Render 1s containing every note kind plus the drone; the output must
    /// be non-silent, finite everywhere, and stay under full scale.
    #[test]
    fn renders_notes_non_silent_finite_bounded() {
        let mut e = Engine::new(48000.0);
        e.note_on(0, 0, 220.0, 0.8, 0.9, -0.2, 0.6, 0.4, 0.5, 0.3);
        e.note_on(64, 1, 55.0, 0.5, 1.0, -0.5, 0.5, 0.5, 0.5, 0.2);
        e.note_on(32, 2, 190.0, 0.15, 0.8, 0.3, 0.5, 0.5, 0.5, 0.2);
        e.note_on(0, 3, 400.0, 0.06, 0.7, 0.5, 0.5, 0.5, 0.5, 0.2);
        e.set_drone(220.0, 0.7, 0.6);

        let quanta = 48000 / QUANTUM; // 1 second
        let mut peak = 0.0f32;
        let mut sum_abs = 0.0f64;
        for _ in 0..quanta {
            e.process();
            for i in 0..QUANTUM {
                let l = e.out_l[i];
                let r = e.out_r[i];
                assert!(l.is_finite() && r.is_finite(), "non-finite sample");
                peak = peak.max(l.abs()).max(r.abs());
                sum_abs += (l.abs() + r.abs()) as f64;
            }
        }
        assert!(peak > 0.01, "output is effectively silent (peak {peak})");
        assert!(peak < 1.0, "output clips (peak {peak})");
        assert!(sum_abs > 1.0, "energy too low ({sum_abs})");
    }

    /// A note scheduled with an intra-quantum offset must start silent and
    /// become audible after the offset — sample-accurate onset.
    #[test]
    fn note_offset_is_sample_accurate() {
        let mut e = Engine::new(48000.0);
        e.note_on(100, 0, 440.0, 0.5, 1.0, 0.0, 0.8, 0.2, 0.9, 0.0);
        e.process();
        let before: f32 = e.out_l[..100]
            .iter()
            .chain(e.out_r[..100].iter())
            .fold(0.0, |a, v| a.max(v.abs()));
        assert!(before < 1.0e-6, "audio before the note offset ({before})");
        let mut peak_after = 0.0f32;
        for _ in 0..40 {
            e.process();
            for i in 0..QUANTUM {
                peak_after = peak_after.max(e.out_l[i].abs());
            }
        }
        assert!(peak_after > 0.005, "note never became audible ({peak_after})");
    }

    /// Voice stealing must never exceed the cap and always succeed.
    #[test]
    fn voice_stealing_respects_cap() {
        let mut e = Engine::new(48000.0);
        e.cap = 8;
        for i in 0..40 {
            e.note_on(0, 0, 200.0 + i as f32 * 10.0, 1.0, 0.8, 0.0, 0.5, 0.5, 0.5, 0.5);
            e.process();
        }
        let active = e.voices.iter().filter(|v| v.active).count();
        assert!(active <= 8, "active voices {active} exceed cap 8");
    }
}

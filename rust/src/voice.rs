//! DSP for the worklet engine: wavetables, the 4-op FM voice (tones and
//! percussion patches on the same struct), the drawing drone, and the shared
//! stereo ping-pong delay.

use core::f32::consts::PI;

pub const QUANTUM: usize = 128;
pub const TABLE_SIZE: usize = 2048;
pub const NUM_TABLES: usize = 4;
const TWO_PI: f32 = 2.0 * PI;
/// Phase modulation in table-lookup land is normalized phase (0..1 = one
/// cycle), so an "FM index in radians" gets scaled by 1/2π.
const PM_SCALE: f32 = 1.0 / TWO_PI;

#[inline]
fn wrap(p: f32) -> f32 {
    p - p.floor()
}

/// Flush denormals in feedback paths only; everywhere else the signal path
/// decays to true zero via envelope gating.
#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1.0e-20 {
        0.0
    } else {
        x
    }
}

#[inline]
fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// One-pole smoothing/lowpass coefficient for a given cutoff.
#[inline]
fn onepole_coef(cutoff_hz: f32, sr: f32) -> f32 {
    1.0 - (-TWO_PI * cutoff_hz / sr).exp()
}

/* ------------------------------ Wavetables ------------------------------- */

/// Four morph tables, each TABLE_SIZE+1 samples (guard sample for lerp):
/// 0 sine, 1 soft (1/n²), 2 bright (1/n, 16 harmonics), 3 hollow (odd 1/n).
/// The 16-harmonic cap is the anti-aliasing stance: at the melodic register
/// this engine plays (≤ ~1 kHz fundamentals) partials stay below Nyquist.
pub struct Tables {
    data: Vec<f32>,
}

impl Tables {
    pub fn new() -> Self {
        let stride = TABLE_SIZE + 1;
        let mut data = vec![0.0f32; NUM_TABLES * stride];
        for t in 0..NUM_TABLES {
            let table = &mut data[t * stride..(t + 1) * stride];
            for (i, out) in table.iter_mut().take(TABLE_SIZE).enumerate() {
                let x = TWO_PI * (i as f32) / (TABLE_SIZE as f32);
                *out = match t {
                    0 => x.sin(),
                    1 => harmonic_sum(x, |n| 1.0 / ((n * n) as f32), false),
                    2 => harmonic_sum(x, |n| 1.0 / (n as f32), false),
                    _ => harmonic_sum(x, |n| 1.0 / (n as f32), true),
                };
            }
            let peak = table
                .iter()
                .take(TABLE_SIZE)
                .fold(0.0f32, |a, &v| a.max(v.abs()))
                .max(1.0e-9);
            let norm = 0.95 / peak;
            for v in table.iter_mut().take(TABLE_SIZE) {
                *v *= norm;
            }
            table[TABLE_SIZE] = table[0];
        }
        Tables { data }
    }

    #[inline]
    fn lookup(&self, table: usize, phase: f32) -> f32 {
        let p = wrap(phase) * TABLE_SIZE as f32;
        // wrap() can round to exactly 1.0 for tiny negative phases (f32), which
        // would make i == TABLE_SIZE and read past the guard sample. Clamp so
        // the last table stays in bounds; frac then ≈1.0 reads the guard
        // (== table[0]), i.e. correct wraparound.
        let i = (p as usize).min(TABLE_SIZE - 1);
        let frac = p - i as f32;
        let base = table * (TABLE_SIZE + 1) + i;
        let a = self.data[base];
        let b = self.data[base + 1];
        a + (b - a) * frac
    }

    #[inline]
    pub fn sine(&self, phase: f32) -> f32 {
        self.lookup(0, phase)
    }

    /// Crossfaded lookup across the morph axis, position in [0, NUM_TABLES-1].
    #[inline]
    pub fn morph(&self, position: f32, phase: f32) -> f32 {
        let pos = position.clamp(0.0, (NUM_TABLES - 1) as f32);
        let lo = pos as usize;
        let hi = (lo + 1).min(NUM_TABLES - 1);
        let frac = pos - lo as f32;
        let a = self.lookup(lo, phase);
        let b = self.lookup(hi, phase);
        a + (b - a) * frac
    }
}

fn harmonic_sum(x: f32, amp: impl Fn(usize) -> f32, odd_only: bool) -> f32 {
    let mut acc = 0.0;
    let mut n = 1;
    while n <= 16 {
        acc += amp(n) * ((n as f32) * x).sin();
        n += if odd_only { 2 } else { 1 };
    }
    acc
}

/* --------------------------------- Voice --------------------------------- */

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Tone,
    Kick,
    Snare,
    Hat,
}

impl Kind {
    pub fn from_u32(v: u32) -> Kind {
        match v {
            1 => Kind::Kick,
            2 => Kind::Snare,
            3 => Kind::Hat,
            _ => Kind::Tone,
        }
    }
}

/// Per-note parameters derived once in `note_on` from the VoiceProfile axes.
#[derive(Clone, Copy)]
pub struct Voice {
    pub active: bool,
    kind: Kind,
    delay: u32, // frames until the note starts (intra-quantum offset)
    pub age: u32,
    dur_samples: f32,
    freq: f32,
    vel: f32,
    gain_l: f32,
    gain_r: f32,
    send: f32,

    // amp envelope: linear attack then exponential decay
    attack_samples: f32,
    amp_decay_mul: f32,
    pub env: f32,

    // FM-index envelope (the "bloom"): linear attack, exp decay to a floor
    idx_attack_samples: f32,
    idx_decay_mul: f32,
    idx_floor: f32,
    idx_env: f32,
    fm_index: f32,

    // pitch glide (tones) / pitch sweep (kick)
    glide_samples: f32,
    glide_from_mul: f32,
    sweep_state: f32,
    sweep_mul: f32,

    // oscillators
    ph1a: f32,
    ph1b: f32,
    ph2: f32,
    ph3: f32,
    ph4: f32,
    ratio2: f32,
    detune_a: f32,
    detune_b: f32,
    morph: f32,
    sheen_level: f32,
    fb4: f32,
    fb4_state: f32,

    // per-voice filters (one-pole)
    lp_coef: f32,
    lp_state: f32,
    hp_coef: f32,
    hp_state: f32,
}

impl Voice {
    pub const fn idle() -> Voice {
        Voice {
            active: false,
            kind: Kind::Tone,
            delay: 0,
            age: 0,
            dur_samples: 0.0,
            freq: 440.0,
            vel: 0.0,
            gain_l: 0.0,
            gain_r: 0.0,
            send: 0.0,
            attack_samples: 1.0,
            amp_decay_mul: 0.0,
            env: 0.0,
            idx_attack_samples: 1.0,
            idx_decay_mul: 0.0,
            idx_floor: 0.0,
            idx_env: 0.0,
            fm_index: 0.0,
            glide_samples: 0.0,
            glide_from_mul: 1.0,
            sweep_state: 0.0,
            sweep_mul: 0.0,
            ph1a: 0.0,
            ph1b: 0.0,
            ph2: 0.0,
            ph3: 0.0,
            ph4: 0.0,
            ratio2: 1.0,
            detune_a: 1.0,
            detune_b: 1.0,
            morph: 0.0,
            sheen_level: 0.0,
            fb4: 0.0,
            fb4_state: 0.0,
            lp_coef: 1.0,
            lp_state: 0.0,
            hp_coef: 0.0,
            hp_state: 0.0,
        }
    }

    /// True once the attack phase is over (candidate for "deepest in release").
    #[inline]
    pub fn in_release(&self) -> bool {
        self.active && (self.age as f32) > self.attack_samples
    }

    #[allow(clippy::too_many_arguments)]
    pub fn note_on(
        &mut self,
        sr: f32,
        offset_frames: u32,
        kind: Kind,
        freq: f32,
        dur: f32,
        vel: f32,
        pan: f32,
        spectral: f32,
        texture: f32,
        motion: f32,
        space: f32,
        rng: &mut impl FnMut() -> f32,
    ) {
        let s = clamp01(spectral);
        let t = clamp01(texture);
        let m = clamp01(motion);
        let sp = clamp01(space);
        let freq = if freq.is_finite() && freq > 0.0 {
            freq.clamp(20.0, 8000.0)
        } else {
            440.0
        };
        let dur = if dur.is_finite() { dur.clamp(0.02, 8.0) } else { 0.2 };

        *self = Voice::idle();
        self.active = true;
        self.kind = kind;
        self.delay = offset_frames;
        self.freq = freq;
        self.vel = clamp01(vel).max(0.02);
        self.dur_samples = dur * sr;

        // Per-note pan spread scales with the space axis.
        let pan = (pan + (rng() * 2.0 - 1.0) * 0.6 * sp).clamp(-1.0, 1.0);
        let angle = (pan + 1.0) * PI / 4.0;
        self.gain_l = angle.cos();
        self.gain_r = angle.sin();

        match kind {
            Kind::Tone => {
                self.fm_index = 0.5 + 4.5 * s;
                self.morph = s * (NUM_TABLES - 1) as f32;
                self.sheen_level = 0.25 * s;
                self.lp_coef = onepole_coef(800.0 * 15.0f32.powf(s), sr);
                let detune_cents = 12.0 * t;
                self.detune_a = (2.0f32).powf(detune_cents / 1200.0);
                self.detune_b = (2.0f32).powf(-detune_cents / 1200.0);
                let base_ratio = if s < 0.34 {
                    1.0
                } else if s < 0.67 {
                    2.0
                } else {
                    3.0
                };
                self.ratio2 = base_ratio * (1.0 + (rng() - 0.5) * 0.04 * t);
                self.fb4 = 0.35 * t;

                let attack = (0.006 + 0.174 * (1.0 - m)).min(0.3 * dur);
                self.attack_samples = (attack * sr).max(1.0);
                let decay_samples =
                    (self.dur_samples - self.attack_samples).max(sr * 0.03);
                self.amp_decay_mul = (-7.6 / decay_samples).exp(); // ≈ -66 dB at dur

                let idx_attack = (0.002 + 0.06 * (1.0 - m)).min(0.25 * dur);
                self.idx_attack_samples = (idx_attack * sr).max(1.0);
                let idx_tau = dur * (0.25 + 0.5 * (1.0 - m));
                self.idx_decay_mul = (-1.0 / (idx_tau * sr).max(1.0)).exp();
                self.idx_floor = 0.15;

                self.glide_samples = (0.120 * m * sr).max(1.0);
                self.glide_from_mul = 0.97;

                self.send = 0.35 * sp;
                // Spread unison phases so voices don't all cancel/pile up.
                self.ph1b = 0.37;
            }
            Kind::Kick => {
                // Pitch-swept sine 180 → 45 Hz plus a 15 ms knock partial.
                self.sweep_state = 1.0;
                self.sweep_mul = (-1.0 / (0.045 * sr)).exp();
                self.attack_samples = (0.003 * sr).max(1.0);
                let tau = (dur * 0.6).clamp(0.08, 0.45);
                self.amp_decay_mul = (-1.0 / (tau * sr)).exp();
                // Reuse the index envelope as the knock envelope (5 ms tau);
                // zero attack so it decays from 1 starting at the first sample.
                self.idx_attack_samples = 0.0;
                self.idx_decay_mul = (-1.0 / (0.005 * sr)).exp();
                self.idx_env = 1.0;
                self.send = 0.15 * sp;
            }
            Kind::Snare => {
                // Tonal FM body + high-feedback pitched-noise op, highpassed.
                self.freq = freq.clamp(150.0, 250.0);
                self.ratio2 = 1.5;
                self.fm_index = 1.8;
                self.fb4 = 1.5; // >1: chaotic feedback = pitched noise
                self.hp_coef = onepole_coef(1800.0, sr);
                self.attack_samples = (0.001 * sr).max(1.0);
                let tau = dur.clamp(0.08, 0.18);
                self.amp_decay_mul = (-1.0 / (tau * sr)).exp();
                // Body decays faster than the noise: reuse the index env.
                self.idx_attack_samples = 0.0;
                self.idx_decay_mul = (-1.0 / (0.09 * sr)).exp();
                self.idx_env = 1.0;
                self.send = 0.2 * sp;
            }
            Kind::Hat => {
                // Inharmonic two-modulator chain (8.17 → 5.41 → carrier).
                self.freq = freq.clamp(200.0, 600.0);
                self.fb4 = 1.3;
                self.hp_coef = onepole_coef(6000.0, sr);
                self.attack_samples = (0.001 * sr).max(1.0);
                let tau = (dur * 0.8).clamp(0.02, 0.08);
                self.amp_decay_mul = (-1.0 / (tau * sr)).exp();
                self.send = 0.2 * sp;
            }
        }
    }

    /// Render this voice into the mix/send buffers. Returns false when the
    /// voice finished and freed itself.
    pub fn render(
        &mut self,
        tables: &Tables,
        sr_inv: f32,
        out_l: &mut [f32; QUANTUM],
        out_r: &mut [f32; QUANTUM],
        send_l: &mut [f32; QUANTUM],
        send_r: &mut [f32; QUANTUM],
    ) -> bool {
        let start = self.delay.min(QUANTUM as u32) as usize;
        self.delay = self.delay.saturating_sub(QUANTUM as u32);
        if start >= QUANTUM {
            return true;
        }

        for i in start..QUANTUM {
            // Amp envelope: linear attack, then exponential decay.
            let age = self.age as f32;
            if age < self.attack_samples {
                self.env = age / self.attack_samples;
            } else if age as u32 == self.attack_samples as u32 {
                self.env = 1.0;
            } else {
                self.env *= self.amp_decay_mul;
            }
            // Index envelope (tone bloom / percussion transient).
            if age < self.idx_attack_samples {
                self.idx_env = age / self.idx_attack_samples;
            } else {
                self.idx_env = self.idx_floor
                    + (self.idx_env - self.idx_floor) * self.idx_decay_mul;
            }
            self.age += 1;

            let sig = match self.kind {
                Kind::Tone => self.tick_tone(tables, sr_inv),
                Kind::Kick => self.tick_kick(tables, sr_inv),
                Kind::Snare => self.tick_snare(tables, sr_inv),
                Kind::Hat => self.tick_hat(tables, sr_inv),
            };

            let sample = sig * self.env * self.vel;
            out_l[i] += sample * self.gain_l;
            out_r[i] += sample * self.gain_r;
            if self.send > 0.0 {
                let wet = sample * self.send;
                send_l[i] += wet * self.gain_l;
                send_r[i] += wet * self.gain_r;
            }

            if self.in_release() && self.env < 1.0e-4 {
                self.active = false;
                return false;
            }
        }
        true
    }

    #[inline]
    fn tick_tone(&mut self, tables: &Tables, sr_inv: f32) -> f32 {
        // Pitch glide toward the target frequency.
        let glide = (self.age as f32 / self.glide_samples).min(1.0);
        let f = self.freq * (self.glide_from_mul + (1.0 - self.glide_from_mul) * glide);

        // OP4 (feedback) → OP3 sine one octave up: the "sheen" stack.
        let o4 = tables.sine(self.ph4 + self.fb4 * self.fb4_state * PM_SCALE);
        self.fb4_state = flush(o4);
        self.ph4 = wrap(self.ph4 + 3.5 * f * sr_inv);
        let o3 = tables.sine(self.ph3 + 0.6 * o4 * PM_SCALE);
        self.ph3 = wrap(self.ph3 + 2.0 * f * sr_inv);

        // OP2 → OP1 (morphing carrier, 2-phase unison).
        let o2 = tables.sine(self.ph2);
        self.ph2 = wrap(self.ph2 + self.ratio2 * f * sr_inv);
        let pm = o2 * self.fm_index * self.idx_env * PM_SCALE;
        let o1 = (tables.morph(self.morph, self.ph1a + pm)
            + tables.morph(self.morph, self.ph1b + pm))
            * 0.5;
        self.ph1a = wrap(self.ph1a + f * self.detune_a * sr_inv);
        self.ph1b = wrap(self.ph1b + f * self.detune_b * sr_inv);

        let sig = o1 + o3 * self.sheen_level;
        self.lp_state += self.lp_coef * (sig - self.lp_state);
        self.lp_state
    }

    #[inline]
    fn tick_kick(&mut self, tables: &Tables, sr_inv: f32) -> f32 {
        let f = 45.0 + 135.0 * self.sweep_state;
        self.sweep_state *= self.sweep_mul;
        let body = tables.sine(self.ph1a);
        self.ph1a = wrap(self.ph1a + f * sr_inv);
        // 15 ms knock partial rides the fast index envelope.
        let knock = tables.sine(self.ph2) * self.idx_env * 0.3;
        self.ph2 = wrap(self.ph2 + 1100.0 * sr_inv);
        (body + knock) * 1.1
    }

    #[inline]
    fn tick_snare(&mut self, tables: &Tables, sr_inv: f32) -> f32 {
        // Tonal body: OP2 → OP1 with a fast-decaying index.
        let o2 = tables.sine(self.ph2);
        self.ph2 = wrap(self.ph2 + self.ratio2 * self.freq * sr_inv);
        let body =
            tables.sine(self.ph1a + o2 * self.fm_index * self.idx_env * PM_SCALE);
        self.ph1a = wrap(self.ph1a + self.freq * sr_inv);

        // Pitched noise: chaotic self-feedback oscillator, highpassed.
        let o4 = tables.sine(self.ph4 + self.fb4 * self.fb4_state * PM_SCALE * 8.0);
        self.fb4_state = flush(o4);
        self.ph4 = wrap(self.ph4 + 1400.0 * sr_inv);
        self.hp_state += self.hp_coef * (o4 - self.hp_state);
        let noise = o4 - self.hp_state;

        body * 0.6 * self.idx_env + noise * 0.8
    }

    #[inline]
    fn tick_hat(&mut self, tables: &Tables, sr_inv: f32) -> f32 {
        let f = self.freq;
        let o4 = tables.sine(self.ph4 + self.fb4 * self.fb4_state * PM_SCALE * 8.0);
        self.fb4_state = flush(o4);
        self.ph4 = wrap(self.ph4 + f * 8.17 * sr_inv);
        let o2 = tables.sine(self.ph2 + o4 * 1.2);
        self.ph2 = wrap(self.ph2 + f * 5.41 * sr_inv);
        let o1 = tables.sine(self.ph1a + o2 * 1.5);
        self.ph1a = wrap(self.ph1a + f * 2.0 * sr_inv);
        self.hp_state += self.hp_coef * (o1 - self.hp_state);
        (o1 - self.hp_state) * 1.6
    }
}

/* --------------------------------- Drone --------------------------------- */

/// Continuously-running drawing drone: two detuned morphing carriers with a
/// slow morph LFO and a brightness-tracking lowpass. Parameter targets come
/// from k-rate AudioParams (already ramped on the main thread); a per-sample
/// one-pole here removes the remaining 128-frame zipper.
pub struct Drone {
    t_freq: f32,
    t_bright: f32,
    t_level: f32,
    freq: f32,
    bright: f32,
    level: f32,
    smooth: f32,
    ph_a: f32,
    ph_b: f32,
    lfo_ph: f32,
    lp_state: f32,
}

impl Drone {
    pub fn new(sr: f32) -> Drone {
        Drone {
            t_freq: 220.0,
            t_bright: 0.5,
            t_level: 0.0,
            freq: 220.0,
            bright: 0.5,
            level: 0.0,
            smooth: onepole_coef(40.0, sr),
            ph_a: 0.0,
            ph_b: 0.25,
            lfo_ph: 0.0,
            lp_state: 0.0,
        }
    }

    pub fn set_targets(&mut self, freq: f32, bright: f32, level: f32) {
        if freq.is_finite() && freq > 0.0 {
            self.t_freq = freq.clamp(20.0, 4000.0);
        }
        self.t_bright = clamp01(bright);
        self.t_level = clamp01(level);
    }

    pub fn render(
        &mut self,
        tables: &Tables,
        sr: f32,
        out_l: &mut [f32; QUANTUM],
        out_r: &mut [f32; QUANTUM],
        send_l: &mut [f32; QUANTUM],
        send_r: &mut [f32; QUANTUM],
    ) {
        if self.level < 1.0e-5 && self.t_level < 1.0e-5 {
            self.level = self.t_level;
            return;
        }
        let sr_inv = 1.0 / sr;
        let detune = (2.0f32).powf(7.0 / 1200.0);
        for i in 0..QUANTUM {
            self.freq += self.smooth * (self.t_freq - self.freq);
            self.bright += self.smooth * (self.t_bright - self.bright);
            self.level += self.smooth * (self.t_level - self.level);

            let lfo = tables.sine(self.lfo_ph) * 0.25;
            self.lfo_ph = wrap(self.lfo_ph + 0.13 * sr_inv);
            let morph = (self.bright * (NUM_TABLES - 1) as f32 + lfo)
                .clamp(0.0, (NUM_TABLES - 1) as f32);

            let o = (tables.morph(morph, self.ph_a) + tables.morph(morph, self.ph_b))
                * 0.5;
            self.ph_a = wrap(self.ph_a + self.freq * detune * sr_inv);
            self.ph_b = wrap(self.ph_b + self.freq / detune * sr_inv);

            let coef = onepole_coef(600.0 * 20.0f32.powf(self.bright), sr);
            self.lp_state += coef * (o - self.lp_state);

            let sample = self.lp_state * self.level * 0.5;
            out_l[i] += sample * 0.707;
            out_r[i] += sample * 0.707;
            send_l[i] += sample * 0.21;
            send_r[i] += sample * 0.21;
        }
    }
}

/* ------------------------------ Ping-pong delay --------------------------- */

/// One shared stereo ping-pong delay (181/239 ms, cross-feedback 0.3, 2.5 kHz
/// lowpass in the loop). Replaces the old per-note main-thread tail network.
pub struct PingPong {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    idx_l: usize,
    idx_r: usize,
    lp_l: f32,
    lp_r: f32,
    lp_coef: f32,
}

impl PingPong {
    pub fn new(sr: f32) -> PingPong {
        let len_l = ((0.181 * sr) as usize).max(1);
        let len_r = ((0.239 * sr) as usize).max(1);
        PingPong {
            buf_l: vec![0.0; len_l],
            buf_r: vec![0.0; len_r],
            idx_l: 0,
            idx_r: 0,
            lp_l: 0.0,
            lp_r: 0.0,
            lp_coef: onepole_coef(2500.0, sr),
        }
    }

    #[inline]
    pub fn process(&mut self, in_l: f32, in_r: f32) -> (f32, f32) {
        let rd_l = self.buf_l[self.idx_l];
        let rd_r = self.buf_r[self.idx_r];
        // Cross-feedback through the loop lowpass: L echoes bounce to R.
        self.lp_l += self.lp_coef * (rd_r - self.lp_l);
        self.lp_r += self.lp_coef * (rd_l - self.lp_r);
        self.buf_l[self.idx_l] = flush(in_l + self.lp_l * 0.3);
        self.buf_r[self.idx_r] = flush(in_r + self.lp_r * 0.3);
        self.idx_l += 1;
        if self.idx_l == self.buf_l.len() {
            self.idx_l = 0;
        }
        self.idx_r += 1;
        if self.idx_r == self.buf_r.len() {
            self.idx_r = 0;
        }
        (rd_l, rd_r)
    }
}

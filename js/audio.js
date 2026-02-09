import {
    LIVE_AUDIO_FADE_SEC,
    LOOP_SCHEDULE_AHEAD_SEC,
} from "./constants.js";
import { analyzeSegments, chooseScale } from "./utils.js";

/**
 * Create a shared AudioContext instance.
 * Call this once and reuse across modules.
 */
export function createAudioContext() {
    return new (window.AudioContext || window.webkitAudioContext)();
}

/**
 * Build a small harmonic stack and play a single note segment.
 * Used by the looping playback for finalized circles.
 */
export function playRichTone(
    audioCtx,
    freq,
    pan,
    duration,
    yFactor,
    startTime,
    rng,
    circle,
    analysis,
) {
    const gain = audioCtx.createGain();
    gain.gain.value = 0.1 + yFactor * 0.3;

    const harmonics = 1 + Math.floor(analysis.complexity / 3);
    const detunes = Array.from({ length: harmonics }, (_, i) => {
        return i * 5 * (rng() > 0.5 ? 1 : -1);
    });

    const attackTime = analysis.avgDashLength * 0.1;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(
        gain.gain.value,
        startTime + attackTime,
    );
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    const filter = audioCtx.createBiquadFilter();
    filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
    filter.Q.value = 1 + analysis.dashGapRatio * 5;

    const panner = new StereoPannerNode(audioCtx, { pan });

    filter.connect(gain);
    gain.connect(panner);
    panner.connect(audioCtx.destination);

    detunes.forEach((detune) => {
        const osc = audioCtx.createOscillator();
        osc.type = analysis.avgDashLength > 0.2 ? "sine" : "triangle";
        osc.frequency.value = freq * (1 + detune / 1200);
        osc.connect(filter);
        osc.start(startTime);
        osc.stop(startTime + duration);

        circle._activeOscillators = circle._activeOscillators || [];
        circle._activeOscillators.push(osc);
    });
}

/**
 * Create live audio while the user is actively holding Space.
 * Returns a node bundle for later cleanup.
 */
export function createLiveAudio(audioCtx, circle, analysis, noteScale) {
    const x = circle._pos.x;
    const y = circle._pos.y;
    const pan = (x / window.innerWidth) * 2 - 1;
    const yFactor = y / window.innerHeight;

    const noteIndex = Math.floor(circle._rng() * noteScale.length);
    const baseFreq = noteScale[noteIndex];

    const mainGain = audioCtx.createGain();
    mainGain.gain.value = 0.1 + yFactor * 0.3;

    const filter = audioCtx.createBiquadFilter();
    filter.frequency.value = 500 + pan * 2000 + yFactor * 3000;
    filter.Q.value = 1 + analysis.dashGapRatio * 5;

    const panner = new StereoPannerNode(audioCtx, { pan });
    filter.connect(mainGain);
    mainGain.connect(panner);
    panner.connect(audioCtx.destination);

    const harmonics = 1 + Math.floor(analysis.complexity / 3);
    const detunes = Array.from({ length: harmonics }, (_, i) => {
        return i * 5 * (circle._rng() > 0.5 ? 1 : -1);
    });

    const oscillators = detunes.map((detune) => {
        const osc = audioCtx.createOscillator();
        osc.type = analysis.avgDashLength > 0.2 ? "sine" : "triangle";
        osc.frequency.value = baseFreq * (1 + detune / 1200);
        osc.connect(filter);
        osc.start();
        return osc;
    });

    return { gain: mainGain, filter, panner, oscillators };
}

export function fadeAndCleanupLiveAudio(audioCtx, circle) {
    if (!circle._liveAudioNodes) return;
    const now = audioCtx.currentTime;

    circle._liveAudioNodes.gain.gain.linearRampToValueAtTime(
        0,
        now + LIVE_AUDIO_FADE_SEC,
    );

    setTimeout(() => {
        const nodes = circle._liveAudioNodes;
        if (!nodes) return;

        nodes.oscillators.forEach((osc) => {
            osc.stop();
            osc.disconnect();
        });
        nodes.filter.disconnect();
        nodes.gain.disconnect();
        nodes.panner.disconnect();
        circle._liveAudioNodes = null;
    }, LIVE_AUDIO_FADE_SEC * 1000 + 10);
}

/**
 * Convert dasharray to segments and schedule looping playback.
 * The circle stores its timeout so it can be canceled on clear.
 */
export function loopCircleAudio(audioCtx, circle) {
    const rotationPeriod = circle._holdDuration / 1000;
    const dashArray = circle
        .getAttribute("stroke-dasharray")
        .split(" ")
        .map(Number);
    const totalLength = dashArray.reduce((a, b) => a + b, 0);
    const segmentsLoop = dashArray.map((len, i) => ({
        type: i % 2 === 0 ? "dash" : "gap",
        length: len,
    }));

    const analysis = analyzeSegments(segmentsLoop, totalLength);
    const scale = chooseScale(analysis);

    const x = circle._pos.x;
    const y = circle._pos.y;
    const pan = (x / window.innerWidth) * 2 - 1;
    const yFactor = y / window.innerHeight;

    function scheduleLoopAhead() {
        let t = audioCtx.currentTime + LOOP_SCHEDULE_AHEAD_SEC;

        segmentsLoop.forEach((seg) => {
            const dur = (seg.length / totalLength) * rotationPeriod;
            if (seg.type === "dash" && dur > 0) {
                const noteIndex = Math.floor(circle._rng() * scale.length);
                const freq =
                    scale[noteIndex] * (0.995 + circle._rng() * 0.01);
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
            }
            t += dur;
        });

        circle._loopTimeout = setTimeout(
            scheduleLoopAhead,
            (rotationPeriod - LOOP_SCHEDULE_AHEAD_SEC) * 1000,
        );
    }

    scheduleLoopAhead();
}

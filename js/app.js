import { CIRCLE_CIRCUMFERENCE } from "./constants.js";
import { buildDashArray, analyzeSegments, chooseScale, toSvgPoint } from "./utils.js";
import {
    createAudioContext,
    createLiveAudio,
    fadeAndCleanupLiveAudio,
    loopCircleAudio,
} from "./audio.js";
import { createCircleAt } from "./circles.js";

/**
 * Dash‑Synced Generative Audio Circles
 * Main application module:
 *  - wires DOM events
 *  - drives live preview
 *  - bridges UI state to audio engine
 */

/* ----------------------------- DOM & Context ----------------------------- */
const svg = document.getElementById("canvas");
const clearBtn = document.getElementById("clearBtn");
const audioCtx = createAudioContext();

/* ------------------------------ Global State ------------------------------ */
let currentCircle = null;
let holdStart = null;
let lastSegmentStart = null;
let isSpaceDown = false;
let segments = [];
let rafId = null;

/* ------------------------------ Live Preview ------------------------------ */
function startLivePreview() {
    const tick = () => {
        if (!currentCircle) return;

        const now = performance.now();
        const liveDuration = lastSegmentStart ? now - lastSegmentStart : 0;
        const total = now - holdStart;

        const dashArray = buildDashArray(
            segments,
            isSpaceDown ? "dash" : "gap",
            liveDuration,
            total,
        );

        currentCircle.setAttribute("stroke-dasharray", dashArray);
        currentCircle.setAttribute("stroke-dashoffset", 0.5);

        rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
}

/* ------------------------------ Event Handlers ---------------------------- */
svg.addEventListener("mousedown", (e) => {
    const loc = toSvgPoint(svg, e);
    currentCircle = createCircleAt(svg, loc);

    holdStart = performance.now();
    lastSegmentStart = holdStart;
    segments = [];
    isSpaceDown = false;

    startLivePreview();
});

svg.addEventListener("mouseup", () => {
    if (!currentCircle) return;

    const now = performance.now();
    segments.push({
        type: isSpaceDown ? "dash" : "gap",
        duration: now - lastSegmentStart,
    });

    const total = now - holdStart;
    const dashArray = buildDashArray(segments, null, 0, total);

    // Stop any live audio immediately.
    fadeAndCleanupLiveAudio(audioCtx, currentCircle);

    currentCircle.setAttribute("stroke-dasharray", dashArray);
    currentCircle.setAttribute("stroke-dashoffset", 0.5);
    currentCircle.style.animation = `spin ${total / 1000}s linear infinite`;

    currentCircle._segments = segments.slice();
    currentCircle._holdDuration = total;
    loopCircleAudio(audioCtx, currentCircle);

    cancelAnimationFrame(rafId);
    currentCircle = null;
    segments = [];
    isSpaceDown = false;
    holdStart = null;
    lastSegmentStart = null;
});

document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !currentCircle || isSpaceDown) return;

    const now = performance.now();
    segments.push({
        type: "gap",
        duration: now - lastSegmentStart,
    });
    lastSegmentStart = now;
    isSpaceDown = true;

    const totalDuration = now - holdStart;
    const scale = CIRCLE_CIRCUMFERENCE / totalDuration;
    const currentSegments = segments.map((s) => ({
        ...s,
        length: Math.max(1, Math.round(s.duration * scale)),
    }));

    const analysis = analyzeSegments(currentSegments, CIRCLE_CIRCUMFERENCE);
    const noteScale = chooseScale(analysis);

    currentCircle._liveAudioNodes = createLiveAudio(
        audioCtx,
        currentCircle,
        analysis,
        noteScale,
    );

    e.preventDefault();
});

document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || !currentCircle || !isSpaceDown) return;

    const now = performance.now();
    segments.push({
        type: "dash",
        duration: now - lastSegmentStart,
    });
    lastSegmentStart = now;
    isSpaceDown = false;

    fadeAndCleanupLiveAudio(audioCtx, currentCircle);
    e.preventDefault();
});

/* ------------------------------ Clear All --------------------------------- */
clearBtn.addEventListener("click", () => {
    Array.from(svg.querySelectorAll("circle")).forEach((c) => {
        // Stop any loop scheduling
        if (c._loopTimeout) {
            clearTimeout(c._loopTimeout);
            c._loopTimeout = null;
        }

        // Stop live audio
        if (c._liveAudioNodes) {
            fadeAndCleanupLiveAudio(audioCtx, c);
        }

        // Stop active oscillators
        if (c._activeOscillators) {
            c._activeOscillators.forEach((o) => {
                try {
                    o.stop();
                } catch (_) {}
                o.disconnect();
            });
            c._activeOscillators = [];
        }

        c.remove();
    });
});

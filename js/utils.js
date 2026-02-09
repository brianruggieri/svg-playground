import { CIRCLE_CIRCUMFERENCE, SCALES } from "./constants.js";

/** Simple seeded RNG for deterministic variations per circle. */
export function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomColor() {
    return `hsl(${Math.floor(Math.random() * 360)}, 80%, 55%)`;
}

/**
 * Convert viewport coordinates to SVG coordinates.
 * @param {SVGSVGElement} svg
 * @param {MouseEvent} evt
 */
export function toSvgPoint(svg, evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
}

/**
 * Convert recorded segments + optional live segment into an SVG dasharray.
 * @param {Array<{type:'dash'|'gap', duration:number}>} segments
 * @param {'dash'|'gap'|null} liveType
 * @param {number} liveDuration
 * @param {number} totalDurationMs
 */
export function buildDashArray(
    segments,
    liveType,
    liveDuration,
    totalDurationMs,
) {
    if (totalDurationMs <= 0) return `0 ${CIRCLE_CIRCUMFERENCE}`;

    const scale = CIRCLE_CIRCUMFERENCE / totalDurationMs;
    const all = segments.slice();
    if (liveDuration > 0 && liveType) {
        all.push({ type: liveType, duration: liveDuration });
    }
    if (all.length === 0) return `0 ${CIRCLE_CIRCUMFERENCE}`;

    // Ensure each dash/gap is visible by clamping to at least 1 unit.
    const lens = all.map((s) => Math.max(1, Math.round(s.duration * scale)));
    const out = [];

    // SVG dasharray starts with dash length; if first segment is a gap, insert a 0 dash.
    if (all[0].type === "gap") {
        out.push(0, lens[0]);
        for (let i = 1; i < lens.length; i++) out.push(lens[i]);
    } else {
        for (let i = 0; i < lens.length; i++) out.push(lens[i]);
    }

    return out.join(" ");
}

/**
 * Analyze dash/gap sequence to steer synthesis parameters.
 * @param {Array<{type:'dash'|'gap', length:number}>} segments
 * @param {number} totalLength
 */
export function analyzeSegments(segments, totalLength) {
    const counts = { dash: 0, gap: 0 };
    const avgLengths = { dash: 0, gap: 0 };

    segments.forEach((seg) => {
        counts[seg.type]++;
        avgLengths[seg.type] += seg.length;
    });

    avgLengths.dash = avgLengths.dash / (counts.dash || 1);
    avgLengths.gap = avgLengths.gap / (counts.gap || 1);

    return {
        complexity: segments.length,
        dashGapRatio: counts.dash / (counts.gap || 1),
        avgDashLength: avgLengths.dash / totalLength,
        avgGapLength: avgLengths.gap / totalLength,
    };
}

export function chooseScale(analysis) {
    if (analysis.complexity <= 4) return SCALES.pentatonic;
    return analysis.dashGapRatio > 1 ? SCALES.major : SCALES.minor;
}

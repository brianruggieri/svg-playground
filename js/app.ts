/**
 * svg-playground/js/app.ts
 *
 * Mountable application entry for Dash‑Synced Generative Audio Circles.
 *
 * Exports:
 *  - init(container?, options?) -> { destroy(), audioCtx, getActiveCircleCount() }
 *
 * Notes:
 *  - Uses pointer events for unified mouse/touch/stylus input.
 *  - Expects an SVG element with id="canvas" and a button with id="clearBtn"
 *    to be present inside the provided container (usually document.body).
 */

import { CIRCLE_CIRCUMFERENCE } from './constants';
import {
  buildDashArray,
  analyzeSegments,
  chooseScale,
  toSvgPoint,
  SegmentInput,
  SegmentLength,
  AnalysisResult,
} from './utils';
import {
  createAudioContext,
  createLiveAudio,
  fadeAndCleanupLiveAudio,
  loopCircleAudio,
  playClickTone,
} from './audio';
import { createCircleAt, emotionalExit } from './circles';
import { initGlow } from './glow';
import {
  setSegments,
  setHoldDuration,
  setLiveAudioNodes,
  getLiveAudioNodes,
  getLoopTimeout,
  clearLoopTimeout,
  stopAndClearActiveOscillators,
} from './state';

export type InitOptions = {
  audioCtx?: AudioContext;
};

export type AppInstance = {
  destroy(): void;
  audioCtx: AudioContext;
  getActiveCircleCount(): number;
};

/**
 * Initialize the app inside a container element (or selector).
 *
 * @param container - Element or selector (defaults to document.body)
 * @param options - optional settings (audioCtx can be supplied)
 */
export function init(
  container: Element | string = document.body,
  options: InitOptions = {}
): AppInstance {
  const root =
    typeof container === 'string'
      ? document.querySelector(container)
      : container;
  if (!root) {
    throw new Error('Container element not found for svg-playground.init()');
  }

  const svg = root.querySelector('#canvas') as SVGSVGElement | null;
  const clearBtn = root.querySelector('#clearBtn') as HTMLButtonElement | null;

  if (!svg) {
    throw new Error(
      "SVG element with id 'canvas' not found in container. Ensure the container includes <svg id='canvas'>"
    );
  }
  if (!clearBtn) {
    throw new Error(
      "Clear button with id 'clearBtn' not found in container. Ensure the container includes <button id='clearBtn'>"
    );
  }

  // Narrowed non-null locals for use throughout the function so we don't
  // have to carry `| null` everywhere below.
  const svgEl = svg!;
  const clearBtnEl = clearBtn!;

  const audioCtx = options.audioCtx ?? createAudioContext();
  const glow = initGlow(svgEl, {
    enableDebugPanel: false,
    persistConfig: false,
  });

  // Debug window typing for filter compensation UI.
  // This gives us a typed handle instead of repeatedly casting `window as any`.
  interface WindowWithDebug extends Window {
    __FILTER_COMPENSATION_SENSITIVITY?: number;
  }
  const debugWindow = window as unknown as WindowWithDebug;

  // Instance local state
  let currentCircle: SVGCircleElement | null = null;
  let holdStart: number | null = null;
  let lastSegmentStart: number | null = null;
  let isSpaceDown = false;
  let segments: SegmentInput[] = [];
  let rafId: number | null = null;

  // Keep small registry for cleanup if needed
  const trackedCircles = new Set<SVGCircleElement>();
  // Gate for immediate click tone feedback. Set to true to enable per-pointerdown click tone.
  const ENABLE_CLICK_TONE = false;

  // Debug overlay state: map circles -> overlay elements
  let debugMode = false;

  const overlayMap = new Map<SVGCircleElement, HTMLElement>();
  let debugRaf: number | null = null;

  // Create a simple overlay element showing freq/gain/pan and stick it to the circle.
  function createOverlayForCircle(
    circle: SVGCircleElement,
    clientX: number,
    clientY: number,
    info: {
      freq: number;
      gain: number;
      pan: number;
      filterFreq?: number;
      filterClamped?: boolean;
    }
  ): HTMLElement {
    // If an overlay already exists for this circle, update text and return it.
    const existing = overlayMap.get(circle);
    const filterLine =
      typeof info.filterFreq === 'number'
        ? `filter: ${info.filterFreq.toFixed(1)}Hz${
            info.filterClamped ? ' (clamped)' : ''
          }`
        : '';
    if (existing) {
      try {
        // If overlay was created with structured children, update the info block;
        // otherwise fall back to overwriting textContent.
        const infoEl = existing.querySelector('.overlay-info');
        if (infoEl) {
          infoEl.textContent = `freq: ${info.freq.toFixed(1)}Hz\ngain: ${info.gain.toFixed(
            3
          )}\npan: ${info.pan.toFixed(2)}${filterLine ? '\n' + filterLine : ''}`;
        } else {
          existing.textContent = `freq: ${info.freq.toFixed(1)}Hz\ngain: ${info.gain.toFixed(
            3
          )}\npan: ${info.pan.toFixed(2)}${filterLine ? '\n' + filterLine : ''}`;
        }
        // Update the compensation label if present
        const compLabel = existing.querySelector('.comp-label');
        const globalVal = debugWindow.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0;
        if (compLabel)
          compLabel.textContent = `comp: ${Number(globalVal).toFixed(2)}`;
      } catch {
        existing.textContent = `freq: ${info.freq.toFixed(1)}Hz\ngain: ${info.gain.toFixed(
          3
        )}\npan: ${info.pan.toFixed(2)}${filterLine ? '\n' + filterLine : ''}`;
      }
      return existing;
    }

    const el = document.createElement('div');
    el.className = 'debug-overlay';
    // allow pointer events for controls (slider) while keeping text selection behavior reasonable
    el.style.position = 'absolute';
    el.style.pointerEvents = 'auto';
    el.style.whiteSpace = 'normal';
    el.style.fontFamily = 'monospace';
    el.style.fontSize = '12px';
    el.style.padding = '6px 8px';
    el.style.background = 'rgba(0,0,0,0.85)';
    el.style.color = 'white';
    el.style.borderRadius = '6px';
    el.style.transform = 'translate(-50%, -140%)';
    el.style.zIndex = '9999';
    el.style.minWidth = '120px';
    el.style.boxSizing = 'border-box';
    // Info block (read-only, updated per-frame)
    const infoDiv = document.createElement('div');
    infoDiv.className = 'overlay-info';
    infoDiv.style.whiteSpace = 'pre';
    infoDiv.style.pointerEvents = 'none';
    infoDiv.textContent = `freq: ${info.freq.toFixed(1)}Hz\ngain: ${info.gain.toFixed(
      3
    )}\npan: ${info.pan.toFixed(2)}${filterLine ? '\n' + filterLine : ''}`;
    // Controls (slider) - hidden by default visually compact; visible in debug overlay
    const controls = document.createElement('div');
    controls.className = 'overlay-controls';
    controls.style.marginTop = '6px';
    controls.style.display = 'flex';
    controls.style.alignItems = 'center';
    controls.style.gap = '8px';
    controls.style.pointerEvents = 'auto';
    // slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1.0';
    slider.max = '3.0';
    slider.step = '0.01';
    slider.className = 'comp-slider';
    // initialize global if missing
    if (debugWindow.__FILTER_COMPENSATION_SENSITIVITY == null) {
      debugWindow.__FILTER_COMPENSATION_SENSITIVITY = 1.0;
    }
    slider.value = String(debugWindow.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0);
    slider.style.width = '88px';
    slider.style.verticalAlign = 'middle';
    // label showing current value
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.style.fontSize = '11px';
    label.style.opacity = '0.95';
    label.textContent = `comp: ${Number(slider.value).toFixed(2)}`;
    // wire slider updates to global window var for immediate access by audio code
    slider.addEventListener('input', () => {
      try {
        const v = Number(slider.value) || 1.0;
        debugWindow.__FILTER_COMPENSATION_SENSITIVITY = v;
        label.textContent = `comp: ${v.toFixed(2)}`;
      } catch {
        /* ignore event errors */
      }
    });
    // Assemble overlay
    controls.appendChild(slider);
    controls.appendChild(label);
    el.appendChild(infoDiv);
    el.appendChild(controls);
    document.body.appendChild(el);
    overlayMap.set(circle, el);
    // Position immediately
    try {
      const r = circle.getBoundingClientRect();
      el.style.left = `${r.left + r.width / 2}px`;
      el.style.top = `${r.top + r.height / 2}px`;
    } catch {
      // fallback to client coords if DOM geometry not available
      el.style.left = `${clientX}px`;
      el.style.top = `${clientY}px`;
    }
    return el;
  }

  function removeOverlayForCircle(circle: SVGCircleElement) {
    const el = overlayMap.get(circle);
    if (!el) return;
    try {
      el.remove();
    } catch {
      // ignore
    }
    overlayMap.delete(circle);
  }

  function updateAllOverlays() {
    for (const [circle, el] of overlayMap.entries()) {
      try {
        const r = circle.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        el.style.left = `${cx}px`;
        el.style.top = `${r.top + r.height / 2}px`;

        // recompute mapping values each frame to reflect live changes
        try {
          const pan = Math.max(
            -1,
            Math.min(1, (cx / Math.max(1, window.innerWidth)) * 2 - 1)
          );
          const yNorm = Math.max(
            0,
            Math.min(1, cy / Math.max(1, window.innerHeight))
          );
          const yFactor = 1 - yNorm;
          const freq = 220 * Math.pow(880 / 220, yFactor);
          const gain = Math.max(0.01, 0.06 + yFactor * 0.18);

          // compute filter frequency / clamping consistent with audio mapping
          const sr = (audioCtx && audioCtx.sampleRate) || 44100;
          const minFilter = Math.max(40, sr * 0.001);
          const rawFilter = 500 + pan * 2000 + yFactor * 3000;
          const filterFreq = Math.max(minFilter, rawFilter);
          const filterClamped =
            rawFilter < minFilter ||
            circle.getAttribute('data-pan-clamped') === '1';

          // Update structured overlay children if present to avoid stomping controls
          const infoEl = el.querySelector('.overlay-info');
          if (infoEl) {
            infoEl.textContent = `freq: ${freq.toFixed(1)}Hz\ngain: ${gain.toFixed(
              3
            )}\npan: ${pan.toFixed(2)}\nfilter: ${filterFreq.toFixed(1)}Hz${filterClamped ? ' (clamped)' : ''}`;
          } else {
            el.textContent = `freq: ${freq.toFixed(1)}Hz\ngain: ${gain.toFixed(
              3
            )}\npan: ${pan.toFixed(2)}\nfilter: ${filterFreq.toFixed(1)}Hz${filterClamped ? ' (clamped)' : ''}`;
          }
          // Update compensation label if present
          try {
            const compLabel = el.querySelector('.comp-label');
            const globalVal =
              debugWindow.__FILTER_COMPENSATION_SENSITIVITY ?? 1.0;
            if (compLabel)
              compLabel.textContent = `comp: ${Number(globalVal).toFixed(2)}`;
          } catch {
            // ignore label update failures
          }
        } catch {
          // ignore value-computation errors for overlays
        }
      } catch {
        // ignore geometry errors
      }
    }
    debugRaf = debugMode ? requestAnimationFrame(updateAllOverlays) : null;
  }

  function setDebugMode(on: boolean) {
    debugMode = on;
    if (!debugMode) {
      // remove overlays
      for (const c of Array.from(overlayMap.keys())) {
        removeOverlayForCircle(c);
      }
      if (debugRaf) {
        cancelAnimationFrame(debugRaf);
        debugRaf = null;
      }
    } else {
      // create overlays for existing tracked circles with placeholder info
      for (const c of trackedCircles) {
        // compute approximate values from circle center
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const pan = Math.max(
          -1,
          Math.min(1, (cx / Math.max(1, window.innerWidth)) * 2 - 1)
        );
        const yNorm = Math.max(
          0,
          Math.min(1, cy / Math.max(1, window.innerHeight))
        );
        const yFactor = 1 - yNorm;
        const freq = 220 * Math.pow(880 / 220, yFactor);
        const gain = Math.max(0.01, 0.06 + yFactor * 0.18);
        // compute filter frequency using the same formula as audio; use audioCtx sampleRate to determine min
        try {
          const sr = (audioCtx && audioCtx.sampleRate) || 44100;
          const minFilter = Math.max(40, sr * 0.001);
          const rawFilter = 500 + pan * 2000 + yFactor * 3000;
          const filterFreq = Math.max(minFilter, rawFilter);
          const filterClamped = rawFilter < minFilter;
          createOverlayForCircle(c, cx, cy, {
            freq,
            gain,
            pan,
            filterFreq,
            filterClamped,
          });
        } catch {
          createOverlayForCircle(c, cx, cy, { freq, gain, pan });
        }
      }
      // kick off RAF to keep overlays positioned
      if (!debugRaf) updateAllOverlays();
    }
  }

  // Toggle debug overlay with the 'D' key (case-insensitive)
  document.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyD') {
      const next = !debugMode;
      setDebugMode(next);
      glow.setDebugPanelEnabled(next);
    }
  });

  // Ensure audio starts on first user gesture (some browsers require resume)
  function ensureAudioStarted() {
    if (audioCtx && audioCtx.state === 'suspended') {
      const resumeOnce = () => {
        void audioCtx.resume();
        window.removeEventListener('pointerdown', resumeOnce, {
          capture: true,
        });
      };
      window.addEventListener('pointerdown', resumeOnce, { capture: true });
    }
  }
  ensureAudioStarted();

  // Live preview RAF
  function startLivePreview() {
    function tick() {
      if (!currentCircle || holdStart == null) return;
      const now = performance.now();
      const liveDuration = lastSegmentStart ? now - lastSegmentStart : 0;
      const total = now - holdStart;
      const dashArray = buildDashArray(
        segments,
        isSpaceDown ? 'dash' : 'gap',
        liveDuration,
        total
      );
      currentCircle.setAttribute('stroke-dasharray', dashArray);
      currentCircle.setAttribute('stroke-dashoffset', '0.5');
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  // Finalize current recorded circle into looping playback
  function finalizeCurrentCircle() {
    if (!currentCircle || holdStart == null || lastSegmentStart == null) return;

    const now = performance.now();
    segments.push({
      type: isSpaceDown ? 'dash' : 'gap',
      duration: now - lastSegmentStart,
    });

    const total = now - holdStart;
    const dashArray = buildDashArray(segments, null, 0, total);

    // Fade and cleanup any live audio nodes
    fadeAndCleanupLiveAudio(audioCtx, currentCircle);

    // If the recorded segments contain no 'dash' entries (i.e. no beats),
    // animate the circle out with an emotional exit and cleanup instead of abrupt removal.
    const hasDash = segments.some((s) => s.type === 'dash' && s.duration > 0);
    if (!hasDash) {
      try {
        // Trigger a visible emotional exit animation (shrink + fade).
        // `emotionalExit` will attempt to clear state and remove the SVG elements.
        emotionalExit(currentCircle);
      } catch {
        // ignore animation errors
      }
      try {
        // Remove any debug overlay for this circle (overlay is separate from SVG)
        removeOverlayForCircle(currentCircle);
      } catch {
        // ignore
      }
      try {
        // Ensure we do not track this circle for cleanup
        trackedCircles.delete(currentCircle);
      } catch {
        // ignore
      }

      // reset hold state
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      currentCircle = null;
      segments = [];
      isSpaceDown = false;
      holdStart = null;
      lastSegmentStart = null;
      return;
    }

    // If we have dashes, proceed to set up visible loop and audio
    currentCircle.setAttribute('stroke-dasharray', dashArray);
    currentCircle.setAttribute('stroke-dashoffset', '0.5');
    currentCircle.style.animation = `spin ${total / 1000}s linear infinite`;

    // store metadata for the loop scheduler (WeakMap-backed state)
    setSegments(currentCircle as SVGCircleElement, segments.slice());
    setHoldDuration(currentCircle as SVGCircleElement, total);

    // Debug: log scheduling details to help diagnose looping issues
    try {
      const cx = currentCircle.getAttribute('cx');
      const cy = currentCircle.getAttribute('cy');
      console.debug('[finalizeCurrentCircle] scheduling loop', {
        cx,
        cy,
        total,
        segments: segments.slice(),
        dashArray,
      });
    } catch {
      // ignore debug failures in environments without console
    }

    // schedule looped audio for this circle
    loopCircleAudio(audioCtx, currentCircle);

    // add to tracked set for cleanup
    trackedCircles.add(currentCircle);

    // reset hold state
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    currentCircle = null;
    segments = [];
    isSpaceDown = false;
    holdStart = null;
    lastSegmentStart = null;
  }

  // Abort the current recording (used on pointercancel)
  function abortCurrentRecording() {
    if (!currentCircle) return;
    // fade any live audio, remove the visual circle
    fadeAndCleanupLiveAudio(audioCtx, currentCircle);
    try {
      currentCircle.remove();
    } catch {
      /* ignore */
    }
    currentCircle = null;
    segments = [];
    isSpaceDown = false;
    holdStart = null;
    lastSegmentStart = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // Event handlers (pointer-based)
  function onPointerDown(e: PointerEvent) {
    // Ignore non-primary mouse buttons
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    ensureAudioStarted();

    const loc = toSvgPoint(svgEl, e);
    const created = createCircleAt(svgEl, loc);
    // Type assert into SVGCircleElement
    currentCircle = created as SVGCircleElement;

    // Immediate audible feedback for the click position (guarded)
    try {
      if (ENABLE_CLICK_TONE) {
        playClickTone(audioCtx, e.clientX, e.clientY);
      }
    } catch {
      /* ignore audio errors on constrained platforms */
    }

    // Also create a debug overlay (if debug mode enabled) and attach it to the new circle.
    try {
      // compute pan/yFactor and sample gain/freq similar to audio mapping
      const pan = Math.max(
        -1,
        Math.min(1, (loc.x / Math.max(1, window.innerWidth)) * 2 - 1)
      );
      const yNorm = Math.max(
        0,
        Math.min(1, loc.y / Math.max(1, window.innerHeight))
      );
      const yFactor = 1 - yNorm;
      const freq = 220 * Math.pow(880 / 220, yFactor);
      const gain = Math.max(0.01, 0.06 + yFactor * 0.18);
      if (debugMode && currentCircle) {
        try {
          const sr = (audioCtx && audioCtx.sampleRate) || 44100;
          const minFilter = Math.max(40, sr * 0.001);
          const rawFilter = 500 + pan * 2000 + yFactor * 3000;
          const filterFreq = Math.max(minFilter, rawFilter);
          const filterClamped =
            rawFilter < minFilter ||
            currentCircle.getAttribute('data-pan-clamped') === '1';
          createOverlayForCircle(currentCircle, e.clientX, e.clientY, {
            freq,
            gain,
            pan,
            filterFreq,
            filterClamped,
          });
        } catch {
          createOverlayForCircle(currentCircle, e.clientX, e.clientY, {
            freq,
            gain,
            pan,
          });
        }
      }
    } catch {
      // ignore overlay failures
    }

    holdStart = performance.now();
    lastSegmentStart = holdStart;
    segments = [];
    isSpaceDown = false;

    startLivePreview();
  }

  function onPointerUp() {
    // If no active recording, nothing to do
    if (!currentCircle) return;
    finalizeCurrentCircle();
  }

  function onPointerCancel() {
    abortCurrentRecording();
  }

  // Keyboard handlers for Space to start/stop dash segments
  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== 'Space' || !currentCircle || isSpaceDown) return;

    const now = performance.now();
    segments.push({
      type: 'gap',
      duration: now - (lastSegmentStart ?? now),
    });
    lastSegmentStart = now;
    isSpaceDown = true;

    // compute normalized segment lengths for analysis
    const totalDuration = now - (holdStart ?? now);
    const scale = CIRCLE_CIRCUMFERENCE / Math.max(1, totalDuration);
    const currentSegments: SegmentLength[] = segments.map((s) => ({
      type: s.type,
      length: Math.max(1, Math.round(s.duration * scale)),
    }));

    const analysis: AnalysisResult = analyzeSegments(
      currentSegments,
      CIRCLE_CIRCUMFERENCE
    );
    const noteScale = chooseScale(analysis);

    // create live audio nodes and attach to circle state
    const liveNodes = createLiveAudio(
      audioCtx,
      currentCircle,
      analysis,
      noteScale
    );
    setLiveAudioNodes(currentCircle as SVGCircleElement, liveNodes);

    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== 'Space' || !currentCircle || !isSpaceDown) return;

    const now = performance.now();
    segments.push({
      type: 'dash',
      duration: now - (lastSegmentStart ?? now),
    });
    lastSegmentStart = now;
    isSpaceDown = false;

    fadeAndCleanupLiveAudio(audioCtx, currentCircle);

    e.preventDefault();
  }

  // Clear button handler
  function onClearClick() {
    const circles = Array.from(svgEl.querySelectorAll('circle'));
    for (const c of circles) {
      // cancel loop timeout
      try {
        const maybeTimeout = getLoopTimeout(c);
        if (typeof maybeTimeout === 'number') {
          // clearLoopTimeout will clear the timeout and null the entry in state
          clearLoopTimeout(c);
        }
      } catch {
        // ignore
      }
      // fade live audio
      try {
        const nodes = getLiveAudioNodes(c);
        if (nodes) {
          fadeAndCleanupLiveAudio(audioCtx, c);
        }
      } catch {
        // ignore
      }
      try {
        // stop and clear active oscillators tracked in state
        stopAndClearActiveOscillators(c);
      } catch {
        // ignore
      }
      try {
        c.remove();
      } catch {
        /* ignore */
      }
    }
    trackedCircles.clear();
  }

  // Wire event listeners
  svgEl.addEventListener('pointerdown', onPointerDown);
  // pointerup might happen anywhere; listen on window to ensure we catch it
  window.addEventListener('pointerup', onPointerUp);
  svgEl.addEventListener('pointercancel', onPointerCancel);
  svgEl.addEventListener('pointerleave', onPointerUp);

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  clearBtnEl.addEventListener('click', onClearClick);

  // Return API: destroy handler + useful helpers
  function destroy() {
    svgEl.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    svgEl.removeEventListener('pointercancel', onPointerCancel);
    svgEl.removeEventListener('pointerleave', onPointerUp);

    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);

    clearBtnEl.removeEventListener('click', onClearClick);

    try {
      glow.destroy();
    } catch {
      // ignore
    }

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Stop and cleanup all circles in the svg
    const circles = Array.from(svgEl.querySelectorAll('circle'));
    for (const c of circles) {
      try {
        const maybeTimeout = getLoopTimeout(c);
        if (typeof maybeTimeout === 'number') {
          clearLoopTimeout(c);
        }
      } catch {
        // ignore
      }
      try {
        const nodes = getLiveAudioNodes(c);
        if (nodes) fadeAndCleanupLiveAudio(audioCtx, c);
      } catch {
        // ignore
      }
      try {
        // Stop and clear active oscillators via the state manager
        stopAndClearActiveOscillators(c);
      } catch {
        // ignore
      }
      try {
        const nodes = getLiveAudioNodes(c);
        if (nodes) {
          fadeAndCleanupLiveAudio(audioCtx, c);
        }
      } catch {
        // ignore
      }
      // Remove any per-circle debug overlay if present
      try {
        removeOverlayForCircle(c);
      } catch {
        // ignore
      }
    }
    trackedCircles.clear();

    // Ensure debug overlays cleared and RAF stopped
    try {
      for (const el of Array.from(overlayMap.values())) {
        try {
          el.remove();
        } catch {
          /* ignore */
        }
      }
      overlayMap.clear();
      if (debugRaf) {
        cancelAnimationFrame(debugRaf);
        debugRaf = null;
      }
    } catch {
      // ignore
    }
  }

  return {
    destroy,
    audioCtx,
    getActiveCircleCount: () => svgEl.querySelectorAll('circle').length,
  };
}

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

import { buildDashArray, toSvgPoint, SegmentInput } from './utils';
import {
  createAudioContext,
  initAudioEngine,
  loopCircleAudio,
  previewLiveNote,
  stopAllAudio,
  disposeAudioEngine,
} from './audio';
import { createCircleAt, emotionalExit } from './circles';
import { initGlow } from './glow';
import {
  setSegments,
  setHoldDuration,
  getLoopTimeout,
  clearLoopTimeout,
} from './state';

export type InitOptions = {
  audioCtx?: AudioContext;
};

export type AppInstance = {
  destroy(): void;
  audioCtx: AudioContext;
  getActiveCircleCount(): number;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

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
  // Fire-and-forget: worklet + WASM load fine on a suspended context; notes
  // scheduled before the engine is ready drop silently.
  void initAudioEngine(audioCtx).catch(console.error);
  const glow = initGlow(svgEl, {
    enableDebugPanel: false,
    persistConfig: false,
    // The live-draw RAF rewrites stroke-dasharray every frame; the attr
    // observer would fire a spurious flash on each write.
    config: { enableFallbackAttrObserver: false },
  });

  // Instance local state
  let currentCircle: SVGCircleElement | null = null;
  let holdStart: number | null = null;
  let lastSegmentStart: number | null = null;
  let isSpaceDown = false;
  let segments: SegmentInput[] = [];
  let rafId: number | null = null;

  // Keep small registry for cleanup if needed
  const trackedCircles = new Set<SVGCircleElement>();

  // Debug overlay state: map circles -> overlay elements
  let debugMode = false;
  const overlayMap = new Map<SVGCircleElement, HTMLElement>();
  let debugRaf: number | null = null;

  // Approximate the position→pitch/level mapping for the debug overlay only.
  function positionInfo(cx: number, cy: number) {
    const pan = Math.max(
      -1,
      Math.min(1, (cx / Math.max(1, window.innerWidth)) * 2 - 1)
    );
    const yFactor = 1 - clamp01(cy / Math.max(1, window.innerHeight));
    const freq = 220 * Math.pow(880 / 220, yFactor);
    const gain = Math.max(0.01, 0.06 + yFactor * 0.18);
    return { pan, freq, gain };
  }

  function overlayText(info: {
    freq: number;
    gain: number;
    pan: number;
  }): string {
    return `freq: ${info.freq.toFixed(1)}Hz\ngain: ${info.gain.toFixed(
      3
    )}\npan: ${info.pan.toFixed(2)}`;
  }

  // Create a simple overlay element showing freq/gain/pan and stick it to the circle.
  function createOverlayForCircle(
    circle: SVGCircleElement,
    clientX: number,
    clientY: number,
    info: { freq: number; gain: number; pan: number }
  ): HTMLElement {
    const existing = overlayMap.get(circle);
    if (existing) {
      const infoEl = existing.querySelector('.overlay-info') ?? existing;
      infoEl.textContent = overlayText(info);
      return existing;
    }

    const el = document.createElement('div');
    el.className = 'debug-overlay';
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    el.style.whiteSpace = 'pre';
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

    const infoDiv = document.createElement('div');
    infoDiv.className = 'overlay-info';
    infoDiv.textContent = overlayText(info);
    el.appendChild(infoDiv);

    document.body.appendChild(el);
    overlayMap.set(circle, el);

    try {
      const r = circle.getBoundingClientRect();
      el.style.left = `${r.left + r.width / 2}px`;
      el.style.top = `${r.top + r.height / 2}px`;
    } catch {
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
        el.style.top = `${cy}px`;

        const info = positionInfo(cx, cy);
        const infoEl = el.querySelector('.overlay-info') ?? el;
        infoEl.textContent = overlayText(info);
      } catch {
        // ignore geometry errors
      }
    }
    debugRaf = debugMode ? requestAnimationFrame(updateAllOverlays) : null;
  }

  function setDebugMode(on: boolean) {
    debugMode = on;
    if (!debugMode) {
      for (const c of Array.from(overlayMap.keys())) {
        removeOverlayForCircle(c);
      }
      if (debugRaf) {
        cancelAnimationFrame(debugRaf);
        debugRaf = null;
      }
    } else {
      for (const c of trackedCircles) {
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        createOverlayForCircle(c, cx, cy, positionInfo(cx, cy));
      }
      if (!debugRaf) updateAllOverlays();
    }
  }

  // Toggle debug overlay with the 'D' key (case-insensitive)
  function onDebugKeyDown(ev: KeyboardEvent) {
    if (ev.code === 'KeyD') {
      const next = !debugMode;
      setDebugMode(next);
      glow.setDebugPanelEnabled(next);
    }
  }
  document.addEventListener('keydown', onDebugKeyDown);

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

  // Reset hold state and cancel the live preview RAF.
  function resetHoldState() {
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

    // If the recorded segments contain no 'dash' entries (i.e. no beats),
    // animate the circle out with an emotional exit and cleanup instead of abrupt removal.
    const hasDash = segments.some((s) => s.type === 'dash' && s.duration > 0);
    if (!hasDash) {
      try {
        emotionalExit(currentCircle);
      } catch {
        // ignore animation errors
      }
      removeOverlayForCircle(currentCircle);
      trackedCircles.delete(currentCircle);
      resetHoldState();
      return;
    }

    // If we have dashes, proceed to set up visible loop and audio
    currentCircle.setAttribute('stroke-dasharray', dashArray);
    currentCircle.setAttribute('stroke-dashoffset', '0.5');
    currentCircle.style.animation = `spin ${total / 1000}s linear infinite`;

    // store metadata for the loop scheduler (WeakMap-backed state)
    setSegments(currentCircle as SVGCircleElement, segments.slice());
    setHoldDuration(currentCircle as SVGCircleElement, total);

    // schedule looped audio for this circle
    loopCircleAudio(audioCtx, currentCircle);

    // add to tracked set for cleanup
    trackedCircles.add(currentCircle);

    resetHoldState();
  }

  // Abort the current recording (used on pointercancel)
  function abortCurrentRecording() {
    if (!currentCircle) return;
    try {
      currentCircle.remove();
    } catch {
      /* ignore */
    }
    removeOverlayForCircle(currentCircle);
    resetHoldState();
  }

  // Event handlers (pointer-based)
  function onPointerDown(e: PointerEvent) {
    // Ignore non-primary mouse buttons
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    ensureAudioStarted();

    const loc = toSvgPoint(svgEl, e);
    const created = createCircleAt(svgEl, loc);
    currentCircle = created as SVGCircleElement;

    if (debugMode && currentCircle) {
      createOverlayForCircle(
        currentCircle,
        e.clientX,
        e.clientY,
        positionInfo(e.clientX, e.clientY)
      );
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

    // Audition the loop's voice: each dash-start fires the same FM note the
    // loop will play at that dash's onset, so holding Space previews the
    // finished instrument (not a separate drone).
    if (currentCircle) previewLiveNote(audioCtx, currentCircle);

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

    // Dash ended. The preview note is one-shot and rings out on its own —
    // nothing to silence here.

    e.preventDefault();
  }

  // Clear button handler
  function onClearClick() {
    // Cut audio already scheduled into the worklet (up to one rotation ahead),
    // not just future scheduler ticks — otherwise long circles keep sounding.
    stopAllAudio();
    const circles = Array.from(svgEl.querySelectorAll('circle'));
    for (const c of circles) {
      try {
        if (typeof getLoopTimeout(c) === 'number') clearLoopTimeout(c);
      } catch {
        // ignore
      }
      removeOverlayForCircle(c as SVGCircleElement);
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
    // Disconnect the worklet node and reset the engine singleton so a later
    // mount re-inits against its own context instead of the stale one.
    disposeAudioEngine();

    svgEl.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    svgEl.removeEventListener('pointercancel', onPointerCancel);
    svgEl.removeEventListener('pointerleave', onPointerUp);

    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('keydown', onDebugKeyDown);

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
        if (typeof getLoopTimeout(c) === 'number') clearLoopTimeout(c);
      } catch {
        // ignore
      }
      removeOverlayForCircle(c as SVGCircleElement);
    }
    trackedCircles.clear();

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
  }

  return {
    destroy,
    audioCtx,
    getActiveCircleCount: () => svgEl.querySelectorAll('circle').length,
  };
}

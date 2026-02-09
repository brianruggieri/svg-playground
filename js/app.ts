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
} from './audio';
import { createCircleAt } from './circles';
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

  // Instance local state
  let currentCircle: SVGCircleElement | null = null;
  let holdStart: number | null = null;
  let lastSegmentStart: number | null = null;
  let isSpaceDown = false;
  let segments: SegmentInput[] = [];
  let rafId: number | null = null;

  // Keep small registry for cleanup if needed
  const trackedCircles = new Set<SVGCircleElement>();

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
      } catch (err) {
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
      } catch (err) {
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
      } catch (err) {
        // ignore
      }
      try {
        const nodes = getLiveAudioNodes(c);
        if (nodes) {
          fadeAndCleanupLiveAudio(audioCtx, c);
        }
      } catch (err) {
        // ignore
      }
    }
    trackedCircles.clear();
  }

  return {
    destroy,
    audioCtx,
    getActiveCircleCount: () => svgEl.querySelectorAll('circle').length,
  };
}

/**
 * svg-playground/js/glow.ts
 *
 * Encapsulates glow visuals, event wiring, and optional debug panel for note flashes.
 *
 * Responsibilities:
 *  - Create/maintain an SVG glow layer with blurred halo rings.
 *  - Listen for note events (svg-playground:note) and flash glow rings.
 *  - Optionally create a small debug panel to tune glow settings at runtime.
 *
 * This module is intentionally self-contained and non-invasive.
 */

export type GlowConfig = {
  blur: number; // feGaussianBlur stdDeviation
  opacityMultiplier: number;
  scaleMultiplier: number;
  minOpacity: number;
  maxOpacity: number;
  minScale: number;
  maxScale: number;
  pulseEnabled: boolean;
  pulseDuration: number; // ms
  enableFallbackAttrObserver: boolean;
  enablePointerFallback: boolean;
  throttleMs: number; // min per-circle ms between flashes
  maxConcurrent: number; // max simultaneous glow rings in playing state
};

export type NoteDetail = {
  circleId?: string | null;
  circle?: SVGElement | null;
  freq?: number;
  duration?: number;
  intensity?: number;
};

export type GlowInitOptions = {
  config?: Partial<GlowConfig>;
  enableDebugPanel?: boolean;
  persistConfig?: boolean;
  storageKey?: string;
};

export type GlowController = {
  destroy(): void;
  getConfig(): GlowConfig;
  applyConfig(next: Partial<GlowConfig>): void;
  flash(circle: SVGCircleElement, detail?: NoteDetail): void;
  setDebugPanelEnabled(on: boolean): void;
};

const DEFAULT_CONFIG: GlowConfig = {
  blur: 6,
  opacityMultiplier: 1.0,
  scaleMultiplier: 1.0,
  minOpacity: 0.06,
  maxOpacity: 1.0,
  minScale: 0.9,
  maxScale: 1.4,
  pulseEnabled: true,
  pulseDuration: 360,
  enableFallbackAttrObserver: true,
  enablePointerFallback: true,
  throttleMs: 60,
  maxConcurrent: 24,
};

const DEFAULT_STORAGE_KEY = 'svg-playground.glow-config';

type GlowRing = SVGCircleElement & {
  __glowTimer?: number;
  __lastFlashAt?: number;
};

type GlowState = {
  svg: SVGSVGElement;
  config: GlowConfig;
  glowLayer: SVGGElement;
  debugPanel: HTMLDivElement | null;
  observers: MutationObserver[];
  listeners: Array<() => void>;
  playingCount: number;
  storageKey: string;
  persistConfig: boolean;
};

let __activeState: GlowState | null = null;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toNumber(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function getSvgRoot(svg?: SVGSVGElement | null): SVGSVGElement | null {
  if (svg) return svg;
  const el = document.getElementById('canvas');
  return el instanceof SVGSVGElement ? el : null;
}

function ensureGlowDefs(svg: SVGSVGElement): void {
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }

  let filter = defs.querySelector('#glow');
  if (!filter) {
    filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', 'glow');
    filter.setAttribute('x', '-75%');
    filter.setAttribute('y', '-75%');
    filter.setAttribute('width', '250%');
    filter.setAttribute('height', '250%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    const blur = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'feGaussianBlur'
    );
    blur.setAttribute('stdDeviation', String(DEFAULT_CONFIG.blur));
    blur.setAttribute('result', 'b');

    const matrix = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'feColorMatrix'
    );
    matrix.setAttribute('in', 'b');
    matrix.setAttribute('type', 'matrix');
    matrix.setAttribute(
      'values',
      ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0', '0 0 0 0.9 0'].join('\n')
    );
    matrix.setAttribute('result', 'c');

    const merge = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'feMerge'
    );
    const node1 = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'feMergeNode'
    );
    node1.setAttribute('in', 'c');
    const node2 = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'feMergeNode'
    );
    node2.setAttribute('in', 'SourceGraphic');

    merge.appendChild(node1);
    merge.appendChild(node2);

    filter.appendChild(blur);
    filter.appendChild(matrix);
    filter.appendChild(merge);

    defs.appendChild(filter);
  }
}

function ensureGlowLayer(svg: SVGSVGElement): SVGGElement {
  let layer = svg.querySelector('#glow-layer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('id', 'glow-layer');
    layer.setAttribute('aria-hidden', 'true');
    svg.appendChild(layer);
  }
  return layer as SVGGElement;
}

function readStrokeColor(circle: SVGCircleElement): string {
  let strokeColor = circle.getAttribute('stroke') || '';
  if (!strokeColor && circle.style && circle.style.stroke) {
    strokeColor = circle.style.stroke;
  }
  if (!strokeColor) {
    try {
      const cs = window.getComputedStyle(circle);
      strokeColor = cs ? cs.stroke || cs.getPropertyValue('stroke') : '';
    } catch {
      // ignore
    }
  }
  return strokeColor || '#fff';
}

function createOrSyncGlowRing(
  state: GlowState,
  circle: SVGCircleElement
): GlowRing | null {
  const id = circle.getAttribute('data-circle-id');
  if (!id) return null;

  let ring = state.glowLayer.querySelector(
    `.glow-ring[data-circle-id="${id}"]`
  ) as GlowRing | null;

  if (!ring) {
    ring = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    ) as GlowRing;
    ring.classList.add('glow-ring');
    ring.setAttribute('data-circle-id', id);
    state.glowLayer.appendChild(ring);
  }

  try {
    const cx = circle.getAttribute('cx');
    const cy = circle.getAttribute('cy');
    const r = circle.getAttribute('r');
    ring.setAttribute('cx', cx ?? '0');
    ring.setAttribute('cy', cy ?? '0');
    ring.setAttribute('r', r ?? '0');
    ring.setAttribute('stroke', readStrokeColor(circle));
    ring.setAttribute('filter', 'url(#glow)');
    ring.style.transition =
      'opacity 140ms ease-out, transform 180ms cubic-bezier(.22,.9,.35,1)';
    ring.style.opacity = '0';
    ring.style.transform = 'scale(1)';
    ring.style.pointerEvents = 'none';
    ring.style.transformBox = 'fill-box';
    ring.style.transformOrigin = 'center';
  } catch {
    // best effort
  }

  return ring;
}

function computeAmplitude(detail?: NoteDetail | null): number {
  if (detail && typeof detail.intensity === 'number') {
    return Math.max(0, detail.intensity);
  }
  const dur = Math.max(0.001, Number(detail?.duration) || 0.05);
  const freq = Math.max(20, Number(detail?.freq) || 440);
  const dFactor = Math.tanh(dur * 2.5);
  const fFactor = Math.min(1, Math.log2(freq / 55) / 6);
  const amp = 0.65 * dFactor + 0.35 * fFactor;
  return clamp(amp, 0, 1);
}

function applyFilterConfig(state: GlowState): void {
  try {
    const blur = state.svg.querySelector('#glow feGaussianBlur');
    if (blur) blur.setAttribute('stdDeviation', String(state.config.blur));
  } catch {
    // ignore
  }
}

function shouldThrottle(ring: GlowRing, throttleMs: number): boolean {
  if (throttleMs <= 0) return false;
  const last = ring.__lastFlashAt ?? 0;
  const now = performance.now();
  if (now - last < throttleMs) return true;
  ring.__lastFlashAt = now;
  return false;
}

function flashGlow(
  state: GlowState,
  circle: SVGCircleElement,
  detail?: NoteDetail
): void {
  const ring = createOrSyncGlowRing(state, circle);
  if (!ring) return;

  if (shouldThrottle(ring, state.config.throttleMs)) return;
  const hasActiveTimer = typeof ring.__glowTimer === 'number';
  if (
    state.config.maxConcurrent > 0 &&
    state.playingCount >= state.config.maxConcurrent &&
    !hasActiveTimer
  ) {
    return;
  }

  const duration =
    typeof detail?.duration === 'number'
      ? detail.duration * 1000
      : state.config.pulseEnabled
        ? state.config.pulseDuration
        : 180;

  const amp = computeAmplitude(detail);
  const baseOpacity = clamp(
    amp * state.config.opacityMultiplier,
    state.config.minOpacity,
    state.config.maxOpacity
  );
  const baseScale = clamp(
    1 + amp * (0.25 * state.config.scaleMultiplier),
    state.config.minScale,
    state.config.maxScale
  );

  try {
    ring.style.opacity = String(baseOpacity);
    ring.style.transform = `scale(${baseScale})`;
  } catch {
    // ignore
  }

  try {
    circle.classList.add('emphasized');
  } catch {
    // ignore
  }

  if (state.config.pulseEnabled) {
    ring.classList.add('playing');
    circle.classList.add('emphasized');
  }

  if (typeof ring.__glowTimer === 'number') {
    clearTimeout(ring.__glowTimer);
    ring.__glowTimer = undefined;
    state.playingCount = Math.max(0, state.playingCount - 1);
  }

  state.playingCount += 1;

  ring.__glowTimer = window.setTimeout(
    () => {
      try {
        ring.style.opacity = '0';
        ring.style.transform = 'scale(1)';
        circle.classList.remove('emphasized');
        if (state.config.pulseEnabled) {
          ring.classList.remove('playing');
          circle.classList.remove('emphasized');
        }
      } catch {
        // ignore
      } finally {
        state.playingCount = Math.max(0, state.playingCount - 1);
        ring.__glowTimer = undefined;
      }
    },
    Math.max(80, duration)
  );
}

function loadPersistedConfig(storageKey: string): Partial<GlowConfig> | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GlowConfig>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistConfig(state: GlowState): void {
  if (!state.persistConfig) return;
  try {
    localStorage.setItem(state.storageKey, JSON.stringify(state.config));
  } catch {
    // ignore
  }
}

function createDebugPanel(state: GlowState): HTMLDivElement {
  const panel = document.createElement('div');
  panel.setAttribute('id', 'glow-debug-panel');
  panel.style.position = 'fixed';
  panel.style.right = '18px';
  panel.style.top = '72px';
  panel.style.zIndex = '10000';
  panel.style.padding = '10px';
  panel.style.background = 'rgba(16,16,16,0.86)';
  panel.style.color = '#fff';
  panel.style.border = '1px solid rgba(255,255,255,0.06)';
  panel.style.borderRadius = '8px';
  panel.style.fontFamily = 'sans-serif';
  panel.style.fontSize = '12px';
  panel.style.width = '260px';
  panel.style.boxShadow = '0 4px 18px rgba(0,0,0,0.6)';

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <strong>Glow Debug</strong>
      <button id="glow-debug-close" style="background:transparent;border:0;color:#fff;cursor:pointer">✕</button>
    </div>
    <label>Blur: <span id="g-blur-val">${state.config.blur}</span></label>
    <input id="g-blur" type="range" min="0" max="20" step="1" value="${state.config.blur}" style="width:100%"/>
    <label>Opacity ×: <span id="g-op-val">${state.config.opacityMultiplier.toFixed(2)}</span></label>
    <input id="g-op" type="range" min="0" max="3" step="0.01" value="${state.config.opacityMultiplier}" style="width:100%"/>
    <label>Scale ×: <span id="g-scale-val">${state.config.scaleMultiplier.toFixed(2)}</span></label>
    <input id="g-scale" type="range" min="0.25" max="3" step="0.01" value="${state.config.scaleMultiplier}" style="width:100%"/>
    <label>Pulse:</label>
    <select id="g-pulse" style="width:100%;margin-bottom:6px">
      <option value="on" ${state.config.pulseEnabled ? 'selected' : ''}>On</option>
      <option value="off" ${!state.config.pulseEnabled ? 'selected' : ''}>Off</option>
    </select>
    <label>Pulse duration (ms): <span id="g-pulse-val">${state.config.pulseDuration}</span></label>
    <input id="g-pulse-dur" type="range" min="60" max="1000" step="10" value="${state.config.pulseDuration}" style="width:100%"/>
    <label>Throttle (ms): <span id="g-throttle-val">${state.config.throttleMs}</span></label>
    <input id="g-throttle" type="range" min="0" max="500" step="10" value="${state.config.throttleMs}" style="width:100%"/>
    <label>Max concurrent: <span id="g-max-val">${state.config.maxConcurrent}</span></label>
    <input id="g-max" type="range" min="1" max="64" step="1" value="${state.config.maxConcurrent}" style="width:100%"/>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button id="g-apply" style="flex:1;padding:6px;border-radius:6px;border:0;background:#2e7d32;color:#fff;cursor:pointer">Apply</button>
      <button id="g-reset" style="flex:1;padding:6px;border-radius:6px;border:0;background:#666;color:#fff;cursor:pointer">Reset</button>
    </div>
  `;

  document.body.appendChild(panel);

  const blurIn = panel.querySelector('#g-blur') as HTMLInputElement | null;
  const blurVal = panel.querySelector('#g-blur-val') as HTMLElement | null;
  const opIn = panel.querySelector('#g-op') as HTMLInputElement | null;
  const opVal = panel.querySelector('#g-op-val') as HTMLElement | null;
  const scaleIn = panel.querySelector('#g-scale') as HTMLInputElement | null;
  const scaleVal = panel.querySelector('#g-scale-val') as HTMLElement | null;
  const pulseIn = panel.querySelector('#g-pulse') as HTMLSelectElement | null;
  const pulseDurIn = panel.querySelector(
    '#g-pulse-dur'
  ) as HTMLInputElement | null;
  const pulseDurVal = panel.querySelector('#g-pulse-val') as HTMLElement | null;
  const throttleIn = panel.querySelector(
    '#g-throttle'
  ) as HTMLInputElement | null;
  const throttleVal = panel.querySelector(
    '#g-throttle-val'
  ) as HTMLElement | null;
  const maxIn = panel.querySelector('#g-max') as HTMLInputElement | null;
  const maxVal = panel.querySelector('#g-max-val') as HTMLElement | null;
  const applyBtn = panel.querySelector('#g-apply') as HTMLButtonElement | null;
  const resetBtn = panel.querySelector('#g-reset') as HTMLButtonElement | null;
  const closeBtn = panel.querySelector(
    '#glow-debug-close'
  ) as HTMLButtonElement | null;

  if (blurIn && blurVal) {
    blurIn.addEventListener('input', () => {
      blurVal.textContent = blurIn.value;
    });
  }
  if (opIn && opVal) {
    opIn.addEventListener('input', () => {
      opVal.textContent = Number(opIn.value).toFixed(2);
    });
  }
  if (scaleIn && scaleVal) {
    scaleIn.addEventListener('input', () => {
      scaleVal.textContent = Number(scaleIn.value).toFixed(2);
    });
  }
  if (pulseDurIn && pulseDurVal) {
    pulseDurIn.addEventListener('input', () => {
      pulseDurVal.textContent = pulseDurIn.value;
    });
  }
  if (throttleIn && throttleVal) {
    throttleIn.addEventListener('input', () => {
      throttleVal.textContent = throttleIn.value;
    });
  }
  if (maxIn && maxVal) {
    maxIn.addEventListener('input', () => {
      maxVal.textContent = maxIn.value;
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      state.config.blur = toNumber(blurIn?.value, state.config.blur);
      state.config.opacityMultiplier = toNumber(
        opIn?.value,
        state.config.opacityMultiplier
      );
      state.config.scaleMultiplier = toNumber(
        scaleIn?.value,
        state.config.scaleMultiplier
      );
      state.config.pulseEnabled = pulseIn?.value === 'on';
      state.config.pulseDuration = toNumber(
        pulseDurIn?.value,
        state.config.pulseDuration
      );
      state.config.throttleMs = toNumber(
        throttleIn?.value,
        state.config.throttleMs
      );
      state.config.maxConcurrent = Math.max(
        1,
        toNumber(maxIn?.value, state.config.maxConcurrent)
      );
      applyFilterConfig(state);
      persistConfig(state);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.config = { ...DEFAULT_CONFIG };
      if (blurIn) blurIn.value = String(state.config.blur);
      if (opIn) opIn.value = String(state.config.opacityMultiplier);
      if (scaleIn) scaleIn.value = String(state.config.scaleMultiplier);
      if (pulseIn) pulseIn.value = state.config.pulseEnabled ? 'on' : 'off';
      if (pulseDurIn) pulseDurIn.value = String(state.config.pulseDuration);
      if (throttleIn) throttleIn.value = String(state.config.throttleMs);
      if (maxIn) maxIn.value = String(state.config.maxConcurrent);

      if (blurVal) blurVal.textContent = String(state.config.blur);
      if (opVal) opVal.textContent = state.config.opacityMultiplier.toFixed(2);
      if (scaleVal)
        scaleVal.textContent = state.config.scaleMultiplier.toFixed(2);
      if (pulseDurVal)
        pulseDurVal.textContent = String(state.config.pulseDuration);
      if (throttleVal)
        throttleVal.textContent = String(state.config.throttleMs);
      if (maxVal) maxVal.textContent = String(state.config.maxConcurrent);

      applyFilterConfig(state);
      persistConfig(state);
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      try {
        panel.remove();
      } catch {
        // ignore
      }
      state.debugPanel = null;
    });
  }

  return panel;
}

function attachGlowEventListeners(state: GlowState): void {
  const onNote = (ev: Event) => {
    try {
      const d = ev instanceof CustomEvent ? (ev.detail as NoteDetail) : null;
      const circleId = d?.circleId;
      let target: SVGCircleElement | null = null;
      if (circleId) {
        target = state.svg.querySelector(
          `circle[data-circle-id="${circleId}"]`
        );
      } else if (d?.circle && d.circle instanceof SVGCircleElement) {
        target = d.circle;
      }
      if (target) {
        flashGlow(state, target, d ?? undefined);
      }
    } catch {
      // ignore
    }
  };

  const onFlash = (ev: Event) => {
    try {
      const d = ev instanceof CustomEvent ? (ev.detail as NoteDetail) : null;
      const circle = d?.circle;
      if (circle instanceof SVGCircleElement) {
        flashGlow(state, circle, d ?? undefined);
      }
    } catch {
      // ignore
    }
  };

  document.addEventListener('svg-playground:note', onNote);
  document.addEventListener('svg-playground:flash', onFlash);

  state.listeners.push(() =>
    document.removeEventListener('svg-playground:note', onNote)
  );
  state.listeners.push(() =>
    document.removeEventListener('svg-playground:flash', onFlash)
  );
}

function attachMutationObservers(state: GlowState): void {
  const svg = state.svg;

  const childObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const n of Array.from(m.addedNodes)) {
          if (n instanceof SVGElement && n.classList?.contains('spinner')) {
            createOrSyncGlowRing(state, n as SVGCircleElement);
          }
        }
      } else if (m.type === 'attributes' && m.target instanceof SVGElement) {
        const el = m.target;
        if (
          el.classList.contains('spinner') &&
          (m.attributeName === 'cx' ||
            m.attributeName === 'cy' ||
            m.attributeName === 'r' ||
            m.attributeName === 'stroke')
        ) {
          createOrSyncGlowRing(state, el as SVGCircleElement);
        }
      }
    }
  });

  childObserver.observe(svg, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['cx', 'cy', 'r', 'stroke'],
  });

  state.observers.push(childObserver);

  if (state.config.enableFallbackAttrObserver) {
    const attrObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (!(m.target instanceof SVGElement)) continue;
        const el = m.target;
        if (!el.classList.contains('spinner')) continue;

        if (
          m.attributeName === 'data-filter-clamped' ||
          m.attributeName === 'data-pan-clamped' ||
          m.attributeName === 'stroke-dasharray'
        ) {
          const dash = el.getAttribute('stroke-dasharray') || '';
          const firstNum = Number(dash.split(/\s+/)[0]) || 0;
          flashGlow(state, el as SVGCircleElement, {
            duration: Math.max(0.02, firstNum / 400),
            freq: 440,
          });
        }
      }
    });

    attrObserver.observe(svg, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-filter-clamped',
        'data-pan-clamped',
        'stroke-dasharray',
      ],
    });

    state.observers.push(attrObserver);
  }

  if (state.config.enablePointerFallback) {
    const onPointerDown = (e: PointerEvent) => {
      try {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const svgP = pt.matrixTransform(ctm.inverse());

        let nearest: SVGCircleElement | null = null;
        let bestD = Infinity;
        for (const c of Array.from(svg.querySelectorAll('circle.spinner'))) {
          const cx = Number(c.getAttribute('cx') || 0);
          const cy = Number(c.getAttribute('cy') || 0);
          const dx = cx - svgP.x;
          const dy = cy - svgP.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD) {
            bestD = d2;
            nearest = c as SVGCircleElement;
          }
        }
        if (nearest && bestD < Math.pow(160, 2)) {
          flashGlow(state, nearest, { duration: 0.22, freq: 440 });
        }
      } catch {
        // ignore
      }
    };

    svg.addEventListener('pointerdown', onPointerDown);
    state.listeners.push(() =>
      svg.removeEventListener('pointerdown', onPointerDown)
    );
  }
}

function cleanupGlowState(state: GlowState): void {
  for (const obs of state.observers) {
    try {
      obs.disconnect();
    } catch {
      // ignore
    }
  }
  state.observers = [];
  for (const off of state.listeners) {
    try {
      off();
    } catch {
      // ignore
    }
  }
  state.listeners = [];
  try {
    state.debugPanel?.remove();
  } catch {
    // ignore
  }
  state.debugPanel = null;
}

function initGlowInternal(
  svg: SVGSVGElement,
  options: GlowInitOptions = {}
): GlowController {
  if (__activeState) {
    cleanupGlowState(__activeState);
    __activeState = null;
  }

  const persisted =
    options.persistConfig !== false
      ? loadPersistedConfig(options.storageKey ?? DEFAULT_STORAGE_KEY)
      : null;

  const config: GlowConfig = {
    ...DEFAULT_CONFIG,
    ...(persisted ?? {}),
    ...(options.config ?? {}),
  };

  ensureGlowDefs(svg);
  const glowLayer = ensureGlowLayer(svg);

  const state: GlowState = {
    svg,
    config,
    glowLayer,
    debugPanel: null,
    observers: [],
    listeners: [],
    playingCount: 0,
    storageKey: options.storageKey ?? DEFAULT_STORAGE_KEY,
    persistConfig: options.persistConfig !== false,
  };

  __activeState = state;

  applyFilterConfig(state);

  // initialize any existing spinners
  for (const c of Array.from(svg.querySelectorAll('circle.spinner'))) {
    createOrSyncGlowRing(state, c as SVGCircleElement);
  }

  attachGlowEventListeners(state);
  attachMutationObservers(state);

  if (options.enableDebugPanel) {
    state.debugPanel = createDebugPanel(state);
  }

  const destroy = () => {
    cleanupGlowState(state);
    if (__activeState === state) {
      __activeState = null;
    }
  };

  return {
    destroy,
    getConfig: () => ({ ...state.config }),
    applyConfig: (next: Partial<GlowConfig>) => {
      state.config = { ...state.config, ...next };
      applyFilterConfig(state);
      persistConfig(state);
    },
    flash: (circle: SVGCircleElement, detail?: NoteDetail) => {
      flashGlow(state, circle, detail);
    },
    setDebugPanelEnabled: (on: boolean) => {
      if (on && !state.debugPanel) {
        state.debugPanel = createDebugPanel(state);
      } else if (!on && state.debugPanel) {
        try {
          state.debugPanel.remove();
        } catch {
          // ignore
        }
        state.debugPanel = null;
      }
    },
  };
}

export function initGlow(
  svg?: SVGSVGElement | null,
  options: GlowInitOptions = {}
): GlowController {
  const root = getSvgRoot(svg);
  if (!root) {
    throw new Error('SVG root not found for glow initialization');
  }
  return initGlowInternal(root, options);
}

export function getGlowController(): GlowController | null {
  if (!__activeState) return null;
  return {
    destroy: () => __activeState?.observers?.forEach((o) => o.disconnect()),
    getConfig: () =>
      __activeState ? { ...__activeState.config } : { ...DEFAULT_CONFIG },
    applyConfig: (next: Partial<GlowConfig>) => {
      if (!__activeState) return;
      __activeState.config = { ...__activeState.config, ...next };
      applyFilterConfig(__activeState);
      persistConfig(__activeState);
    },
    flash: (circle: SVGCircleElement, detail?: NoteDetail) => {
      if (!__activeState) return;
      flashGlow(__activeState, circle, detail);
    },
    setDebugPanelEnabled: (on: boolean) => {
      if (!__activeState) return;
      if (on && !__activeState.debugPanel) {
        __activeState.debugPanel = createDebugPanel(__activeState);
      } else if (!on && __activeState.debugPanel) {
        try {
          __activeState.debugPanel.remove();
        } catch {
          // ignore
        }
        __activeState.debugPanel = null;
      }
    },
  };
}

export function flashGlowForCircleId(
  circleId: string,
  detail?: NoteDetail
): void {
  if (!__activeState) return;
  const target = __activeState.svg.querySelector(
    `circle[data-circle-id="${circleId}"]`
  ) as SVGCircleElement | null;
  if (target) flashGlow(__activeState, target, detail);
}

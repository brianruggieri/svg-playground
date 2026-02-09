import { CIRCLE_RADIUS, CIRCLE_CIRCUMFERENCE } from './constants';
import { mulberry32, randomColor } from './utils';

import { ensureCircleState, deleteState } from './state';

/**
 * Create a ghost outline and an active circle at the given SVG location.
 * Returns the created circle element augmented with runtime state.
 *
 * @param svg - The SVG root element where the circle should be appended
 * @param loc - Coordinates in SVG space { x, y }
 */
export function createCircleAt(
  svg: SVGSVGElement,
  loc: { x: number; y: number }
): SVGCircleElement {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Create a stable id for this circle pair so we can find and remove them later.
  const id = `c-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  // Ghost outline (subtle visual indicator while recording)
  const ghost = document.createElementNS(SVG_NS, 'circle');
  ghost.setAttribute('cx', String(loc.x));
  ghost.setAttribute('cy', String(loc.y));
  ghost.setAttribute('r', String(CIRCLE_RADIUS));
  ghost.classList.add('ghost');
  ghost.setAttribute('data-circle-id', id);
  svg.appendChild(ghost);

  // Main spinner circle
  const circle = document.createElementNS(
    SVG_NS,
    'circle'
  ) as unknown as SVGCircleElement;
  circle.setAttribute('cx', String(loc.x));
  circle.setAttribute('cy', String(loc.y));
  circle.setAttribute('r', String(CIRCLE_RADIUS));
  circle.classList.add('spinner');
  circle.setAttribute('data-circle-id', id);

  // Visual stroke color
  // (style is safe on SVG elements in modern browsers)
  try {
    (circle.style as CSSStyleDeclaration).stroke = randomColor();
  } catch {
    // Fallback: set stroke attribute if direct style assignment fails
    circle.setAttribute('stroke', randomColor());
  }

  // Start with empty dash pattern (no dash, full gap)
  circle.setAttribute('stroke-dasharray', `0 ${CIRCLE_CIRCUMFERENCE}`);
  circle.setAttribute('stroke-dashoffset', '0.5');

  // Seed state for this circle (position + seeded RNG) using the WeakMap-backed state manager
  const seed = Math.floor(loc.x * 1000 + loc.y * 1000 + performance.now());
  ensureCircleState(circle as unknown as SVGCircleElement, {
    pos: { x: loc.x, y: loc.y },
    rng: mulberry32(seed),
  });

  // Append to DOM and return the typed circle
  svg.appendChild(circle as unknown as SVGCircleElement);
  return circle;
}

/**
 * Emotional exit for a circle: shrink, fade, and remove both the spinner and its ghost.
 * This produces a visible, emotional departure rather than an abrupt removal.
 *
 * @param circle - the spinner circle element to remove
 * @param durationMs - how long the exit animation should take (default 700ms)
 */
export function emotionalExit(
  circle: SVGCircleElement,
  durationMs = 700
): void {
  try {
    // Safely attempt to clear any state for the circle
    try {
      deleteState(circle);
    } catch {
      // ignore state deletion errors
    }

    const id = circle.getAttribute('data-circle-id');
    const svg = circle.ownerSVGElement;
    let ghost: SVGCircleElement | null = null;
    if (svg && id) {
      try {
        ghost = svg.querySelector(
          `circle.ghost[data-circle-id="${id}"]`
        ) as SVGCircleElement | null;
      } catch {
        ghost = null;
      }
    }

    // Prepare elements to animate (circle + ghost if present)
    const elements: (SVGGraphicsElement | null)[] = [circle, ghost];

    for (const el of elements) {
      if (!el) continue;
      try {
        // Make sure element participates visually in the transition
        // Use inline styles to avoid requiring external CSS changes.
        (el.style as any).transition =
          `transform ${durationMs}ms cubic-bezier(.22,.9,.35,1), opacity ${durationMs}ms ease-out`;
        // SVG transform origin via CSS; fallback to setting transformBox/Origin
        try {
          (el.style as any).transformBox = 'fill-box';
          (el.style as any).transformOrigin = '50% 50%';
        } catch {
          /* ignore transform origin failures */
        }
        // Trigger the exit: shrink & fade
        (el.style as any).opacity = '0';
        (el.style as any).transform = 'scale(0.18)';
        // Optionally reduce stroke-width for a more delicate fade (non-critical)
        try {
          const sw = el.getAttribute('stroke-width');
          if (sw != null) {
            el.setAttribute(
              'stroke-width',
              String(Math.max(0.2, Number(sw) * 0.2))
            );
          }
        } catch {
          // ignore
        }
      } catch {
        // ignore per-element animation failures
      }
    }

    // Remove elements after animation completes
    window.setTimeout(() => {
      try {
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      } catch {
        /* ignore */
      }
      try {
        if (circle && circle.parentNode) circle.parentNode.removeChild(circle);
      } catch {
        /* ignore */
      }
    }, durationMs + 40);
  } catch {
    // swallow unexpected errors to avoid breaking UI
  }
}

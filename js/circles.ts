import { CIRCLE_RADIUS, CIRCLE_CIRCUMFERENCE } from './constants';
import { mulberry32, randomColor } from './utils';

import { ensureCircleState } from './state';

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

  // Ghost outline (subtle visual indicator while recording)
  const ghost = document.createElementNS(SVG_NS, 'circle');
  ghost.setAttribute('cx', String(loc.x));
  ghost.setAttribute('cy', String(loc.y));
  ghost.setAttribute('r', String(CIRCLE_RADIUS));
  ghost.classList.add('ghost');
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

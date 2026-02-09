import { CIRCLE_RADIUS, CIRCLE_CIRCUMFERENCE } from "./constants.js";
import { mulberry32, randomColor } from "./utils.js";

/**
 * Create a ghost outline and an active circle at the given SVG location.
 * Returns the created circle element.
 * @param {SVGSVGElement} svg
 * @param {{x:number,y:number}} loc
 */
export function createCircleAt(svg, loc) {
    // Ghost outline
    const ghost = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ghost.setAttribute("cx", loc.x);
    ghost.setAttribute("cy", loc.y);
    ghost.setAttribute("r", CIRCLE_RADIUS);
    ghost.classList.add("ghost");
    svg.appendChild(ghost);

    // Actual circle
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", loc.x);
    circle.setAttribute("cy", loc.y);
    circle.setAttribute("r", CIRCLE_RADIUS);
    circle.classList.add("spinner");
    circle.style.stroke = randomColor();
    circle.setAttribute("stroke-dasharray", `0 ${CIRCLE_CIRCUMFERENCE}`);
    circle.setAttribute("stroke-dashoffset", 0.5);

    circle._pos = { x: loc.x, y: loc.y };
    circle._rng = mulberry32(
        Math.floor(loc.x * 1000 + loc.y * 1000 + performance.now()),
    );

    svg.appendChild(circle);
    return circle;
}

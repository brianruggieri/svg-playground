# Dash‑Synced Generative Audio Circles

A single‑page SVG + Web Audio experiment that lets you “draw” rhythmic dash patterns by holding the mouse and pressing Space. Each circle becomes a looping audio pattern whose tone and timbre are derived from the dash/gap structure.

## Usage

1. Open `index.html` in a modern browser (Chrome, Edge, Safari).
2. **Mouse down** to place a circle.
3. **Hold the mouse** to define the loop duration (longer hold = slower rotation).
4. **Press and hold Space** while still holding the mouse to create *dash* segments (audible).
5. **Release Space** to return to *gap* segments (silent).
6. **Mouse up** to finalize the circle. The dash pattern loops visually and sonically.
7. Click **Clear** to stop all audio and remove all circles.

> Note: Browsers require a user gesture to start audio. If sound is muted, click once on the page and try again.

## How It Works (Architecture)

The app is intentionally contained in one file, but the script is organized into focused sections:

- **Geometry & State**
  - Tracks `segments` (dash/gap durations) while the mouse is held.
  - Converts segments into an SVG `stroke-dasharray` so the circle visually represents the rhythm.

- **Live Preview**
  - During recording, `requestAnimationFrame` updates the dash pattern continuously.
  - The current “live” segment is appended before rendering.

- **Audio**
  - **Live Audio**: While Space is held, the app plays a sustained tone derived from the current segment analysis.
  - **Loop Audio**: After mouse up, the dasharray is converted into timed segments. Each dash triggers a note.
  - The **scale selection** and **harmonic content** depend on complexity:
    - Fewer segments → pentatonic.
    - More dashes than gaps → major.
    - Otherwise → minor.
  - Horizontal position maps to stereo pan; vertical position maps to brightness/volume.

- **Cleanup**
  - Each circle keeps references to active oscillators and timeouts.
  - Clicking **Clear** stops playback and disconnects audio nodes.

## Key Concepts

- **Dash/Gaps**
  - `dash` segments are audible and visible.
  - `gap` segments are silent and just visual spacing.
- **Rotation**
  - The total mouse‑hold duration becomes the animation period for the spinner.
- **Timing**
  - Segment durations are normalized to the circle circumference, then rescaled to time.

## File Layout

- `index.html` — Everything: markup, styles, and logic.
- `README.md` — This file.

## Notes & Tips

- The system uses the Web Audio API (`AudioContext`, `OscillatorNode`, `BiquadFilterNode`, `StereoPannerNode`).
- If you want to customize sound:
  - Adjust the `SCALES` list.
  - Tweak `LIVE_AUDIO_FADE_SEC` or filter parameters.
- For larger refactors, consider extracting the audio engine into a dedicated module.

## License

This project is experimental and provided as‑is.
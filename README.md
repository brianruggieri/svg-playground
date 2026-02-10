# Dash‑Synced Generative Audio Circles

A single‑page SVG + Web Audio experiment that lets you “draw” rhythmic dash patterns by using pointer input (mouse/touch/stylus) and pressing Space. Each circle becomes a looping audio pattern whose tone and timbre are derived from the dash/gap structure.

## Usage

1. Open `index.html` in a modern browser (Chrome, Edge, Safari).
2. **Pointer down** to place a circle.
3. **Hold the pointer** to define the loop duration (longer hold = slower rotation).
4. **Press and hold Space** while still holding the pointer to create _dash_ segments (audible).
5. **Release Space** to return to _gap_ segments (silent).
6. **Pointer up** to finalize the circle. The dash pattern loops visually and sonically.
7. Click **Clear** to stop all audio and remove all circles.

> Note: Browsers require a user gesture to start audio. If sound is muted, interact with the page (e.g., a single tap/click) and try again.

## How It Works (Architecture)

The app is split into ES modules, organized into focused areas:

- **Geometry & State**
  - Tracks `segments` (dash/gap durations) while the pointer is held.
  - Converts segments into an SVG `stroke-dasharray` so the circle visually represents the rhythm.

- **Live Preview**
  - During recording, `requestAnimationFrame` updates the dash pattern continuously.
  - The current “live” segment is appended before rendering.

- **Audio**
  - **Live Audio**: While Space is held, the app plays a sustained tone derived from the current segment analysis.
  - **Loop Audio**: After pointer up, the dasharray is converted into timed segments. Each dash triggers a note.
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
  - The total pointer‑hold duration becomes the animation period for the spinner.
- **Timing**
  - Segment durations are normalized to the circle circumference, then rescaled to time.

## File Layout

- `index.html` — Markup, styles, and module entrypoint.
- `js/app.js` — App wiring (events, preview, state).
- `js/audio.js` — Audio engine (live + loop playback).
- `js/utils.js` — Helpers (analysis, dasharray, RNG).
- `js/constants.js` — Shared constants and scales.
- `js/circles.js` — Circle creation and SVG setup.
- `README.md` — This file.

## Notes & Tips

- The system uses the Web Audio API (`AudioContext`, `OscillatorNode`, `BiquadFilterNode`, `StereoPannerNode`).
- If you want to customize sound:
  - Adjust the `SCALES` list.
  - Tweak `LIVE_AUDIO_FADE_SEC` or filter parameters.
- For larger refactors, consider extracting the audio engine into a dedicated module.

## Dev Server

This project now uses Vite as the recommended development server for native ES module workflows (fast start, HMR, and an optimized production build).

- Install dependencies (Node >= 20.17.0 is recommended):

```bash
npm install
```

- Start the Vite dev server:

```bash
npm run dev
```

By default Vite listens on port 5173; to override the port set the PORT environment variable:

```bash
PORT=3000 npm run dev
```

- Build production assets:

```bash
npm run build
```

- Preview the production build locally:

```bash
npm run preview
```

## License

This project is experimental and provided as‑is.

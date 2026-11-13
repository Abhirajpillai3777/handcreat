# HandCreate

**Draw in the air.** HandCreate is a browser drawing studio you can control with hand gestures through your webcam — or with a mouse, stylus or finger. No install, no account, no upload: everything runs locally in your browser.

![HandCreate screenshot](assets/screenshot.png)

* * *

## Features

-   **Gesture control** — MediaPipe Hands tracks one hand and turns six gestures into drawing actions.
-   **Mouse / touch / stylus** — full parity: the same tools work with a pointer.
-   **Six tools** — Move, Draw, Shape, Line, Text, Eraser.
-   **16 shapes** — circle, ellipse, square, rounded rect, triangle, diamond, pentagon, hexagon, octagon, star, heart, arrow, cross, moon, bolt, cloud. Solid or hollow.
-   **15-colour palette**, brush size 3–48 px, opacity 10–100 %.
-   **Six artboard presets** — grid, dots, solid, gradient, blueprint, paper — plus custom colours.
-   **Three themes** — dark, light, neon. The artboard follows the theme.
-   **Undo / redo** with a 60-step snapshot history.
-   **Export** to PNG (1× / 2× / 3×) or SVG (real vector geometry, not bitmaps), with optional transparent background. Copy straight to the clipboard.
-   **Physics mode** — objects fall and bounce.
-   **Hand skeleton overlay** and live gesture HUD with hold-progress ring.
-   **Settings persist** in `localStorage`.
-   **Mobile-ready** — the sidebar becomes a bottom sheet.
-   **Accessible** — keyboard shortcuts, ARIA state, focus management, `prefers-reduced-motion`, restored pinch-zoom.

* * *

## Gesture cheat sheet

| Gesture | Action |
| --- | --- |
| ☝️ Index finger only | Freehand draw — just point and move |
| 🤏 Pinch (thumb + index tips together) | Place a shape, line or text; drag an object in Move mode |
| ✌️ Peace sign (hold ~0.3 s) | Cycle through tools |
| 🤟 Three fingers (hold ~0.3 s) | Cycle colour |
| 🖐️ Four fingers, **thumb tucked in** (hold ~0.3 s) | Cycle brush size |
| ✊ Fist (hold ~0.4 s) | Toggle solid / hollow, then next shape |
| ✋ Open palm, **thumb out to the side** (hold ~0.3 s) | Pause drawing |

### How the tracking works

Two details make the recognition stable in real use:

-   **Everything is scaled to the hand.** Thresholds are divided by the distance from the wrist to the middle knuckle, so moving closer to or further from the camera does not change the result.
-   **Finger extension is rotation-invariant.** A finger counts as extended when its tip is further from the wrist than its middle joint — not when its `y` coordinate is higher. Pointing sideways or at an angle works just as well as pointing straight up.

The two four-finger poses are separated by the thumb: tucked across the palm means _size_, splayed out to the side means _pause_. That is the one gesture worth practising for a few seconds.

### If your hand is not detected

1.  **Light it up.** Face a window or a lamp; backlit hands fail.
2.  **Fill the frame.** Keep your whole hand — wrist to fingertips — inside the camera preview.
3.  **About an arm's length away.** Too close crops the hand; too far makes it tiny.
4.  **Plain background.** Busy or skin-toned backgrounds confuse the detector.
5.  **One hand only.** The tracker is configured for a single hand.
6.  **Watch the HUD.** It reads _Waiting for hand…_ until tracking starts, then names the pose it sees. If it says _Hand detected_ but nothing fires, you are between poses — make the gesture more exaggerated.
7.  **Toggle the camera off and on** from the top bar if the model stalls.

The camera preview in the corner shows exactly what the model sees.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1`–`6` | Move, Draw, Shape, Line, Text, Eraser |
| `D` `V` `S` `L` `T` `E` | Same tools by mnemonic |
| `[` / `]` | Brush size down / up |
| `G` | Toggle grid |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` or `Y` | Redo |
| `Ctrl/Cmd + S` | Export PNG |
| `Ctrl/Cmd + Shift + S` | Export SVG |
| `Delete` / `Backspace` | Delete selected object |
| `F` | Fullscreen |
| `?` or `H` | Help |
| `Esc` | Cancel text / line / close dialog |

In **Move** mode, click an object to select it, drag to move it, and scroll to resize it.

* * *

## Run it locally

The app is plain HTML, CSS and ES modules — there is **no build step**.

Because ES modules and `getUserMedia` require a secure context, open it through a local server rather than `file://`:

```bash
cd handcreate
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works — `npx serve`, `php -S localhost:8000`, VS Code Live Server, etc.

### Camera notes

-   The camera needs **HTTPS or `localhost`**.
-   The first time you press **Use camera**, the browser asks for permission.
-   Video never leaves the device; inference runs in the page with MediaPipe.
-   If the model fails to load, an error card offers a retry and a mouse-mode fallback.

* * *

## Browser support

| Browser | Drawing | Camera / gestures |
| --- | --- | --- |
| Chrome / Edge 90+ | ✅ | ✅ |
| Safari 15+ | ✅ | ✅ (iOS 15+) |
| Firefox 90+ | ✅ | ✅ |
| Mobile Chrome / Safari | ✅ | ✅ (front camera) |

Requires `PointerEvent`, `Canvas 2D`, `ResizeObserver` and ES modules — all baseline in modern browsers.

* * *

## Project structure

```
handcreate/
├── index.html                 # the only page — semantic shell + ARIA
├── css/
│   ├── main.css               # single entry point, @imports the rest
│   ├── tokens.css             # design tokens + 3 themes
│   ├── base.css               # reset, app grid, stage, canvas layers
│   ├── components.css         # buttons, panels, HUD, toggles, swatches
│   ├── overlays.css           # help dialog, loader, toasts
│   └── responsive.css         # tablet / mobile bottom sheet
├── js/
│   ├── main.js                # bootstrap
│   ├── config.js              # modes, shapes, palette, defaults, limits
│   ├── state.js               # reactive state + pub/sub + persistence
│   ├── audio.js               # WebAudio feedback tones
│   ├── core/
│   │   ├── canvas.js          # DPR sizing, 3 layers, dirty-flag render loop
│   │   ├── shapes.js          # pure geometry → SVG path strings
│   │   ├── renderer.js        # canvas drawing, hit-testing, transforms
│   │   ├── background.js      # artboard presets
│   │   ├── history.js         # snapshot undo / redo
│   │   └── physics.js         # gravity + bounce
│   ├── input/
│   │   ├── pointer.js         # mouse / touch / stylus
│   │   ├── keyboard.js        # shortcuts
│   │   └── hands.js           # MediaPipe camera + gesture state machine
│   ├── ui/
│   │   ├── dom.js             # cached element references
│   │   ├── controls.js        # sidebar wiring
│   │   ├── actions.js         # intent layer used by UI *and* gestures
│   │   ├── theme.js           # theme + artboard sync
│   │   ├── hud.js             # gesture HUD (diffed updates)
│   │   └── overlays.js        # help, loader, toasts
│   └── export/
│       ├── png.js             # offscreen render + download + clipboard
│       └── svg.js             # true vector export
├── assets/
│   ├── favicon.svg
│   ├── og-image.png
│   └── screenshot.png
├── .github/workflows/deploy.yml
├── LICENSE
└── package.json
```

### Architecture notes

-   **Three canvas layers.** `#bg-canvas` paints the artboard, `#art-canvas` holds the artwork (this is what gets exported), `#fx-canvas` draws the cursor, hand skeleton and selection box. The overlay is never baked into exports.
-   **One geometry source.** `core/shapes.js` returns SVG path strings; both the canvas (`Path2D`) and the SVG exporter consume them, so screen and file always match.
-   **Dirty flags, not a permanent loop.** `requestArt()`, `requestFx()` and `requestBackground()` schedule a single `requestAnimationFrame`. The physics loop only runs while physics is on.
-   **Actions layer.** `ui/actions.js` is the only place that mutates state. Mouse input and hand gestures both call into it, so behaviour can never drift between the two.
-   **History correctness.** `commit()` snapshots state _before_ a mutation, which is why erasing is undoable.

* * *

## Deploying to GitHub Pages

1.  Create a repository and push this folder (see below).
2.  In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3.  The included workflow (`.github/workflows/deploy.yml`) publishes on every push to `main`.
4.  Your app is live at `https://<username>.github.io/<repo>/`.

Because all paths are relative, it works from a subpath with no configuration.

* * *

## License

MIT — see [LICENSE](LICENSE).
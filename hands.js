/**
 * hands.js — MediaPipe Hands + gesture state machine.
 *
 * Two rules keep this reliable:
 *
 *  1. Every measurement is normalised by the hand's own size (wrist → middle
 *     knuckle). A fixed percentage threshold breaks as soon as the hand moves
 *     closer to or further from the camera.
 *  2. Finger extension is measured as "is the tip further from the wrist than
 *     the middle joint", which is rotation-invariant. Comparing raw `y` values
 *     only works when the hand is perfectly upright.
 *
 * Poses are evaluated in priority order and are mutually exclusive, so one
 * frame can never count towards two gestures at once.
 */

import { state } from "../state.js";
import { setHud, setStatus } from "../ui/hud.js";
import { showLoading, setLoadingText, hideLoading, showLoadingError, toast } from "../ui/overlays.js";
import { setFxPainter, requestFx, getSize } from "../core/canvas.js";
import {
  placeShapeAt,
  lineClickAt,
  openTextAt,
  handStrokeStart,
  handStrokeMove,
  handStrokeEnd,
  handEraseStart,
  handEraseMove,
  handEraseEnd,
  handSelectStart,
  handSelectMove,
  handSelectEnd,
} from "../input/pointer.js";
import { cycleMode, cycleColor, cycleSize, toggleFilled, cycleShape } from "../ui/actions.js";
import { el } from "../ui/dom.js";

/* ------------------------------------------------------------- constants */

// Frames a gesture must be held before it fires. At a typical 25–30 fps
// that is roughly 0.3 s — long enough to ignore a hand passing through the
// pose, short enough to feel responsive.
const HOLD = {
  peace: 8,
  three: 8,
  four: 8,
  fist: 10,
  palm: 8,
};

const COOLDOWN_MS = {
  peace: 700,
  three: 600,
  four: 600,
  fist: 800,
};

/* ---------------------------------------------------------- module state */

const counters = { peace: 0, three: 0, four: 0, fist: 0, palm: 0 };
const cooldown = { peace: 0, three: 0, four: 0, fist: 0 };

let hands = null;
let stream = null;
let loopId = null;
let sending = false;
let running = false;

let smoothX = null;
let smoothY = null;
let cursor = { x: 0, y: 0, pinching: false, paused: false, visible: false };
let pinchLatch = false;
let lastLandmarks = null;

let strokeActive = false;
let eraseActive = false;
let dragActive = false;

/* diagnostics */
let frames = 0;
let detections = 0;
let sendErrors = 0;
let lastHandAt = 0;
let hintShown = false;

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

/* ------------------------------------------------------------- lifecycle */

export function initHands() {
  setFxPainter(paintFx);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running) pauseLoop();
    else if (!document.hidden && running) resumeLoop();
  });
}

export async function startCamera() {
  if (running) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    showLoadingError("This browser has no camera API.<br>Try Chrome, Edge or Safari.", startCamera);
    return;
  }
  if (typeof window.Hands === "undefined") {
    showLoadingError(
      "The hand-tracking library could not load.<br>Check your connection and try again.",
      startCamera
    );
    return;
  }

  showLoading("Requesting camera access…");
  setStatus("Waiting for camera permission…", false);

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });

    // Show the preview *before* playing: some browsers refuse to decode frames
    // for a video element inside a `display:none` container.
    el.cam.hidden = false;
    el.video.srcObject = stream;
    el.video.muted = true;
    el.video.playsInline = true;
    await el.video.play();

    // Wait until the element actually has a frame, otherwise the first
    // `send()` calls push a 0×0 image and MediaPipe never recovers.
    await waitForFrame(el.video);

    setLoadingText("Loading hand model…");

    hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });
    hands.setOptions({
      selfieMode: false, // we mirror the coordinates ourselves
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(handleResults);

    running = true;
    state.cameraActive = true;
    frames = detections = sendErrors = 0;
    lastHandAt = 0;
    hintShown = false;

    hideLoading();
    setStatus("Live · hand tracking", true);
    setHud({
      emoji: "👋",
      label: "Waiting for hand…",
      hint: "Hold your hand up, palm towards the camera",
      progress: 0,
      idle: true,
    });
    toast("Camera ready — show your hand", "accent", 2200);
    resumeLoop();
  } catch (err) {
    running = false;
    state.cameraActive = false;
    el.cam.hidden = true;
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      showLoadingError(
        "Camera permission was denied.<br>Allow camera access in the address bar, then try again.",
        startCamera
      );
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      showLoadingError("No camera was found on this device.", startCamera);
    } else if (name === "NotReadableError") {
      showLoadingError("The camera is used by another app.<br>Close it and try again.", startCamera);
    } else {
      showLoadingError(`Could not start the camera.<br>${String(err?.message || err).slice(0, 120)}`, startCamera);
    }
    setStatus("Camera unavailable", false);
  }
}

function waitForFrame(video, timeout = 4000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
      if (performance.now() - started > timeout) return resolve(false);
      requestAnimationFrame(check);
    };
    check();
  });
}

export function stopCamera() {
  running = false;
  state.cameraActive = false;
  if (loopId) cancelAnimationFrame(loopId);
  loopId = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (hands) {
    try {
      hands.close();
    } catch {
      /* ignore */
    }
    hands = null;
  }
  handStrokeEnd();
  handEraseEnd();
  handSelectEnd();
  strokeActive = eraseActive = dragActive = false;
  el.cam.hidden = true;
  cursor.visible = false;
  requestFx();
  setStatus("Mouse mode", false);
  setHud({ emoji: "🖱️", label: "Mouse mode", hint: "Click and drag on the canvas to draw", progress: 0, idle: true });
}

function pauseLoop() {
  if (loopId) cancelAnimationFrame(loopId);
  loopId = null;
}

function resumeLoop() {
  if (loopId !== null) return;
  const tick = async () => {
    if (!running) return;
    if (hands && el.video.readyState >= 2 && !sending) {
      sending = true;
      try {
        await hands.send({ image: el.video });
      } catch (err) {
        sendErrors++;
        // One dropped frame is normal; a run of them means the pipeline is
        // broken and the user deserves to know instead of staring at
        // "Waiting for hand…" forever.
        if (sendErrors === 20) {
          setStatus("Hand tracking error", false);
          toast("Hand tracking hiccup — try toggling the camera off and on", "danger", 3200);
        }
      }
      sending = false;
    }
    loopId = requestAnimationFrame(tick);
  };
  loopId = requestAnimationFrame(tick);
}

/* --------------------------------------------------------------- results */

export function handleResults(results) {
  frames++;
  const list = results.multiHandLandmarks;

  if (!list || !list.length) {
    cursor.visible = false;
    cursor.pinching = false;
    cursor.paused = false;
    pinchLatch = false;
    resetCounters();
    smoothX = smoothY = null;
    lastLandmarks = null;

    // close any in-progress hand action so nothing is left dangling
    if (strokeActive) {
      strokeActive = false;
      handStrokeEnd();
    }
    if (eraseActive) {
      eraseActive = false;
      handEraseEnd();
    }
    if (dragActive) {
      dragActive = false;
      handSelectEnd();
    }

    requestFx();
    setHud({
      emoji: "👋",
      label: "Waiting for hand…",
      hint: "Hold your hand up, palm towards the camera",
      progress: 0,
      idle: true,
    });

    // after a few seconds of nothing, offer concrete troubleshooting
    if (running && !hintShown && performance.now() - lastHandAt > 5000) {
      hintShown = true;
      toast("No hand detected — check lighting, keep your whole hand in frame", "danger", 4000);
    }
    return;
  }

  detections++;
  lastHandAt = performance.now();
  hintShown = false;

  const lm = list[0];
  lastLandmarks = lm;

  const { width, height } = getSize();
  const indexTip = lm[8];

  /* ---- cursor position: mirrored + velocity-adaptive smoothing ---- */
  const rawX = (1 - indexTip.x) * width;
  const rawY = indexTip.y * height;

  if (smoothX === null) {
    smoothX = rawX;
    smoothY = rawY;
  } else {
    const dist = Math.hypot(rawX - smoothX, rawY - smoothY);
    // move fast → follow closely; move slowly → smooth harder
    const alpha = Math.min(0.85, Math.max(0.18, dist / 90));
    smoothX += (rawX - smoothX) * alpha;
    smoothY += (rawY - smoothY) * alpha;
  }

  cursor.x = smoothX;
  cursor.y = smoothY;
  cursor.visible = true;

  /* ---- pose measurement (all scale-relative) ---- */
  const pose = readPose(lm);
  const { pinching, openPalm, point, peace, three, four, fist } = pose;

  // The palm counter must advance on the *raw* pose, otherwise `paused` would
  // depend on itself and could never become true.
  counters.palm = openPalm ? counters.palm + 1 : 0;
  const paused = counters.palm >= HOLD.palm;

  cursor.pinching = pinching;
  cursor.paused = paused;

  /* ---- hold-to-fire gestures ---- */
  const now = performance.now();

  if (peace) {
    if (++counters.peace >= HOLD.peace && now - cooldown.peace > COOLDOWN_MS.peace) {
      cycleMode();
      cooldown.peace = now;
      counters.peace = 0;
    }
  } else counters.peace = 0;

  if (three) {
    if (++counters.three >= HOLD.three && now - cooldown.three > COOLDOWN_MS.three) {
      cycleColor();
      cooldown.three = now;
      counters.three = 0;
    }
  } else counters.three = 0;

  if (four) {
    if (++counters.four >= HOLD.four && now - cooldown.four > COOLDOWN_MS.four) {
      cycleSize();
      cooldown.four = now;
      counters.four = 0;
    }
  } else counters.four = 0;

  if (fist) {
    if (++counters.fist >= HOLD.fist && now - cooldown.fist > COOLDOWN_MS.fist) {
      if (state.mode === "shape") cycleShape();
      else toggleFilled();
      cooldown.fist = now;
      counters.fist = 0;
    }
  } else counters.fist = 0;

  /* ---- continuous actions (draw / erase / drag) ---- */
  runContinuousActions({ point, pinching, paused, fist });

  /* ---- discrete pinch actions ---- */
  if (pinching && !pinchLatch) {
    pinchLatch = true;
    onPinch(cursor.x, cursor.y);
  } else if (!pinching) {
    pinchLatch = false;
  }

  /* ---- HUD ---- */
  updateHud({ ...pose, paused });

  requestFx();
}

/**
 * Turn 21 landmarks into a set of mutually exclusive pose flags.
 * Everything is relative to `scale` (wrist → middle knuckle), so distance
 * from the camera stops mattering.
 */
function readPose(lm) {
  const dist = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);

  const scale = Math.max(dist(0, 9), 0.04);

  // rotation-invariant finger extension: tip further from wrist than the PIP?
  const extended = (tip, pip) => dist(0, tip) > dist(0, pip) * 1.12;

  const f = [extended(8, 6), extended(12, 10), extended(16, 14), extended(20, 18)];
  const nExt = f.reduce((n, v) => n + (v ? 1 : 0), 0);

  const pinchDist = dist(4, 8) / scale; // thumb tip ↔ index tip
  const indexReach = dist(0, 8) / scale; // how far the index sticks out
  // Two independent signals for "thumb is splayed out to the side" rather
  // than tucked across the palm — one alone is too easy to fool.
  const thumbOut = dist(4, 0) > dist(3, 0) * 1.06 && dist(4, 17) > dist(3, 17) * 1.02;

  // A pinch needs the index pointing *away* from the palm; in a fist the
  // thumb also touches the index, but the index is curled into the palm.
  const pinching = pinchDist < 0.42 && indexReach > 1.15;

  const fist = nExt === 0 && !pinching;
  const point = f[0] && !f[1] && !f[2] && !f[3] && !pinching;
  const peace = f[0] && f[1] && !f[2] && !f[3] && !pinching;
  const three = f[0] && f[1] && f[2] && !f[3] && !pinching;
  const fourFingers = f[0] && f[1] && f[2] && f[3] && !pinching;

  // "four fingers" vs "open palm" is decided by the thumb: tucked across the
  // palm = size, stuck out to the side = pause.
  const four = fourFingers && !thumbOut;
  const openPalm = fourFingers && thumbOut;

  return { pinching, point, peace, three, four, fist, openPalm, nExt };
}

function runContinuousActions({ point, pinching, paused, fist }) {
  const mode = state.mode;

  /* --- freehand drawing with the index finger --- */
  const wantStroke = mode === "draw" && point && !paused && !pinching;
  if (wantStroke) {
    if (!strokeActive) {
      strokeActive = true;
      handStrokeStart(cursor.x, cursor.y);
    } else {
      handStrokeMove(cursor.x, cursor.y);
    }
  } else if (strokeActive) {
    strokeActive = false;
    handStrokeEnd();
  }

  /* --- erasing --- */
  const wantErase = mode === "eraser" && (point || pinching) && !paused;
  if (wantErase) {
    if (!eraseActive) {
      eraseActive = true;
      handEraseStart();
    }
    handEraseMove(cursor.x, cursor.y);
  } else if (eraseActive) {
    eraseActive = false;
    handEraseEnd();
  }

  /* --- dragging a selected object --- */
  const wantDrag = mode === "select" && pinching && !paused;
  if (wantDrag) {
    if (!dragActive) {
      dragActive = true;
      handSelectStart(cursor.x, cursor.y);
    } else {
      handSelectMove(cursor.x, cursor.y);
    }
  } else if (dragActive) {
    dragActive = false;
    handSelectEnd();
  }

  /* --- a fist or an open palm interrupts anything continuous --- */
  if (fist || paused) {
    if (strokeActive) {
      strokeActive = false;
      handStrokeEnd();
    }
    if (eraseActive) {
      eraseActive = false;
      handEraseEnd();
    }
    if (dragActive) {
      dragActive = false;
      handSelectEnd();
    }
  }
}

function onPinch(x, y) {
  switch (state.mode) {
    case "shape":
      placeShapeAt(x, y);
      break;
    case "line":
      lineClickAt(x, y);
      break;
    case "text":
      openTextAt(x, y);
      break;
    case "eraser":
      handEraseStart();
      handEraseMove(x, y);
      break;
    default:
      break;
  }
}

function updateHud(pose) {
  const { pinching, paused, point, peace, three, four, fist } = pose;

  if (paused) {
    setHud({
      emoji: "✋",
      label: "Paused",
      hint: "Open palm detected — curl your thumb in to resume",
      progress: 1,
      idle: false,
    });
    return;
  }

  if (pinching) {
    const hints = {
      shape: `Release to place a ${state.shape}`,
      line: "Pinch to set start / end point",
      text: "Release to place text",
      select: "Pinch and drag to move the object",
      eraser: "Pinch to erase",
      draw: "Pinch — switch to Shape mode to place objects",
    };
    setHud({ emoji: "🤏", label: "Pinch", hint: hints[state.mode] || "", progress: 1, idle: false });
    return;
  }

  if (counters.four > 0) {
    setHud({
      emoji: "🖐️",
      label: "Four fingers — size",
      hint: `Hold to change size (now ${state.size})`,
      progress: counters.four / HOLD.four,
      idle: false,
    });
    return;
  }
  if (counters.three > 0) {
    setHud({
      emoji: "🤟",
      label: "Three fingers — colour",
      hint: `Hold to change colour (${state.color})`,
      progress: counters.three / HOLD.three,
      idle: false,
    });
    return;
  }
  if (counters.peace > 0) {
    setHud({
      emoji: "✌️",
      label: "Peace — mode",
      hint: "Hold to switch tool",
      progress: counters.peace / HOLD.peace,
      idle: false,
    });
    return;
  }
  if (counters.fist > 0) {
    setHud({
      emoji: "✊",
      label: "Fist",
      hint: state.mode === "shape" ? "Hold for next shape" : "Hold to toggle solid / hollow",
      progress: counters.fist / HOLD.fist,
      idle: false,
    });
    return;
  }

  if (point) {
    if (state.mode === "draw") {
      setHud({ emoji: "☝️", label: "Drawing", hint: "Move your fingertip to draw", progress: 0, idle: false });
    } else if (state.mode === "eraser") {
      setHud({ emoji: "🧹", label: "Erasing", hint: "Point at an object to erase it", progress: 0, idle: false });
    } else {
      setHud({ emoji: "☝️", label: "Pointing", hint: `Pinch to use ${state.mode}`, progress: 0, idle: false });
    }
    return;
  }

  setHud({
    emoji: "☝️",
    label: "Hand detected",
    hint: "☝️ draw · 🤏 pinch · ✌️ mode · 🤟 colour · 🖐️ size · ✊ fill",
    progress: 0,
    idle: false,
  });
}

function resetCounters() {
  counters.peace = counters.three = counters.four = counters.fist = counters.palm = 0;
}

/* ---------------------------------------------------------------- painter */

function paintFx(ctx) {
  if (!cursor.visible) return;
  if (state.skeleton && lastLandmarks) drawSkeleton(ctx, lastLandmarks);
  drawCursor(ctx, cursor);
}

function drawSkeleton(ctx, lm) {
  const { width, height } = getSize();
  const px = (p) => (1 - p.x) * width;
  const py = (p) => p.y * height;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = "rgba(34, 211, 238, 0.22)";
  ctx.lineWidth = 6;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(px(lm[a]), py(lm[a]));
    ctx.lineTo(px(lm[b]), py(lm[b]));
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(34, 211, 238, 0.85)";
  ctx.lineWidth = 2;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(px(lm[a]), py(lm[a]));
    ctx.lineTo(px(lm[b]), py(lm[b]));
    ctx.stroke();
  }

  const tips = new Set([4, 8, 12, 16, 20]);
  for (let i = 0; i < lm.length; i++) {
    const isTip = tips.has(i);
    ctx.beginPath();
    ctx.arc(px(lm[i]), py(lm[i]), isTip ? 4 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? "#22d3ee" : "rgba(255,255,255,0.92)";
    ctx.fill();
  }
  ctx.restore();
}

function drawCursor(ctx, c) {
  const r = c.pinching ? 16 : c.paused ? 12 : 9;
  const color = c.pinching ? "#22d3ee" : c.paused ? "#fbbf24" : "#ffffff";

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = c.pinching ? "rgba(34,211,238,0.25)" : "rgba(255,255,255,0.12)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(c.x, c.y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------ diagnostics */

export function trackingStats() {
  return {
    running,
    frames,
    detections,
    sendErrors,
    detectedRate: frames ? detections / frames : 0,
    lastHandAgo: lastHandAt ? performance.now() - lastHandAt : null,
  };
}

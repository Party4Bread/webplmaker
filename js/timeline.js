/**
 * Canvas-based DAW timeline.
 *
 * Layout (y axis, per track):
 *   RULER_H      px  — time ruler (top, once)
 *   TRACK_H      px  — audio region / waveform
 *   AUTO_H       px  — volume automation lane
 *   TRACK_GAP    px  — separator
 *
 * The canvas width = max(wrapper width, totalDuration * pxPerSec + padding).
 * The canvas height = RULER_H + numTracks * (TRACK_H + AUTO_H + TRACK_GAP).
 */

import { interpolateAutomation } from "./audio.js";

// ── Layout constants (must match CSS variables) ──────────────
const RULER_H = 28;
const TRACK_H = 64;
const AUTO_H = 48;
const TRACK_GAP = 2;
const TRACK_TOTAL = TRACK_H + AUTO_H + TRACK_GAP;
const AUTO_PT_R = 5; // automation point radius (px)
const MIN_SET_DURATION = 30; // minimum visible set length (sec)

// BPM automation lane (global, below all tracks)
const BPM_H = 56;
const BPM_MIN = 40;
const BPM_MAX = 300;

// ── Colors ───────────────────────────────────────────────────
const C = {
  bg: "#1a1a1a",
  ruler: "#222222",
  rulerText: "#666666",
  rulerTick: "#444444",
  playhead: "#e8a020",
  trackBg: "#2a2a2a",
  waveform: "#ffffff28",
  autoLane: "#1e1e1e",
  autoLine: "#4a9eff",
  autoPt: "#4a9eff",
  autoPtSel: "#ffffff",
  gridLine: "#2a2a2a",
  sep: "#111111",
};

// ── State ────────────────────────────────────────────────────
let canvas = null;
let ctx2d = null;
let state = null; // reference to app state (shared object)
let onSeek = null; // callback(setTimeSec)
let onTrackMove = null; // callback(trackId, newStartTime)
let onTrackMoveStart = null; // callback(trackId) — fired once on drag start
let onAutomationEdit = null; // callback(trackId, points)
let onBpmAutomationEdit = null; // callback(points) — global BPM curve
let rafId = null;

// Drag state
const drag = {
  type: "none", // 'none' | 'playhead' | 'track' | 'auto_point' | 'bpm_point'
  trackId: null,
  pointIndex: -1,
  startMouseX: 0,
  startMouseY: 0,
  startValue: 0, // original startTime or point value
  moved: false,
};

// Hover state for cursor
let hoverRegion = "none"; // 'ruler' | 'track' | 'auto'

export function init(canvasEl, appState, callbacks) {
  canvas = canvasEl;
  ctx2d = canvas.getContext("2d");
  state = appState;
  onSeek = callbacks.onSeek;
  onTrackMove = callbacks.onTrackMove;
  onTrackMoveStart = callbacks.onTrackMoveStart ?? null;
  onAutomationEdit = callbacks.onAutomationEdit;
  onBpmAutomationEdit = callbacks.onBpmAutomationEdit ?? null;

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseleave", onMouseUp);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("dblclick", onDblClick);

  startRenderLoop();
}

export function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
}

/** No-op kept for API compatibility — no cache to invalidate. */
export function invalidateTrack(_trackId) {}

// ── Render loop ──────────────────────────────────────────────

function startRenderLoop() {
  function frame() {
    resize();
    render();
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

function resize() {
  const wrapper = canvas.parentElement;
  const totalSec = Math.max(MIN_SET_DURATION, longestTrackEnd() + 10);
  const minW = Math.ceil(totalSec * state.pxPerSec) + 40;
  const w = Math.max(wrapper.clientWidth, minW);
  const h = RULER_H + Math.max(1, state.tracks.length) * TRACK_TOTAL + BPM_H;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function render() {
  const wrapper = canvas.parentElement;
  const vpLeft = wrapper.scrollLeft;
  const vpW = wrapper.clientWidth;
  const H = canvas.height;
  const c = ctx2d;

  // Only clear/fill the visible strip — the canvas can be 30,000 px wide
  c.clearRect(vpLeft, 0, vpW, H);
  c.fillStyle = C.bg;
  c.fillRect(vpLeft, 0, vpW, H);

  drawGrid(vpLeft, vpW, H);
  drawRuler(vpLeft, vpW);
  drawTracks(vpLeft, vpW);
  drawBpmLane(vpLeft, vpW);
  drawPlayhead(H);
}

// ── Drawing helpers ──────────────────────────────────────────

function drawGrid(vpLeft, vpW, H) {
  const c = ctx2d;
  const bpm = state.masterBPM || 120;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const barPx = barSec * state.pxPerSec;
  const beatPx = beatSec * state.pxPerSec;
  const vpRight = vpLeft + vpW;

  // Bar lines (always shown)
  if (barPx >= 2) {
    const tStart = Math.floor(vpLeft / state.pxPerSec / barSec) * barSec;
    c.strokeStyle = "rgba(232,160,32,0.10)";
    c.lineWidth = 1;
    for (let t = tStart; t * state.pxPerSec < vpRight + barSec; t += barSec) {
      const x = Math.round(t * state.pxPerSec) + 0.5;
      c.beginPath();
      c.moveTo(x, RULER_H);
      c.lineTo(x, H);
      c.stroke();
    }
  }

  // Beat lines (only when zoomed in enough)
  if (beatPx >= 5) {
    const tStart = Math.floor(vpLeft / state.pxPerSec / beatSec) * beatSec;
    c.strokeStyle = "rgba(255,255,255,0.05)";
    c.lineWidth = 1;
    for (let t = tStart; t * state.pxPerSec < vpRight + beatSec; t += beatSec) {
      if (t % barSec < 0.001) continue;
      const x = Math.round(t * state.pxPerSec) + 0.5;
      c.beginPath();
      c.moveTo(x, RULER_H);
      c.lineTo(x, H);
      c.stroke();
    }
  }

  drawBeatTicks(vpLeft, vpW, beatSec, barSec);
}

function drawBeatTicks(vpLeft, vpW, beatSec, barSec) {
  if (state.snapMode === "off") return;
  const c = ctx2d;
  const beatPx = beatSec * state.pxPerSec;
  if (beatPx < 3) return;

  const tStart = Math.floor(vpLeft / state.pxPerSec / beatSec) * beatSec;
  const vpRight = vpLeft + vpW;

  for (let t = tStart; t * state.pxPerSec < vpRight + beatSec; t += beatSec) {
    const x = Math.round(t * state.pxPerSec) + 0.5;
    const isBar = Math.abs(t % barSec) < 0.001 || Math.abs((t % barSec) - barSec) < 0.001;
    c.strokeStyle = isBar ? "rgba(232,160,32,0.6)" : "rgba(74,158,255,0.4)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, isBar ? RULER_H - 10 : RULER_H - 5);
    c.lineTo(x, RULER_H);
    c.stroke();
  }
}

function drawRuler(vpLeft, vpW) {
  const c = ctx2d;
  c.fillStyle = C.ruler;
  c.fillRect(vpLeft, 0, vpW, RULER_H);

  const { stepSec } = gridStep();
  c.fillStyle = C.rulerText;
  c.strokeStyle = C.rulerTick;
  c.font = "10px monospace";
  c.textBaseline = "middle";
  c.lineWidth = 1;

  const tStart = Math.floor(vpLeft / state.pxPerSec / stepSec) * stepSec;
  const vpRight = vpLeft + vpW;

  for (let t = tStart; t * state.pxPerSec < vpRight + stepSec; t += stepSec) {
    const x = Math.round(t * state.pxPerSec) + 0.5;
    c.beginPath();
    c.moveTo(x, RULER_H - 6);
    c.lineTo(x, RULER_H);
    c.strokeStyle = C.rulerTick;
    c.stroke();

    if (x > vpLeft + 5) {
      c.fillText(formatBeat(t), x + 3, RULER_H / 2);
    }
  }
}

function drawTracks(vpLeft, vpW) {
  const c = ctx2d;
  state.tracks.forEach((track, idx) => {
    const yt = RULER_H + idx * TRACK_TOTAL;
    const ya = yt + TRACK_H + TRACK_GAP;

    // Separator
    c.fillStyle = C.sep;
    c.fillRect(vpLeft, yt + TRACK_H, vpW, TRACK_GAP);

    // Automation lane background
    c.fillStyle = C.autoLane;
    c.fillRect(vpLeft, ya, vpW, AUTO_H);

    drawTrackBlock(track, yt, vpLeft, vpW);
    drawAutomationLane(track, ya);
  });
}

function drawTrackBlock(track, yt, vpLeft, vpW) {
  const c = ctx2d;
  const x = Math.round(_beatToPx(track.startTime));
  const w = Math.round(_trackSetDuration(track) * state.pxPerSec);
  if (w <= 0) return;

  // Clip drawing to the intersection of track bounds and visible viewport
  const drawLeft = Math.max(x, vpLeft);
  const drawRight = Math.min(x + w, vpLeft + vpW);
  if (drawLeft >= drawRight) return;

  // 1. Background — only the visible slice
  c.fillStyle = track.color + (track.muted ? "55" : "cc");
  c.fillRect(drawLeft, yt, drawRight - drawLeft, TRACK_H);

  // 2. Waveform — iterate only the visible pixels
  if (track.waveform?.length) {
    c.fillStyle = track.muted ? C.waveform + "44" : C.waveform;
    const len = track.waveform.length;
    const mid = yt + TRACK_H / 2;
    for (let px = drawLeft; px < drawRight; px++) {
      const wIdx = Math.floor(((px - x) / w) * len);
      const amp = (track.waveform[wIdx] ?? 0) * (TRACK_H - 8);
      c.fillRect(px, mid - amp / 2, 1, amp || 1);
    }
  }

  // 3. Text labels
  const masterBpm = state.masterBPM || 120;
  const syncLabel =
    track.bpm && Math.abs(track.bpm - masterBpm) > 0.5 ? `${track.bpm}→${masterBpm} BPM` : `${track.bpm ?? "?"} BPM`;
  c.save();
  c.rect(x, yt, w, TRACK_H);
  c.clip();
  c.fillStyle = track.muted ? "#777" : "#fff";
  c.font = "bold 11px monospace";
  c.textBaseline = "top";
  c.fillText(track.name, x + 6, yt + 6);
  c.font = "10px monospace";
  c.fillStyle = "#ffffff88";
  c.fillText(`${syncLabel}  ${formatTime(_trackSetDuration(track))}`, x + 6, yt + 20);
  c.restore();

  // 4. Beat grid overlay — iterate only beats visible in the viewport
  if (track.bpm && track.beatOffset !== undefined) {
    const trackBpm = track.bpm;
    const beatSec = 60 / trackBpm;
    const beatPx = ((beatSec * trackBpm) / masterBpm) * state.pxPerSec;
    if (beatPx >= 2) {
      const visAudioStart = Math.max(0, (((drawLeft - x) / state.pxPerSec) * masterBpm) / trackBpm);
      const visAudioEnd = Math.min(track.duration, (((drawRight - x) / state.pxPerSec) * masterBpm) / trackBpm);
      const nStart = Math.floor((visAudioStart - track.beatOffset) / beatSec) - 1;
      const nEnd = Math.ceil((visAudioEnd - track.beatOffset) / beatSec) + 1;

      c.save();
      c.rect(x + 3, yt, w - 3, TRACK_H);
      c.clip();
      for (let n = nStart; n <= nEnd; n++) {
        const audioTime = track.beatOffset + n * beatSec;
        if (audioTime < 0 || audioTime > track.duration) continue;
        const bx = Math.round(x + ((audioTime * trackBpm) / masterBpm) * state.pxPerSec);
        const isBar = n % 4 === 0;
        const isBeat1 = n === 0;
        if (isBeat1) {
          c.strokeStyle = "rgba(232,160,32,0.9)";
          c.lineWidth = 1.5;
        } else if (isBar) {
          c.strokeStyle = "rgba(232,160,32,0.45)";
          c.lineWidth = 1;
        } else {
          if (beatPx < 6) continue;
          c.strokeStyle = "rgba(255,255,255,0.2)";
          c.lineWidth = 0.5;
        }
        c.beginPath();
        c.moveTo(bx, yt);
        c.lineTo(bx, yt + TRACK_H);
        c.stroke();
      }
      c.restore();
    }
  }

  // 5. Left border accent
  c.fillStyle = track.color;
  c.fillRect(x, yt, 3, TRACK_H);
}

function drawAutomationLane(track, ya) {
  const c = ctx2d;
  const points = track.automation ?? [];
  if (points.length === 0) return;

  const sorted = [...points].sort((a, b) => a.time - b.time);

  // Draw line — pt.time is audio-file seconds; convert to canvas x via _audioTimeToX
  c.beginPath();
  c.strokeStyle = C.autoLine;
  c.lineWidth = 1.5;

  sorted.forEach((pt, i) => {
    const x = Math.round(_audioTimeToX(track, pt.time));
    const y = Math.round(ya + (1 - pt.value) * (AUTO_H - AUTO_PT_R * 2) + AUTO_PT_R);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
  c.stroke();

  // Extend line to track edges (in set-time coordinates)
  if (sorted.length > 0) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const xStart = Math.round(_beatToPx(track.startTime));
    const xEnd = Math.round(_beatToPx(track.startTime) + _trackSetDuration(track) * state.pxPerSec);
    const yFirst = Math.round(ya + (1 - first.value) * (AUTO_H - AUTO_PT_R * 2) + AUTO_PT_R);
    const yLast = Math.round(ya + (1 - last.value) * (AUTO_H - AUTO_PT_R * 2) + AUTO_PT_R);

    c.beginPath();
    c.strokeStyle = C.autoLine + "55";
    c.lineWidth = 1;
    c.moveTo(xStart, yFirst);
    c.lineTo(Math.round(_audioTimeToX(track, first.time)), yFirst);
    c.stroke();

    c.beginPath();
    c.moveTo(Math.round(_audioTimeToX(track, last.time)), yLast);
    c.lineTo(xEnd, yLast);
    c.stroke();
  }

  // Draw points
  sorted.forEach((pt, i) => {
    const x = Math.round(_audioTimeToX(track, pt.time));
    const y = Math.round(ya + (1 - pt.value) * (AUTO_H - AUTO_PT_R * 2) + AUTO_PT_R);

    const isSelected = drag.type === "auto_point" && drag.trackId === track.id && drag.pointIndex === i;

    c.beginPath();
    c.arc(x, y, AUTO_PT_R, 0, Math.PI * 2);
    c.fillStyle = isSelected ? C.autoPtSel : C.autoPt;
    c.fill();
    c.strokeStyle = "#000";
    c.lineWidth = 1;
    c.stroke();

    if (isSelected) {
      c.fillStyle = "#fff";
      c.font = "9px monospace";
      c.textBaseline = "bottom";
      c.fillText(`${Math.round(pt.value * 100)}%`, x + 7, y - 1);
    }
  });
}

function drawBpmLane(vpLeft, vpW) {
  const laneY = RULER_H + state.tracks.length * TRACK_TOTAL;
  const c = ctx2d;
  const vpRight = vpLeft + vpW;

  // Background
  c.fillStyle = "#1a1a28";
  c.fillRect(vpLeft, laneY, vpW, BPM_H);

  // Top separator
  c.fillStyle = "#111";
  c.fillRect(vpLeft, laneY, vpW, 2);

  // Y-axis reference lines (every 40 BPM) — clip lines to viewport, pin labels to left edge
  c.strokeStyle = "rgba(255,255,255,0.04)";
  c.lineWidth = 1;
  for (let b = BPM_MIN; b <= BPM_MAX; b += 40) {
    const y = Math.round(_bpmToY(b, laneY)) + 0.5;
    c.beginPath();
    c.moveTo(vpLeft, y);
    c.lineTo(vpRight, y);
    c.stroke();
    c.fillStyle = "rgba(255,255,255,0.18)";
    c.font = "8px monospace";
    c.textBaseline = "middle";
    c.fillText(`${b}`, vpLeft + 3, y);
  }

  const points = state.bpmAutomation ?? [];
  if (points.length === 0) {
    // Draw a flat line at masterBPM
    const y = Math.round(_bpmToY(state.masterBPM, laneY)) + 0.5;
    c.strokeStyle = "rgba(232,160,32,0.35)";
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(vpLeft, y);
    c.lineTo(vpRight, y);
    c.stroke();
    c.setLineDash([]);
    return;
  }

  const sorted = [...points].sort((a, b) => a.time - b.time);

  // Lead-in flat line from left edge to first point
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const yFirst = _bpmToY(first.value, laneY);
  const yLast = _bpmToY(last.value, laneY);

  c.strokeStyle = "rgba(232,160,32,0.3)";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(vpLeft, yFirst);
  c.lineTo(first.time * state.pxPerSec, yFirst);
  c.stroke();

  // Main curve
  c.strokeStyle = "#e8a020";
  c.lineWidth = 1.5;
  c.beginPath();
  sorted.forEach((pt, i) => {
    const x = pt.time * state.pxPerSec;
    const y = _bpmToY(pt.value, laneY);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
  c.stroke();

  // Tail flat line from last point to right edge
  c.strokeStyle = "rgba(232,160,32,0.3)";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(last.time * state.pxPerSec, yLast);
  c.lineTo(vpRight, yLast);
  c.stroke();

  // Points
  sorted.forEach((pt, i) => {
    const x = pt.time * state.pxPerSec;
    const y = _bpmToY(pt.value, laneY);
    const isSelected = drag.type === "bpm_point" && drag.pointIndex === i;

    c.beginPath();
    c.arc(x, y, AUTO_PT_R, 0, Math.PI * 2);
    c.fillStyle = isSelected ? "#fff" : "#e8a020";
    c.fill();
    c.strokeStyle = "#000";
    c.lineWidth = 1;
    c.stroke();

    if (isSelected) {
      c.fillStyle = "#fff";
      c.font = "9px monospace";
      c.textBaseline = "bottom";
      c.fillText(`${Math.round(pt.value)} BPM`, x + 7, y - 1);
    }
  });

  // "BPM AUTO" label pinned to left edge of viewport
  c.fillStyle = "rgba(232,160,32,0.6)";
  c.font = "bold 10px monospace";
  c.textBaseline = "middle";
  c.fillText("BPM AUTO", vpLeft + 6, laneY + BPM_H / 2);
}

function _bpmToY(bpm, laneY) {
  const v = 1 - (Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)) - BPM_MIN) / (BPM_MAX - BPM_MIN);
  return laneY + AUTO_PT_R + v * (BPM_H - AUTO_PT_R * 2);
}

function _yToBpm(y, laneY) {
  const v = 1 - (y - laneY - AUTO_PT_R) / (BPM_H - AUTO_PT_R * 2);
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(BPM_MIN + v * (BPM_MAX - BPM_MIN))));
}

function _findBpmPoint(mx) {
  const points = state.bpmAutomation ?? [];
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(mx - points[i].time * state.pxPerSec) <= AUTO_PT_R + 4) return i;
  }
  return -1;
}

function drawPlayhead(H) {
  const c = ctx2d;
  const x = Math.round(state.playhead * state.pxPerSec) + 0.5;

  c.strokeStyle = C.playhead;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(x, 0);
  c.lineTo(x, H);
  c.stroke();

  // Triangle marker
  c.fillStyle = C.playhead;
  c.beginPath();
  c.moveTo(x - 6, 0);
  c.lineTo(x + 6, 0);
  c.lineTo(x, 10);
  c.closePath();
  c.fill();
}

// ── Interaction ──────────────────────────────────────────────

function onMouseDown(e) {
  if (e.button !== 0) return;
  const { x, y } = mousePos(e);
  const region = hitTest(x, y);

  drag.startMouseX = x;
  drag.startMouseY = y;
  drag.moved = false;

  if (region.zone === "ruler") {
    drag.type = "playhead";
    onSeek(x / state.pxPerSec);
  } else if (region.zone === "bpm") {
    const ptIndex = _findBpmPoint(x);
    if (ptIndex >= 0) {
      drag.type = "bpm_point";
      drag.pointIndex = ptIndex;
    } else {
      // Add new BPM point on click
      const time = x / state.pxPerSec;
      const bpm = _yToBpm(y, region.laneY);
      const newPoints = [...(state.bpmAutomation ?? []), { time, value: bpm }].sort((a, b) => a.time - b.time);
      onBpmAutomationEdit?.(newPoints);
      drag.type = "bpm_point";
      drag.pointIndex = newPoints.findIndex((p) => p.time === time && p.value === bpm);
    }
  } else if (region.zone === "track") {
    drag.type = "track";
    drag.trackId = region.track.id;
    drag.startValue = region.track.startTime;
    canvas.style.cursor = "grabbing";
    onTrackMoveStart?.(region.track.id);
  } else if (region.zone === "auto") {
    const track = region.track;
    const ya = RULER_H + region.trackIndex * TRACK_TOTAL + TRACK_H + TRACK_GAP;
    const ptIndex = findAutoPoint(track, x, ya);

    if (ptIndex >= 0) {
      drag.type = "auto_point";
      drag.trackId = track.id;
      drag.pointIndex = ptIndex;
    } else {
      // Add new point on click — convert canvas x to audio-file time
      const audioTime = _xToAudioTime(track, x);
      if (audioTime >= 0 && audioTime <= track.duration) {
        const value = autoYToValue(y, ya);
        const newPoints = [...(track.automation ?? []), { time: audioTime, value }].sort((a, b) => a.time - b.time);
        onAutomationEdit(track.id, newPoints);
        drag.type = "auto_point";
        drag.trackId = track.id;
        drag.pointIndex = newPoints.findIndex((p) => p.time === audioTime && p.value === value);
      }
    }
  }
}

function onMouseMove(e) {
  const { x, y } = mousePos(e);
  drag.moved = true;

  if (drag.type === "playhead") {
    onSeek(Math.max(0, x / state.pxPerSec));
  } else if (drag.type === "track") {
    const dx = x - drag.startMouseX;
    const newStart = Math.max(0, drag.startValue + _pxToBeats(dx));
    onTrackMove(drag.trackId, newStart);
  } else if (drag.type === "auto_point") {
    const track = state.tracks.find((t) => t.id === drag.trackId);
    if (!track) return;
    const idx = state.tracks.indexOf(track);
    const ya = RULER_H + idx * TRACK_TOTAL + TRACK_H + TRACK_GAP;

    const newTime = Math.max(0, Math.min(track.duration, _xToAudioTime(track, x)));
    const newValue = autoYToValue(y, ya);

    const newPoints = (track.automation ?? []).map((pt, i) =>
      i === drag.pointIndex ? { time: newTime, value: newValue } : pt,
    );
    onAutomationEdit(drag.trackId, newPoints);
  } else if (drag.type === "bpm_point") {
    const laneY = RULER_H + state.tracks.length * TRACK_TOTAL;
    const newTime = Math.max(0, x / state.pxPerSec);
    const newBpm = _yToBpm(y, laneY);
    const newPoints = (state.bpmAutomation ?? []).map((pt, i) =>
      i === drag.pointIndex ? { time: newTime, value: newBpm } : pt,
    );
    onBpmAutomationEdit?.(newPoints);
  } else {
    // Update cursor based on hover
    const region = hitTest(x, y);
    if (region.zone === "track") canvas.style.cursor = "grab";
    else if (region.zone === "ruler") canvas.style.cursor = "col-resize";
    else if (region.zone === "bpm") canvas.style.cursor = "crosshair";
    else canvas.style.cursor = "crosshair";
  }
}

function onMouseUp(e) {
  if (drag.type !== "none") {
    drag.type = "none";
    drag.trackId = null;
    drag.pointIndex = -1;
    canvas.style.cursor = "crosshair";
  }
}

function onContextMenu(e) {
  e.preventDefault();
  const { x, y } = mousePos(e);
  const region = hitTest(x, y);

  if (region.zone === "bpm") {
    const ptIndex = _findBpmPoint(x);
    if (ptIndex >= 0) {
      const pts = state.bpmAutomation ?? [];
      showContextMenu(e.clientX, e.clientY, [
        { label: `${Math.round(pts[ptIndex].value)} BPM`, disabled: true },
        { separator: true },
        {
          label: "Delete BPM point",
          action: () => onBpmAutomationEdit?.(pts.filter((_, i) => i !== ptIndex)),
          danger: true,
        },
      ]);
    }
  } else if (region.zone === "auto") {
    const track = region.track;
    const ya = RULER_H + region.trackIndex * TRACK_TOTAL + TRACK_H + TRACK_GAP;
    const ptIndex = findAutoPoint(track, x, ya);
    if (ptIndex >= 0) {
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "Delete point",
          action: () => {
            const pts = (track.automation ?? []).filter((_, i) => i !== ptIndex);
            onAutomationEdit(track.id, pts);
          },
          danger: true,
        },
      ]);
    }
  } else if (region.zone === "track") {
    showContextMenu(e.clientX, e.clientY, [
      { label: `Track: ${region.track.name}`, disabled: true },
      { separator: true },
      {
        label: "Reset automation",
        action: () => {
          onAutomationEdit(region.track.id, [
            { time: 0, value: 1 },
            { time: region.track.duration, value: 1 },
          ]);
        },
      },
    ]);
  }
}

function onDblClick(e) {
  // Double-click automation lane to add point (already handled by single click)
}

// ── Hit testing ───────────────────────────────────────────────

function hitTest(x, y) {
  if (y < RULER_H) return { zone: "ruler" };

  const bpmLaneY = RULER_H + state.tracks.length * TRACK_TOTAL;
  if (y >= bpmLaneY) return { zone: "bpm", laneY: bpmLaneY };

  const relY = y - RULER_H;
  const trackIndex = Math.floor(relY / TRACK_TOTAL);
  const track = state.tracks[trackIndex];
  if (!track) return { zone: "empty" };

  const localY = relY - trackIndex * TRACK_TOTAL;

  if (localY < TRACK_H) {
    const tx = _beatToPx(track.startTime);
    const tw = _trackSetDuration(track) * state.pxPerSec;
    if (x >= tx && x <= tx + tw) return { zone: "track", track, trackIndex };
    return { zone: "empty" };
  }

  // Automation lane
  return { zone: "auto", track, trackIndex };
}

function findAutoPoint(track, mx, laneY) {
  const points = track.automation ?? [];
  for (let i = 0; i < points.length; i++) {
    const px = _audioTimeToX(track, points[i].time);
    if (Math.abs(mx - px) <= AUTO_PT_R + 4) return i;
  }
  return -1;
}

function autoYToValue(y, laneY) {
  const v = 1 - (y - laneY - AUTO_PT_R) / (AUTO_H - AUTO_PT_R * 2);
  return Math.min(1, Math.max(0, v));
}

// ── Utilities ────────────────────────────────────────────────

function mousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/**
 * Effective set-timeline duration of a track when tempo-synced.
 * If track BPM differs from master BPM, playback rate shifts and the
 * real-time duration changes: setDuration = audioDuration * trackBpm / masterBPM
 * (e.g. a 140 BPM track at 120 BPM master plays slower → takes more real time).
 */
function _trackSetDuration(track) {
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm || masterBpm;
  return (track.duration * trackBpm) / masterBpm;
}

/** Convert audio-file offset (seconds from track start) → canvas x. */
function _audioTimeToX(track, audioTime) {
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm || masterBpm;
  const startSec = track.startTime * (60 / masterBpm); // beats → seconds
  const setOffset = (audioTime * trackBpm) / masterBpm; // audio-sec → set-sec
  return (startSec + setOffset) * state.pxPerSec;
}

/** Convert canvas x → audio-file offset (seconds from track start). */
function _xToAudioTime(track, x) {
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm || masterBpm;
  const startSec = track.startTime * (60 / masterBpm); // beats → seconds
  const setOffset = x / state.pxPerSec - startSec;
  return (setOffset * masterBpm) / trackBpm;
}

function longestTrackEnd() {
  const masterBpm = state.masterBPM || 120;
  return state.tracks.reduce((max, t) => {
    const startSec = t.startTime * (60 / masterBpm);
    return Math.max(max, startSec + _trackSetDuration(t));
  }, 0);
}

/** Convert beat position to canvas x. */
function _beatToPx(beats) {
  const masterBpm = state.masterBPM || 120;
  return beats * (60 / masterBpm) * state.pxPerSec;
}

/** Convert canvas x delta to beats. */
function _pxToBeats(px) {
  const masterBpm = state.masterBPM || 120;
  return (px * masterBpm) / (60 * state.pxPerSec);
}

function gridStep() {
  const bpm = state.masterBPM || 120;
  const secPerBeat = 60 / bpm;
  const pxPerBeat = secPerBeat * state.pxPerSec;
  const beatSteps = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  const stepBeats = beatSteps.find((s) => s * pxPerBeat >= 80) ?? 256;
  return { stepBeats, stepSec: stepBeats * secPerBeat };
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBeat(sec) {
  const bpm = state.masterBPM || 120;
  const totalBeats = Math.round(((sec * bpm) / 60) * 10000) / 10000; // avoid float drift
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = Math.round(totalBeats % 4);
  return beat === 0 ? `${bar}` : `${bar}.${beat + 1}`;
}

// ── Context menu ─────────────────────────────────────────────

function showContextMenu(clientX, clientY, items) {
  let menu = document.getElementById("context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "context-menu";
    document.body.appendChild(menu);
  }
  menu.innerHTML = "";
  menu.className = "";

  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-separator";
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement("div");
    el.className = "ctx-item" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : "");
    el.textContent = item.label;
    if (item.action && !item.disabled)
      el.addEventListener("click", () => {
        item.action();
        menu.className = "hidden";
      });
    menu.appendChild(el);
  });

  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;

  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.className = "hidden";
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

/** Sync the left-panel scroll position with timeline vertical scroll. */
export function syncScroll(wrapper) {
  const body = document.getElementById("track-controls-body");
  if (!body) return;
  wrapper.addEventListener("scroll", () => {
    body.scrollTop = wrapper.scrollTop;
  });
}

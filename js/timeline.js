/**
 * Hybrid timeline renderer.
 *
 * What runs every animation frame:
 *   - Playhead div left position (one style.left write)
 *   - State-signature check to detect zoom / BPM / track changes
 *
 * What is event-driven (rebuilt only when state changes):
 *   - Ruler canvas, grid canvas, track block positions, beat SVGs,
 *     automation SVGs, BPM SVG
 *
 * DOM tree inside #timeline-scroll-wrapper:
 *   #tl-content  (position:relative, sized to full timeline)
 *     #tl-ruler  (position:sticky top:0)
 *       <canvas id="tl-ruler-canvas">
 *     <canvas id="tl-grid">   (absolute, behind tracks)
 *     #tl-tracks
 *       .tl-track-row  × N
 *         .tl-block  (absolute, left = beatToPx)
 *           <canvas class="tl-waveform">  (fixed 1200 px, CSS-stretched)
 *           .tl-block-label
 *           <svg class="tl-beat-svg">
 *         .tl-auto-lane
 *           <svg class="tl-auto-svg">  (full content width)
 *     #tl-bpm-lane
 *       <svg id="tl-bpm-svg">
 *     #tl-playhead  (absolute div, z-index:20)
 */

import { interpolateAutomation } from "./audio.js";

// ── Layout constants ──────────────────────────────────────────
const RULER_H = 28;
const TRACK_H = 64;
const AUTO_H = 48;
const TRACK_GAP = 2;
const TRACK_TOTAL = TRACK_H + AUTO_H + TRACK_GAP;
const BPM_H = 56;
const BPM_MIN = 40;
const BPM_MAX = 300;
const AUTO_PT_R = 5;
const MIN_SET_DURATION = 30;
const WAVEFORM_W = 1200; // fixed waveform canvas resolution (CSS stretches it)

// ── Colors ────────────────────────────────────────────────────
const C = {
  bg: "#1a1a1a",
  ruler: "#222222",
  rulerText: "#666666",
  rulerTick: "#444444",
  playhead: "#e8a020",
  autoLane: "#1e1e1e",
  autoLine: "#4a9eff",
  autoPt: "#4a9eff",
  autoPtSel: "#ffffff",
  sep: "#111111",
};

// ── Module state ──────────────────────────────────────────────
let wrapper = null;
let state = null;
let onSeek = null;
let onTrackMove = null;
let onTrackMoveStart = null;
let onTrackMoveEnd = null;
let onAutomationEdit = null;
let onBpmAutomationEdit = null;
let rafId = null;

// Created DOM nodes
let contentDiv = null;
let rulerCanvas = null;
let gridCanvas = null;
let tracksContainer = null;
let bpmLane = null;
let bpmSvg = null;
let playheadEl = null;

// Per-track DOM: Map<id, {rowEl, blockEl, waveCanvas, beatSvg, autoLane, autoSvg, labelDiv}>
const _trackDom = new Map();
// Waveform canvas cache: Map<id, HTMLCanvasElement>
const _waveCanvases = new Map();

// Dirty tracking
let _layoutSig = "";

// Drag state
const drag = {
  type: "none", // 'none'|'playhead'|'track'|'auto_point'|'bpm_point'
  trackId: null,
  pointIndex: -1,
  startMouseX: 0,
  startValue: 0, // beats (track) or time (bpm point)
};

// ── Public API ────────────────────────────────────────────────

export function init(wrapperEl, appState, callbacks) {
  wrapper = wrapperEl;
  state = appState;
  onSeek = callbacks.onSeek;
  onTrackMove = callbacks.onTrackMove;
  onTrackMoveStart = callbacks.onTrackMoveStart ?? null;
  onTrackMoveEnd = callbacks.onTrackMoveEnd ?? null;
  onAutomationEdit = callbacks.onAutomationEdit;
  onBpmAutomationEdit = callbacks.onBpmAutomationEdit ?? null;

  _buildDom();
  document.addEventListener("mousemove", _onMouseMove);
  document.addEventListener("mouseup", _onMouseUp);
  _startRaf();
}

export function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
  document.removeEventListener("mousemove", _onMouseMove);
  document.removeEventListener("mouseup", _onMouseUp);
}

/** Rebuild waveform canvas for a track (call after mute toggle or re-import). */
export function invalidateTrack(trackId) {
  _waveCanvases.delete(trackId);
  const dom = _trackDom.get(trackId);
  const track = state.tracks.find((t) => t.id === trackId);
  if (dom && track) {
    const newCanvas = _buildWaveformCanvas(track);
    _waveCanvases.set(trackId, newCanvas);
    newCanvas.style.cssText = dom.waveCanvas.style.cssText;
    dom.waveCanvas.replaceWith(newCanvas);
    dom.waveCanvas = newCanvas;
  }
  _forceLayoutUpdate();
}

/** Sync left-panel scroll with timeline vertical scroll. */
export function syncScroll(scrollWrapper) {
  const body = document.getElementById("track-controls-body");
  if (!body) return;
  scrollWrapper.addEventListener("scroll", () => {
    body.scrollTop = scrollWrapper.scrollTop;
  });
}

// ── DOM construction ──────────────────────────────────────────

function _buildDom() {
  wrapper.innerHTML = "";

  contentDiv = document.createElement("div");
  contentDiv.id = "tl-content";
  contentDiv.style.cssText = "position:relative; min-width:100%;";

  // ── Ruler (sticky top) ────────────────────────────────────
  const rulerDiv = document.createElement("div");
  rulerDiv.id = "tl-ruler";
  rulerDiv.style.cssText =
    `position:sticky; top:0; z-index:10; height:${RULER_H}px; ` +
    `background:${C.ruler}; overflow:hidden; cursor:col-resize;`;
  rulerCanvas = document.createElement("canvas");
  rulerCanvas.id = "tl-ruler-canvas";
  rulerCanvas.height = RULER_H;
  rulerCanvas.style.cssText = "display:block; position:absolute; top:0; left:0;";
  rulerDiv.appendChild(rulerCanvas);
  rulerDiv.addEventListener("mousedown", _onRulerMouseDown);
  contentDiv.appendChild(rulerDiv);

  // ── Grid canvas (behind tracks) ───────────────────────────
  gridCanvas = document.createElement("canvas");
  gridCanvas.id = "tl-grid";
  gridCanvas.style.cssText = `position:absolute; top:${RULER_H}px; left:0; pointer-events:none; z-index:0;`;
  contentDiv.appendChild(gridCanvas);

  // ── Tracks container ──────────────────────────────────────
  tracksContainer = document.createElement("div");
  tracksContainer.id = "tl-tracks";
  tracksContainer.style.cssText = "position:relative; z-index:1;";
  contentDiv.appendChild(tracksContainer);

  // ── BPM lane ──────────────────────────────────────────────
  bpmLane = document.createElement("div");
  bpmLane.id = "tl-bpm-lane";
  bpmLane.style.cssText = `position:relative; height:${BPM_H}px; background:#1a1a28; border-top:2px solid #111; overflow:visible;`;
  bpmSvg = _svg("svg");
  bpmSvg.id = "tl-bpm-svg";
  bpmSvg.setAttribute("height", BPM_H);
  bpmSvg.style.cssText = "position:absolute; top:0; left:0; overflow:visible;";
  bpmLane.appendChild(bpmSvg);
  // "BPM AUTO" label pinned to left edge while scrolling
  const bpmLabel = document.createElement("div");
  bpmLabel.style.cssText =
    `position:sticky; left:6px; display:inline-block; pointer-events:none; ` +
    `font:bold 10px monospace; color:rgba(232,160,32,0.6); ` +
    `line-height:${BPM_H}px; z-index:1;`;
  bpmLabel.textContent = "BPM AUTO";
  bpmLane.appendChild(bpmLabel);
  bpmLane.addEventListener("mousedown", _onBpmMouseDown);
  bpmLane.addEventListener("contextmenu", _onBpmContextMenu);
  contentDiv.appendChild(bpmLane);

  // ── Playhead ──────────────────────────────────────────────
  playheadEl = document.createElement("div");
  playheadEl.id = "tl-playhead";
  playheadEl.style.cssText =
    `position:absolute; top:0; left:0; width:2px; height:100%; ` +
    `background:${C.playhead}; pointer-events:none; z-index:20;`;
  // Triangle marker via child div
  const tri = document.createElement("div");
  tri.style.cssText =
    `position:absolute; top:0; left:-5px; width:0; height:0; ` +
    `border-left:6px solid transparent; border-right:6px solid transparent; ` +
    `border-top:10px solid ${C.playhead};`;
  playheadEl.appendChild(tri);
  contentDiv.appendChild(playheadEl);

  wrapper.appendChild(contentDiv);
}

// ── Per-track row ─────────────────────────────────────────────

function _ensureTrackRows() {
  const currentIds = new Set(state.tracks.map((t) => t.id));

  // Remove stale rows
  for (const [id, dom] of _trackDom) {
    if (!currentIds.has(id)) {
      dom.rowEl.remove();
      _trackDom.delete(id);
      _waveCanvases.delete(id);
    }
  }

  // Add / re-order rows to match state.tracks order
  state.tracks.forEach((track) => {
    if (!_trackDom.has(track.id)) _addTrackRow(track);
    // re-appending an existing child moves it to the end → preserves order
    tracksContainer.appendChild(_trackDom.get(track.id).rowEl);
  });
}

function _addTrackRow(track) {
  const rowEl = document.createElement("div");
  rowEl.className = "tl-track-row";
  rowEl.dataset.id = track.id;
  rowEl.style.cssText = `position:relative; height:${TRACK_TOTAL}px;`;

  // Separator line between track block and automation lane
  const sep = document.createElement("div");
  sep.style.cssText = `position:absolute; left:0; right:0; top:${TRACK_H}px; height:${TRACK_GAP}px; background:${C.sep};`;
  rowEl.appendChild(sep);

  // ── Track block ──────────────────────────────────────────
  const blockEl = document.createElement("div");
  blockEl.className = "tl-block";
  blockEl.style.cssText =
    `position:absolute; top:0; height:${TRACK_H}px; overflow:hidden; cursor:grab; ` +
    `border-left:3px solid ${track.color};`;
  blockEl.addEventListener("mousedown", (e) => _onTrackMouseDown(e, track));
  blockEl.addEventListener("contextmenu", (e) => _onTrackContextMenu(e, track));

  // Waveform canvas (fixed-resolution, CSS-stretched)
  const waveCanvas = _getOrBuildWaveCanvas(track);
  waveCanvas.style.cssText = "position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none;";
  blockEl.appendChild(waveCanvas);

  // Text labels
  const labelDiv = document.createElement("div");
  labelDiv.className = "tl-block-label";
  labelDiv.style.cssText =
    "position:absolute; top:6px; left:8px; pointer-events:none; user-select:none; overflow:hidden; right:4px;";
  blockEl.appendChild(labelDiv);

  // Beat-grid SVG
  const beatSvg = _svg("svg");
  beatSvg.setAttribute("class", "tl-beat-svg");
  beatSvg.style.cssText = "position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible;";
  beatSvg.setAttribute("height", TRACK_H);
  blockEl.appendChild(beatSvg);

  rowEl.appendChild(blockEl);

  // ── Automation lane ───────────────────────────────────────
  const autoLane = document.createElement("div");
  autoLane.className = "tl-auto-lane";
  autoLane.style.cssText =
    `position:absolute; left:0; right:0; top:${TRACK_H + TRACK_GAP}px; ` +
    `height:${AUTO_H}px; background:${C.autoLane}; overflow:visible; cursor:crosshair;`;

  const autoSvg = _svg("svg");
  autoSvg.setAttribute("class", "tl-auto-svg");
  autoSvg.setAttribute("height", AUTO_H);
  autoSvg.style.cssText = "position:absolute; top:0; left:0; overflow:visible;";
  autoSvg.addEventListener("mousedown", (e) => _onAutoMouseDown(e, track));
  autoSvg.addEventListener("contextmenu", (e) => _onAutoContextMenu(e, track));
  autoLane.appendChild(autoSvg);
  rowEl.appendChild(autoLane);

  _trackDom.set(track.id, { rowEl, blockEl, waveCanvas, beatSvg, autoLane, autoSvg, labelDiv });
}

// ── Waveform canvas ───────────────────────────────────────────

function _getOrBuildWaveCanvas(track) {
  if (_waveCanvases.has(track.id)) return _waveCanvases.get(track.id);
  const oc = _buildWaveformCanvas(track);
  _waveCanvases.set(track.id, oc);
  return oc;
}

function _buildWaveformCanvas(track) {
  const oc = document.createElement("canvas");
  oc.width = WAVEFORM_W;
  oc.height = TRACK_H;
  const c = oc.getContext("2d");

  c.fillStyle = track.color + (track.muted ? "55" : "cc");
  c.fillRect(0, 0, WAVEFORM_W, TRACK_H);

  if (track.waveform?.length) {
    c.fillStyle = track.muted ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.16)";
    const len = track.waveform.length;
    const mid = TRACK_H / 2;
    for (let i = 0; i < WAVEFORM_W; i++) {
      const wIdx = Math.floor((i / WAVEFORM_W) * len);
      const amp = (track.waveform[wIdx] ?? 0) * (TRACK_H - 8);
      c.fillRect(i, mid - amp / 2, 1, amp || 1);
    }
  }
  return oc;
}

// ── Layout update ─────────────────────────────────────────────

function _updateLayout() {
  const masterBpm = state.masterBPM || 120;
  const totalSec = Math.max(MIN_SET_DURATION, _longestTrackEnd() + 10);
  const contentW = Math.max(wrapper.clientWidth, Math.ceil(totalSec * state.pxPerSec) + 40);
  const tracksH = Math.max(1, state.tracks.length) * TRACK_TOTAL;

  contentDiv.style.width = contentW + "px";
  contentDiv.style.height = RULER_H + tracksH + BPM_H + "px";

  // Tracks container must be at least tracksH tall to cover the grid canvas
  tracksContainer.style.minHeight = tracksH + "px";

  // Ruler
  rulerCanvas.width = contentW;
  _drawRuler(contentW);

  // Grid (only covers tracks area)
  gridCanvas.width = contentW;
  gridCanvas.height = tracksH;
  _drawGrid(contentW, tracksH);

  // Track rows
  _ensureTrackRows();

  state.tracks.forEach((track) => {
    const dom = _trackDom.get(track.id);
    if (!dom) return;

    const x = Math.round(_beatToPx(track.startTime));
    const w = Math.max(1, Math.round(_trackSetDuration(track) * state.pxPerSec));

    dom.blockEl.style.left = x + "px";
    dom.blockEl.style.width = w + "px";
    dom.blockEl.style.borderLeftColor = track.color;

    // Labels
    const syncLabel =
      track.bpm && Math.abs(track.bpm - masterBpm) > 0.5 ? `${track.bpm}→${masterBpm} BPM` : `${track.bpm ?? "?"} BPM`;
    dom.labelDiv.innerHTML =
      `<div style="color:${track.muted ? "#777" : "#fff"};font:bold 11px monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(track.name)}</div>` +
      `<div style="color:#ffffff88;font:10px monospace">${syncLabel}  ${_formatTime(_trackSetDuration(track))}</div>`;

    // Beat grid SVG
    dom.beatSvg.innerHTML = "";
    _buildBeatSvg(track, dom.beatSvg);

    // Automation SVG
    dom.autoSvg.setAttribute("width", contentW);
    dom.autoSvg.innerHTML = "";
    _buildAutoSvg(track, dom.autoSvg, contentW);
  });

  // BPM SVG
  bpmSvg.setAttribute("width", contentW);
  bpmSvg.innerHTML = "";
  _buildBpmSvg(contentW);
}

// ── Grid + Ruler (canvas) ─────────────────────────────────────

function _drawGrid(W, H) {
  const c = gridCanvas.getContext("2d");
  c.clearRect(0, 0, W, H);
  const bpm = state.masterBPM || 120;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const barPx = barSec * state.pxPerSec;
  const beatPx = beatSec * state.pxPerSec;
  const totalSec = W / state.pxPerSec;

  if (barPx >= 2) {
    c.strokeStyle = "rgba(232,160,32,0.10)";
    c.lineWidth = 1;
    for (let t = 0; t < totalSec + barSec; t += barSec) {
      const x = Math.round(t * state.pxPerSec) + 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
    }
  }
  if (beatPx >= 5) {
    c.strokeStyle = "rgba(255,255,255,0.05)";
    c.lineWidth = 1;
    for (let t = 0; t < totalSec + beatSec; t += beatSec) {
      if (t % barSec < 0.001) continue;
      const x = Math.round(t * state.pxPerSec) + 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
    }
  }
}

function _drawRuler(W) {
  const c = rulerCanvas.getContext("2d");
  c.clearRect(0, 0, W, RULER_H);
  c.fillStyle = C.ruler;
  c.fillRect(0, 0, W, RULER_H);

  const { stepSec } = _gridStep();
  c.fillStyle = C.rulerText;
  c.font = "10px monospace";
  c.textBaseline = "middle";
  c.lineWidth = 1;

  for (let t = 0; t * state.pxPerSec < W; t += stepSec) {
    const x = Math.round(t * state.pxPerSec) + 0.5;
    c.strokeStyle = C.rulerTick;
    c.beginPath();
    c.moveTo(x, RULER_H - 6);
    c.lineTo(x, RULER_H);
    c.stroke();
    if (x > 20) c.fillText(_formatBeat(t), x + 3, RULER_H / 2);
  }
}

// ── Beat-grid SVG ─────────────────────────────────────────────

function _buildBeatSvg(track, svg) {
  if (!track.bpm || track.beatOffset === undefined) return;
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm;
  const beatSec = 60 / trackBpm;
  const beatPx = ((beatSec * trackBpm) / masterBpm) * state.pxPerSec;
  if (beatPx < 2) return;

  const nStart = Math.floor((0 - track.beatOffset) / beatSec) - 1;
  const nEnd = Math.ceil((track.duration - track.beatOffset) / beatSec) + 1;

  for (let n = nStart; n <= nEnd; n++) {
    const audioTime = track.beatOffset + n * beatSec;
    if (audioTime < 0 || audioTime > track.duration) continue;
    const bx = ((audioTime * trackBpm) / masterBpm) * state.pxPerSec;
    const isBar = n % 4 === 0;
    const isBeat1 = n === 0;
    if (!isBeat1 && !isBar && beatPx < 6) continue;

    const line = _svg("line");
    line.setAttribute("x1", bx);
    line.setAttribute("x2", bx);
    line.setAttribute("y1", 0);
    line.setAttribute("y2", TRACK_H);
    if (isBeat1) {
      line.setAttribute("stroke", "rgba(232,160,32,0.9)");
      line.setAttribute("stroke-width", "1.5");
    } else if (isBar) {
      line.setAttribute("stroke", "rgba(232,160,32,0.45)");
      line.setAttribute("stroke-width", "1");
    } else {
      line.setAttribute("stroke", "rgba(255,255,255,0.2)");
      line.setAttribute("stroke-width", "0.5");
    }
    svg.appendChild(line);
  }
}

// ── Automation SVG ────────────────────────────────────────────

function _buildAutoSvg(track, svg, contentW) {
  const points = track.automation ?? [];
  if (!points.length) return;

  const sorted = [...points].sort((a, b) => a.time - b.time);
  const toX = (t) => _audioTimeToX(track, t);
  const toY = (v) => Math.round(AUTO_PT_R + (1 - v) * (AUTO_H - AUTO_PT_R * 2));
  const trackXStart = Math.round(_beatToPx(track.startTime));
  const trackXEnd = trackXStart + Math.round(_trackSetDuration(track) * state.pxPerSec);

  // Lead-in
  _appendSvgLine(
    svg,
    trackXStart,
    toY(sorted[0].value),
    toX(sorted[0].time),
    toY(sorted[0].value),
    C.autoLine + "55",
    1,
  );

  // Polyline through points
  const poly = _svg("polyline");
  poly.setAttribute("points", sorted.map((p) => `${toX(p.time)},${toY(p.value)}`).join(" "));
  poly.setAttribute("stroke", C.autoLine);
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("fill", "none");
  svg.appendChild(poly);

  // Tail
  _appendSvgLine(
    svg,
    toX(sorted[sorted.length - 1].time),
    toY(sorted[sorted.length - 1].value),
    trackXEnd,
    toY(sorted[sorted.length - 1].value),
    C.autoLine + "55",
    1,
  );

  // Points
  sorted.forEach((pt, i) => {
    const cx = toX(pt.time);
    const cy = toY(pt.value);
    const isSelected = drag.type === "auto_point" && drag.trackId === track.id && drag.pointIndex === i;

    const circle = _svg("circle");
    circle.setAttribute("cx", cx);
    circle.setAttribute("cy", cy);
    circle.setAttribute("r", AUTO_PT_R);
    circle.setAttribute("fill", isSelected ? C.autoPtSel : C.autoPt);
    circle.setAttribute("stroke", "#000");
    circle.setAttribute("stroke-width", "1");
    circle.style.cursor = "pointer";
    svg.appendChild(circle);

    if (isSelected) {
      const lbl = _svg("text");
      lbl.setAttribute("x", cx + 7);
      lbl.setAttribute("y", cy - 1);
      lbl.setAttribute("font-size", "9");
      lbl.setAttribute("font-family", "monospace");
      lbl.setAttribute("fill", "#fff");
      lbl.textContent = `${Math.round(pt.value * 100)}%`;
      svg.appendChild(lbl);
    }
  });
}

// ── BPM SVG ───────────────────────────────────────────────────

function _buildBpmSvg(contentW) {
  const bpmToY = (bpm) => {
    const v = 1 - (Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)) - BPM_MIN) / (BPM_MAX - BPM_MIN);
    return AUTO_PT_R + v * (BPM_H - AUTO_PT_R * 2);
  };

  // Reference lines + labels
  for (let b = BPM_MIN; b <= BPM_MAX; b += 40) {
    const y = Math.round(bpmToY(b)) + 0.5;
    _appendSvgLine(bpmSvg, 0, y, contentW, y, "rgba(255,255,255,0.04)", 1);
    const lbl = _svg("text");
    lbl.setAttribute("x", 3);
    lbl.setAttribute("y", y + 3);
    lbl.setAttribute("font-size", "8");
    lbl.setAttribute("font-family", "monospace");
    lbl.setAttribute("fill", "rgba(255,255,255,0.18)");
    lbl.textContent = `${b}`;
    bpmSvg.appendChild(lbl);
  }

  const points = state.bpmAutomation ?? [];

  if (points.length === 0) {
    const y = Math.round(bpmToY(state.masterBPM)) + 0.5;
    const line = _appendSvgLine(bpmSvg, 0, y, contentW, y, "rgba(232,160,32,0.35)", 1);
    line.setAttribute("stroke-dasharray", "4 4");
  } else {
    const sorted = [...points].sort((a, b) => a.time - b.time);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    _appendSvgLine(
      bpmSvg,
      0,
      bpmToY(first.value),
      first.time * state.pxPerSec,
      bpmToY(first.value),
      "rgba(232,160,32,0.3)",
      1,
    );

    const poly = _svg("polyline");
    poly.setAttribute("points", sorted.map((p) => `${p.time * state.pxPerSec},${bpmToY(p.value)}`).join(" "));
    poly.setAttribute("stroke", "#e8a020");
    poly.setAttribute("stroke-width", "1.5");
    poly.setAttribute("fill", "none");
    bpmSvg.appendChild(poly);

    _appendSvgLine(
      bpmSvg,
      last.time * state.pxPerSec,
      bpmToY(last.value),
      contentW,
      bpmToY(last.value),
      "rgba(232,160,32,0.3)",
      1,
    );

    sorted.forEach((pt, i) => {
      const cx = pt.time * state.pxPerSec;
      const cy = bpmToY(pt.value);
      const isSelected = drag.type === "bpm_point" && drag.pointIndex === i;

      const circle = _svg("circle");
      circle.setAttribute("cx", cx);
      circle.setAttribute("cy", cy);
      circle.setAttribute("r", AUTO_PT_R);
      circle.setAttribute("fill", isSelected ? "#fff" : "#e8a020");
      circle.setAttribute("stroke", "#000");
      circle.setAttribute("stroke-width", "1");
      circle.style.cursor = "pointer";
      bpmSvg.appendChild(circle);

      if (isSelected) {
        const lbl = _svg("text");
        lbl.setAttribute("x", cx + 7);
        lbl.setAttribute("y", cy - 1);
        lbl.setAttribute("font-size", "9");
        lbl.setAttribute("font-family", "monospace");
        lbl.setAttribute("fill", "#fff");
        lbl.textContent = `${Math.round(pt.value)} BPM`;
        bpmSvg.appendChild(lbl);
      }
    });
  }
}

// ── RAF loop ──────────────────────────────────────────────────

function _stateSignature() {
  return (
    state.pxPerSec +
    "|" +
    state.masterBPM +
    "|" +
    (state.bpmAutomation?.length ?? 0) +
    "|" +
    state.tracks
      .map(
        (t) =>
          `${t.id}:${t.startTime}:${t.bpm}:${t.beatOffset ?? 0}:${t.muted ? 1 : 0}:${t.color}:${(t.automation ?? []).length}`,
      )
      .join(",")
  );
}

function _forceLayoutUpdate() {
  _layoutSig = ""; // invalidate so next frame triggers rebuild
}

function _startRaf() {
  function frame() {
    // Check if anything changed
    const sig = _stateSignature();
    if (sig !== _layoutSig) {
      _layoutSig = sig;
      _updateLayout();
    }

    // Playhead — only thing that moves every frame
    if (playheadEl && state) {
      playheadEl.style.left = Math.round(state.playhead * state.pxPerSec) + "px";
    }

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

// ── Interactions ──────────────────────────────────────────────

function _contentX(clientX) {
  return clientX - wrapper.getBoundingClientRect().left + wrapper.scrollLeft;
}
function _contentY(clientY) {
  return clientY - wrapper.getBoundingClientRect().top + wrapper.scrollTop;
}

function _onRulerMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  drag.type = "playhead";
  onSeek(Math.max(0, _contentX(e.clientX) / state.pxPerSec));
}

function _onTrackMouseDown(e, track) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  drag.type = "track";
  drag.trackId = track.id;
  drag.startValue = track.startTime;
  drag.startMouseX = e.clientX;
  onTrackMoveStart?.(track.id);
  _trackDom.get(track.id)?.blockEl.style.setProperty("cursor", "grabbing");
}

function _onAutoMouseDown(e, track) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const x = _contentX(e.clientX);
  const y = _contentY(e.clientY);
  const idx = state.tracks.findIndex((t) => t.id === track.id);
  const laneY = RULER_H + idx * TRACK_TOTAL + TRACK_H + TRACK_GAP;

  const points = track.automation ?? [];
  let ptIndex = points.findIndex((p) => Math.abs(_audioTimeToX(track, p.time) - x) <= AUTO_PT_R + 4);

  if (ptIndex >= 0) {
    drag.type = "auto_point";
    drag.trackId = track.id;
    drag.pointIndex = ptIndex;
    drag.startMouseX = e.clientX;
  } else {
    const audioTime = _xToAudioTime(track, x);
    if (audioTime >= 0 && audioTime <= track.duration) {
      const value = _autoYToValue(y, laneY);
      const newPoints = [...points, { time: audioTime, value }].sort((a, b) => a.time - b.time);
      onAutomationEdit(track.id, newPoints);
      drag.type = "auto_point";
      drag.trackId = track.id;
      drag.pointIndex = newPoints.findIndex((p) => p.time === audioTime && p.value === value);
      drag.startMouseX = e.clientX;
    }
  }
}

function _onBpmMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const x = _contentX(e.clientX);
  const y = _contentY(e.clientY) - (RULER_H + state.tracks.length * TRACK_TOTAL + 2);

  const points = state.bpmAutomation ?? [];
  let ptIndex = points.findIndex((p) => Math.abs(p.time * state.pxPerSec - x) <= AUTO_PT_R + 4);

  if (ptIndex >= 0) {
    drag.type = "bpm_point";
    drag.pointIndex = ptIndex;
    drag.startMouseX = e.clientX;
    drag.startValue = points[ptIndex].time;
  } else {
    const time = x / state.pxPerSec;
    const bpm = _yToBpm(y);
    const newPoints = [...points, { time, value: bpm }].sort((a, b) => a.time - b.time);
    onBpmAutomationEdit?.(newPoints);
    drag.type = "bpm_point";
    drag.pointIndex = newPoints.findIndex((p) => p.time === time && p.value === bpm);
    drag.startMouseX = e.clientX;
  }
}

function _onMouseMove(e) {
  if (drag.type === "none") return;

  const x = _contentX(e.clientX);
  const y = _contentY(e.clientY);

  if (drag.type === "playhead") {
    onSeek(Math.max(0, x / state.pxPerSec));
  } else if (drag.type === "track") {
    const dx = e.clientX - drag.startMouseX;
    onTrackMove(drag.trackId, Math.max(0, drag.startValue + _pxToBeats(dx)));
  } else if (drag.type === "auto_point") {
    const track = state.tracks.find((t) => t.id === drag.trackId);
    if (!track) return;
    const idx = state.tracks.indexOf(track);
    const laneY = RULER_H + idx * TRACK_TOTAL + TRACK_H + TRACK_GAP;
    const newTime = Math.max(0, Math.min(track.duration, _xToAudioTime(track, x)));
    const newValue = _autoYToValue(y, laneY);
    const newPoints = (track.automation ?? []).map((pt, i) =>
      i === drag.pointIndex ? { time: newTime, value: newValue } : pt,
    );
    onAutomationEdit(drag.trackId, newPoints);
  } else if (drag.type === "bpm_point") {
    const newTime = Math.max(0, x / state.pxPerSec);
    const laneLocalY = y - (RULER_H + state.tracks.length * TRACK_TOTAL + 2);
    const newBpm = _yToBpm(laneLocalY);
    const newPoints = (state.bpmAutomation ?? []).map((pt, i) =>
      i === drag.pointIndex ? { time: newTime, value: newBpm } : pt,
    );
    onBpmAutomationEdit?.(newPoints);
  }
}

function _onMouseUp(e) {
  if (drag.type === "track") {
    const dom = _trackDom.get(drag.trackId);
    if (dom) dom.blockEl.style.removeProperty("cursor");
    onTrackMoveEnd?.(drag.trackId);
  }
  drag.type = "none";
  drag.trackId = null;
  drag.pointIndex = -1;
}

function _onTrackContextMenu(e, track) {
  e.preventDefault();
  _showContextMenu(e.clientX, e.clientY, [
    { label: `Track: ${track.name}`, disabled: true },
    { separator: true },
    {
      label: "Reset automation",
      action: () =>
        onAutomationEdit(track.id, [
          { time: 0, value: 1 },
          { time: track.duration, value: 1 },
        ]),
    },
  ]);
}

function _onAutoContextMenu(e, track) {
  e.preventDefault();
  const x = _contentX(e.clientX);
  const points = track.automation ?? [];
  const ptIndex = points.findIndex((p) => Math.abs(_audioTimeToX(track, p.time) - x) <= AUTO_PT_R + 4);
  if (ptIndex >= 0) {
    _showContextMenu(e.clientX, e.clientY, [
      {
        label: "Delete point",
        action: () =>
          onAutomationEdit(
            track.id,
            points.filter((_, i) => i !== ptIndex),
          ),
        danger: true,
      },
    ]);
  }
}

function _onBpmContextMenu(e) {
  e.preventDefault();
  const x = _contentX(e.clientX);
  const points = state.bpmAutomation ?? [];
  const ptIndex = points.findIndex((p) => Math.abs(p.time * state.pxPerSec - x) <= AUTO_PT_R + 4);
  if (ptIndex >= 0) {
    _showContextMenu(e.clientX, e.clientY, [
      { label: `${Math.round(points[ptIndex].value)} BPM`, disabled: true },
      { separator: true },
      {
        label: "Delete BPM point",
        action: () => onBpmAutomationEdit?.(points.filter((_, i) => i !== ptIndex)),
        danger: true,
      },
    ]);
  }
}

// ── Utilities ─────────────────────────────────────────────────

function _svg(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function _appendSvgLine(parent, x1, y1, x2, y2, stroke, width) {
  const line = _svg("line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", width);
  parent.appendChild(line);
  return line;
}

function _esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _autoYToValue(y, laneY) {
  const v = 1 - (y - laneY - AUTO_PT_R) / (AUTO_H - AUTO_PT_R * 2);
  return Math.min(1, Math.max(0, v));
}

function _yToBpm(localY) {
  const v = 1 - (localY - AUTO_PT_R) / (BPM_H - AUTO_PT_R * 2);
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(BPM_MIN + v * (BPM_MAX - BPM_MIN))));
}

function _longestTrackEnd() {
  const masterBpm = state.masterBPM || 120;
  return state.tracks.reduce((max, t) => {
    return Math.max(max, t.startTime * (60 / masterBpm) + _trackSetDuration(t));
  }, 0);
}

function _beatToPx(beats) {
  return beats * (60 / (state.masterBPM || 120)) * state.pxPerSec;
}

function _pxToBeats(px) {
  return (px * (state.masterBPM || 120)) / (60 * state.pxPerSec);
}

function _trackSetDuration(track) {
  const masterBpm = state.masterBPM || 120;
  return (track.duration * (track.bpm || masterBpm)) / masterBpm;
}

function _audioTimeToX(track, audioTime) {
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm || masterBpm;
  return (track.startTime * (60 / masterBpm) + (audioTime * trackBpm) / masterBpm) * state.pxPerSec;
}

function _xToAudioTime(track, x) {
  const masterBpm = state.masterBPM || 120;
  const trackBpm = track.bpm || masterBpm;
  const startSec = track.startTime * (60 / masterBpm);
  return ((x / state.pxPerSec - startSec) * masterBpm) / trackBpm;
}

function _gridStep() {
  const bpm = state.masterBPM || 120;
  const secPerBeat = 60 / bpm;
  const pxPerBeat = secPerBeat * state.pxPerSec;
  const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  const stepBeats = steps.find((s) => s * pxPerBeat >= 80) ?? 256;
  return { stepBeats, stepSec: stepBeats * secPerBeat };
}

function _formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function _formatBeat(sec) {
  const bpm = state.masterBPM || 120;
  const totalBeats = Math.round(((sec * bpm) / 60) * 10000) / 10000;
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = Math.round(totalBeats % 4);
  return beat === 0 ? `${bar}` : `${bar}.${beat + 1}`;
}

function _showContextMenu(clientX, clientY, items) {
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

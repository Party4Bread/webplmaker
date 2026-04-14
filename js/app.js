/**
 * app.js — main coordinator
 * Owns global state, wires up all modules, manages UI.
 */

import * as OPFS from "./opfs.js";
import * as Audio from "./audio.js";
import { detectBPM } from "./bpm.js";
import * as Timeline from "./timeline.js";
import * as Metronome from "./metronome.js";
import * as BeatGrid from "./beatgrid.js";

// ── Track colours (cycles) ───────────────────────────────────
const TRACK_COLORS = ["#e8622a", "#4a9eff", "#50c878", "#e8c820", "#c050e8", "#e85078", "#20c8e8", "#78e850"];
let colorIdx = 0;
function nextColor() {
  return TRACK_COLORS[colorIdx++ % TRACK_COLORS.length];
}

// ── Global state ─────────────────────────────────────────────
// snapMode + masterBPM are shared with timeline.js so it can draw the beat grid
const state = {
  tracks: [],
  playhead: 0,
  pxPerSec: 30,
  snapMode: "off", // 'off' | 'beat' | 'bar'
  masterBPM: 120, // kept in sync with the BPM input
  bpmAutomation: [{ time: 0, value: 120 }], // global BPM curve [{time (set-sec), value (BPM)}]
};

// ── Audio cache (id → { audioBuffer, waveform }) for undo of deletions ──
const audioCache = new Map();

// ── DOM refs ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const btnImport = $("btn-import");
const btnSave = $("btn-save");
const btnPlay = $("btn-play");
const btnStop = $("btn-stop");
const btnUndo = $("btn-undo");
const btnRedo = $("btn-redo");
const btnTapBpm = $("btn-tap-bpm");
const btnSnap = $("btn-snap");
const btnMetro = $("btn-metro");
const metroVolume = $("metro-volume");
const btnZoomIn = $("btn-zoom-in");
const btnZoomOut = $("btn-zoom-out");
const btnZoomFit = $("btn-zoom-fit");
const fileInput = $("file-input");
const masterBpm = $("master-bpm");
const playheadDisplay = $("playhead-display");
const zoomDisplay = $("zoom-display");
const statusText = $("status-text");
const opfsIndicator = $("opfs-indicator");
const trackControlsBody = $("track-controls-body");
const scrollWrapper = $("timeline-scroll-wrapper");

// Drop overlay — created lazily
let dropOverlay;
function ensureDropOverlay() {
  if (dropOverlay) return;
  dropOverlay = document.createElement("div");
  dropOverlay.id = "drop-overlay";
  dropOverlay.className = "hidden";
  dropOverlay.innerHTML = `<div class="drop-label">🎵 Drop audio files to import</div>`;
  document.body.appendChild(dropOverlay);
}

// ── Undo / Redo ───────────────────────────────────────────────
const MAX_HISTORY = 50;
const undoStack = [];
const redoStack = [];

/** Serialise current track list (no AudioBuffer/waveform). */
function snapshotTracks() {
  return state.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    filename: t.filename,
    startTime: t.startTime,
    duration: t.duration,
    bpm: t.bpm,
    beatOffset: t.beatOffset ?? 0,
    volume: t.volume,
    muted: t.muted,
    color: t.color,
    automation: JSON.parse(JSON.stringify(t.automation ?? [])),
  }));
}

function snapshotBpmAuto() {
  return JSON.parse(JSON.stringify(state.bpmAutomation ?? []));
}

/** Push snapshot to undo stack before a mutating operation. */
function pushUndo() {
  undoStack.push(snapshotTracks());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  syncUndoButtons();
}

function syncUndoButtons() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

/** Restore a snapshot into state.tracks, reusing cached audio. */
function applySnapshot(snap) {
  // Build lookup of current audio assets
  for (const t of state.tracks) {
    if (!audioCache.has(t.id)) {
      audioCache.set(t.id, { audioBuffer: t.audioBuffer, waveform: t.waveform });
    }
  }

  // Rebuild track array from snapshot
  state.tracks = snap.map((saved) => {
    const existing = state.tracks.find((t) => t.id === saved.id);
    const cached = audioCache.get(saved.id) ?? {};
    return {
      ...saved,
      audioBuffer: existing?.audioBuffer ?? cached.audioBuffer ?? null,
      waveform: existing?.waveform ?? cached.waveform ?? null,
    };
  });

  if (Audio.isPlaying()) Audio.stop(false);
  renderTrackControls();
  scheduleSave();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotTracks());
  applySnapshot(undoStack.pop());
  syncUndoButtons();
  setStatus("Undo");
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotTracks());
  applySnapshot(redoStack.pop());
  syncUndoButtons();
  setStatus("Redo");
}

// ── Tap tempo ────────────────────────────────────────────────
const tapTimes = [];
let tapResetTimer = null;

function handleTapBpm() {
  const now = Date.now();

  // Reset tap sequence after 2 s of silence
  clearTimeout(tapResetTimer);
  tapResetTimer = setTimeout(() => {
    tapTimes.length = 0;
    btnTapBpm.classList.remove("tapping");
  }, 2000);

  tapTimes.push(now);
  btnTapBpm.classList.add("tapping");

  if (tapTimes.length < 2) {
    setStatus("Tap BPM — keep tapping…");
    return;
  }

  // Average interval across all recorded taps (more taps = more stable)
  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) {
    intervals.push(tapTimes[i] - tapTimes[i - 1]);
  }
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = Math.round(60000 / avgMs);
  const clamped = Math.min(300, Math.max(40, bpm));

  masterBpm.value = clamped;
  state.masterBPM = clamped;
  scheduleSave();
  setStatus(`Tap BPM: ${clamped} (${tapTimes.length} tap${tapTimes.length > 1 ? "s" : ""})`);
}

// ── Tap BPM popup (per-track) ────────────────────────────────

let tapPopupTrackId = null;
let popupTapTimes = [];
let popupTapTimer = null;
let tapPopupEl = null;

function buildTapPopup() {
  if (tapPopupEl) return;
  const el = document.createElement("div");
  el.id = "bpm-tap-modal";
  el.className = "hidden";
  el.innerHTML = `
    <div class="bpm-tap-panel">
      <div class="bpm-tap-header">
        <span class="bpm-tap-title">TAP BPM</span>
        <span class="bpm-tap-trackname" id="tap-track-name"></span>
        <button class="bpm-tap-close" id="tap-close">✕</button>
      </div>

      <button class="bpm-tap-zone" id="tap-zone" title="Click or press Space to tap">
        <span class="bpm-tap-value" id="tap-value">—</span>
        <span class="bpm-tap-unit">BPM</span>
      </button>

      <div class="bpm-tap-hint" id="tap-hint">Click the pad (or press Space) in beat</div>

      <div class="bpm-tap-confidence-bar">
        <div class="bpm-tap-confidence-fill" id="tap-confidence-fill"></div>
      </div>
      <div class="bpm-tap-confidence-label" id="tap-confidence-label">0 taps</div>

      <div class="bpm-tap-variants" id="tap-variants"></div>

      <div class="bpm-tap-actions">
        <button class="bpm-tap-reset" id="tap-reset">Reset</button>
        <button class="bpm-tap-apply" id="tap-apply" disabled>Apply</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  tapPopupEl = el;

  el.addEventListener("click", (e) => {
    if (e.target === el) closeTapBpmPopup();
  });
  el.querySelector("#tap-close").addEventListener("click", closeTapBpmPopup);
  el.querySelector("#tap-zone").addEventListener("click", (e) => {
    e.stopPropagation();
    doPopupTap();
  });
  el.querySelector("#tap-reset").addEventListener("click", resetPopupTaps);
  el.querySelector("#tap-apply").addEventListener("click", applyPopupBpm);
}

function openTapBpmPopup(trackId) {
  buildTapPopup();
  tapPopupTrackId = trackId;
  resetPopupTaps();

  const track = state.tracks.find((t) => t.id === trackId);
  tapPopupEl.querySelector("#tap-track-name").textContent = track?.name ?? "";
  tapPopupEl.querySelector("#tap-value").textContent = track?.bpm ?? "—";
  tapPopupEl.querySelector("#tap-apply").disabled = true;
  renderPopupVariants(track?.bpm ?? null);
  tapPopupEl.classList.remove("hidden");
}

function closeTapBpmPopup() {
  tapPopupEl?.classList.add("hidden");
  tapPopupTrackId = null;
  clearTimeout(popupTapTimer);
  popupTapTimes = [];
}

function resetPopupTaps() {
  clearTimeout(popupTapTimer);
  popupTapTimes = [];
  if (!tapPopupEl) return;
  const track = state.tracks.find((t) => t.id === tapPopupTrackId);
  tapPopupEl.querySelector("#tap-value").textContent = track?.bpm ?? "—";
  tapPopupEl.querySelector("#tap-hint").textContent = "Click the pad (or press Space) in beat";
  tapPopupEl.querySelector("#tap-confidence-fill").style.width = "0%";
  tapPopupEl.querySelector("#tap-confidence-label").textContent = "0 taps";
  tapPopupEl.querySelector("#tap-apply").disabled = true;
  renderPopupVariants(track?.bpm ?? null);
}

function doPopupTap() {
  const now = Date.now();
  clearTimeout(popupTapTimer);
  popupTapTimer = setTimeout(resetPopupTaps, 2500);
  popupTapTimes.push(now);

  const n = popupTapTimes.length;
  const el = tapPopupEl;

  if (n < 2) {
    el.querySelector("#tap-hint").textContent = "Keep tapping…";
    el.querySelector("#tap-confidence-label").textContent = `${n} tap`;
    return;
  }

  // Average all non-zero intervals for stability
  const intervals = [];
  for (let i = 1; i < n; i++) {
    const d = popupTapTimes[i] - popupTapTimes[i - 1];
    if (d > 0) intervals.push(d);
  }
  if (intervals.length === 0) return; // all taps at same ms (e.g. automated test)
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const rawBpm = 60000 / avgMs;

  // Snap to nearest musical half/double if close (±10%)
  const bpm = snapBpm(rawBpm);

  el.querySelector("#tap-value").textContent = bpm;
  el.querySelector("#tap-apply").disabled = false;
  el.querySelector("#tap-apply").dataset.bpm = bpm;

  // Confidence: max at 8 taps
  const pct = Math.min(100, Math.round((n / 8) * 100));
  el.querySelector("#tap-confidence-fill").style.width = `${pct}%`;
  el.querySelector("#tap-confidence-label").textContent =
    `${n} tap${n > 1 ? "s" : ""} · ${pct < 50 ? "low" : pct < 80 ? "good" : "solid"} confidence`;
  el.querySelector("#tap-hint").textContent =
    n < 4 ? "Keep tapping for better accuracy…" : "Looking good — tap more or apply";

  renderPopupVariants(bpm);
}

/** Snap raw BPM to musical half/double if within 5%. */
function snapBpm(raw) {
  const candidates = [raw, raw * 2, raw / 2, raw * 4, raw / 4].filter((b) => b >= 40 && b <= 300);
  // Prefer the range 90–180 when possible
  const inRange = candidates.filter((b) => b >= 90 && b <= 180);
  const best = (inRange.length ? inRange : candidates)[0];
  return Math.round(best);
}

function renderPopupVariants(bpm) {
  const el = tapPopupEl?.querySelector("#tap-variants");
  if (!el) return;
  if (!bpm) {
    el.innerHTML = "";
    return;
  }

  const variants = [
    { label: "½", value: Math.round(bpm / 2) },
    { label: "1×", value: Math.round(bpm), current: true },
    { label: "2×", value: Math.round(bpm * 2) },
  ].filter((v) => v.value >= 40 && v.value <= 300);

  el.innerHTML = variants
    .map(
      (v) =>
        `<button class="bpm-variant-btn${v.current ? " current" : ""}"
       data-bpm="${v.value}">${v.label} <strong>${v.value}</strong></button>`,
    )
    .join("");

  el.querySelectorAll(".bpm-variant-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = parseInt(btn.dataset.bpm, 10);
      tapPopupEl.querySelector("#tap-value").textContent = val;
      tapPopupEl.querySelector("#tap-apply").disabled = false;
      tapPopupEl.querySelector("#tap-apply").dataset.bpm = val;
      renderPopupVariants(val);
    });
  });
}

function applyPopupBpm() {
  const bpm = parseInt(tapPopupEl.querySelector("#tap-apply").dataset.bpm, 10);
  if (!bpm || !tapPopupTrackId) return;

  // Also update the BPM input in the track strip
  const strip = trackControlsBody.querySelector(`[data-id="${tapPopupTrackId}"] .track-bpm-input`);
  if (strip) strip.value = bpm;

  setTrackBpm(tapPopupTrackId, bpm);
  setStatus(`BPM set to ${bpm} for "${state.tracks.find((t) => t.id === tapPopupTrackId)?.name}"`);
  closeTapBpmPopup();
}

// Space key taps into the open popup if no other input is focused
function handlePopupKeyTap(e) {
  if (!tapPopupEl || tapPopupEl.classList.contains("hidden")) return;
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") {
    e.preventDefault();
    doPopupTap();
  }
  if (e.code === "Escape") closeTapBpmPopup();
  if (e.code === "Enter") {
    const btn = tapPopupEl.querySelector("#tap-apply");
    if (!btn.disabled) applyPopupBpm();
  }
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  ensureDropOverlay();
  setStatus("Initializing…");
  syncUndoButtons();

  const opfsOk = await OPFS.isAvailable();
  opfsIndicator.classList.toggle("available", opfsOk);
  opfsIndicator.title = opfsOk
    ? "OPFS available — audio files persist across sessions"
    : "OPFS unavailable — files will not persist";

  if (opfsOk) await loadProject();

  Metronome.setGetBPM(() => state.masterBPM);
  Metronome.setVolume(0.6);

  Timeline.init(scrollWrapper, state, {
    onSeek: handleSeek,
    onTrackMove: handleTrackMove,
    onTrackMoveEnd: clearMoveFlag,
    onAutomationEdit: handleAutomationEdit,
    onBpmAutomationEdit: handleBpmAutomationEdit,
  });
  Timeline.syncScroll(scrollWrapper);

  setInterval(updatePlayheadDisplay, 50);

  // ── Event wiring ─────────────────────────────────────────────
  btnImport.addEventListener("click", () => {
    Audio.ensureResumed();
    fileInput.click();
  });
  fileInput.addEventListener("change", handleFileImport);
  btnSave.addEventListener("click", saveProject);
  btnPlay.addEventListener("click", togglePlay);
  btnStop.addEventListener("click", handleStop);
  btnUndo.addEventListener("click", undo);
  btnRedo.addEventListener("click", redo);
  btnTapBpm.addEventListener("click", handleTapBpm);
  btnSnap.addEventListener("click", cycleSnap);
  btnMetro?.addEventListener("click", toggleMetronome);
  metroVolume?.addEventListener("input", () => Metronome.setVolume(parseFloat(metroVolume.value)));
  btnZoomIn.addEventListener("click", () => zoom(1.4));
  btnZoomOut.addEventListener("click", () => zoom(1 / 1.4));
  btnZoomFit.addEventListener("click", zoomFit);
  masterBpm.addEventListener("change", () => {
    const bpm = parseFloat(masterBpm.value) || 120;
    state.masterBPM = bpm;
    // Update initial BPM automation point (t=0) to stay in sync
    if (state.bpmAutomation.length === 1) {
      state.bpmAutomation[0].value = bpm;
    } else if (state.bpmAutomation.length === 0) {
      state.bpmAutomation = [{ time: 0, value: bpm }];
    }
    if (Audio.isPlaying()) Audio.setMasterBPM(bpm);
    scheduleSave();
  });
  masterBpm.addEventListener("input", () => {
    state.masterBPM = parseFloat(masterBpm.value) || 120;
    if (Audio.isPlaying()) Audio.setMasterBPM(state.masterBPM);
  });

  document.addEventListener("keydown", onKeyDown);

  // Drag-and-drop
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropOverlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) dropOverlay.classList.add("hidden");
  });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.classList.add("hidden");
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("audio/") || /\.(mp3|wav|flac|ogg|aac|m4a|opus)$/i.test(f.name),
    );
    if (!files.length) return setStatus("No audio files found in drop.");
    await Audio.ensureResumed();
    await processFiles(files);
  });

  setStatus(
    state.tracks.length
      ? `Loaded ${state.tracks.length} track(s). Press Space to play.`
      : "Ready — drag audio files here or click ＋ Import.",
  );
}

// ── Playback ─────────────────────────────────────────────────

function togglePlay() {
  if (Audio.isPlaying()) {
    Audio.pause();
    btnPlay.textContent = "▶";
    btnPlay.classList.remove("playing");
    state.playhead = Audio.currentSetTime();
    if (Metronome.isActive()) Metronome.stop();
  } else {
    Audio.ensureResumed().then(() => {
      Audio.play(state.playhead, state.tracks, state.masterBPM, state.bpmAutomation);
      btnPlay.textContent = "⏸";
      btnPlay.classList.add("playing");
      if (btnMetro?.classList.contains("metro-on")) {
        const audioCtx = Audio.getAudioContext();
        Metronome.setGetBPM(() => state.masterBPM);
        Metronome.start(audioCtx, state.playhead);
      }
    });
  }
}

function handleStop() {
  Audio.stop(true);
  Metronome.stop();
  state.playhead = 0;
  btnPlay.textContent = "▶";
  btnPlay.classList.remove("playing");
}

function handleSeek(setTimeSec) {
  state.playhead = Math.max(0, setTimeSec);
  if (Audio.isPlaying()) {
    Audio.stop(false);
    Audio.play(state.playhead, state.tracks, state.masterBPM, state.bpmAutomation);
    if (Metronome.isActive()) {
      Metronome.stop();
      Metronome.start(Audio.getAudioContext(), state.playhead);
    }
  }
}

function updatePlayheadDisplay() {
  if (Audio.isPlaying()) {
    state.playhead = Audio.currentSetTime();
    // Follow BPM automation curve during playback
    const pts = state.bpmAutomation;
    if (pts && pts.length > 1) {
      const bpm = Audio.interpolateAutomation(pts, state.playhead);
      if (bpm && Math.abs(bpm - state.masterBPM) > 0.5) {
        state.masterBPM = bpm;
        masterBpm.value = bpm.toFixed(1);
        // No need to call Audio.setMasterBPM — rates were pre-scheduled at play()
      }
    }
  }
  playheadDisplay.textContent = formatTimeMs(state.playhead);
}

// ── Track management ─────────────────────────────────────────

function handleTrackMove(trackId, newStartTime) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  // Push undo only on first move (mousedown), not every pixel
  if (track._moveStarted !== true) {
    pushUndo();
    track._moveStarted = true;
  }
  track.startTime = Math.max(0, snapTrackTime(newStartTime, track));
  // Re-schedule audio immediately so the live playback position updates
  if (Audio.isPlaying()) Audio.rescheduleTrack(track);
  scheduleSave();
}

/** Called by timeline on mouseup to clear the move-started flag. */
export function clearMoveFlag(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (track) track._moveStarted = false;
}

function handleAutomationEdit(trackId, points) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  pushUndo();
  track.automation = points;
  if (Audio.isPlaying()) {
    Audio.rescheduleAutomation(trackId, points, track.startTime * (60 / (state.masterBPM || 120)));
  }
  scheduleSave();
}

function handleBpmAutomationEdit(points) {
  pushUndo();
  state.bpmAutomation = points;
  if (Audio.isPlaying()) Audio.rescheduleBpmAutomation(points);
  // Also sync masterBPM display to current playhead value
  if (points.length > 0) {
    const bpm = Audio.interpolateAutomation(points, state.playhead);
    if (bpm) {
      state.masterBPM = bpm;
      masterBpm.value = bpm.toFixed(1);
    }
  }
  scheduleSave();
}

function setTrackVolume(trackId, value) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  track.volume = value;
  if (Audio.isPlaying()) Audio.setTrackVolume(trackId, value);
  scheduleSave();
}

function setTrackBpm(trackId, bpm) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  pushUndo();
  track.bpm = bpm;
  scheduleSave();
}

function setTrackBeatGrid(trackId, bpm, beatOffset) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  pushUndo();
  track.bpm = bpm;
  track.beatOffset = beatOffset;
  // Sync BPM input in the strip
  const strip = trackControlsBody.querySelector(`[data-id="${trackId}"] .track-bpm-input`);
  if (strip) strip.value = Math.round(bpm);
  scheduleSave();
}

function toggleMute(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  pushUndo();
  track.muted = !track.muted;
  if (Audio.isPlaying()) {
    Audio.stop(false);
    Audio.play(state.playhead, state.tracks);
  }
  renderTrackControls();
  scheduleSave();
}

function deleteTrack(trackId) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return;
  pushUndo();
  // Cache audio assets so undo can restore them
  const t = state.tracks[idx];
  audioCache.set(t.id, { audioBuffer: t.audioBuffer, waveform: t.waveform });
  if (Audio.isPlaying()) Audio.stop(false);
  state.tracks.splice(idx, 1);
  Timeline.invalidateTrack(trackId);
  // NOTE: don't delete from OPFS so undo can reload it
  renderTrackControls();
  scheduleSave();
  setStatus(`Track deleted. ${state.tracks.length} track(s) remaining. (Ctrl+Z to undo)`);
}

// ── File import ───────────────────────────────────────────────

async function handleFileImport(e) {
  const files = Array.from(e.target.files);
  fileInput.value = "";
  if (!files.length) return;
  await processFiles(files);
}

async function processFiles(files) {
  showLoading(true);
  const opfsOk = await OPFS.isAvailable();
  let imported = 0;

  for (const file of files) {
    setStatus(`Loading ${file.name}…`);
    try {
      pushUndo(); // undo point before each new track
      await importFile(file, opfsOk);
      imported++;
    } catch (err) {
      undoStack.pop(); // discard failed undo point
      console.error("Import failed:", err);
      setStatus(`Error importing ${file.name}: ${err.message}`);
    }
  }

  showLoading(false);
  renderTrackControls();
  syncUndoButtons();
  scheduleSave();
  setStatus(`Imported ${imported} file(s). ${state.tracks.length} track(s) total.`);
}

async function importFile(file, saveToOPFS) {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await Audio.decodeAudio(arrayBuffer);

  setStatus(`Estimating BPM for ${file.name}…`);
  const bpm = await detectBPM(audioBuffer);
  const waveform = Audio.buildWaveform(audioBuffer, 1000);

  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const masterBPM = state.masterBPM || 120;
  const lastEnd = state.tracks.reduce((m, t) => {
    const trackBpm = t.bpm || masterBPM;
    return Math.max(m, t.startTime + (t.duration * trackBpm) / 60);
  }, 0);
  const startTime = state.tracks.length === 0 ? 0 : lastEnd + 4; // 4 beats = 1 bar gap

  const track = {
    id,
    name: file.name.replace(/\.[^/.]+$/, ""),
    filename: `${id}.bin`,
    startTime,
    duration: audioBuffer.duration,
    bpm,
    beatOffset: 0,
    volume: 1,
    muted: false,
    color: nextColor(),
    audioBuffer,
    waveform,
    automation: [
      { time: 0, value: 1 },
      { time: audioBuffer.duration, value: 1 },
    ],
  };

  state.tracks.push(track);
  audioCache.set(id, { audioBuffer, waveform });

  if (saveToOPFS) await OPFS.saveAudio(id, arrayBuffer);
}

// ── Left panel (track control strips) ───────────────────────

function renderTrackControls() {
  trackControlsBody.innerHTML = "";

  state.tracks.forEach((track) => {
    const strip = document.createElement("div");
    strip.className = "track-strip";
    strip.dataset.id = track.id;

    strip.innerHTML = `
      <div class="track-strip-main">
        <div class="track-strip-name" title="${track.name}">${track.name}</div>
        <div class="track-bpm-row">
          <span>BPM</span>
          <input class="track-bpm-input" type="number" min="40" max="300" step="1"
            value="${track.bpm ?? 120}" title="Track BPM (editable)">
          <button class="btn-tap-track" title="Tap tempo for this track">TAP</button>
          <button class="btn-beat-grid" title="Open beat grid editor">GRID</button>
          <span class="track-dur">· ${formatTimeSec(track.duration)}</span>
        </div>
        <div class="track-strip-controls">
          <input class="track-volume-slider" type="range" min="0" max="1" step="0.01"
            value="${track.volume}" title="Volume">
          <button class="btn-mute${track.muted ? " muted" : ""}" title="Mute">M</button>
          <button class="btn-delete" title="Delete track">✕</button>
        </div>
      </div>
      <div class="track-strip-automation">
        <span>VOL AUTO</span>
      </div>
    `;

    // BPM text input
    const bpmInput = strip.querySelector(".track-bpm-input");
    bpmInput.addEventListener("change", (ev) => {
      const val = Math.round(Math.min(300, Math.max(40, parseFloat(ev.target.value) || 120)));
      ev.target.value = val;
      setTrackBpm(track.id, val);
    });

    // Tap BPM button → open popup for this track
    strip.querySelector(".btn-tap-track").addEventListener("click", () => {
      openTapBpmPopup(track.id);
    });

    // Beat grid editor
    strip.querySelector(".btn-beat-grid").addEventListener("click", () => {
      Audio.ensureResumed().then(() => {
        BeatGrid.open(track, Audio.getAudioContext(), (bpm, beatOffset) => {
          setTrackBeatGrid(track.id, bpm, beatOffset);
        });
      });
    });

    // Volume slider — push undo on mousedown, not every input tick
    const volSlider = strip.querySelector(".track-volume-slider");
    volSlider.addEventListener("mousedown", () => pushUndo());
    volSlider.addEventListener("input", (ev) => setTrackVolume(track.id, parseFloat(ev.target.value)));

    strip.querySelector(".btn-mute").addEventListener("click", () => toggleMute(track.id));
    strip.querySelector(".btn-delete").addEventListener("click", () => {
      if (confirm(`Delete "${track.name}"?`)) deleteTrack(track.id);
    });

    trackControlsBody.appendChild(strip);
  });

  // BPM automation strip — always at the bottom, matches BPM_H in timeline.js
  const bpmStrip = document.createElement("div");
  bpmStrip.className = "bpm-auto-strip";
  bpmStrip.innerHTML = `<span class="bpm-auto-label">BPM AUTO</span>`;
  trackControlsBody.appendChild(bpmStrip);
}

// ── Metronome ─────────────────────────────────────────────────

function toggleMetronome() {
  if (!btnMetro) return;
  const on = !btnMetro.classList.contains("metro-on");
  btnMetro.classList.toggle("metro-on", on);
  btnMetro.textContent = on ? "METRO: ON" : "METRO: OFF";

  if (on && Audio.isPlaying()) {
    Audio.ensureResumed().then(() => {
      Metronome.setGetBPM(() => state.masterBPM);
      Metronome.start(Audio.getAudioContext(), state.playhead);
    });
  } else {
    Metronome.stop();
  }
}

// ── Snap ──────────────────────────────────────────────────────

const SNAP_MODES = ["off", "beat", "bar"];
const SNAP_LABELS = { off: "SNAP: OFF", beat: "SNAP: BEAT", bar: "SNAP: BAR" };

function cycleSnap() {
  const idx = SNAP_MODES.indexOf(state.snapMode);
  state.snapMode = SNAP_MODES[(idx + 1) % SNAP_MODES.length];
  btnSnap.textContent = SNAP_LABELS[state.snapMode];
  btnSnap.className = `snap-btn ${state.snapMode}`;
  setStatus(state.snapMode === "off" ? "Snap off" : `Snap to ${state.snapMode} — ${state.masterBPM} BPM`);
}

/** Snap a set-time value to the nearest beat or bar boundary. */
function snapTime(t) {
  if (state.snapMode === "off") return t;
  const grid = state.snapMode === "bar" ? 4 : 1;
  return Math.round(t / grid) * grid;
}

/**
 * Snap a track's startTime so that its beat 1 lands on the nearest
 * beat/bar boundary rather than the file start.
 * @param {number} t  proposed startTime in master beats
 * @param {Object} track
 */
function snapTrackTime(t, track) {
  if (state.snapMode === "off") return t;
  const masterBPM = state.masterBPM || 120;
  const trackBPM = track.bpm || masterBPM;
  // beatOffset is in audio-file seconds; convert to master-BPM beats
  const beatOffsetBeats = ((track.beatOffset || 0) * trackBPM) / 60;
  // where beat 1 lands in master beats
  const beat1 = t + beatOffsetBeats;
  const grid = state.snapMode === "bar" ? 4 : 1;
  const snappedBeat1 = Math.round(beat1 / grid) * grid;
  return snappedBeat1 - beatOffsetBeats;
}

// ── Zoom ──────────────────────────────────────────────────────

const MIN_PX_PER_SEC = 1;
const MAX_PX_PER_SEC = 200;

function zoom(factor) {
  const oldPps = state.pxPerSec;
  const newPps = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, oldPps * factor));
  if (newPps === oldPps) return;
  const visW = scrollWrapper.clientWidth;
  const centerSec = (scrollWrapper.scrollLeft + visW / 2) / oldPps;
  state.pxPerSec = newPps;
  zoomDisplay.textContent = `${(newPps / 30).toFixed(2)}×`;
  requestAnimationFrame(() => {
    scrollWrapper.scrollLeft = Math.max(0, centerSec * newPps - visW / 2);
  });
}

function zoomFit() {
  if (!state.tracks.length) return;
  const masterBPM = state.masterBPM || 120;
  const totalSec = state.tracks.reduce((m, t) => {
    const trackBpm = t.bpm || masterBPM;
    const startSec = t.startTime * (60 / masterBPM);
    const durSec = (t.duration * trackBpm) / masterBPM;
    return Math.max(m, startSec + durSec);
  }, 0);
  if (totalSec <= 0) return;
  const availW = scrollWrapper.clientWidth - 20;
  state.pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, availW / totalSec));
  zoomDisplay.textContent = `${(state.pxPerSec / 30).toFixed(2)}×`;
  scrollWrapper.scrollLeft = 0;
}

// ── Project save / load ───────────────────────────────────────

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 1000);
}

async function saveProject() {
  if (!(await OPFS.isAvailable())) return;
  await OPFS.saveProject({
    version: 2,
    masterBPM: parseFloat(masterBpm.value) || 120,
    pxPerSec: state.pxPerSec,
    bpmAutomation: state.bpmAutomation,
    tracks: state.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      filename: t.filename,
      startTime: t.startTime,
      duration: t.duration,
      bpm: t.bpm,
      beatOffset: t.beatOffset ?? 0,
      volume: t.volume,
      muted: t.muted,
      color: t.color,
      automation: t.automation,
    })),
  });
}

async function loadProject() {
  const data = await OPFS.loadProject();
  if (!data) return;

  masterBpm.value = data.masterBPM ?? 120;
  state.masterBPM = parseFloat(masterBpm.value);
  if (data.bpmAutomation?.length) {
    state.bpmAutomation = data.bpmAutomation;
  } else {
    state.bpmAutomation = [{ time: 0, value: state.masterBPM }];
  }
  if (data.pxPerSec) {
    state.pxPerSec = data.pxPerSec;
    zoomDisplay.textContent = `${(state.pxPerSec / 30).toFixed(2)}×`;
  }

  for (const td of data.tracks ?? []) {
    setStatus(`Restoring "${td.name}"…`);
    try {
      const bytes = await OPFS.loadAudio(td.id);
      if (!bytes) {
        console.warn(`Audio not found in OPFS for ${td.id}`);
        continue;
      }
      const audioBuffer = await Audio.decodeAudio(bytes);
      const waveform = Audio.buildWaveform(audioBuffer, 1000);
      const track = { ...td, beatOffset: td.beatOffset ?? 0, audioBuffer, waveform };
      // v1 stored startTime in seconds; v2 stores beats
      if ((data.version ?? 1) < 2) {
        track.startTime = (track.startTime * state.masterBPM) / 60;
      }
      state.tracks.push(track);
      audioCache.set(td.id, { audioBuffer, waveform });
    } catch (err) {
      console.error(`Failed to restore track ${td.name}:`, err);
    }
  }
  renderTrackControls();
}

// ── Keyboard shortcuts ────────────────────────────────────────

function onKeyDown(e) {
  // If tap popup is open, route Space/Enter/Escape to it first
  if (tapPopupEl && !tapPopupEl.classList.contains("hidden")) {
    handlePopupKeyTap(e);
    return;
  }

  const inInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";

  if (e.code === "Space" && !inInput) {
    e.preventDefault();
    togglePlay();
  }
  if (e.code === "Home" && !inInput) handleSeek(0);
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
    e.preventDefault();
    redo();
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
    e.preventDefault();
    saveProject();
  }
  if (!inInput && (e.code === "Equal" || e.code === "NumpadAdd")) zoom(1.3);
  if (!inInput && (e.code === "Minus" || e.code === "NumpadSubtract")) zoom(1 / 1.3);
}

// ── Helpers ───────────────────────────────────────────────────

function formatTimeMs(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function formatTimeSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function showLoading(show) {
  let ov = document.getElementById("loading-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "loading-overlay";
    ov.innerHTML = '<div class="spinner"></div><span>Processing…</span>';
    document.body.appendChild(ov);
  }
  ov.className = show ? "" : "hidden";
}

// ── Boot ──────────────────────────────────────────────────────
init().catch((err) => {
  console.error("App init failed:", err);
  setStatus(`Startup error: ${err.message}`);
});

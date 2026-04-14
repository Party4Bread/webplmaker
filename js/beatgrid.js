/**
 * Beat Grid Editor Modal
 *
 * Lets the user set the first-beat offset (beatOffset) for a track
 * so the beat grid in the timeline aligns with the audio content.
 *
 * State exposed to the rest of the app: { bpm, beatOffset }
 * beatOffset = seconds from the start of the audio file to beat 1
 */

const WAVEFORM_POINTS = 12_000; // high-res waveform for the modal canvas
const CANVAS_H = 160;
const PPS_DEFAULT = 150; // px per second (initial zoom)
const PPS_MIN = 10;
const PPS_MAX = 1200;

// ── Module state ─────────────────────────────────────────────
let _el = null;
let _canvas = null;
let _c = null;
let _track = null;
let _audioCtx = null;
let _onApply = null;

let _bpm = 120;
let _offset = 0; // beat-1 position in audio-file seconds
let _pxPerSec = PPS_DEFAULT;
let _scrollX = 0; // leftmost visible audio-file second
let _waveform = null; // Float32Array (WAVEFORM_POINTS peaks)
let _drag = false;
let _rafId = null;

let _prevSrc = null;
let _prevGain = null;
let _prevStartCtx = 0;
let _prevStartTrack = 0;
let _prevPlaying = false;

// Metronome state
let _metroOn = true;
let _metroTimer = null;
let _metroNextBeat = 0;
let _metroBeatCount = 0;
const _METRO_LOOKAHEAD = 0.1;
const _METRO_TICK_MS = 25;

// ── Public API ────────────────────────────────────────────────

/**
 * Open the modal for a track.
 * @param {Object}   track      track object with .audioBuffer, .bpm, .beatOffset
 * @param {AudioContext} audioCtx
 * @param {Function} onApply   callback(bpm, beatOffset) when user clicks Apply
 */
export function open(track, audioCtx, onApply) {
  _track = track;
  _audioCtx = audioCtx;
  _onApply = onApply;
  _bpm = track.bpm || 120;
  _offset = track.beatOffset ?? 0;
  _pxPerSec = PPS_DEFAULT;
  _scrollX = Math.max(0, _offset - 2);

  if (track.audioBuffer) {
    _waveform = _buildWaveform(track.audioBuffer, WAVEFORM_POINTS);
  } else {
    _waveform = track.waveform ?? new Float32Array(0);
  }

  _build();
  _el.querySelector(".bgm-trackname").textContent = track.name;
  _syncInputs();
  _el.classList.remove("hidden");
  _startLoop();
}

export function close() {
  _stopPreview();
  _stopLoop();
  if (_el) _el.classList.add("hidden");
}

// ── DOM Construction ──────────────────────────────────────────

function _build() {
  if (_el) return; // already built — reused across openings

  _el = document.createElement("div");
  _el.id = "beat-grid-modal";
  _el.className = "hidden";
  _el.innerHTML = `
    <div class="bgm-panel">
      <div class="bgm-header">
        <span class="bgm-title">BEAT GRID</span>
        <span class="bgm-trackname"></span>
        <button class="bgm-close" title="Close">✕</button>
      </div>

      <div class="bgm-controls">
        <label class="bgm-ctrl-group">
          <span>BPM</span>
          <input class="bgm-bpm" type="number" min="40" max="300" step="0.5">
        </label>
        <label class="bgm-ctrl-group">
          <span>Beat 1 offset</span>
          <input class="bgm-offset-in" type="number" min="-60" max="99999" step="0.001">
          <span>s</span>
        </label>
        <div class="bgm-nudge-group">
          <button class="bgm-nudge" data-beats="-4" title="Back 1 bar">◀◀</button>
          <button class="bgm-nudge" data-beats="-1" title="Back 1 beat">◀</button>
          <button class="bgm-nudge" data-beats="1" title="Forward 1 beat">▶</button>
          <button class="bgm-nudge" data-beats="4" title="Forward 1 bar">▶▶</button>
        </div>
      </div>

      <div class="bgm-canvas-wrapper">
        <canvas class="bgm-canvas"></canvas>
      </div>

      <div class="bgm-zoom-row">
        <button class="bgm-zoom-out" title="Zoom out (scroll ctrl+wheel)">−</button>
        <span class="bgm-zoom-label">zoom</span>
        <button class="bgm-zoom-in" title="Zoom in">＋</button>
        <span class="bgm-hint-text">Click waveform to place beat 1 · Ctrl+scroll = zoom · Scroll = pan · Arrow keys to nudge</span>
      </div>

      <div class="bgm-actions">
        <button class="bgm-preview-btn">▶ Preview</button>
        <button class="bgm-metro-btn metro-on">METRO: ON</button>
        <span style="flex:1"></span>
        <button class="bgm-cancel">Cancel</button>
        <button class="bgm-apply">Apply</button>
      </div>
    </div>
  `;
  document.body.appendChild(_el);

  _canvas = _el.querySelector(".bgm-canvas");
  _c = _canvas.getContext("2d");

  // Backdrop dismiss
  _el.addEventListener("click", (e) => {
    if (e.target === _el) close();
  });
  _el.querySelector(".bgm-close").addEventListener("click", close);
  _el.querySelector(".bgm-cancel").addEventListener("click", close);

  // Apply
  _el.querySelector(".bgm-apply").addEventListener("click", () => {
    _onApply?.(_bpm, _offset);
    close();
  });

  // BPM input
  const bpmInput = _el.querySelector(".bgm-bpm");
  bpmInput.addEventListener("input", () => {
    const v = parseFloat(bpmInput.value);
    if (v >= 40 && v <= 300) _bpm = v;
  });
  bpmInput.addEventListener("change", () => {
    const v = parseFloat(bpmInput.value) || 120;
    _bpm = Math.min(300, Math.max(40, v));
    _syncInputs();
  });

  // Offset input
  const offsetInput = _el.querySelector(".bgm-offset-in");
  offsetInput.addEventListener("input", () => {
    const v = parseFloat(offsetInput.value);
    if (!isNaN(v)) _offset = v;
  });

  // Nudge buttons
  _el.querySelectorAll(".bgm-nudge").forEach((btn) => {
    btn.addEventListener("click", () => {
      const beats = parseFloat(btn.dataset.beats);
      _offset = parseFloat((_offset + beats * (60 / _bpm)).toFixed(6));
      _syncInputs();
    });
  });

  // Zoom buttons
  _el.querySelector(".bgm-zoom-out").addEventListener("click", () => _zoom(0.7));
  _el.querySelector(".bgm-zoom-in").addEventListener("click", () => _zoom(1.4));

  // Preview
  _el.querySelector(".bgm-preview-btn").addEventListener("click", _togglePreview);

  // Metro toggle
  _el.querySelector(".bgm-metro-btn").addEventListener("click", () => {
    _metroOn = !_metroOn;
    _el.querySelector(".bgm-metro-btn").textContent = _metroOn ? "METRO: ON" : "METRO: OFF";
    _el.querySelector(".bgm-metro-btn").classList.toggle("metro-on", _metroOn);
    if (!_metroOn) _stopMetro();
    else if (_prevPlaying) _startMetro();
  });

  // Canvas mouse
  _canvas.addEventListener("mousedown", _onMouseDown);
  _canvas.addEventListener("mousemove", _onMouseMove);
  _canvas.addEventListener("mouseup", () => (_drag = false));
  _canvas.addEventListener("mouseleave", () => (_drag = false));
  _canvas.addEventListener("wheel", _onWheel, { passive: false });

  // Keyboard — attached once, guarded inside handler
  document.addEventListener("keydown", _onKeyDown);
}

// ── Render loop ───────────────────────────────────────────────

function _startLoop() {
  if (_rafId) return;
  const tick = () => {
    _resize();
    _draw();
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

function _stopLoop() {
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

function _resize() {
  const w = _canvas.parentElement.clientWidth;
  if (_canvas.width !== w || _canvas.height !== CANVAS_H) {
    _canvas.width = w;
    _canvas.height = CANVAS_H;
  }
}

function _draw() {
  const c = _c;
  const W = _canvas.width;
  const H = _canvas.height;
  if (!W || !H) return;

  // Background
  c.fillStyle = "#111";
  c.fillRect(0, 0, W, H);

  _drawWaveform(W, H);
  _drawBeatGrid(W, H);
  _drawPlayhead(W, H);
  _drawTimeRuler(W, H);
}

function _drawWaveform(W, H) {
  if (!_waveform || !_waveform.length) return;
  const dur = _track.audioBuffer?.duration ?? _track.duration ?? 1;
  const mid = H / 2;

  for (let px = 0; px < W; px++) {
    const sec = _scrollX + px / _pxPerSec;
    if (sec < 0 || sec > dur) continue;
    const idx = Math.floor((sec / dur) * _waveform.length);
    const amp = (_waveform[Math.min(idx, _waveform.length - 1)] ?? 0) * (H * 0.44);
    _c.fillStyle = "#3d3d3d";
    _c.fillRect(px, mid - amp, 1, amp * 2 || 1);
  }
}

function _drawBeatGrid(W, H) {
  if (!_bpm || !_bpm) return;
  const c = _c;
  const beatSec = 60 / _bpm;
  const visibleSec = W / _pxPerSec;

  // Range of beat indices visible
  const nStart = Math.floor((_scrollX - _offset) / beatSec) - 1;
  const nEnd = Math.ceil((_scrollX + visibleSec - _offset) / beatSec) + 1;

  for (let n = nStart; n <= nEnd; n++) {
    const t = _offset + n * beatSec;
    if (t < -beatSec) continue; // too far before track start
    const x = (t - _scrollX) * _pxPerSec;
    if (x < -2 || x > W + 2) continue;

    const isBarLine = n % 4 === 0;
    const isBeat1 = n === 0;

    if (isBeat1) {
      // Bold amber line + label
      c.strokeStyle = "#e8a020";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();

      // Handle at top
      c.fillStyle = "#e8a020";
      c.beginPath();
      c.moveTo(x - 6, 0);
      c.lineTo(x + 6, 0);
      c.lineTo(x, 12);
      c.closePath();
      c.fill();

      // "1" label below handle
      c.fillStyle = "#e8a020";
      c.font = "bold 11px monospace";
      c.textBaseline = "top";
      c.fillText("BEAT 1", x + 4, 14);
    } else if (isBarLine) {
      const barNum = Math.floor(n / 4);
      c.strokeStyle = "rgba(232,160,32,0.45)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();

      if (barNum > 0 && x + 6 < W) {
        c.fillStyle = "rgba(232,160,32,0.55)";
        c.font = "9px monospace";
        c.textBaseline = "top";
        c.fillText(`${barNum + 1}`, x + 2, 3);
      }
    } else {
      // Beat line
      c.strokeStyle = "rgba(74,158,255,0.3)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, H * 0.2);
      c.lineTo(x, H * 0.8);
      c.stroke();
    }
  }
}

function _drawPlayhead(W, H) {
  if (!_prevPlaying) return;
  const trackTime = _prevStartTrack + (_audioCtx.currentTime - _prevStartCtx);
  const x = (trackTime - _scrollX) * _pxPerSec;
  if (x < 0 || x > W) return;
  const c = _c;
  c.strokeStyle = "#e8a020";
  c.lineWidth = 1.5;
  c.setLineDash([3, 3]);
  c.beginPath();
  c.moveTo(x, 0);
  c.lineTo(x, H);
  c.stroke();
  c.setLineDash([]);
}

function _drawTimeRuler(W, H) {
  const c = _c;
  // Thin top ruler band
  c.fillStyle = "#1e1e1e";
  c.fillRect(0, 0, W, 14);

  // Time ticks
  const visibleSec = W / _pxPerSec;
  const step = _niceStep(visibleSec / 8); // ~8 ticks visible

  c.fillStyle = "#555";
  c.font = "8px monospace";
  c.textBaseline = "top";

  for (let t = Math.ceil(_scrollX / step) * step; t < _scrollX + visibleSec + step; t += step) {
    const x = (t - _scrollX) * _pxPerSec;
    if (x < 0 || x > W) continue;
    c.fillStyle = "#444";
    c.fillRect(Math.round(x), 10, 1, 4);
    c.fillStyle = "#555";
    c.fillText(_fmtSec(t), Math.round(x) + 2, 2);
  }
}

// ── Interaction ───────────────────────────────────────────────

function _onMouseDown(e) {
  if (e.button !== 0) return;
  _drag = true;
  _setOffsetFromX(e.offsetX);
}

function _onMouseMove(e) {
  if (!_drag) return;
  _setOffsetFromX(e.offsetX);
}

function _setOffsetFromX(px) {
  _offset = parseFloat((_scrollX + px / _pxPerSec).toFixed(6));
  _syncInputs();
}

function _onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    _zoom(e.deltaY < 0 ? 1.3 : 0.77);
  } else {
    // Pan — deltaMode 0: pixels, 1: lines, 2: pages
    const pixDelta = e.deltaMode === 0 ? e.deltaY : e.deltaY * 20;
    const dur = _track.audioBuffer?.duration ?? _track.duration ?? 1;
    _scrollX = Math.max(0, Math.min(dur - 0.5, _scrollX + pixDelta / _pxPerSec));
  }
}

function _zoom(factor) {
  const center = _scrollX + _canvas.width / _pxPerSec / 2;
  _pxPerSec = Math.min(PPS_MAX, Math.max(PPS_MIN, _pxPerSec * factor));
  _scrollX = Math.max(0, center - _canvas.width / _pxPerSec / 2);
}

// ── Metronome ─────────────────────────────────────────────────

function _startMetro() {
  _stopMetro();
  if (!_metroOn || !_audioCtx || !_prevPlaying) return;

  const beatSec = 60 / _bpm;
  const now = _audioCtx.currentTime;
  // _prevStartCtx is the ctx time when beat 1 (_offset) started playing.
  // Beat n fires at _prevStartCtx + n * beatSec.
  const elapsed = now - _prevStartCtx;
  _metroBeatCount = Math.max(0, Math.ceil(elapsed / beatSec - 0.001));
  _metroNextBeat = _prevStartCtx + _metroBeatCount * beatSec;
  _metroTick();
}

function _stopMetro() {
  clearTimeout(_metroTimer);
  _metroTimer = null;
}

function _metroTick() {
  if (!_prevPlaying || !_audioCtx) return;
  const beatSec = 60 / _bpm;
  const now = _audioCtx.currentTime;
  while (_metroNextBeat < now + _METRO_LOOKAHEAD) {
    if (_metroNextBeat >= now - 0.01) {
      _metroClick(_metroNextBeat, _metroBeatCount % 4 === 0);
    }
    _metroBeatCount++;
    _metroNextBeat += beatSec;
  }
  _metroTimer = setTimeout(_metroTick, _METRO_TICK_MS);
}

function _metroClick(time, accent) {
  const c = _audioCtx;
  const vol = 0.6 * (accent ? 1.0 : 0.55);
  _metroOsc(c, accent ? 1100 : 800, vol * 0.6, time, accent ? 0.045 : 0.03);
  _metroOsc(c, accent ? 550 : 400, vol * 0.4, time, accent ? 0.032 : 0.021);
  _metroNoise(c, vol * 0.25, time, 0.008);
}

function _metroOsc(c, freq, gain, time, dur) {
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.connect(env);
  env.connect(c.destination);
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(gain, time + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.start(time);
  osc.stop(time + dur + 0.005);
}

function _metroNoise(c, gain, time, dur) {
  const bufSize = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, bufSize, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  const env = c.createGain();
  const flt = c.createBiquadFilter();
  flt.type = "bandpass";
  flt.frequency.value = 2000;
  flt.Q.value = 0.8;
  src.buffer = buf;
  src.connect(flt);
  flt.connect(env);
  env.connect(c.destination);
  env.gain.setValueAtTime(gain, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  src.start(time);
  src.stop(time + dur + 0.005);
}

// ── Preview ───────────────────────────────────────────────────

function _togglePreview() {
  if (_prevPlaying) _stopPreview();
  else _startPreview();
}

function _startPreview() {
  if (!_track.audioBuffer || !_audioCtx) return;
  _stopPreview();

  // Play from beat 1 for 2 bars
  const startSec = Math.max(0, _offset);
  const duration = (60 / _bpm) * 8;

  const src = _audioCtx.createBufferSource();
  const gain = _audioCtx.createGain();
  src.buffer = _track.audioBuffer;
  gain.gain.value = 0.9;
  src.connect(gain);
  gain.connect(_audioCtx.destination);
  src.start(_audioCtx.currentTime, startSec, duration);
  src.onended = () => {
    _stopMetro();
    _prevPlaying = false;
    _updatePreviewBtn();
  };

  _prevSrc = src;
  _prevGain = gain;
  _prevStartCtx = _audioCtx.currentTime;
  _prevStartTrack = startSec;
  _prevPlaying = true;
  _updatePreviewBtn();
  _startMetro();

  // Scroll view to show beat 1
  const W = _canvas.width || 600;
  _scrollX = Math.max(0, _offset - W / _pxPerSec / 4);
}

function _stopPreview() {
  _stopMetro();
  if (_prevSrc) {
    _prevSrc.onended = null; // prevent stale onended from killing the next preview's metronome
    try {
      _prevSrc.stop();
    } catch {
      /* already ended */
    }
    _prevGain?.disconnect();
    _prevSrc = null;
    _prevGain = null;
  }
  _prevPlaying = false;
  _updatePreviewBtn();
}

function _updatePreviewBtn() {
  const btn = _el?.querySelector(".bgm-preview-btn");
  if (btn) btn.textContent = _prevPlaying ? "⏹ Stop" : "▶ Preview";
}

// ── Keyboard ──────────────────────────────────────────────────

function _onKeyDown(e) {
  if (!_el || _el.classList.contains("hidden")) return;
  const inInput = e.target.tagName === "INPUT";

  if (e.code === "Escape") {
    close();
    return;
  }
  if (e.code === "Enter" && !inInput) {
    _onApply?.(_bpm, _offset);
    close();
    return;
  }
  if (e.code === "Space" && !inInput) {
    e.preventDefault();
    _togglePreview();
    return;
  }

  // Arrow keys to nudge offset
  const nudgeBeat = e.shiftKey ? 0.25 : 1;
  if (e.code === "ArrowLeft" && !inInput) {
    e.preventDefault();
    _offset = parseFloat((_offset - nudgeBeat * (60 / _bpm)).toFixed(6));
    _syncInputs();
  }
  if (e.code === "ArrowRight" && !inInput) {
    e.preventDefault();
    _offset = parseFloat((_offset + nudgeBeat * (60 / _bpm)).toFixed(6));
    _syncInputs();
  }
}

// ── Helpers ───────────────────────────────────────────────────

function _syncInputs() {
  if (!_el) return;
  _el.querySelector(".bgm-bpm").value = _bpm.toFixed(1);
  _el.querySelector(".bgm-offset-in").value = _offset.toFixed(4);
}

function _buildWaveform(audioBuffer, numPoints) {
  const ch = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(ch.length / numPoints));
  const out = new Float32Array(numPoints);
  for (let i = 0; i < numPoints; i++) {
    let max = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize && start + j < ch.length; j++) {
      const v = Math.abs(ch[start + j]);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

function _niceStep(approx) {
  const candidates = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((s) => s >= approx) ?? 60;
}

function _fmtSec(sec) {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(0).padStart(2, "0");
  return `${m}:${s}`;
}

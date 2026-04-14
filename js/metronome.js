/**
 * Lookahead metronome using the Web Audio clock.
 * Schedules clicks 100 ms ahead to stay jitter-free on the main thread.
 *
 * Accent (beat 1 of bar): higher-pitched double-click feel
 * Regular beats: softer single click
 */

let _ctx = null;
let _active = false;
let _nextBeat = 0;
let _beatCount = 0;
let _timer = null;
let _getBPM = () => 120;
let _volume = 0.6; // 0–1

const LOOKAHEAD = 0.1; // seconds to schedule ahead
const TICK_MS = 25; // scheduler wake-up interval

export function setGetBPM(fn) {
  _getBPM = fn;
}
export function setVolume(v) {
  _volume = Math.min(1, Math.max(0, v));
}
export function isActive() {
  return _active;
}

/**
 * Start the metronome.
 * @param {AudioContext} audioCtx
 * @param {number} [alignToSetTime] - set-timeline position (sec) to align
 *        beat 1 of the bar. If omitted starts from now.
 */
export function start(audioCtx, alignToSetTime = 0) {
  _ctx = audioCtx;
  _active = true;

  const bpm = _getBPM();
  const beatInterval = 60 / bpm;
  const barInterval = beatInterval * 4;

  // Align beat count so bar lines match the set timeline
  const now = _ctx.currentTime;
  _beatCount = Math.floor(alignToSetTime / beatInterval);
  _nextBeat = now + (Math.ceil(alignToSetTime / beatInterval) * beatInterval - alignToSetTime);
  // If playhead is exactly on a beat, start right away
  if (_nextBeat > now + LOOKAHEAD) _nextBeat = now;

  _schedule();
}

export function stop() {
  _active = false;
  clearTimeout(_timer);
  _timer = null;
}

// ── Internal ──────────────────────────────────────────────────

function _schedule() {
  if (!_active || !_ctx) return;

  const bpm = _getBPM();
  const beatInterval = 60 / bpm;

  while (_nextBeat < _ctx.currentTime + LOOKAHEAD) {
    _playClick(_nextBeat, _beatCount % 4 === 0);
    _beatCount++;
    _nextBeat += beatInterval;
  }

  _timer = setTimeout(_schedule, TICK_MS);
}

/**
 * Synthesise a short click using two stacked oscillators + noise burst.
 * Accent: brighter, louder. Regular: softer.
 */
function _playClick(time, accent) {
  const c = _ctx;
  const vol = _volume * (accent ? 1.0 : 0.55);
  const freqHi = accent ? 1100 : 800;
  const freqLo = accent ? 550 : 400;
  const dur = accent ? 0.045 : 0.03;

  // Hi oscillator
  _osc(c, freqHi, "sine", vol * 0.6, time, dur);
  // Lo oscillator (body)
  _osc(c, freqLo, "sine", vol * 0.4, time, dur * 0.7);
  // Noise transient (attack click)
  _noise(c, vol * 0.25, time, 0.008);
}

function _osc(c, freq, type, gain, time, dur) {
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.connect(env);
  env.connect(c.destination);
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(gain, time + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.start(time);
  osc.stop(time + dur + 0.005);
}

function _noise(c, gain, time, dur) {
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

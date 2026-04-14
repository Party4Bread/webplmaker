/**
 * Web Audio playback engine.
 *
 * Terminology:
 *   setTime  — position in the DJ set timeline (seconds, starts at 0)
 *   ctxTime  — AudioContext.currentTime (seconds, monotonically increasing)
 *
 * When play() is called at setTime T:
 *   ctxAnchor = ctx.currentTime
 *   setAnchor = T
 *   currentSetTime() = setAnchor + (ctx.currentTime - ctxAnchor)
 */

let ctx = null;
let ctxAnchor = 0; // ctx.currentTime when play() was last called
let setAnchor = 0; // setTime value when play() was last called
let playing = false;
let playheadAtStop = 0; // setTime when stopped/paused
let _masterBPM = 120; // current master BPM (used for playback rate calc)
let _bpmAutomation = []; // [{time, value}] set-time → BPM

// Active source nodes: Map<trackId, { source, gain, trackBpm }>
const activeSources = new Map();

function getCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Current set-time (seconds). Works whether playing or paused. */
export function currentSetTime() {
  if (!playing) return playheadAtStop;
  return setAnchor + (getCtx().currentTime - ctxAnchor);
}

export function isPlaying() {
  return playing;
}

/** Return the AudioContext (creates one if needed). */
export function getAudioContext() {
  return getCtx();
}

/** Resume the AudioContext (required after user gesture). */
export async function ensureResumed() {
  const c = getCtx();
  if (c.state === "suspended") await c.resume();
}

/**
 * Start playback from a given set-time position.
 * @param {number} fromSetTime
 * @param {Array}  tracks  — track objects with { id, audioBuffer, startTime, duration, volume, muted, automation }
 * @param {number} [masterBPM]      current master BPM (used to set playback rates)
 * @param {Array}  [bpmAutomation]  [{time, value}] set-time BPM curve
 */
export function play(fromSetTime, tracks, masterBPM = 120, bpmAutomation = []) {
  if (playing) stop(false);

  const c = getCtx();
  ctxAnchor = c.currentTime;
  setAnchor = fromSetTime;
  _masterBPM = masterBPM;
  _bpmAutomation = bpmAutomation;
  playing = true;

  for (const track of tracks) {
    scheduleTrack(track, fromSetTime);
  }
}

/** Stop all sources. If rewind=true reset playhead to 0. */
export function stop(rewind = true) {
  // Capture position before clearing `playing` flag
  const posNow = currentSetTime();
  playing = false;
  playheadAtStop = rewind ? 0 : posNow;

  for (const [, nodes] of activeSources) {
    try {
      nodes.source.stop();
    } catch {
      /* already stopped */
    }
    nodes.gain.disconnect();
    nodes.masterGain.disconnect();
  }
  activeSources.clear();
}

/** Pause — preserve current position. */
export function pause() {
  if (!playing) return;
  playheadAtStop = currentSetTime();
  stop(false);
}

/** Update volume for a running track in real time. */
export function setTrackVolume(trackId, value) {
  const nodes = activeSources.get(trackId);
  if (nodes) nodes.masterGain.gain.setTargetAtTime(value, getCtx().currentTime, 0.02);
}

/**
 * Stop and re-schedule a single track — call this when its startTime changes
 * during playback so the audio position updates immediately.
 * @param {Object} track  the updated track object
 */
export function rescheduleTrack(track) {
  if (!playing) return;

  // Stop existing source for this track
  const nodes = activeSources.get(track.id);
  if (nodes) {
    try {
      nodes.source.stop();
    } catch {
      /* already ended */
    }
    nodes.gain.disconnect();
    nodes.masterGain.disconnect();
    activeSources.delete(track.id);
  }

  // Refresh anchors so scheduleTrack's ctx-time formula stays accurate.
  // ctxAnchor was set when play() was called; if seconds have elapsed it's
  // far in the past, causing startCtxTime to fall behind ctx.currentTime and
  // the source to fire immediately even when the track is still in the future.
  const c = getCtx();
  const setNow = currentSetTime();
  ctxAnchor = c.currentTime;
  setAnchor = setNow;

  scheduleTrack(track, setNow);
}

/**
 * Schedule a single track for playback.
 * Handles the case where the playhead is already inside the track.
 * Playback rate = masterBPM / track.bpm so tracks stay beat-locked.
 */
function scheduleTrack(track, fromSetTime) {
  if (!track.audioBuffer || track.muted) return;

  const c = getCtx();
  const trackBpm = track.bpm || _masterBPM;
  const playbackRate = _masterBPM / trackBpm;
  // track.startTime is in beats; convert to set-timeline seconds
  const trackStartInSec = track.startTime * (60 / _masterBPM);

  // Effective set-timeline duration when time-stretched to master BPM
  const setDuration = track.duration / playbackRate;
  const trackEnd = trackStartInSec + setDuration;

  if (trackEnd <= fromSetTime) return;

  const source = c.createBufferSource();
  source.buffer = track.audioBuffer;
  source.playbackRate.value = playbackRate;

  // Two gain nodes so automation and the volume slider never fight each other.
  // autoGain (0–1): driven entirely by volume automation points.
  // masterGain (0–1): driven by the track volume slider, never touched by automation.
  const gain = c.createGain(); // automation gain
  const masterGain = c.createGain(); // volume slider gain
  gain.gain.value = 1;
  masterGain.gain.value = track.volume ?? 1;
  source.connect(gain);
  gain.connect(masterGain);
  masterGain.connect(c.destination);

  // Audio-file offset: accounts for playback rate
  const audioOffset = Math.max(0, (fromSetTime - trackStartInSec) * playbackRate);

  // When in ctx time does playback begin?
  const startCtxTime = ctxAnchor + Math.max(0, trackStartInSec - fromSetTime);

  // Remaining audio duration (audio-file seconds)
  const remainingDuration = track.duration - audioOffset;
  if (remainingDuration <= 0) return;

  source.start(startCtxTime, audioOffset, remainingDuration);

  // Pre-schedule future BPM automation rate changes
  _scheduleBpmRate(source.playbackRate, trackBpm, fromSetTime, ctxAnchor);

  // Schedule volume automation (pass playbackRate so timing is correct)
  applyAutomation(gain.gain, track.automation ?? [], trackStartInSec, fromSetTime, ctxAnchor, playbackRate);

  activeSources.set(track.id, { source, gain, masterGain, trackBpm });

  source.onended = () => {
    if (activeSources.get(track.id)?.source === source) {
      gain.disconnect();
      masterGain.disconnect();
      activeSources.delete(track.id);
    }
  };
}

/**
 * Pre-schedule playback-rate ramps from BPM automation onto an AudioParam.
 * @param {AudioParam} param
 * @param {number} trackBpm  native BPM of the audio file
 * @param {number} fromSetTime  set-time at which playback starts
 * @param {number} fromCtxTime  corresponding AudioContext time
 */
function _scheduleBpmRate(param, trackBpm, fromSetTime, fromCtxTime) {
  if (!_bpmAutomation || _bpmAutomation.length < 2) return;
  const sorted = [..._bpmAutomation].sort((a, b) => a.time - b.time);
  for (const pt of sorted) {
    if (pt.time <= fromSetTime) continue;
    const ctxTime = fromCtxTime + (pt.time - fromSetTime);
    param.linearRampToValueAtTime(pt.value / trackBpm, ctxTime);
  }
}

/**
 * Apply volume automation to a GainNode AudioParam.
 * @param {AudioParam} param
 * @param {Array}  points         [{time, value}]  time = seconds into the audio file
 * @param {number} trackStartInSet  when track begins in set timeline
 * @param {number} fromSetTime      current playhead position
 * @param {number} ctxAnchor        ctx.currentTime at play()
 * @param {number} [playbackRate]   source.playbackRate (default 1)
 */
function applyAutomation(param, points, trackStartInSet, fromSetTime, ctxAnchor, playbackRate = 1) {
  if (!points || points.length === 0) return;

  const c = getCtx();
  const sorted = [...points].sort((a, b) => a.time - b.time);

  // Current position inside the audio file
  const audioOffset = Math.max(0, (fromSetTime - trackStartInSet) * playbackRate);
  const initValue = interpolateAutomation(sorted, audioOffset);
  param.setValueAtTime(initValue, c.currentTime);

  // Schedule future automation points
  // pt.time is in audio-file seconds; convert to set-time then to ctx-time
  for (const pt of sorted) {
    const setTimeOfPoint = trackStartInSet + pt.time / playbackRate;
    if (setTimeOfPoint <= fromSetTime) continue;
    const ctxTimeOfPoint = ctxAnchor + (setTimeOfPoint - fromSetTime);
    param.linearRampToValueAtTime(pt.value, ctxTimeOfPoint);
  }
}

/**
 * Cancel any scheduled gain events for a track and re-apply fresh automation
 * from the current playhead position. Call this whenever automation is edited
 * during playback so the old scheduled ramps don't override the new points.
 *
 * @param {string} trackId
 * @param {Array}  points          [{time, value}]  time = seconds from track start
 * @param {number} trackStartInSet when the track begins in the set timeline (seconds)
 */
export function rescheduleAutomation(trackId, points, trackStartInSet) {
  const nodes = activeSources.get(trackId);
  if (!nodes) return;

  const c = getCtx();
  const now = c.currentTime;
  const setNow = currentSetTime();
  const playbackRate = nodes.trackBpm ? _masterBPM / nodes.trackBpm : 1;

  // Current position inside the audio file (accounts for playback rate)
  const audioOffset = Math.max(0, (setNow - trackStartInSet) * playbackRate);

  // Only touch the automation gain node — masterGain is owned by the volume slider
  nodes.gain.gain.cancelScheduledValues(now);
  nodes.gain.gain.setValueAtTime(interpolateAutomation(points, audioOffset), now);

  const sorted = [...points].sort((a, b) => a.time - b.time);
  for (const pt of sorted) {
    const setTimeOfPoint = trackStartInSet + pt.time / playbackRate;
    if (setTimeOfPoint <= setNow) continue;
    const ctxTime = now + (setTimeOfPoint - setNow);
    nodes.gain.gain.linearRampToValueAtTime(pt.value, ctxTime);
  }
}

/**
 * Update the master BPM live — reschedules playback rates for all active sources.
 * @param {number} bpm
 */
export function setMasterBPM(bpm) {
  _masterBPM = bpm;
  if (!playing) return;
  const c = getCtx();
  const now = c.currentTime;
  const setNow = currentSetTime();

  for (const [, nodes] of activeSources) {
    const trackBpm = nodes.trackBpm || bpm;
    nodes.source.playbackRate.cancelScheduledValues(now);
    nodes.source.playbackRate.setValueAtTime(bpm / trackBpm, now);
    _scheduleBpmRate(nodes.source.playbackRate, trackBpm, setNow, now);
  }
}

/**
 * Replace the BPM automation curve and reschedule all active source rates.
 * Call this when BPM automation points are edited during playback.
 * @param {Array} bpmAutomation  [{time, value}]
 */
export function rescheduleBpmAutomation(bpmAutomation) {
  _bpmAutomation = bpmAutomation;
  if (!playing) return;
  const c = getCtx();
  const now = c.currentTime;
  const setNow = currentSetTime();
  const curBpm = interpolateAutomation(bpmAutomation, setNow) || _masterBPM;

  for (const [, nodes] of activeSources) {
    const trackBpm = nodes.trackBpm || _masterBPM;
    nodes.source.playbackRate.cancelScheduledValues(now);
    nodes.source.playbackRate.setValueAtTime(curBpm / trackBpm, now);
    _scheduleBpmRate(nodes.source.playbackRate, trackBpm, setNow, now);
  }
  _masterBPM = curBpm;
}

/** Linear interpolation between automation points at a given track-offset. */
export function interpolateAutomation(points, trackOffset) {
  if (!points || points.length === 0) return 1;
  if (points.length === 1) return points[0].value;

  const sorted = [...points].sort((a, b) => a.time - b.time);

  if (trackOffset <= sorted[0].time) return sorted[0].value;
  if (trackOffset >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i],
      b = sorted[i + 1];
    if (trackOffset >= a.time && trackOffset <= b.time) {
      const t = (trackOffset - a.time) / (b.time - a.time);
      return a.value + t * (b.value - a.value);
    }
  }
  return 1;
}

/**
 * Decode an ArrayBuffer into an AudioBuffer.
 * Returns decoded AudioBuffer.
 */
export async function decodeAudio(arrayBuffer) {
  const c = getCtx();
  return c.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Build a downsampled waveform array for display.
 * Returns Float32Array of length `numPoints`, values 0–1.
 */
export function buildWaveform(audioBuffer, numPoints) {
  const channel = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channel.length / numPoints);
  const waveform = new Float32Array(numPoints);

  for (let i = 0; i < numPoints; i++) {
    let max = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      const abs = Math.abs(channel[start + j]);
      if (abs > max) max = abs;
    }
    waveform[i] = max;
  }
  return waveform;
}

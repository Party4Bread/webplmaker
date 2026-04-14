/**
 * BPM detection using onset-strength autocorrelation.
 * Analyzes up to the first 60s of audio.
 */
export async function detectBPM(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const maxSamples = Math.min(audioBuffer.length, sampleRate * 60);

  // Mix down to mono
  const mono = new Float32Array(maxSamples);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const channel = audioBuffer.getChannelData(ch);
    for (let i = 0; i < maxSamples; i++) mono[i] += channel[i];
  }
  const scale = 1 / audioBuffer.numberOfChannels;
  for (let i = 0; i < maxSamples; i++) mono[i] *= scale;

  // RMS energy in overlapping windows
  const windowSamples = Math.round(sampleRate * 0.04); // 40ms
  const hopSamples = Math.round(sampleRate * 0.02); // 20ms
  const numFrames = Math.floor((maxSamples - windowSamples) / hopSamples);

  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const offset = i * hopSamples;
    for (let j = 0; j < windowSamples; j++) {
      const s = mono[offset + j];
      sum += s * s;
    }
    energy[i] = Math.sqrt(sum / windowSamples);
  }

  // Onset detection function: half-wave rectified energy derivative
  const odf = new Float32Array(numFrames);
  for (let i = 1; i < numFrames; i++) {
    odf[i] = Math.max(0, energy[i] - energy[i - 1]);
  }

  // Normalize ODF
  let maxOdf = 0;
  for (let i = 0; i < numFrames; i++) if (odf[i] > maxOdf) maxOdf = odf[i];
  if (maxOdf > 0) for (let i = 0; i < numFrames; i++) odf[i] /= maxOdf;

  // Autocorrelation over BPM range 60–200
  const hopDuration = hopSamples / sampleRate; // seconds per frame
  const minLag = Math.max(1, Math.floor(60 / (200 * hopDuration)));
  const maxLag = Math.ceil(60 / (60 * hopDuration));

  let bestBPM = 120;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    const n = numFrames - lag;
    for (let i = 0; i < n; i++) score += odf[i] * odf[i + lag];
    score /= n;

    const bpm = 60 / (lag * hopDuration);
    if (score > bestScore) {
      bestScore = score;
      bestBPM = bpm;
    }
  }

  // Prefer the range 90–180 — resolve half/double ambiguity
  const candidates = [bestBPM, bestBPM * 2, bestBPM / 2];
  const resolved = candidates.find((b) => b >= 90 && b <= 180) ?? bestBPM;

  return Math.round(resolved);
}

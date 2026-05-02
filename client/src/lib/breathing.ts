/*
 * breathing.ts — Respiratory Signal Processing Library
 * Bio-Lab Noir build (Face Breath)
 *
 * Implements video-based respiratory rate estimation based on:
 *
 * [RR-1] Chen et al. (2019) "Respiratory Rate Estimation from Face Videos"
 *   arXiv:1909.03503 / IEEE BHI 2019 — rPPG-based RR with two-phase temporal filtering
 *
 * [RR-2] Park & Hong (2023) "Facial Video-Based Robust Measurement of Respiratory Rates"
 *   Journal of Sensors, DOI:10.1155/2023/9207750
 *   — YCgCo color space + partial zero-padding FFT for RR extraction
 *
 * [RR-3] Nhan & Chung (2020) "Tracking nostril movement in facial video for RR estimation"
 *   IEEE EMBC 2020, DOI:10.1109/EMBC44109.2020.9225464
 *   — Nostril landmark tracking for nasal breathing signal
 *
 * [RR-4] Huang et al. (2021) "Nose breathing or mouth breathing?"
 *   CVPRW 2021 — Nasal/oral breathing classification via ROI signal comparison
 *
 * [RR-5] Fei & Pavlidis (2010) "Extracting respiration rate and relative tidal volume"
 *   Psychophysiology, DOI:10.1111/j.1469-8986.2010.01167.x
 *   — Peak-to-peak amplitude as relative tidal volume proxy
 *
 * Pipeline:
 *   1. Collect (timestamp, R, G, B) samples from multiple ROIs at ~30fps
 *   2. Resample to uniform grid, detrend, apply Hann window
 *   3. FFT → bandpass 0.1–0.5 Hz (6–30 BPM) for respiratory band
 *   4. Parabolic interpolation for sub-bin peak frequency
 *   5. Estimate BPM, depth (peak-to-peak), SNR, confidence
 *   6. Classify nasal vs oral breathing from ROI signal ratios
 */

export interface RgbSample {
  t: number; // ms
  r: number;
  g: number;
  b: number;
}

export interface LandmarkSample {
  t: number;
  /** Normalized y-coordinate of upper lip center (FaceMesh #13) */
  upperLipY: number;
  /** Normalized y-coordinate of lower lip center (FaceMesh #14) */
  lowerLipY: number;
  /** Normalized y-coordinate of nose tip (FaceMesh #1) */
  noseTipY: number;
  /** Normalized y-coordinate of left nostril base (FaceMesh #2) */
  leftNostrilY: number;
  /** Normalized y-coordinate of right nostril base (FaceMesh #326) */
  rightNostrilY: number;
}

export type BreathingMode = "nasal" | "oral" | "mixed" | "unknown";

export interface BreathingResult {
  /** Breaths per minute */
  bpm: number;
  /** Signal-to-noise ratio (higher is better) */
  snr: number;
  /** 0..1 confidence */
  confidence: number;
  /** Effective frames per second */
  fps: number;
  /** Filtered respiratory waveform, normalized to ~[-1, 1] */
  waveform: number[];
  /** Dominant frequency in Hz */
  freqHz: number;
  /** Instantaneous phase 0..2π */
  phase: number;
  /** Relative breathing depth (peak-to-peak amplitude, 0..1) */
  depth: number;
  /** Nasal vs oral breathing classification */
  breathingMode: BreathingMode;
  /** Mouth openness ratio (0=closed, 1=fully open relative to face height) */
  mouthOpenness: number;
  /** Nasal signal power relative to total */
  nasalPower: number;
  /** Oral signal power relative to total */
  oralPower: number;
}

// ── frequency constants ──────────────────────────────────────────────────────
const MIN_HZ = 0.1; // 6 BPM
const MAX_HZ = 0.5; // 30 BPM
const MIN_SAMPLES = 64;
const MIN_DURATION_S = 6;

// ── utility: detrend (remove linear trend) ──────────────────────────────────
function detrend(x: Float32Array): Float32Array {
  const N = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < N; i++) {
    sumX += i; sumY += x[i]; sumXY += i * x[i]; sumX2 += i * i;
  }
  const denom = N * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (N * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / N;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i] - (slope * i + intercept);
  return out;
}

// ── utility: Hann window ─────────────────────────────────────────────────────
function hannWindow(x: Float32Array): Float32Array {
  const N = x.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = x[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return out;
}

// ── utility: DFT (real input) ────────────────────────────────────────────────
function dft(x: Float32Array): { re: Float32Array; im: Float32Array } {
  const N = x.length;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let r = 0, i = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      r += x[n] * Math.cos(angle);
      i -= x[n] * Math.sin(angle);
    }
    re[k] = r; im[k] = i;
  }
  return { re, im };
}

// ── utility: linear interpolation resample ──────────────────────────────────
function resample(samples: RgbSample[], targetFs: number): Float32Array[] {
  const N = samples.length;
  const t0 = samples[0].t;
  const tN = samples[N - 1].t;
  const durationS = (tN - t0) / 1000;
  const M = Math.floor(durationS * targetFs);
  const r = new Float32Array(M);
  const g = new Float32Array(M);
  const b = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const t = t0 + (i / targetFs) * 1000;
    // binary search for surrounding samples
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) lo = mid; else hi = mid;
    }
    const alpha = samples[hi].t === samples[lo].t
      ? 0
      : (t - samples[lo].t) / (samples[hi].t - samples[lo].t);
    r[i] = samples[lo].r + alpha * (samples[hi].r - samples[lo].r);
    g[i] = samples[lo].g + alpha * (samples[hi].g - samples[lo].g);
    b[i] = samples[lo].b + alpha * (samples[hi].b - samples[lo].b);
  }
  return [r, g, b];
}

// ── utility: normalize to [-1, 1] ────────────────────────────────────────────
function normalize(x: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > max) max = Math.abs(x[i]);
  if (max < 1e-9) return x;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / max;
  return out;
}

// ── BreathingProcessor ───────────────────────────────────────────────────────
export class BreathingProcessor {
  private faceSamples: RgbSample[] = [];
  private noseSamples: RgbSample[] = [];
  private mouthSamples: RgbSample[] = [];
  private chestSamples: RgbSample[] = [];
  private landmarkSamples: LandmarkSample[] = [];
  private windowMs: number;

  constructor(windowSeconds = 20) {
    this.windowMs = windowSeconds * 1000;
  }

  pushFace(s: RgbSample) { this._push(this.faceSamples, s); }
  pushNose(s: RgbSample) { this._push(this.noseSamples, s); }
  pushMouth(s: RgbSample) { this._push(this.mouthSamples, s); }
  pushChest(s: RgbSample) { this._push(this.chestSamples, s); }
  pushLandmark(s: LandmarkSample) {
    this.landmarkSamples.push(s);
    const cutoff = s.t - this.windowMs;
    while (this.landmarkSamples.length > 0 && this.landmarkSamples[0].t < cutoff) {
      this.landmarkSamples.shift();
    }
  }

  private _push(arr: RgbSample[], s: RgbSample) {
    arr.push(s);
    const cutoff = s.t - this.windowMs;
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
  }

  reset() {
    this.faceSamples = [];
    this.noseSamples = [];
    this.mouthSamples = [];
    this.chestSamples = [];
    this.landmarkSamples = [];
  }

  get faceCount() { return this.faceSamples.length; }

  get spanSeconds() {
    if (this.faceSamples.length < 2) return 0;
    return (this.faceSamples[this.faceSamples.length - 1].t - this.faceSamples[0].t) / 1000;
  }

  /**
   * Analyze respiratory signals from all available ROIs.
   *
   * Signal extraction strategy (Park & Hong 2023, Chen et al. 2019):
   * - Face ROI: Cg channel (YCgCo transform) captures respiration-related
   *   color changes in the green channel (Cg = G - (R+B)/2)
   * - Nose ROI: Brightness changes from nostril airflow (Nhan & Chung 2020)
   * - Mouth ROI: Lip movement + color changes for oral breathing
   * - Chest ROI: Luminance changes from chest expansion
   * - Landmark: Mouth openness from lip distance (Huang et al. 2021)
   */
  analyze(): BreathingResult | null {
    const primary = this.faceSamples;
    if (primary.length < MIN_SAMPLES) return null;
    const t0 = primary[0].t;
    const tN = primary[primary.length - 1].t;
    const durationS = (tN - t0) / 1000;
    if (durationS < MIN_DURATION_S) return null;

    const fps = (primary.length - 1) / durationS;
    const targetFs = Math.min(30, Math.max(10, fps));
    const M = Math.floor(durationS * targetFs);
    if (M < MIN_SAMPLES) return null;

    // ── Extract Cg channel from face ROI (Park & Hong 2023) ──
    // YCgCo: Cg = G - (R + B) / 2  — robust to illumination changes
    const [fr, fg, fb] = resample(primary, targetFs);
    const cg = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      cg[i] = fg[i] - (fr[i] + fb[i]) / 2;
    }

    // ── Nose ROI: green channel brightness (Nhan & Chung 2020) ──
    let noseSignal: Float32Array | null = null;
    if (this.noseSamples.length >= MIN_SAMPLES) {
      const [, ng] = resample(this.noseSamples, targetFs);
      noseSignal = detrend(hannWindow(normalize(ng)));
    }

    // ── Mouth ROI: green channel ──
    let mouthSignal: Float32Array | null = null;
    if (this.mouthSamples.length >= MIN_SAMPLES) {
      const [, mg] = resample(this.mouthSamples, targetFs);
      mouthSignal = detrend(hannWindow(normalize(mg)));
    }

    // ── Chest ROI: luminance ──
    let chestSignal: Float32Array | null = null;
    if (this.chestSamples.length >= MIN_SAMPLES) {
      const [cr, cg2, cb] = resample(this.chestSamples, targetFs);
      const lum = new Float32Array(M);
      for (let i = 0; i < M; i++) lum[i] = 0.299 * cr[i] + 0.587 * cg2[i] + 0.114 * cb[i];
      chestSignal = detrend(hannWindow(normalize(lum)));
    }

    // ── Process primary face signal ──
    const processed = hannWindow(detrend(cg));
    const { re, im } = dft(processed);

    const freqRes = targetFs / M;
    const minBin = Math.floor(MIN_HZ / freqRes);
    const maxBin = Math.ceil(MAX_HZ / freqRes);

    // Find peak in respiratory band
    let peakBin = minBin;
    let peakPow = 0;
    let totalPow = 0;
    for (let k = 1; k <= M / 2; k++) {
      const pow = re[k] * re[k] + im[k] * im[k];
      if (k >= minBin && k <= maxBin) {
        totalPow += pow;
        if (pow > peakPow) { peakPow = pow; peakBin = k; }
      }
    }

    // Parabolic interpolation for sub-bin precision
    let peakFreq = peakBin * freqRes;
    if (peakBin > minBin && peakBin < maxBin) {
      const p1 = re[peakBin - 1] ** 2 + im[peakBin - 1] ** 2;
      const p2 = peakPow;
      const p3 = re[peakBin + 1] ** 2 + im[peakBin + 1] ** 2;
      const denom = p1 - 2 * p2 + p3;
      if (Math.abs(denom) > 1e-9) {
        peakFreq = (peakBin + 0.5 * (p1 - p3) / denom) * freqRes;
        peakFreq = Math.max(MIN_HZ, Math.min(MAX_HZ, peakFreq));
      }
    }

    const bpm = peakFreq * 60;

    // SNR: peak power vs total band power
    const snr = totalPow > 0 ? 10 * Math.log10(peakPow / (totalPow - peakPow + 1e-9)) : 0;
    const confidence = Math.min(1, Math.max(0, (snr + 5) / 20));

    // ── Reconstruct filtered waveform ──
    // Bandpass: zero out bins outside respiratory range
    const filtRe = new Float32Array(M);
    const filtIm = new Float32Array(M);
    for (let k = minBin; k <= maxBin && k <= M / 2; k++) {
      filtRe[k] = re[k]; filtIm[k] = im[k];
      if (k > 0 && M - k < M) { filtRe[M - k] = re[M - k]; filtIm[M - k] = im[M - k]; }
    }
    // IDFT
    const waveRaw = new Float32Array(M);
    for (let n = 0; n < M; n++) {
      let v = 0;
      for (let k = 0; k < M; k++) {
        const angle = (2 * Math.PI * k * n) / M;
        v += filtRe[k] * Math.cos(angle) - filtIm[k] * Math.sin(angle);
      }
      waveRaw[n] = v / M;
    }
    const waveNorm = normalize(waveRaw);

    // Instantaneous phase of dominant component
    const phase = Math.atan2(im[peakBin], re[peakBin]);

    // ── Breathing depth (Fei & Pavlidis 2010) ──
    // Peak-to-peak amplitude of the filtered waveform as relative tidal volume
    let maxV = -Infinity, minV = Infinity;
    for (let i = 0; i < waveNorm.length; i++) {
      if (waveNorm[i] > maxV) maxV = waveNorm[i];
      if (waveNorm[i] < minV) minV = waveNorm[i];
    }
    const depth = Math.min(1, (maxV - minV) / 2);

    // ── Nasal/oral classification (Huang et al. 2021) ──
    let breathingMode: BreathingMode = "unknown";
    let nasalPower = 0.5;
    let oralPower = 0.5;
    let mouthOpenness = 0;

    // Mouth openness from landmark data
    if (this.landmarkSamples.length > 10) {
      const recent = this.landmarkSamples.slice(-30);
      let sumOpen = 0;
      for (const s of recent) {
        sumOpen += Math.abs(s.lowerLipY - s.upperLipY);
      }
      mouthOpenness = sumOpen / recent.length;
    }

    // Power comparison between nose and mouth ROI signals
    if (noseSignal && mouthSignal) {
      let nPow = 0, mPow = 0;
      const len = Math.min(noseSignal.length, mouthSignal.length);
      for (let i = 0; i < len; i++) {
        nPow += noseSignal[i] * noseSignal[i];
        mPow += mouthSignal[i] * mouthSignal[i];
      }
      const total = nPow + mPow + 1e-9;
      nasalPower = nPow / total;
      oralPower = mPow / total;

      // Classification thresholds (Huang et al. 2021 approach adapted for RGB)
      const ORAL_THRESHOLD = 0.55;
      const NASAL_THRESHOLD = 0.55;
      const MOUTH_OPEN_THRESHOLD = 0.025; // normalized face height

      if (oralPower > ORAL_THRESHOLD && mouthOpenness > MOUTH_OPEN_THRESHOLD) {
        breathingMode = "oral";
      } else if (nasalPower > NASAL_THRESHOLD) {
        breathingMode = "nasal";
      } else {
        breathingMode = "mixed";
      }
    } else if (mouthOpenness > 0.03) {
      breathingMode = "oral";
    } else if (mouthOpenness < 0.01) {
      breathingMode = "nasal";
    }

    return {
      bpm,
      snr,
      confidence,
      fps,
      waveform: Array.from(waveNorm),
      freqHz: peakFreq,
      phase,
      depth,
      breathingMode,
      mouthOpenness,
      nasalPower,
      oralPower,
    };
  }

  /**
   * Compute instantaneous respiratory signal value for EVM amplification.
   * Returns the current value of the dominant respiratory component.
   */
  getInstantaneousValue(): number {
    if (this.faceSamples.length < 10) return 0;
    const recent = this.faceSamples.slice(-10);
    const cg = recent.map(s => s.g - (s.r + s.b) / 2);
    const mean = cg.reduce((a, b) => a + b, 0) / cg.length;
    const last = cg[cg.length - 1];
    return Math.max(-1, Math.min(1, (last - mean) / (Math.abs(mean) + 1)));
  }
}

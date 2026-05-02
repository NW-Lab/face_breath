/**
 * BreathingVisualizer — Bio-Lab Noir
 *
 * Design rules:
 *  - ONE useEffect with [] dependency
 *  - NO useCallback
 *  - Minimal state: only `status` (string) for UI re-render
 *  - Everything else in useRef
 *  - RAF loop handles ALL processing
 *  - iPhone Safari first
 */

import { useEffect, useRef, useState } from "react";

// ── Constants ──────────────────────────────────────────────────────────────
const CALIB_FRAMES = 150;       // ~5s at 30fps
const TARGET_FPS   = 30;
const SAMPLE_WINDOW_MS = 10000; // 10s sliding window for BPM
const WAVEFORM_LEN = 120;

// ── Types ──────────────────────────────────────────────────────────────────
interface RGBSample { t: number; r: number; g: number; b: number }

// ── Simple bandpass filter (IIR, breath band 0.1–0.5 Hz) ──────────────────
// Butterworth 2nd-order coefficients pre-computed for fs=30Hz, 0.1–0.5Hz
// Using simple moving-average difference as lightweight alternative
function bandpassBreath(signal: number[]): number[] {
  if (signal.length < 10) return signal.map(() => 0);
  const n = signal.length;
  const out = new Array(n).fill(0);
  const slowWin = Math.min(n, Math.round(30 / 0.1)); // ~300 samples
  const fastWin = Math.min(n, Math.round(30 / 0.5)); // ~60 samples
  for (let i = 0; i < n; i++) {
    const s0 = Math.max(0, i - slowWin);
    const s1 = Math.max(0, i - fastWin);
    let sumSlow = 0, sumFast = 0;
    for (let j = s0; j <= i; j++) sumSlow += signal[j];
    for (let j = s1; j <= i; j++) sumFast += signal[j];
    out[i] = sumFast / (i - s1 + 1) - sumSlow / (i - s0 + 1);
  }
  return out;
}

function estimateBPM(signal: number[], fps: number): number {
  const filtered = bandpassBreath(signal);
  const n = filtered.length;
  if (n < 30) return 0;
  // Count zero-crossings (upward) for breath rate
  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if (filtered[i - 1] < 0 && filtered[i] >= 0) crossings++;
  }
  const durationSec = n / fps;
  return Math.round((crossings / durationSec) * 60);
}

function peakToPeak(signal: number[]): number {
  if (signal.length === 0) return 0;
  const mn = Math.min(...signal);
  const mx = Math.max(...signal);
  return mx - mn;
}

// Slider constants
const FFT_WIN_MIN = 100;
const FFT_WIN_MAX = 600;
const FFT_WIN_DEFAULT = 300;

// ── Component ──────────────────────────────────────────────────────────────
export default function BreathingVisualizer() {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const waveRef    = useRef<HTMLCanvasElement>(null);

  // All mutable state in refs (no re-render from these)
  const rafRef         = useRef<number>(0);
  const lastFrameRef   = useRef<number>(0);
  const frameCountRef  = useRef<number>(0);   // calibration counter
  const faceSamples    = useRef<RGBSample[]>([]);
  const noseSamples    = useRef<RGBSample[]>([]);
  const mouthSamples   = useRef<RGBSample[]>([]);
  const chestSamples   = useRef<RGBSample[]>([]);
  const waveformRef    = useRef<number[]>([]);
  const smoothBreath   = useRef<number>(0);

  // FFT window length (in frames) — controlled by slider, stored in ref
  const fftWinRef      = useRef<number>(FFT_WIN_DEFAULT);

  // Results (stored in ref, written to DOM directly for performance)
  const bpmRef         = useRef<number>(0);
  const depthRef       = useRef<number>(0);
  const modeRef        = useRef<string>("--");
  const phaseRef       = useRef<"idle"|"calibrating"|"measuring">("idle");

  // DOM refs for result display (avoid React re-render)
  const bpmDomRef      = useRef<HTMLSpanElement>(null);
  const depthDomRef    = useRef<HTMLSpanElement>(null);
  const modeDomRef     = useRef<HTMLSpanElement>(null);
  const calibBarRef    = useRef<HTMLDivElement>(null);
  const calibTextRef   = useRef<HTMLSpanElement>(null);
  const statusDomRef   = useRef<HTMLDivElement>(null);
  const sampleCountDomRef = useRef<HTMLSpanElement>(null);

  // React state: only for showing/hiding camera UI
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [fftWinDisplay, setFftWinDisplay] = useState(FFT_WIN_DEFAULT);

  // ── Sample ROI from canvas ──────────────────────────────────────────────
  function sampleROI(
    ctx: CanvasRenderingContext2D,
    xFrac: number, yFrac: number,
    wFrac: number, hFrac: number
  ): { r: number; g: number; b: number } | null {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    if (!cw || !ch) return null;
    const x = Math.floor(xFrac * cw);
    const y = Math.floor(yFrac * ch);
    const w = Math.max(1, Math.floor(wFrac * cw));
    const h = Math.max(1, Math.floor(hFrac * ch));
    try {
      const d = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0;
      const n = w * h;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2];
      }
      return { r: r / n, g: g / n, b: b / n };
    } catch {
      return null;
    }
  }

  // ── Draw face guide oval ────────────────────────────────────────────────
  function drawGuide(ctx: CanvasRenderingContext2D, progress: number) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const cx = w / 2;
    const cy = h * 0.42;
    const rx = w * 0.22;
    const ry = h * 0.32;
    const alpha = 0.5 + progress * 0.5;
    const color = `rgba(0, 220, 255, ${alpha})`;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 8]);
    ctx.shadowColor = "rgba(0,220,255,0.8)";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Label
    ctx.fillStyle = color;
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.fillText("FACE ALIGN", cx, cy - ry - 14);

    // Progress arc
    if (progress > 0) {
      ctx.strokeStyle = `rgba(0,255,180,${alpha})`;
      ctx.lineWidth = 4;
      ctx.shadowColor = "rgba(0,255,180,0.8)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + 8, ry + 8, -Math.PI / 2, 0, Math.PI * 2 * progress);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // ── EVM-style breath amplification overlay ──────────────────────────────
  function drawBreathOverlay(ctx: CanvasRenderingContext2D, breathVal: number) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const intensity = Math.min(1, Math.abs(breathVal) * 8);
    if (intensity < 0.02) return;

    // Nose glow
    ctx.save();
    const noseGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, w * 0.15);
    noseGrad.addColorStop(0, `rgba(0,220,255,${intensity * 0.25})`);
    noseGrad.addColorStop(1, "rgba(0,220,255,0)");
    ctx.fillStyle = noseGrad;
    ctx.fillRect(0, 0, w, h);

    // Chest glow (lower half)
    const chestGrad = ctx.createRadialGradient(w * 0.5, h * 0.8, 0, w * 0.5, h * 0.8, w * 0.35);
    chestGrad.addColorStop(0, `rgba(0,180,255,${intensity * 0.18})`);
    chestGrad.addColorStop(1, "rgba(0,180,255,0)");
    ctx.fillStyle = chestGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ── Draw waveform ────────────────────────────────────────────────────────
  function drawWaveform(waveData: number[]) {
    const canvas = waveRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (waveData.length < 2) return;

    ctx.save();
    ctx.strokeStyle = "rgba(0,220,255,0.9)";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,220,255,0.6)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    const step = w / (waveData.length - 1);
    waveData.forEach((v, i) => {
      const x = i * step;
      const y = h / 2 - v * h * 0.4;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center line
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Main RAF loop ────────────────────────────────────────────────────────
  useEffect(() => {
    // This effect runs once on mount and never restarts.
    // All mutable values are accessed via refs.
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let running = true;

    const loop = (now: number) => {
      if (!running) return;
      rafRef.current = requestAnimationFrame(loop);

      if (phaseRef.current === "idle") return;

      // Throttle to TARGET_FPS
      if (now - lastFrameRef.current < 1000 / TARGET_FPS) return;
      lastFrameRef.current = now;

      // Wait for video
      if (video.readyState < 2) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      // Sync canvas size to CSS size
      const rect = canvas.getBoundingClientRect();
      const cw = Math.floor(rect.width)  || vw;
      const ch = Math.floor(rect.height) || vh;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width  = cw;
        canvas.height = ch;
      }

      // Sync wave canvas size
      const waveCanvas = waveRef.current;
      if (waveCanvas) {
        const wr = waveCanvas.getBoundingClientRect();
        const ww = Math.floor(wr.width)  || 300;
        const wh = Math.floor(wr.height) || 80;
        if (waveCanvas.width !== ww || waveCanvas.height !== wh) {
          waveCanvas.width  = ww;
          waveCanvas.height = wh;
        }
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      // ── Draw video frame (mirrored) ──
      ctx.save();
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, cw, ch);
      ctx.restore();

      const t = now;

      // ── Sample ROIs ──
      const faceRoi  = sampleROI(ctx, 0.22, 0.08, 0.56, 0.52);
      const noseRoi  = sampleROI(ctx, 0.38, 0.40, 0.24, 0.14);
      const mouthRoi = sampleROI(ctx, 0.35, 0.56, 0.30, 0.12);
      const chestRoi = sampleROI(ctx, 0.15, 0.68, 0.70, 0.28);

      if (faceRoi)  faceSamples.current.push({ t, ...faceRoi });
      if (noseRoi)  noseSamples.current.push({ t, ...noseRoi });
      if (mouthRoi) mouthSamples.current.push({ t, ...mouthRoi });
      if (chestRoi) chestSamples.current.push({ t, ...chestRoi });

      // Trim old samples
      const cutoff = t - SAMPLE_WINDOW_MS;
      faceSamples.current  = faceSamples.current.filter(s => s.t > cutoff);
      noseSamples.current  = noseSamples.current.filter(s => s.t > cutoff);
      mouthSamples.current = mouthSamples.current.filter(s => s.t > cutoff);
      chestSamples.current = chestSamples.current.filter(s => s.t > cutoff);

      // ── Calibration counter ──
      frameCountRef.current++;
      const fc = frameCountRef.current;

      if (phaseRef.current === "calibrating") {
        const progress = Math.min(1, fc / CALIB_FRAMES);

        // Update calibration bar DOM directly
        if (calibBarRef.current) {
          calibBarRef.current.style.width = `${Math.round(progress * 100)}%`;
        }
        if (calibTextRef.current) {
          calibTextRef.current.textContent = `キャリブレーション ${Math.round(progress * 100)}%`;
        }

        // Draw guide oval
        drawGuide(ctx, progress);

        if (fc >= CALIB_FRAMES) {
          phaseRef.current = "measuring";
          if (statusDomRef.current) {
            statusDomRef.current.textContent = "計測中";
          }
        }
        return; // Don't analyze yet during calibration
      }

      // ── Measuring phase ──
      // Use fftWinRef.current frames for BPM analysis window
      const winLen = fftWinRef.current;
      const allFace  = faceSamples.current.map(s => s.g);
      const allNose  = noseSamples.current.map(s => s.g);
      const allMouth = mouthSamples.current.map(s => s.g);
      const allChest = chestSamples.current.map(s => s.g);

      // Slice to FFT window length
      const faceSignal  = allFace.slice(-winLen);
      const noseSignal  = allNose.slice(-winLen);
      const mouthSignal = allMouth.slice(-winLen);
      const chestSignal = allChest.slice(-winLen);

      // Primary breath signal: face green channel
      const breathSignal = faceSignal.length > 0 ? faceSignal : chestSignal;
      const filtered = bandpassBreath(breathSignal);
      const latest = filtered[filtered.length - 1] ?? 0;
      smoothBreath.current += (latest - smoothBreath.current) * 0.15;
      const breathVal = smoothBreath.current;

      // BPM (only update when we have enough samples)
      if (breathSignal.length >= 60) {
        const bpm = estimateBPM(breathSignal, TARGET_FPS);
        const clampedBpm = bpm < 4 || bpm > 40 ? bpmRef.current : bpm;
        bpmRef.current = clampedBpm;
      }

      // Depth (peak-to-peak of filtered signal)
      const depth = peakToPeak(filtered.slice(-60));
      depthRef.current = depth;

      // Nasal vs oral: compare nose signal amplitude vs mouth signal amplitude
      const noseAmp  = peakToPeak(bandpassBreath(noseSignal).slice(-60));
      const mouthAmp = peakToPeak(bandpassBreath(mouthSignal).slice(-60));
      if (noseAmp > 0 || mouthAmp > 0) {
        const ratio = noseAmp / (noseAmp + mouthAmp + 0.001);
        modeRef.current = ratio > 0.55 ? "鼻呼吸" : ratio < 0.35 ? "口呼吸" : "混合";
      }

      // Waveform
      const wf = filtered.slice(-WAVEFORM_LEN);
      // Normalize
      const wfMax = Math.max(...wf.map(Math.abs), 0.001);
      waveformRef.current = wf.map(v => v / wfMax);

      // ── Update DOM directly ──
      const clampedBpm = bpmRef.current;
      if (bpmDomRef.current)        bpmDomRef.current.textContent        = clampedBpm > 0 ? `${clampedBpm}` : "--";
      if (depthDomRef.current)      depthDomRef.current.textContent      = depth > 0 ? `${Math.round(depth * 100) / 100}` : "--";
      if (modeDomRef.current)       modeDomRef.current.textContent       = modeRef.current;
      if (sampleCountDomRef.current) sampleCountDomRef.current.textContent = `${breathSignal.length} / ${winLen}`;

      // ── EVM overlay ──
      drawBreathOverlay(ctx, breathVal);

      // ── Waveform ──
      drawWaveform(waveformRef.current);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, []); // ← empty dependency array: runs once only

  // ── Start camera ────────────────────────────────────────────────────────
  async function startCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width:  { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();

      // Reset state
      frameCountRef.current = 0;
      faceSamples.current   = [];
      noseSamples.current   = [];
      mouthSamples.current  = [];
      chestSamples.current  = [];
      waveformRef.current   = [];
      smoothBreath.current  = 0;
      bpmRef.current        = 0;
      phaseRef.current      = "calibrating";

      setIsRunning(true);
    } catch (e) {
      setError("カメラにアクセスできませんでした。許可を確認してください。");
      console.error(e);
    }
  }

  // ── Stop camera ──────────────────────────────────────────────────────────
  function stopCamera() {
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    phaseRef.current = "idle";
    frameCountRef.current = 0;
    setIsRunning(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center w-full max-w-lg mx-auto px-4 py-6 gap-4">

      {/* Header */}
      <div className="text-center mb-2">
        <p className="text-xs tracking-[0.25em] text-cyan-400 font-mono mb-1">BIO-LAB NOIR</p>
        <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
          Face Breath
        </h1>
        <p className="text-sm text-gray-400 mt-1">カメラで顔・鼻孔・胸部の動きから呼吸をリアルタイム推定</p>
      </div>

      {/* Camera canvas */}
      <div className="relative w-full rounded-xl overflow-hidden border border-cyan-900/40"
           style={{ aspectRatio: "4/3", background: "#0a0f1a" }}>

        {/* Hidden video element — feeds canvas */}
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />

        {/* Display canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
        />

        {/* Idle overlay */}
        {!isRunning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3"
               style={{ background: "rgba(5,10,20,0.85)" }}>
            <div className="text-4xl">🫁</div>
            <p className="text-gray-400 text-sm text-center px-4">
              「計測開始」を押してカメラを起動<br/>
              顔全体と胸・肩が映るよう距離を調整
            </p>
          </div>
        )}

        {/* Calibration bar */}
        {isRunning && (
          <div className="absolute bottom-0 left-0 right-0 px-3 pb-3">
            <div className="flex justify-between items-center mb-1">
              <span ref={calibTextRef} className="text-xs font-mono text-cyan-400">
                キャリブレーション 0%
              </span>
              <span ref={statusDomRef} className="text-xs font-mono text-gray-500">
                キャリブレーション中
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full" style={{ background: "rgba(0,220,255,0.15)" }}>
              <div
                ref={calibBarRef}
                className="h-full rounded-full transition-none"
                style={{ width: "0%", background: "linear-gradient(90deg, #00dcff, #00ffb4)" }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="w-full rounded-lg px-4 py-3 text-sm text-red-400 border border-red-900/50"
             style={{ background: "rgba(255,50,50,0.08)" }}>
          {error}
        </div>
      )}

      {/* Start / Stop button */}
      <button
        onClick={isRunning ? stopCamera : startCamera}
        className="w-full py-3 rounded-xl font-bold text-sm tracking-widest font-mono transition-all"
        style={{
          background: isRunning
            ? "rgba(255,60,60,0.15)"
            : "linear-gradient(135deg, #00dcff22, #00ffb422)",
          border: isRunning ? "1px solid rgba(255,60,60,0.4)" : "1px solid rgba(0,220,255,0.4)",
          color: isRunning ? "#ff6060" : "#00dcff",
        }}
      >
        {isRunning ? "■ 計測停止" : "▶ 計測開始"}
      </button>

      {/* Results grid */}
      <div className="w-full grid grid-cols-3 gap-3">
        {/* BPM */}
        <div className="rounded-xl p-4 text-center" style={{ background: "rgba(0,220,255,0.06)", border: "1px solid rgba(0,220,255,0.15)" }}>
          <p className="text-xs text-gray-500 font-mono mb-1">呼吸数</p>
          <p className="text-2xl font-bold text-cyan-400 font-mono">
            <span ref={bpmDomRef}>--</span>
          </p>
          <p className="text-xs text-gray-600 font-mono">BPM</p>
        </div>

        {/* Mode */}
        <div className="rounded-xl p-4 text-center" style={{ background: "rgba(0,220,255,0.06)", border: "1px solid rgba(0,220,255,0.15)" }}>
          <p className="text-xs text-gray-500 font-mono mb-1">呼吸モード</p>
          <p className="text-sm font-bold text-cyan-300 font-mono mt-1">
            <span ref={modeDomRef}>--</span>
          </p>
          <p className="text-xs text-gray-600 font-mono mt-1">鼻/口</p>
        </div>

        {/* Depth */}
        <div className="rounded-xl p-4 text-center" style={{ background: "rgba(0,220,255,0.06)", border: "1px solid rgba(0,220,255,0.15)" }}>
          <p className="text-xs text-gray-500 font-mono mb-1">呼吸深さ</p>
          <p className="text-2xl font-bold text-cyan-400 font-mono">
            <span ref={depthDomRef}>--</span>
          </p>
          <p className="text-xs text-gray-600 font-mono">振幅</p>
        </div>
      </div>

      {/* Waveform */}
      <div className="w-full rounded-xl overflow-hidden" style={{ background: "rgba(0,10,20,0.8)", border: "1px solid rgba(0,220,255,0.12)" }}>
        <p className="text-xs text-gray-600 font-mono px-3 pt-2">BREATH WAVEFORM</p>
        <canvas ref={waveRef} className="w-full" style={{ height: 80 }} />
      </div>

      {/* FFT Window Slider — placed prominently before start button */}
      <div className="w-full rounded-xl px-4 pt-4 pb-3"
           style={{ background: "rgba(0,220,255,0.07)", border: "2px solid rgba(0,220,255,0.25)" }}>

        {/* Label row */}
        <div className="flex justify-between items-center mb-1">
          <span className="text-sm font-bold font-mono" style={{ color: "#00dcff" }}>
            FFT Window
          </span>
          <span className="text-base font-bold font-mono" style={{ color: "#00ffb4" }}>
            {fftWinDisplay} frames &nbsp;({(fftWinDisplay / TARGET_FPS).toFixed(1)} s)
          </span>
        </div>

        {/* Native range — iOS Safari safe */}
        <input
          type="range"
          min={FFT_WIN_MIN}
          max={FFT_WIN_MAX}
          step={10}
          defaultValue={FFT_WIN_DEFAULT}
          className="breath-slider"
          onChange={(e) => {
            const v = Number(e.target.value);
            fftWinRef.current = v;
            setFftWinDisplay(v);
          }}
        />

        {/* Range labels */}
        <div className="flex justify-between -mt-1">
          <span className="text-xs text-gray-500 font-mono">{FFT_WIN_MIN}f / {(FFT_WIN_MIN/TARGET_FPS).toFixed(0)}s</span>
          <span className="text-xs text-gray-500 font-mono">{FFT_WIN_MAX}f / {(FFT_WIN_MAX/TARGET_FPS).toFixed(0)}s</span>
        </div>

        {/* Live sample counter */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-500 font-mono">サンプル数:</span>
          <span ref={sampleCountDomRef} className="text-xs font-bold font-mono" style={{ color: "#00dcff" }}>
            -- / {fftWinDisplay}
          </span>
          <span className="text-xs text-gray-600 font-mono ml-auto">不安定なら大きく</span>
        </div>
      </div>

      {/* Info */}
      <div className="w-full text-xs text-gray-600 font-mono text-center leading-relaxed">
        顔全体が映るよう距離を調整してください。<br/>
        胸・肩も映ると呼吸の深さ推定精度が向上します。<br/>
        <span className="text-cyan-900">BPM が不安定な場合はウィンドウ長を増やしてください。</span>
      </div>
    </div>
  );
}

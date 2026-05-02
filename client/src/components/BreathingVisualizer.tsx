/*
 * BreathingVisualizer — Bio-Lab Noir, Respiratory Edition
 *
 * Implements video-based respiratory monitoring with EVM-style amplification:
 *
 * ROI-based signal extraction:
 *   - Face ROI: Cg channel (YCgCo) for primary respiratory signal
 *     (Park & Hong 2023, Chen et al. 2019)
 *   - Nose ROI: FaceMesh landmarks #2/#326 region brightness
 *     (Nhan & Chung 2020)
 *   - Mouth ROI: FaceMesh landmarks #13/#14 region for oral breathing
 *     (Huang et al. 2021)
 *   - Chest ROI: Lower camera region luminance for chest motion
 *     (Wu et al. 2012 EVM, Mattioli et al. 2023)
 *
 * EVM amplification modes (Wu et al. 2012, Wadhwa et al. 2013):
 *   SUBTLE  : Nose/mouth overlay with soft cyan/amber glow
 *   VIVID   : Full-face + chest region pulsing with breath cycle
 *   EXTREME : Per-pixel luminance shift on face + chest expansion visualization
 *
 * Nasal/oral classification (Huang et al. 2021):
 *   Compare respiratory signal power between nose ROI and mouth ROI.
 *   Mouth openness from landmark distance as additional cue.
 *
 * Breathing depth (Fei & Pavlidis 2010):
 *   Peak-to-peak amplitude of filtered respiratory waveform.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BreathingProcessor, type BreathingResult } from "@/lib/breathing";

// ── MediaPipe FaceMesh landmark indices ──────────────────────────────────────
// Nose tip: 1, Left nostril base: 2, Right nostril base: 326
// Upper lip center: 13, Lower lip center: 14
// Left nose wing: 64, Right nose wing: 294
// Nose bridge: 6, Philtrum: 164
const NOSE_LANDMARKS = [1, 2, 4, 5, 6, 19, 20, 94, 97, 98, 99, 102, 129, 131, 168, 195, 197, 326, 327, 358];
const MOUTH_LANDMARKS = [0, 13, 14, 17, 37, 39, 40, 61, 84, 87, 88, 91, 178, 181, 267, 269, 270, 291, 308, 311, 312, 314, 317, 402, 405];
const UPPER_LIP = 13;
const LOWER_LIP = 14;

// ── EVM amplification modes ──────────────────────────────────────────────────
type ModeId = "subtle" | "vivid" | "extreme";

interface ModeSpec {
  id: ModeId;
  label: string;
  caption: string;
  ampScale: number;
  inhaleRgb: [number, number, number];  // inhale phase color
  exhaleRgb: [number, number, number];  // exhale phase color
}

const MODES: ModeSpec[] = [
  {
    id: "subtle",
    label: "SUBTLE",
    caption: "控えめモード — 鼻孔・口周辺のみ柔らかく増幅",
    ampScale: 1.0,
    inhaleRgb: [61, 250, 255],   // cyan
    exhaleRgb: [255, 200, 50],   // amber
  },
  {
    id: "vivid",
    label: "VIVID",
    caption: "派手モード — 顔全体と胸部が呼吸と同期して脈動",
    ampScale: 3.0,
    inhaleRgb: [40, 220, 200],   // teal
    exhaleRgb: [255, 160, 30],   // warm amber
  },
  {
    id: "extreme",
    label: "EXTREME",
    caption: "超派手モード — ピクセル単位で呼吸変化を増幅",
    ampScale: 6.0,
    inhaleRgb: [0, 255, 200],    // bright teal
    exhaleRgb: [255, 120, 0],    // deep orange
  },
];

// ── constants ────────────────────────────────────────────────────────────────
const WAVEFORM_POINTS = 200;
const TARGET_FPS = 30;
const FX_W = 240;
const FX_H = 180;

type Phase = "idle" | "calibrating" | "measuring" | "error";

// ── FaceMesh loader ──────────────────────────────────────────────────────────
declare global {
  interface Window {
    FaceMesh: unknown;
  }
}

interface FaceMeshResults {
  multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
}

// ── component ────────────────────────────────────────────────────────────────
export default function BreathingVisualizer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const processorRef = useRef(new BreathingProcessor(20));
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const vignetteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smoothBreathRef = useRef<number>(0);
  const lastBreathPhaseRef = useRef<number>(0);
  const faceMeshRef = useRef<unknown>(null);
  const landmarksRef = useRef<Array<{ x: number; y: number; z: number }> | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<BreathingResult | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [vignetteActive, setVignetteActive] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [ampLevel, setAmpLevel] = useState(5);
  const [modeId, setModeId] = useState<ModeId>("vivid");
  const [faceMeshReady, setFaceMeshReady] = useState(false);

  const mode = useMemo(() => MODES.find((m) => m.id === modeId) ?? MODES[1], [modeId]);

  // ── Load MediaPipe FaceMesh ──────────────────────────────────────────────
  useEffect(() => {
    const script1 = document.createElement("script");
    script1.src = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
    script1.crossOrigin = "anonymous";
    document.head.appendChild(script1);

    const script2 = document.createElement("script");
    script2.src = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
    script2.crossOrigin = "anonymous";
    script2.onload = () => {
      try {
        // @ts-expect-error MediaPipe global
        const fm = new window.FaceMesh({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
        });
        fm.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        fm.onResults((results: FaceMeshResults) => {
          if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            landmarksRef.current = results.multiFaceLandmarks[0];
          } else {
            landmarksRef.current = null;
          }
        });
        faceMeshRef.current = fm;
        setFaceMeshReady(true);
      } catch {
        // FaceMesh unavailable — fall back to ROI-only mode
        setFaceMeshReady(true);
      }
    };
    document.head.appendChild(script2);

    return () => {
      document.head.removeChild(script1);
      document.head.removeChild(script2);
    };
  }, []);

  // ── camera start ────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setPhase("calibrating");
    setErrorMsg("");
    processorRef.current.reset();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: TARGET_FPS, max: 60 },
        },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(`カメラを起動できませんでした: ${msg}`);
      setPhase("error");
    }
  }, []);

  // ── camera stop ─────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    processorRef.current.reset();
    setPhase("idle");
    setResult(null);
    setSampleCount(0);
    setWaveformData([]);
    smoothBreathRef.current = 0;
    landmarksRef.current = null;
  }, []);

  // ── helper: sample ROI from canvas ──────────────────────────────────────
  const sampleROI = useCallback(
    (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
      const cw = ctx.canvas.width;
      const ch = ctx.canvas.height;
      const rx = Math.max(0, Math.floor(x * cw));
      const ry = Math.max(0, Math.floor(y * ch));
      const rw = Math.max(1, Math.min(Math.floor(w * cw), cw - rx));
      const rh = Math.max(1, Math.min(Math.floor(h * ch), ch - ry));
      try {
        const data = ctx.getImageData(rx, ry, rw, rh).data;
        let r = 0, g = 0, b = 0;
        const n = rw * rh;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2];
        }
        return { r: r / n, g: g / n, b: b / n };
      } catch {
        return null;
      }
    },
    []
  );

  // ── EVM amplification: draw breath-amplified overlay ────────────────────
  const drawBreathAmplification = useCallback(
    (
      displayCtx: CanvasRenderingContext2D,
      breathVal: number, // -1..1
      dw: number,
      dh: number,
      vw: number,
      vh: number,
    ) => {
      const amp = (ampLevel / 5) * mode.ampScale;
      const intensity = Math.abs(breathVal) * amp * 0.15;
      const isInhale = breathVal > 0;
      const [tr, tg, tb] = isInhale ? mode.inhaleRgb : mode.exhaleRgb;

      if (modeId === "subtle") {
        // Soft glow around nose/mouth area
        const cx = dw / 2;
        const cy = dh * 0.55;
        const grad = displayCtx.createRadialGradient(cx, cy, 0, cx, cy, dw * 0.35);
        grad.addColorStop(0, `rgba(${tr},${tg},${tb},${intensity * 0.5})`);
        grad.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
        displayCtx.globalCompositeOperation = "screen";
        displayCtx.fillStyle = grad;
        displayCtx.fillRect(0, 0, dw, dh);
        displayCtx.globalCompositeOperation = "source-over";

      } else if (modeId === "vivid") {
        // Full face + chest area pulsing
        const cx = dw / 2;
        const cy = dh * 0.45;
        const grad = displayCtx.createRadialGradient(cx, cy, 0, cx, cy, dw * 0.65);
        grad.addColorStop(0, `rgba(${tr},${tg},${tb},${intensity * 0.6})`);
        grad.addColorStop(0.6, `rgba(${tr},${tg},${tb},${intensity * 0.25})`);
        grad.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
        displayCtx.globalCompositeOperation = "screen";
        displayCtx.fillStyle = grad;
        displayCtx.fillRect(0, 0, dw, dh);

        // Chest area (lower portion)
        const chestGrad = displayCtx.createRadialGradient(cx, dh * 0.82, 0, cx, dh * 0.82, dw * 0.4);
        chestGrad.addColorStop(0, `rgba(${tr},${tg},${tb},${intensity * 0.4})`);
        chestGrad.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
        displayCtx.fillStyle = chestGrad;
        displayCtx.fillRect(0, dh * 0.6, dw, dh * 0.4);
        displayCtx.globalCompositeOperation = "source-over";

        // Screen wash
        displayCtx.globalCompositeOperation = "soft-light";
        displayCtx.fillStyle = `rgba(${tr},${tg},${tb},${intensity * 0.12})`;
        displayCtx.fillRect(0, 0, dw, dh);
        displayCtx.globalCompositeOperation = "source-over";

      } else if (modeId === "extreme") {
        // Per-pixel luminance shift using offscreen FX canvas
        if (!fxCanvasRef.current) {
          const c = document.createElement("canvas");
          c.width = FX_W; c.height = FX_H;
          fxCanvasRef.current = c;
        }
        const fxCtx = fxCanvasRef.current.getContext("2d")!;
        fxCtx.drawImage(videoRef.current!, 0, 0, FX_W, FX_H);
        const imgData = fxCtx.getImageData(0, 0, FX_W, FX_H);
        const d = imgData.data;
        const mixStrength = Math.min(0.85, intensity * 1.5);

        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // Skin-tone heuristic: R > G > B and reasonable brightness
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (r > g && g > b && lum > 40 && lum < 220 && r / (g + 1) > 1.05) {
            d[i]     = Math.round(r + (tr - r) * mixStrength);
            d[i + 1] = Math.round(g + (tg - g) * mixStrength);
            d[i + 2] = Math.round(b + (tb - b) * mixStrength);
          }
        }
        fxCtx.putImageData(imgData, 0, 0);

        displayCtx.globalCompositeOperation = "lighter";
        displayCtx.globalAlpha = intensity * 0.7;
        displayCtx.drawImage(fxCanvasRef.current, 0, 0, dw, dh);
        displayCtx.globalAlpha = 1;
        displayCtx.globalCompositeOperation = "source-over";

        // Full screen tint
        displayCtx.globalCompositeOperation = "screen";
        displayCtx.fillStyle = `rgba(${tr},${tg},${tb},${intensity * 0.18})`;
        displayCtx.fillRect(0, 0, dw, dh);
        displayCtx.globalCompositeOperation = "source-over";
      }

      // ── Landmark overlays ──────────────────────────────────────────────
      const lm = landmarksRef.current;
      if (lm && lm.length > 400) {
        // Draw nose ROI highlight
        const nosePts = NOSE_LANDMARKS.map(i => lm[i]).filter(Boolean);
        if (nosePts.length > 0) {
          const noseColor = isInhale
            ? `rgba(61,250,255,${0.15 + intensity * 0.5})`
            : `rgba(255,200,50,${0.1 + intensity * 0.3})`;
          displayCtx.beginPath();
          nosePts.forEach((p, idx) => {
            const px = (1 - p.x) * dw; // mirror
            const py = p.y * dh;
            if (idx === 0) displayCtx.moveTo(px, py);
            else displayCtx.lineTo(px, py);
          });
          displayCtx.closePath();
          displayCtx.fillStyle = noseColor;
          displayCtx.fill();
          displayCtx.strokeStyle = isInhale ? `rgba(61,250,255,${0.4 + intensity * 0.4})` : `rgba(255,200,50,${0.3 + intensity * 0.3})`;
          displayCtx.lineWidth = 1.5;
          displayCtx.stroke();
        }

        // Draw mouth ROI highlight
        const mouthPts = MOUTH_LANDMARKS.map(i => lm[i]).filter(Boolean);
        if (mouthPts.length > 0) {
          const mouthColor = `rgba(255,160,30,${0.08 + intensity * 0.3})`;
          displayCtx.beginPath();
          mouthPts.forEach((p, idx) => {
            const px = (1 - p.x) * dw;
            const py = p.y * dh;
            if (idx === 0) displayCtx.moveTo(px, py);
            else displayCtx.lineTo(px, py);
          });
          displayCtx.closePath();
          displayCtx.fillStyle = mouthColor;
          displayCtx.fill();
        }
      }
    },
    [ampLevel, mode, modeId]
  );

  // ── draw waveform ────────────────────────────────────────────────────────
  const drawWaveform = useCallback(
    (waveData: number[], breathVal: number) => {
      const canvas = waveCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (waveData.length < 2) return;

      const isInhale = breathVal > 0;
      const waveColor = isInhale ? "#3dfaff" : "#ffc832";
      const glowColor = isInhale ? "rgba(61,250,255,0.4)" : "rgba(255,200,50,0.4)";

      // Grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Zero line
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      ctx.setLineDash([]);

      // Waveform glow
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = waveColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = w / (waveData.length - 1);
      waveData.forEach((v, i) => {
        const x = i * step;
        const y = h / 2 - (v * h * 0.42);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
    []
  );

  // ── main render loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    const displayCanvas = displayCanvasRef.current;
    const waveCanvas = waveCanvasRef.current;
    if (!video || !displayCanvas || !waveCanvas) return;
    if (phase === "idle" || phase === "error") {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    let frameCount = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      if (now - lastFrameRef.current < 1000 / TARGET_FPS) return;
      lastFrameRef.current = now;
      if (video.readyState < 2) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      // Ensure sample canvas
      if (!sampleCanvasRef.current || sampleCanvasRef.current.width !== vw) {
        const c = document.createElement("canvas");
        c.width = vw; c.height = vh;
        sampleCanvasRef.current = c;
      }

      // Sync display canvas
      const rect = displayCanvas.getBoundingClientRect();
      const targetW = Math.floor(rect.width) || vw;
      const targetH = Math.floor(rect.height) || vh;
      if (displayCanvas.width !== targetW || displayCanvas.height !== targetH) {
        displayCanvas.width = targetW;
        displayCanvas.height = targetH;
      }

      const sCtx = sampleCanvasRef.current.getContext("2d", { willReadFrequently: true });
      if (!sCtx) return;
      sCtx.drawImage(video, 0, 0, vw, vh);

      const t = now;

      // ── FaceMesh processing (every 2nd frame for performance) ──
      if (frameCount % 2 === 0 && faceMeshRef.current) {
        try {
          // @ts-expect-error MediaPipe
          faceMeshRef.current.send({ image: video }).catch(() => {});
        } catch {}
      }
      frameCount++;

      // ── ROI sampling ──────────────────────────────────────────────────
      const lm = landmarksRef.current;

      // Face ROI: center 55% of frame (forehead + cheeks)
      const faceRoi = sampleROI(sCtx, 0.225, 0.1, 0.55, 0.55);
      if (faceRoi) processorRef.current.pushFace({ t, ...faceRoi });

      // Nose ROI: from landmarks or fixed position
      let noseRoi = null;
      if (lm && lm.length > 400) {
        const noseTip = lm[1];
        const noseBase = lm[2];
        const noseW = 0.12, noseH = 0.1;
        noseRoi = sampleROI(sCtx,
          Math.max(0, (1 - noseTip.x) - noseW / 2),
          Math.max(0, noseTip.y - noseH * 0.3),
          noseW, noseH
        );
      } else {
        noseRoi = sampleROI(sCtx, 0.4, 0.42, 0.2, 0.12);
      }
      if (noseRoi) processorRef.current.pushNose({ t, ...noseRoi });

      // Mouth ROI: from landmarks or fixed position
      let mouthRoi = null;
      if (lm && lm.length > 400) {
        const upperLip = lm[UPPER_LIP];
        const lowerLip = lm[LOWER_LIP];
        const mouthW = 0.18, mouthH = 0.1;
        mouthRoi = sampleROI(sCtx,
          Math.max(0, (1 - upperLip.x) - mouthW / 2),
          Math.max(0, upperLip.y - 0.01),
          mouthW, mouthH
        );
        // Landmark sample for mouth openness
        processorRef.current.pushLandmark({
          t,
          upperLipY: upperLip.y,
          lowerLipY: lowerLip.y,
          noseTipY: lm[1].y,
          leftNostrilY: lm[2].y,
          rightNostrilY: lm[326]?.y ?? lm[2].y,
        });
      } else {
        mouthRoi = sampleROI(sCtx, 0.38, 0.56, 0.24, 0.1);
      }
      if (mouthRoi) processorRef.current.pushMouth({ t, ...mouthRoi });

      // Chest ROI: lower 30% of frame
      const chestRoi = sampleROI(sCtx, 0.2, 0.7, 0.6, 0.25);
      if (chestRoi) processorRef.current.pushChest({ t, ...chestRoi });

      const count = processorRef.current.faceCount;
      setSampleCount(count);

      // ── Analyze ──────────────────────────────────────────────────────
      const CALIBRATION_SAMPLES = 180; // ~6 seconds at 30fps
      if (count >= CALIBRATION_SAMPLES && phase === "calibrating") {
        setPhase("measuring");
      }

      let currentResult: BreathingResult | null = null;
      if (phase === "measuring" || count > CALIBRATION_SAMPLES) {
        currentResult = processorRef.current.analyze();
        if (currentResult) {
          setResult(currentResult);

          // Waveform update
          const wf = currentResult.waveform.slice(-WAVEFORM_POINTS);
          setWaveformData(wf);

          // Breath cycle vignette
          const currentPhase = currentResult.phase;
          const prevPhase = lastBreathPhaseRef.current;
          if (prevPhase < 0 && currentPhase >= 0 && Math.abs(currentPhase - prevPhase) > 1) {
            if (vignetteTimerRef.current) clearTimeout(vignetteTimerRef.current);
            setVignetteActive(true);
            vignetteTimerRef.current = setTimeout(() => setVignetteActive(false), 800);
          }
          lastBreathPhaseRef.current = currentPhase;
        }
      }

      // ── Smooth breath value for animation ────────────────────────────
      const rawBreath = processorRef.current.getInstantaneousValue();
      smoothBreathRef.current += (rawBreath - smoothBreathRef.current) * 0.12;
      const breathVal = smoothBreathRef.current;

      // ── Draw display canvas ───────────────────────────────────────────
      const dCtx = displayCanvas.getContext("2d");
      if (!dCtx) return;
      const dw = displayCanvas.width;
      const dh = displayCanvas.height;

      // Mirror video
      dCtx.save();
      dCtx.scale(-1, 1);
      dCtx.drawImage(video, -dw, 0, dw, dh);
      dCtx.restore();

      // EVM amplification overlay
      drawBreathAmplification(dCtx, breathVal, dw, dh, vw, vh);

      // Waveform
      const wf = currentResult?.waveform.slice(-WAVEFORM_POINTS) ?? waveformData;
      drawWaveform(wf, breathVal);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, drawBreathAmplification, drawWaveform, sampleROI, waveformData]);

  // ── Breathing mode display helpers ──────────────────────────────────────
  const breathingModeLabel = (mode: string) => {
    switch (mode) {
      case "nasal": return { label: "鼻呼吸", color: "text-emerald-400", glow: "glow-green" };
      case "oral": return { label: "口呼吸", color: "text-amber-400", glow: "glow-amber" };
      case "mixed": return { label: "混合", color: "text-cyan-400", glow: "glow-cyan" };
      default: return { label: "判定中", color: "text-gray-400", glow: "" };
    }
  };

  const modeInfo = result ? breathingModeLabel(result.breathingMode) : breathingModeLabel("unknown");

  // ── Calibration progress ─────────────────────────────────────────────────
  const calibProgress = Math.min(100, (sampleCount / 180) * 100);

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full bg-background overflow-hidden select-none">
      {/* Hidden video element */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none"
        playsInline
        muted
        autoPlay
      />

      {/* Display canvas — full screen */}
      <canvas
        ref={displayCanvasRef}
        className={`absolute inset-0 w-full h-full object-cover scanlines ${vignetteActive ? "breath-vignette" : ""}`}
        style={{ display: phase === "idle" || phase === "error" ? "none" : "block" }}
      />

      {/* Grain overlay */}
      {(phase === "measuring" || phase === "calibrating") && (
        <div className="absolute inset-0 pointer-events-none grain" />
      )}

      {/* Scan line animation during calibration */}
      {phase === "calibrating" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="scan-line" />
        </div>
      )}

      {/* ── IDLE STATE ──────────────────────────────────────────────────── */}
      {phase === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 px-6">
          {/* Title */}
          <div className="text-center">
            <div className="hud-label text-primary mb-2">BIO-LAB NOIR</div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-sans)" }}>
              Face Breath
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-xs">
              カメラで顔・鼻孔・胸部の動きから呼吸をリアルタイム推定
            </p>
          </div>

          {/* Feature list */}
          <div className="hud-panel rounded-lg p-4 w-full max-w-sm space-y-2">
            {[
              { icon: "◈", label: "呼吸数 (BPM)", desc: "顔ROI rPPG + FFT解析" },
              { icon: "◉", label: "鼻/口呼吸判別", desc: "FaceMesh ROI比較" },
              { icon: "◎", label: "呼吸の深さ", desc: "Peak-to-peak振幅" },
              { icon: "◆", label: "EVM映像増幅", desc: "呼吸変化を派手に可視化" },
            ].map((f) => (
              <div key={f.label} className="flex items-center gap-3">
                <span className="text-primary text-lg w-6 text-center">{f.icon}</span>
                <div>
                  <div className="text-xs font-medium text-foreground">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Start button */}
          <button
            onClick={startCamera}
            className="relative px-8 py-4 rounded-lg font-semibold text-primary-foreground overflow-hidden transition-all active:scale-95"
            style={{
              background: "oklch(0.78 0.16 200)",
              boxShadow: "0 0 20px rgba(61,250,255,0.4), 0 0 40px rgba(61,250,255,0.2)",
              fontFamily: "var(--font-sans)",
            }}
          >
            <span className="relative z-10 tracking-wider uppercase text-sm font-bold">計測開始</span>
          </button>

          <p className="text-xs text-muted-foreground text-center max-w-xs">
            顔全体が映るよう距離を調整してください。<br />
            胸・肩も映ると呼吸の深さ推定精度が向上します。
          </p>
        </div>
      )}

      {/* ── ERROR STATE ─────────────────────────────────────────────────── */}
      {phase === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-6">
          <div className="hud-panel rounded-lg p-6 max-w-sm text-center">
            <div className="text-destructive text-2xl mb-3">⚠</div>
            <p className="text-sm text-foreground mb-4">{errorMsg}</p>
            <button
              onClick={startCamera}
              className="px-6 py-2 rounded text-sm font-medium text-primary-foreground"
              style={{ background: "oklch(0.78 0.16 200)" }}
            >
              再試行
            </button>
          </div>
        </div>
      )}

      {/* ── CALIBRATION OVERLAY ─────────────────────────────────────────── */}
      {phase === "calibrating" && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-4 px-6">
          <div className="hud-panel rounded-lg px-6 py-4 text-center">
            <div className="hud-label text-primary mb-2">CALIBRATING</div>
            <p className="text-xs text-muted-foreground mb-3">
              顔を枠内に収めて静止してください
            </p>
            <div className="w-48 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${calibProgress}%`,
                  background: "oklch(0.78 0.16 200)",
                  boxShadow: "0 0 8px rgba(61,250,255,0.6)",
                }}
              />
            </div>
            <div className="hud-numeric text-xs text-muted-foreground mt-1">
              {Math.round(calibProgress)}%
            </div>
          </div>
        </div>
      )}

      {/* ── HUD OVERLAY (measuring) ─────────────────────────────────────── */}
      {(phase === "measuring" || (phase === "calibrating" && sampleCount > 60)) && (
        <>
          {/* Top status bar */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 pt-safe-top"
            style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
            <div className="hud-panel rounded px-3 py-1 flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${phase === "measuring" ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
              <span className="hud-label">{phase === "measuring" ? "MEASURING" : "CALIBRATING"}</span>
            </div>
            {result && (
              <div className="hud-panel rounded px-3 py-1">
                <span className="hud-label text-muted-foreground">SNR </span>
                <span className="hud-numeric text-xs text-primary">{result.snr.toFixed(1)} dB</span>
              </div>
            )}
          </div>

          {/* Left side: BPM + breathing mode */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col gap-3">
            <div className="hud-panel rounded-lg px-4 py-3">
              <div className="hud-label text-muted-foreground">RESP RATE</div>
              <div className={`hud-numeric text-5xl font-bold leading-none mt-1 ${result ? "text-primary glow-cyan" : "text-muted-foreground"}`}>
                {result ? Math.round(result.bpm) : "--"}
              </div>
              <div className="hud-label text-muted-foreground mt-1">BPM</div>
            </div>

            <div className="hud-panel rounded-lg px-4 py-3">
              <div className="hud-label text-muted-foreground">MODE</div>
              <div className={`text-sm font-bold mt-1 ${modeInfo.color} ${modeInfo.glow}`}>
                {modeInfo.label}
              </div>
            </div>

            <div className="hud-panel rounded-lg px-4 py-3">
              <div className="hud-label text-muted-foreground">DEPTH</div>
              <div className="flex items-end gap-1 mt-1">
                <div className="hud-numeric text-2xl font-bold text-accent glow-amber">
                  {result ? Math.round(result.depth * 100) : "--"}
                </div>
                <div className="hud-label text-muted-foreground mb-1">%</div>
              </div>
            </div>
          </div>

          {/* Right side: waveform + confidence */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-3">
            <div className="hud-panel rounded-lg p-2" style={{ width: 120 }}>
              <div className="hud-label text-muted-foreground mb-1">WAVEFORM</div>
              <canvas
                ref={waveCanvasRef}
                width={112}
                height={60}
                className="block"
              />
            </div>

            {result && (
              <div className="hud-panel rounded-lg px-3 py-2">
                <div className="hud-label text-muted-foreground">CONF</div>
                <div className="hud-numeric text-lg font-bold text-primary mt-1">
                  {Math.round(result.confidence * 100)}%
                </div>
              </div>
            )}

            {result && (
              <div className="hud-panel rounded-lg px-3 py-2">
                <div className="hud-label text-muted-foreground">NASAL</div>
                <div className="hud-numeric text-sm font-bold text-emerald-400 mt-0.5">
                  {Math.round(result.nasalPower * 100)}%
                </div>
                <div className="hud-label text-muted-foreground mt-1">ORAL</div>
                <div className="hud-numeric text-sm font-bold text-amber-400 mt-0.5">
                  {Math.round(result.oralPower * 100)}%
                </div>
              </div>
            )}
          </div>

          {/* Bottom controls */}
          <div
            className="absolute left-0 right-0 flex flex-col gap-3 px-4"
            style={{ bottom: "max(env(safe-area-inset-bottom), 16px)", paddingBottom: 8 }}
          >
            {/* Mode selector */}
            <div className="flex gap-2 justify-center">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setModeId(m.id)}
                  className={`hud-panel rounded px-3 py-1.5 transition-all ${modeId === m.id ? "border-primary" : "border-border"}`}
                  style={modeId === m.id ? { borderColor: "oklch(0.78 0.16 200)", boxShadow: "0 0 8px rgba(61,250,255,0.3)" } : {}}
                >
                  <span className={`hud-label ${modeId === m.id ? "text-primary" : "text-muted-foreground"}`}>
                    {m.label}
                  </span>
                </button>
              ))}
            </div>

            {/* AMP slider + stop */}
            <div className="flex items-center gap-3">
              <div className="hud-panel rounded px-3 py-2 flex-1 flex items-center gap-3">
                <span className="hud-label text-muted-foreground shrink-0">AMP</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={ampLevel}
                  onChange={(e) => setAmpLevel(Number(e.target.value))}
                  className="flex-1 h-1 accent-primary"
                  style={{ accentColor: "oklch(0.78 0.16 200)" }}
                />
                <span className="hud-numeric text-xs text-primary w-4 text-right">{ampLevel}</span>
              </div>
              <button
                onClick={stopCamera}
                className="hud-panel rounded px-4 py-2 text-destructive border-destructive/40 active:scale-95 transition-transform"
              >
                <span className="hud-label">STOP</span>
              </button>
            </div>

            {/* Mode caption */}
            <div className="text-center">
              <span className="text-xs text-muted-foreground">{mode.caption}</span>
            </div>
          </div>

          {/* Nose/mouth ROI corner indicators */}
          {result && (
            <div className="absolute top-16 right-4">
              <div className="hud-panel rounded px-2 py-1">
                <div className="hud-label text-muted-foreground">MOUTH</div>
                <div className="hud-numeric text-xs text-amber-400">
                  {result.mouthOpenness > 0.02 ? "OPEN" : "CLOSED"}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

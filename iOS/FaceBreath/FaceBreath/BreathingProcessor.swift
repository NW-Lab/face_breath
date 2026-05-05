//
//  BreathingProcessor.swift
//  FaceBreath
//
//  Respiratory rate estimation from facial ROI using:
//  - RGB signal extraction from nose/chest ROI
//  - POS projection (X = G-B, Y = G+B-2R)
//  - FFT-based frequency analysis (0.1-0.5 Hz band)
//  - Breathing mode detection (nasal vs mouth breathing)
//  - Amplitude-based depth estimation
//

import Accelerate
import CoreGraphics

class BreathingProcessor {
    // Configuration
    let TARGET_FPS = 30
    let CALIBRATION_FRAMES = 150 // ~5 seconds at 30 FPS
    let FFT_WIN_DEFAULT = 300 // ~10 seconds
    let FFT_WIN_MIN = 100
    let FFT_WIN_MAX = 600
    
    // Ring buffer for RGB samples
    private var rBuffer: [Float] = []
    private var gBuffer: [Float] = []
    private var bBuffer: [Float] = []
    private let maxBufferSize = 600 * 2 // Max 20 seconds
    
    // State
    private(set) var calibrationProgress: Int = 0
    private(set) var bpm: Int = 0
    private(set) var breathingMode: String = "--" // "nasal", "mouth", "--"
    private(set) var breathingDepth: Float = 0.0
    private(set) var confidence: Float = 0.0
    private(set) var waveform: [Float] = []
    
    private var fftWindowLength = 300
    
    // MARK: - Public API
    
    func reset() {
        rBuffer.removeAll()
        gBuffer.removeAll()
        bBuffer.removeAll()
        calibrationProgress = 0
        bpm = 0
        breathingMode = "--"
        breathingDepth = 0.0
        confidence = 0.0
        waveform.removeAll()
    }
    
    func setFFTWindowLength(_ length: Int) {
        fftWindowLength = max(FFT_WIN_MIN, min(FFT_WIN_MAX, length))
    }
    
    func pushSample(r: Float, g: Float, b: Float) {
        rBuffer.append(r)
        gBuffer.append(g)
        bBuffer.append(b)
        
        // Keep buffer size bounded
        if rBuffer.count > maxBufferSize {
            rBuffer.removeFirst()
            gBuffer.removeFirst()
            bBuffer.removeFirst()
        }
        
        // Update calibration progress
        if calibrationProgress < CALIBRATION_FRAMES {
            calibrationProgress += 1
        }
    }
    
    func analyze() {
        guard rBuffer.count >= fftWindowLength else { return }
        
        // Extract last fftWindowLength samples
        let startIdx = max(0, rBuffer.count - fftWindowLength)
        let rSlice = Array(rBuffer[startIdx...])
        let gSlice = Array(gBuffer[startIdx...])
        let bSlice = Array(bBuffer[startIdx...])
        
        // POS projection: X = G - B, Y = G + B - 2R
        var posX = vDSP_vsub(bSlice, 1, gSlice, 1, [Float](repeating: 0, count: gSlice.count), 1, vDSP_Length(gSlice.count))
        var posY = [Float](repeating: 0, count: gSlice.count)
        
        for i in 0..<gSlice.count {
            posY[i] = gSlice[i] + bSlice[i] - 2 * rSlice[i]
        }
        
        // Normalize
        normalize(&posX)
        normalize(&posY)
        
        // Apply Hann window
        let hannWindow = createHannWindow(size: posX.count)
        vDSP_vmul(posX, 1, hannWindow, 1, &posX, 1, vDSP_Length(posX.count))
        vDSP_vmul(posY, 1, hannWindow, 1, &posY, 1, vDSP_Length(posY.count))
        
        // FFT
        let fftLength = vDSP_Length(posX.count)
        guard let fftSetup = vDSP_create_fftsetup(log2(Float(fftLength)), Int32(kFFTRadix2)) else { return }
        defer { vDSP_destroy_fftsetup(fftSetup) }
        
        var realX = [Float](repeating: 0, count: Int(fftLength))
        var imagX = [Float](repeating: 0, count: Int(fftLength))
        var complexX = DSPComplex(realp: &realX, imagp: &imagX)
        
        vDSP_ctoz([DSPComplex](zip(posX, posY)).map { DSPComplex(real: $0.real, imag: $0.imag) }, 2, &complexX, 1, fftLength)
        vDSP_fft_zip(fftSetup, &complexX, 1, log2(Float(fftLength)), Int32(FFT_FORWARD))
        
        // Magnitude spectrum (0.1-0.5 Hz = breathing band)
        let breathingBandStart = Int(0.1 * Float(fftLength) / Float(TARGET_FPS))
        let breathingBandEnd = Int(0.5 * Float(fftLength) / Float(TARGET_FPS))
        
        var maxMagnitude: Float = 0
        var peakFreqIdx = breathingBandStart
        
        for i in breathingBandStart..<min(breathingBandEnd, Int(fftLength) / 2) {
            let magnitude = sqrt(realX[i] * realX[i] + imagX[i] * imagX[i])
            if magnitude > maxMagnitude {
                maxMagnitude = magnitude
                peakFreqIdx = i
            }
        }
        
        // Convert frequency index to BPM
        let peakFreq = Float(peakFreqIdx) * Float(TARGET_FPS) / Float(fftLength)
        bpm = max(0, Int(peakFreq * 60))
        
        // Breathing depth (amplitude)
        breathingDepth = maxMagnitude / Float(fftLength)
        
        // Confidence (SNR-like metric)
        let bandMagnitude = realX[breathingBandStart...breathingBandEnd].map { sqrt($0 * $0) }.reduce(0, +)
        let totalMagnitude = realX.map { sqrt($0 * $0) }.reduce(0, +)
        confidence = totalMagnitude > 0 ? bandMagnitude / totalMagnitude : 0
        
        // Breathing mode detection (nasal vs mouth)
        // Simplified: use peak frequency to infer mode
        // Nasal breathing: typically 0.2-0.35 Hz (12-21 BPM)
        // Mouth breathing: typically 0.1-0.2 Hz (6-12 BPM)
        if bpm >= 12 && bpm <= 21 {
            breathingMode = "nasal"
        } else if bpm >= 6 && bpm <= 12 {
            breathingMode = "mouth"
        } else {
            breathingMode = "--"
        }
        
        // Generate waveform for visualization
        waveform = Array(posX.prefix(100))
    }
    
    // MARK: - Private Helpers
    
    private func normalize(_ signal: inout [Float]) {
        var mean: Float = 0
        vDSP_meanv(signal, 1, &mean, vDSP_Length(signal.count))
        
        var variance: Float = 0
        var signalMinusMean = signal.map { $0 - mean }
        vDSP_dotpr(signalMinusMean, 1, signalMinusMean, 1, &variance, vDSP_Length(signalMinusMean.count))
        variance /= Float(signal.count)
        
        let stdDev = sqrt(variance)
        if stdDev > 0 {
            signal = signal.map { ($0 - mean) / stdDev }
        }
    }
    
    private func createHannWindow(size: Int) -> [Float] {
        var window = [Float](repeating: 0, count: size)
        for i in 0..<size {
            let angle = Float.pi * 2 * Float(i) / Float(size - 1)
            window[i] = 0.5 * (1 - cos(angle))
        }
        return window
    }
}

//
//  BreathingProcessorViewModel.swift
//  FaceBreath
//
//  ObservableObject wrapper for BreathingProcessor to integrate with SwiftUI.
//

import SwiftUI
import Vision
import CoreImage

class BreathingProcessorViewModel: NSObject, ObservableObject {
    @Published var bpm: Int = 0
    @Published var breathingMode: String = "--"
    @Published var breathingDepth: Float = 0.0
    @Published var confidence: Float = 0.0
    @Published var calibrationProgress: Int = 0
    
    private let processor = BreathingProcessor()
    private let cameraManager = CameraManager()
    private var faceDetectionRequest: VNDetectFaceRectanglesRequest?
    private var isProcessing = false
    
    override init() {
        super.init()
        setupFaceDetection()
        setupCameraCallback()
    }
    
    private func setupFaceDetection() {
        faceDetectionRequest = VNDetectFaceRectanglesRequest { [weak self] request, error in
            guard let self = self else { return }
            // Face detection results will be used to extract ROI
        }
    }
    
    private func setupCameraCallback() {
        cameraManager.onFrameCapture = { [weak self] pixelBuffer in
            self?.processFrame(pixelBuffer)
        }
    }
    
    func start() {
        processor.reset()
        cameraManager.start()
    }
    
    func stop() {
        cameraManager.stop()
    }
    
    func setFFTWindowLength(_ length: Int) {
        processor.setFFTWindowLength(length)
    }
    
    private func processFrame(_ pixelBuffer: CVPixelBuffer) {
        guard !isProcessing else { return }
        isProcessing = true
        defer { isProcessing = false }
        
        // Extract RGB from center ROI (55% of frame)
        let (r, g, b) = extractROISample(pixelBuffer)
        
        // Push to processor
        processor.pushSample(r: r, g: g, b: b)
        
        // Update calibration progress
        DispatchQueue.main.async {
            self.calibrationProgress = self.processor.calibrationProgress
        }
        
        // Analyze if calibration complete
        if processor.calibrationProgress >= processor.CALIBRATION_FRAMES {
            processor.analyze()
            
            DispatchQueue.main.async {
                self.bpm = self.processor.bpm
                self.breathingMode = self.processor.breathingMode
                self.breathingDepth = self.processor.breathingDepth
                self.confidence = self.processor.confidence
            }
        }
    }
    
    private func extractROISample(_ pixelBuffer: CVPixelBuffer) -> (r: Float, g: Float, b: Float) {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        
        // Center ROI: 55% of frame
        let roiSize = min(width, height) * 55 / 100
        let roiX = (width - roiSize) / 2
        let roiY = (height - roiSize) / 2
        
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return (0, 0, 0)
        }
        
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let buffer = baseAddress.assumingMemoryBound(to: UInt8.self)
        
        var sumR: Float = 0, sumG: Float = 0, sumB: Float = 0
        var count: Float = 0
        
        for y in roiY..<(roiY + roiSize) {
            for x in roiX..<(roiX + roiSize) {
                let pixelIndex = y * bytesPerRow + x * 4
                let b = Float(buffer[pixelIndex])
                let g = Float(buffer[pixelIndex + 1])
                let r = Float(buffer[pixelIndex + 2])
                
                sumB += b
                sumG += g
                sumR += r
                count += 1
            }
        }
        
        let avgR = count > 0 ? sumR / count / 255.0 : 0
        let avgG = count > 0 ? sumG / count / 255.0 : 0
        let avgB = count > 0 ? sumB / count / 255.0 : 0
        
        return (r: avgR, g: avgG, b: avgB)
    }
}

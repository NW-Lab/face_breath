//
//  ContentView.swift
//  FaceBreath
//
//  Main UI: camera preview, calibration progress, BPM display, FFT window slider.
//  Bio-Lab Noir theme (dark background, cyan accents).
//

import SwiftUI
import AVFoundation

struct ContentView: View {
    @StateObject private var cameraManager = CameraManager()
    @StateObject private var processor = BreathingProcessorViewModel()
    
    @State private var isRunning = false
    @State private var calibrationProgress: CGFloat = 0
    @State private var fftWindowLength = 300
    @State private var ampLevel = 1.0
    
    var body: some View {
        ZStack {
            // Background
            Color(red: 0.02, green: 0.04, blue: 0.08).ignoresSafeArea()
            
            VStack(spacing: 12) {
                // Header
                VStack(alignment: .leading, spacing: 4) {
                    Text("BIO-LAB NOIR")
                        .font(.caption)
                        .tracking(0.1)
                        .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                    
                    Text("Face Breath")
                        .font(.system(size: 32, weight: .bold, design: .default))
                        .foregroundColor(.white)
                    
                    Text("カメラで顔・鼻孔・胸部の動きから呼吸をリアルタイム推定")
                        .font(.caption)
                        .foregroundColor(Color(red: 0.5, green: 0.6, blue: 0.6))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 16)
                
                // Camera Preview (max 50vh)
                ZStack {
                    if let session = cameraManager.captureSession as AVCaptureSession? {
                        CameraPreviewView(session: session)
                            .frame(maxHeight: UIScreen.main.bounds.height * 0.5)
                            .clipped()
                            .border(Color(red: 0.0, green: 0.86, blue: 1.0), width: 1)
                            .cornerRadius(12)
                    }
                    
                    // Overlay: Face guide + calibration progress
                    if isRunning {
                        VStack {
                            HStack {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("CALIBRATING")
                                        .font(.caption)
                                        .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                                    
                                    ProgressView(value: calibrationProgress, total: 1.0)
                                        .tint(Color(red: 0.0, green: 0.86, blue: 1.0))
                                        .frame(width: 100)
                                    
                                    Text("\(Int(calibrationProgress * 100))%")
                                        .font(.caption2)
                                        .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                                }
                                .padding(12)
                                .background(Color(red: 0.02, green: 0.08, blue: 0.12).opacity(0.9))
                                .cornerRadius(8)
                                
                                Spacer()
                            }
                            .padding(12)
                            
                            Spacer()
                        }
                    }
                }
                .padding(.horizontal, 16)
                
                // Start/Stop Button
                Button(action: toggleMeasurement) {
                    HStack {
                        Image(systemName: isRunning ? "stop.fill" : "play.fill")
                        Text(isRunning ? "計測停止" : "計測開始")
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundColor(.white)
                    .background(Color(red: 0.0, green: 0.5, blue: 0.5))
                    .cornerRadius(12)
                }
                .padding(.horizontal, 16)
                
                // Metrics Display
                HStack(spacing: 12) {
                    VStack(spacing: 4) {
                        Text("呼吸数")
                            .font(.caption)
                            .foregroundColor(Color(red: 0.5, green: 0.6, blue: 0.6))
                        
                        Text("\(processor.bpm)")
                            .font(.system(size: 24, weight: .bold, design: .monospaced))
                            .foregroundColor(Color(red: 0.0, green: 1.0, blue: 0.71))
                        
                        Text("BPM")
                            .font(.caption2)
                            .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(Color(red: 0.05, green: 0.1, blue: 0.15))
                    .cornerRadius(10)
                    
                    VStack(spacing: 4) {
                        Text("呼吸モード")
                            .font(.caption)
                            .foregroundColor(Color(red: 0.5, green: 0.6, blue: 0.6))
                        
                        Text(processor.breathingMode)
                            .font(.system(size: 16, weight: .bold, design: .monospaced))
                            .foregroundColor(Color(red: 0.0, green: 1.0, blue: 0.71))
                        
                        Text("nasal/mouth")
                            .font(.caption2)
                            .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(Color(red: 0.05, green: 0.1, blue: 0.15))
                    .cornerRadius(10)
                    
                    VStack(spacing: 4) {
                        Text("呼吸深さ")
                            .font(.caption)
                            .foregroundColor(Color(red: 0.5, green: 0.6, blue: 0.6))
                        
                        Text(String(format: "%.2f", processor.breathingDepth))
                            .font(.system(size: 16, weight: .bold, design: .monospaced))
                            .foregroundColor(Color(red: 0.0, green: 1.0, blue: 0.71))
                        
                        Text("振幅")

                        Text("振幅")
                            .font(.caption2)
                            .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.8))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(Color(red: 0.05, green: 0.1, blue: 0.15))
                    .cornerRadius(10)
                }
                .padding(.horizontal, 16)
                
                // FFT Window Length Control (−/＋ buttons)
                VStack(spacing: 8) {
                    Text("FFT WINDOW LENGTH")
                        .font(.caption)
                        .tracking(0.05)
                        .foregroundColor(Color(red: 0.5, green: 0.8, blue: 0.8))
                    
                    HStack(spacing: 12) {
                        Button(action: decreaseFFTWindow) {
                            Text("−")
                                .font(.system(size: 28, weight: .bold, design: .monospaced))
                                .frame(width: 50, height: 44)
                                .foregroundColor(Color(red: 0.0, green: 0.86, blue: 1.0))
                                .border(Color(red: 0.0, green: 0.86, blue: 1.0), width: 2)
                                .cornerRadius(10)
                        }
                        
                        VStack(spacing: 4) {
                            Text("\(fftWindowLength)")
                                .font(.system(size: 28, weight: .bold, design: .monospaced))
                                .foregroundColor(Color(red: 0.0, green: 1.0, blue: 0.71))
                            
                            Text("frames / \(String(format: "%.1f", Double(fftWindowLength) / 30.0)) s")
                                .font(.caption)
                                .foregroundColor(Color(red: 0.5, green: 0.8, blue: 0.8))
                        }
                        .frame(maxWidth: .infinity)
                        
                        Button(action: increaseFFTWindow) {
                            Text("＋")
                                .font(.system(size: 28, weight: .bold, design: .monospaced))
                                .frame(width: 50, height: 44)
                                .foregroundColor(Color(red: 0.0, green: 0.86, blue: 1.0))
                                .border(Color(red: 0.0, green: 0.86, blue: 1.0), width: 2)
                                .cornerRadius(10)
                        }
                    }
                    
                    HStack {
                        Text("MIN 100f")
                            .font(.caption2)
                            .foregroundColor(Color(red: 0.3, green: 0.4, blue: 0.4))
                        
                        Spacer()
                        
                        Text("MAX 600f")
                            .font(.caption2)
                            .foregroundColor(Color(red: 0.3, green: 0.4, blue: 0.4))
                    }
                }
                .padding(16)
                .background(Color(red: 0.0, green: 0.13, blue: 0.2).opacity(0.5))
                .border(Color(red: 0.0, green: 0.86, blue: 1.0), width: 2)
                .cornerRadius(12)
                .padding(.horizontal, 16)
                
                Spacer()
                
                // Footer
                Text("顔全体が映るよう距離を調整してください。\n十分な照明環境で計測精度が向上します。")
                    .font(.caption2)
                    .foregroundColor(Color(red: 0.3, green: 0.4, blue: 0.4))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
            }
        }
        .onAppear {
            requestCameraPermission()
        }
        .onChange(of: isRunning) { newValue in
            if newValue {
                cameraManager.start()
                processor.start()
            } else {
                cameraManager.stop()
                processor.stop()
            }
        }
        .onChange(of: calibrationProgress) { _ in
            // Update UI when calibration progresses
        }
    }
    
    // MARK: - Actions
    
    private func toggleMeasurement() {
        isRunning.toggle()
    }
    
    private func decreaseFFTWindow() {
        fftWindowLength = max(100, fftWindowLength - 50)
        processor.setFFTWindowLength(fftWindowLength)
    }
    
    private func increaseFFTWindow() {
        fftWindowLength = min(600, fftWindowLength + 50)
        processor.setFFTWindowLength(fftWindowLength)
    }
    
    private func requestCameraPermission() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            if !granted {
                print("Camera permission denied")
            }
        }
    }
}

#Preview {
    ContentView()
        .preferredColorScheme(.dark)
}

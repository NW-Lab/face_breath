using FaceBreathWin.Processing;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
using Windows.Devices.Enumeration;
using Windows.Media.MediaProperties;

namespace FaceBreathWin;

public sealed partial class MainPage : Page
{
    private const int CalibFrames = 150;
    private const int TargetFps = 30;
    private const int SampleWindowMs = 10_000;
    private const int WaveformLen = 120;
    private const int FftWinMin = 100;
    private const int FftWinMax = 600;
    private const int FftWinDefault = 300;

    private MediaCapture? _mediaCapture;
    private MediaFrameReader? _frameReader;
    private readonly SoftwareBitmapSource _previewBitmapSource = new();
    private readonly BreathingEstimator _estimator = new(SampleWindowMs, TargetFps, WaveformLen);
    private readonly DispatcherQueue _dispatcherQueue;

    private bool _isRunning;
    private bool _isCalibrating;
    private int _frameCount;
    private int _fftWindow = FftWinDefault;
    private long _lastFrameMs;
    private int _uiFrameModulo;
    private long _captureStartMs;
    private List<DeviceInformation> _cameras = [];
    private int _cameraIndex;
    private bool _isMirrored = true;

    public MainPage()
    {
        InitializeComponent();
        _dispatcherQueue = DispatcherQueue;
        PreviewImage.Source = _previewBitmapSource;
        ApplyMirrorState();

        Unloaded += (_, _) =>
        {
            _ = StopCaptureAsync();
        };

        UpdateFftLabel();
        UpdateRunStateVisuals();
        _ = LoadCameraListAsync();
    }

    private async void StartStopButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isRunning)
        {
            await StopCaptureAsync();
        }
        else
        {
            await StartCaptureAsync();
        }
    }

    private void DecreaseFftButton_OnClick(object sender, RoutedEventArgs e)
    {
        _fftWindow = Math.Max(FftWinMin, _fftWindow - 50);
        UpdateFftLabel();
    }

    private void IncreaseFftButton_OnClick(object sender, RoutedEventArgs e)
    {
        _fftWindow = Math.Min(FftWinMax, _fftWindow + 50);
        UpdateFftLabel();
    }

    private async void SwitchCameraButton_OnClick(object sender, RoutedEventArgs e)
    {
        ShowError(string.Empty);
        await LoadCameraListAsync(refresh: true);
        if (_cameras.Count <= 1)
        {
            ShowError("切り替え可能なカメラが見つからない");
            return;
        }

        _cameraIndex = (_cameraIndex + 1) % _cameras.Count;
        UpdateCameraLabel();

        if (_isRunning)
        {
            await StopCaptureAsync();
            await StartCaptureAsync();
        }
    }

    private void MirrorToggleButton_OnClick(object sender, RoutedEventArgs e)
    {
        _isMirrored = !_isMirrored;
        ApplyMirrorState();
    }

    private async Task LoadCameraListAsync(bool refresh = false)
    {
        if (!refresh && _cameras.Count > 0)
        {
            return;
        }

        var devices = await DeviceInformation.FindAllAsync(DeviceClass.VideoCapture);
        _cameras = devices.ToList();
        if (_cameraIndex >= _cameras.Count)
        {
            _cameraIndex = 0;
        }

        UpdateCameraLabel();
    }

    private void UpdateCameraLabel()
    {
        if (_cameras.Count == 0)
        {
            CameraNameText.Text = "カメラ: なし";
            SwitchCameraButton.IsEnabled = false;
            return;
        }

        var cameraName = _cameras[_cameraIndex].Name;
        CameraNameText.Text = $"カメラ: {cameraName}";
        SwitchCameraButton.IsEnabled = _cameras.Count > 1;
    }

    private void ApplyMirrorState()
    {
        PreviewImage.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
        PreviewImage.RenderTransform = new ScaleTransform
        {
            ScaleX = _isMirrored ? -1 : 1,
            ScaleY = 1
        };
        MirrorToggleButton.Content = _isMirrored ? "鏡像 ON" : "鏡像 OFF";
    }

    private async Task StartCaptureAsync()
    {
        ShowError(string.Empty);

        try
        {
            await LoadCameraListAsync(refresh: true);
            if (_cameras.Count == 0)
            {
                throw new InvalidOperationException("利用可能なカメラが見つからない");
            }

            var selectedCamera = _cameras[_cameraIndex];
            UpdateCameraLabel();

            _mediaCapture = new MediaCapture();
            await _mediaCapture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                VideoDeviceId = selectedCamera.Id,
                SharingMode = MediaCaptureSharingMode.SharedReadOnly,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu,
                StreamingCaptureMode = StreamingCaptureMode.Video
            });
            PreviewHintText.Visibility = Visibility.Visible;

            var colorSource = _mediaCapture.FrameSources.Values.FirstOrDefault(source =>
                                  source.Info.SourceKind == MediaFrameSourceKind.Color
                                  && source.Info.MediaStreamType == MediaStreamType.VideoPreview)
                              ?? _mediaCapture.FrameSources.Values.FirstOrDefault(source =>
                                  source.Info.SourceKind == MediaFrameSourceKind.Color);

            if (colorSource is null)
            {
                throw new InvalidOperationException("カメラのカラーソースが見つからない");
            }

            _frameReader = await _mediaCapture.CreateFrameReaderAsync(colorSource, MediaEncodingSubtypes.Bgra8);
            _frameReader.AcquisitionMode = MediaFrameReaderAcquisitionMode.Realtime;
            _frameReader.FrameArrived += FrameReaderOnFrameArrived;

            var status = await _frameReader.StartAsync();
            if (status != MediaFrameReaderStartStatus.Success)
            {
                throw new InvalidOperationException($"FrameReader 起動失敗: {status}");
            }

            _estimator.Reset();
            _frameCount = 0;
            _lastFrameMs = 0;
            _uiFrameModulo = 0;
            _captureStartMs = Environment.TickCount64;
            _isRunning = true;
            _isCalibrating = true;
            UpdateRunStateVisuals();

            _ = Task.Run(async () =>
            {
                await Task.Delay(5000);
                if (_isRunning && _frameCount == 0)
                {
                    _dispatcherQueue.TryEnqueue(async () =>
                    {
                        ShowError("カメラフレームを取得できない。カメラ使用中アプリを閉じて再試行して。必要ならプライバシー設定のカメラ許可も確認して。" );
                        await StopCaptureAsync();
                    });
                }
            });

            _ = Task.Run(async () =>
            {
                await Task.Delay(20000);
                if (_isRunning && _isCalibrating)
                {
                    var frames = _frameCount;
                    _dispatcherQueue.TryEnqueue(async () =>
                    {
                        ShowError($"キャリブレーションが進まない ({frames}/{CalibFrames})。顔を中央に合わせ、照明を明るくして再試行して。" );
                        await StopCaptureAsync();
                    });
                }
            });
        }
        catch (Exception ex)
        {
            await StopCaptureAsync();
            ShowError($"カメラ起動に失敗: {ex.Message}");
        }
    }

    private async Task StopCaptureAsync()
    {
        _isRunning = false;
        _isCalibrating = false;

        if (_frameReader is not null)
        {
            _frameReader.FrameArrived -= FrameReaderOnFrameArrived;
            await _frameReader.StopAsync();
            _frameReader.Dispose();
            _frameReader = null;
        }

        if (_mediaCapture is not null)
        {
            _mediaCapture.Dispose();
            _mediaCapture = null;
        }
        PreviewHintText.Visibility = Visibility.Visible;
        _estimator.Reset();
        _frameCount = 0;
        BpmText.Text = "--";
        DepthText.Text = "--";
        ModeText.Text = "--";
        SignalConfText.Text = "SIG CONF --";
        BpmConfText.Text = "BPM CONF --";
        ModeConfText.Text = "MODE CONF --";
        SnrText.Text = "SNR -- dB";
        SampleCountText.Text = $"-- / {_fftWindow}";
        WavePolyline.Points = new PointCollection();
        QualityWarningPanel.Visibility = Visibility.Collapsed;
        QualityWarningText.Text = string.Empty;
        UpdateRunStateVisuals();
    }

    private void FrameReaderOnFrameArrived(MediaFrameReader sender, MediaFrameArrivedEventArgs args)
    {
        try
        {
            if (!_isRunning)
            {
                return;
            }

            using var frameReference = sender.TryAcquireLatestFrame();
            var softwareBitmap = frameReference?.VideoMediaFrame?.SoftwareBitmap;
            if (softwareBitmap is null)
            {
                return;
            }

            var nowMs = Environment.TickCount64;
            if (_lastFrameMs > 0 && nowMs - _lastFrameMs < 1000 / TargetFps)
            {
                return;
            }

            _lastFrameMs = nowMs;
            var previewFrame = SoftwareBitmap.Convert(softwareBitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);

            _dispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    await _previewBitmapSource.SetBitmapAsync(previewFrame);
                    PreviewHintText.Visibility = Visibility.Collapsed;
                }
                catch
                {
                    // Ignore preview update errors to keep capture loop alive.
                }
                finally
                {
                    previewFrame.Dispose();
                }
            });

            using var bgra = softwareBitmap.BitmapPixelFormat == BitmapPixelFormat.Bgra8
                ? SoftwareBitmap.Copy(softwareBitmap)
                : SoftwareBitmap.Convert(softwareBitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);

            var width = bgra.PixelWidth;
            var height = bgra.PixelHeight;
            if (width <= 0 || height <= 0)
            {
                return;
            }

            var buffer = new byte[4 * width * height];
            bgra.CopyToBuffer(buffer.AsBuffer());

            var faceStats = SampleGreenStats(buffer, width, height, 0.22, 0.08, 0.56, 0.52);
            var faceG = faceStats.Mean;
            var noseG = SampleGreen(buffer, width, height, 0.38, 0.40, 0.24, 0.14);
            var mouthG = SampleGreen(buffer, width, height, 0.35, 0.56, 0.30, 0.12);
            var chestG = SampleGreen(buffer, width, height, 0.15, 0.68, 0.70, 0.28);

            _estimator.Push(nowMs, faceG, noseG, mouthG, chestG);
            _frameCount++;

            if (_isCalibrating)
            {
                var quickResult = _estimator.Analyze(Math.Min(_fftWindow, 120));
                var progress = Math.Min(1.0, _frameCount / (double)CalibFrames);
                _dispatcherQueue.TryEnqueue(() =>
                {
                    CalibrationProgress.Value = progress * 100;
                    CalibrationText.Text = $"キャリブレーション {Math.Round(progress * 100)}% ({_frameCount}/{CalibFrames})";
                    var elapsedSec = Math.Max(0.0, (Environment.TickCount64 - _captureStartMs) / 1000.0);
                    StatusText.Text = $"キャリブレーション中 {elapsedSec:0.0}s";
                    if (quickResult is not null)
                    {
                        ModeText.Text = quickResult.Mode;
                        SignalConfText.Text = $"SIG CONF {quickResult.SignalConfidence * 100:0}%";
                        BpmConfText.Text = $"BPM CONF {quickResult.BpmConfidence * 100:0}%";
                        ModeConfText.Text = $"MODE CONF {quickResult.ModeConfidence * 100:0}%";
                        SnrText.Text = $"SNR {quickResult.SnrDb:0.0} dB";
                    }

                    UpdateQualityWarnings(faceStats, quickResult);
                });

                if (_frameCount >= CalibFrames)
                {
                    _isCalibrating = false;
                    _dispatcherQueue.TryEnqueue(() =>
                    {
                        StatusText.Text = "計測中";
                    });
                }

                return;
            }

            var result = _estimator.Analyze(_fftWindow);
            _uiFrameModulo = (_uiFrameModulo + 1) % 2;
            if (result is null || _uiFrameModulo != 0)
            {
                return;
            }

            _dispatcherQueue.TryEnqueue(() =>
            {
                BpmText.Text = result.Bpm > 0 ? result.Bpm.ToString() : "--";
                DepthText.Text = result.Depth > 0 ? result.Depth.ToString("0.00") : "--";
                ModeText.Text = result.Mode;
                SignalConfText.Text = $"SIG CONF {result.SignalConfidence * 100:0}%";
                BpmConfText.Text = $"BPM CONF {result.BpmConfidence * 100:0}%";
                ModeConfText.Text = $"MODE CONF {result.ModeConfidence * 100:0}%";
                SnrText.Text = $"SNR {result.SnrDb:0.0} dB";
                SampleCountText.Text = $"{result.SampleCount} / {_fftWindow}";
                DrawWaveform(result.Waveform);
                UpdateQualityWarnings(faceStats, result);
            });
        }
        catch (Exception ex)
        {
            _dispatcherQueue.TryEnqueue(() =>
            {
                ShowError($"フレーム解析エラー: {ex.Message}");
            });
        }
    }

    private static double SampleGreen(byte[] pixels, int width, int height, double xFrac, double yFrac, double wFrac, double hFrac)
    {
        return SampleGreenStats(pixels, width, height, xFrac, yFrac, wFrac, hFrac).Mean;
    }

    private static SignalStats SampleGreenStats(byte[] pixels, int width, int height, double xFrac, double yFrac, double wFrac, double hFrac)
    {
        var x = Math.Clamp((int)Math.Floor(width * xFrac), 0, width - 1);
        var y = Math.Clamp((int)Math.Floor(height * yFrac), 0, height - 1);
        var w = Math.Clamp((int)Math.Floor(width * wFrac), 1, width - x);
        var h = Math.Clamp((int)Math.Floor(height * hFrac), 1, height - y);

        var count = w * h;
        if (count <= 0)
        {
            return new SignalStats(0, 0);
        }

        double sum = 0;
        double sumSq = 0;

        for (var row = y; row < y + h; row++)
        {
            var rowOffset = row * width * 4;
            for (var col = x; col < x + w; col++)
            {
                var pixelOffset = rowOffset + (col * 4);
                var g = pixels[pixelOffset + 1];
                sum += g;
                sumSq += g * g;
            }
        }

        var mean = sum / count;
        var variance = Math.Max(0, (sumSq / count) - (mean * mean));
        var stdDev = Math.Sqrt(variance);
        return new SignalStats(mean, stdDev);
    }

    private void UpdateQualityWarnings(SignalStats faceStats, BreathingResult? result)
    {
        var warnings = new List<string>();

        if (faceStats.Mean < 55)
        {
            warnings.Add("画面が暗い。照明を足して");
        }
        else if (faceStats.Mean > 220)
        {
            warnings.Add("画面が明るすぎる。逆光を避けて");
        }

        if (faceStats.StdDev < 10)
        {
            warnings.Add("顔のコントラスト不足。顔を近づけるか光を調整して");
        }

        if (result is not null && _frameCount >= 45 && result.SignalConfidence < 0.35)
        {
            warnings.Add("信号が弱い。顔が小さいか遠い可能性あり");
        }

        if (warnings.Count == 0)
        {
            QualityWarningPanel.Visibility = Visibility.Collapsed;
            QualityWarningText.Text = string.Empty;
            return;
        }

        QualityWarningPanel.Visibility = Visibility.Visible;
        QualityWarningText.Text = string.Join(" / ", warnings);
    }

    private void DrawWaveform(IReadOnlyList<double> waveform)
    {
        if (waveform.Count < 2)
        {
            WavePolyline.Points = new PointCollection();
            return;
        }

        var width = WaveCanvas.ActualWidth;
        var height = WaveCanvas.ActualHeight;
        if (width <= 0 || height <= 0)
        {
            return;
        }

        var points = new PointCollection();
        var stepX = width / (waveform.Count - 1);
        var centerY = height / 2;
        var amp = height * 0.4;
        for (var i = 0; i < waveform.Count; i++)
        {
            points.Add(new Windows.Foundation.Point(i * stepX, centerY - waveform[i] * amp));
        }

        WavePolyline.Stroke = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0, 220, 255));
        WavePolyline.Points = points;
    }

    private void UpdateRunStateVisuals()
    {
        IdleOverlay.Visibility = _isRunning ? Visibility.Collapsed : Visibility.Visible;
        CalibrationPanel.Visibility = _isRunning ? Visibility.Visible : Visibility.Collapsed;
        CalibrationProgress.Value = 0;
        CalibrationText.Text = "キャリブレーション 0%";
        StatusText.Text = _isRunning ? "キャリブレーション中" : "停止中";
        StartStopButton.Content = _isRunning ? "■ 計測停止" : "▶ 計測開始";
        StartStopButton.Foreground = new SolidColorBrush(_isRunning
            ? Windows.UI.Color.FromArgb(255, 255, 96, 96)
            : Windows.UI.Color.FromArgb(255, 0, 220, 255));
    }

    private void UpdateFftLabel()
    {
        FftWindowText.Text = _fftWindow.ToString();
        FftWindowSecondsText.Text = $"frames / {_fftWindow / (double)TargetFps:0.0} s";
        SampleCountText.Text = $"-- / {_fftWindow}";
    }

    private void ShowError(string message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            ErrorPanel.Visibility = Visibility.Collapsed;
            ErrorText.Text = string.Empty;
            return;
        }

        ErrorPanel.Visibility = Visibility.Visible;
        ErrorText.Text = message;
    }

    private readonly record struct SignalStats(double Mean, double StdDev);
}

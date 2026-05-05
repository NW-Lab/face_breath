using FaceBreathWin.Processing;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
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
    private readonly BreathingEstimator _estimator = new(SampleWindowMs, TargetFps, WaveformLen);
    private readonly DispatcherQueue _dispatcherQueue;

    private bool _isRunning;
    private bool _isCalibrating;
    private int _frameCount;
    private int _fftWindow = FftWinDefault;
    private long _lastFrameMs;
    private int _uiFrameModulo;

    public MainPage()
    {
        InitializeComponent();
        _dispatcherQueue = DispatcherQueue;

        Unloaded += (_, _) =>
        {
            _ = StopCaptureAsync();
        };

        UpdateFftLabel();
        UpdateRunStateVisuals();
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

    private async Task StartCaptureAsync()
    {
        ShowError(string.Empty);

        try
        {
            _mediaCapture = new MediaCapture();
            await _mediaCapture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = StreamingCaptureMode.Video
            });

            var colorSource = _mediaCapture.FrameSources.Values.FirstOrDefault(source =>
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
            _isRunning = true;
            _isCalibrating = true;
            UpdateRunStateVisuals();
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
        _estimator.Reset();
        _frameCount = 0;
        BpmText.Text = "--";
        DepthText.Text = "--";
        ModeText.Text = "--";
        SampleCountText.Text = $"-- / {_fftWindow}";
        WavePolyline.Points = new PointCollection();
        UpdateRunStateVisuals();
    }

    private void FrameReaderOnFrameArrived(MediaFrameReader sender, MediaFrameArrivedEventArgs args)
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

        var faceG = SampleGreen(buffer, width, height, 0.22, 0.08, 0.56, 0.52);
        var noseG = SampleGreen(buffer, width, height, 0.38, 0.40, 0.24, 0.14);
        var mouthG = SampleGreen(buffer, width, height, 0.35, 0.56, 0.30, 0.12);
        var chestG = SampleGreen(buffer, width, height, 0.15, 0.68, 0.70, 0.28);

        _estimator.Push(nowMs, faceG, noseG, mouthG, chestG);
        _frameCount++;

        if (_isCalibrating)
        {
            var progress = Math.Min(1.0, _frameCount / (double)CalibFrames);
            _dispatcherQueue.TryEnqueue(() =>
            {
                CalibrationProgress.Value = progress * 100;
                CalibrationText.Text = $"キャリブレーション {Math.Round(progress * 100)}%";
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
            SampleCountText.Text = $"{result.SampleCount} / {_fftWindow}";
            DrawWaveform(result.Waveform);
        });
    }

    private static double SampleGreen(byte[] pixels, int width, int height, double xFrac, double yFrac, double wFrac, double hFrac)
    {
        var x = Math.Clamp((int)Math.Floor(width * xFrac), 0, width - 1);
        var y = Math.Clamp((int)Math.Floor(height * yFrac), 0, height - 1);
        var w = Math.Clamp((int)Math.Floor(width * wFrac), 1, width - x);
        var h = Math.Clamp((int)Math.Floor(height * hFrac), 1, height - y);

        long sum = 0;
        var count = w * h;
        for (var row = y; row < y + h; row++)
        {
            var rowOffset = row * width * 4;
            for (var col = x; col < x + w; col++)
            {
                var pixelOffset = rowOffset + (col * 4);
                sum += pixels[pixelOffset + 1];
            }
        }

        return count == 0 ? 0 : sum / (double)count;
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
}

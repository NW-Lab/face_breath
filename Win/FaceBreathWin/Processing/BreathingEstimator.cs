namespace FaceBreathWin.Processing;

public sealed class BreathingEstimator
{
    private readonly int _windowMs;
    private readonly int _targetFps;
    private readonly int _waveformLen;

    private readonly List<SignalSample> _faceSamples = [];
    private readonly List<SignalSample> _noseSamples = [];
    private readonly List<SignalSample> _mouthSamples = [];
    private readonly List<SignalSample> _chestSamples = [];

    private int _lastStableBpm;
    private string _lastMode = "--";

    public BreathingEstimator(int windowMs, int targetFps, int waveformLen)
    {
        _windowMs = windowMs;
        _targetFps = targetFps;
        _waveformLen = waveformLen;
    }

    public void Reset()
    {
        _faceSamples.Clear();
        _noseSamples.Clear();
        _mouthSamples.Clear();
        _chestSamples.Clear();
        _lastStableBpm = 0;
        _lastMode = "--";
    }

    public void Push(long tMs, double faceG, double noseG, double mouthG, double chestG)
    {
        PushTo(_faceSamples, tMs, faceG);
        PushTo(_noseSamples, tMs, noseG);
        PushTo(_mouthSamples, tMs, mouthG);
        PushTo(_chestSamples, tMs, chestG);
    }

    public BreathingResult? Analyze(int windowFrames)
    {
        if (_faceSamples.Count < 30)
        {
            return null;
        }

        var faceSignal = _faceSamples.Select(sample => sample.Value).TakeLast(windowFrames).ToList();
        var noseSignal = _noseSamples.Select(sample => sample.Value).TakeLast(windowFrames).ToList();
        var mouthSignal = _mouthSamples.Select(sample => sample.Value).TakeLast(windowFrames).ToList();
        var chestSignal = _chestSamples.Select(sample => sample.Value).TakeLast(windowFrames).ToList();

        var breathSignal = faceSignal.Count > 0 ? faceSignal : chestSignal;
        if (breathSignal.Count < 30)
        {
            return null;
        }

        var filtered = BandpassBreath(breathSignal, _targetFps);
        var bpm = EstimateBpm(breathSignal, _targetFps);

        if (bpm is >= 4 and <= 40)
        {
            _lastStableBpm = bpm;
        }

        var depth = PeakToPeak(filtered.TakeLast(60));
        var modeWindow = Math.Max(18, Math.Min(45, _targetFps));
        var noseAmp = PeakToPeak(BandpassBreath(noseSignal, _targetFps).TakeLast(modeWindow));
        var mouthAmp = PeakToPeak(BandpassBreath(mouthSignal, _targetFps).TakeLast(modeWindow));
        var mode = ResolveMode(noseAmp, mouthAmp, _lastMode);
        _lastMode = mode;
        var snrDb = EstimateSnrDb(filtered.TakeLast(Math.Max(60, _targetFps * 2)).ToArray());
        var signalConfidence = EstimateSignalConfidence(snrDb, breathSignal.Count);
        var bpmConfidence = EstimateBpmConfidence(bpm, _lastStableBpm, signalConfidence);
        var modeConfidence = EstimateModeConfidence(noseAmp, mouthAmp, signalConfidence);

        var waveformSourceLen = Math.Max(_waveformLen, _targetFps * 6);
        var waveformSource = breathSignal.TakeLast(waveformSourceLen).ToArray();
        var waveformFiltered = BandpassBreath(waveformSource, _targetFps, 4.0, 1.0);
        var waveformTrimmed = TrimFilterStartup(waveformFiltered, _targetFps);
        var wave = Normalize(waveformTrimmed.TakeLast(_waveformLen).ToArray());

        return new BreathingResult(
            _lastStableBpm,
            depth,
            mode,
            breathSignal.Count,
            wave,
            snrDb,
            signalConfidence,
            bpmConfidence,
            modeConfidence);
    }

    private void PushTo(List<SignalSample> list, long tMs, double value)
    {
        list.Add(new SignalSample(tMs, value));
        var cutoff = tMs - _windowMs;
        while (list.Count > 0 && list[0].TimestampMs < cutoff)
        {
            list.RemoveAt(0);
        }
    }

    private static List<double> BandpassBreath(IReadOnlyList<double> signal, int fps, double slowWindowSec = 10.0, double fastWindowSec = 2.0)
    {
        if (signal.Count < 10)
        {
            return Enumerable.Repeat(0d, signal.Count).ToList();
        }

        var output = new double[signal.Count];
        var requestedSlowWindow = Math.Max(1, (int)Math.Round(fps * slowWindowSec));
        var requestedFastWindow = Math.Max(1, (int)Math.Round(fps * fastWindowSec));
        var maxSlowWindow = Math.Max(8, signal.Count / 2);
        var slowWindow = Math.Max(6, Math.Min(maxSlowWindow, requestedSlowWindow));
        var fastWindow = Math.Max(3, Math.Min(slowWindow - 2, requestedFastWindow));

        for (var i = 0; i < signal.Count; i++)
        {
            var slowStart = Math.Max(0, i - slowWindow);
            var fastStart = Math.Max(0, i - fastWindow);

            double slowSum = 0;
            double fastSum = 0;
            for (var j = slowStart; j <= i; j++)
            {
                slowSum += signal[j];
            }

            for (var j = fastStart; j <= i; j++)
            {
                fastSum += signal[j];
            }

            var slowAvg = slowSum / (i - slowStart + 1);
            var fastAvg = fastSum / (i - fastStart + 1);
            output[i] = fastAvg - slowAvg;
        }

        return output.ToList();
    }

    private static IReadOnlyList<double> TrimFilterStartup(IReadOnlyList<double> filtered, int fps)
    {
        if (filtered.Count <= 20)
        {
            return filtered;
        }

        var trimCount = Math.Min(filtered.Count / 3, Math.Max(8, fps / 2));
        var trimmed = filtered.Skip(trimCount).ToArray();
        return trimmed.Length > 0 ? trimmed : filtered;
    }

    private static int EstimateBpm(IReadOnlyList<double> signal, int fps)
    {
        var filtered = BandpassBreath(signal, fps);
        if (filtered.Count < 30)
        {
            return 0;
        }

        var crossings = 0;
        for (var i = 1; i < filtered.Count; i++)
        {
            if (filtered[i - 1] < 0 && filtered[i] >= 0)
            {
                crossings++;
            }
        }

        var durationSec = filtered.Count / (double)fps;
        if (durationSec <= 0)
        {
            return 0;
        }

        return (int)Math.Round((crossings / durationSec) * 60);
    }

    private static double PeakToPeak(IEnumerable<double> values)
    {
        var array = values.ToArray();
        if (array.Length == 0)
        {
            return 0;
        }

        return array.Max() - array.Min();
    }

    private static string ResolveMode(double noseAmp, double mouthAmp, string previousMode)
    {
        var totalAmp = noseAmp + mouthAmp;
        if (totalAmp <= 0.01)
        {
            return previousMode;
        }

        var ratio = noseAmp / (totalAmp + 0.001);
        if (previousMode == "鼻呼吸" && ratio > 0.50)
        {
            return "鼻呼吸";
        }

        if (previousMode == "口呼吸" && ratio < 0.50)
        {
            return "口呼吸";
        }

        return ratio > 0.58 ? "鼻呼吸" : ratio < 0.42 ? "口呼吸" : "混合";
    }

    private static double EstimateSnrDb(IReadOnlyList<double> signal)
    {
        if (signal.Count < 8)
        {
            return -30;
        }

        var mean = signal.Average();
        var centered = signal.Select(v => v - mean).ToArray();
        var signalPower = centered.Select(v => v * v).Average();

        var diffSqSum = 0.0;
        for (var i = 1; i < centered.Length; i++)
        {
            var d = centered[i] - centered[i - 1];
            diffSqSum += d * d;
        }

        var noisePower = Math.Max(1e-9, diffSqSum / Math.Max(1, centered.Length - 1));
        var snr = 10.0 * Math.Log10((signalPower + 1e-9) / noisePower);
        return Math.Clamp(snr, -30, 40);
    }

    private static double EstimateSignalConfidence(double snrDb, int sampleCount)
    {
        var snrFactor = Math.Clamp((snrDb + 8.0) / 18.0, 0.0, 1.0);
        var sampleFactor = Math.Clamp(sampleCount / 120.0, 0.0, 1.0);

        var confidence = (0.75 * snrFactor) + (0.25 * sampleFactor);
        return Math.Clamp(confidence, 0.0, 1.0);
    }

    private static double EstimateBpmConfidence(int bpm, int stableBpm, double signalConfidence)
    {
        var bpmRangeFactor = bpm is >= 4 and <= 40 ? 1.0 : 0.25;
        var stableFactor = stableBpm > 0
            ? Math.Clamp(1.0 - (Math.Abs(bpm - stableBpm) / 20.0), 0.0, 1.0)
            : 0.5;

        var confidence = (0.40 * signalConfidence) + (0.40 * bpmRangeFactor) + (0.20 * stableFactor);
        return Math.Clamp(confidence, 0.0, 1.0);
    }

    private static double EstimateModeConfidence(double noseAmp, double mouthAmp, double signalConfidence)
    {
        var separation = Math.Clamp(Math.Abs(noseAmp - mouthAmp) / (noseAmp + mouthAmp + 0.001), 0.0, 1.0);
        var amplitudeFactor = Math.Clamp((noseAmp + mouthAmp) / 2.0, 0.0, 1.0);

        var confidence = (0.50 * separation) + (0.30 * signalConfidence) + (0.20 * amplitudeFactor);
        return Math.Clamp(confidence, 0.0, 1.0);
    }

    private static IReadOnlyList<double> Normalize(IReadOnlyList<double> wave)
    {
        if (wave.Count == 0)
        {
            return Array.Empty<double>();
        }

        var maxAbs = wave.Max(v => Math.Abs(v));
        if (maxAbs < 1e-6)
        {
            return wave;
        }

        return wave.Select(v => v / maxAbs).ToArray();
    }

    private readonly record struct SignalSample(long TimestampMs, double Value);
}

public sealed record BreathingResult(
    int Bpm,
    double Depth,
    string Mode,
    int SampleCount,
    IReadOnlyList<double> Waveform,
    double SnrDb,
    double SignalConfidence,
    double BpmConfidence,
    double ModeConfidence);

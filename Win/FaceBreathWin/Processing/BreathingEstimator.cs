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
        var noseAmp = PeakToPeak(BandpassBreath(noseSignal, _targetFps).TakeLast(60));
        var mouthAmp = PeakToPeak(BandpassBreath(mouthSignal, _targetFps).TakeLast(60));
        var mode = "--";

        if (noseAmp > 0 || mouthAmp > 0)
        {
            var ratio = noseAmp / (noseAmp + mouthAmp + 0.001);
            mode = ratio > 0.55 ? "鼻呼吸" : ratio < 0.35 ? "口呼吸" : "混合";
        }

        var wave = Normalize(filtered.TakeLast(_waveformLen).ToArray());

        return new BreathingResult(
            _lastStableBpm,
            depth,
            mode,
            breathSignal.Count,
            wave);
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

    private static List<double> BandpassBreath(IReadOnlyList<double> signal, int fps)
    {
        if (signal.Count < 10)
        {
            return Enumerable.Repeat(0d, signal.Count).ToList();
        }

        var output = new double[signal.Count];
        var slowWindow = Math.Max(1, Math.Min(signal.Count, (int)Math.Round(fps / 0.1)));
        var fastWindow = Math.Max(1, Math.Min(signal.Count, (int)Math.Round(fps / 0.5)));

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

public sealed record BreathingResult(int Bpm, double Depth, string Mode, int SampleCount, IReadOnlyList<double> Waveform);

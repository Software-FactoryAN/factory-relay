using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

// Desk test for the hardware path of Encoder.cs / EncoderAsync.cs: needs a hardware H.264 encoder MFT. Exit 0 = every check passed.
//   EncoderHwTest.exe <out.h264>
static class EncoderHwTest
{
    static int failures;
    // Luma noise amplitude of the bitrate content; white noise at full range stays far above the 8 Mbit/s target.
    static int NoiseAmp = 16;
    static void Check(bool ok, string what) { Console.WriteLine((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; }
    static double Pct(List<double> v, double p) { var s = new List<double>(v); s.Sort(); return s.Count == 0 ? 0 : s[Math.Min(s.Count - 1, (int)Math.Ceiling(p * s.Count) - 1)]; }

    // Moving gradient (noise = false) or seeded noise on the luma plane over a flat chroma plane.
    static byte[] Frame(int w, int h, int n, bool noise)
    {
        var f = new byte[w * h * 3 / 2];
        var rnd = new Random(n + 1);
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) f[y * w + x] = (byte)(16 + ((x + y + n * 6) & 0x7f) + (noise ? rnd.Next(NoiseAmp) : 0));
        for (int i = w * h; i < f.Length; i++) f[i] = (byte)(100 + (n & 0x1f) + (i & 1) * 20);
        return f;
    }

    static H264Encoder Open(int w, int h, int bps = 4000000) { return new H264Encoder(new EncoderConfig(w, h, 30, bps, true, false)); }

    static bool Throws<T>(Action a) where T : Exception { try { a(); } catch (T) { return true; } catch (Exception) { return false; } return false; }

    static void Stream(string outPath)
    {
        const int W = 640, H = 360, Frames = 30, ForcedAt = 15;
        var all = new List<AccessUnit>(); var wall = new List<double>(); int single = 0;
        using (var enc = Open(W, H))
        {
            var s = enc.ReadSettings();
            Console.WriteLine("INFO MFT " + s.MftName + " vendor " + s.VendorId + " fallback " + s.FallbackReason);
            Check(s.Hardware && s.LowLatency == true && (s.RateControlMode == 0 || s.RateControlMode == 4) && s.MeanBitRateBps == 4000000u && s.GopSize == 18000u && s.OutputProfile == 77, "hardware MFT open, settings read back");
            var sw = new Stopwatch();
            for (int i = 0; i < Frames; i++)
            {
                if (i == ForcedAt) enc.ForceKeyFrame();
                var f = Frame(W, H, i, false); sw.Restart();
                var r = enc.Encode(f, i * 10000000L / 30); wall.Add(sw.Elapsed.TotalMilliseconds);
                if (r.Count == 1) single++; all.AddRange(r);
            }
            all.AddRange(enc.Drain());
            Check(Throws<InvalidOperationException>(() => enc.Encode(Frame(W, H, 0, false), 0)), "use after drain rejected");
        }
        Check(all.Count == Frames, "30 in, 30 access units out (" + all.Count + ")");
        Check(single >= 28 && Pct(wall, 0.95) <= 20, "Encode returns one AU per call in " + single + "/30, wall p95 " + Pct(wall, 0.95).ToString("F1") + " ms");
        bool mono = true; for (int i = 1; i < all.Count; i++) if (all[i].PtsHns <= all[i - 1].PtsHns) mono = false;
        Check(mono && all.Count > ForcedAt && all[0].Keyframe && all[ForcedAt].Keyframe, "PTS increase, first and forced AU are IDRs");
        using (var f = File.Create(outPath)) foreach (var au in all) f.Write(au.Data, 0, au.Data.Length);
    }

    static void IdrLatency()
    {
        const int W = 1920, H = 1080; var lat = new List<double>(); int landed = 0, wanted = 0;
        using (var enc = Open(W, H))
        {
            var sw = Stopwatch.StartNew(); double tick = 1000.0 / 30, next = 0; long reqPts = -1; double t0 = 0; var frames = new byte[8][];
            for (int i = 0; i < 8; i++) frames[i] = Frame(W, H, i, false);
            for (int k = 0; k < 30 + 25 * 12; k++)
            {
                bool req = k >= 30 && (k - 30) % 12 == 0;
                if (req) { while (sw.Elapsed.TotalMilliseconds < next - 16) Thread.Sleep(0); t0 = sw.Elapsed.TotalMilliseconds; enc.ForceKeyFrame(); reqPts = k * 10000000L / 30; wanted++; }
                while (sw.Elapsed.TotalMilliseconds < next) Thread.Sleep(0);
                foreach (var au in enc.Encode(frames[k & 7], k * 10000000L / 30))
                    if (reqPts >= 0 && au.Keyframe) { lat.Add(sw.Elapsed.TotalMilliseconds - t0); if (au.PtsHns == reqPts) landed++; reqPts = -1; }
                next += tick;
            }
            foreach (var au in enc.Drain()) if (reqPts >= 0 && au.Keyframe) { lat.Add(sw.Elapsed.TotalMilliseconds - t0); if (au.PtsHns == reqPts) landed++; reqPts = -1; }
        }
        Console.WriteLine("INFO IDR request to AU in hand, n=" + lat.Count + " p50 " + Pct(lat, 0.5).ToString("F1") + " ms p95 " + Pct(lat, 0.95).ToString("F1") + " ms");
        Check(wanted >= 20 && lat.Count == wanted && landed == wanted && Pct(lat, 0.95) <= 54, "IDR on request: n=" + wanted + ", " + landed + " on the requested frame, p95 <= 54 ms");
    }

    static void Bitrate()
    {
        const int W = 1280, H = 720; int[] phases = { 4000000, 1500000, 8000000 }; var bytes = new long[3]; int idrAfterFirst = 0; uint read;
        using (var enc = Open(W, H))
        {
            var sw = Stopwatch.StartNew(); double next = 0; int k = 0;
            for (int p = 0; p < 3; p++)
            {
                if (p > 0) enc.SetBitrate(phases[p]);
                for (int i = 0; i < 90; i++, k++)
                {
                    while (sw.Elapsed.TotalMilliseconds < next) Thread.Sleep(0);
                    next += 1000.0 / 30;
                    foreach (var au in enc.Encode(Frame(W, H, k, true), k * 10000000L / 30)) Count(au, bytes, ref idrAfterFirst);
                }
            }
            foreach (var au in enc.Drain()) Count(au, bytes, ref idrAfterFirst);
            read = enc.ReadSettings().MeanBitRateBps ?? 0;
        }
        double a = bytes[0] * 8 / 2000.0, b = bytes[1] * 8 / 2000.0, c = bytes[2] * 8 / 2000.0;
        Console.WriteLine("INFO bitrate kbit/s seconds 2-3 of each phase: 4M " + a.ToString("F0") + ", 1.5M " + b.ToString("F0") + ", 8M " + c.ToString("F0"));
        Check(b / a <= 0.6 && c / a >= 1.4 && idrAfterFirst == 0 && read == 8000000u, "bitrate follows SetBitrate, no IDR after the first, read back " + read);
    }

    // Only the last 60 frames (2 s) of each 90-frame phase count; the AU's PTS tells the phase.
    static void Count(AccessUnit au, long[] bytes, ref int idrs)
    {
        long frame = au.PtsHns * 30 / 10000000L; int p = (int)(frame / 90);
        if (frame % 90 >= 30) bytes[p] += au.Data.Length;
        if (au.Keyframe && frame > 0) idrs++;
    }

    static void SessionLimit()
    {
        var open = new List<H264Encoder>(); string refused = null; int hr = 0;
        try { for (int i = 0; i < H264Encoder.MaxHardwareSessions + 1 && refused == null; i++) { try { open.Add(Open(640, 360)); } catch (EncoderException e) { refused = e.Stage; hr = e.HResultCode; } } }
        finally
        {
            Console.WriteLine("INFO opened " + open.Count + " hardware sessions, then refused with stage " + refused + " 0x" + hr.ToString("X8") + ", live " + H264Encoder.LiveHardwareSessions);
            Check(refused == "SessionLimit" && open.Count <= H264Encoder.MaxHardwareSessions && H264Encoder.LiveHardwareSessions == open.Count, "session limit refused with a code instead of hanging");
            foreach (var e in open) e.Dispose();
        }
        Check(H264Encoder.LiveHardwareSessions == 0, "every session closed, live count 0");
        using (var e = Open(640, 360)) Check(e.ReadSettings().Hardware, "a new hardware session opens after the limit case");
    }

    static void Hygiene()
    {
        using (var e = Open(160, 120)) { e.Encode(Frame(160, 120, 0, false), 0); e.Drain(); }
        int before = Process.GetCurrentProcess().HandleCount;
        for (int i = 0; i < 20; i++) using (var e = Open(160, 120)) { e.Encode(Frame(160, 120, 0, false), 0); e.Drain(); }
        GC.Collect(); GC.WaitForPendingFinalizers();
        int after = Process.GetCurrentProcess().HandleCount;
        Check(after - before <= 20 * 12 && H264Encoder.LiveHardwareSessions == 0, "hardware handle growth " + (after - before) + " over 20 cycles (limit 240), live count 0");
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length > 1) { NoiseAmp = int.Parse(args[1]); Bitrate(); return failures; }
            Stream(args.Length > 0 ? args[0] : "h2-hw.h264"); IdrLatency(); Bitrate(); SessionLimit(); Hygiene();
        }
        catch (Exception e) { Console.WriteLine("FAIL unexpected " + e); return 2; }
        Console.WriteLine(failures == 0 ? "ALL PASS" : failures + " FAILED");
        return failures == 0 ? 0 : 1;
    }
}

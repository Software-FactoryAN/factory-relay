using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

// Desk self-test for Encoder.cs: real software MFT with a synthetic NV12 sequence. Exit 0 = every check passed.
//   EncoderSelfTest.exe <out.h264>
static class EncoderSelfTest
{
    const int W = 640, H = 360, Fps = 30, Frames = 30, ForcedAt = 15;
    static int failures;

    static void Check(bool ok, string what) { Console.WriteLine((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; }

    static bool Throws<T>(Action a) where T : Exception { try { a(); } catch (T) { return true; } catch (Exception) { return false; } return false; }

    // Moving diagonal gradient on a flat chroma plane, so P-frames have something to code.
    static byte[] Frame(int n)
    {
        var f = new byte[W * H * 3 / 2];
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) f[y * W + x] = (byte)(16 + ((x + y + n * 6) & 0x7f));
        for (int i = W * H; i < f.Length; i++) f[i] = (byte)(100 + (n & 0x1f) + (i & 1) * 20);
        return f;
    }

    // Returns the NAL types of an Annex-B unit in order.
    static List<int> Nals(byte[] d)
    {
        var r = new List<int>();
        for (int i = 0; i + 3 < d.Length; i++) if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) { r.Add(d[i + 3] & 0x1f); i += 2; }
        return r;
    }

    static void Validation()
    {
        Func<int, int, int, int, bool> bad = (w, h, fps, kbps) => Throws<ArgumentException>(() => new H264Encoder(new EncoderConfig(w, h, fps, kbps)));
        Check(Throws<ArgumentNullException>(() => new H264Encoder(null)), "null config rejected");
        Check(bad(158, 120, 30, 4000000) && bad(160, 118, 30, 4000000) && bad(1922, 1088, 30, 4000000) && bad(1920, 1090, 30, 4000000), "canvas bounds rejected");
        Check(bad(641, 360, 30, 4000000) && bad(640, 361, 30, 4000000) && bad(0, 0, 30, 4000000) && bad(-160, 120, 30, 4000000), "odd and non-positive canvas rejected");
        Check(bad(640, 360, 0, 4000000) && bad(640, 360, -30, 4000000) && bad(1920, 1088, 255, 4000000) && bad(640, 360, int.MaxValue, 4000000), "frame rate and level bound rejected");
        Check(bad(640, 360, 30, 0) && bad(640, 360, 30, 1499999) && bad(640, 360, 30, 8000001), "bitrate range rejected");
        Check(Throws<NotSupportedException>(() => new H264Encoder(new EncoderConfig(640, 360, 30, 4000000, true))), "hardware flag refused");
    }

    static int Run(string outPath)
    {
        var all = new List<AccessUnit>();
        using (var enc = new H264Encoder(new EncoderConfig(W, H, Fps)))
        {
            Check(Throws<ArgumentNullException>(() => enc.Encode(null, 0)), "null frame rejected");
            Check(Throws<ArgumentException>(() => enc.Encode(new byte[W * H * 3 / 2 - 1], 0)) && Throws<ArgumentException>(() => enc.Encode(new byte[W * H * 3 / 2 + 1], 0)), "wrong frame length rejected");
            Check(Throws<InvalidOperationException>(() => { Exception e = null; var th = new Thread(() => { try { enc.ForceKeyFrame(); } catch (Exception x) { e = x; } }); th.Start(); th.Join(); if (e != null) throw e; }), "other thread rejected");
            for (int i = 0; i < Frames; i++)
            {
                if (i == ForcedAt) enc.ForceKeyFrame();
                all.AddRange(enc.Encode(Frame(i), i * 10000000L / Fps));
            }
            all.AddRange(enc.Drain());
            Check(Throws<InvalidOperationException>(() => enc.Encode(Frame(0), 0)) && Throws<InvalidOperationException>(() => enc.Drain()), "use after drain rejected");
        }
        Check(all.Count == Frames, "frames in == access units out (" + all.Count + ")");
        bool mono = true; for (int i = 1; i < all.Count; i++) if (all[i].PtsHns <= all[i - 1].PtsHns) mono = false;
        Check(mono, "timestamps strictly increase");
        Check(all.Count > 0 && all[0].Keyframe, "first access unit is an IDR");
        Check(all.Count > ForcedAt && all[ForcedAt].Keyframe, "forced key frame lands on frame " + ForcedAt);
        int idrs = 0; bool setsOk = true;
        foreach (var au in all)
        {
            if (!au.Keyframe) continue;
            idrs++; var n = Nals(au.Data);
            int idr = n.IndexOf(5), sps = n.IndexOf(7), pps = n.IndexOf(8);
            if (sps < 0 || pps < 0 || sps > idr || pps > idr) setsOk = false;
        }
        Check(idrs == 2 && setsOk, "SPS and PPS before each of the " + idrs + " IDRs");
        using (var f = File.Create(outPath)) foreach (var au in all) f.Write(au.Data, 0, au.Data.Length);
        return all.Count;
    }

    static void Settings()
    {
        using (var enc = new H264Encoder(new EncoderConfig(W, H, Fps)))
        {
            var r = enc.ReadSettings();
            Check(r.LowLatency == true && (r.RateControlMode == 0 || r.RateControlMode == 4) && r.MeanBitRateBps == 4000000u && r.GopSize == (uint)(Fps * 600), "settings read back: low latency, CBR/LowDelayVBR, 4 Mbit/s, GOP " + r.GopSize);
            Check(r.OutputProfile == 77 && r.OutputWidth == W && r.OutputHeight == H && r.OutputFpsNum == Fps && r.OutputFpsDen == 1 && r.InputStride == W, "type read back: Main, 640x360 at 30/1, stride 640");
            Check(Throws<InvalidOperationException>(() => { Exception e = null; var th = new Thread(() => { try { enc.ReadSettings(); } catch (Exception x) { e = x; } }); th.Start(); th.Join(); if (e != null) throw e; }), "ReadSettings on other thread rejected");
        }
    }

    static void Prepend()
    {
        byte[] hdr = { 0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2 }, idr = { 0, 0, 0, 1, 0x65, 9 }, full = { 0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 9 };
        bool ok = true; AccessUnit au = null;
        try { au = H264Encoder.Finish(idr, 5, hdr); } catch (Exception) { ok = false; }
        Check(ok && au.PrependedSps && au.Keyframe && Nals(au.Data).Count == 3 && au.Data.Length == hdr.Length + idr.Length, "IDR without SPS/PPS gets the sequence header");
        au = H264Encoder.Finish(full, 5, hdr);
        Check(!au.PrependedSps && au.Data.Length == full.Length, "in-band SPS/PPS is not duplicated");
        Check(Throws<EncoderException>(() => H264Encoder.Finish(idr, 5, null)), "IDR without SPS/PPS and no header throws");
        Check(Throws<EncoderException>(() => H264Encoder.Finish(new byte[] { 1, 2, 3, 4, 5 }, 5, hdr)), "non Annex-B payload throws");
    }

    static void Hygiene()
    {
        using (var e = new H264Encoder(new EncoderConfig(160, 120, 30))) { e.Encode(Frame160(), 0); e.Drain(); }
        int before = Process.GetCurrentProcess().HandleCount;
        for (int i = 0; i < 20; i++) using (var e = new H264Encoder(new EncoderConfig(160, 120, 30))) { e.Encode(Frame160(), 0); e.Drain(); }
        GC.Collect(); GC.WaitForPendingFinalizers();
        int after = Process.GetCurrentProcess().HandleCount;
        Check(after - before <= 10, "handle count flat over 20 cycles (" + before + " -> " + after + ")");
        var d = new H264Encoder(new EncoderConfig(160, 120, 30)); d.Dispose(); d.Dispose();
        Check(Throws<ObjectDisposedException>(() => d.Encode(Frame160(), 0)) && Throws<ObjectDisposedException>(() => d.ForceKeyFrame()) && Throws<ObjectDisposedException>(() => d.Drain()), "use after dispose rejected, double dispose is a no-op");
    }

    static byte[] Frame160() { var f = new byte[160 * 120 * 3 / 2]; for (int i = 0; i < f.Length; i++) f[i] = (byte)(i * 7); return f; }

    static int Main(string[] args)
    {
        try { Validation(); Run(args.Length > 0 ? args[0] : "h1.h264"); Settings(); Prepend(); Hygiene(); }
        catch (Exception e) { Console.WriteLine("FAIL unexpected " + e); return 2; }
        Console.WriteLine(failures == 0 ? "ALL PASS" : failures + " FAILED");
        return failures == 0 ? 0 : 1;
    }
}

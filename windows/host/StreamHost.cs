using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX.Direct3D11;

// Stream mode: Windows.exe stream <windowId> <pid> <bundleId> | stream desktop <displayId> <displayUUID> [--timing-out file.jsonl]
// Writes [uint32BE header length][JSON header][JPEG] packets and heartbeats to stdout, reads one 0x06 ack per packet from stdin.
// Stdout carries packets only; errors go to stderr. Before the first frame a failure is one diagnostic line and exit 0; later it closes stdout.
static class StreamHost
{
    const int HeartbeatCount = 5, AckWaitMs = 10000, CapSeconds = 1800, HeaderLimit = 8192;
    const double MaxAgeSeconds = 2;
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    sealed class Target
    {
        public bool Desktop;
        public IntPtr Handle;
        public uint Pid, DisplayId;
        public string Bundle, Uuid, Configuration;
        public double StartedAt;
        public double[] Rect;
    }

    static T Parse<T>(bool ok, T value) { if (!ok) throw new ArgumentException("bad stream arguments"); return value; }

    // Null when the target is gone or no longer capturable; an exception when the arguments are malformed.
    static Target Resolve(string[] a)
    {
        var target = new Target();
        if (a[1] == "desktop")
        {
            uint id;
            Parse(uint.TryParse(a[2], NumberStyles.None, Inv, out id) && id >= 1 && Regex.IsMatch(a[3], "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"), 0);
            target.Desktop = true; target.DisplayId = id; target.Uuid = a[3];
            WindowList.Display found = WindowList.Displays().Find(d => d.Id == id && d.Uuid == a[3]);
            if (found == null) return null;
            target.Handle = found.Monitor; target.Configuration = found.Configuration;
            return target;
        }
        long window; uint pid = 0;
        Parse(long.TryParse(a[1], NumberStyles.None, Inv, out window) && window >= 1 && window <= uint.MaxValue &&
            uint.TryParse(a[2], NumberStyles.None, Inv, out pid) && pid >= 1 && pid <= int.MaxValue && Regex.IsMatch(a[3], "^[A-Za-z0-9._-]{0,255}$"), 0);
        target.Handle = new IntPtr(window); target.Pid = pid; target.Bundle = a[3];
        return WindowList.Locate(target.Handle, pid, a[3], out target.StartedAt, out target.Rect) ? target : null;
    }

    static bool Same(Target first, Target now)
    {
        if (now == null || first.Configuration != now.Configuration || first.StartedAt != now.StartedAt) return false;
        for (int i = 0; first.Rect != null && i < 4; i++) if (first.Rect[i] != now.Rect[i]) return false;
        return true;
    }

    static string Header(Target t, long sequence, int width, int height, double capture, double sent, int replaced, int bytes)
    {
        string common = "\"protocol\":1,\"type\":\"frame\",\"sequence\":" + sequence + ",\"mediaType\":\"image/jpeg\",\"width\":" + width + ",\"height\":" + height +
            ",\"captureTimeSeconds\":" + WindowList.Number(capture) + ",\"sentUptimeSeconds\":" + WindowList.Number(sent) +
            ",\"contentRectPixels\":[0,0," + width + "," + height + "],\"contentScale\":1,\"scaleFactor\":1,\"replacedFrames\":" + replaced + ",\"bytes\":" + bytes;
        return t.Desktop
            ? "{" + common + ",\"kind\":\"desktop\",\"displayId\":" + t.DisplayId + ",\"displayUUID\":\"" + t.Uuid + "\",\"displayConfiguration\":" + t.Configuration + "}"
            : "{" + common + ",\"windowId\":" + t.Handle.ToInt64() + ",\"pid\":" + t.Pid + ",\"bundleId\":\"" + t.Bundle + "\",\"initialWindowRectPoints\":" +
                WindowList.Rectangle(t.Rect[0], t.Rect[1], t.Rect[2], t.Rect[3]) + ",\"processStartedAt\":" + WindowList.Number(t.StartedAt) + "}";
    }

    static double Now() { return Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency; }

    static void Send(Stream stdout, string header, byte[] image)
    {
        byte[] json = Encoding.UTF8.GetBytes(header);
        if (json.Length > HeaderLimit) throw new Exception("header over " + HeaderLimit + " bytes");
        byte[] size = { (byte)(json.Length >> 24), (byte)(json.Length >> 16), (byte)(json.Length >> 8), (byte)json.Length };
        stdout.Write(size, 0, 4); stdout.Write(json, 0, json.Length);
        if (image != null) stdout.Write(image, 0, image.Length);
        stdout.Flush();
    }

    // False when the supervisor went away (end of input) or stopped answering; any byte but 0x06 is a protocol error.
    static bool Ack(Stream stdin)
    {
        var one = new byte[1];
        var read = stdin.ReadAsync(one, 0, 1);
        if (!read.Wait(AckWaitMs) || read.Result == 0) return false;
        if (one[0] != 6) throw new Exception("unexpected ack byte " + one[0]);
        return true;
    }

    internal static int Run(string[] args)
    {
        Stream stdout = Console.OpenStandardOutput(), stdin = Console.OpenStandardInput();
        long sequence = 0;
        int dropped = 0, silent = 0;
        IntPtr d3d = IntPtr.Zero, context = IntPtr.Zero;
        Capture.Grabber grabber = null;
        StreamWriter timing = null;
        try
        {
            Parse(args.Length == 4 || (args.Length == 6 && args[4] == "--timing-out"), 0);
            if (args.Length == 6) timing = new StreamWriter(args[5], false, new UTF8Encoding(false));
            Target first = Resolve(args);
            if (first == null) throw new Exception("target not capturable");
            IDirect3DDevice device = Capture.MakeDevice(out d3d, out context);
            GraphicsCaptureItem item = Capture.ItemFor(!first.Desktop, first.Handle);
            double[] rect = first.Desktop ? null : first.Rect;
            double rectWidth = rect == null ? item.Size.Width : rect[2], rectHeight = rect == null ? item.Size.Height : rect[3];
            // The broker refuses frames whose aspect differs from the window rect by more than two pixels' worth.
            if (Math.Abs((double)item.Size.Width / item.Size.Height - rectWidth / rectHeight) > 2.0 / Math.Min(item.Size.Width, item.Size.Height))
                throw new Exception("capture size " + item.Size.Width + "x" + item.Size.Height + " does not match the window rect");
            grabber = new Capture.Grabber(device, item);
            var life = Stopwatch.StartNew();
            while (life.Elapsed.TotalSeconds < CapSeconds)
            {
                if (!Same(first, Resolve(args))) return 0;
                long start = Stopwatch.GetTimestamp(), arrived;
                Direct3D11CaptureFrame frame;
                try { frame = grabber.Take(start, out arrived, true); }
                catch (TimeoutException)
                {
                    if (sequence == 0 && ++silent >= HeartbeatCount) throw new Exception("no frame from the target");
                    Send(stdout, "{\"protocol\":1,\"type\":\"heartbeat\",\"bytes\":0,\"sentUptimeSeconds\":" + WindowList.Number(Now()) + "}", null);
                    if (!Ack(stdin)) return 0;
                    continue;
                }
                byte[] jpeg; int width, height;
                double capture, readbackMs, encodeMs;
                using (frame)
                {
                    if (frame.ContentSize.Width != grabber.Width || frame.ContentSize.Height != grabber.Height) throw new Exception("content size changed");
                    // The frame time can lie ahead of the QPC read of its arrival; never claim a capture later than it arrived.
                    capture = Math.Min(frame.SystemRelativeTime.TotalSeconds, arrived / (double)Stopwatch.Frequency);
                    long read = Stopwatch.GetTimestamp();
                    Bitmap bitmap = Capture.ReadBack(frame.Surface);
                    long encode = Stopwatch.GetTimestamp();
                    readbackMs = Capture.Ms(encode - read);
                    using (bitmap) jpeg = Capture.Encode(bitmap, out width, out height);
                    encodeMs = Capture.Ms(Stopwatch.GetTimestamp() - encode);
                }
                double sent = Now(), age = sent - capture;
                if (double.IsNaN(age) || age < 0) throw new Exception("frame stamped after it was sent: " + age);
                if (age > MaxAgeSeconds) { dropped++; continue; }
                if (!Same(first, Resolve(args))) return 0;
                int replaced = grabber.Replaced + dropped;
                Send(stdout, Header(first, ++sequence, width, height, capture, sent, replaced, jpeg.Length), jpeg);
                if (timing != null)
                    timing.WriteLine("{\"i\":" + sequence + ",\"capture_ms\":" + Capture.Ms(arrived - start).ToString("F2", Inv) + ",\"readback_ms\":" + readbackMs.ToString("F2", Inv) +
                        ",\"encode_ms\":" + encodeMs.ToString("F2", Inv) + ",\"send_ms\":" + ((Now() - sent) * 1000).ToString("F2", Inv) + ",\"bytes\":" + jpeg.Length + ",\"replaced\":" + replaced + "}");
                if (!Ack(stdin)) return 0;
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            if (sequence > 0) return 1;
            try { byte[] line = Encoding.UTF8.GetBytes(WindowList.Diagnostic("capture_unavailable", "starting_capture") + "\n"); stdout.Write(line, 0, line.Length); stdout.Flush(); }
            catch (IOException) { return 1; }
            return 0;
        }
        finally
        {
            if (grabber != null) grabber.Dispose();
            if (context != IntPtr.Zero) Marshal.Release(context);
            if (d3d != IntPtr.Zero) Marshal.Release(d3d);
            if (timing != null) timing.Dispose();
        }
    }
}

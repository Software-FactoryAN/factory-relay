using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

// One observation still of a window or the primary display: Windows Graphics Capture, read-back, JPEG.
//   Capture.exe window <hwnd> | monitor primary  [--n 1] [--mode cold|warm] [--timing file.jsonl] [--save file.jpg] [--gap-ms 0]
// cold builds the capture session per observation; warm keeps one session and takes the next frame. Needs a window that repaints.
// Stages per observation: capture (request to frame arrival), readback (GPU surface to bitmap), encode (scale + JPEG).
// Stdout carries only the summary line; the JPEG goes to --save.
static class Capture
{
    const int MaxEdge = 2048, MaxJpegBytes = 4 * 1024 * 1024, JpegQuality = 70, FrameWaitMs = 2000, ReadbackWaitMs = 2000;

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
        IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
    }
    [ComImport, Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMemoryBufferByteAccess { [PreserveSig] int GetBuffer(out IntPtr buffer, out uint capacity); }

    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string src, int len, out IntPtr hs);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hs);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr sw, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr ctx);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr graphicsDevice);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(long point, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] static extern void Copy(IntPtr to, IntPtr from, UIntPtr size);

    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " hr=0x" + hr.ToString("X")); }
    static double Ms(long ticks) { return ticks * 1000.0 / Stopwatch.Frequency; }

    static IDirect3DDevice MakeDevice(out IntPtr d3d, out IntPtr ctx)
    {
        int level;
        Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d3d, out level, out ctx), "D3D11CreateDevice");
        Guid dxgiIid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        IntPtr dxgi, device;
        Check(Marshal.QueryInterface(d3d, ref dxgiIid, out dxgi), "IDXGIDevice");
        int hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi, out device);
        Marshal.Release(dxgi);
        Check(hr, "CreateDirect3D11DeviceFromDXGIDevice");
        return (IDirect3DDevice)Marshal.GetObjectForIUnknown(device);
    }

    static GraphicsCaptureItem ItemFor(bool window, IntPtr handle)
    {
        Guid interopIid = new Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), itemIid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
        IntPtr name, factory;
        const string Class = "Windows.Graphics.Capture.GraphicsCaptureItem";
        WindowsCreateString(Class, Class.Length, out name);
        int hr = RoGetActivationFactory(name, ref interopIid, out factory);
        WindowsDeleteString(name);
        Check(hr, "RoGetActivationFactory");
        var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factory);
        return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(window ? interop.CreateForWindow(handle, ref itemIid) : interop.CreateForMonitor(handle, ref itemIid));
    }

    // Keeps only the newest frame; an older one that was never taken counts as replaced, as on the Mac host.
    sealed class Grabber : IDisposable
    {
        readonly Direct3D11CaptureFramePool pool;
        readonly GraphicsCaptureSession session;
        readonly object gate = new object();
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        Direct3D11CaptureFrame slot;
        long slotTicks;
        public int Replaced;

        public Grabber(IDirect3DDevice device, GraphicsCaptureItem item)
        {
            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
            pool.FrameArrived += new Windows.Foundation.TypedEventHandler<Direct3D11CaptureFramePool, object>(OnArrived);
            session = pool.CreateCaptureSession(item);
            session.IsCursorCaptureEnabled = false;
            session.StartCapture();
        }

        void OnArrived(Direct3D11CaptureFramePool sender, object args)
        {
            Direct3D11CaptureFrame next;
            while ((next = sender.TryGetNextFrame()) != null)
                lock (gate)
                {
                    if (slot != null) { slot.Dispose(); Replaced++; }
                    slot = next;
                    slotTicks = Stopwatch.GetTimestamp();
                }
            signal.Set();
        }

        // Next frame that arrived at or after "after"; an older one is dropped.
        public Direct3D11CaptureFrame Take(long after, out long arrived)
        {
            long limit = after + FrameWaitMs * Stopwatch.Frequency / 1000;
            while (true)
            {
                lock (gate)
                {
                    if (slot != null && slotTicks >= after) { var frame = slot; slot = null; arrived = slotTicks; return frame; }
                    if (slot != null) { slot.Dispose(); slot = null; }
                }
                long left = (limit - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
                if (left <= 0) throw new TimeoutException("no frame within " + FrameWaitMs + " ms");
                signal.WaitOne((int)left);
            }
        }

        // The pool goes before the session, or the D3D device stays alive.
        public void Dispose()
        {
            pool.Dispose();
            session.Dispose();
            lock (gate) { if (slot != null) slot.Dispose(); slot = null; }
            signal.Dispose();
        }
    }

    // BGRA rows are copied one by one: the GPU buffer's stride can be wider than width * 4.
    static Bitmap ReadBack(IDirect3DSurface surface)
    {
        var operation = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface);
        var done = new ManualResetEvent(false);
        operation.Completed = new Windows.Foundation.AsyncOperationCompletedHandler<SoftwareBitmap>((o, status) => done.Set());
        if (!done.WaitOne(ReadbackWaitMs)) throw new TimeoutException("read-back");
        done.Dispose();
        using (SoftwareBitmap software = operation.GetResults())
        using (BitmapBuffer buffer = software.LockBuffer(BitmapBufferAccessMode.Read))
        using (var reference = buffer.CreateReference())
        {
            IntPtr source;
            uint capacity;
            Check(((IMemoryBufferByteAccess)(object)reference).GetBuffer(out source, out capacity), "GetBuffer");
            int stride = buffer.GetPlaneDescription(0).Stride, width = software.PixelWidth, height = software.PixelHeight;
            if (width < 1 || height < 1 || stride < width * 4 || (long)stride * height > capacity) throw new Exception("unexpected surface layout");
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
            BitmapData target = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < height; y++)
                    Copy(new IntPtr(target.Scan0.ToInt64() + (long)y * target.Stride), new IntPtr(source.ToInt64() + (long)y * stride), (UIntPtr)(uint)(width * 4));
            }
            finally { bitmap.UnlockBits(target); }
            return bitmap;
        }
    }

    static byte[] Encode(Bitmap bitmap, out int width, out int height)
    {
        width = bitmap.Width; height = bitmap.Height;
        Bitmap shown = bitmap;
        try
        {
            if (Math.Max(width, height) > MaxEdge)
            {
                double scale = (double)MaxEdge / Math.Max(width, height);
                width = Math.Max(1, (int)Math.Round(width * scale)); height = Math.Max(1, (int)Math.Round(height * scale));
                shown = new Bitmap(width, height, PixelFormat.Format32bppRgb);
                using (Graphics g = Graphics.FromImage(shown)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(bitmap, 0, 0, width, height); }
            }
            ImageCodecInfo codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
            using (var memory = new MemoryStream())
            using (var parameters = new EncoderParameters(1))
            {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)JpegQuality);
                shown.Save(memory, codec, parameters);
                byte[] jpeg = memory.ToArray();
                if (jpeg.Length < 4 || jpeg.Length > MaxJpegBytes || jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[jpeg.Length - 2] != 0xff || jpeg[jpeg.Length - 1] != 0xd9)
                    throw new Exception("JPEG outside the wire contract: " + jpeg.Length + " bytes");
                return jpeg;
            }
        }
        finally { if (shown != bitmap) shown.Dispose(); }
    }

    sealed class Observation { public double CaptureMs, ReadbackMs, EncodeMs, FrameAgeMs; public int Width, Height, Replaced; public byte[] Jpeg; }

    static Observation Observe(IDirect3DDevice device, GraphicsCaptureItem item, Grabber warm)
    {
        long start = Stopwatch.GetTimestamp(), arrived;
        Grabber grabber = warm ?? new Grabber(device, item);
        try
        {
            var result = new Observation();
            using (Direct3D11CaptureFrame frame = grabber.Take(start, out arrived))
            {
                result.CaptureMs = Ms(arrived - start);
                // QPC arrival minus SystemRelativeTime. Measured about -15 ms on a cold session's first frame, so the frame time can lie ahead of
                // the QPC read; a packet's send time must be stamped after this and the pair checked before it is sent.
                result.FrameAgeMs = Ms(arrived) - frame.SystemRelativeTime.TotalMilliseconds;
                result.Replaced = grabber.Replaced;
                long read = Stopwatch.GetTimestamp();
                Bitmap bitmap = ReadBack(frame.Surface);
                long encode = Stopwatch.GetTimestamp();
                result.ReadbackMs = Ms(encode - read);
                using (bitmap) result.Jpeg = Encode(bitmap, out result.Width, out result.Height);
                result.EncodeMs = Ms(Stopwatch.GetTimestamp() - encode);
            }
            return result;
        }
        finally { if (warm == null) grabber.Dispose(); }
    }

    static string N(double value) { return value.ToString("F2", CultureInfo.InvariantCulture); }
    static double Pct(List<double> sorted, double p) { return sorted.Count == 0 ? double.NaN : sorted[Math.Max(0, (int)Math.Ceiling(p * sorted.Count) - 1)]; }
    static string Summary(string name, List<double> values)
    {
        var sorted = new List<double>(values);
        sorted.Sort();
        return "\"" + name + "\":{\"p50\":" + N(Pct(sorted, 0.5)) + ",\"p95\":" + N(Pct(sorted, 0.95)) + ",\"max\":" + N(sorted.Count == 0 ? double.NaN : sorted[sorted.Count - 1]) + "}";
    }

    static int Main(string[] argv)
    {
        try
        {
            if (argv.Length < 2) { Console.Error.WriteLine("usage: Capture.exe window <hwnd> | monitor primary [--n N] [--mode cold|warm] [--timing f] [--save f] [--gap-ms N]"); return 2; }
            var options = new Dictionary<string, string>();
            for (int i = 2; i + 1 < argv.Length; i += 2) options[argv[i].TrimStart('-')] = argv[i + 1];
            Func<string, string, string> get = (key, fallback) => options.ContainsKey(key) ? options[key] : fallback;
            int count = int.Parse(get("n", "1")), gap = int.Parse(get("gap-ms", "0"));
            bool warm = get("mode", "cold") == "warm", window = argv[0] == "window";
            if (count < 1 || (!window && (argv[0] != "monitor" || argv[1] != "primary")) || (!warm && get("mode", "cold") != "cold")) throw new ArgumentException("bad arguments");
            SetProcessDPIAware();
            IntPtr handle = window ? new IntPtr(long.Parse(argv[1])) : MonitorFromPoint(0, 1);
            if (window && !IsWindow(handle)) throw new ArgumentException("no such window");
            IntPtr d3d, context;
            IDirect3DDevice device = MakeDevice(out d3d, out context);
            GraphicsCaptureItem item = ItemFor(window, handle);
            Grabber keep = warm ? new Grabber(device, item) : null;
            var capture = new List<double>(); var readback = new List<double>(); var encode = new List<double>(); var total = new List<double>(); var age = new List<double>();
            int failures = 0;
            string last = null, timingPath = get("timing", null), savePath = get("save", null);
            using (var timing = timingPath == null ? null : new StreamWriter(timingPath, false, new System.Text.UTF8Encoding(false)))
            {
                for (int i = 0; i < count; i++)
                {
                    try
                    {
                        Observation o = Observe(device, item, keep);
                        capture.Add(o.CaptureMs); readback.Add(o.ReadbackMs); encode.Add(o.EncodeMs); age.Add(o.FrameAgeMs);
                        total.Add(o.CaptureMs + o.ReadbackMs + o.EncodeMs);
                        if (timing != null) timing.WriteLine("{\"i\":" + i + ",\"capture_ms\":" + N(o.CaptureMs) + ",\"readback_ms\":" + N(o.ReadbackMs) + ",\"encode_ms\":" + N(o.EncodeMs) +
                            ",\"frame_age_ms\":" + N(o.FrameAgeMs) + ",\"bytes\":" + o.Jpeg.Length + ",\"width\":" + o.Width + ",\"height\":" + o.Height + ",\"replaced\":" + o.Replaced + "}");
                        if (savePath != null && i == count - 1) File.WriteAllBytes(savePath, o.Jpeg);
                    }
                    catch (Exception error) { failures++; last = error.GetType().Name + ": " + error.Message; }
                    if (gap > 0) Thread.Sleep(gap);
                }
            }
            if (keep != null) keep.Dispose();
            Marshal.Release(context); Marshal.Release(d3d);
            Console.Out.WriteLine("{\"mode\":\"" + (warm ? "warm" : "cold") + "\",\"n\":" + total.Count + ",\"failures\":" + failures + "," + Summary("capture_ms", capture) + "," +
                Summary("readback_ms", readback) + "," + Summary("encode_ms", encode) + "," + Summary("total_ms", total) + "," + Summary("frame_age_ms", age) + "}");
            if (last != null) Console.Error.WriteLine("last failure: " + last);
            return failures == 0 ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}

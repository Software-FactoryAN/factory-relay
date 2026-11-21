using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

// Window and display list and diagnose for the Windows relay host, in the packet shapes of the Mac host
// (host/AppletsHost.swift). Process start is Unix seconds, the unit of control/AppletsControl.swift:64.
static class WindowList
{
    const int PacketLimitBytes = 7000, MaxWindows = 100, MaxDisplays = 32, MaxEdgePixels = 16384, MaxNameChars = 80;
    const uint ProcessQueryLimitedInformation = 0x1000, WsExToolWindow = 0x80, GwOwner = 4, DwmaCloaked = 14, DwmaExtendedFrameBounds = 9;
    const long UnixEpochAsFileTimeSeconds = 11644473600;

    internal sealed class Display { public IntPtr Monitor; public uint Id; public string Uuid, Configuration, Row; }

    delegate bool WindowProc(IntPtr window, IntPtr data);
    delegate bool MonitorProc(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MonitorInfo
    {
        public int Size; public Rect Monitor, Work; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    [DllImport("user32.dll", SetLastError = true)] static extern bool EnumWindows(WindowProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowLongW(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetRect(IntPtr window, uint attribute, out Rect value, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);

    internal static string Text(string value)
    {
        var json = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < 0x20 || c > 0x7e) json.AppendFormat("\\u{0:x4}", (int)c);
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }
    internal static string Number(double value) { return value.ToString("R", CultureInfo.InvariantCulture); }
    internal static string Rectangle(double x, double y, double w, double h) { return "[" + Number(x) + "," + Number(y) + "," + Number(w) + "," + Number(h) + "]"; }

    // The visible frame, so the rect matches what Graphics Capture returns and not the invisible resize border.
    static bool Bounds(IntPtr window, out Rect rect)
    {
        return DwmGetRect(window, DwmaExtendedFrameBounds, out rect, Marshal.SizeOf(typeof(Rect))) == 0 || GetWindowRect(window, out rect);
    }

    // The list filters for one window; false once it is no longer a capturable target of that process.
    internal static bool Locate(IntPtr window, uint pid, string bundleId, out double startedAt, out double[] rect)
    {
        startedAt = 0; rect = null;
        int cloaked;
        Rect r;
        uint owner;
        if (!IsWindow(window) || !IsWindowVisible(window) || IsIconic(window) || DwmGetWindowAttribute(window, DwmaCloaked, out cloaked, 4) != 0 || cloaked != 0 || !Bounds(window, out r)) return false;
        GetWindowThreadProcessId(window, out owner);
        int width = r.Right - r.Left, height = r.Bottom - r.Top;
        string[] info = owner != pid ? null : Owner(pid, out startedAt);
        if (info == null || info[1] != bundleId || width < 1 || height < 1 || width > MaxEdgePixels || height > MaxEdgePixels) return false;
        rect = new double[] { r.Left, r.Top, width, height };
        return true;
    }

    // Null when the process cannot be read: a window whose owner is unknown is left out, as on the Mac.
    internal static string[] Owner(uint pid, out double startedAt)
    {
        startedAt = 0;
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            FileTime created, exited, kernel, user;
            var image = new StringBuilder(1024);
            int size = image.Capacity;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || !QueryFullProcessImageNameW(process, 0, image, ref size)) return null;
            long ticks = ((long)created.High << 32) | created.Low;
            startedAt = ticks / 1e7 - UnixEpochAsFileTimeSeconds;
            if (startedAt <= 0) return null;
            string name = Path.GetFileNameWithoutExtension(image.ToString());
            if (name.Length > MaxNameChars) name = name.Substring(0, MaxNameChars);
            var bundle = new StringBuilder("win.");
            foreach (char c in Path.GetFileName(image.ToString()))
                bundle.Append(c < 0x80 && (char.IsLetterOrDigit(c) || c == '.' || c == '_' || c == '-') ? c : '_');
            return name.Length == 0 ? null : new[] { name, bundle.ToString(0, Math.Min(bundle.Length, 255)) };
        }
        finally { CloseHandle(process); }
    }

    static List<string> WindowRows()
    {
        var rows = new List<string>();
        uint ownPid = (uint)Process.GetCurrentProcess().Id;
        if (!EnumWindows((window, data) =>
        {
            int cloaked;
            Rect rect;
            uint pid;
            if (rows.Count >= MaxWindows || !IsWindowVisible(window) || IsIconic(window) || GetWindow(window, GwOwner) != IntPtr.Zero ||
                (GetWindowLongW(window, -20) & WsExToolWindow) != 0 || GetWindowTextLengthW(window) == 0 ||
                DwmGetWindowAttribute(window, DwmaCloaked, out cloaked, 4) != 0 || cloaked != 0 || !Bounds(window, out rect)) return true;
            long id = window.ToInt64();
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            GetWindowThreadProcessId(window, out pid);
            double startedAt = 0;
            string[] owner = pid == 0 || pid == ownPid || id < 1 || id > uint.MaxValue || width < 1 || height < 1 ||
                width > MaxEdgePixels || height > MaxEdgePixels ? null : Owner(pid, out startedAt);
            if (owner == null) return true;
            rows.Add("{\"bundleId\":" + Text(owner[1]) + ",\"displayName\":" + Text(owner[0]) + ",\"pid\":" + pid +
                ",\"processStartedAt\":" + Number(startedAt) + ",\"title\":" + Text(owner[0]) + ",\"windowId\":" + id +
                ",\"windowRectPoints\":" + Rectangle(rect.Left, rect.Top, width, height) + "}");
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "EnumWindows failed");
        return rows;
    }

    // Display ids and UUIDs are derived from the device name, so they stay stable when the enumeration order changes.
    static List<string> DisplayRows() { return Displays().ConvertAll(d => d.Row); }

    internal static List<Display> Displays()
    {
        var rows = new List<Display>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, dc, clip, data) =>
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (rows.Count >= MaxDisplays || !GetMonitorInfoW(monitor, ref info)) return true;
            int width = info.Monitor.Right - info.Monitor.Left, height = info.Monitor.Bottom - info.Monitor.Top;
            if (width < 1 || height < 1 || width > MaxEdgePixels || height > MaxEdgePixels) return true;
            byte[] hash = MD5.Create().ComputeHash(Encoding.UTF8.GetBytes(info.Device));
            uint id = BitConverter.ToUInt32(hash, 0);
            if (id == 0) id = 1;
            string uuid = new Guid(hash).ToString("D");
            string configuration = "{\"boundsPoints\":" + Rectangle(info.Monitor.Left, info.Monitor.Top, width, height) +
                ",\"pixelHeight\":" + height + ",\"pixelWidth\":" + width + ",\"rotation\":0,\"scaleX\":1,\"scaleY\":1}";
            rows.Add(new Display { Monitor = monitor, Id = id, Uuid = uuid, Configuration = configuration,
                Row = "{\"displayConfiguration\":" + configuration + ",\"displayId\":" + id + ",\"displayUUID\":" + Text(uuid) +
                ",\"kind\":\"desktop\",\"main\":" + ((info.Flags & 1) != 0 ? "true" : "false") + "}" });
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "EnumDisplayMonitors failed");
        return rows;
    }

    static string Packet(List<string> displays, List<string> windows)
    {
        // Same cut as the Mac host: rows are added while the whole packet stays under the limit.
        var kept = new List<string>();
        foreach (string row in windows)
        {
            kept.Add(row);
            if (Build(displays, kept).Length >= PacketLimitBytes) { kept.RemoveAt(kept.Count - 1); break; }
        }
        return Build(displays, kept);
    }
    static string Build(List<string> displays, List<string> windows)
    {
        return "{\"displays\":[" + string.Join(",", displays) + "],\"protocol\":1,\"type\":\"windows\",\"windows\":[" + string.Join(",", windows) + "]}";
    }

    static string Diagnostic() { return Diagnostic("permission_preflight", "app_ready"); }

    internal static string Diagnostic(string code, string stage)
    {
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        return "{\"accessibility\":true,\"bundleId\":\"com.factory.applets.host\",\"bundlePath\":" + Text(Path.GetDirectoryName(executable)) +
            ",\"code\":\"" + code + "\",\"executablePath\":" + Text(executable) + ",\"launchMode\":\"launchservices-ipc\"" +
            ",\"lifecycle\":{\"appKitInitialized\":true,\"eventLoopRunning\":true,\"launchFinished\":true,\"mainThread\":true}" +
            ",\"permissionRequested\":false,\"processId\":" + Process.GetCurrentProcess().Id + ",\"protocol\":1,\"screenRecording\":true" +
            ",\"stage\":\"" + stage + "\",\"type\":\"diagnostic\"}";
    }

    static int Main(string[] args)
    {
        try
        {
            SetProcessDPIAware();
            if (args.Length > 0 && args[0] == "stream") return StreamHost.Run(args);
            if (args.Length != 1 || (args[0] != "windows" && args[0] != "diagnose")) throw new ArgumentException("usage: Windows.exe windows|diagnose");
            Console.Out.Write((args[0] == "windows" ? Packet(DisplayRows(), WindowRows()) : Diagnostic()) + "\n");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}

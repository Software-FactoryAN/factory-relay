using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// H.264 encoder core for the host: Microsoft software MFT, synchronous, system-memory NV12 in, Annex-B access units out.
// Settings follow the Annular encoder (low latency, CBR, no B-frames, long GOP, packed NV12 rows, ForceKeyFrame as VT_UI4).
// One thread owns an instance. The hardware MFT, async events and live bitrate are a later slice and extend this partial class.
public sealed class EncoderException : Exception
{
    public readonly int HResultCode; public readonly string Stage;
    public EncoderException(string stage, int hr, string message) : base(stage + ": " + message + " (0x" + hr.ToString("X8") + ")") { Stage = stage; HResultCode = hr; }
}

public sealed class EncoderConfig
{
    public const int MinWidth = 160, MaxWidth = 1920, MinHeight = 120, MaxHeight = 1088;
    public const int DefaultBitrateBps = 4000000, MinBitrateBps = 1500000, MaxBitrateBps = 8000000;
    public const long MaxMacroblocksPerSecond = 2073600L; // H.264 level 5.2
    public int Width, Height, Fps, BitrateBps; public bool PreferHardware;
    public EncoderConfig(int width, int height, int fps, int bitrateBps = DefaultBitrateBps, bool preferHardware = false)
    { Width = width; Height = height; Fps = fps; BitrateBps = bitrateBps; PreferHardware = preferHardware; }
}

public sealed class AccessUnit
{
    public readonly byte[] Data; public readonly long PtsHns; public readonly bool Keyframe, PrependedSps;
    public AccessUnit(byte[] data, long ptsHns, bool keyframe, bool prependedSps) { Data = data; PtsHns = ptsHns; Keyframe = keyframe; PrependedSps = prependedSps; }
}

public sealed partial class H264Encoder : IDisposable
{
    [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFTransform
    {
        // Slots that are never called are placeholders.
        [PreserveSig] int s0(); [PreserveSig] int s1(); [PreserveSig] int s2();
        [PreserveSig] int GetInputStreamInfo(uint id, out MftInputStreamInfo info);
        [PreserveSig] int GetOutputStreamInfo(uint id, out MftOutputStreamInfo info);
        [PreserveSig] int GetAttributes(out IntPtr attrs);
        [PreserveSig] int s3(); [PreserveSig] int s4(); [PreserveSig] int s5(); [PreserveSig] int s6(); [PreserveSig] int s7(); [PreserveSig] int GetOutputAvailableType(uint id, uint index, out IntPtr type);
        [PreserveSig] int SetInputType(uint id, IntPtr type, uint flags);
        [PreserveSig] int SetOutputType(uint id, IntPtr type, uint flags);
        [PreserveSig] int GetInputCurrentType(uint id, out IntPtr type);
        [PreserveSig] int GetOutputCurrentType(uint id, out IntPtr type);
        [PreserveSig] int s8(); [PreserveSig] int s9(); [PreserveSig] int s10(); [PreserveSig] int s11();
        [PreserveSig] int ProcessMessage(int message, IntPtr param);
        [PreserveSig] int ProcessInput(uint id, IntPtr sample, uint flags);
        [PreserveSig] int ProcessOutput(uint flags, uint count, ref MftOutputDataBuffer buffers, out uint status);
    }
    [StructLayout(LayoutKind.Sequential)] struct MftInputStreamInfo { public long MaxLatency; public uint Flags, Size, MaxLookahead, Alignment; }
    [StructLayout(LayoutKind.Sequential)] struct MftOutputStreamInfo { public uint Flags, Size, Alignment; }
    [StructLayout(LayoutKind.Sequential)] struct MftOutputDataBuffer { public uint StreamId; public IntPtr Sample; public uint Status; public IntPtr Events; }

    // IMFMediaType and IMFSample start with the IMFAttributes slots; the methods after SetGUID are never called and are left out.
    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFAttributes
    {
        [PreserveSig] int g0(); [PreserveSig] int g1(); [PreserveSig] int g2(); [PreserveSig] int g3();
        [PreserveSig] int GetUINT32(ref Guid k, out uint v); [PreserveSig] int GetUINT64(ref Guid k, out ulong v); [PreserveSig] int g4();
        [PreserveSig] int GetGUID(ref Guid k, out Guid v); [PreserveSig] int g5(); [PreserveSig] int g6(); [PreserveSig] int g7();
        [PreserveSig] int GetBlobSize(ref Guid k, out uint size); [PreserveSig] int GetBlob(ref Guid k, byte[] buf, uint size, out uint written);
        [PreserveSig] int g8(); [PreserveSig] int g9(); [PreserveSig] int g10(); [PreserveSig] int g11(); [PreserveSig] int g12();
        [PreserveSig] int SetUINT32(ref Guid k, uint v); [PreserveSig] int SetUINT64(ref Guid k, ulong v); [PreserveSig] int g13();
        [PreserveSig] int SetGUID(ref Guid k, ref Guid v);
    }
    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSample
    {
        [PreserveSig] int a0(); [PreserveSig] int a1(); [PreserveSig] int a2(); [PreserveSig] int a3(); [PreserveSig] int a4(); [PreserveSig] int a5(); [PreserveSig] int a6(); [PreserveSig] int a7(); [PreserveSig] int a8(); [PreserveSig] int a9();
        [PreserveSig] int a10(); [PreserveSig] int a11(); [PreserveSig] int a12(); [PreserveSig] int a13(); [PreserveSig] int a14(); [PreserveSig] int a15(); [PreserveSig] int a16(); [PreserveSig] int a17(); [PreserveSig] int a18(); [PreserveSig] int a19();
        [PreserveSig] int a20(); [PreserveSig] int a21(); [PreserveSig] int a22(); [PreserveSig] int a23(); [PreserveSig] int a24(); [PreserveSig] int a25(); [PreserveSig] int a26(); [PreserveSig] int a27(); [PreserveSig] int a28(); [PreserveSig] int a29();
        [PreserveSig] int GetSampleFlags(out uint f); [PreserveSig] int SetSampleFlags(uint f);
        [PreserveSig] int GetSampleTime(out long t); [PreserveSig] int SetSampleTime(long t);
        [PreserveSig] int GetSampleDuration(out long d); [PreserveSig] int SetSampleDuration(long d);
        [PreserveSig] int GetBufferCount(out uint n); [PreserveSig] int GetBufferByIndex(uint i, out IntPtr b);
        [PreserveSig] int ConvertToContiguousBuffer(out IntPtr b); [PreserveSig] int AddBuffer(IntPtr b);
    }
    [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr data, out uint max, out uint cur); [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out uint len); [PreserveSig] int SetCurrentLength(uint len);
    }
    [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICodecAPI
    {
        [PreserveSig] int IsSupported(ref Guid api); [PreserveSig] int IsModifiable(ref Guid api);
        [PreserveSig] int GetParameterRange(ref Guid api, IntPtr min, IntPtr max, IntPtr step); [PreserveSig] int GetParameterValues(ref Guid api, IntPtr values, out uint n);
        [PreserveSig] int GetDefaultValue(ref Guid api, IntPtr value); [PreserveSig] int GetValue(ref Guid api, IntPtr value); [PreserveSig] int SetValue(ref Guid api, IntPtr value);
    }

    [DllImport("mfplat.dll")] static extern int MFStartup(uint version, uint flags);
    [DllImport("mfplat.dll")] static extern int MFShutdown();
    [DllImport("mfplat.dll")] static extern int MFCreateMediaType(out IntPtr type);
    [DllImport("mfplat.dll")] static extern int MFCreateSample(out IntPtr sample);
    [DllImport("mfplat.dll")] static extern int MFCreateMemoryBuffer(uint size, out IntPtr buf);
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr obj);
    [DllImport("oleaut32.dll")] static extern int VariantClear(IntPtr variant);

    static Guid G(string s) { return new Guid(s); }
    static readonly Guid ClsidSoftware = G("6ca50344-051a-4ded-9779-a43305165e35"), IidTransform = G("bf94c121-5b05-4e6f-8000-ba598961414d");
    static readonly Guid Video = G("73646976-0000-0010-8000-00aa00389b71"), Nv12 = G("3231564e-0000-0010-8000-00aa00389b71"), H264 = G("34363248-0000-0010-8000-00aa00389b71");
    static readonly Guid MtMajor = G("48eba18e-f8c9-4687-bf11-0a74c9f96a8f"), MtSub = G("f7e34c9a-42e8-4714-b74b-cb29d72c35e5"), MtFrameSize = G("1652c33d-d6b2-4012-b834-72030849a37d");
    static readonly Guid MtFrameRate = G("c459a2e8-3d2c-4e44-b132-fee5156c7bb0"), MtPixelAspect = G("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6"), MtInterlace = G("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    static readonly Guid MtAvgBitrate = G("20332624-fb0d-4d9e-bd0d-cbf6786c102e"), MtProfile = G("ad76a80b-2d5c-4e0b-b375-64e520137036"), MtStride = G("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    static readonly Guid MtSeqHeader = G("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
    static readonly Guid ApiLowLatency = G("9c27891a-ed7a-40e1-88e8-b22727a024ee"), ApiRateControl = G("1c0608e9-370c-4710-8a58-cb6181c42423"), ApiBitrate = G("f7222374-2144-4815-b550-a37f8e12ee52");
    static readonly Guid ApiBFrames = G("8d390aac-dc5c-4200-b57f-814d04babab2"), ApiGop = G("95f31b26-95a4-41aa-9303-246a7fc6eef1"), ApiForceKey = G("398c1b98-8353-475a-9ef2-8f265d260345");
    const int MessageDrain = 1, MessageBegin = 0x10000000, MessageEnd = 0x10000001, VtBool = 11, VtUi4 = 19, FrameMultiple = 2;
    const int ENotAccepting = unchecked((int)0xC00D36B5), ENeedMoreInput = unchecked((int)0xC00D6D72), EBufferTooSmall = unchecked((int)0xC00D36B1), EStreamChange = unchecked((int)0xC00D6D61);
    const int EInvalidArg = unchecked((int)0x80070057), ENotImpl = unchecked((int)0x80004001), ENotFound = unchecked((int)0x80070490);
    enum State { Open, Drained, Disposed }

    public readonly EncoderConfig Config;
    IMFTransform t; ICodecAPI api; State state; bool mfStarted; readonly int owner, fps;
    byte[] seqHeader; readonly byte[] zeros; string typeOrder; int inSize, outSize = 1 << 20, bpHr; uint outFlags;

    public H264Encoder(EncoderConfig config)
    {
        Validate(config);
        Config = config; fps = config.Fps; owner = Thread.CurrentThread.ManagedThreadId; zeros = new byte[config.Width * config.Height * 3 / 2];
        try
        {
            Need("MFStartup", MFStartup(0x00020070, 0)); mfStarted = true;
            Guid clsid = ClsidSoftware, iid = IidTransform; IntPtr obj;
            Need("CoCreateInstance", CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out obj));
            t = (IMFTransform)Marshal.GetObjectForIUnknown(obj); Marshal.Release(obj);
            api = t as ICodecAPI;
            if (api == null) throw new EncoderException("ICodecAPI", ENotImpl, "encoder does not expose ICodecAPI");
            Configure();
        }
        catch { Dispose(); throw; }
    }

    static void Validate(EncoderConfig c)
    {
        if (c == null) throw new ArgumentNullException("config");
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("the VARIANT layout used here is x64");
        if (c.PreferHardware) throw new NotSupportedException("hardware encoder is not part of this build");
        if (c.Width < EncoderConfig.MinWidth || c.Width > EncoderConfig.MaxWidth || c.Height < EncoderConfig.MinHeight || c.Height > EncoderConfig.MaxHeight) throw new ArgumentOutOfRangeException("config", "canvas outside 160x120..1920x1088");
        if (((c.Width | c.Height) & 1) != 0) throw new ArgumentException("canvas dimensions must be even", "config");
        if (c.Fps < 1 || ((c.Width + 15) / 16) * ((c.Height + 15) / 16) * (long)c.Fps > EncoderConfig.MaxMacroblocksPerSecond) throw new ArgumentOutOfRangeException("config", "frame rate beyond the level 5.2 macroblock rate");
        if (c.BitrateBps < EncoderConfig.MinBitrateBps || c.BitrateBps > EncoderConfig.MaxBitrateBps) throw new ArgumentOutOfRangeException("config", "bitrate outside 1.5-8 Mbit/s");
    }

    static void Need(string stage, int hr) { if (hr != 0) throw new EncoderException(stage, hr, "call failed"); }

    // ICodecAPI takes a 24-byte x64 VARIANT.
    int SetApi(Guid key, ushort vt, ulong val)
    {
        IntPtr v = Marshal.AllocHGlobal(24);
        try { for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(v, i, 0); Marshal.WriteInt16(v, 0, (short)vt); Marshal.WriteInt64(v, 8, (long)val); return api.SetValue(ref key, v); }
        finally { Marshal.FreeHGlobal(v); }
    }

    IntPtr NewType(bool h264)
    {
        IntPtr mt; Need("MFCreateMediaType", MFCreateMediaType(out mt));
        IMFAttributes a = (IMFAttributes)Marshal.GetObjectForIUnknown(mt);
        Guid k = MtMajor, v = Video; a.SetGUID(ref k, ref v);
        k = MtSub; v = h264 ? H264 : Nv12; a.SetGUID(ref k, ref v);
        k = MtFrameSize; a.SetUINT64(ref k, ((ulong)(uint)Config.Width << 32) | (uint)Config.Height);
        k = MtFrameRate; a.SetUINT64(ref k, ((ulong)(uint)fps << 32) | 1u);
        k = MtPixelAspect; a.SetUINT64(ref k, (1UL << 32) | 1u);
        k = MtInterlace; a.SetUINT32(ref k, 2);
        if (h264) { k = MtAvgBitrate; a.SetUINT32(ref k, (uint)Config.BitrateBps); k = MtProfile; a.SetUINT32(ref k, 77); }
        else { k = MtStride; a.SetUINT32(ref k, (uint)Config.Width); }
        Marshal.ReleaseComObject(a);
        return mt;
    }

    bool CurrentOutputMatches(IntPtr want)
    {
        IntPtr cur;
        if (t.GetOutputCurrentType(0, out cur) != 0 || cur == IntPtr.Zero) return false;
        IMFAttributes c = (IMFAttributes)Marshal.GetObjectForIUnknown(cur), w = (IMFAttributes)Marshal.GetObjectForIUnknown(want);
        Marshal.Release(cur);
        Guid k = MtSub, g1, g2; ulong s1, s2;
        c.GetGUID(ref k, out g1); w.GetGUID(ref k, out g2); k = MtFrameSize; c.GetUINT64(ref k, out s1); w.GetUINT64(ref k, out s2);
        Marshal.ReleaseComObject(c); Marshal.ReleaseComObject(w);
        return g1 == g2 && s1 == s2;
    }

    void Configure()
    {
        Need("AVLowLatencyMode", SetApi(ApiLowLatency, VtBool, 0xFFFF));
        if (SetApi(ApiRateControl, VtUi4, 0) != 0) Need("AVEncCommonRateControlMode", SetApi(ApiRateControl, VtUi4, 4));
        Need("AVEncCommonMeanBitRate", SetApi(ApiBitrate, VtUi4, (ulong)Config.BitrateBps));
        Need("AVEncMPVGOPSize", SetApi(ApiGop, VtUi4, (ulong)fps * 600));
        // The NVIDIA MFT answers E_INVALIDARG here; the software MFT is the only one in this slice but stays tolerant.
        bpHr = SetApi(ApiBFrames, VtUi4, 0);
        if (bpHr != 0 && bpHr != EInvalidArg && bpHr != ENotImpl && bpHr != ENotFound) Need("AVEncMPVDefaultBPictureCount", bpHr);
        IntPtr inT = NewType(false), outT = NewType(true);
        try
        {
            int hrOut = t.SetOutputType(0, outT, 0);
            if (hrOut != 0 && CurrentOutputMatches(outT)) hrOut = 0;
            if (hrOut == 0) { Need("SetInputType", t.SetInputType(0, inT, 0)); typeOrder = "output-first"; }
            else
            {
                Need("SetInputType", t.SetInputType(0, inT, 0));
                hrOut = t.SetOutputType(0, outT, 0);
                if (hrOut != 0 && CurrentOutputMatches(outT)) hrOut = 0;
                Need("SetOutputType", hrOut); typeOrder = "input-first";
            }
        }
        finally { Marshal.Release(inT); Marshal.Release(outT); }
        ReadStreamState();
        Need("BeginStreaming", t.ProcessMessage(MessageBegin, IntPtr.Zero));
    }

    void ReadStreamState()
    {
        IntPtr cur;
        if (t.GetOutputCurrentType(0, out cur) == 0 && cur != IntPtr.Zero)
        {
            IMFAttributes a = (IMFAttributes)Marshal.GetObjectForIUnknown(cur); Marshal.Release(cur);
            Guid k = MtSeqHeader; uint n, w;
            seqHeader = null;
            if (a.GetBlobSize(ref k, out n) == 0 && n > 0) { seqHeader = new byte[n]; a.GetBlob(ref k, seqHeader, n, out w); }
            Marshal.ReleaseComObject(a);
        }
        MftInputStreamInfo ii; if (t.GetInputStreamInfo(0, out ii) == 0) inSize = (int)ii.Size;
        MftOutputStreamInfo oi; if (t.GetOutputStreamInfo(0, out oi) == 0) { outFlags = oi.Flags; if (oi.Size > outSize) outSize = (int)oi.Size; }
    }

    void Guard()
    {
        if (state == State.Disposed) throw new ObjectDisposedException("H264Encoder");
        if (Thread.CurrentThread.ManagedThreadId != owner) throw new InvalidOperationException("H264Encoder must be used on its creating thread");
    }

    // Creates a sample around one memory buffer; fill (if any) is copied in and the rest of the buffer is zeroed.
    IntPtr NewSample(int size, byte[] fill, long ptsHns)
    {
        IntPtr buf, sp;
        Need("MFCreateMemoryBuffer", MFCreateMemoryBuffer((uint)size, out buf));
        try
        {
            if (fill != null)
            {
                IMFMediaBuffer mb = (IMFMediaBuffer)Marshal.GetObjectForIUnknown(buf);
                IntPtr data; uint max, cur;
                Need("IMFMediaBuffer::Lock", mb.Lock(out data, out max, out cur));
                try
                {
                    Marshal.Copy(fill, 0, data, fill.Length);
                    for (int off = fill.Length; off < size; off += zeros.Length) Marshal.Copy(zeros, 0, data + off, Math.Min(zeros.Length, size - off));
                }
                finally { mb.Unlock(); }
                mb.SetCurrentLength((uint)size); Marshal.ReleaseComObject(mb);
            }
            Need("MFCreateSample", MFCreateSample(out sp));
            IMFSample s = (IMFSample)Marshal.GetObjectForIUnknown(sp);
            try
            {
                Need("AddBuffer", s.AddBuffer(buf)); Need("SetSampleTime", s.SetSampleTime(ptsHns)); Need("SetSampleDuration", s.SetSampleDuration(10000000L / fps));
            }
            catch { Marshal.Release(sp); throw; }
            finally { Marshal.ReleaseComObject(s); }
            return sp;
        }
        finally { Marshal.Release(buf); }
    }

    public List<AccessUnit> Encode(byte[] nv12, long ptsHns)
    {
        Guard();
        if (state != State.Open) throw new InvalidOperationException("encoder is drained");
        if (nv12 == null) throw new ArgumentNullException("nv12");
        if (nv12.Length != zeros.Length) throw new ArgumentException("expected " + zeros.Length + " packed NV12 bytes", "nv12");
        var result = new List<AccessUnit>();
        IntPtr sp = NewSample(Math.Max(zeros.Length * FrameMultiple, inSize), nv12, ptsHns);
        try
        {
            for (int attempt = 0; ; attempt++)
            {
                int hr = t.ProcessInput(0, sp, 0);
                if (hr == 0) break;
                if (hr != ENotAccepting || attempt >= 16) throw new EncoderException("ProcessInput", hr, "input refused");
                if (!Output(result)) throw new EncoderException("ProcessInput", hr, "encoder refuses input and has no output to give");
            }
        }
        finally { Marshal.Release(sp); }
        while (Output(result)) { }
        return result;
    }

    // IDR on the next submitted frame; VT_BOOL is acknowledged and ignored by the MFTs.
    public void ForceKeyFrame()
    {
        Guard();
        if (state != State.Open) throw new InvalidOperationException("encoder is drained");
        Need("ForceKeyFrame", SetApi(ApiForceKey, VtUi4, 1));
    }

    public List<AccessUnit> Drain()
    {
        Guard();
        if (state != State.Open) throw new InvalidOperationException("encoder is drained");
        var result = new List<AccessUnit>();
        Need("Drain", t.ProcessMessage(MessageDrain, IntPtr.Zero));
        while (Output(result)) { }
        state = State.Drained;
        return result;
    }

    // One ProcessOutput round. False means the MFT wants more input.
    bool Output(List<AccessUnit> result)
    {
        int tries = 0, changes = 0;
        for (; ; tries++)
        {
            var odb = new MftOutputDataBuffer(); IntPtr own = IntPtr.Zero;
            if ((outFlags & 0x100) == 0) { own = NewSample(outSize, null, 0); odb.Sample = own; }
            uint status; int hr = t.ProcessOutput(0, 1, ref odb, out status);
            if (odb.Events != IntPtr.Zero) Marshal.Release(odb.Events);
            if (hr == 0)
            {
                try { result.Add(ReadSample(odb.Sample)); } finally { Marshal.Release(odb.Sample); }
                return true;
            }
            if (own != IntPtr.Zero) Marshal.Release(own);
            if (hr == ENeedMoreInput) return false;
            if (hr == EStreamChange && ++changes <= 4) { Renegotiate(); continue; }
            if (hr == EBufferTooSmall && tries < 8 && outSize < (64 << 20)) { outSize *= 2; continue; }
            throw new EncoderException("ProcessOutput", hr, "output failed");
        }
    }

    AccessUnit ReadSample(IntPtr samplePtr)
    {
        IMFSample s = (IMFSample)Marshal.GetObjectForIUnknown(samplePtr);
        long pts; IntPtr bp; byte[] data;
        s.GetSampleTime(out pts);
        Need("ConvertToContiguousBuffer", s.ConvertToContiguousBuffer(out bp));
        IMFMediaBuffer b = (IMFMediaBuffer)Marshal.GetObjectForIUnknown(bp);
        try
        {
            uint len, max, cur; IntPtr p;
            b.GetCurrentLength(out len); data = new byte[len];
            if (len > 0) { Need("IMFMediaBuffer::Lock", b.Lock(out p, out max, out cur)); try { Marshal.Copy(p, data, 0, (int)len); } finally { b.Unlock(); } }
        }
        finally { Marshal.ReleaseComObject(b); Marshal.Release(bp); Marshal.ReleaseComObject(s); }
        return Finish(data, pts, seqHeader);
    }

    // Validates one access unit and puts the sequence header in front of an IDR that lacks SPS/PPS.
    internal static AccessUnit Finish(byte[] data, long pts, byte[] seqHeader)
    {
        bool idr, ps; Scan(data, out idr, out ps);
        if (data.Length < 4 || data[0] != 0 || data[1] != 0 || (data[2] != 1 && (data[2] != 0 || data[3] != 1))) throw new EncoderException("ProcessOutput", 0, "access unit is not Annex-B");
        bool prepended = false;
        if (idr && !ps)
        {
            bool hIdr, hPs = false;
            if (seqHeader != null) Scan(seqHeader, out hIdr, out hPs);
            if (!hPs) throw new EncoderException("SequenceHeader", 0, "IDR without SPS/PPS and no sequence header to prepend");
            var joined = new byte[seqHeader.Length + data.Length];
            Buffer.BlockCopy(seqHeader, 0, joined, 0, seqHeader.Length); Buffer.BlockCopy(data, 0, joined, seqHeader.Length, data.Length);
            data = joined; prepended = true;
        }
        return new AccessUnit(data, pts, idr, prepended);
    }

    // idr: an IDR slice (NAL 5) is present. ps: SPS (7) and PPS (8) both appear before the first IDR, or anywhere when there is none.
    static void Scan(byte[] d, out bool idr, out bool ps)
    {
        bool sps = false, pps = false; idr = false;
        for (int i = 0; i + 3 < d.Length && !idr; i++)
        {
            if (d[i] != 0 || d[i + 1] != 0 || d[i + 2] != 1) continue;
            int nal = d[i + 3] & 0x1f;
            if (nal == 5) idr = true; else if (nal == 7) sps = true; else if (nal == 8) pps = true;
            i += 2;
        }
        ps = sps && pps;
    }

    public void Dispose()
    {
        if (state == State.Disposed) return;
        state = State.Disposed;
        if (t != null)
        {
            try { t.ProcessMessage(MessageEnd, IntPtr.Zero); } catch (Exception) { }
            Marshal.FinalReleaseComObject(t); t = null; api = null;
        }
        if (mfStarted) { MFShutdown(); mfStarted = false; }
    }
}

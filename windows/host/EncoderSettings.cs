using System;
using System.Runtime.InteropServices;

public sealed class EncoderSettings
{
    public string MftName, TypeOrder; public bool? LowLatency;
    public uint? RateControlMode, MeanBitRateBps, BPictureCount, GopSize;
    public int BPictureHr, SequenceHeaderBytes;
    public uint OutputProfile, OutputWidth, OutputHeight, OutputFpsNum, OutputFpsDen, OutputAvgBitrate, InputStride;
}

public sealed partial class H264Encoder
{
    ulong? GetApi(Guid key)
    {
        IntPtr v = Marshal.AllocHGlobal(24);
        try
        {
            for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(v, i, 0);
            if (api.GetValue(ref key, v) != 0) return null;
            ulong r = (ulong)Marshal.ReadInt64(v, 8); VariantClear(v); return r;
        }
        finally { Marshal.FreeHGlobal(v); }
    }

    void Renegotiate()
    {
        IntPtr type;
        Need("StreamChange", t.GetOutputAvailableType(0, 0, out type));
        try { Need("StreamChange", t.SetOutputType(0, type, 0)); } finally { Marshal.Release(type); }
        ReadStreamState();
    }

    public EncoderSettings ReadSettings()
    {
        Guard();
        var r = new EncoderSettings { MftName = "Microsoft H.264 Video Encoder MFT (software)", TypeOrder = typeOrder, BPictureHr = bpHr };
        ulong? v = GetApi(ApiLowLatency); r.LowLatency = v.HasValue ? v.Value != 0 : (bool?)null;
        v = GetApi(ApiRateControl); r.RateControlMode = v.HasValue ? (uint)v.Value : (uint?)null;
        v = GetApi(ApiBitrate); r.MeanBitRateBps = v.HasValue ? (uint)v.Value : (uint?)null;
        v = GetApi(ApiBFrames); r.BPictureCount = v.HasValue ? (uint)v.Value : (uint?)null;
        v = GetApi(ApiGop); r.GopSize = v.HasValue ? (uint)v.Value : (uint?)null;
        r.SequenceHeaderBytes = seqHeader == null ? 0 : seqHeader.Length;
        IntPtr cur; Guid k; ulong u64; uint u32;
        if (t.GetOutputCurrentType(0, out cur) == 0 && cur != IntPtr.Zero)
        {
            IMFAttributes a = (IMFAttributes)Marshal.GetObjectForIUnknown(cur); Marshal.Release(cur);
            k = MtProfile; a.GetUINT32(ref k, out r.OutputProfile); k = MtAvgBitrate; a.GetUINT32(ref k, out r.OutputAvgBitrate);
            k = MtFrameSize; if (a.GetUINT64(ref k, out u64) == 0) { r.OutputWidth = (uint)(u64 >> 32); r.OutputHeight = (uint)u64; }
            k = MtFrameRate; if (a.GetUINT64(ref k, out u64) == 0) { r.OutputFpsNum = (uint)(u64 >> 32); r.OutputFpsDen = (uint)u64; }
            Marshal.ReleaseComObject(a);
        }
        if (t.GetInputCurrentType(0, out cur) == 0 && cur != IntPtr.Zero)
        {
            IMFAttributes a = (IMFAttributes)Marshal.GetObjectForIUnknown(cur); Marshal.Release(cur);
            k = MtStride; if (a.GetUINT32(ref k, out u32) == 0) r.InputStride = u32;
            Marshal.ReleaseComObject(a);
        }
        return r;
    }
}

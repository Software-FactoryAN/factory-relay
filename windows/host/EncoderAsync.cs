using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Hardware H.264 encoder MFT (async event model) for the host, with software fallback, live bitrate and a hardware session cap.
// Events are polled on the owner thread inside Encode and Drain; there is no pump thread.
public sealed partial class H264Encoder
{
    // IMFActivate starts with the 30 IMFAttributes slots; only GetAllocatedString (slot 10) is called.
    [ComImport, Guid("7fee9e9a-4a89-47a6-899c-b6a53a70fb67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFActivate
    {
        [PreserveSig] int h0(); [PreserveSig] int h1(); [PreserveSig] int h2(); [PreserveSig] int h3(); [PreserveSig] int h4();
        [PreserveSig] int h5(); [PreserveSig] int h6(); [PreserveSig] int h7(); [PreserveSig] int h8(); [PreserveSig] int h9();
        [PreserveSig] int GetAllocatedString(ref Guid key, out IntPtr value, out uint length);
        [PreserveSig] int h11(); [PreserveSig] int h12(); [PreserveSig] int h13(); [PreserveSig] int h14(); [PreserveSig] int h15();
        [PreserveSig] int h16(); [PreserveSig] int h17(); [PreserveSig] int h18(); [PreserveSig] int h19(); [PreserveSig] int h20();
        [PreserveSig] int h21(); [PreserveSig] int h22(); [PreserveSig] int h23(); [PreserveSig] int h24(); [PreserveSig] int h25();
        [PreserveSig] int h26(); [PreserveSig] int h27(); [PreserveSig] int h28(); [PreserveSig] int h29();
        [PreserveSig] int ActivateObject(ref Guid iid, out IntPtr obj); [PreserveSig] int ShutdownObject(); [PreserveSig] int DetachObject();
    }
    [ComImport, Guid("2cd0bd52-bcd5-4b89-b62c-eadc0c031e7d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaEventGenerator { [PreserveSig] int GetEvent(uint flags, out IntPtr evt); }
    [ComImport, Guid("DF598932-F10C-4E39-BBA2-C308F101DAA3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaEvent
    {
        [PreserveSig] int m0(); [PreserveSig] int m1(); [PreserveSig] int m2(); [PreserveSig] int m3(); [PreserveSig] int m4();
        [PreserveSig] int m5(); [PreserveSig] int m6(); [PreserveSig] int m7(); [PreserveSig] int m8(); [PreserveSig] int m9();
        [PreserveSig] int m10(); [PreserveSig] int m11(); [PreserveSig] int m12(); [PreserveSig] int m13(); [PreserveSig] int m14();
        [PreserveSig] int m15(); [PreserveSig] int m16(); [PreserveSig] int m17(); [PreserveSig] int m18(); [PreserveSig] int m19();
        [PreserveSig] int m20(); [PreserveSig] int m21(); [PreserveSig] int m22(); [PreserveSig] int m23(); [PreserveSig] int m24();
        [PreserveSig] int m25(); [PreserveSig] int m26(); [PreserveSig] int m27(); [PreserveSig] int m28(); [PreserveSig] int m29();
        [PreserveSig] int EvType(out uint type); [PreserveSig] int GetExtendedType(out Guid t); [PreserveSig] int GetStatus(out int hr);
    }
    [StructLayout(LayoutKind.Sequential)] struct MftRegisterTypeInfo { public Guid Major, Sub; }

    [DllImport("mfplat.dll")] static extern int MFTEnumEx(Guid category, uint flags, ref MftRegisterTypeInfo input, ref MftRegisterTypeInfo output, out IntPtr activates, out uint count);
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

    public const int MaxHardwareSessions = 12;
    static readonly Guid CategoryEncoder = G("f79eac7d-e545-4387-bdee-d647d7bde42a"), MfAsync = G("f81a699a-649a-497d-8c73-29f8fed6ad7a"), MfAsyncUnlock = G("e5666d6b-3422-4eb6-a421-da7db1f8e207");
    static readonly Guid MftFriendlyName = G("314ffbae-5b41-4c95-9c19-4e7d586face3"), MftVendorId = G("3aecb0cc-035b-4bcc-8185-2b8d551ef3af");
    const int MessageEndOfStream = 0x10000002, MessageStartOfStream = 0x10000003, EvError = 1, EvNeedInput = 601, EvHaveOutput = 602, EvDrainComplete = 603, EvInputStreamState = 605;
    const int ENoEvents = unchecked((int)0xC00D3E80), ESessionLimit = unchecked((int)0xC00D6D76), ETimeout = unchecked((int)0x800705B4), EUnexpected = unchecked((int)0x8000FFFF), ENoHardware = unchecked((int)0xC00D36D5);
    const int InputWaitMs = 200, DrainWaitMs = 2000;

    static int live;
    // 0 none, 1 enumeration finds nothing, 2 every activate fails in Configure.
    internal static int TestHardwareFault;
    internal static int LiveHardwareSessions { get { return Volatile.Read(ref live); } }
    internal static bool IsSessionLimit(int hr) { return hr == ESessionLimit; }
    // The hr an event turns into, 0 when it is harmless.
    internal static int EventFault(uint type, int status)
    {
        if (status < 0) return status;
        return type == EvError || type == EvInputStreamState ? EUnexpected : 0;
    }

    IMFMediaEventGenerator events; IMFActivate activate;
    readonly List<AccessUnit> carry = new List<AccessUnit>();
    int needInput, inFlight; bool hardware, draining, drainDone, holdsSession, timerRaised; string mftName, vendorId, fallbackReason;

    void OpenSoftware()
    {
        Guid clsid = ClsidSoftware, iid = IidTransform; IntPtr obj;
        Need("CoCreateInstance", CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out obj));
        t = (IMFTransform)Marshal.GetObjectForIUnknown(obj); Marshal.Release(obj);
        api = t as ICodecAPI;
        if (api == null) throw new EncoderException("ICodecAPI", ENotImpl, "encoder does not expose ICodecAPI");
        mftName = "Microsoft H.264 Video Encoder MFT (software)";
        Configure();
    }

    void FallBack(string reason, string stage, int hr)
    {
        if (!Config.AllowSoftwareFallback) throw new EncoderException(stage, hr, reason);
        fallbackReason = reason; OpenSoftware();
    }

    static string ReadString(IMFActivate a, Guid key)
    {
        IntPtr s; uint n;
        if (a.GetAllocatedString(ref key, out s, out n) != 0 || s == IntPtr.Zero) return null;
        try { return Marshal.PtrToStringUni(s); } finally { CoTaskMemFree(s); }
    }

    void OpenHardware()
    {
        var inInfo = new MftRegisterTypeInfo { Major = Video, Sub = Nv12 }; var outInfo = new MftRegisterTypeInfo { Major = Video, Sub = H264 };
        IntPtr acts = IntPtr.Zero; uint count = 0; int hr = 0;
        if (TestHardwareFault != 1) hr = MFTEnumEx(CategoryEncoder, 0x44, ref inInfo, ref outInfo, out acts, out count);
        if (hr != 0 || count == 0 || acts == IntPtr.Zero)
        {
            FallBack(hr != 0 ? "MFTEnumEx failed 0x" + hr.ToString("X8") : "no hardware H.264 encoder MFT", "NoHardware", hr != 0 ? hr : ENoHardware);
            return;
        }
        string failures = "", lastStage = "Activate"; int lastHr = 0; bool opened = false;
        try
        {
            if (Interlocked.Increment(ref live) > MaxHardwareSessions) { Interlocked.Decrement(ref live); throw new EncoderException("SessionLimit", 0, "hardware encoder session cap of " + MaxHardwareSessions + " reached"); }
            holdsSession = true;
            for (int i = 0; i < count && !opened; i++)
            {
                IntPtr p = Marshal.ReadIntPtr(acts, i * IntPtr.Size);
                activate = (IMFActivate)Marshal.GetObjectForIUnknown(p);
                string name = ReadString(activate, MftFriendlyName);
                try { StartHardware(); opened = true; mftName = string.IsNullOrEmpty(name) ? "hardware H.264 encoder MFT (unnamed)" : name; vendorId = ReadString(activate, MftVendorId); }
                catch (EncoderException e)
                {
                    DropMft();
                    if (IsSessionLimit(e.HResultCode)) throw new EncoderException("SessionLimit", e.HResultCode, "the driver refused another encoder session");
                    failures += (failures.Length > 0 ? "; " : "") + (name ?? "unnamed") + ": " + e.Stage + " 0x" + e.HResultCode.ToString("X8"); lastStage = e.Stage; lastHr = e.HResultCode;
                }
            }
        }
        finally
        {
            for (uint i = 0; i < count; i++) Marshal.Release(Marshal.ReadIntPtr(acts, (int)i * IntPtr.Size));
            CoTaskMemFree(acts);
        }
        if (opened) { hardware = true; timeBeginPeriod(1); timerRaised = true; return; }
        ReleaseSession();
        FallBack(failures, lastStage, lastHr);
    }

    void StartHardware()
    {
        Guid iid = IidTransform, k; IntPtr obj, ap; uint isAsync;
        Need("ActivateObject", activate.ActivateObject(ref iid, out obj));
        t = (IMFTransform)Marshal.GetObjectForIUnknown(obj); Marshal.Release(obj);
        if (TestHardwareFault == 2) throw new EncoderException("Configure", ENotImpl, "injected fault");
        Need("GetAttributes", t.GetAttributes(out ap));
        IMFAttributes a = (IMFAttributes)Marshal.GetObjectForIUnknown(ap); Marshal.Release(ap);
        try
        {
            k = MfAsync; if (a.GetUINT32(ref k, out isAsync) != 0 || isAsync == 0) throw new EncoderException("Async", ENotImpl, "encoder is not asynchronous");
            k = MfAsyncUnlock; Need("AsyncUnlock", a.SetUINT32(ref k, 1));
        }
        finally { Marshal.ReleaseComObject(a); }
        api = t as ICodecAPI; events = t as IMFMediaEventGenerator;
        if (api == null || events == null) throw new EncoderException("ICodecAPI", ENotImpl, "encoder lacks ICodecAPI or the event generator");
        Configure();
        Need("StartOfStream", t.ProcessMessage(MessageStartOfStream, IntPtr.Zero));
        needInput = 0; inFlight = 0;
    }

    // Releases the MFT and its activation object; the session slot and timer are handled apart.
    void DropMft()
    {
        events = null; api = null;
        if (activate != null) { try { activate.ShutdownObject(); } catch (Exception) { } Marshal.FinalReleaseComObject(activate); activate = null; }
        if (t != null) { Marshal.FinalReleaseComObject(t); t = null; }
    }

    void ReleaseSession()
    {
        if (holdsSession) { holdsSession = false; Interlocked.Decrement(ref live); }
    }

    void ReleaseHardware()
    {
        if (timerRaised) { timerRaised = false; timeEndPeriod(1); }
        ReleaseSession();
    }

    // One GetEvent without waiting; false when the queue is empty.
    bool Poll(List<AccessUnit> result)
    {
        IntPtr ev; int hr = events.GetEvent(1, out ev);
        if (hr == ENoEvents) return false;
        if (hr != 0 || ev == IntPtr.Zero) throw new EncoderException("GetEvent", hr, "event queue failed");
        IMFMediaEvent me = (IMFMediaEvent)Marshal.GetObjectForIUnknown(ev); Marshal.Release(ev);
        uint type; int status;
        try { me.EvType(out type); me.GetStatus(out status); } finally { Marshal.ReleaseComObject(me); }
        int bad = EventFault(type, status);
        if (bad != 0) throw new EncoderException("AsyncEvent", bad, "event " + type + " reported failure");
        if (type == EvNeedInput) needInput++;
        else if (type == EvHaveOutput) { Output(result); if (inFlight > 0) inFlight--; }
        else if (type == EvDrainComplete)
        {
            if (!draining) throw new EncoderException("AsyncEvent", EUnexpected, "drain complete outside Drain");
            drainDone = true;
        }
        return true;
    }

    void WaitInput(List<AccessUnit> result, Stopwatch sw)
    {
        while (needInput <= 0)
        {
            if (Poll(result)) continue;
            if (sw.ElapsedMilliseconds >= InputWaitMs) throw new EncoderException("InputTimeout", ETimeout, "no NeedInput within " + InputWaitMs + " ms");
            Thread.Sleep(1);
        }
    }

    List<AccessUnit> EncodeAsync(byte[] nv12, long ptsHns)
    {
        var result = new List<AccessUnit>(carry); carry.Clear();
        int first = result.Count;
        try
        {
            var sw = Stopwatch.StartNew();
            IntPtr sp = NewSample(Math.Max(zeros.Length * FrameMultiple, inSize), nv12, ptsHns);
            try
            {
                for (; ; )
                {
                    WaitInput(result, sw);
                    int hr = t.ProcessInput(0, sp, 0);
                    if (hr == 0) { needInput--; inFlight++; break; }
                    if (hr != ENotAccepting) throw new EncoderException("ProcessInput", hr, "input refused");
                    needInput = 0;
                }
            }
            finally { Marshal.Release(sp); }
            sw.Restart(); Stopwatch half = null;
            while (inFlight > 0 && sw.ElapsedMilliseconds < InputWaitMs)
            {
                if (!Poll(result)) Thread.Sleep(1);
                if (half == null && result.Count > first) half = Stopwatch.StartNew();
                if (half != null && half.ElapsedMilliseconds >= 500 / fps) break;
            }
            inFlight = 0;
            return result;
        }
        catch (EncoderException e)
        {
            if (e.Stage == "InputTimeout") carry.AddRange(result); else state = State.Faulted;
            throw;
        }
    }

    List<AccessUnit> DrainAsync()
    {
        var result = new List<AccessUnit>(carry); carry.Clear();
        try
        {
            Need("EndOfStream", t.ProcessMessage(MessageEndOfStream, IntPtr.Zero));
            Need("Drain", t.ProcessMessage(MessageDrain, IntPtr.Zero));
            draining = true; drainDone = false;
            var sw = Stopwatch.StartNew();
            while (!drainDone)
            {
                if (Poll(result)) continue;
                if (sw.ElapsedMilliseconds >= DrainWaitMs) { state = State.Drained; throw new EncoderException("DrainTimeout", ETimeout, "drain incomplete, " + result.Count + " access units collected"); }
                Thread.Sleep(1);
            }
            state = State.Drained;
            return result;
        }
        catch (EncoderException) { if (state != State.Drained) state = State.Faulted; throw; }
        finally { draining = false; }
    }

    // Live mean bitrate change; no IDR and no reinitialisation.
    public void SetBitrate(int bps)
    {
        Guard();
        if (state != State.Open) throw new InvalidOperationException("encoder is not open (drained or faulted)");
        if (bps < EncoderConfig.MinBitrateBps || bps > EncoderConfig.MaxBitrateBps) throw new ArgumentOutOfRangeException("bps", "bitrate outside 1.5-8 Mbit/s");
        Need("SetBitrate", SetApi(ApiBitrate, VtUi4, (ulong)bps));
        Config.BitrateBps = bps;
    }
}

# Desk test for windows/host/Encoder.cs: builds the self-test, encodes a synthetic NV12 sequence with the software MFT, then has ffprobe and ffmpeg judge the stream.
param([string]$Out = "$env:TEMP\relay-h1")
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
New-Item -ItemType Directory -Force $Out | Out-Null
& ($fw + 'csc.exe') /nologo /optimize+ /target:exe /platform:x64 /out:$Out\EncoderSelfTest.exe "$here\..\host\Encoder.cs" "$here\..\host\EncoderSettings.cs" "$here\EncoderSelfTest.cs"
if ($LASTEXITCODE -ne 0) { throw "csc exit $LASTEXITCODE" }
& $Out\EncoderSelfTest.exe $Out\h1.h264
if ($LASTEXITCODE -ne 0) { throw "EncoderSelfTest exit $LASTEXITCODE" }
$probe = ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,profile,width,height,nb_read_frames -of default=nw=1 -f h264 $Out\h1.h264
$probe
if (($probe -join ' ') -notmatch 'codec_name=h264.*profile=Main.*width=640.*height=360.*nb_read_frames=30') { throw 'ffprobe does not report h264 Main 640x360 with 30 frames' }
ffmpeg -v error -xerror -f h264 -i $Out\h1.h264 -f null -
if ($LASTEXITCODE -ne 0) { throw "ffmpeg rejected the stream (exit $LASTEXITCODE)" }
Write-Output 'H1 DESK TEST PASS'

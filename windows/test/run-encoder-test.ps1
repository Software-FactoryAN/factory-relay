# Desk test for windows/host/Encoder.cs and EncoderAsync.cs: builds the self-tests, encodes a synthetic NV12 sequence with the software MFT and (with -Hardware) the hardware MFT, then has ffprobe and ffmpeg judge each stream.
param([string]$Out = "$env:TEMP\relay-h2", [switch]$Hardware)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
New-Item -ItemType Directory -Force $Out | Out-Null
$host_ = @("$here\..\host\Encoder.cs", "$here\..\host\EncoderSettings.cs", "$here\..\host\EncoderAsync.cs")
function Judge($file, $label) {
  $probe = ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,profile,width,height,nb_read_frames -of default=nw=1 -f h264 $file
  $probe
  if (($probe -join ' ') -notmatch 'codec_name=h264.*profile=Main.*width=640.*height=360.*nb_read_frames=30') { throw "ffprobe does not report h264 Main 640x360 with 30 frames ($label)" }
  ffmpeg -v error -xerror -f h264 -i $file -f null -
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg rejected the $label stream (exit $LASTEXITCODE)" }
}
& ($fw + 'csc.exe') /nologo /optimize+ /target:exe /platform:x64 /out:$Out\EncoderSelfTest.exe @host_ "$here\EncoderSelfTest.cs"
if ($LASTEXITCODE -ne 0) { throw "csc exit $LASTEXITCODE" }
& $Out\EncoderSelfTest.exe $Out\h1.h264
if ($LASTEXITCODE -ne 0) { throw "EncoderSelfTest exit $LASTEXITCODE" }
Judge $Out\h1.h264 'software'
if ($Hardware) {
  & ($fw + 'csc.exe') /nologo /optimize+ /target:exe /platform:x64 /out:$Out\EncoderHwTest.exe @host_ "$here\EncoderHwTest.cs"
  if ($LASTEXITCODE -ne 0) { throw "csc exit $LASTEXITCODE" }
  & $Out\EncoderHwTest.exe $Out\h2-hw.h264
  if ($LASTEXITCODE -ne 0) { throw "EncoderHwTest exit $LASTEXITCODE" }
  Judge $Out\h2-hw.h264 'hardware'
  Write-Output 'H2 DESK TEST PASS'
} else { Write-Output 'H1 DESK TEST PASS (software only; add -Hardware for H2)' }

# Builds Windows.exe (list, diagnose, stream) with the .NET Framework 4.8 csc (C# 5). Capture.cs also builds alone as Capture.exe. No binaries go into the repository.
param([string]$Out = "$env:USERPROFILE\relay-evidence\bin")
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$wm = 'C:\Windows\System32\WinMetadata\'
$refs = @("/r:$wm\Windows.Foundation.winmd", "/r:$wm\Windows.Graphics.winmd", "/r:$wm\Windows.Storage.winmd", "/r:$fw\System.Runtime.dll",
  "/r:$fw\System.Runtime.InteropServices.WindowsRuntime.dll", "/r:$fw\System.Runtime.WindowsRuntime.dll", '/r:System.Drawing.dll')
New-Item -ItemType Directory -Force $Out | Out-Null
& ($fw + 'csc.exe') /nologo /target:exe /main:WindowList /out:$Out\Windows.exe @refs $here\Windows.cs $here\Capture.cs $here\StreamHost.cs
& ($fw + 'csc.exe') /nologo /target:exe /out:$Out\Capture.exe @refs $here\Capture.cs

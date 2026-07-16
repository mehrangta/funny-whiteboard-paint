param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$SummaryTitle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$sourceFile = Get-Item -LiteralPath $resolvedSource

if ($sourceFile.Length -le 0) {
  throw "Windows executable is empty: $resolvedSource"
}

$bytes = [System.IO.File]::ReadAllBytes($resolvedSource)
if ($bytes.Length -lt 64) {
  throw "Windows executable is too small to contain a valid PE header: $resolvedSource"
}

$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) {
  throw "Windows executable contains an invalid PE header offset: $resolvedSource"
}

$peSignature = [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4)
if ($peSignature -ne "PE`0`0") {
  throw "Windows executable does not contain a valid PE signature: $resolvedSource"
}

$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) {
  throw ("Expected an x86-64 PE executable (0x8664), found 0x{0:X4}" -f $machine)
}

$authenticode = Get-AuthenticodeSignature -FilePath $resolvedSource
if ($authenticode.Status -ne "NotSigned") {
  throw "Expected an unsigned executable, found Authenticode status '$($authenticode.Status)'"
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Copy-Item -LiteralPath $resolvedSource -Destination $OutputPath -Force

$stagedFiles = @(Get-ChildItem -LiteralPath $outputDirectory -File)
if ($stagedFiles.Count -ne 1 -or $stagedFiles[0].FullName -ne (Get-Item -LiteralPath $OutputPath).FullName) {
  throw "The staging directory must contain exactly the requested executable"
}

$hash = Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
$stagedFile = Get-Item -LiteralPath $OutputPath

if ($env:GITHUB_OUTPUT) {
  "artifact_path=$($stagedFile.FullName)" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
  "sha256=$($hash.Hash)" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:GITHUB_STEP_SUMMARY) {
  @"
## $SummaryTitle

- Source: ``$resolvedSource``
- Asset: ``$($stagedFile.Name)``
- Size: $($stagedFile.Length) bytes
- Architecture: x86-64 (PE machine ``0x8664``)
- Authenticode: ``NotSigned``
- SHA-256: ``$($hash.Hash)``
"@ | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}

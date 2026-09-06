param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if (!$OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot "release/$($metadata.version)" }
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)
$appRoot = Join-Path $releaseRoot 'win-unpacked'
$zipPath = Join-Path $releaseRoot "PH-Launcher-$($metadata.version)-Windows-Folder.zip"
$sourceName = "PH-Launcher-$($metadata.version)-Source.zip"
foreach ($required in @((Join-Path $appRoot 'PH Launcher.exe'), (Join-Path $releaseRoot '解压版打开说明.md'), (Join-Path $releaseRoot $sourceName))) {
  if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required distribution file: $required" }
}
if (Test-Path -LiteralPath $zipPath) { throw 'Folder archive already exists; choose another output directory.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $appRoot -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($appRoot, $file.FullName)
    if ($relative.StartsWith('..') -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected archive input.' }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, ('PH Launcher/' + $relative.Replace('\', '/')), [IO.Compression.CompressionLevel]::Fastest) | Out-Null
  }
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $releaseRoot '解压版打开说明.md'), '打开说明.md', [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $releaseRoot $sourceName), $sourceName, [IO.Compression.CompressionLevel]::NoCompression) | Out-Null
} finally { $archive.Dispose() }
Write-Output $zipPath

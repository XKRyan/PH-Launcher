param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if (!$OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot "release/$($metadata.version)" }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$archivePath = Join-Path $destination "PH-Launcher-$($metadata.version)-Source.zip"
if (Test-Path -LiteralPath $archivePath) { throw 'Source archive already exists; choose another output directory.' }
$files = [Collections.Generic.List[IO.FileInfo]]::new()
foreach ($name in @('electron', 'src', 'tests', 'scripts', 'build', 'docs', '.github')) {
  Get-ChildItem -LiteralPath (Join-Path $sourceRoot $name) -File -Recurse | ForEach-Object {
    if ($_.Extension -in @('.cjs', '.mjs', '.js', '.css', '.html', '.json', '.md', '.yml', '.yaml', '.plist', '.txt', '.svg', '.png', '.ico', '.ps1', '.sh')) { $files.Add($_) }
  }
}
Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Extension -eq '.md' -or $_.Name -in @('LICENSE', 'LICENSE-MIT-PH-Launcher.txt', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes') } | ForEach-Object { $files.Add($_) }
foreach ($name in @('icon.ico', 'icon.png', 'icon.svg', 'dictionary/LICENSE-ECDICT.txt')) { $files.Add((Get-Item -LiteralPath (Join-Path $sourceRoot "assets/$name"))) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files | Sort-Object FullName -Unique) {
    $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
    if ($relative.StartsWith('..') -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe source archive entry' }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
Write-Output $archivePath

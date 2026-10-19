# Crée le zip à envoyer sur le Chrome Web Store.
# Le Web Store refuse le champ "key" du manifest : il est retiré de la copie packagée,
# manifest.json reste inchangé pour le chargement en mode non empaqueté.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$manifest = Get-Content manifest.json -Raw -Encoding UTF8
$version = ($manifest | ConvertFrom-Json).version
$zip = "linkxp-$version.zip"

$build = Join-Path ([System.IO.Path]::GetTempPath()) "linkxp-build-$version"
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory $build | Out-Null
New-Item -ItemType Directory (Join-Path $build 'icons') | Out-Null

Copy-Item background.js, collector.js, popup.html, popup.js, styles.css -Destination $build
Copy-Item icons\*.png -Destination (Join-Path $build 'icons')

$stripped = $manifest -replace '(?m)^[ \t]*"key"\s*:\s*"[^"]*",\s*\r?\n(\s*\r?\n)?', ''
if ($stripped -match '"key"\s*:') { throw 'manifest.json : le champ "key" est toujours present dans la copie packagee.' }
[System.IO.File]::WriteAllText((Join-Path $build 'manifest.json'), $stripped, (New-Object System.Text.UTF8Encoding $false))

# Compress-Archive (PowerShell 5.1) écrit des chemins avec "\", que le Web Store rejette :
# les entrées sont ajoutées une à une avec des "/".
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [System.IO.Compression.ZipFile]::Open((Join-Path $PSScriptRoot $zip), 'Create')
try {
    Get-ChildItem $build -Recurse -File | ForEach-Object {
        $entry = $_.FullName.Substring($build.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry) | Out-Null
    }
} finally {
    $archive.Dispose()
}
Remove-Item $build -Recurse -Force

Write-Host "OK : $zip"

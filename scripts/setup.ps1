param([switch]$SkipModels)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
foreach($dir in @('runtime','data/downloads','data/temp','data/npm-cache','data/electron-cache','tools/ffmpeg','tools/whisper','tools/models')) { New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $dir) | Out-Null }
$env:TEMP=Join-Path $projectRoot 'data/temp'
$env:TMP=$env:TEMP
$env:ELECTRON_CACHE=Join-Path $projectRoot 'data/electron-cache'
$env:npm_config_cache=Join-Path $projectRoot 'data/npm-cache'
function Download-Checked($Uri,$Destination,$Hash) {
  if(Test-Path -LiteralPath $Destination) { if((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Hash) { return } }
  Invoke-WebRequest -Uri $Uri -OutFile ($Destination+'.part')
  if((Get-FileHash -LiteralPath ($Destination+'.part') -Algorithm SHA256).Hash -ne $Hash) { throw "Checksum mismatch: $Uri" }
  Move-Item -LiteralPath ($Destination+'.part') -Destination $Destination -Force
}
$nodeVersion='v24.21.0'
$nodeDir=Join-Path $projectRoot ('runtime/node-'+$nodeVersion+'-win-x64')
if(!(Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  $checksums=(Invoke-WebRequest ('https://nodejs.org/dist/'+$nodeVersion+'/SHASUMS256.txt')).Content
  $nodeHash=($checksums -split "`n" | Where-Object {$_ -match (' node-'+[regex]::Escape($nodeVersion)+'-win-x64.zip$')}).Split(' ')[0]
  Download-Checked ('https://nodejs.org/dist/'+$nodeVersion+'/node-'+$nodeVersion+'-win-x64.zip') (Join-Path $projectRoot 'data/downloads/node.zip') $nodeHash
  Expand-Archive -LiteralPath 'data/downloads/node.zip' -DestinationPath runtime -Force
}
$env:Path=$nodeDir+';'+$env:Path
& (Join-Path $nodeDir 'npm.cmd') ci --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'npm dependency installation failed'}
& (Join-Path $nodeDir 'node.exe') node_modules/electron/install.js
if($LASTEXITCODE -ne 0){throw 'Electron portable download failed'}
if(!(Test-Path -LiteralPath 'tools/whisper/Release/whisper-cli.exe')) {
  Download-Checked 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' (Join-Path $projectRoot 'data/downloads/whisper.zip') '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
  Expand-Archive -LiteralPath 'data/downloads/whisper.zip' -DestinationPath tools/whisper -Force
}
# App-local redistributable runtime files, no Visual C++ installer.
foreach($dll in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')) {
  if(!(Test-Path -LiteralPath ('tools/whisper/Release/'+$dll))) {
    $runtimeFile=Join-Path $env:WINDIR ('System32/'+$dll)
    if(Test-Path -LiteralPath $runtimeFile) { Copy-Item -LiteralPath $runtimeFile -Destination tools/whisper/Release }
    else { throw "Missing $dll. Copy its app-local x64 redistributable into tools/whisper/Release; no system installation is performed." }
  }
}
if(!(Test-Path -LiteralPath 'tools/ffmpeg/ffmpeg.exe') -or !(Test-Path -LiteralPath 'tools/ffmpeg/ffprobe.exe')) {
  Write-Host 'Place a portable Windows FFmpeg build with libass in tools/ffmpeg (ffmpeg.exe + ffprobe.exe).'
  Write-Host 'Official Windows build links: https://ffmpeg.org/download.html#build-windows'
  throw 'FFmpeg is missing. No global installation was attempted.'
}
if(!$SkipModels) {
  Download-Checked 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' (Join-Path $projectRoot 'tools/models/ggml-base.bin') '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  Download-Checked 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' (Join-Path $projectRoot 'tools/models/ggml-large-v3-turbo-q5_0.bin') '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
}
& (Join-Path $nodeDir 'npm.cmd') run build
if($LASTEXITCODE -ne 0){throw 'UI build failed'}
& (Join-Path $nodeDir 'node.exe') scripts/package-portable.cjs
if($LASTEXITCODE -ne 0){throw 'Portable application assembly failed'}
Write-Host 'Ready. Double-click the app EXE in the root folder. All dependencies and data are contained in this folder.'

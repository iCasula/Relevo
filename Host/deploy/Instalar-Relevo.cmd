@echo off
setlocal
rem Relevo for Windows: downloads the latest published version from GitHub and installs it
rem (the agents' host as a service, plus the desktop app). Double-click it; it asks for administrator rights.
set "RELEVO_SELF=%~f0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath $env:RELEVO_SELF -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText($env:RELEVO_SELF); iex $t.Substring($t.LastIndexOf('#' + '#POWERSHELL##'))"
echo.
pause
exit /b

##POWERSHELL##
# Runs elevated. Plain ASCII on purpose: Windows PowerShell 5.1 reads this file in the ANSI code page.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'iCasula/Relevo'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host ''
  Write-Host '  Relevo para Windows' -ForegroundColor Cyan
  Write-Host ''

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Relevo necesita Node.js (20 o posterior) y no esta instalado.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $answer = Read-Host 'Lo instalo ahora con winget (Node.js LTS)? [S/n]'
      if ($answer -notmatch '^[nN]') {
        winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw 'Instala Node.js LTS (https://nodejs.org) y vuelve a abrir este instalador.'
    }
  }

  # The newest release, read from its own files (not the GitHub API, which limits requests per IP); it must be
  # signed (manifest.sig), as the updater requires.
  function Get-Text([string]$u) {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -Headers @{ 'User-Agent' = 'relevo-installer' }
    if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { $r.Content }
  }
  $manifest = Get-Text "https://github.com/$repo/releases/latest/download/manifest.json" | ConvertFrom-Json
  try { $null = Get-Text "https://github.com/$repo/releases/latest/download/manifest.sig" } catch { throw 'La ultima version aun no esta firmada: prueba de nuevo en unos minutos.' }
  $ref = $manifest.tag
  if ($ref -notmatch '^v?\d+\.\d+\.\d+$') { throw 'No encuentro ninguna version publicada.' }
  $url = "https://codeload.github.com/$repo/zip/refs/tags/$ref"
  Write-Host "Descargando Relevo $ref..."
  $work = Join-Path $env:TEMP ('relevo-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $zip = Join-Path $work 'relevo.zip'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $work
  $root = Get-ChildItem $work -Directory | Select-Object -First 1
  $installer = Join-Path $root.FullName 'Host\deploy\install-windows.ps1'
  if (-not (Test-Path $installer)) { throw "La version $ref no trae el instalador de Windows." }

  $params = @{}
  if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'RelevoHost\host.env'))) {
    $default = Join-Path $HOME 'Projects'
    $projects = Read-Host "Carpeta con tus proyectos [$default]"
    $params['Projects'] = $(if ($projects) { $projects } else { $default })
  }
  & $installer @params
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host 'Listo. Abre "Relevo" desde el menu Inicio o el escritorio.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "No se ha podido instalar: $($_.Exception.Message)" -ForegroundColor Red
}

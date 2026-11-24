#Requires -Version 5.1
<#
.SYNOPSIS
  Installs or updates relevo-host on this Windows PC, as a scheduled task that starts when you sign in and
  runs as you, hidden, so the agents use your logins and your projects. With -SinSesion it starts with Windows
  instead, before anyone signs in; but then Antigravity (agy) can't run terminal commands (they fail with
  -1073741502: a session without a desktop can't give them a console).

.DESCRIPTION
  Run it from an administrator PowerShell, signed in as the user who will own the agents (an admin account
  with UAC: right-click PowerShell › Run as administrator). Administrator rights are needed once, for the
  firewall rule and for a task that starts without a session.

    powershell -ExecutionPolicy Bypass -File Host\deploy\install-windows.ps1 [-Projects <folder>] [-Base <folder>] [-Name <name>] [-Port 47820] [-SinSesion]
    powershell -ExecutionPolicy Bypass -File Host\deploy\install-windows.ps1 -Uninstall

  <Base>\app          the program (a few files)
  <Base>\data         state, transcripts, Claude Code config, Codex home, temp files, caches and logs\host.log
  <Base>\host.env     settings (written once; edit it and run the script again, or restart the task)
  <Base>\relevo-host.cmd   `relevo-host pair | login | status | update | app | logs` (the folder goes in your PATH)
  Relevo (Start menu and desktop)   the desktop app: this PC and every other paired host, in an Edge app window

  -Uninstall removes the task, the firewall rule, the PATH entry and the shortcuts; <Base> stays (delete it by hand).
#>
[CmdletBinding()]
param(
  [string]$Projects = (Join-Path $HOME 'Projects'),
  [string]$Base = (Join-Path $env:LOCALAPPDATA 'RelevoHost'),
  [string]$Name = $env:COMPUTERNAME,
  [int]$Port = 47820,
  [switch]$SinSesion,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Relevo host'
# Absolute paths: the task, host.env and .NET calls don't resolve them against this terminal's folder.
$Base = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Base)
$Projects = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Projects)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Abre PowerShell como administrador: hace falta para la regla del firewall y para la tarea que arranca con Windows.'
}

function Remove-FromUserPath([string]$dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $kept = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir.TrimEnd('\')) })
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

# The host's own node processes (supervisor and worker), by their command line: nothing else.
function Get-HostProcesses {
  $script = Join-Path $Base 'app\relevo-host.mjs'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script) }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # The worker notices its supervisor is gone within 5 s and frees the port.
  Start-Sleep -Seconds 6
  # Started through the hidden launcher, stopping the task ends the launcher, not node: end it too.
  Get-HostProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$shortcuts = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) | ForEach-Object { Join-Path $_ 'Relevo.lnk' }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  $shortcuts | Where-Object { Test-Path $_ } | Remove-Item -Force
  Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-FromUserPath $Base
  Write-Host "Quitados la tarea, la regla del firewall, la entrada del PATH y los accesos directos. Los datos siguen en $Base."
  return
}

# Node 20 or newer (fetch, fs.statfs); no npm install, the program has no dependencies.
$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw 'No encuentro Node.js. Instálalo (versión 20 o posterior), por ejemplo: winget install OpenJS.NodeJS.LTS' }
$major = [int](& $node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "Node $major es demasiado antiguo: hace falta la versión 20 o posterior." }

$here = Split-Path -Parent $PSScriptRoot
$app = Join-Path $Base 'app'
$data = Join-Path $Base 'data'
New-Item -ItemType Directory -Force -Path $app, $data, $Projects | Out-Null
Copy-Item (Join-Path $here 'relevo-host.mjs') $app -Force
Copy-Item (Join-Path $here 'lib') $app -Recurse -Force
Copy-Item (Join-Path $here 'ui') $app -Recurse -Force
if (Test-Path (Join-Path $here 'VERSION')) { Copy-Item (Join-Path $here 'VERSION') $app -Force }

# The CLIs, by absolute path: the task's PATH may not be your terminal's.
function Find-Cli([string]$cli) {
  $local = Join-Path $HOME ".local\bin\$cli.exe"
  if (Test-Path $local) { return $local }
  $found = Get-Command $cli -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  return $null
}
$claude = Find-Cli 'claude'
$codex = Find-Cli 'codex'
$agy = Find-Cli 'agy'
# Claude Code runs its shell commands with Git Bash.
$bash = $null
$git = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
foreach ($candidate in @(
    $(if ($git) { Join-Path (Split-Path (Split-Path $git)) 'bin\bash.exe' }),
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))) {
  if ($candidate -and (Test-Path $candidate)) { $bash = $candidate; break }
}

$envFile = Join-Path $Base 'host.env'
$settings = [ordered]@{}
if (Test-Path $envFile) {
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
  }
} else {
  $settings['RELEVO_HOST_DATA'] = $data
  $settings['RELEVO_PROJECTS'] = $Projects
  $settings['RELEVO_HOST_NAME'] = $Name
  $settings['RELEVO_PORT'] = "$Port"
  $settings['RELEVO_MAX_AGENTS'] = '2'
  $settings['RELEVO_MIN_FREE_GB_DATA'] = '1'
  $settings['RELEVO_MIN_FREE_GB_PROJECTS'] = '2'
}
# Paths found now fill what's missing; what you set by hand stays.
if ($claude -and -not $settings.Contains('RELEVO_CLAUDE')) { $settings['RELEVO_CLAUDE'] = $claude }
if ($codex -and -not $settings.Contains('RELEVO_CODEX')) { $settings['RELEVO_CODEX'] = $codex }
if ($agy -and -not $settings.Contains('RELEVO_AGY')) { $settings['RELEVO_AGY'] = $agy }
if ($bash -and -not $settings.Contains('CLAUDE_CODE_GIT_BASH_PATH')) { $settings['CLAUDE_CODE_GIT_BASH_PATH'] = $bash }
# The desktop app's page, on 127.0.0.1 only (also added to installs from before it existed).
if (-not $settings.Contains('RELEVO_UI_PORT')) { $settings['RELEVO_UI_PORT'] = '47821' }
[IO.File]::WriteAllLines($envFile, [string[]]@($settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }))
if ($settings.Contains('RELEVO_PORT')) { $Port = [int]$settings['RELEVO_PORT'] }

$wrapper = Join-Path $Base 'relevo-host.cmd'
# cmd.exe reads batch files in the OEM code page, so a user folder with accents must be written in it.
$oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
[IO.File]::WriteAllLines($wrapper, [string[]]@('@echo off', "`"$node`" `"$app\relevo-host.mjs`" %*"), $oem)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (@($userPath -split ';') | Where-Object { $_.TrimEnd('\') -eq $Base.TrimEnd('\') })) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $Base) | Where-Object { $_ }) -join ';', 'User')
}

# The iPhone connects from the local network (or through a VPN that lands on it).
Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $TaskName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null

# relevo-host supervises its own worker (restarts after an update or a crash); the task restarts the supervisor.
if ($SinSesion) {
  # S4U: runs as you without storing your password and without a window; starts with Windows. Its session has
  # no desktop, so agy's terminal commands fail there (Claude's and Codex's work).
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$app\relevo-host.mjs`" serve" -WorkingDirectory $Base
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
} else {
  # In your session, from when you sign in (a locked screen is fine), with no window: a small launcher starts
  # node hidden (window style 0) and waits for it, so the task sees it running and restarts it if it stops.
  $launcher = Join-Path $Base 'relevo-host-oculto.vbs'
  $q = '""'
  $command = "$q$node$q $q$app\relevo-host.mjs$q serve"
  [IO.File]::WriteAllLines($launcher, [string[]]@(
    'Set shell = CreateObject("WScript.Shell")',
    "shell.CurrentDirectory = `"$Base`"",
    "WScript.Quit shell.Run(`"$command`", 0, True)"
  ), [Text.Encoding]::Unicode)
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //NoLogo `"$launcher`"" -WorkingDirectory $Base
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
}
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
# The app's link (and its token, created here before the service starts, so both use the same one).
$appUrl = & $node (Join-Path $app 'relevo-host.mjs') app --url | Select-Object -Last 1
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings `
  -Description 'Relevo host for Relevo Companion (Host\deploy\install-windows.ps1)' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# The app: Edge (always on Windows) opens the page as its own window, with Relevo's icon. The link carries
# the token that lets this user in; it lives only in these shortcuts and in <data>\desktop\ui-token.
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
foreach ($path in $shortcuts) {
  $link = $shell.CreateShortcut($path)
  if ($edge) { $link.TargetPath = $edge; $link.Arguments = "--app=$appUrl" } else { $link.TargetPath = $appUrl }
  $link.IconLocation = Join-Path $app 'ui\relevo.ico'
  $link.Description = 'Relevo: tus agentes en este PC y en tus otros hosts'
  $link.Save()
}
Start-Sleep -Seconds 4

$log = Join-Path $data 'logs\host.log'
Write-Host ''
Write-Host "Tarea «$TaskName»: $((Get-ScheduledTask -TaskName $TaskName).State)"
if (Test-Path $log) { Get-Content $log -Tail 4 }
Write-Host ''
Write-Host "Claude: $(if ($claude) { $claude } else { 'no encontrado' })   Codex: $(if ($codex) { $codex } else { 'no encontrado' })   Git Bash: $(if ($bash) { $bash } else { 'no encontrado (Claude Code lo necesita)' })"
Write-Host ''
Write-Host 'En una terminal nueva (para que coja el PATH), inicia sesión en cada agente para este host:'
Write-Host '  relevo-host login claude'
Write-Host '  relevo-host login codex'
Write-Host ''
Write-Host 'La app: «Relevo» en el menú Inicio y en el escritorio (o «relevo-host app»).'
Write-Host ''
Write-Host 'Enlace de vinculación (ábrelo en el iPhone o pégalo en Relevo Companion; no lo compartas):'
& $node (Join-Path $app 'relevo-host.mjs') pair

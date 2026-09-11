<#
  Install-ZehenServer.ps1
  -------------------------------------------------------------------------
  Registers ZEHEN's database + API as an always-on Windows service so the
  shop's server PC serves clients whenever it is powered on -- no login, no
  one launching the app, no access shared.

  SAFETY MODEL (read before running on any real shop):
    * Run this on a TEST PC with a COPY of a shop's data FIRST. Do not run it
      on a live counter until you have watched it work on the test box.
    * It never deletes or moves your database. It points the service at the
      database exactly where it already lives (C:\Users\<owner>\.zehen).
    * Before enabling the service it takes a fresh logical backup (pg_dumpall)
      plus a copy of the config, into a timestamped folder.
    * If the service does not come up HEALTHY within the timeout, it rolls
      itself back (removes the service + marker) so the PC returns to normal
      in-app mode. Your data is untouched either way.

  REQUIREMENTS:
    * Run as Administrator (right-click PowerShell -> Run as administrator).
    * nssm.exe present (service wrapper). Put it at <repo>\vendor\nssm\nssm.exe
      or pass -Nssm <path>. Download: https://nssm.cc/download

  USAGE (from the ZEHEN folder, elevated):
    powershell -ExecutionPolicy Bypass -File scripts\service\Install-ZehenServer.ps1
    # optional overrides:
    #   -OwnerProfile "C:\Users\shopowner"   (whose .zehen holds the data)
    #   -ExePath "...\ZEHEN.exe"             (packaged) or electron.exe (dev)
    #   -ScriptPath "...\electron\service-headless.js"
    #   -Port 3001
    #   -AllowFresh                          (permit a brand-new empty DB)
#>

[CmdletBinding()]
param(
  [string]$OwnerProfile = $env:USERPROFILE,
  [string]$ExePath,
  [string]$ScriptPath,
  [string]$Nssm,
  [int]$Port = 3001,
  [string]$ServiceName = 'ZEHENServer',
  [string]$DisplayName = 'ZEHEN Server',
  [int]$HealthTimeoutSec = 90,
  [switch]$AllowFresh
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ ok  ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn ] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[FAIL ] $m" -ForegroundColor Red; exit 1 }

# 0. Must be admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Die "Please run this in an ADMIN PowerShell (right-click -> Run as administrator)." }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Info "Repo root: $RepoRoot"

# 1. Resolve the binary + headless script.
# Prefer a packaged install if we can find one; otherwise fall back to the
# dev electron in node_modules (for test-machine validation from the repo).
if (-not $ExePath) {
  $candidates = @(
    (Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ExePath = $c; break } }
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
  Die "Could not find the ZEHEN/Electron exe. Pass -ExePath explicitly (packaged: the installed ZEHEN.exe)."
}
if (-not $ScriptPath) {
  $ScriptPath = Join-Path $RepoRoot 'electron\service-headless.js'
}
if (-not (Test-Path $ScriptPath)) { Die "Headless script not found: $ScriptPath" }
Ok "Exe:    $ExePath"
Ok "Script: $ScriptPath"

# 2. Resolve nssm.
if (-not $Nssm) {
  $n = Join-Path $RepoRoot 'vendor\nssm\nssm.exe'
  if (Test-Path $n) { $Nssm = $n }
}
if (-not $Nssm -or -not (Test-Path $Nssm)) {
  Die "nssm.exe not found. Download from https://nssm.cc/download and put it at vendor\nssm\nssm.exe (or pass -Nssm <path>)."
}
Ok "nssm:   $Nssm"

# 3. Verify the data home (never point at an empty profile).
$ZehenHome = Join-Path $OwnerProfile '.zehen'
$PgData    = Join-Path $ZehenHome 'pgdata'
$ClusterExists = Test-Path (Join-Path $PgData 'PG_VERSION')
Info "Owner profile: $OwnerProfile"
Info "Data home:     $ZehenHome  (cluster present: $ClusterExists)"

if (-not (Test-Path $ZehenHome)) {
  if (-not $AllowFresh) {
    Die "No .zehen folder under $OwnerProfile. If this is a brand-new server with no data yet, re-run with -AllowFresh. Otherwise pass the correct -OwnerProfile (the account that has been running ZEHEN)."
  }
  New-Item -ItemType Directory -Force -Path $ZehenHome | Out-Null
}
if (-not $ClusterExists -and -not $AllowFresh) {
  Die "No database cluster found at $PgData. Refusing to continue so we never create an empty second database. If this really is a fresh server, re-run with -AllowFresh."
}

# 4. SAFEGUARD: backup before cutover.
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $ZehenHome ("service-install-backup-" + $stamp)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Info "Backup folder: $backupDir"

foreach ($f in @('config.json','embedded-pg.json')) {
  $src = Join-Path $ZehenHome $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backupDir $f) -Force; Ok "Backed up $f" }
}

# Best-effort logical dump if the cluster is up and we have saved creds.
if ($ClusterExists) {
  $pgBin = Join-Path $RepoRoot 'vendor\pgsql\bin'
  $dumpAll = Join-Path $pgBin 'pg_dumpall.exe'
  $stateFile = Join-Path $ZehenHome 'embedded-pg.json'
  if ((Test-Path $dumpAll) -and (Test-Path $stateFile)) {
    try {
      $state = Get-Content $stateFile -Raw | ConvertFrom-Json
      $env:PGPASSWORD = $state.password
      $dumpFile = Join-Path $backupDir 'pg_dumpall.sql'
      Info "Taking logical backup (pg_dumpall) - this can take a moment..."
      & $dumpAll '-h' '127.0.0.1' '-p' "$($state.port)" '-U' 'postgres' '-w' '-f' $dumpFile
      if ($LASTEXITCODE -eq 0 -and (Test-Path $dumpFile)) { Ok "Logical backup written: $dumpFile" }
      else { Warn "pg_dumpall did not complete (exit $LASTEXITCODE). Config backup still taken; consider a manual in-app backup before proceeding." }
    } catch {
      Warn "Could not take a logical backup ($($_.Exception.Message)). The config backup is still in place."
    } finally {
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
  } else {
    Warn "pg_dumpall or saved DB state not found - skipped the logical backup. STRONGLY recommend taking a manual backup from ZEHEN (Settings -> Backup) before continuing."
  }
}

# 5. Grant SYSTEM + owner full control on the data dir.
# On reboot the service starts Postgres as LocalSystem; make sure both SYSTEM
# and the owner retain full access so ownership never blocks a start, and so
# reverting to in-app (owner-run) mode later still works.
if ($ClusterExists) {
  try {
    $userGrant = '{0}:(OI)(CI)F' -f $env:USERNAME
    & icacls $PgData /grant "*S-1-5-18:(OI)(CI)F" /grant $userGrant /T /C | Out-Null
    Ok "Granted SYSTEM + current user full control on pgdata."
  } catch { Warn "icacls grant failed ($($_.Exception.Message)); continuing." }
}

# 6. Drop the app-side marker so ZEHEN.exe stops self-hosting.
$marker = Join-Path $ZehenHome '.server-service.json'
$markerObj = [ordered]@{
  mode='service'; port=$Port; exe=$ExePath; script=$ScriptPath;
  ownerProfile=$OwnerProfile; installedAt=(Get-Date).ToString('o'); backup=$backupDir
}
($markerObj | ConvertTo-Json) | Set-Content -Path $marker -Encoding UTF8
Ok "Wrote marker: $marker"
if ($AllowFresh -and -not $ClusterExists) {
  Set-Content -Path (Join-Path $ZehenHome '.service-fresh-ok') -Value $stamp -Encoding UTF8
  Warn "Fresh-install flag set - the service is permitted to initialise a NEW database."
}

# 7. Register the service via nssm.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Info "Service already exists - stopping + removing before re-install."
  & $Nssm stop $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 2
  & $Nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

$svcLog = Join-Path $ZehenHome 'service-stdout.log'
$svcErr = Join-Path $ZehenHome 'service-stderr.log'
$homeDrive = $OwnerProfile.Substring(0,2)
$homePath  = $OwnerProfile.Substring(2)

Info "Registering service '$ServiceName'..."
& $Nssm install $ServiceName $ExePath | Out-Null
& $Nssm set $ServiceName AppParameters $ScriptPath | Out-Null
# ELECTRON_RUN_AS_NODE makes the app's own binary behave as plain Node.
# USERPROFILE redirects every ~/.zehen lookup to the owner's real data.
& $Nssm set $ServiceName AppEnvironmentExtra "ELECTRON_RUN_AS_NODE=1" "USERPROFILE=$OwnerProfile" "HOMEDRIVE=$homeDrive" "HOMEPATH=$homePath" | Out-Null
& $Nssm set $ServiceName AppDirectory $RepoRoot | Out-Null
& $Nssm set $ServiceName DisplayName $DisplayName | Out-Null
& $Nssm set $ServiceName Description "ZEHEN database + API. Serves billing clients on the LAN whenever this PC is on." | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $Nssm set $ServiceName ObjectName LocalSystem | Out-Null
& $Nssm set $ServiceName AppStdout $svcLog | Out-Null
& $Nssm set $ServiceName AppStderr $svcErr | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 1048576 | Out-Null
# Restart on crash, but throttle so a hard-failing config doesn't hot-loop.
& $Nssm set $ServiceName AppExit Default Restart | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $Nssm set $ServiceName AppThrottle 10000 | Out-Null
Ok "Service registered."

# 8. Firewall: allow the API port on private networks.
try {
  netsh advfirewall firewall delete rule name="ZEHEN Server ($Port)" 2>$null | Out-Null
  netsh advfirewall firewall add rule name="ZEHEN Server ($Port)" dir=in action=allow protocol=TCP localport=$Port profile=private | Out-Null
  Ok "Firewall rule added for TCP $Port (private networks)."
} catch { Warn "Could not add firewall rule automatically - add it manually if clients can't connect." }

# 9. Start + health-check, with rollback on failure.
Info "Starting service..."
& $Nssm start $ServiceName | Out-Null

$healthUrl = "http://127.0.0.1:$Port/api/health"
$deadline  = (Get-Date).AddSeconds($HealthTimeoutSec)
$healthy = $false
Info "Waiting for $healthUrl (up to $HealthTimeoutSec s)..."
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Milliseconds 1500 }
}

if ($healthy) {
  Ok "ZEHEN Server is HEALTHY and responding on port $Port."
  Ok "Done. The server will now start automatically whenever this PC is powered on."
  Info "Point each billing PC at:  http://<this-PC-ip>:$Port"
  Info "Logs: $svcErr  and  $(Join-Path $ZehenHome 'service.log')"
  exit 0
}

# Rollback
Warn "Service did not become healthy within $HealthTimeoutSec s - ROLLING BACK so this PC keeps working in normal in-app mode."
try { & $Nssm stop $ServiceName confirm | Out-Null } catch {}
try { & $Nssm remove $ServiceName confirm | Out-Null } catch {}
try { Remove-Item $marker -Force -ErrorAction SilentlyContinue } catch {}
try { Remove-Item (Join-Path $ZehenHome '.service-fresh-ok') -Force -ErrorAction SilentlyContinue } catch {}
Write-Host ""
Warn "Last 30 lines of the service error log ($svcErr):"
if (Test-Path $svcErr) { Get-Content $svcErr -Tail 30 | ForEach-Object { Write-Host "    $_" } }
Die "Rolled back. Your data is untouched and ZEHEN will open normally. Check the log above, fix the cause, and re-run."

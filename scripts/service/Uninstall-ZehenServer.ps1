<#
  Uninstall-ZehenServer.ps1
  -------------------------------------------------------------------------
  Cleanly reverses Install-ZehenServer.ps1: stops + removes the Windows
  service and the app-side marker so the PC goes back to normal in-app mode
  (ZEHEN.exe hosts its own database + API again, as it did before).

  It does NOT touch your data. The database stays exactly where it is.

  Run in an ADMIN PowerShell:
    powershell -ExecutionPolicy Bypass -File scripts\service\Uninstall-ZehenServer.ps1
    # optional: -OwnerProfile "C:\Users\shopowner"  -StopPostgres
#>

[CmdletBinding()]
param(
  [string]$OwnerProfile = $env:USERPROFILE,
  [string]$Nssm,
  [string]$ServiceName = 'ZEHENServer',
  [int]$Port = 3001,
  [switch]$StopPostgres
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "[uninstall] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[  ok  ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[ warn ] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[ FAIL ] $m" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Die "Please run this in an ADMIN PowerShell (right-click -> Run as administrator)." }

$RepoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ZehenHome = Join-Path $OwnerProfile '.zehen'

# Resolve nssm (used to remove the service). Fall back to sc.exe if absent.
if (-not $Nssm) {
  $n = Join-Path $RepoRoot 'vendor\nssm\nssm.exe'
  if (Test-Path $n) { $Nssm = $n }
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Info "Stopping + removing service '$ServiceName'..."
  if ($Nssm -and (Test-Path $Nssm)) {
    & $Nssm stop $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
    & $Nssm remove $ServiceName confirm | Out-Null
  } else {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    & sc.exe delete $ServiceName | Out-Null
  }
  Ok "Service removed."
} else {
  Warn "Service '$ServiceName' was not installed - nothing to remove."
}

# Optionally stop Postgres cleanly so the app restarts it under the owner on
# next launch. Safe to skip: the running cluster is reused by the app anyway.
if ($StopPostgres) {
  $pgCtl  = Join-Path $RepoRoot 'vendor\pgsql\bin\pg_ctl.exe'
  $pgData = Join-Path $ZehenHome 'pgdata'
  if ((Test-Path $pgCtl) -and (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
    try {
      Info "Stopping Postgres (fast)..."
      & $pgCtl '-D' $pgData 'stop' '-m' 'fast' '-w' '-t' '30' | Out-Null
      Ok "Postgres stopped."
    } catch { Warn "pg_ctl stop reported: $($_.Exception.Message) (it may already be stopped)." }
  }
}

# Remove the app-side markers so ZEHEN.exe self-hosts again.
foreach ($f in @('.server-service.json', '.service-fresh-ok')) {
  $p = Join-Path $ZehenHome $f
  if (Test-Path $p) { Remove-Item $p -Force; Ok "Removed $f" }
}

# Remove the firewall rule we added (harmless to leave, but keep it tidy).
try { netsh advfirewall firewall delete rule name="ZEHEN Server ($Port)" 2>$null | Out-Null } catch {}

Ok "Reverted. ZEHEN will now run in normal in-app mode again on this PC."
Info "Your database and every bill/ledger are untouched at: $(Join-Path $ZehenHome 'pgdata')"

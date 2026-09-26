# Cloudflare Tunnel helper for CCW (Windows / PowerShell)
# Usage:
#   .\enable-tunnel.ps1                       # quick tunnel (random trycloudflare.com domain)
#   .\enable-tunnel.ps1 -Mode named -Hostname ccw.example.com
#   .\enable-tunnel.ps1 -Port 8888
#   .\enable-tunnel.ps1 -Stop                 # stop running tunnel processes
param(
    [ValidateSet("quick", "named")]
    [string]$Mode = "quick",
    [string]$Hostname = "",
    [string]$Name = "ccw-console",
    [int]$Port = 8080,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

function Find-Cloudflared {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $PSScriptRoot "cloudflared\cloudflared.exe"
    if (Test-Path $local) { return $local }
    $candidates = @(
        "$env:ProgramFiles\Cloudflare\cloudflared.exe",
        "${env:ProgramFiles(x86)}\Cloudflare\cloudflared.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\cloudflared.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

if ($Stop) {
    $procs = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $procs) { Write-Host "No cloudflared process is running."; exit 0 }
    $procs | Stop-Process -Force
    Write-Host "Stopped $($procs.Count) cloudflared process(es)."
    exit 0
}

$exe = Find-Cloudflared
if (-not $exe) {
    Write-Host "cloudflared not found. Installing via winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: winget is unavailable. Install cloudflared manually:"
        Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        exit 1
    }
    winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
    $env:PATH = "$env:ProgramFiles\Cloudflare;$env:PATH"
    $exe = Find-Cloudflared
    if (-not $exe) {
        Write-Host "ERROR: installation finished but cloudflared is still not on PATH. Please restart the shell."
        exit 1
    }
}

Write-Host "cloudflared: $exe"
& $exe --version

if ($Mode -eq "quick") {
    Write-Host ""
    Write-Host "Starting quick tunnel -> http://127.0.0.1:$Port"
    Write-Host "The public https://*.trycloudflare.com address will appear below shortly."
    Write-Host "Press Ctrl+C to stop."
    Write-Host ""
    & $exe tunnel --no-autoupdate --url "http://127.0.0.1:$Port"
    exit 0
}

# ---- named tunnel (fixed domain) ----
if (-not $Hostname) {
    Write-Host "ERROR: -Hostname is required in named mode, e.g. -Hostname ccw.example.com"
    exit 1
}
$cert = Join-Path $HOME ".cloudflared\cert.pem"
if (-not (Test-Path $cert)) {
    Write-Host "Cloudflare login required. Running: cloudflared tunnel login"
    & $exe tunnel login
    if (-not (Test-Path $cert)) {
        Write-Host "ERROR: cert.pem not found after login. Aborting."
        exit 1
    }
}

$existing = & $exe tunnel list 2>$null
if (-not ($existing -match $Name)) {
    Write-Host "Creating tunnel: $Name"
    & $exe tunnel create $Name
} else {
    Write-Host "Tunnel already exists: $Name"
}

Write-Host "Routing DNS: $Hostname -> $Name"
& $exe tunnel route dns $Name $Hostname

$cred = Get-ChildItem (Join-Path $HOME ".cloudflared") -Filter "*.json" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $cred) { Write-Host "ERROR: tunnel credentials not found."; exit 1 }

$cfgDir = Join-Path $PSScriptRoot "cloudflared"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = Join-Path $cfgDir "config.yml"
$credPosix = $cred.FullName -replace "\\", "/"
@"
tunnel: $Name
credentials-file: $credPosix

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$Port
  - service: http_status:404
"@ | Set-Content -Path $cfg -Encoding UTF8

Write-Host ""
Write-Host "Config written: $cfg"
Write-Host "Public address: https://$Hostname"
Write-Host "Press Ctrl+C to stop."
Write-Host ""
& $exe --config $cfg tunnel --no-autoupdate run $Name

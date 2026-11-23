# start-tunnel.ps1
param (
    [int]$Port = 5000,
    [string]$Domain = "https://unplowed-nutlike-antitoxic.ngrok-free.dev"
)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   StreetVerse Local Backend Tunnel Setup    " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "Forwarding HTTPS & WSS requests to localhost:$Port..." -ForegroundColor Yellow

$ngrok = Get-Command ngrok -ErrorAction SilentlyContinue

if ($ngrok) {
    Write-Host ""
    Write-Host "Starting permanent ngrok tunnel to $Domain..." -ForegroundColor Green
    Write-Host "Permanent URL: $Domain" -ForegroundColor Cyan
    Write-Host "This URL is permanent and configured in your Vercel Environment Variables." -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop the tunnel at any time." -ForegroundColor Gray
    Write-Host ""

    ngrok http $Port --url $Domain
    exit 0
}

Write-Host "ngrok not found in PATH. Falling back to Cloudflare Tunnel..." -ForegroundColor Yellow
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue

if (-not $cloudflared) {
    $localExe = Join-Path $PSScriptRoot "cloudflared.exe"
    if (-not (Test-Path $localExe)) {
        Write-Host "Cloudflared not found in PATH. Downloading standalone cloudflared.exe..." -ForegroundColor Yellow
        $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        try {
            Invoke-WebRequest -Uri $url -OutFile $localExe
            Write-Host "Downloaded successfully to $localExe!" -ForegroundColor Green
        } catch {
            Write-Host "Download failed: $_" -ForegroundColor Red
            Write-Host "Alternative: Install ngrok (ngrok http $Port) or install cloudflared manually." -ForegroundColor Yellow
            exit 1
        }
    }
    $cmd = $localExe
} else {
    $cmd = "cloudflared"
}

Write-Host ""
Write-Host "Starting Cloudflare Tunnel..." -ForegroundColor Green
Write-Host "Look for the URL ending with '.trycloudflare.com' below." -ForegroundColor Cyan
Write-Host "Copy that URL and paste it into your Vercel Environment Variables as NEXT_PUBLIC_API_URL / VITE_API_URL." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the tunnel at any time." -ForegroundColor Gray
Write-Host ""

& $cmd tunnel --url "http://localhost:$Port"

#!/usr/bin/env pwsh
# PowerShell script to install and start SearxNG via Docker on Windows.
#
# This is the PREFERRED method for Windows users because SearxNG doesn't
# run natively on Windows (Python dependencies don't compile correctly).
# Docker Desktop provides a clean, isolated environment.
#
# Usage:
#   .\scripts\setup-searx-docker.ps1           # install + start
#   .\scripts\setup-searx-docker.ps1 -Check    # just check status
#   .\scripts\setup-searx-docker.ps1 -Start    # start if installed
#   .\scripts\setup-searx-docker.ps1 -Stop     # stop container
#   .\scripts\setup-searx-docker.ps1 -Remove   # remove container + image

param(
    [switch]$Check,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Remove,
    [switch]$Yes
)

$CONTAINER_NAME = "claude-killer-searxng"
$SEARX_PORT = 8888
$SEARX_URL = "http://localhost:$SEARX_PORT"

function Test-DockerAvailable {
    try {
        $null = docker --version 2>&1
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-ContainerRunning {
    try {
        $status = docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>&1
        return $status -eq "true"
    } catch {
        return $false
    }
}

function Test-ContainerExists {
    try {
        $null = docker inspect $CONTAINER_NAME 2>&1
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-SearxResponding {
    try {
        $response = Invoke-WebRequest -Uri "$SEARX_URL/search?q=test&format=json" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Install-SearxDocker {
    Write-Host "============================================================"
    Write-Host "  Claude-Killer - SearxNG Docker Setup (Windows)"
    Write-Host "============================================================"
    Write-Host ""

    # Check if Docker is available
    if (-not (Test-DockerAvailable)) {
        Write-Host "[FAIL] Docker is not installed or not in PATH."
        Write-Host ""
        Write-Host "To install Docker Desktop:"
        Write-Host "  1. Download from: https://www.docker.com/products/docker-desktop"
        Write-Host "  2. Run the installer"
        Write-Host "  3. Start Docker Desktop (wait for the whale icon in system tray)"
        Write-Host "  4. Re-run this script: .\scripts\setup-searx-docker.ps1"
        Write-Host ""
        Write-Host "Alternatively, use WSL (Windows Subsystem for Linux) and run"
        Write-Host "the Python setup inside a Linux distro."
        return $false
    }

    # Check if Docker daemon is running. If not, try to start Docker Desktop
    # automatically. This handles the common case where the user installed
    # Docker Desktop but hasn't launched it yet.
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[INFO] Docker daemon is not running. Attempting to start Docker Desktop..."

            # Find Docker Desktop executable
            $dockerExe = $null
            $candidates = @(
                "C:\Program Files\Docker\Docker\Docker Desktop.exe",
                "C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe",
                "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
            )
            foreach ($cand in $candidates) {
                if (Test-Path $cand) {
                    $dockerExe = $cand
                    break
                }
            }

            if (-not $dockerExe) {
                Write-Host "[FAIL] Docker Desktop executable not found."
                Write-Host "       Start Docker Desktop manually, then re-run this script."
                return $false
            }

            # Launch Docker Desktop (detached)
            Write-Host "[START] Launching Docker Desktop..."
            Start-Process -FilePath $dockerExe
            Write-Host "[WAIT] Waiting for Docker daemon to be ready (up to 90 seconds)..."

            # Wait for daemon — poll every 2 seconds, up to 90 seconds
            $ready = $false
            for ($i = 0; $i -lt 45; $i++) {
                Start-Sleep -Seconds 2
                $null = docker info 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Host ""
                    Write-Host "[OK] Docker daemon is ready (took ~$(($i + 1) * 2) seconds)."
                    $ready = $true
                    break
                }
                Write-Host "." -NoNewline
            }

            if (-not $ready) {
                Write-Host ""
                Write-Host "[FAIL] Docker daemon did not start within 90 seconds."
                Write-Host "       Start Docker Desktop manually, then re-run this script."
                return $false
            }
        }
    } catch {
        Write-Host "[FAIL] Cannot connect to Docker daemon."
        return $false
    }

    Write-Host "[OK] Docker is available and running."
    Write-Host ""

    # Check if container already exists
    if (Test-ContainerExists) {
        if (Test-ContainerRunning) {
            Write-Host "[OK] SearxNG container is already running."
            Write-Host "     URL: $SEARX_URL"
            return $true
        } else {
            Write-Host "[INFO] Container exists but is stopped. Starting..."
            docker start $CONTAINER_NAME
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[OK] Container started. Waiting for SearxNG to be ready..."
                return (Wait-SearxReady)
            } else {
                Write-Host "[FAIL] Failed to start container."
                return $false
            }
        }
    }

    # Pull image and create container
    Write-Host "[INSTALL] Pulling SearxNG Docker image (searxng/searxng)..."
    Write-Host "          This may take 1-3 minutes on first run..."
    docker pull searxng/searxng
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Failed to pull SearxNG image."
        Write-Host "       Check your internet connection and try again."
        return $false
    }

    Write-Host ""
    Write-Host "[INSTALL] Creating and starting container..."
    Write-Host "  Name: $CONTAINER_NAME"
    Write-Host "  Port: $SEARX_PORT -> 8080 (container internal)"
    Write-Host "  URL:  $SEARX_URL"
    Write-Host ""

    # Create settings.yml that enables JSON format (required for API access)
    $settingsDir = "$env:USERPROFILE\.claude-killer\searxng"
    New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null

    $settingsContent = @"
use_default_settings: true

server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "$([System.Guid]::NewGuid().ToString('N'))"

search:
  formats:
    - html
    - json
"@

    $settingsPath = "$settingsDir\settings.yml"
    $settingsContent | Out-File -FilePath $settingsPath -Encoding utf8 -NoNewline

    # Run container with volume mount for settings
    docker run -d `
        --name $CONTAINER_NAME `
        -p "${SEARX_PORT}:8080" `
        -v "${settingsPath}:/etc/searxng/settings.yml:ro" `
        -e "BASE_URL=$SEARX_URL" `
        -e "INSTANCE_NAME=claude-killer-searxng" `
        --restart unless-stopped `
        searxng/searxng

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Failed to create container."
        Write-Host "       Check if port $SEARX_PORT is already in use:"
        Write-Host "         netstat -ano | findstr :$SEARX_PORT"
        return $false
    }

    Write-Host "[OK] Container created and started."
    Write-Host ""
    return (Wait-SearxReady)
}

function Wait-SearxReady {
    Write-Host "[WAIT] Waiting for SearxNG to be ready (up to 60 seconds)..." -NoNewline
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        Write-Host "." -NoNewline
        if (Test-SearxResponding) {
            Write-Host ""
            Write-Host ""
            Write-Host "[OK] SearxNG is ready!"
            Write-Host "  URL: $SEARX_URL"
            Write-Host "  Container: $CONTAINER_NAME"
            Write-Host ""
            Write-Host "Claude-Killer will now use SearxNG (Google + Bing + DDG) for searches."
            Write-Host "The container starts automatically when Docker Desktop starts."
            return $true
        }
    }
    Write-Host ""
    Write-Host ""
    Write-Host "[FAIL] SearxNG did not become ready within 60 seconds."
    Write-Host "       Check container logs: docker logs $CONTAINER_NAME"
    return $false
}

function Start-SearxContainer {
    if (-not (Test-ContainerExists)) {
        Write-Host "[FAIL] Container does not exist. Run without flags to install first."
        return $false
    }
    if (Test-ContainerRunning) {
        Write-Host "[OK] Container is already running."
        return $true
    }
    Write-Host "[START] Starting container..."
    docker start $CONTAINER_NAME
    if ($LASTEXITCODE -eq 0) {
        return (Wait-SearxReady)
    }
    Write-Host "[FAIL] Failed to start container."
    return $false
}

function Stop-SearxContainer {
    if (-not (Test-ContainerExists)) {
        Write-Host "[INFO] Container does not exist."
        return
    }
    Write-Host "[STOP] Stopping container..."
    docker stop $CONTAINER_NAME
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Container stopped."
    } else {
        Write-Host "[FAIL] Failed to stop container."
    }
}

function Remove-SearxContainer {
    if (Test-ContainerExists) {
        Write-Host "[REMOVE] Stopping and removing container..."
        docker rm -f $CONTAINER_NAME
        Write-Host "[OK] Container removed."
    }
    Write-Host "[INFO] To also remove the Docker image:"
    Write-Host "  docker rmi searxng/searxng"
}

function Show-Status {
    Write-Host "SearxNG Docker Status:"
    Write-Host "  Container : $CONTAINER_NAME"

    if (-not (Test-DockerAvailable)) {
        Write-Host "  Docker    : NOT INSTALLED"
        Write-Host ""
        Write-Host "Install Docker Desktop: https://www.docker.com/products/docker-desktop"
        return
    }

    Write-Host "  Docker    : Installed"

    if (Test-ContainerExists) {
        if (Test-ContainerRunning) {
            Write-Host "  Status    : RUNNING"
            if (Test-SearxResponding) {
                Write-Host "  Health    : HEALTHY (responding to JSON API)"
            } else {
                Write-Host "  Health    : STARTING (not responding yet)"
            }
        } else {
            Write-Host "  Status    : STOPPED"
            Write-Host "  Start with: .\scripts\setup-searx-docker.ps1 -Start"
        }
    } else {
        Write-Host "  Status    : NOT INSTALLED"
        Write-Host "  Install:    .\scripts\setup-searx-docker.ps1"
    }
    Write-Host "  URL       : $SEARX_URL"
}

# --- Main logic ---

if ($Check) {
    Show-Status
    return
}

if ($Start) {
    Start-SearxContainer
    return
}

if ($Stop) {
    Stop-SearxContainer
    return
}

if ($Remove) {
    Remove-SearxContainer
    return
}

# Default: install
Install-SearxDocker

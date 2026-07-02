#!/usr/bin/env python3
"""
Searx setup helper for Claude-Killer.

This script:
1. Checks if Searx is already installed/running
2. If not, offers to install it via Python (git clone + venv)
3. Starts Searx in the background
4. Verifies it's accessible

Usage:
    python3 setup-searx.py          # interactive setup
    python3 setup-searx.py --check  # just check if running
    python3 setup-searx.py --start  # start if installed
    python3 setup-searx.py --yes    # non-interactive (used by npm postinstall)

NO EMOJIS: Windows cmd.exe (CP437/CP1252) cannot render Unicode emojis
like boxes, checkmarks, etc. This script uses ASCII-only output to
ensure it works on ALL terminals (cmd, PowerShell, Git Bash, Linux, macOS).
"""

import os
import sys
import subprocess
import urllib.request
import urllib.error
import json
import platform
from pathlib import Path

SEARX_DIR = Path.home() / ".claude-killer" / "searxng"
SEARX_PORT = 8888
SEARX_URL = f"http://localhost:{SEARX_PORT}"

IS_WINDOWS = platform.system() == "Windows"


def get_venv_python():
    """Get the venv python path (platform-specific)."""
    if IS_WINDOWS:
        return str(SEARX_DIR / ".venv" / "Scripts" / "python.exe")
    return str(SEARX_DIR / ".venv" / "bin" / "python")


def get_venv_pip():
    """Get the venv pip path (platform-specific)."""
    if IS_WINDOWS:
        return str(SEARX_DIR / ".venv" / "Scripts" / "pip.exe")
    return str(SEARX_DIR / ".venv" / "bin" / "pip")


def is_searx_running():
    """Check if Searx is running and responding with JSON."""
    try:
        url = f"{SEARX_URL}/search?q=test&format=json"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf8"))
            return "results" in data
    except Exception:
        return False


def is_searx_installed():
    """Check if Searx is installed in ~/.claude-killer/searxng."""
    return (SEARX_DIR / "searx" / "settings.yml").exists() or \
           (SEARX_DIR / "settings.yml").exists()


def install_searx():
    """Install Searx via git clone + Python venv."""
    print(f"\n[INSTALL] Installing Searx to: {SEARX_DIR}")
    SEARX_DIR.parent.mkdir(parents=True, exist_ok=True)

    # Step 1: Clone repo
    if not SEARX_DIR.exists():
        print("  [1/4] Cloning searxng repository...")
        result = subprocess.run(
            ["git", "clone", "https://github.com/searxng/searxng.git", str(SEARX_DIR)],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"  [FAIL] Git clone failed: {result.stderr}")
            return False
    else:
        print("  [1/4] Repository already exists, skipping clone")

    # Step 2: Create venv
    venv_dir = SEARX_DIR / ".venv"
    if not venv_dir.exists():
        print("  [2/4] Creating Python virtual environment...")
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"  [FAIL] venv creation failed: {result.stderr}")
            return False
    else:
        print("  [2/4] venv already exists, skipping")

    # Step 3: Install dependencies
    print("  [3/4] Installing dependencies (this may take a minute)...")
    pip = get_venv_pip()
    result = subprocess.run(
        [pip, "install", "-e", str(SEARX_DIR)],
        capture_output=True, text=True, cwd=str(SEARX_DIR)
    )
    if result.returncode != 0:
        print(f"  [FAIL] pip install failed: {result.stderr[:500]}")
        return False

    # Step 4: Generate settings
    print("  [4/4] Generating settings.yml...")
    settings_path = SEARX_DIR / "settings.yml"
    if not settings_path.exists():
        # Create minimal settings that enables JSON format
        settings_content = f"""use_default_settings: true

server:
  bind_address: "127.0.0.1"
  port: {SEARX_PORT}
  secret_key: "{os.urandom(32).hex()}"

search:
  formats:
    - html
    - json
"""
        settings_path.write_text(settings_content, encoding="utf-8")

    print("\n[OK] Searx installed successfully!")
    print(f"   Location: {SEARX_DIR}")
    print(f"   URL: {SEARX_URL}")
    return True


def start_searx():
    """Start Searx in background."""
    if not is_searx_installed():
        print("[FAIL] Searx is not installed. Run with --install first.")
        return False

    if is_searx_running():
        print(f"[OK] Searx is already running at {SEARX_URL}")
        return True

    print(f"[START] Starting Searx at {SEARX_URL}...")
    python = get_venv_python()

    if not os.path.exists(python):
        print(f"[FAIL] Python not found at: {python}")
        print("       Searx may not be installed correctly. Try re-running setup.")
        return False

    # Start in background, detach
    log_file = SEARX_DIR / "searx.log"

    try:
        if IS_WINDOWS:
            # Windows: use CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS
            import ctypes
            proc = subprocess.Popen(
                [python, "-m", "searx.webapp"],
                stdout=open(log_file, "w"),
                stderr=subprocess.STDOUT,
                cwd=str(SEARX_DIR),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
            )
        else:
            # Unix: use start_new_session to detach
            proc = subprocess.Popen(
                [python, "-m", "searx.webapp"],
                stdout=open(log_file, "w"),
                stderr=subprocess.STDOUT,
                cwd=str(SEARX_DIR),
                start_new_session=True  # detach from parent
            )
    except Exception as e:
        print(f"[FAIL] Failed to start Searx: {e}")
        return False

    # Wait for it to start (up to 20 seconds)
    print("  Waiting for Searx to start", end="", flush=True)
    import time
    for i in range(40):
        time.sleep(0.5)
        print(".", end="", flush=True)
        if is_searx_running():
            print(f"\n[OK] Searx is running at {SEARX_URL}")
            print(f"   PID: {proc.pid}")
            print(f"   Log: {log_file}")
            return True

    print(f"\n[FAIL] Searx didn't start within 20 seconds. Check log: {log_file}")
    return False


def stop_searx():
    """Stop Searx if running."""
    try:
        if IS_WINDOWS:
            # Windows: use taskkill
            result = subprocess.run(
                ["taskkill", "/F", "/IM", "python.exe", "/FI",
                 f"WINDOWTITLE eq searx*"],
                capture_output=True, text=True
            )
            # Also try by finding the process on the port
            result2 = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True
            )
            for line in result2.stdout.splitlines():
                if f":{SEARX_PORT}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts:
                        pid = parts[-1]
                        subprocess.run(["taskkill", "/F", "/PID", pid],
                                     capture_output=True, text=True)
            print("[OK] Searx stopped")
        else:
            # Unix: use pkill
            result = subprocess.run(["pkill", "-f", "searx.webapp"],
                                    capture_output=True, text=True)
            if result.returncode == 0:
                print("[OK] Searx stopped")
            else:
                print("[INFO] Searx was not running")
    except Exception as e:
        print(f"[FAIL] Failed to stop: {e}")


def main():
    args = sys.argv[1:]
    non_interactive = "--yes" in args or "-y" in args

    # Force UTF-8 output on Windows (prevents UnicodeEncodeError)
    if IS_WINDOWS:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass  # old Python versions don't have reconfigure

    if "--check" in args:
        if is_searx_running():
            print(f"[OK] Searx is running at {SEARX_URL}")
            sys.exit(0)
        elif is_searx_installed():
            print("[WARN] Searx is installed but not running. Use --start to start it.")
            sys.exit(1)
        else:
            print("[FAIL] Searx is not installed. Run without args to install.")
            sys.exit(2)

    elif "--start" in args:
        sys.exit(0 if start_searx() else 1)

    elif "--stop" in args:
        stop_searx()
        sys.exit(0)

    elif "--install" in args or non_interactive:
        # Non-interactive install mode (used by npm postinstall)
        # No prompts -- installs and starts automatically
        print("=" * 60)
        print("  Claude-Killer -- Searx Local Search Setup (auto)")
        print("=" * 60)

        if is_searx_running():
            print(f"\n[OK] Searx is already running at {SEARX_URL}")
            sys.exit(0)

        if is_searx_installed():
            print("\n[INFO] Searx already installed. Starting...")
            if start_searx():
                print("\n[OK] Searx started successfully.")
                sys.exit(0)
            else:
                print("\n[WARN] Searx installed but failed to start. Will use Bing fallback.")
                sys.exit(0)  # Don't fail npm install

        # Install
        print(f"\nInstall location: {SEARX_DIR}")
        print("Disk usage: ~200MB | RAM: ~50-100MB | Requirements: Python 3.8+, git")
        print()
        if install_searx():
            print("\n[START] Starting Searx...")
            start_searx()
            print("\n[OK] Searx installed and started.")
            print("   Claude-Killer will use it automatically on next launch.")
            sys.exit(0)
        else:
            print("\n[WARN] Searx installation failed. Claude-Killer will use Bing fallback.")
            sys.exit(0)  # Don't fail npm install -- Searx is optional

    else:
        # Interactive
        print("=" * 60)
        print("  Claude-Killer -- Searx Local Search Setup")
        print("=" * 60)

        if is_searx_running():
            print(f"\n[OK] Searx is already running at {SEARX_URL}")
            print("   Claude-Killer will use it automatically.")
            sys.exit(0)

        if is_searx_installed():
            print("\n[INFO] Searx is installed but not running.")
            resp = input("  Start it now? [Y/n] ").strip().lower()
            if resp in ("", "y", "yes"):
                if start_searx():
                    print("\n[OK] All set! Claude-Killer will use Searx for searches.")
                else:
                    sys.exit(1)
            else:
                print("\nYou can start it later with: python3 setup-searx.py --start")
            sys.exit(0)

        # Not installed
        print("\nSearx is not installed. It provides stable, free web search")
        print("by aggregating Google + Bing + DuckDuckGo results locally.")
        print(f"\nInstall location: {SEARX_DIR}")
        print("Disk usage: ~200MB")
        print("RAM when running: ~50-100MB")
        print("\nRequirements: Python 3.8+, git")
        resp = input("\n  Install Searx now? [Y/n] ").strip().lower()
        if resp not in ("", "y", "yes"):
            print("\nInstallation cancelled. Claude-Killer will continue using Bing scraping.")
            sys.exit(0)

        if install_searx():
            resp = input("\n  Start Searx now? [Y/n] ").strip().lower()
            if resp in ("", "y", "yes"):
                if start_searx():
                    print("\n[OK] All set! Claude-Killer will use Searx automatically.")
                    print("   To stop it later: python3 setup-searx.py --stop")
                    print("   To restart: python3 setup-searx.py --start")
        else:
            print("\n[FAIL] Installation failed. See errors above.")
            sys.exit(1)


if __name__ == "__main__":
    main()

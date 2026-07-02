#!/usr/bin/env bash
# Shell script to install and start SearxNG via Docker on Linux/macOS.
#
# This is the PREFERRED method because Docker provides isolation and
# avoids Python dependency issues. Works on Linux, macOS, and Windows
# (via Git Bash or WSL).
#
# Usage:
#   ./scripts/setup-searx-docker.sh            # install + start
#   ./scripts/setup-searx-docker.sh check      # just check status
#   ./scripts/setup-searx-docker.sh start      # start if installed
#   ./scripts/setup-searx-docker.sh stop       # stop container
#   ./scripts/setup-searx-docker.sh remove     # remove container + image

set -e

CONTAINER_NAME="claude-killer-searxng"
SEARX_PORT=8888
SEARX_URL="http://localhost:${SEARX_PORT}"

# --- Helpers ---

check_docker_available() {
    command -v docker >/dev/null 2>&1
}

check_docker_running() {
    docker info >/dev/null 2>&1
}

container_exists() {
    docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1
}

container_running() {
    local status
    status=$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo "false")
    [ "${status}" = "true" ]
}

searx_responding() {
    curl -sf --max-time 5 "${SEARX_URL}/search?q=test&format=json" >/dev/null 2>&1
}

wait_searx_ready() {
    echo -n "[WAIT] Waiting for SearxNG to be ready (up to 60 seconds)..."
    for i in $(seq 1 60); do
        echo -n "."
        sleep 1
        if searx_responding; then
            echo ""
            echo ""
            echo "[OK] SearxNG is ready!"
            echo "  URL: ${SEARX_URL}"
            echo "  Container: ${CONTAINER_NAME}"
            echo ""
            echo "Claude-Killer will now use SearxNG (Google + Bing + DDG) for searches."
            return 0
        fi
    done
    echo ""
    echo ""
    echo "[FAIL] SearxNG did not become ready within 60 seconds."
    echo "       Check container logs: docker logs ${CONTAINER_NAME}"
    return 1
}

# --- Commands ---

install_searx() {
    echo "============================================================"
    echo "  Claude-Killer - SearxNG Docker Setup (Linux/macOS)"
    echo "============================================================"
    echo ""

    if ! check_docker_available; then
        echo "[FAIL] Docker is not installed or not in PATH."
        echo ""
        echo "To install Docker:"
        echo "  Linux:  https://docs.docker.com/engine/install/"
        echo "  macOS:  https://docs.docker.com/desktop/install/mac-install/"
        echo ""
        echo "Alternatively, use the Python setup:"
        echo "  python3 scripts/setup-searx.py"
        return 1
    fi

    if ! check_docker_running; then
        echo "[FAIL] Docker daemon is not running."
        echo "       Start Docker service:"
        echo "         Linux:  sudo systemctl start docker"
        echo "         macOS:  open Docker Desktop"
        return 1
    fi

    echo "[OK] Docker is available and running."
    echo ""

    if container_exists; then
        if container_running; then
            echo "[OK] SearxNG container is already running."
            echo "     URL: ${SEARX_URL}"
            return 0
        else
            echo "[INFO] Container exists but is stopped. Starting..."
            docker start "${CONTAINER_NAME}"
            wait_searx_ready
            return $?
        fi
    fi

    echo "[INSTALL] Pulling SearxNG Docker image (searxng/searxng)..."
    echo "          This may take 1-3 minutes on first run..."
    docker pull searxng/searxng

    echo ""
    echo "[INSTALL] Creating and starting container..."
    echo "  Name: ${CONTAINER_NAME}"
    echo "  Port: ${SEARX_PORT} -> 8080 (container internal)"
    echo "  URL:  ${SEARX_URL}"
    echo ""

    # Create settings directory and file
    SETTINGS_DIR="${HOME}/.claude-killer/searxng"
    mkdir -p "${SETTINGS_DIR}"

    SECRET_KEY=$(head -c 32 /dev/urandom | xxd -p | head -c 64)
    cat > "${SETTINGS_DIR}/settings.yml" << EOF
use_default_settings: true

server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "${SECRET_KEY}"

search:
  formats:
    - html
    - json
EOF

    docker run -d \
        --name "${CONTAINER_NAME}" \
        -p "${SEARX_PORT}:8080" \
        -v "${SETTINGS_DIR}/settings.yml:/etc/searxng/settings.yml:ro" \
        -e "BASE_URL=${SEARX_URL}" \
        -e "INSTANCE_NAME=claude-killer-searxng" \
        --restart unless-stopped \
        searxng/searxng

    echo "[OK] Container created and started."
    echo ""
    wait_searx_ready
    return $?
}

start_container() {
    if ! container_exists; then
        echo "[FAIL] Container does not exist. Run without args to install first."
        return 1
    fi
    if container_running; then
        echo "[OK] Container is already running."
        return 0
    fi
    echo "[START] Starting container..."
    docker start "${CONTAINER_NAME}"
    wait_searx_ready
    return $?
}

stop_container() {
    if ! container_exists; then
        echo "[INFO] Container does not exist."
        return 0
    fi
    echo "[STOP] Stopping container..."
    docker stop "${CONTAINER_NAME}"
    echo "[OK] Container stopped."
}

remove_container() {
    if container_exists; then
        echo "[REMOVE] Stopping and removing container..."
        docker rm -f "${CONTAINER_NAME}"
        echo "[OK] Container removed."
    fi
    echo "[INFO] To also remove the Docker image:"
    echo "  docker rmi searxng/searxng"
}

show_status() {
    echo "SearxNG Docker Status:"
    echo "  Container : ${CONTAINER_NAME}"

    if ! check_docker_available; then
        echo "  Docker    : NOT INSTALLED"
        echo ""
        echo "Install Docker: https://docs.docker.com/get-docker/"
        return
    fi

    echo "  Docker    : Installed"

    if container_exists; then
        if container_running; then
            echo "  Status    : RUNNING"
            if searx_responding; then
                echo "  Health    : HEALTHY (responding to JSON API)"
            else
                echo "  Health    : STARTING (not responding yet)"
            fi
        else
            echo "  Status    : STOPPED"
            echo "  Start with: ./scripts/setup-searx-docker.sh start"
        fi
    else
        echo "  Status    : NOT INSTALLED"
        echo "  Install:    ./scripts/setup-searx-docker.sh"
    fi
    echo "  URL       : ${SEARX_URL}"
}

# --- Main ---

case "${1:-install}" in
    check)
        show_status
        ;;
    start)
        start_container
        ;;
    stop)
        stop_container
        ;;
    remove)
        remove_container
        ;;
    install|"")
        install_searx
        ;;
    *)
        echo "Usage: $0 {install|check|start|stop|remove}"
        exit 1
        ;;
esac

#!/usr/bin/env bash
# Cloudflare Tunnel helper for CCW (Linux / macOS)
# Usage:
#   ./enable-tunnel.sh                        # quick tunnel (random trycloudflare.com domain)
#   ./enable-tunnel.sh named ccw.example.com  # fixed domain
#   ./enable-tunnel.sh --stop                 # stop running cloudflared processes
set -euo pipefail

MODE="${1:-quick}"
HOSTNAME_ARG="${2:-}"
NAME="ccw-console"
PORT="${PORT:-8080}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "--stop" ]]; then
  if pgrep -x cloudflared >/dev/null 2>&1; then
    pkill -x cloudflared && echo "Stopped cloudflared."
  else
    echo "No cloudflared process is running."
  fi
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing via brew..."
    brew install cloudflared
  else
    echo "Downloading official binary..."
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64|amd64) SUFFIX="linux-amd64" ;;
      aarch64|arm64) SUFFIX="linux-arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-$SUFFIX" \
      -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
  fi
fi

cloudflared --version

if [[ "$MODE" == "quick" ]]; then
  echo ""
  echo "Starting quick tunnel -> http://127.0.0.1:$PORT"
  echo "The public https://*.trycloudflare.com address will appear below shortly."
  echo "Press Ctrl+C to stop."
  echo ""
  exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
fi

# ---- named tunnel (fixed domain) ----
if [[ -z "$HOSTNAME_ARG" ]]; then
  echo "ERROR: usage: $0 named <hostname>   e.g. $0 named ccw.example.com"
  exit 1
fi

CERT="$HOME/.cloudflared/cert.pem"
if [[ ! -f "$CERT" ]]; then
  echo "Cloudflare login required."
  cloudflared tunnel login
  [[ -f "$CERT" ]] || { echo "ERROR: cert.pem not found after login."; exit 1; }
fi

if ! cloudflared tunnel list 2>/dev/null | grep -q "$NAME"; then
  echo "Creating tunnel: $NAME"
  cloudflared tunnel create "$NAME"
else
  echo "Tunnel already exists: $NAME"
fi

echo "Routing DNS: $HOSTNAME_ARG -> $NAME"
cloudflared tunnel route dns "$NAME" "$HOSTNAME_ARG"

CRED="$(ls -t "$HOME"/.cloudflared/*.json 2>/dev/null | head -n 1)"
[[ -n "$CRED" ]] || { echo "ERROR: tunnel credentials not found."; exit 1; }

CFG_DIR="$DIR/cloudflared"
mkdir -p "$CFG_DIR"
CFG="$CFG_DIR/config.yml"
cat > "$CFG" <<EOF
tunnel: $NAME
credentials-file: $CRED

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

echo ""
echo "Config written: $CFG"
echo "Public address: https://$HOSTNAME_ARG"
echo "Press Ctrl+C to stop."
echo ""
exec cloudflared --config "$CFG" tunnel --no-autoupdate run "$NAME"

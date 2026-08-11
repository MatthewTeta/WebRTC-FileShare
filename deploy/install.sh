#!/usr/bin/env bash
set -euo pipefail

# Installs the P2P File Drop signaling server as a systemd socket-activated
# service (webrtc-fileshare.socket + webrtc-fileshare.service).
#
# Run with sudo as your normal user, e.g.:
#   sudo ./deploy/install.sh
#
# The port comes from server/.env (PORT=...), defaulting to 8097 if unset.
# Re-run this script any time you change server/.env's PORT — the socket
# unit bakes the port in at install time and needs to be regenerated.

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (try: sudo $0)" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "Run this via sudo as your normal login user (sudo $0), not directly as root." >&2
  exit 1
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
ENV_FILE="$SERVER_DIR/.env"

PORT=8097
if [[ -f "$ENV_FILE" ]]; then
  ENV_PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  [[ -n "$ENV_PORT" ]] && PORT="$ENV_PORT"
fi

NODE_BIN="$(su - "$TARGET_USER" -c 'command -v node' 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find 'node' on PATH for user $TARGET_USER (checked via 'su - $TARGET_USER -c \"command -v node\"')." >&2
  echo "Install Node.js for that user (e.g. via nvm) and re-run, or edit" >&2
  echo "/etc/systemd/system/webrtc-fileshare.service by hand afterwards." >&2
  exit 1
fi

echo "Installing webrtc-fileshare systemd socket + service:"
echo "  repo dir : $REPO_DIR"
echo "  user     : $TARGET_USER:$TARGET_GROUP"
echo "  node     : $NODE_BIN"
echo "  port     : $PORT"
echo

sed \
  -e "s#__PORT__#${PORT}#g" \
  "$REPO_DIR/deploy/webrtc-fileshare.socket.template" \
  > /etc/systemd/system/webrtc-fileshare.socket

sed \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  -e "s#__WORKDIR__#${SERVER_DIR}#g" \
  -e "s#__USER__#${TARGET_USER}#g" \
  -e "s#__GROUP__#${TARGET_GROUP}#g" \
  "$REPO_DIR/deploy/webrtc-fileshare.service.template" \
  > /etc/systemd/system/webrtc-fileshare.service

chmod 644 /etc/systemd/system/webrtc-fileshare.socket /etc/systemd/system/webrtc-fileshare.service

systemctl daemon-reload
systemctl enable --now webrtc-fileshare.socket

echo
echo "Done. systemd listens on port $PORT and starts the server on the"
echo "first connection. Check it with:"
echo "  systemctl status webrtc-fileshare.socket webrtc-fileshare.service"
echo "  journalctl -u webrtc-fileshare.service -f"

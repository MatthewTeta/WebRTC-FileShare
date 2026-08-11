#!/usr/bin/env bash
set -euo pipefail

# Removes the webrtc-fileshare systemd socket + service installed by
# install.sh. Run with sudo:
#   sudo ./deploy/uninstall.sh

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (try: sudo $0)" >&2
  exit 1
fi

systemctl disable --now webrtc-fileshare.socket 2>/dev/null || true
systemctl stop webrtc-fileshare.service 2>/dev/null || true
rm -f /etc/systemd/system/webrtc-fileshare.socket /etc/systemd/system/webrtc-fileshare.service
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

echo "Removed webrtc-fileshare systemd units."

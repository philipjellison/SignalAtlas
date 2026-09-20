#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' 'This removes the service and application files but preserves /var/lib/signalatlas/config.json.'
sudo systemctl disable --now signalatlas.service || true
sudo rm -f /etc/systemd/system/signalatlas.service
sudo rm -rf /opt/signalatlas
sudo systemctl daemon-reload

printf '%s\n' 'Remove /opt/signalatlas/bin/signalatlas-kiosk & from ~/.config/labwc/autostart if present.'

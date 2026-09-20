#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' 'This removes the service and application files but preserves /var/lib/geochron-display/config.json.'
sudo systemctl disable --now geochron-display.service || true
sudo rm -f /etc/systemd/system/geochron-display.service
sudo rm -rf /opt/geochron-display
sudo systemctl daemon-reload

printf '%s\n' 'Remove /opt/geochron-display/bin/geochron-kiosk & from ~/.config/labwc/autostart if present.'

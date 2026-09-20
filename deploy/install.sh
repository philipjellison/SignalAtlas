#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -eq 0 ]]; then
  printf '%s\n' 'Run this installer as the normal desktop user; it will use sudo when needed.' >&2
  exit 1
fi

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="/opt/geochron-display"

cd "$project_root"
cargo build --locked --release

sudo install -d -m 0755 "$install_root/bin" "$install_root/web"
sudo install -m 0755 target/release/geochron-display "$install_root/bin/geochron-display"
sudo cp -a web/. "$install_root/web/"
sudo install -m 0755 deploy/geochron-kiosk "$install_root/bin/geochron-kiosk"
sudo install -m 0644 deploy/geochron-display.service /etc/systemd/system/geochron-display.service
sudo systemctl daemon-reload
sudo systemctl enable --now geochron-display.service

printf '%s\n' "Service installed. Run: $project_root/deploy/install-kiosk.sh"

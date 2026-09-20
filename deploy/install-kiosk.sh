#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -eq 0 ]]; then
  printf '%s\n' 'Run this installer as the desktop user that will own the kiosk session.' >&2
  exit 1
fi

command -v chromium >/dev/null || {
  printf '%s\n' 'Chromium is required. Install it with: sudo apt install chromium curl' >&2
  exit 1
}
command -v curl >/dev/null || {
  printf '%s\n' 'curl is required. Install it with: sudo apt install curl' >&2
  exit 1
}

autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/labwc"
autostart_file="$autostart_dir/autostart"
kiosk_command="/opt/geochron-display/bin/geochron-kiosk &"
mkdir -p "$autostart_dir"
touch "$autostart_file"

if ! grep -Fqx "$kiosk_command" "$autostart_file"; then
  printf '\n%s\n' "$kiosk_command" >> "$autostart_file"
fi

printf '%s\n' 'Kiosk autostart installed. Enable Desktop Autologin in raspi-config, then reboot.'

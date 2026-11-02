#!/usr/bin/env bash
# Configure the optional labwc (Raspberry Pi OS Trixie) fullscreen Chromium kiosk.
set -euo pipefail

# shellcheck source=deploy/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<USAGE
Usage: deploy/install-kiosk.sh [--prefix DIR]

Adds the kiosk launcher to ~/.config/labwc/autostart (once). Run as the desktop
user that will own the kiosk session. Requires deploy/install.sh to have been
run, plus chromium and curl.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || die "--prefix needs a directory"; PREFIX="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
check_prefix

[[ ${EUID} -ne 0 ]] || die "run this as the desktop user that will own the kiosk session"
command -v chromium >/dev/null || die "Chromium is required. Install it with: sudo apt install chromium curl"
command -v curl >/dev/null || die "curl is required. Install it with: sudo apt install chromium curl"
[[ -x "$PREFIX/bin/signalatlas-kiosk" ]] \
  || die "$PREFIX/bin/signalatlas-kiosk not found; run deploy/install.sh first"

autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/labwc"
autostart_file="$autostart_dir/autostart"
kiosk_command="$PREFIX/bin/signalatlas-kiosk &"
mkdir -p "$autostart_dir"
touch "$autostart_file"

if grep -Fqx "$kiosk_command" "$autostart_file"; then
  info "Kiosk autostart entry already present in $autostart_file"
else
  printf '\n%s\n' "$kiosk_command" >> "$autostart_file"
  info "Added kiosk autostart entry to $autostart_file"
fi

if ! systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  info "Warning: $SERVICE_NAME is not installed. The kiosk waits for SignalAtlas at"
  info "http://127.0.0.1:3000/, so install the service (deploy/install-service.sh --enable --start)"
  info "or make sure SignalAtlas is otherwise started at login."
fi
info "Enable Desktop Autologin in raspi-config (System Options > Boot / Auto Login), then reboot."

#!/usr/bin/env bash
# Remove SignalAtlas application files, the systemd unit and the kiosk autostart
# entry. Configuration, presets and the WSPR cache are never deleted.
set -euo pipefail

# shellcheck source=deploy/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<USAGE
Usage: deploy/uninstall.sh [--prefix DIR]

Stops and removes $SERVICE_NAME if installed, removes the kiosk autostart entry
for this user, and removes the installed files under the prefix (default:
$DEFAULT_PREFIX). User data (e.g. /var/lib/signalatlas, ~/.local/share/signalatlas,
the repository's data/ directory) is preserved; delete it yourself if desired.
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

if command -v systemctl >/dev/null && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  priv systemctl disable --now "$SERVICE_NAME" || info "Warning: could not disable/stop $SERVICE_NAME"
  priv rm -f "$UNIT_PATH"
  priv systemctl daemon-reload
  info "Removed $SERVICE_NAME"
fi

autostart_file="${XDG_CONFIG_HOME:-$HOME/.config}/labwc/autostart"
kiosk_command="$PREFIX/bin/signalatlas-kiosk &"
if [[ -f "$autostart_file" ]] && grep -Fqx "$kiosk_command" "$autostart_file"; then
  tmp="$(mktemp)"
  grep -Fvx "$kiosk_command" "$autostart_file" > "$tmp" || true
  cat "$tmp" > "$autostart_file"
  rm -f "$tmp"
  info "Removed kiosk entry from $autostart_file"
fi

# Remove only files this project installed, never the whole prefix tree.
maybe_priv "$PREFIX" rm -f "$PREFIX/bin/signalatlas" "$PREFIX/bin/signalatlas-kiosk"
maybe_priv "$PREFIX" rm -rf "$PREFIX/web" "$PREFIX/web.new" "$PREFIX/web.old"
if [[ -d "$PREFIX/bin" ]]; then maybe_priv "$PREFIX" rmdir --ignore-fail-on-non-empty "$PREFIX/bin"; fi
if [[ -d "$PREFIX" ]]; then maybe_priv "$PREFIX" rmdir --ignore-fail-on-non-empty "$PREFIX"; fi

info "Removed application files under $PREFIX. User data was preserved."

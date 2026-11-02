#!/usr/bin/env bash
# Remove SignalAtlas application files, the systemd unit and the kiosk autostart
# entry. Configuration, presets and the WSPR cache are never deleted.
set -euo pipefail

# shellcheck source=deploy/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<USAGE
Usage: deploy/uninstall.sh [--prefix DIR] [--keep-service]

Removes the installed files under the prefix (default: $DEFAULT_PREFIX) and this
user's kiosk autostart entry for that prefix. $SERVICE_NAME is stopped,
disabled and removed only if its ExecStart is exactly <prefix>/bin/signalatlas;
a service belonging to another prefix is left untouched, and if ownership
cannot be determined the script stops without changing anything.
  --keep-service  never touch the systemd service (files only)

User data (e.g. /var/lib/signalatlas, ~/.local/share/signalatlas,
the repository's data/ directory) is preserved; delete it yourself if desired.
USAGE
}

keep_service=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || die "--prefix needs a directory"; PREFIX="$2"; shift 2 ;;
    --keep-service) keep_service=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
check_prefix

ownership=none
if [[ $keep_service -eq 0 ]]; then
  ownership="$(service_ownership "$UNIT_PATH" "$PREFIX")"
fi
case "$ownership" in
  ambiguous)
    die "cannot tell whether $UNIT_PATH belongs to $PREFIX (symlink, drop-in, or unusual ExecStart). Nothing was changed. Re-run with --keep-service to remove files only." ;;
  other)
    info "$SERVICE_NAME belongs to a different installation; leaving it unchanged." ;;
  match)
    if command -v systemctl >/dev/null; then
      priv systemctl disable --now "$SERVICE_NAME" || info "Warning: could not disable/stop $SERVICE_NAME"
    fi
    priv rm -f "$UNIT_PATH"
    if command -v systemctl >/dev/null; then priv systemctl daemon-reload; fi
    info "Removed $SERVICE_NAME" ;;
esac

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
remove_web "$PREFIX"
if [[ -d "$PREFIX/bin" ]]; then maybe_priv "$PREFIX" rmdir --ignore-fail-on-non-empty "$PREFIX/bin"; fi
if [[ -d "$PREFIX" ]]; then maybe_priv "$PREFIX" rmdir --ignore-fail-on-non-empty "$PREFIX"; fi

info "Removed application files under $PREFIX. User data was preserved."

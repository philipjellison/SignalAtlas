#!/usr/bin/env bash
# Install the optional systemd unit. Installing, enabling at boot, and starting
# are separate steps; by default this only installs the unit file.
set -euo pipefail

# shellcheck source=deploy/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
root="$(project_root)"

usage() {
  cat <<USAGE
Usage: deploy/install-service.sh [--prefix DIR] [--enable] [--start]

Installs $UNIT_PATH for an application already installed by deploy/install.sh.

  --prefix DIR  location the application was installed to (default: $DEFAULT_PREFIX)
  --enable      also enable the service at boot (systemctl enable)
  --start       also start the service now (systemctl start)

Without --enable or --start the unit is only installed. Re-running updates the
unit file and reloads systemd but never changes whether an existing service is
enabled or running; restart it yourself to apply an update.
USAGE
}

enable=0
start=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || die "--prefix needs a directory"; PREFIX="$2"; shift 2 ;;
    --enable) enable=1; shift ;;
    --start) start=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
check_prefix

command -v systemctl >/dev/null || die "systemd (systemctl) is not available on this system"
[[ -x "$PREFIX/bin/signalatlas" && -d "$PREFIX/web" ]] \
  || die "SignalAtlas is not installed under $PREFIX; run deploy/install.sh first"

unit="$(mktemp)"
trap 'rm -f -- "$unit"' EXIT
# The shipped unit assumes $DEFAULT_PREFIX; substitute the chosen prefix.
sed "s|$DEFAULT_PREFIX|$PREFIX|g" "$root/deploy/signalatlas.service" > "$unit"

priv install -m 0644 "$unit" "$UNIT_PATH"
priv systemctl daemon-reload
info "Installed $UNIT_PATH"

if [[ $enable -eq 1 ]]; then
  priv systemctl enable "$SERVICE_NAME"
  info "Enabled: SignalAtlas will start at boot."
fi
if [[ $start -eq 1 ]]; then
  priv systemctl start "$SERVICE_NAME"
  info "Started."
fi

enabled="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
active="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
info "Service state: enabled=${enabled:-unknown} active=${active:-unknown}"
if [[ "$active" == "active" && $start -eq 0 ]]; then
  info "The running service still uses the previous unit settings and executable."
  info "Apply them with:  sudo systemctl restart signalatlas"
fi
if [[ "$enabled" != "enabled" ]]; then
  info "Not enabled at boot. To enable: sudo systemctl enable signalatlas"
fi
if [[ "$active" != "active" ]]; then
  info "Not running. To start: sudo systemctl start signalatlas"
fi

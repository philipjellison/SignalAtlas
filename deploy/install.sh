#!/usr/bin/env bash
# Install the SignalAtlas application files. This does NOT create, enable, or
# start any service and does not configure a kiosk; see install-service.sh and
# install-kiosk.sh for those optional steps.
set -euo pipefail

# shellcheck source=deploy/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
root="$(project_root)"

usage() {
  cat <<USAGE
Usage: deploy/install.sh [--prefix DIR] [--no-build]

Installs bin/signalatlas, bin/signalatlas-kiosk and web/ under the prefix
(default: $DEFAULT_PREFIX, or \$SIGNALATLAS_PREFIX). Existing configuration,
presets and WSPR cache files are never touched. Safe to run repeatedly.

  --prefix DIR  install under DIR instead
  --no-build    use the existing target/release/signalatlas instead of building
USAGE
}

build=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || die "--prefix needs a directory"; PREFIX="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
check_prefix

cd "$root"
if [[ $build -eq 1 ]]; then
  [[ ${EUID} -ne 0 ]] || die "do not build as root; run as a normal user (sudo is used only to copy files) or pass --no-build"
  command -v cargo >/dev/null || die "cargo not found; install Rust first (see README.md)"
  cargo build --locked --release
fi
[[ -x target/release/signalatlas ]] || die "target/release/signalatlas not found; run without --no-build"

maybe_priv "$PREFIX" install -d -m 0755 "$PREFIX" "$PREFIX/bin"
# Install via a temporary name and rename so a running binary is replaced atomically.
maybe_priv "$PREFIX" install -m 0755 target/release/signalatlas "$PREFIX/bin/.signalatlas.new"
maybe_priv "$PREFIX" mv -f "$PREFIX/bin/.signalatlas.new" "$PREFIX/bin/signalatlas"
maybe_priv "$PREFIX" install -m 0755 deploy/signalatlas-kiosk "$PREFIX/bin/.signalatlas-kiosk.new"
maybe_priv "$PREFIX" mv -f "$PREFIX/bin/.signalatlas-kiosk.new" "$PREFIX/bin/signalatlas-kiosk"
# Web assets: versioned release + atomic symlink switch (see publish_web in common.sh).
publish_web "$root/web" "$PREFIX" || die "could not install web assets; the previous assets were left in place"

info "Installed SignalAtlas to $PREFIX (no service started, nothing enabled)."
info "Run it with:  $PREFIX/bin/signalatlas"
info "Optional next steps: deploy/install-service.sh, deploy/install-kiosk.sh"

if command -v systemctl >/dev/null && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info ""
  info "Note: $SERVICE_NAME is running and still uses the previous executable."
  info "Apply the update when convenient with:  sudo systemctl restart signalatlas"
fi

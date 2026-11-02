# shellcheck shell=bash disable=SC2034
# Shared helpers for the SignalAtlas deploy scripts. Source this file; do not run it.

DEFAULT_PREFIX="/opt/signalatlas"
PREFIX="${SIGNALATLAS_PREFIX:-$DEFAULT_PREFIX}"
SERVICE_NAME="signalatlas.service"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

# Run a command with root privileges only when they are actually needed.
priv() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
  else
    command -v sudo >/dev/null || die "sudo is required to run: $*"
    sudo "$@"
  fi
}

# Run a command directly if the target path is writable by this user, otherwise via sudo.
# Usage: maybe_priv <path-that-must-be-writable> <command...>
maybe_priv() {
  local target="$1"
  shift
  local probe="$target"
  while [[ ! -e "$probe" ]]; do probe="$(dirname -- "$probe")"; done
  if [[ -w "$probe" ]]; then
    "$@"
  else
    priv "$@"
  fi
}

# Validate $PREFIX: absolute, normalised, not a dangerous location.
check_prefix() {
  [[ "$PREFIX" == /* ]] || die "prefix must be an absolute path: $PREFIX"
  PREFIX="$(realpath -m -- "$PREFIX")"
  case "$PREFIX" in
    / | /usr | /bin | /etc | /var | /opt | /home | "$HOME") die "refusing unsafe prefix: $PREFIX" ;;
  esac
}

project_root() {
  cd -- "$(dirname -- "${BASH_SOURCE[1]}")/.." && pwd
}

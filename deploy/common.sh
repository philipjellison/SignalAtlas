# shellcheck shell=bash disable=SC2034
# Shared helpers for the SignalAtlas deploy scripts. Source this file; do not run it.

DEFAULT_PREFIX="/opt/signalatlas"
PREFIX="${SIGNALATLAS_PREFIX:-$DEFAULT_PREFIX}"
SERVICE_NAME="signalatlas.service"
# SIGNALATLAS_UNIT_PATH exists so tests can use a fake unit file.
UNIT_PATH="${SIGNALATLAS_UNIT_PATH:-/etc/systemd/system/$SERVICE_NAME}"

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

# Decide whether the systemd unit at $1 belongs to the installation under prefix $2.
# Prints one of:
#   none       no unit is installed
#   match      the unit's only ExecStart is exactly <prefix>/bin/signalatlas
#   other      the unit runs something else (another prefix, or not SignalAtlas)
#   ambiguous  ownership cannot be determined reliably (symlink, unreadable,
#              zero or several ExecStart lines, relative path, or a drop-in
#              directory that sets ExecStart)
# Units written by earlier versions use ExecStart=/opt/signalatlas/bin/signalatlas
# and are therefore recognised as belonging to the default prefix.
service_ownership() {
  local unit="$1" prefix="$2"
  if [[ ! -e "$unit" && ! -L "$unit" ]]; then echo none; return 0; fi
  if [[ -L "$unit" || ! -f "$unit" || ! -r "$unit" ]]; then echo ambiguous; return 0; fi
  local dropin
  for dropin in "$unit".d/*.conf; do
    [[ -e "$dropin" ]] || continue
    if grep -Eq '^[[:space:]]*ExecStart[[:space:]]*=' "$dropin" 2>/dev/null; then
      echo ambiguous; return 0
    fi
  done
  local lines
  mapfile -t lines < <(grep -E '^[[:space:]]*ExecStart[[:space:]]*=' "$unit" || true)
  if [[ ${#lines[@]} -ne 1 ]]; then echo ambiguous; return 0; fi
  local value="${lines[0]#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  while [[ "$value" == [@!:+-]* ]]; do value="${value:1}"; done
  local exe="${value%%[[:space:]]*}"
  if [[ "$exe" != /* ]]; then echo ambiguous; return 0; fi
  exe="$(realpath -m -- "$exe")"
  if [[ "$exe" == "$prefix/bin/signalatlas" ]]; then echo match; else echo other; fi
}

# Publish web assets from directory $1 into prefix $2 as an immutable release
# under <prefix>/web-releases/, activated by atomically repointing the
# <prefix>/web symlink (rename(2) over the old link).
#
# - The active <prefix>/web path stays valid during normal upgrades.
# - A failed or interrupted upgrade leaves the previous assets in place.
# - A legacy <prefix>/web *directory* (older installers) cannot be replaced by a
#   symlink atomically on Linux: it is moved to web-releases/legacy-* and the
#   link is created immediately after, leaving a gap of two system calls.
#   If that is interrupted, rerunning the installer restores the legacy
#   directory first; manual recovery:
#     mv <prefix>/web-releases/legacy-<newest> <prefix>/web
# - Only the newest two r-* releases are kept; legacy-* and unknown entries are
#   never pruned.
# Returns non-zero (after rolling back) on failure.
publish_web() {
  local src="$1" prefix="$2"
  local rel="$prefix/web-releases" web="$prefix/web"
  local run=(maybe_priv "$prefix")

  [[ -f "$src/display.html" ]] || { printf 'error: %s has no display.html\n' "$src" >&2; return 1; }
  "${run[@]}" install -d -m 0755 "$prefix" "$rel" || return 1

  # Finish recovery from an interrupted legacy transition.
  if [[ ! -e "$web" && ! -L "$web" ]]; then
    local newest_legacy
    newest_legacy="$(find "$rel" -maxdepth 1 -type d -name 'legacy-*' 2>/dev/null | sort | tail -n 1)"
    if [[ -n "$newest_legacy" ]]; then
      "${run[@]}" mv "$newest_legacy" "$web" || return 1
      info "Restored previous web assets from $newest_legacy"
    fi
  fi
  # Remove leftovers of earlier interrupted runs (only names this script creates).
  "${run[@]}" find "$rel" -maxdepth 1 -name '.staging-*' -exec rm -rf {} + 2>/dev/null || true
  "${run[@]}" find "$prefix" -maxdepth 1 -name '.web.tmp-*' -exec rm -f {} + 2>/dev/null || true

  if [[ -d "$web" ]] && diff -rq "$src" "$web" >/dev/null 2>&1; then
    info "Web assets are already up to date."
    return 0
  fi

  local id stamp
  stamp="$(date -u +%Y%m%d%H%M%S)"
  id="r-$stamp-$$"
  local staging="$rel/.staging-$id" release="$rel/$id"
  if ! "${run[@]}" cp -a "$src" "$staging" \
    || ! "${run[@]}" chmod -R a+rX "$staging" \
    || ! "${run[@]}" mv "$staging" "$release"; then
    "${run[@]}" rm -rf "$staging" "$release"
    return 1
  fi

  if [[ -d "$web" && ! -L "$web" ]]; then
    local legacy="$rel/legacy-$stamp-$$"
    "${run[@]}" mv "$web" "$legacy" || { "${run[@]}" rm -rf "$release"; return 1; }
    if ! "${run[@]}" ln -s "web-releases/$id" "$web"; then
      "${run[@]}" mv "$legacy" "$web"
      "${run[@]}" rm -rf "$release"
      return 1
    fi
  else
    local tmp="$prefix/.web.tmp-$$"
    "${run[@]}" rm -f "$tmp"
    if ! "${run[@]}" ln -s "web-releases/$id" "$tmp" || ! "${run[@]}" mv -T "$tmp" "$web"; then
      "${run[@]}" rm -f "$tmp"
      "${run[@]}" rm -rf "$release"
      return 1
    fi
  fi

  # Prune: keep the newest two r-* releases.
  local old
  while IFS= read -r old; do
    [[ -n "$old" ]] && "${run[@]}" rm -rf "$old"
  done < <(find "$rel" -maxdepth 1 -type d -name 'r-*' | sort -r | tail -n +3)
  return 0
}

# Remove everything publish_web created, plus a legacy web directory.
remove_web() {
  local prefix="$1"
  [[ -d "$prefix" ]] || return 0
  local run=(maybe_priv "$prefix")
  "${run[@]}" rm -rf "$prefix/web" "$prefix/web.new" "$prefix/web.old"
  if [[ -d "$prefix/web-releases" ]]; then
    "${run[@]}" find "$prefix/web-releases" -maxdepth 1 \( -name 'r-*' -o -name 'legacy-*' -o -name '.staging-*' \) -exec rm -rf {} +
    "${run[@]}" rmdir --ignore-fail-on-non-empty "$prefix/web-releases"
  fi
  "${run[@]}" find "$prefix" -maxdepth 1 -name '.web.tmp-*' -exec rm -f {} +
}

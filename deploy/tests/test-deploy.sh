#!/usr/bin/env bash
# Isolated tests for deploy/common.sh (service ownership, web publishing) and the
# install/uninstall scripts. Everything happens in a temporary directory with
# stub sudo/systemctl and a fake unit file; real systemd and /opt are never touched.
# shellcheck disable=SC2016
set -uo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
check_not() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# --- stubs -----------------------------------------------------------------
stubs="$tmp/stubs"
mkdir -p "$stubs"
cat > "$stubs/sudo" <<'S'
#!/bin/sh
echo "sudo $*" >> "$STUB_LOG"
exec "$@"
S
cat > "$stubs/systemctl" <<'S'
#!/bin/sh
echo "systemctl $*" >> "$STUB_LOG"
exit 0
S
cat > "$stubs/systemctl" <<'S'
#!/bin/sh
echo "systemctl $*" >> "$STUB_LOG"
if [ -n "${FAIL_SYSTEMCTL_DISABLE:-}" ] && [ "$1" = disable ]; then exit 1; fi
exit 0
S
cat > "$stubs/mv" <<'S'
#!/bin/sh
# Simulated failure of the atomic symlink switch (mv -T) when FAIL_MV_T is set.
if [ -n "${FAIL_MV_T:-}" ]; then for a in "$@"; do [ "$a" = "-T" ] && exit 1; done; fi
exec /usr/bin/env -S PATH=/usr/bin:/bin mv "$@"
S
cat > "$stubs/ln" <<'S'
#!/bin/sh
if [ -n "${FAIL_LN:-}" ]; then exit 1; fi
exec /usr/bin/env -S PATH=/usr/bin:/bin ln "$@"
S
chmod +x "$stubs"/*
export STUB_LOG="$tmp/stub.log"
: > "$STUB_LOG"
export PATH="$stubs:$PATH"

# shellcheck source=deploy/common.sh
source "$repo/deploy/common.sh"

unit_for() { # unit_for <file> <exe path>
  sed "s|/opt/signalatlas|$(dirname "$(dirname "$2")")|g" "$repo/deploy/signalatlas.service" > "$1"
}

echo "service_ownership"
u="$tmp/unit"
eq "no unit -> none" "$(service_ownership "$tmp/missing" /opt/signalatlas)" none
cat > "$u" <<'U'
[Service]
ExecStart=/opt/signalatlas/bin/signalatlas
WorkingDirectory=/opt/signalatlas
U
eq "previous-version unit matches default prefix" "$(service_ownership "$u" /opt/signalatlas)" match
eq "previous-version unit does not match other prefix" "$(service_ownership "$u" /home/x/signalatlas)" other
unit_for "$u" /opt/signalatlas/bin/signalatlas
eq "current shipped unit matches default prefix" "$(service_ownership "$u" /opt/signalatlas)" match
unit_for "$u" /home/x/sa/bin/signalatlas
eq "custom-prefix unit matches its prefix" "$(service_ownership "$u" /home/x/sa)" match
eq "custom-prefix unit does not match default" "$(service_ownership "$u" /opt/signalatlas)" other
printf '[Service]\nExecStart=-/opt/signalatlas/bin/signalatlas --x\n' > "$u"
eq "exec modifier and arguments tolerated" "$(service_ownership "$u" /opt/signalatlas)" match
printf '[Service]\nExecStart=/usr/bin/other\n' > "$u"
eq "unrelated ExecStart -> other" "$(service_ownership "$u" /opt/signalatlas)" other
printf '[Service]\nExecStart=/opt/signalatlas/bin/signalatlas\nExecStart=/bin/true\n' > "$u"
eq "two ExecStart lines -> ambiguous" "$(service_ownership "$u" /opt/signalatlas)" ambiguous
printf '[Service]\nDescription=x\n' > "$u"
eq "no ExecStart -> ambiguous" "$(service_ownership "$u" /opt/signalatlas)" ambiguous
printf '[Service]\nExecStart=bin/signalatlas\n' > "$u"
eq "relative ExecStart -> ambiguous" "$(service_ownership "$u" /opt/signalatlas)" ambiguous
unit_for "$u" /opt/signalatlas/bin/signalatlas
ln -sf "$u" "$tmp/unit-link"
eq "symlinked unit -> ambiguous" "$(service_ownership "$tmp/unit-link" /opt/signalatlas)" ambiguous
mkdir -p "$u.d"; printf '[Service]\nExecStart=\nExecStart=/x/y\n' > "$u.d/o.conf"
eq "drop-in overriding ExecStart -> ambiguous" "$(service_ownership "$u" /opt/signalatlas)" ambiguous
rm -rf "$u.d"

# --- fake installed prefix helper -------------------------------------------
make_prefix() { # make_prefix <prefix>
  mkdir -p "$1/bin" "$1/web/assets"
  echo bin > "$1/bin/signalatlas"; echo k > "$1/bin/signalatlas-kiosk"
  echo html > "$1/web/display.html"
}
run_uninstall() { # run_uninstall <prefix> [args]
  local prefix="$1"; shift
  HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/home/.config" SIGNALATLAS_UNIT_PATH="$tmp/fake.service" \
    "$repo/deploy/uninstall.sh" --prefix "$prefix" "$@"
}
mkdir -p "$tmp/home"

echo "uninstall.sh"
# Standalone prefix must not disturb a service that belongs to another prefix.
sys="$tmp/optlike"; sa="$tmp/standalone"
make_prefix "$sys"; make_prefix "$sa"
mkdir -p "$tmp/xdg/signalatlas"; echo '{}' > "$tmp/xdg/signalatlas/config.json"
unit_for "$tmp/fake.service" "$sys/bin/signalatlas"
: > "$STUB_LOG"
check "standalone uninstall succeeds" run_uninstall "$sa"
check "standalone files removed" test ! -e "$sa/bin/signalatlas"
check "unrelated service unit untouched" test -f "$tmp/fake.service"
check_not "no systemctl disable/stop issued" grep -q "systemctl" "$STUB_LOG"
check "other prefix files untouched" test -f "$sys/bin/signalatlas"
check "user data preserved" test -f "$tmp/xdg/signalatlas/config.json"

# Matching prefix: service identified and removed.
: > "$STUB_LOG"
check "matching uninstall succeeds" run_uninstall "$sys"
check "matching unit removed" test ! -e "$tmp/fake.service"
check "systemctl disable --now issued" grep -q "systemctl disable --now signalatlas.service" "$STUB_LOG"
check "daemon-reload issued" grep -q "systemctl daemon-reload" "$STUB_LOG"
check "matching prefix files removed" test ! -e "$sys/web"
check "prefix directory removed when empty" test ! -e "$sys"

# Missing service.
make_prefix "$sa"; rm -f "$tmp/fake.service"; : > "$STUB_LOG"
check "uninstall without a service succeeds" run_uninstall "$sa"
check_not "no service commands without a service" grep -q systemctl "$STUB_LOG"
check "uninstall is repeatable" run_uninstall "$sa"

# Ambiguous ownership fails safe.
make_prefix "$sa"; unit_for "$tmp/fake.service" "$sa/bin/signalatlas"
printf 'ExecStart=/bin/true\n' >> "$tmp/fake.service"; : > "$STUB_LOG"
check_not "ambiguous ownership aborts" run_uninstall "$sa"
check "ambiguous: prefix files untouched" test -f "$sa/bin/signalatlas"
check "ambiguous: unit untouched" test -f "$tmp/fake.service"
check_not "ambiguous: no systemctl calls" grep -q systemctl "$STUB_LOG"
check "--keep-service removes files only" run_uninstall "$sa" --keep-service
check "--keep-service leaves unit" test -f "$tmp/fake.service"
check_not "--keep-service makes no systemctl calls" grep -q systemctl "$STUB_LOG"

# Unknown files in the prefix survive; legacy real web dir is removed.
make_prefix "$sa"; rm -f "$tmp/fake.service"; echo mine > "$sa/bin/mine"
run_uninstall "$sa" >/dev/null 2>&1
check "unrelated file kept" test -f "$sa/bin/mine"
check "legacy web directory removed" test ! -e "$sa/web"

# Kiosk entry for this prefix only.
make_prefix "$sa"; mkdir -p "$tmp/home/.config/labwc"
printf 'other &\n%s/bin/signalatlas-kiosk &\n/opt/other/bin/signalatlas-kiosk &\n' "$sa" > "$tmp/home/.config/labwc/autostart"
run_uninstall "$sa" >/dev/null 2>&1
eq "only matching kiosk line removed" "$(tr '\n' '|' < "$tmp/home/.config/labwc/autostart")" "other &|/opt/other/bin/signalatlas-kiosk &|"

# Stopping the matching service fails: abort with nothing removed.
make_prefix "$sa"; unit_for "$tmp/fake.service" "$sa/bin/signalatlas"; : > "$STUB_LOG"
check_not "failed service stop aborts uninstall" env FAIL_SYSTEMCTL_DISABLE=1 bash -c 'HOME="$1" XDG_CONFIG_HOME="$1/.config" SIGNALATLAS_UNIT_PATH="$2" "$3/deploy/uninstall.sh" --prefix "$4"' _ "$tmp/home" "$tmp/fake.service" "$repo" "$sa"
check "failed stop: unit kept" test -f "$tmp/fake.service"
check "failed stop: binary kept" test -f "$sa/bin/signalatlas"
check "failed stop: web kept" test -f "$sa/web/display.html"
check_not "failed stop: unit not deleted via rm" grep -q "sudo rm" "$STUB_LOG"
check "retry after failure succeeds" run_uninstall "$sa"
check "retry removed unit" test ! -e "$tmp/fake.service"

# Legacy web backups survive uninstall; releases and symlink do not.
sb="$tmp/withbackup"; make_prefix "$sb"; rm -rf "$sb/web"
mkdir -p "$sb/web-releases/legacy-20200101000000-1" "$sb/web-releases/r-20240101000000-2"
echo user > "$sb/web-releases/legacy-20200101000000-1/custom.txt"
echo new > "$sb/web-releases/r-20240101000000-2/display.html"
ln -s web-releases/r-20240101000000-2 "$sb/web"
rm -f "$tmp/fake.service"
check "uninstall with legacy backup succeeds" run_uninstall "$sb"
check "legacy backup preserved" test -f "$sb/web-releases/legacy-20200101000000-1/custom.txt"
check "release removed" test ! -e "$sb/web-releases/r-20240101000000-2"
check "web symlink removed" test ! -e "$sb/web" -a ! -L "$sb/web"
check "binary removed" test ! -e "$sb/bin/signalatlas"

echo "install-service.sh"
run_install_service() { # <prefix> [args]
  local prefix="$1"; shift
  SIGNALATLAS_UNIT_PATH="$tmp/fake.service" "$repo/deploy/install-service.sh" --prefix "$prefix" "$@"
}
sc="$tmp/svc-a"; sd="$tmp/svc-b"; make_prefix "$sc"; make_prefix "$sd"; chmod +x "$sc/bin/signalatlas" "$sd/bin/signalatlas"
rm -f "$tmp/fake.service"; : > "$STUB_LOG"
check "fresh unit install" run_install_service "$sc"
check "unit written for prefix" grep -q "ExecStart=$sc/bin/signalatlas" "$tmp/fake.service"
check_not "install only: no enable/start" grep -Eq "systemctl (enable|start)" "$STUB_LOG"
check "re-install over own unit" run_install_service "$sc"
cp "$tmp/fake.service" "$tmp/fake.before"
check_not "refuses to overwrite another prefix's unit" run_install_service "$sd"
check "other-prefix unit unchanged" cmp -s "$tmp/fake.service" "$tmp/fake.before"
printf 'ExecStart=/bin/true\n' >> "$tmp/fake.service"; cp "$tmp/fake.service" "$tmp/fake.before"
check_not "refuses to overwrite ambiguous unit" run_install_service "$sc"
check "ambiguous unit unchanged" cmp -s "$tmp/fake.service" "$tmp/fake.before"
cat > "$tmp/fake.service" <<U
[Service]
ExecStart=$sc/bin/signalatlas
U
check "upgrades a previous-version style unit" run_install_service "$sc"
check "upgraded unit has new settings" grep -q SIGNALATLAS_WEB "$tmp/fake.service"
rm -f "$tmp/fake.service"

echo "publish_web"
src="$tmp/src"; mkdir -p "$src/assets"; echo v1 > "$src/display.html"; echo a > "$src/assets/a.js"
pub() { ( set -e; publish_web "$1" "$2" ); }
count_releases() { find "$1/web-releases" -maxdepth 1 -type d -name 'r-*' 2>/dev/null | wc -l; }
P1="$tmp/p1"
check "fresh publish" pub "$src" "$P1"
check "web is a symlink to a release" test -L "$P1/web"
eq "content served" "$(cat "$P1/web/display.html")" v1
r1="$(readlink "$P1/web")"
check "repeat with same content succeeds" pub "$src" "$P1"
eq "repeat is a no-op (same release)" "$(readlink "$P1/web")" "$r1"
eq "one release after repeat" "$(count_releases "$P1")" 1
echo v2 > "$src/display.html"; sleep 1
check "upgrade" pub "$src" "$P1"
eq "new content active" "$(cat "$P1/web/display.html")" v2
eq "two releases kept" "$(count_releases "$P1")" 2
echo v3 > "$src/display.html"; sleep 1; pub "$src" "$P1"
eq "pruned to two releases" "$(count_releases "$P1")" 2
eq "third content active" "$(cat "$P1/web/display.html")" v3
echo keep > "$P1/unrelated.txt"; mkdir -p "$P1/web-releases/notes"; echo v4 > "$src/display.html"; sleep 1; pub "$src" "$P1"
check "unrelated file kept" test -f "$P1/unrelated.txt"
check "unknown directory in web-releases kept" test -d "$P1/web-releases/notes"

# Failure while switching the symlink: previous assets stay active, no leftovers.
before="$(readlink "$P1/web")"; n="$(count_releases "$P1")"
echo v5 > "$src/display.html"; sleep 1
check_not "failed switch reports failure" env FAIL_MV_T=1 bash -c 'source "$0"; set -e; publish_web "$1" "$2"' "$repo/deploy/common.sh" "$src" "$P1"
eq "previous release still active" "$(readlink "$P1/web")" "$before"
eq "previous content still served" "$(cat "$P1/web/display.html")" v4
eq "no stray release left" "$(count_releases "$P1")" "$n"
check_not "no temp link left" bash -c 'ls "$0"/.web.tmp-* 2>/dev/null | grep -q .' "$P1"
check "retry after failure succeeds" pub "$src" "$P1"
eq "retry activates new content" "$(cat "$P1/web/display.html")" v5

# Legacy layout: web is a real directory.
P2="$tmp/p2"; mkdir -p "$P2/web"; echo old > "$P2/web/display.html"; echo userfile > "$P2/web/custom.txt"
echo n1 > "$src/display.html"
check "legacy directory upgrade" pub "$src" "$P2"
check "web now a symlink" test -L "$P2/web"
eq "new content served" "$(cat "$P2/web/display.html")" n1
check "legacy directory preserved with user file" bash -c 'cat "$0"/web-releases/legacy-*/custom.txt | grep -q userfile' "$P2"
echo n2 > "$src/display.html"; sleep 1; pub "$src" "$P2"
check "legacy backup survives later upgrades" bash -c 'ls -d "$0"/web-releases/legacy-* >/dev/null' "$P2"

# Legacy transition fails at link creation: directory is restored.
P3="$tmp/p3"; mkdir -p "$P3/web"; echo old > "$P3/web/display.html"
check_not "failed legacy link reports failure" env FAIL_LN=1 bash -c 'source "$0"; set -e; publish_web "$1" "$2"' "$repo/deploy/common.sh" "$src" "$P3"
check "legacy web directory restored" test -d "$P3/web" -a ! -L "$P3/web"
eq "legacy content intact" "$(cat "$P3/web/display.html")" old
eq "no release left after rollback" "$(count_releases "$P3")" 0

# Interrupted legacy transition (web missing, legacy backup present): recovered on rerun.
P4="$tmp/p4"; mkdir -p "$P4/web-releases/legacy-20200101000000-1"; echo old > "$P4/web-releases/legacy-20200101000000-1/display.html"
check "rerun after interruption succeeds" pub "$src" "$P4"
eq "assets valid after recovery" "$(cat "$P4/web/display.html")" n2

# Stale staging directory from a killed run is cleaned.
mkdir -p "$P4/web-releases/.staging-r-x"; echo n3 > "$src/display.html"; sleep 1; pub "$src" "$P4"
check "stale staging removed" test ! -e "$P4/web-releases/.staging-r-x"

echo "install.sh (fake repository, fake binary)"
fake="$tmp/fakerepo"; mkdir -p "$fake/target/release"
cp -a "$repo/deploy" "$repo/web" "$fake/"
printf '#!/bin/sh\nexit 0\n' > "$fake/target/release/signalatlas"; chmod +x "$fake/target/release/signalatlas"
IP="$tmp/installed"; : > "$STUB_LOG"
check "install" "$fake/deploy/install.sh" --no-build --prefix "$IP"
check "binary installed" test -x "$IP/bin/signalatlas"
check "assets served via symlink" test -f "$IP/web/display.html"
check_not "install makes no service changes" grep -Eq "systemctl (enable|disable|start|stop|restart|daemon-reload)" "$STUB_LOG"
check "reinstall" "$fake/deploy/install.sh" --no-build --prefix "$IP"
eq "reinstall created no extra release" "$(count_releases "$IP")" 1
echo changed >> "$fake/web/display.html"; sleep 1
check "upgrade install" "$fake/deploy/install.sh" --no-build --prefix "$IP"
check "upgrade content active" grep -q changed "$IP/web/display.html"
IL="$tmp/installed-legacy"; mkdir -p "$IL/web" "$IL/bin"; echo old > "$IL/web/display.html"
check "install over legacy layout" "$fake/deploy/install.sh" --no-build --prefix "$IL"
check "legacy layout upgraded" test -L "$IL/web"

echo
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]

# SignalAtlas

SignalAtlas is a world-map display for amateur radio stations and anyone who likes a live view of the Earth. A small Rust server provides the data and configuration; one or more web browsers show the map. It is designed to run on a Linux computer or Raspberry Pi, either started by hand or left running as a background service or dedicated full-screen kiosk.

Typical uses: a shack wall display, a club-station status screen, or a desktop window showing where your WSPR signals are being heard.

## Features

- **World map rendering** with a WebGL2 renderer and four map styles: political relief, Natural Earth, NASA Blue Marble, and Blue Marble with night lights. The map can be centered on Greenwich, your station, or the Sun.
- **Day/night terminator** calculated from the current UTC time, with hard-edge or civil-twilight shading and adjustable night intensity.
- **Timezone and geographic overlays**: idealized 15° or political timezone boundaries with labels, and country boundaries.
- **Station location**: set your Maidenhead locator (six characters) to place a marker; optionally show the station name and locator.
- **Live WSPR reception display**: pins for stations that heard your callsign ("My Station") or a global view, from the wspr.live database, filtered by band and fading after a configurable persistence time.
- **Historical WSPR playback** of the last 6, 12, 24, or 48 hours, with the terminator moving in step with the replayed time. Historical playback is available for "My Station" only; the global source is live only.
- **Presentation presets**: save the current look (map, overlays, WSPR options) under a name and apply it later. Presets do not change your callsign or locator.
- **Multiple synchronized displays**: every open browser display follows the configuration page in real time.
- **Offline map operation**: all map images and boundary data are served by SignalAtlas itself, so the map, terminator, and overlays work without Internet access. WSPR data needs Internet access to wspr.live; without it the last cached pins stay on screen, marked as cached.

Not implemented: authentication, HTTPS, and Windows or macOS support.

## Requirements

| Item | Details |
| --- | --- |
| Operating system | Linux. |
| CPU architecture | x86_64 and 64-bit ARM (aarch64). |
| Rust | A current stable toolchain (the project uses Rust edition 2024, so Rust 1.85 or newer) installed with [rustup](https://rustup.rs). |
| Build tools | A C compiler and `git`. No OpenSSL is needed. |
| Browser | Any modern browser with **WebGL2** enabled (current Chromium, Chrome, or Firefox). |
| Network | Port 3000 (configurable) on the machine running SignalAtlas. Outbound HTTPS to `db1.wspr.live` for WSPR data only. |

**Tested:**

- x86_64 Fedora Linux: building, running from the repository and from an installed directory, serving the web interface, configuration persistence, and clean shutdown.
- Raspberry Pi 4 Model B (2 GB) with 64-bit Raspberry Pi OS Trixie: the display's rendering performance ([report](docs/performance-report-rpi4.md)).

**Expected to work, not verified:** other Linux distributions, other Raspberry Pi models, and other aarch64 boards. The systemd service and kiosk installers were checked for syntax and in a temporary directory, but have not been exercised end to end on a systemd host or on a Pi with this version of the scripts.

## Quick start — Manual execution

This is the primary way to run SignalAtlas. It needs no service, no root access after installing the build tools, and starts nothing automatically.

1. **Install build dependencies.**

   ```sh
   # Debian, Ubuntu, Raspberry Pi OS
   sudo apt update && sudo apt install -y build-essential curl git

   # Fedora
   sudo dnf install -y gcc curl git
   ```

2. **Install Rust.**

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   . "$HOME/.cargo/env"
   ```

3. **Clone the repository.**

   ```sh
   git clone https://github.com/philipjellison/SignalAtlas.git
   cd SignalAtlas
   ```

4. **Build.**

   ```sh
   cargo build --locked --release
   ```

5. **Start SignalAtlas.** It can be started from any directory.

   ```sh
   ./target/release/signalatlas
   ```

6. **Open the interface** in a browser: the display is at <http://localhost:3000/> and the configuration page at <http://localhost:3000/config>. From another computer use `http://HOSTNAME:3000/`.

7. **Stop** with `Ctrl+C` in the terminal (or `kill` the process; both shut down cleanly).

### Where files are found and stored

SignalAtlas finds its web files (read-only) and its data files (writable) independently of the directory you start it from.

**Web files** — the first directory containing `display.html` from:

1. `SIGNALATLAS_WEB`, if set (an error if it is wrong);
2. `web/` next to the executable's `bin/` directory (installed layout);
3. `web/` in the source repository (running from `target/release/`);
4. `web/` in the current directory (older behavior).

**Data files** — `config.json` (settings), `presets.json`, and `wspr-cache.json` live in one directory chosen from:

1. `SIGNALATLAS_DATA_DIR`, if set;
2. the directory of `SIGNALATLAS_CONFIG`, if set;
3. `data/` in the repository, when running `target/release/signalatlas` from a checkout;
4. an existing `data/` directory in the current directory that already holds SignalAtlas files (older behavior);
5. `$XDG_DATA_HOME/signalatlas`, or `~/.local/share/signalatlas` by default.

The chosen locations are logged at startup. The directory is created if it does not exist, and nothing is moved or deleted automatically. The files can also be set individually with `SIGNALATLAS_CONFIG`, `SIGNALATLAS_PRESETS` (default: beside the configuration file), and `SIGNALATLAS_WSPR_CACHE`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNALATLAS_BIND` | `0.0.0.0:3000` | Address and port to listen on. Use `127.0.0.1:3000` to accept local connections only. |
| `SIGNALATLAS_WEB` | auto | Web asset directory. |
| `SIGNALATLAS_DATA_DIR` | auto | Directory for all data files. |
| `SIGNALATLAS_CONFIG` | `<data dir>/config.json` | Configuration file. |
| `SIGNALATLAS_PRESETS` | beside the configuration file | Presets file. |
| `SIGNALATLAS_WSPR_CACHE` | `<data dir>/wspr-cache.json` | WSPR cache file. |
| `SIGNALATLAS_WSPR_ENDPOINT` | `https://db1.wspr.live/` | WSPR provider endpoint. |
| `RUST_LOG` | `signalatlas=info,tower_http=info` | Log verbosity. |

Example: `SIGNALATLAS_BIND=127.0.0.1:8080 ./target/release/signalatlas`

There is no authentication. Keep the port on a trusted LAN and do not expose it to the Internet.

## Optional standalone installation

To run SignalAtlas without keeping the source tree, install the compiled application. This copies files only: it does not start anything and does not create a service.

```sh
./deploy/install.sh                      # builds, then installs to /opt/signalatlas (uses sudo only for the copy)
./deploy/install.sh --prefix ~/signalatlas   # no sudo needed
```

Run it with `/opt/signalatlas/bin/signalatlas` (or `~/signalatlas/bin/signalatlas`). Settings are then stored in `~/.local/share/signalatlas/` unless you set the variables above. Re-running the installer upgrades the application and leaves your data alone. `--no-build` installs an already built `target/release/signalatlas`.

## Optional systemd service

Run SignalAtlas in the background, restarted automatically if it fails. The service must first be installed with `./deploy/install.sh` (default prefix). Installing, enabling at boot, and starting are separate:

```sh
./deploy/install-service.sh              # install the unit only
./deploy/install-service.sh --enable --start   # install, enable at boot, and start now
```

Manage it with:

```sh
sudo systemctl start signalatlas       # start now
sudo systemctl stop signalatlas        # stop
sudo systemctl restart signalatlas     # restart
sudo systemctl enable signalatlas      # start at boot
sudo systemctl disable signalatlas     # do not start at boot
systemctl status signalatlas           # state
journalctl -u signalatlas -f           # live log
```

The service stores its data in `/var/lib/signalatlas/` and listens on port 3000. See [docs/appliance.md](docs/appliance.md) for details.

## Optional Raspberry Pi kiosk

A kiosk shows the display full-screen in Chromium on the Pi's own monitor. It requires **64-bit Raspberry Pi OS Trixie with Desktop** (labwc) and the systemd service above.

```sh
sudo apt install -y chromium curl
./deploy/install.sh
./deploy/install-service.sh --enable --start
./deploy/install-kiosk.sh
sudo raspi-config     # System Options → Boot / Auto Login → Desktop Autologin
sudo reboot
```

Run `install-kiosk.sh` as the desktop user. After the reboot the desktop starts, the launcher waits for SignalAtlas to answer, then opens Chromium full-screen. Running the script again does not add duplicate entries.

## Initial configuration

Open `http://HOSTNAME:3000/config` from any device.

- **Station:** enter your receiver callsign and six-character Maidenhead locator (for example `FN31PR`), and choose whether to show the station name and locator.
- **Appearance:** map style, map center, terminator, night intensity, and timezone and boundary overlays.
- **WSPR:** enable WSPR; choose *My Station* (receptions of your callsign) or *Global*; pick a band; set pin persistence; choose *Live* or *Historical playback* (6/12/24/48 hours, duration, loop). Live WSPR refreshes every two minutes.
- **Presets:** save the current presentation under a name and apply it later.
- **Synchronized displays:** open `http://HOSTNAME:3000/` in as many browsers as you like. Saving on the configuration page updates all of them at once.

## Updating

Your data (`config.json`, `presets.json`, `wspr-cache.json`) is never modified or deleted by an update.

```sh
cd SignalAtlas
git pull
```

- **Manual run from the repository:** `cargo build --locked --release`, then start it again.
- **Standalone installation:** `./deploy/install.sh` (add `--prefix` if you used one), then start it again.
- **systemd service:** `./deploy/install.sh && ./deploy/install-service.sh && sudo systemctl restart signalatlas`. Updating does not change whether the service is enabled or running; the restart applies the new version.
- **Kiosk:** update as for the service; the kiosk entry does not need to be reinstalled. Reboot, or press F5 in the kiosk, to load the new web files.

To remove SignalAtlas: `./deploy/uninstall.sh` (removes the service unit, kiosk entry, and installed files; keeps your data).

## Troubleshooting

**The application will not start.** Run it in a terminal and read the message; startup logs the resolved paths. Under systemd: `journalctl -u signalatlas -n 50 --no-pager`.

**"Address already in use".** Another program, or another SignalAtlas, is using the port. Find it with `ss -ltnp | grep :3000`, stop it, or choose another port with `SIGNALATLAS_BIND=0.0.0.0:3001`.

**"could not find the web assets".** The `web/` directory was not found. Run from a checkout after `cargo build`, use an installed copy, or set `SIGNALATLAS_WEB=/path/to/web` (the directory must contain `display.html`).

**Configuration permission errors** ("load configuration …: Permission denied"). The data directory must be writable by the user running SignalAtlas. Check the logged path, then `ls -ld` on it. For the service the directory is `/var/lib/signalatlas`, managed by systemd.

**Blank display or WebGL errors.** Open `chrome://gpu` (Chromium) or `about:support` (Firefox) and confirm WebGL2 is available; enable hardware acceleration and update the browser and graphics drivers. In a virtual machine, enable 3D acceleration. See [docs/webgl-renderer.md](docs/webgl-renderer.md).

**The service will not start.** `systemctl status signalatlas` and `journalctl -u signalatlas -n 50 --no-pager`. Confirm `/opt/signalatlas/bin/signalatlas` exists and that nothing else uses port 3000. Test the endpoint with `curl --fail http://127.0.0.1:3000/api/health`.

**The kiosk does not appear.** Check that Desktop Autologin is enabled, that `~/.config/labwc/autostart` contains `/opt/signalatlas/bin/signalatlas-kiosk &`, that `chromium` and `curl` are installed, and that `curl --fail http://127.0.0.1:3000/api/health` succeeds. The launcher waits indefinitely for that check.

**No WSPR pins / "cached".** SignalAtlas needs outbound HTTPS to `db1.wspr.live`. Test with `curl -sI https://db1.wspr.live/`. In *My Station* mode the receiver callsign must be set. When the provider is unreachable, the last good data stays on screen as cached; the rest of the display is unaffected.

## Advanced documentation

- [docs/appliance.md](docs/appliance.md) — service administration, kiosk details, recovery.
- [docs/webgl-renderer.md](docs/webgl-renderer.md) — the WebGL2 renderer.
- [docs/performance-report-rpi4.md](docs/performance-report-rpi4.md) — Raspberry Pi 4 measurements.

Browser-side tests: `node --test web/assets/*.test.mjs`. Rust checks: `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`.

## License

MIT. See [LICENSE](LICENSE).

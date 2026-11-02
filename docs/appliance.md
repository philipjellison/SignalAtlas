# Appliance deployment

This document covers the optional background service and kiosk. For the basic install and manual run, see the [README](../README.md).

## Layout

| Component | Script | Effect |
| --- | --- | --- |
| Application files | `deploy/install.sh` | Copies `bin/signalatlas`, `bin/signalatlas-kiosk`, and `web/` to the prefix (default `/opt/signalatlas`). Starts and enables nothing. |
| systemd service | `deploy/install-service.sh` | Installs `/etc/systemd/system/signalatlas.service`. Optional `--enable` (start at boot) and `--start` (start now). |
| Kiosk | `deploy/install-kiosk.sh` | Adds one line to `~/.config/labwc/autostart`. |
| Removal | `deploy/uninstall.sh` | Removes the above; keeps user data. |

All scripts accept `--prefix DIR` (or `SIGNALATLAS_PREFIX`) and `--help`. They use `sudo` only for operations that need it (writing to `/opt`, `/etc/systemd`, `systemctl`) and stop on the first error. Pass the same `--prefix` to every script; a non-default prefix is substituted into the installed unit.

## Raspberry Pi OS Trixie kiosk

Use a clean 64-bit Raspberry Pi OS Trixie **with Desktop** installation. In Raspberry Pi Imager, configure the user, Wi-Fi, hostname, and SSH. The application does not need Internet access after installation (only WSPR does).

```sh
sudo apt update
sudo apt install -y build-essential curl git chromium
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
git clone https://github.com/philipjellison/SignalAtlas.git && cd SignalAtlas
./deploy/install.sh
./deploy/install-service.sh --enable --start
./deploy/install-kiosk.sh
sudo raspi-config      # System Options → Boot / Auto Login → Desktop Autologin
sudo reboot
```

On boot labwc runs `/opt/signalatlas/bin/signalatlas-kiosk`. It polls `/api/health` until the service answers, then runs Chromium in `--kiosk` mode and restarts it two seconds after it exits. Set `SIGNALATLAS_DISPLAY_URL` in the launcher's environment to point it at a different URL. Other desktops should autostart the same launcher using their own session settings.

The kiosk does not require the service specifically, only that SignalAtlas answers at the display URL, but the service is the supported way to guarantee that at boot. `install-kiosk.sh` warns if no service is installed.

The service listens on port 3000; open `http://HOSTNAME:3000/config` from another device to configure it. No authentication is enabled, so do not expose the port to the Internet.

## Service administration

```sh
./deploy/install-service.sh                  # install/update the unit; enablement and running state unchanged
./deploy/install-service.sh --enable --start # install, enable at boot, start
sudo systemctl start|stop|restart signalatlas
sudo systemctl enable|disable signalatlas
systemctl status signalatlas
journalctl -u signalatlas -f
curl --fail http://127.0.0.1:3000/api/health
```

The unit (`deploy/signalatlas.service`) runs as a systemd `DynamicUser` with `StateDirectory=signalatlas`, restarts on failure after 2 seconds, and is sandboxed (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, and others). It sets:

```
SIGNALATLAS_BIND=0.0.0.0:3000
SIGNALATLAS_WEB=<prefix>/web
SIGNALATLAS_DATA_DIR=/var/lib/signalatlas
SIGNALATLAS_CONFIG=/var/lib/signalatlas/config.json
SIGNALATLAS_WSPR_CACHE=/var/lib/signalatlas/wspr-cache.json
```

To change the port or other settings, use `sudo systemctl edit signalatlas` (a drop-in survives upgrades), then restart.

## Persistent data

`/var/lib/signalatlas/` holds `config.json`, `presets.json`, and `wspr-cache.json`. Files are written atomically. Installing, upgrading, and uninstalling never modify or delete them. Back them up by copying that directory; to start fresh, stop the service and delete them yourself. (Under `DynamicUser` systemd stores the directory at `/var/lib/private/signalatlas` and links `/var/lib/signalatlas` to it.)

Without the service, the data directory defaults as described in the README (`~/.local/share/signalatlas`, or `data/` in a source checkout).

## Upgrading existing installations

Installations made with the earlier all-in-one `install.sh` (service enabled, kiosk entry present) keep working unchanged:

- `./deploy/install.sh` replaces the executable, launcher, and web files in `/opt/signalatlas` and does not touch the unit, so a running service keeps running its previous executable until restarted. It prints a reminder when the service is active.
- `./deploy/install-service.sh` refreshes the unit file (it adds `SIGNALATLAS_WEB` and `SIGNALATLAS_DATA_DIR`, which match the old defaults) and reloads systemd. It does not enable, disable, start, or stop anything. Run `sudo systemctl restart signalatlas` to apply it.
- The kiosk autostart line is identical to the old one, so `install-kiosk.sh` does not need to be re-run.

Previously installed units that lack the new variables still work: the executable finds `/opt/signalatlas/web` from its own location.

## Recovery

- Service not running: `systemctl status signalatlas` and `journalctl -u signalatlas -n 100 --no-pager`.
- Bad configuration file: stop the service, move `/var/lib/signalatlas/config.json` aside, start the service; defaults are recreated.
- Kiosk shows a blank page or Chromium error: check the health endpoint above, then `sudo systemctl restart signalatlas`; the launcher restarts Chromium itself.
- A running display keeps its loaded map and astronomy layers if Wi-Fi or Internet is lost. If it loses the local service it reports `reconnecting…`, then `offline · cached display`, and reconnects automatically.
- Live WSPR refreshes every two minutes. Historical windows are fetched once per receiver/window and replayed locally. The last successful response is cached; provider failures keep those pins and mark them as cached.

## Removal

```sh
./deploy/uninstall.sh
```

This stops and removes the service (if installed), removes this user's kiosk autostart line, and deletes the installed files under the prefix. Data in `/var/lib/signalatlas` is preserved.

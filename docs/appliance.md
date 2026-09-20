# Appliance installation

## Raspberry Pi OS Trixie

Use a clean 64-bit Raspberry Pi OS Trixie **with Desktop** installation. In Raspberry Pi Imager, configure the normal user, Wi-Fi, hostname, and SSH before writing the card. The application itself does not require Internet access after installation.

Install the Rust toolchain, compiler prerequisites, Chromium, and curl:

```sh
sudo apt update
sudo apt install -y build-essential curl chromium
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

From the project directory:

```sh
./deploy/install.sh
./deploy/install-kiosk.sh
sudo raspi-config
```

In `raspi-config`, select **System Options → Boot / Auto Login → Desktop Autologin**. Reboot. labwc starts the kiosk wrapper, the wrapper waits for the local service health endpoint, and Chromium opens the display full-screen.

The service listens on port 3000. From another LAN device, open `http://HOSTNAME:3000/config` to configure it. No authentication is enabled, so do not expose this port directly to the Internet.

## x86_64 Linux

Run `./deploy/install.sh` on a systemd-based x86_64 Linux computer. The service and LAN configuration interface work without a desktop. `install-kiosk.sh` targets labwc; other desktops should autostart `/opt/geochron-display/bin/geochron-kiosk` using their normal session settings.

## Operation and recovery

- Application configuration persists at `/var/lib/geochron-display/config.json` using atomic replacement.
- The system service restarts after a process failure.
- The kiosk waits for the service during boot and restarts Chromium if it exits.
- A running display keeps its locally loaded map and astronomy layers if Wi-Fi or Internet access is lost.
- Live WSPR refreshes every two minutes while enabled. Historical 6/12/24/48-hour windows are fetched once per receiver/window selection and replayed locally. The last successful response is cached at `/var/lib/geochron-display/wspr-cache.json`; provider failures retain those pins and mark them as cached.
- If the local service disconnects, the display reports `reconnecting…` and then `offline · cached display`; it reconnects automatically.

Useful commands:

```sh
systemctl status geochron-display
journalctl -u geochron-display -f
sudo systemctl restart geochron-display
curl --fail http://127.0.0.1:3000/api/health
```

To reinstall after an update, run `./deploy/install.sh` again. The persisted configuration is retained. `./deploy/uninstall.sh` removes the executable, web assets, and systemd unit but deliberately preserves the configuration.

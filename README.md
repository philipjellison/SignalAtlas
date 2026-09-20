# SignalAtlas

A Raspberry Pi and x86_64 Linux world-map appliance with synchronized browser displays. The project uses a Rust service and framework-free browser clients.

## Development

Requirements: a current stable Rust toolchain.

```sh
cargo run
```

Open `http://localhost:3000/` for the display and `http://localhost:3000/config` for configuration. To test synchronization, open the display in two browser windows, change a setting in the configuration page, and save it. Both displays update without reloading.

The production display uses the WebGL2 renderer at the root URL. The previous Canvas renderer remains temporarily available at `http://localhost:3000/canvas-display` as a stabilization reference. See [docs/webgl-renderer.md](docs/webgl-renderer.md).

For Raspberry Pi OS Trixie appliance installation and x86_64 systemd deployment, see [docs/appliance.md](docs/appliance.md).

Configuration is written atomically to `data/config.json`. Override defaults with:

```sh
SIGNALATLAS_BIND=127.0.0.1:8080 SIGNALATLAS_CONFIG=/path/to/config.json cargo run
```

## Current scope

Stages 0 through 7 provide synchronized persistent configuration, an offline resolution-independent map renderer, deterministic UTC astronomy, timezone boundaries, a shack marker, live WSPR reception pins, synchronized historical playback, and global presentation presets. WSPR acquisition is isolated behind a replaceable Rust source interface, time-buckets repeated geographic cells, caches the last successful response, and degrades without affecting the base display. Historical 6/12/24/48-hour windows drive the WSPR layer and astronomical terminator from the same synthetic UTC timestamp.

Run browser-side coordinate tests with:

```sh
node --test web/assets/*.test.mjs
```

## License

MIT

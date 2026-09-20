# Raspberry Pi 4 Performance Evaluation

**Project:** Geochron / HamSCI Display  
**Test date:** August 25, 2026  
**Purpose:** Evaluate 4K browser rendering, historical WSPR playback, startup behavior, memory pressure, GPU use, and thermal stability on the intended class of appliance hardware.

## Test hardware and software

- Raspberry Pi 4 Model B Rev 1.4
- 2 GB RAM
- 32 GB microSD card of unspecified speed class
- 64-bit Debian GNU/Linux 13 (Trixie)
- Linux kernel 6.18.34+rpt-rpi-v8
- Chromium 151.0.7922.173
- Labwc Wayland compositor
- LG UltraGear monitor
- Active display mode: 3840×2160 at 30 Hz
- Hardware acceleration: confirmed active through Chromium's GPU process, ANGLE/GLES, `/dev/dri/card1`, `/dev/dri/renderD128`, and the Pi `vc4`/`v3d` drivers
- NTP synchronized
- Pi was not thermally throttled during any recorded sample

## Application configuration during the demanding tests

- NASA Blue Marble with Black Marble night lights
- Stretched-to-screen mode at 4K
- Civil-twilight terminator
- Political timezone boundaries
- WSPR enabled
- Historical WSPR playback used for redraw testing

This combination is close to the application's highest-cost presentation because it includes multiple raster layers, four visible canvases, detailed timezone geometry, WSPR points, and repeated terminator updates.

## Initial behavior

The initial implementation used multiple canvas buffers approaching the physical 4K display size. The terminator used a 2048×1024 source mask but calculated approximately two million pixels on Chromium's main UI thread.

Observed behavior before optimization:

- Chromium startup to completed map: approximately 12–14 seconds.
- During historical playback, each terminator redraw stopped the UTC clock for approximately 2 seconds.
- After an arithmetic optimization, the playback pause fell to approximately 1.5 seconds but remained visible.
- Changing between a window and fullscreen could cause a delay exceeding 10 seconds while all canvases resized and redrew.
- The terminator and WSPR points sometimes appeared approximately 0.5 seconds apart.

The server was generally idle during these pauses. The delays were therefore attributed primarily to Pi-side JavaScript, canvas rendering, image decoding, geometry processing, and GPU-buffer allocation rather than Rust server work.

## Confirmed Chromium crash

The Pi kernel log confirmed that one reported Chromium crash was an out-of-memory event, not an application exception:

- The kernel OOM killer terminated multiple Chromium processes.
- The call path included DRM shared-memory allocation and `v3d_bo_create_finish` while the Pi GPU was creating buffers.
- Near the event, shared memory had reached approximately 540 MB.
- The 2 GB Pi was also carrying retained swap usage from compilation, Chromium, the desktop environment, decoded images, GeoJSON objects, and canvas/GPU buffers.

This finding indicates that the original full-size 4K buffer strategy was unsafe on the 2 GB model.

## Optimizations applied

### Terminator calculation

1. Latitude sine/cosine values were precomputed.
2. Longitude terms were computed once per column rather than repeatedly per pixel.
3. Inverse-sine calculations were limited to the narrow civil-twilight band.
4. The terminator pixel buffer was reused rather than recreated for every frame.
5. Terminator calculation was moved into a Web Worker.
6. Only the newest pending astronomy request is retained, preventing redraw backlogs.

The Web Worker was the change that eliminated the visible UTC-clock stalls during historical playback. Astronomy now completes asynchronously, which can produce a small separation between the WSPR and terminator updates, but the UI remains responsive.

### Canvas and texture memory

1. Internal display canvases were capped at 2560×1440.
2. Chromium's hardware compositor scales those canvases to the 3840×2160 output.
3. All geographic overlays use the same internal dimensions, preserving alignment.
4. Unused map backgrounds are now loaded lazily instead of decoding Natural Earth, Blue Marble, and Black Marble simultaneously.

This substantially reduces canvas and GPU-buffer memory while preserving the screen layout and geographic calculations. There may be a small loss of fine pixel detail compared with native 4K canvas buffers, but none was identified as a functional issue during testing.

### Progressive rendering experiment

Country and timezone boundaries were temporarily changed to load in visible batches. The user reported that this looked worse than the original all-at-once presentation, and it did not materially reduce the approximately 12-second perceived startup time. That experiment was reverted. Country and timezone layers again appear as a completed presentation.

## Controlled local-server profiling

This run used the Pi-local server at `http://127.0.0.1:3000/` and Chromium's loopback-only DevTools interface. It occurred after the worker and lower-memory canvas changes.

### Canvas dimensions

All four display canvases reported 2560×1440:

- World map
- Terminator/night lights
- WSPR overlay
- Geography/timezone overlay

### Browser main-thread tasks

- Longest measured startup task: 354 ms
- Historical-period redraw tasks: approximately 80–154 ms
- No multi-second main-thread task appeared in the controlled 20-second trace
- UTC clock remained visually smooth during historical playback

### Resource measurements

| Resource | Size | Measured duration |
|---|---:|---:|
| Countries GeoJSON | 3.08 MB | 730 ms |
| Political timezones GeoJSON | 3.53 MB | 419 ms |
| Historical WSPR response | 5.87 MB | 2.53 s |

The map rasters were browser-cached during this trace, so their recorded transfer durations were not useful for cold-start analysis.

### Memory and system condition

- Approximately 700 MB memory available after the controlled reload
- JavaScript heap: approximately 36.7 MB used / 39.8 MB allocated
- Temperature: 42.3°C
- Thermal throttling: none (`throttled=0x0`)
- No new OOM, DRM, or V3D fault occurred

## Later laptop-server steady-state test

A later run displayed the application from a laptop server at `http://192.168.1.233:3000/`. The Pi was acting only as the 4K Chromium display client. Server CPU measurements from the Pi are not applicable to this run, but Pi-side rendering measurements remain valid.

Over a 20-second steady-state interval:

- Aggregate Chromium CPU: 9% of one CPU core
- Equivalent total four-core capacity: 2.25%
- Available memory: approximately 621 MB
- Shared memory: approximately 393 MB
- Temperature: 39.9°C
- Thermal throttling: none
- Active swap input/output during sampling: zero
- New OOM events: none
- New GPU/DRM faults: none

Chromium showed approximately 547 MB of allocated swap at that time. This was retained from earlier memory pressure; `vmstat` showed that Chromium was not actively reading or writing swap during the steady-state sample.

## Current user-visible result

- Historical playback clock is smooth.
- Terminator and WSPR layers update without freezing the page.
- The two dynamic layers can appear about 0.5 seconds apart because the terminator is calculated asynchronously.
- Initial startup still takes approximately 12 seconds and the completed presentation appears largely at once.
- The user considers the one-time startup delay less important than reliable steady-state operation.
- No crash has been recorded since reducing canvas memory.

## Interpretation

The application is not CPU-bound during steady-state 4K operation. The most important discovered constraint was GPU/shared-memory pressure on the 2 GB Pi when using near-native 4K canvas buffers. Reducing internal canvas resolution and lazy-loading textures addressed that risk.

The microSD card may affect OS boot, Chromium startup, cold asset reads, builds, and swapping under memory pressure. It does not explain the historical redraw stalls, because those occurred with assets already resident in memory and were resolved by moving astronomy computation off the UI thread.

The remaining 12-second startup time has not been attributed to one continuous JavaScript task. Controlled tracing found multiple sub-second tasks and a 2.5-second historical WSPR response, but no single 10–12-second blocker. Because startup happens once on an unattended kiosk and steady-state behavior is now smooth, further startup optimization is currently considered optional.

## Limitations of these results

- Samples were relatively short; no multi-hour soak result is available yet.
- The Pi has only 2 GB RAM, while another target Pi 4 might have more memory.
- The monitor refresh rate was 30 Hz at 4K, so visual smoothness cannot be compared directly with 4K/60 Hz hardware.
- Some early tests used a Rust debug build; later browser rendering results are still valid, but debug-server CPU should not be treated as final server performance.
- One later test used the laptop as the server; it is explicitly separated above.
- Chromium process RSS values include overlapping shared mappings and should not be summed as unique physical memory.
- No formal frame-rate counter or frame-time distribution was collected.
- The Black Marble and Blue Marble visual quality at 2560×1440 internal resolution was judged informally rather than through image-difference analysis.

## Recommended follow-up tests

1. Run historical playback for several hours while sampling available memory, swap activity, temperature, throttling, and OOM logs.
2. Run a 12–24-hour static/live WSPR kiosk soak test.
3. Use the optimized release server locally on the Pi for the deployment candidate.
4. Verify service restart, Chromium restart, network loss, and WSPR-provider failure recovery.
5. Confirm that 2560×1440 internal rendering is visually acceptable at normal viewing distance.
6. Consider limiting or compressing historical WSPR payloads if startup data grows substantially beyond the measured 5.9 MB.
7. If native-resolution 4K canvases are desired later, use a Pi with more RAM and repeat the OOM and GPU-buffer tests.

## Overall assessment

The current build appears suitable for continued Raspberry Pi 4 testing. Steady-state CPU and thermal headroom are excellent, historical playback is responsive, hardware acceleration is active, and the known 2 GB/4K OOM condition has been mitigated. Long-duration memory stability and unattended recovery remain the primary tests before declaring Stage 8 complete.

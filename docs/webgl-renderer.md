# WebGL2 renderer

## Architecture assessment

WebGL2 is practical for the Raspberry Pi 4 experiment. Chromium on the test Pi exposed an accelerated GLES path through ANGLE, `vc4`, and `v3d`. A single WebGL drawing surface can replace several large Canvas 2D backing stores, while a fragment shader can calculate solar elevation and civil twilight without transferring a two-million-pixel JavaScript mask.

After extended testing, this implementation is the production SignalAtlas display at the root route. The previous Canvas renderer remains available at `/canvas-display` as a temporary fallback and reference. Its scope is:

- Blue Marble daytime texture;
- Black Marble nighttime texture;
- distinct Blue Marble modes with night lights enabled only for the configured night-lights background;
- a lazily loaded Natural Earth texture and an on-screen conservative estimate of decoded GPU texture memory;
- a lazily loaded, precomposited political-relief texture generated from the existing public-domain Natural Earth assets;
- solar-fixed idealized and political UTC labels with screen-space collision reduction and an on-screen visible-label count;
- the existing stretch-background setting, with a centered 2:1 map and black information space when stretching is disabled;
- selectable Greenwich-fixed, shack-fixed, or terminator/solar-fixed centering, with every geographic layer sharing the selected longitude transform;
- one WebGL2 canvas capped at 2560×1440;
- on-demand redraws: the live display redraws once per displayed second, or immediately when configuration, WSPR data, textures, geometry, or the viewport change; running historical playback redraws on every display refresh;
- GPU-completed frame timing through `EXT_disjoint_timer_query_webgl2`, when the browser exposes it, alongside JavaScript submission timing;
- live or historical WSPR cells rendered as GPU point sprites, using the existing band, persistence, visibility, and playback configuration;
- idealized or political timezone boundaries rendered as simplified, instanced GPU line segments;
- on-screen WSPR point count, submitted vertices per frame, and allocated vertex-buffer memory for tracking geometry growth;
- a GPU-rendered shack marker and screen-space station label driven by the same solar-fixed transform;
- simplified country boundaries rendered through the same instanced, antimeridian-safe GPU line path as timezone geometry;
- solar-fixed presentation, with the subsolar longitude fixed at screen center and the Earth textures rotating beneath it;
- hard-edge and civil-twilight shading in a fragment shader;
- live frame-time/FPS and simulated-time diagnostics.

Country and timezone geometry, WSPR geometry, and the shack marker have now been added incrementally after the base experiment demonstrated substantial local headroom. Additional labels and background implementations remain staged separately so each performance change can be measured.

## Expected memory difference

The previous Canvas renderer maintains four visible full-screen canvas buffers plus an additional night-lights compositing canvas and a terminator mask. The WebGL renderer maintains one visible color buffer and two immutable 4096×2048 textures. Exact GPU allocation is implementation-dependent, but it eliminates repeated full-screen backing surfaces and all per-frame terminator-mask uploads.

## Coordinate model

Screen longitude is relative to the Sun: 0° at screen center and ±180° at the horizontal edges. For each frame:

`Earth longitude = screen-relative longitude + subsolar longitude`

The Earth-fixed textures therefore rotate continuously as the subsolar longitude changes, while the shader's hour angle—and thus the horizontal position of the terminator—stays fixed. Solar declination remains time-dependent and changes the terminator's shape.

The map displays latitudes +75° through −75°, matching the production crop. Horizontal texture lookup wraps with `fract()`, avoiding a discontinuity when Earth longitude crosses ±180°.

## Production status

The live display no longer redraws at the display refresh rate. Between redraws the browser keeps presenting the last frame, so the terminator (which drifts about 2 px per minute at 2560 px) and the clock look the same while the Pi's GPU and main thread stay mostly idle. Historical playback still animates every frame.

WSPR data is pushed rather than polled: the server sends `{"type":"wspr","version":N}` over the WebSocket whenever its snapshot changes, and the display downloads `/api/wspr` only when that version differs from what it has, one request at a time.

WebGL context loss triggers a logged page reload so an unattended display does not remain blank. A failure before the first frame (no WebGL2, a shader error, or a base texture that cannot load) shows a message on screen and reloads once `/api/health` answers.

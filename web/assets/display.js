import { connectState } from "./app.js";
import { solarPosition } from "./astronomy.js";
import { displayTimestamp } from "./timeline.js";
import { parseWsprTime, visibleSpots } from "./wspr.js";
import { maidenheadToCoordinates } from "./map.js";
import { centerLongitude, mapLayout, politicalTimezoneLabels, solarFixedScreenPosition, timezoneLabelVerticalOffset, timezoneSegments } from "./display-core.js";
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1440;
const BASE_VERTEX_BYTES = 6 * Float32Array.BYTES_PER_ELEMENT;
const DARK_BOUNDARY_COLOR = new Float32Array([0.04, 0.055, 0.07]);
const LIGHT_BOUNDARY_COLOR = new Float32Array([0.92, 0.96, 0.99]);

const vertexSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_natural;
uniform sampler2D u_political;
uniform float u_center_longitude;
uniform float u_subsolar_longitude;
uniform float u_declination;
uniform float u_night_intensity;
uniform int u_hard_edge;
uniform int u_use_night_lights;
uniform int u_use_natural;
uniform int u_use_political;
in vec2 v_uv;
out vec4 output_color;

const float PI = 3.141592653589793;

void main() {
  float screen_v = 1.0 - v_uv.y;
  float latitude_degrees = mix(75.0, -75.0, screen_v);
  float relative_longitude = mix(-180.0, 180.0, v_uv.x);
  float earth_longitude = relative_longitude + u_center_longitude;
  float day_u = fract((earth_longitude + 180.0) / 360.0);
  float texture_v = (90.0 - latitude_degrees) / 180.0;

  vec3 day_color = u_use_political == 1
    ? texture(u_political, vec2(day_u, texture_v)).rgb
    : u_use_natural == 1
      ? texture(u_natural, vec2(day_u, texture_v)).rgb
      : texture(u_day, vec2(day_u, texture_v)).rgb;
  if (u_use_natural == 1) {
    float luminance = dot(day_color, vec3(0.2126, 0.7152, 0.0722));
    day_color = mix(vec3(luminance), day_color, 0.9) * 0.88;
    day_color = clamp((day_color - 0.5) * 1.4 + 0.5, 0.0, 1.0);
  }
  if (u_use_political == 1) {
    float luminance = dot(day_color, vec3(0.2126, 0.7152, 0.0722));
    day_color = mix(vec3(luminance), day_color, 1.2) * 1.02;
    day_color = clamp((day_color - 0.5) * 1.08 + 0.5, 0.0, 1.0);
  }
  vec3 night_color = texture(u_night, vec2(day_u, texture_v)).rgb;
  float latitude = radians(latitude_degrees);
  float hour_angle = radians(earth_longitude - u_subsolar_longitude);
  float sine_elevation = sin(latitude) * sin(u_declination)
    + cos(latitude) * cos(u_declination) * cos(hour_angle);
  float darkness = u_hard_edge == 1
    ? step(sine_elevation, -0.000001)
    : 1.0 - smoothstep(sin(radians(-6.0)), 0.0, sine_elevation);
  float blend = darkness * u_night_intensity;
  vec3 darkened_day = day_color * vec3(0.08, 0.12, 0.22);
  vec3 illuminated_night = max(night_color * 1.18, darkened_day);
  vec3 night_result = u_use_night_lights == 1 ? illuminated_night : darkened_day;
  output_color = vec4(mix(day_color, night_result, blend), 1.0);
}`;

const wsprVertexSource = `#version 300 es
precision highp float;
in vec2 a_longitude_latitude;
in float a_spot_minute;
in float a_radius;
uniform float u_center_longitude;
uniform float u_display_minute;
uniform float u_persistence_minutes;
uniform float u_point_scale;
out float v_opacity;

void main() {
  float relative_longitude = mod(a_longitude_latitude.x - u_center_longitude + 540.0, 360.0) - 180.0;
  float age = u_display_minute - a_spot_minute;
  float remaining = 1.0 - age / u_persistence_minutes;
  v_opacity = age >= 0.0 && age < u_persistence_minutes ? remaining * remaining : 0.0;
  gl_Position = vec4(relative_longitude / 180.0, a_longitude_latitude.y / 75.0, 0.0, 1.0);
  gl_PointSize = a_radius * 4.4 * u_point_scale;
}`;

const wsprFragmentSource = `#version 300 es
precision highp float;
in float v_opacity;
out vec4 output_color;

void main() {
  float distance_from_center = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (distance_from_center > 1.0 || v_opacity <= 0.0) discard;
  float core = 1.0 - smoothstep(0.38, 0.48, distance_from_center);
  float halo = (1.0 - smoothstep(0.48, 1.0, distance_from_center)) * 0.13;
  float alpha = core * (0.18 + v_opacity * 0.82) + halo * v_opacity;
  output_color = vec4(0.47, 0.89, 1.0, alpha);
}`;

const timezoneVertexSource = `#version 300 es
precision highp float;
in vec4 a_segment;
uniform float u_center_longitude;

void main() {
  int endpoint = gl_VertexID % 2;
  int copy = gl_VertexID / 2 - 1;
  float first_relative = mod(a_segment.x - u_center_longitude + 540.0, 360.0) - 180.0;
  float longitude_delta = mod(a_segment.z - a_segment.x + 540.0, 360.0) - 180.0;
  float relative_longitude = endpoint == 0 ? first_relative : first_relative + longitude_delta;
  float latitude = endpoint == 0 ? a_segment.y : a_segment.w;
  gl_Position = vec4(relative_longitude / 180.0 + float(copy) * 2.0, latitude / 75.0, 0.0, 1.0);
}`;

const timezoneFragmentSource = `#version 300 es
precision highp float;
uniform float u_opacity;
uniform vec3 u_color;
out vec4 output_color;
void main() { output_color = vec4(u_color, u_opacity); }`;

const shackVertexSource = `#version 300 es
precision highp float;
uniform vec2 u_longitude_latitude;
uniform float u_center_longitude;
uniform float u_point_scale;
void main() {
  float relative_longitude = mod(u_longitude_latitude.x - u_center_longitude + 540.0, 360.0) - 180.0;
  gl_Position = vec4(relative_longitude / 180.0, u_longitude_latitude.y / 75.0, 0.0, 1.0);
  gl_PointSize = 26.0 * u_point_scale;
}`;

const shackFragmentSource = `#version 300 es
precision highp float;
out vec4 output_color;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (radius > 1.0) discard;
  vec3 color = radius > 0.72 ? vec3(0.075, 0.11, 0.15) : vec3(1.0, 0.827, 0.306);
  output_color = vec4(color, 1.0);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function createProgram(gl, vertexShaderSource = vertexSource, fragmentShaderSource = fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

async function loadTexture(gl, url, unit) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bitmap);
  bitmap.close();
  return { texture };
}

const canvas = document.querySelector("#display-map");
const timeLabel = document.querySelector("#display-time");
const stationName = document.querySelector("#display-station-name");
const shackLabel = document.querySelector("#display-shack-label");
const timezoneLabelLayer = document.querySelector("#display-timezone-labels");
let contextRecoveryTimer = null;
canvas.addEventListener("webglcontextlost", event => {
  event.preventDefault();
  console.error("WebGL context lost; reloading the SignalAtlas display to recover");
  contextRecoveryTimer ??= window.setTimeout(() => window.location.reload(), 3000);
});
canvas.addEventListener("webglcontextrestored", () => {
  console.warn("WebGL context restored; reloading the SignalAtlas display to rebuild renderer resources");
  if (contextRecoveryTimer !== null) window.clearTimeout(contextRecoveryTimer);
  contextRecoveryTimer = window.setTimeout(() => window.location.reload(), 250);
});
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
if (!gl) throw new Error("WebGL2 is unavailable");

const program = createProgram(gl);
gl.useProgram(program);
const mapVao = gl.createVertexArray();
gl.bindVertexArray(mapVao);
const vertices = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const position = gl.getAttribLocation(program, "a_position");
gl.enableVertexAttribArray(position);
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
const uniforms = {
  center: gl.getUniformLocation(program, "u_center_longitude"),
  subsolar: gl.getUniformLocation(program, "u_subsolar_longitude"),
  declination: gl.getUniformLocation(program, "u_declination"),
  intensity: gl.getUniformLocation(program, "u_night_intensity"),
  hard: gl.getUniformLocation(program, "u_hard_edge"),
  useNightLights: gl.getUniformLocation(program, "u_use_night_lights"),
  useNatural: gl.getUniformLocation(program, "u_use_natural"),
  usePolitical: gl.getUniformLocation(program, "u_use_political"),
};
gl.uniform1i(gl.getUniformLocation(program, "u_day"), 0);
gl.uniform1i(gl.getUniformLocation(program, "u_night"), 1);
gl.uniform1i(gl.getUniformLocation(program, "u_natural"), 2);
gl.uniform1i(gl.getUniformLocation(program, "u_political"), 3);

const wsprProgram = createProgram(gl, wsprVertexSource, wsprFragmentSource);
const wsprVao = gl.createVertexArray();
const wsprBuffer = gl.createBuffer();
gl.bindVertexArray(wsprVao);
gl.bindBuffer(gl.ARRAY_BUFFER, wsprBuffer);
const wsprStride = 4 * Float32Array.BYTES_PER_ELEMENT;
for (const [name, size, offset] of [["a_longitude_latitude", 2, 0], ["a_spot_minute", 1, 2], ["a_radius", 1, 3]]) {
  const attribute = gl.getAttribLocation(wsprProgram, name);
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, wsprStride, offset * Float32Array.BYTES_PER_ELEMENT);
}
const wsprUniforms = {
  center: gl.getUniformLocation(wsprProgram, "u_center_longitude"),
  displayMinute: gl.getUniformLocation(wsprProgram, "u_display_minute"),
  persistence: gl.getUniformLocation(wsprProgram, "u_persistence_minutes"),
  scale: gl.getUniformLocation(wsprProgram, "u_point_scale"),
};

const timezoneProgram = createProgram(gl, timezoneVertexSource, timezoneFragmentSource);
const timezoneVao = gl.createVertexArray();
const timezoneBuffer = gl.createBuffer();
gl.bindVertexArray(timezoneVao);
gl.bindBuffer(gl.ARRAY_BUFFER, timezoneBuffer);
const timezoneAttribute = gl.getAttribLocation(timezoneProgram, "a_segment");
gl.enableVertexAttribArray(timezoneAttribute);
gl.vertexAttribPointer(timezoneAttribute, 4, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(timezoneAttribute, 1);
const timezoneUniforms = {
  center: gl.getUniformLocation(timezoneProgram, "u_center_longitude"),
  opacity: gl.getUniformLocation(timezoneProgram, "u_opacity"),
  color: gl.getUniformLocation(timezoneProgram, "u_color"),
};
const countryVao = gl.createVertexArray();
const countryBuffer = gl.createBuffer();
gl.bindVertexArray(countryVao);
gl.bindBuffer(gl.ARRAY_BUFFER, countryBuffer);
const countryAttribute = gl.getAttribLocation(timezoneProgram, "a_segment");
gl.enableVertexAttribArray(countryAttribute);
gl.vertexAttribPointer(countryAttribute, 4, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(countryAttribute, 1);
let countryCount = 0;
const shackProgram = createProgram(gl, shackVertexSource, shackFragmentSource);
const shackVao = gl.createVertexArray();
const shackUniforms = {
  location: gl.getUniformLocation(shackProgram, "u_longitude_latitude"),
  center: gl.getUniformLocation(shackProgram, "u_center_longitude"),
  scale: gl.getUniformLocation(shackProgram, "u_point_scale"),
};
const idealizedTimezoneData = new Float32Array(Array.from({ length: 24 }, (_, index) => {
  const longitude = (index - 11) * 15;
  return [longitude, -75, longitude, 75];
}).flat());
let politicalTimezoneData = null;
let politicalLabelData = null;
let timezoneBufferStyle = null;
let timezoneCount = 0;
let timezoneLabelStyle = null;
let timezoneLabels = [];

let state = null;
let snapshot = { fetched_at: null };
let texturesReady = false;
let naturalTextureReady = false;
let naturalTextureLoading = false;
let politicalTextureReady = false;
let politicalTextureLoading = false;
const textures = [];
let wsprCount = 0;
let wsprOrigin = 0;
let wsprSelectionUpdated = 0;
let currentMapLayout = { width: 1, height: 1, top: 0 };

function resize() {
  // This route is deliberately full-screen. Using the viewport directly also
  // avoids falling back to the canvas element's 300x150 intrinsic dimensions.
  const layout = mapLayout(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), state?.stretch_backgrounds ?? true);
  const cssWidth = layout.width;
  const cssHeight = layout.height;
  currentMapLayout = layout;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.top = `${layout.top}px`;
  const scale = Math.min(window.devicePixelRatio || 1, MAX_WIDTH / cssWidth, MAX_HEIGHT / cssHeight);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

async function refreshSnapshot() {
  const response = await fetch("/api/wspr", { cache: "no-store" });
  if (response.ok) {
    snapshot = await response.json();
    wsprSelectionUpdated = 0;
  }
}

async function ensureNaturalTexture() {
  if (naturalTextureReady || naturalTextureLoading) return;
  naturalTextureLoading = true;
  try {
    const loaded = await loadTexture(gl, "/assets/maps/natural-earth.webp", 2);
    textures.push(loaded.texture);
    naturalTextureReady = true;
  } finally {
    naturalTextureLoading = false;
  }
}

async function ensurePoliticalTexture() {
  if (politicalTextureReady || politicalTextureLoading) return;
  politicalTextureLoading = true;
  try {
    const loaded = await loadTexture(gl, "/assets/maps/political-relief.webp", 3);
    textures.push(loaded.texture);
    politicalTextureReady = true;
  } finally {
    politicalTextureLoading = false;
  }
}

function updateWsprBuffer(displayTime) {
  wsprSelectionUpdated = displayTime.getTime();
  if (!state.wspr_visible) {
    wsprCount = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, wsprBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    return;
  }
  const selected = visibleSpots(snapshot.spots || [], state.wspr_band, displayTime, state.wspr_persistence_minutes)
    .filter(spot => spot.latitude >= -75 && spot.latitude <= 75);
  wsprOrigin = Math.floor(displayTime.getTime() / 60_000) - state.wspr_persistence_minutes;
  const data = new Float32Array(selected.length * 4);
  selected.forEach((spot, index) => {
    const offset = index * 4;
    data[offset] = spot.longitude;
    data[offset + 1] = spot.latitude;
    data[offset + 2] = parseWsprTime(spot.latest_time).getTime() / 60_000 - wsprOrigin;
    data[offset + 3] = 3.2 + Math.min(3, Math.log2(spot.receptions + 1) * 0.45);
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, wsprBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  wsprCount = selected.length;
}

function selectTimezoneBuffer() {
  const style = state.timezone_style;
  if (timezoneBufferStyle === style) return;
  const data = style === "political" ? politicalTimezoneData : idealizedTimezoneData;
  if (!data) {
    timezoneCount = 0;
    return;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, timezoneBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  timezoneCount = data.length / 4;
  timezoneBufferStyle = style;
}

function selectTimezoneLabels() {
  if (timezoneLabelStyle === state.timezone_style) return;
  const data = state.timezone_style === "political"
    ? politicalLabelData
    : Array.from({ length: 24 }, (_, index) => ({ longitude: (index - 11) * 15, latitude: 68, text: index - 11 === 0 ? "UTC" : `UTC${index - 11 > 0 ? "+" : ""}${index - 11}` }));
  if (!data) return;
  timezoneLabels = data.map(label => {
    const element = document.createElement("span");
    element.textContent = label.text;
    return { ...label, element };
  });
  timezoneLabelLayer.replaceChildren(...timezoneLabels.map(label => label.element));
  timezoneLabelStyle = state.timezone_style;
}

function updateTimezoneLabels(subsolarLongitude) {
  if (!state.timezone_visible) {
    timezoneLabelLayer.hidden = true;
    return;
  }
  selectTimezoneLabels();
  timezoneLabelLayer.hidden = false;
  const occupied = [];
  const collisionDistance = 105 * window.innerWidth / 1920;
  for (const label of timezoneLabels) {
    const point = solarFixedScreenPosition(label.longitude, label.latitude, subsolarLongitude);
    const x = point.x * currentMapLayout.width;
    const y = currentMapLayout.top + point.y * currentMapLayout.height
      + timezoneLabelVerticalOffset(state.timezone_style, label.text, label.latitude, window.innerHeight);
    const collides = state.timezone_style === "political" && occupied.some(other => Math.hypot(other.x - x, other.y - y) < collisionDistance);
    label.element.hidden = collides;
    if (collides) continue;
    label.element.style.left = `${point.x * 100}%`;
    label.element.style.top = `${y}px`;
    occupied.push({ x, y });
  }
}

function draw() {
  window.requestAnimationFrame(draw);
  if (!state || !texturesReady) return;
  resize();
  const timestamp = displayTimestamp(state, snapshot, new Date());
  if (Math.abs(timestamp.getTime() - wsprSelectionUpdated) >= 5000) updateWsprBuffer(timestamp);
  const sun = solarPosition(timestamp);
  const shack = state.shack_locator ? maidenheadToCoordinates(state.shack_locator) : { longitude: 0, latitude: 0 };
  const mapCenter = centerLongitude(state, sun.longitude, shack.longitude);
  gl.useProgram(program);
  gl.bindVertexArray(mapVao);
  gl.uniform1f(uniforms.center, mapCenter);
  gl.uniform1f(uniforms.subsolar, sun.longitude);
  gl.uniform1f(uniforms.declination, sun.declination * Math.PI / 180);
  gl.uniform1f(uniforms.intensity, state.night_intensity);
  gl.uniform1i(uniforms.hard, state.terminator_mode === "hard" ? 1 : 0);
  gl.uniform1i(uniforms.useNightLights, state.map_style === "blue_marble_lights" ? 1 : 0);
  gl.uniform1i(uniforms.useNatural, state.map_style === "natural_earth" && naturalTextureReady ? 1 : 0);
  gl.uniform1i(uniforms.usePolitical, state.map_style === "political_relief" && politicalTextureReady ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const darkBoundaryLines = state.map_style === "natural_earth" || state.map_style === "political_relief";
  const boundaryColor = darkBoundaryLines ? DARK_BOUNDARY_COLOR : LIGHT_BOUNDARY_COLOR;
  if (countryCount > 0) {
    gl.useProgram(timezoneProgram);
    gl.bindVertexArray(countryVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(timezoneUniforms.center, mapCenter);
    gl.uniform1f(timezoneUniforms.opacity, 0.48);
    gl.uniform3fv(timezoneUniforms.color, boundaryColor);
    gl.drawArraysInstanced(gl.LINES, 0, 6, countryCount);
    gl.disable(gl.BLEND);
  }
  if (state.wspr_visible && wsprCount > 0) {
    gl.useProgram(wsprProgram);
    gl.bindVertexArray(wsprVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(wsprUniforms.center, mapCenter);
    gl.uniform1f(wsprUniforms.displayMinute, timestamp.getTime() / 60_000 - wsprOrigin);
    gl.uniform1f(wsprUniforms.persistence, state.wspr_persistence_minutes);
    gl.uniform1f(wsprUniforms.scale, Math.max(0.75, canvas.width / 1920));
    gl.drawArrays(gl.POINTS, 0, wsprCount);
    gl.disable(gl.BLEND);
  }
  if (state.timezone_visible) {
    selectTimezoneBuffer();
    if (timezoneCount > 0) {
      gl.useProgram(timezoneProgram);
      gl.bindVertexArray(timezoneVao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(timezoneUniforms.center, mapCenter);
      gl.uniform1f(timezoneUniforms.opacity, state.timezone_style === "political" ? 0.52 : 0.28);
      gl.uniform3fv(timezoneUniforms.color, boundaryColor);
      gl.drawArraysInstanced(gl.LINES, 0, 6, timezoneCount);
      gl.disable(gl.BLEND);
    }
  }
  const shackVisible = Boolean(state.shack_locator) && (state.station_name_visible || state.maidenhead_visible);
  if (shackVisible) {
    gl.useProgram(shackProgram);
    gl.bindVertexArray(shackVao);
    gl.uniform2f(shackUniforms.location, shack.longitude, shack.latitude);
    gl.uniform1f(shackUniforms.center, mapCenter);
    gl.uniform1f(shackUniforms.scale, Math.max(0.75, canvas.width / 1920));
    gl.drawArrays(gl.POINTS, 0, 1);
  }
  const shackScreen = solarFixedScreenPosition(shack.longitude, shack.latitude, mapCenter);
  stationName.textContent = state.receiver_callsign;
  stationName.hidden = !state.station_name_visible || !state.receiver_callsign;
  const shackLabelParts = [];
  if (state.station_name_visible && state.receiver_callsign) shackLabelParts.push(state.receiver_callsign);
  if (state.maidenhead_visible && state.shack_locator) shackLabelParts.push(state.shack_locator);
  shackLabel.textContent = shackLabelParts.join(" · ");
  shackLabel.hidden = !shackVisible;
  shackLabel.style.left = `${shackScreen.x * 100}%`;
  shackLabel.style.top = `${currentMapLayout.top + shackScreen.y * currentMapLayout.height}px`;
  shackLabel.dataset.edge = shackScreen.x > 0.9 ? "right" : "left";
  updateTimezoneLabels(mapCenter);
  timeLabel.textContent = timestamp.toISOString().slice(0, 19).replace("T", " ") + " UTC";

}

connectState(next => {
  state = next;
  wsprSelectionUpdated = 0;
  timezoneBufferStyle = null;
  timezoneLabelStyle = null;
  if (state.map_style === "natural_earth") ensureNaturalTexture().catch(error => { console.error("SignalAtlas display:", error); });
  if (state.map_style === "political_relief") ensurePoliticalTexture().catch(error => { console.error("SignalAtlas display:", error); });
  refreshSnapshot().catch(error => { console.error("SignalAtlas display:", error); });
});

window.setInterval(() => refreshSnapshot().catch(error => { console.error("SignalAtlas display:", error); }), 60_000);

Promise.all([
  loadTexture(gl, "/assets/maps/blue-marble-january.webp", 0),
  loadTexture(gl, "/assets/maps/black-marble-2016.webp", 1),
]).then(loadedTextures => {
  for (const loaded of loadedTextures) {
    textures.push(loaded.texture);
  }
  texturesReady = true;
}).catch(error => { console.error("SignalAtlas display:", error); });

fetch("/assets/maps/timezones-10m.geojson")
  .then(response => {
    if (!response.ok) throw new Error("Unable to load timezone boundaries");
    return response.json();
  })
  .then(geojson => {
    politicalTimezoneData = timezoneSegments(geojson);
    politicalLabelData = politicalTimezoneLabels(geojson);
    timezoneBufferStyle = null;
    timezoneLabelStyle = null;
  })
  .catch(error => { console.error("SignalAtlas display:", error); });

fetch("/assets/maps/countries-50m.geojson")
  .then(response => {
    if (!response.ok) throw new Error("Unable to load country boundaries");
    return response.json();
  })
  .then(geojson => {
    const data = timezoneSegments(geojson);
    gl.bindBuffer(gl.ARRAY_BUFFER, countryBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    countryCount = data.length / 4;
  })
  .catch(error => { console.error("SignalAtlas display:", error); });

window.addEventListener("resize", resize);
resize();
window.requestAnimationFrame(draw);

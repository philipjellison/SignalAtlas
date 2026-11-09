import test from "node:test";
import assert from "node:assert/strict";
import { centerLongitude, frameNeeded, playbackAnimating, mapLayout, normalizeLongitude, politicalTimezoneLabels, shouldDrawFrame, solarFixedEarthLongitude, solarFixedScreenPosition, textureCoordinates, timezoneLabelVerticalOffset, timezoneSegments } from "./display-core.js";

test("solar-fixed longitude rotates Earth beneath a stationary subsolar point", () => {
  assert.equal(solarFixedEarthLongitude(0, 45), 45);
  assert.equal(solarFixedEarthLongitude(-45, 45), 0);
  assert.equal(solarFixedEarthLongitude(170, 30), -160);
});

test("longitude wrapping is stable at the antimeridian", () => {
  assert.equal(normalizeLongitude(180), -180);
  assert.equal(normalizeLongitude(-181), 179);
  assert.ok(Math.abs(textureCoordinates(179, 0, 2).u - 1 / 360) < 1e-12);
});

test("latitude crop maps to the source texture without distortion", () => {
  assert.equal(textureCoordinates(0, 75, 0).v, 1 / 12);
  assert.equal(textureCoordinates(0, -75, 0).v, 11 / 12);
});

test("30 FPS gate accepts frames at the target interval", () => {
  assert.equal(shouldDrawFrame(null, 0), true);
  assert.equal(shouldDrawFrame(0, 20), false);
  assert.equal(shouldDrawFrame(0, 34), true);
});

test("converts polygon rings to simplified timezone segments", () => {
  const data = timezoneSegments({ features: [{ geometry: { type: "Polygon", coordinates: [[[-10, 0], [-9.99, 0], [-9, 1], [-10, 0]]] } }] }, 0.1);
  assert.deepEqual([...data], [-10, 0, -9, 1, -9, 1, -10, 0]);
});

test("places Earth-fixed markers in the solar-fixed viewport", () => {
  assert.deepEqual(solarFixedScreenPosition(30, 0, 30), { x: 0.5, y: 0.5 });
  assert.ok(Math.abs(solarFixedScreenPosition(-179, 75, 179).x - 182 / 360) < 1e-12);
});

test("derives labels only from sufficiently large inhabited timezone polygons", () => {
  const ring = [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]];
  const labels = politicalTimezoneLabels({ features: [
    { properties: { places: "Example", utc_format: "UTC+02:00" }, geometry: { type: "Polygon", coordinates: [ring] } },
    { properties: { places: "Example Ocean", utc_format: "UTC+03:00" }, geometry: { type: "Polygon", coordinates: [ring] } },
  ] });
  assert.deepEqual(labels, [{ longitude: 10, latitude: 5, text: "UTC+02", area: 200 }]);
});

test("centers an unstretched two-to-one map inside the viewport", () => {
  assert.deepEqual(mapLayout(1920, 1200, false), { width: 1920, height: 960, top: 120 });
  assert.deepEqual(mapLayout(1920, 1200, true), { width: 1920, height: 1200, top: 0 });
});

test("selects Greenwich, shack, or solar-fixed center longitude", () => {
  assert.equal(centerLongitude({ map_center: "greenwich" }, 45, -80), 0);
  assert.equal(centerLongitude({ map_center: "shack" }, 45, -80), -80);
  assert.equal(centerLongitude({ map_center: "terminator" }, 45, -80), 45);
});

test("lowers idealized and selected top-edge political timezone labels", () => {
  assert.equal(timezoneLabelVerticalOffset("idealized", "UTC+5", 68, 1080), 20);
  assert.equal(timezoneLabelVerticalOffset("political", "UTC-12", 67, 2160), 20);
  assert.equal(timezoneLabelVerticalOffset("political", "UTC±00", 67, 1080), 10);
  assert.equal(timezoneLabelVerticalOffset("political", "UTC+5", 67, 1080), 0);
});

test("live display redraws once per displayed second unless something changed", () => {
  assert.equal(frameNeeded(false, false, 100, 100), false);
  assert.equal(frameNeeded(false, false, 101, 100), true);
  assert.equal(frameNeeded(true, false, 100, 100), true);
  assert.equal(frameNeeded(false, true, 100, 100), true);
});

test("only running historical playback animates every frame", () => {
  assert.equal(playbackAnimating({ wspr_mode: "live", playback_running: true }), false);
  assert.equal(playbackAnimating({ wspr_mode: "historical", playback_running: false }), false);
  assert.equal(playbackAnimating({ wspr_mode: "historical", playback_running: true }), true);
  assert.equal(playbackAnimating(null), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { darknessAlpha, darknessAlphaFromSine, solarElevation, solarPosition } from "./astronomy.js";

test("solar declination is near zero at the March equinox", () => {
  const sun = solarPosition("2024-03-20T03:06:00Z");
  assert.ok(Math.abs(sun.declination) < 0.1, `declination was ${sun.declination}`);
});

test("solar declination reaches the expected June solstice latitude", () => {
  const sun = solarPosition("2024-06-20T20:51:00Z");
  assert.ok(Math.abs(sun.declination - 23.44) < 0.1, `declination was ${sun.declination}`);
});

test("subsolar longitude follows UTC", () => {
  const noon = solarPosition("2024-03-20T12:00:00Z");
  const midnight = solarPosition("2024-03-20T00:00:00Z");
  assert.ok(Math.abs(noon.longitude) < 3);
  assert.ok(Math.abs(Math.abs(midnight.longitude) - 180) < 3);
});

test("detects polar day and polar night", () => {
  const june = solarPosition("2024-06-20T20:51:00Z");
  const december = solarPosition("2024-12-21T09:20:00Z");
  for (let longitude = -180; longitude < 180; longitude += 15) {
    assert.ok(solarElevation(80, longitude, june) > 0);
    assert.ok(solarElevation(80, longitude, december) < 0);
  }
});

test("hard edge and civil twilight masks follow their specified thresholds", () => {
  assert.equal(darknessAlpha(0.1, "hard", 0.7), 0);
  assert.equal(darknessAlpha(-0.1, "hard", 0.7), 0.7);
  assert.equal(darknessAlpha(0, "civil_twilight", 0.8), 0);
  assert.equal(darknessAlpha(-6, "civil_twilight", 0.8), 0.8);
  assert.ok(darknessAlpha(-3, "civil_twilight", 0.8) > 0);
});

test("optimized sine-based darkness matches elevation-based darkness", () => {
  for (const mode of ["hard", "civil_twilight"]) {
    for (let elevation = -90; elevation <= 90; elevation += 0.25) {
      const expected = darknessAlpha(elevation, mode, 0.83);
      const actual = darknessAlphaFromSine(Math.sin(elevation * Math.PI / 180), mode, 0.83);
      assert.ok(Math.abs(actual - expected) < 1e-12, `${mode} differed at ${elevation}°`);
    }
  }
});

test("the same timestamp always produces the same solar position", () => {
  assert.deepEqual(solarPosition("2026-08-24T03:15:00Z"), solarPosition("2026-08-24T03:15:00Z"));
});

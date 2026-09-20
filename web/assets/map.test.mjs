import test from "node:test";
import assert from "node:assert/strict";
import { latitudeToY, longitudeToX, maidenheadToCoordinates, mapVerticalBounds, normalizeLongitude } from "./map.js";

test("normalizes longitudes around the antimeridian", () => {
  assert.equal(normalizeLongitude(190), -170);
  assert.equal(normalizeLongitude(-190), 170);
});

test("projects Greenwich-centered cardinal coordinates", () => {
  assert.equal(longitudeToX(-180, 0, 3600), 0);
  assert.equal(longitudeToX(0, 0, 3600), 1800);
  assert.equal(latitudeToY(90, 1800), 0);
  assert.equal(latitudeToY(0, 1800), 900);
});

test("places the selected center longitude at display center", () => {
  assert.equal(longitudeToX(-80, -80, 3600), 1800);
});

test("converts K3LR Maidenhead locator to its cell center", () => {
  const point = maidenheadToCoordinates("EN91se");
  assert.ok(Math.abs(point.longitude - -80.458333) < 0.00001);
  assert.ok(Math.abs(point.latitude - 41.1875) < 0.00001);
});

test("reserves equal presentation bands outside the trimmed polar viewport", () => {
  const bounds = mapVerticalBounds(1080);
  assert.equal(bounds.top, 90);
  assert.equal(bounds.bottom, 990);
});

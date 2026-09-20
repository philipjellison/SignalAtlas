import test from "node:test";
import assert from "node:assert/strict";
import { shackScreenPosition, timezoneMeridians, utcOffsetLabel } from "./geography.js";

const baseState = { map_center: "greenwich", shack_locator: "EN91SE" };

test("produces 24 idealized hourly timezone meridians", () => {
  const meridians = timezoneMeridians();
  assert.equal(meridians.length, 24);
  assert.equal(meridians[0].offset, -11);
  assert.equal(meridians.at(-1).offset, 12);
});

test("formats UTC offset labels", () => {
  assert.equal(utcOffsetLabel(-5), "UTC-5");
  assert.equal(utcOffsetLabel(0), "UTC");
  assert.equal(utcOffsetLabel(9), "UTC+9");
});

test("places EN91SE correctly on a Greenwich-centered map", () => {
  const point = shackScreenPosition(baseState, 3600, 1800);
  assert.ok(Math.abs(point.x - 995.41667) < 0.001);
  assert.ok(Math.abs(point.y - 488.125) < 0.001);
});

test("places the shack at horizontal center in shack-centered mode", () => {
  const point = shackScreenPosition({ ...baseState, map_center: "shack" }, 3840, 1920);
  assert.equal(point.x, 1920);
});

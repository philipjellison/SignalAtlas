import test from "node:test";
import assert from "node:assert/strict";
import { parseWsprTime, recencyOpacity, visibleSpots } from "./wspr.js";

test("parses ClickHouse timestamps as UTC", () => {
  assert.equal(parseWsprTime("2026-08-24 19:34:00").toISOString(), "2026-08-24T19:34:00.000Z");
});

test("fades continuously and expires at persistence limit", () => {
  const now = new Date("2026-08-24T20:04:00Z");
  const halfway = recencyOpacity("2026-08-24 19:34:00", now, 60);
  assert.ok(Math.abs(halfway - 0.25) < 0.0001);
  assert.equal(recencyOpacity("2026-08-24 19:04:00", now, 60), 0);
});

test("filters bands and aggregates repeated geographic cells", () => {
  const spots = [
    { locator: "FN31", band: 14, latest_time: "2026-08-24 19:30:00" },
    { locator: "FN31", band: 7, latest_time: "2026-08-24 19:32:00" },
    { locator: "EM10", band: 14, latest_time: "2026-08-24 19:31:00" },
  ];
  assert.equal(visibleSpots(spots, "all").length, 2);
  assert.equal(visibleSpots(spots, "20m").length, 2);
  assert.equal(visibleSpots(spots, "40m").length, 1);
});

test("selects the latest reception at or before historical display time", () => {
  const spots = [
    { locator: "FN31", band: 14, latest_time: "2026-08-24 18:30:00" },
    { locator: "FN31", band: 14, latest_time: "2026-08-24 19:30:00" },
  ];
  const visible = visibleSpots(spots, "20m", new Date("2026-08-24T19:00:00Z"), 60);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].latest_time, "2026-08-24 18:30:00");
});

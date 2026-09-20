import test from "node:test";
import assert from "node:assert/strict";
import { displayTimestamp, playbackProgress } from "./timeline.js";

const state = {
  wspr_mode: "historical", history_hours: 24, playback_duration_seconds: 240,
  playback_loop: true, playback_running: true, playback_started_at: "2026-08-24T20:00:00Z", playback_position: 0,
};
const snapshot = { fetched_at: "2026-08-24T20:00:00Z" };

test("maps playback progress onto the selected historical UTC window", () => {
  const halfway = new Date("2026-08-24T20:02:00Z");
  assert.equal(playbackProgress(state, halfway), 0.5);
  assert.equal(displayTimestamp(state, snapshot, halfway).toISOString(), "2026-08-24T08:00:00.000Z");
});

test("loops playback at the configured duration", () => {
  assert.equal(playbackProgress(state, new Date("2026-08-24T20:04:00Z")), 0);
});

test("uses one fixed historical time while paused", () => {
  const paused = { ...state, playback_running: false, playback_position: 0.25 };
  assert.equal(displayTimestamp(paused, snapshot, new Date()).toISOString(), "2026-08-24T02:00:00.000Z");
});

test("live mode uses current UTC", () => {
  const now = new Date("2026-08-24T20:10:00Z");
  assert.equal(displayTimestamp({ ...state, wspr_mode: "live" }, snapshot, now), now);
});

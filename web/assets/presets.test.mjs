import test from "node:test";
import assert from "node:assert/strict";
import { applyPreset } from "./presets.js";

const base = { schema_version: 5, receiver_callsign: "K3LR", shack_locator: "EN91SE", stretch_backgrounds: false, wspr_visible: false };

test("Geochron preset hides WSPR without changing station identity", () => {
  const result = applyPreset(base, "geochron");
  assert.equal(result.wspr_visible, false);
  assert.equal(result.map_style, "political_relief");
  assert.equal(result.receiver_callsign, "K3LR");
});

test("24-hour tour starts one synchronized looping playback", () => {
  const now = new Date("2026-08-24T20:00:00Z");
  const result = applyPreset(base, "wspr_24h", now);
  assert.equal(result.history_hours, 24);
  assert.equal(result.playback_running, true);
  assert.equal(result.playback_started_at, now.toISOString());
});

test("band presets select live mode and the requested band", () => {
  for (const band of ["160m", "80m", "40m"]) {
    const result = applyPreset(base, `band_${band}`);
    assert.equal(result.wspr_mode, "live");
    assert.equal(result.wspr_band, band);
    assert.equal(result.wspr_visible, true);
  }
});

test("unknown presets are rejected", () => {
  assert.throws(() => applyPreset(base, "weather"));
});

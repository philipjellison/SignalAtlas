const liveBase = {
  wspr_visible: true,
  wspr_mode: "live",
  playback_running: false,
  playback_position: 0,
  playback_started_at: null,
};

export const PRESETS = [
  { id: "geochron", label: "Geochron" },
  { id: "wspr_live", label: "WSPR Live" },
  { id: "wspr_24h", label: "WSPR 24h Tour" },
  { id: "band_160m", label: "160 m Live" },
  { id: "band_80m", label: "80 m Live" },
  { id: "band_40m", label: "40 m Live" },
  { id: "band_20m", label: "20 m Live" },
  { id: "band_10m", label: "10 m Live" },
];

export function applyPreset(state, preset, now = new Date()) {
  switch (preset) {
    case "geochron":
      return { ...state, wspr_visible: false, wspr_mode: "live", map_style: "political_relief", map_center: "greenwich", terminator_mode: "civil_twilight", timezone_visible: true };
    case "wspr_live":
      return { ...state, ...liveBase, wspr_band: "all", map_style: "natural_earth", map_center: "greenwich" };
    case "wspr_24h":
      return {
        ...state, wspr_visible: true, wspr_mode: "historical", wspr_band: "all",
        history_hours: 24, playback_duration_seconds: 240, playback_loop: true,
        playback_running: true, playback_position: 0, playback_started_at: now.toISOString(),
        map_style: "natural_earth", map_center: "greenwich",
      };
    default: {
      const match = /^band_(160m|80m|40m|20m|15m|10m)$/.exec(preset);
      if (match) return { ...state, ...liveBase, wspr_band: match[1], map_style: "natural_earth", map_center: "greenwich" };
      throw new Error(`Unknown presentation preset: ${preset}`);
    }
  }
}

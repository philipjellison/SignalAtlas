import { centerLongitudeFor, latitudeToY, longitudeToX, mapVerticalBounds } from "./map.js";
import { displayTimestamp } from "./timeline.js";

const BAND_VALUES = { "160m": 1, "80m": 3, "40m": 7, "20m": 14, "15m": 21, "10m": 28 };

export function parseWsprTime(value) {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export function recencyOpacity(spotTime, displayTime, persistenceMinutes) {
  const age = displayTime.getTime() - parseWsprTime(spotTime).getTime();
  const windowMs = persistenceMinutes * 60_000;
  if (age < 0 || age >= windowMs) return 0;
  const remaining = 1 - age / windowMs;
  return remaining * remaining;
}

export function visibleSpots(spots, band, displayTime = null, persistenceMinutes = null) {
  let selected = band === "all" ? spots : spots.filter(spot => spot.band === BAND_VALUES[band]);
  if (displayTime && persistenceMinutes) {
    selected = selected.filter(spot => recencyOpacity(spot.latest_time, displayTime, persistenceMinutes) > 0);
  }
  const cells = new Map();
  for (const spot of selected) {
    const current = cells.get(spot.locator);
    if (!current || spot.latest_time > current.latest_time) cells.set(spot.locator, spot);
  }
  return [...cells.values()];
}

export class WsprOverlay {
  constructor(canvas, clock = () => new Date()) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.clock = clock;
    this.state = null;
    this.snapshot = { spots: [], stale: true, fetched_at: null };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.refresh();
    this.fetchTimer = window.setInterval(() => this.refresh(), 60_000);
  }

  setState(state) { this.state = state; this.render(); }

  displayTime(now = this.clock()) { return displayTimestamp(this.state, this.snapshot, now); }

  async refresh() {
    try {
      const response = await fetch("/api/wspr", { cache: "no-store" });
      if (!response.ok) throw new Error("WSPR cache unavailable");
      this.snapshot = await response.json();
    } catch (error) {
      this.snapshot.stale = true;
      this.snapshot.error = error.message;
    }
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2, 2560 / rect.width, 1440 / rect.height);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height; this.render();
    }
  }

  render(now = this.clock()) {
    const ctx = this.context; const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    if (!this.state?.wspr_visible) return;
    const displayTime = this.displayTime(now);
    const center = centerLongitudeFor(this.state);
    const bounds = mapVerticalBounds(height);
    const scale = Math.max(0.75, width / 1920);
    let count = 0;
    for (const spot of visibleSpots(this.snapshot.spots || [], this.state.wspr_band, displayTime, this.state.wspr_persistence_minutes)) {
      const opacity = recencyOpacity(spot.latest_time, displayTime, this.state.wspr_persistence_minutes);
      const y = latitudeToY(spot.latitude, height);
      if (opacity <= 0 || y < bounds.top || y > bounds.bottom) continue;
      const x = longitudeToX(spot.longitude, center, width);
      const radius = (3.2 + Math.min(3, Math.log2(spot.receptions + 1) * 0.45)) * scale;
      ctx.beginPath(); ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(62, 211, 255, ${opacity * 0.13})`; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(119, 226, 255, ${0.18 + opacity * 0.82})`; ctx.fill();
      count += 1;
    }
    ctx.font = `${Math.max(11, 14 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillStyle = this.snapshot.stale ? "#ffbd78" : "#93dff4";
    const condition = this.snapshot.stale ? " · cached" : "";
    const mode = this.state.wspr_mode === "historical" ? ` · ${displayTime.toISOString().slice(0, 16).replace("T", " ")}Z` : "";
    ctx.fillText(`WSPR ${this.state.wspr_band} · ${count} cells${mode}${condition}`, width - 16 * scale, bounds.bottom + (height - bounds.bottom) / 2);
    this.canvas.dataset.timestamp = displayTime.toISOString();
  }
}

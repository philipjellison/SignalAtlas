import { centerLongitudeFor, latitudeToY, longitudeToX, maidenheadToCoordinates, mapVerticalBounds } from "./map.js";

export function utcOffsetLabel(offset) {
  if (offset === 0) return "UTC";
  return `UTC${offset > 0 ? "+" : ""}${offset}`;
}

export function timezoneMeridians() {
  return Array.from({ length: 24 }, (_, index) => {
    const offset = index - 11;
    return { longitude: offset * 15, offset };
  });
}

export function shackScreenPosition(state, width, height) {
  const shack = maidenheadToCoordinates(state.shack_locator);
  const center = centerLongitudeFor(state);
  return {
    x: longitudeToX(shack.longitude, center, width),
    y: latitudeToY(shack.latitude, height),
    ...shack,
  };
}

export class GeographyOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.state = null;
    this.timezones = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    fetch("/assets/maps/timezones-10m.geojson")
      .then(response => {
        if (!response.ok) throw new Error("Unable to load timezone boundaries");
        return response.json();
      })
      .then(timezones => { this.timezones = timezones; this.render(); })
      .catch(error => console.error(error));
  }

  setState(state) { this.state = state; this.render(); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2, 2560 / rect.width, 1440 / rect.height);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height; this.render();
    }
  }

  render() {
    if (!this.state) return;
    const ctx = this.context; const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    if (this.state.timezone_visible) {
      if (this.state.timezone_style === "political") this.drawPoliticalTimezones();
      else this.drawTimezoneGrid();
    }
    this.drawShackMarker();
  }

  drawTimezoneGrid() {
    const ctx = this.context; const { width, height } = this.canvas;
    const center = centerLongitudeFor(this.state);
    const scale = width / 1920;
    const bounds = mapVerticalBounds(height);
    ctx.save();
    ctx.strokeStyle = "rgba(224, 237, 247, .28)";
    ctx.fillStyle = "rgba(239, 247, 255, .82)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.font = `${Math.max(12, 17 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0, 0, 0, .9)";
    ctx.shadowBlur = 3 * scale;
    for (const { longitude, offset } of timezoneMeridians()) {
      const x = longitudeToX(longitude, center, width);
      ctx.beginPath(); ctx.moveTo(x, bounds.top); ctx.lineTo(x, bounds.bottom); ctx.stroke();
      const labelMargin = 34 * scale;
      const labelX = Math.max(labelMargin, Math.min(width - labelMargin, x));
      ctx.fillText(utcOffsetLabel(offset), labelX, bounds.top + 8 * scale);
    }
    ctx.restore();
  }

  drawPoliticalTimezones() {
    if (!this.timezones) return;
    const ctx = this.context; const { width, height } = this.canvas;
    const center = centerLongitudeFor(this.state);
    const scale = width / 1920;
    const mapBounds = mapVerticalBounds(height);
    const labels = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mapBounds.top, width, mapBounds.bottom - mapBounds.top);
    ctx.clip();
    ctx.strokeStyle = "rgba(235, 244, 252, .52)";
    ctx.lineWidth = Math.max(1, 1.15 * scale);
    for (const feature of this.timezones.features) {
      const polygons = feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates : [feature.geometry.coordinates];
      const places = feature.properties.places || "";
      const labelEligible = places && !/(ocean|sea|antarct)/i.test(places);
      for (const polygon of polygons) {
        const bounds = this.drawProjectedPolygon(polygon, center);
        ctx.stroke();
        if (labelEligible && bounds && bounds.width > 52 * scale && bounds.height > 24 * scale) {
          labels.push({
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            text: feature.properties.utc_format.replace(":00", ""),
            area: bounds.width * bounds.height,
          });
        }
      }
    }
    ctx.fillStyle = "rgba(243, 248, 253, .86)";
    ctx.font = `${Math.max(11, 14 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, .95)"; ctx.shadowBlur = 3 * scale;
    const occupied = [];
    for (const label of labels.sort((a, b) => b.area - a.area)) {
      if (label.x < 24 * scale || label.x > width - 24 * scale) continue;
      if (occupied.some(point => Math.hypot(point.x - label.x, point.y - label.y) < 105 * scale)) continue;
      ctx.fillText(label.text, label.x, label.y);
      occupied.push(label);
    }
    ctx.restore();
  }

  drawProjectedPolygon(rings, center) {
    const ctx = this.context; const { width, height } = this.canvas;
    let primaryBounds = null;
    ctx.beginPath();
    rings.forEach((ring, ringIndex) => {
      let previousLongitude = ring[0][0];
      let unwrappedLongitude = previousLongitude;
      let previousX = null;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      ring.forEach(([longitude, latitude], index) => {
        let delta = longitude - previousLongitude;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (index > 0) unwrappedLongitude += delta;
        let x = (unwrappedLongitude - (center - 180)) / 360 * width;
        while (x < 0) x += width;
        while (x >= width) x -= width;
        const y = latitudeToY(latitude, height);
        if (previousX !== null && Math.abs(x - previousX) > width / 2) ctx.moveTo(x, y);
        else index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        previousLongitude = longitude;
        previousX = x;
      });
      ctx.closePath();
      if (ringIndex === 0 && maxX - minX < width / 2) {
        primaryBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
    });
    return primaryBounds;
  }

  drawShackMarker() {
    const ctx = this.context; const { width, height } = this.canvas;
    const point = shackScreenPosition(this.state, width, height);
    const scale = Math.max(0.75, width / 1920);
    const radius = 7 * scale;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.shadowColor = "rgba(0, 0, 0, .9)";
    ctx.shadowBlur = 5 * scale;
    ctx.fillStyle = "#ffd34e";
    ctx.strokeStyle = "#131c26";
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.arc(0, -radius * 1.35, radius, Math.PI, 0);
    ctx.lineTo(0, radius * 1.3);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.font = `600 ${14 * scale}px system-ui, sans-serif`;
    ctx.textAlign = point.x > width - 140 * scale ? "right" : "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff4bb";
    const labelX = point.x > width - 140 * scale ? -13 * scale : 13 * scale;
    const labelParts = [];
    if (this.state.station_name_visible) labelParts.push(this.state.receiver_callsign);
    if (this.state.maidenhead_visible) labelParts.push(this.state.shack_locator);
    if (labelParts.length > 0) ctx.fillText(labelParts.join(" · "), labelX, -radius * 1.4);
    ctx.restore();
  }
}

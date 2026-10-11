const FULL_CIRCLE = 360;
export const MAP_NORTH_LATITUDE = 75;
export const MAP_SOUTH_LATITUDE = -75;

export function mapVerticalBounds(height) {
  return {
    top: latitudeToY(MAP_NORTH_LATITUDE, height),
    bottom: latitudeToY(MAP_SOUTH_LATITUDE, height),
  };
}

export function normalizeLongitude(longitude) {
  return ((longitude + 180) % FULL_CIRCLE + FULL_CIRCLE) % FULL_CIRCLE - 180;
}

export function longitudeToX(longitude, centerLongitude, width) {
  const leftLongitude = centerLongitude - 180;
  return (((longitude - leftLongitude) % FULL_CIRCLE + FULL_CIRCLE) % FULL_CIRCLE) / FULL_CIRCLE * width;
}

export function latitudeToY(latitude, height) {
  return (90 - latitude) / 180 * height;
}

export function maidenheadToCoordinates(locator) {
  const value = locator.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}[A-X]{2}$/.test(value)) throw new Error("Invalid six-character Maidenhead locator");
  const longitude = -180 + (value.charCodeAt(0) - 65) * 20 + Number(value[2]) * 2 + (value.charCodeAt(4) - 65) / 12 + 1 / 24;
  const latitude = -90 + (value.charCodeAt(1) - 65) * 10 + Number(value[3]) + (value.charCodeAt(5) - 65) / 24 + 1 / 48;
  return { longitude, latitude };
}

export function centerLongitudeFor(state) {
  return state.map_center === "shack" && state.shack_locator ? maidenheadToCoordinates(state.shack_locator).longitude : 0;
}

const palette = ["#f07a32", "#efbd32", "#68bd3f", "#24ad73", "#df5542", "#bd8737", "#e7cf55", "#31a5a0"];

function colorFor(feature) {
  const text = feature.properties.ADM0_A3 || feature.properties.NAME || "country";
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function geometryPolygons(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export class WorldMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.images = {
      natural_earth: new Image(),
      blue_marble: new Image(),
    };
    this.imageSources = {
      natural_earth: "/assets/maps/natural-earth.webp",
      blue_marble: "/assets/maps/blue-marble-january.webp",
    };
    this.countries = null;
    this.state = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    fetch("/assets/maps/countries-50m.geojson").then(response => {
        if (!response.ok) throw new Error("Unable to load country boundaries");
        return response.json();
      }).then(countries => { this.countries = countries; this.render(); })
      .catch(error => this.showError(error.message));
  }

  setState(state) {
    this.state = state;
    const key = state.map_style === "blue_marble" || state.map_style === "blue_marble_lights" ? "blue_marble" : "natural_earth";
    const image = this.images[key];
    if (!image.src) {
      image.src = this.imageSources[key];
      image.decode().then(() => this.render()).catch(error => this.showError(error.message));
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

  render() {
    if (!this.state) return;
    const { context: ctx, canvas } = this;
    const width = canvas.width; const height = canvas.height;
    const center = centerLongitudeFor(this.state);
    const blueMarble = this.state.map_style === "blue_marble" || this.state.map_style === "blue_marble_lights";
    const image = blueMarble ? this.images.blue_marble : this.images.natural_earth;
    if (!image.complete || image.naturalWidth === 0) return;
    ctx.clearRect(0, 0, width, height);

    const normalizedCenter = ((center % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
    const firstX = -normalizedCenter / FULL_CIRCLE * width;
    const bounds = mapVerticalBounds(height);
    const sourceTop = (90 - MAP_NORTH_LATITUDE) / 180 * image.naturalHeight;
    const sourceHeight = (MAP_NORTH_LATITUDE - MAP_SOUTH_LATITUDE) / 180 * image.naturalHeight;
    const filters = {
      political_relief: "saturate(1.2) brightness(1.02) contrast(1.08)",
      natural_earth: "saturate(.9) brightness(.88)",
      blue_marble: "saturate(.95) brightness(.9)",
      blue_marble_lights: "saturate(.95) brightness(.9)",
    };
    ctx.filter = filters[this.state.map_style] || filters.natural_earth;
    ctx.drawImage(image, 0, sourceTop, image.naturalWidth, sourceHeight, firstX, bounds.top, width, bounds.bottom - bounds.top);
    ctx.drawImage(image, 0, sourceTop, image.naturalWidth, sourceHeight, firstX + width, bounds.top, width, bounds.bottom - bounds.top);
    ctx.filter = "none";

    if (this.countries) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, bounds.top, width, bounds.bottom - bounds.top);
      ctx.clip();
      for (const feature of this.countries.features) {
        for (const polygon of geometryPolygons(feature.geometry)) {
          this.drawPolygon(polygon, center, this.state.map_style === "political_relief" ? colorFor(feature) : null);
        }
      }
      ctx.restore();
    }
  }

  drawPolygon(rings, center, fill) {
    const ctx = this.context; const width = this.canvas.width; const height = this.canvas.height;
    for (const shift of [-width, 0, width]) {
      ctx.beginPath();
      for (const ring of rings) {
        let previousLongitude = ring[0][0];
        let unwrappedLongitude = previousLongitude;
        ring.forEach(([longitude, latitude], index) => {
          let delta = longitude - previousLongitude;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          if (index > 0) unwrappedLongitude += delta;
          const x = (unwrappedLongitude - (center - 180)) / 360 * width + shift;
          const y = latitudeToY(latitude, height);
          index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          previousLongitude = longitude;
        });
        ctx.closePath();
      }
      if (fill) { ctx.globalAlpha = 0.8; ctx.fillStyle = fill; ctx.fill("evenodd"); }
      ctx.globalAlpha = fill ? 0.86 : 0.48;
      ctx.strokeStyle = fill ? "#1a2430" : "#dbe8ef";
      ctx.lineWidth = Math.max(0.7, width / 3200);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  showError(message) {
    const ctx = this.context;
    ctx.fillStyle = "#08111f"; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#ffcf66"; ctx.font = "24px system-ui"; ctx.fillText(message, 30, 50);
  }
}

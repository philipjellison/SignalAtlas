import { centerLongitudeFor, mapVerticalBounds } from "./map.js";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const CIVIL_TWILIGHT_SINE = Math.sin(-6 * DEG_TO_RAD);

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeLongitude(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

export function solarPosition(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
  const century = (julianDay - 2_451_545) / 36_525;
  const meanLongitude = normalizeDegrees(280.46646 + century * (36_000.76983 + century * 0.0003032));
  const meanAnomaly = 357.52911 + century * (35_999.05029 - 0.0001537 * century);
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const anomalyRadians = meanAnomaly * DEG_TO_RAD;
  const equationOfCenter = Math.sin(anomalyRadians) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(2 * anomalyRadians) * (0.019993 - 0.000101 * century)
    + Math.sin(3 * anomalyRadians) * 0.000289;
  const apparentLongitude = meanLongitude + equationOfCenter - 0.00569
    - 0.00478 * Math.sin((125.04 - 1934.136 * century) * DEG_TO_RAD);
  const meanObliquity = 23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * century) * DEG_TO_RAD);
  const declination = Math.asin(Math.sin(obliquity * DEG_TO_RAD) * Math.sin(apparentLongitude * DEG_TO_RAD)) * RAD_TO_DEG;

  const y = Math.tan(obliquity * DEG_TO_RAD / 2) ** 2;
  const longitudeRadians = meanLongitude * DEG_TO_RAD;
  const equationOfTime = 4 * RAD_TO_DEG * (y * Math.sin(2 * longitudeRadians)
    - 2 * eccentricity * Math.sin(anomalyRadians)
    + 4 * eccentricity * y * Math.sin(anomalyRadians) * Math.cos(2 * longitudeRadians)
    - 0.5 * y * y * Math.sin(4 * longitudeRadians)
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * anomalyRadians));
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()
    + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60_000;
  const longitude = normalizeLongitude((720 - utcMinutes - equationOfTime) / 4);
  return { declination, longitude, equationOfTime };
}

export function solarElevation(latitude, longitude, sun) {
  const latitudeRadians = latitude * DEG_TO_RAD;
  const declinationRadians = sun.declination * DEG_TO_RAD;
  const hourAngle = (longitude - sun.longitude) * DEG_TO_RAD;
  const sine = Math.sin(latitudeRadians) * Math.sin(declinationRadians)
    + Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sine))) * RAD_TO_DEG;
}

export function darknessAlpha(elevation, mode, intensity) {
  if (mode === "hard") return elevation < 0 ? intensity : 0;
  if (elevation >= 0) return 0;
  if (elevation <= -6) return intensity;
  const blend = -elevation / 6;
  return intensity * blend * blend * (3 - 2 * blend);
}

export function darknessAlphaFromSine(sineElevation, mode, intensity) {
  if (mode === "hard") return sineElevation < 0 ? intensity : 0;
  if (sineElevation >= 0) return 0;
  if (sineElevation <= CIVIL_TWILIGHT_SINE) return intensity;
  const elevation = Math.asin(Math.max(-1, sineElevation)) * RAD_TO_DEG;
  return darknessAlpha(elevation, mode, intensity);
}

export class TerminatorOverlay {
  constructor(canvas, clock = () => new Date()) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.clock = clock;
    this.state = null;
    this.mask = document.createElement("canvas");
    // A 2K source mask keeps the curved cutoff smooth when expanded to 4K,
    // while avoiding the memory cost of a second full-resolution 4K canvas.
    this.mask.width = 2048;
    this.mask.height = 1024;
    this.maskContext = this.mask.getContext("2d");
    this.maskImage = this.maskContext.createImageData(this.mask.width, this.mask.height);
    for (let offset = 0; offset < this.maskImage.data.length; offset += 4) {
      this.maskImage.data[offset] = 1;
      this.maskImage.data[offset + 1] = 5;
      this.maskImage.data[offset + 2] = 18;
    }
    this.worker = new Worker("/assets/astronomy-worker.js");
    this.workerBusy = false;
    this.pendingRender = null;
    this.renderId = 0;
    this.worker.addEventListener("message", event => this.receiveMask(event.data));
    this.lights = document.createElement("canvas");
    this.lightsContext = this.lights.getContext("2d");
    this.nightImage = new Image();
    this.nightReady = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }

  setState(state) {
    this.state = state;
    if (state.map_style === "blue_marble_lights" && !this.nightImage.src) {
      this.nightImage.src = "/assets/maps/black-marble-2016.webp";
      this.nightImage.decode()
        .then(() => { this.nightReady = true; this.render(); })
        .catch(error => console.error("Unable to load night-lights map", error));
    }
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2, 2560 / rect.width, 1440 / rect.height);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.lights.width = width; this.lights.height = height;
      this.render();
    }
  }

  render(timestamp = this.clock()) {
    if (!this.state) return;
    const sun = solarPosition(timestamp);
    const center = centerLongitudeFor(this.state);
    const request = {
      id: ++this.renderId,
      width: this.mask.width,
      height: this.mask.height,
      center,
      sun,
      mode: this.state.terminator_mode,
      intensity: this.state.night_intensity,
      timestamp: timestamp.toISOString(),
    };
    if (this.workerBusy) {
      this.pendingRender = request;
      return;
    }
    this.startMask(request);
  }

  startMask(request) {
    this.workerBusy = true;
    this.worker.postMessage(request);
  }

  receiveMask(result) {
    this.workerBusy = false;
    if (this.pendingRender) {
      const request = this.pendingRender;
      this.pendingRender = null;
      this.startMask(request);
      return;
    }
    const data = this.maskImage.data;
    for (let index = 0, alphaOffset = 3; index < result.alphas.length; index += 1, alphaOffset += 4) {
      data[alphaOffset] = result.alphas[index];
    }
    this.maskContext.putImageData(this.maskImage, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Keep the solar cutoff mathematically hard, but antialias the mask as it is
    // scaled to the display resolution. This avoids stair-stepping at 1080p/4K.
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
    const bounds = mapVerticalBounds(this.canvas.height);
    const sourceTop = this.mask.height / 12;
    const sourceHeight = this.mask.height * 5 / 6;
    this.context.drawImage(
      this.mask,
      0, sourceTop, this.mask.width, sourceHeight,
      0, bounds.top, this.canvas.width, bounds.bottom - bounds.top,
    );
    if (this.state.map_style === "blue_marble_lights" && this.nightReady) {
      this.drawNightLights(result.center, bounds, sourceTop, sourceHeight);
    }
    this.canvas.dataset.timestamp = result.timestamp;
  }

  drawNightLights(center, bounds, maskTop, maskHeight) {
    const ctx = this.lightsContext;
    const width = this.lights.width;
    const height = this.lights.height;
    const normalizedCenter = ((center % 360) + 360) % 360;
    const firstX = -normalizedCenter / 360 * width;
    const sourceTop = this.nightImage.naturalHeight / 12;
    const sourceHeight = this.nightImage.naturalHeight * 5 / 6;
    ctx.clearRect(0, 0, width, height);
    ctx.filter = "brightness(1.2) saturate(1.15)";
    ctx.drawImage(this.nightImage, 0, sourceTop, this.nightImage.naturalWidth, sourceHeight, firstX, bounds.top, width, bounds.bottom - bounds.top);
    ctx.drawImage(this.nightImage, 0, sourceTop, this.nightImage.naturalWidth, sourceHeight, firstX + width, bounds.top, width, bounds.bottom - bounds.top);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "destination-in";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.mask, 0, maskTop, this.mask.width, maskHeight, 0, bounds.top, width, bounds.bottom - bounds.top);
    ctx.globalCompositeOperation = "source-over";

    // Replace the darkened daytime surface with the actual nighttime composite.
    // The mask alpha preserves the configured intensity and twilight transition.
    this.context.save();
    this.context.globalCompositeOperation = "source-over";
    this.context.drawImage(this.lights, 0, 0);
    this.context.restore();
  }
}

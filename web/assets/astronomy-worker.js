const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const CIVIL_TWILIGHT_SINE = Math.sin(-6 * DEG_TO_RAD);

let cachedHeight = 0;
let latitudeSines;
let latitudeCosines;

function prepareLatitudes(height) {
  if (height === cachedHeight) return;
  cachedHeight = height;
  latitudeSines = new Float64Array(height);
  latitudeCosines = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    const latitude = (90 - (y + 0.5) / height * 180) * DEG_TO_RAD;
    latitudeSines[y] = Math.sin(latitude);
    latitudeCosines[y] = Math.cos(latitude);
  }
}

function alphaFor(sineElevation, mode, intensity) {
  if (mode === "hard") return sineElevation < 0 ? intensity : 0;
  if (sineElevation >= 0) return 0;
  if (sineElevation <= CIVIL_TWILIGHT_SINE) return intensity;
  const elevation = Math.asin(Math.max(-1, sineElevation)) * RAD_TO_DEG;
  const blend = -elevation / 6;
  return intensity * blend * blend * (3 - 2 * blend);
}

self.addEventListener("message", event => {
  const { id, width, height, center, sun, mode, intensity, timestamp } = event.data;
  prepareLatitudes(height);
  const declination = sun.declination * DEG_TO_RAD;
  const sinDeclination = Math.sin(declination);
  const cosDeclination = Math.cos(declination);
  const longitudeCosines = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const longitude = center - 180 + (x + 0.5) / width * 360;
    longitudeCosines[x] = Math.cos((longitude - sun.longitude) * DEG_TO_RAD);
  }

  const alphas = new Uint8ClampedArray(width * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const latitudeTerm = latitudeSines[y] * sinDeclination;
    const longitudeScale = latitudeCosines[y] * cosDeclination;
    for (let x = 0; x < width; x += 1) {
      const sineElevation = latitudeTerm + longitudeScale * longitudeCosines[x];
      alphas[offset] = Math.round(alphaFor(sineElevation, mode, intensity) * 255);
      offset += 1;
    }
  }
  self.postMessage({ id, timestamp, center, alphas }, [alphas.buffer]);
});

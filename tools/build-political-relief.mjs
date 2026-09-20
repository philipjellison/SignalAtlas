import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const mapRoot = path.join(projectRoot, "web/assets/maps");
const countries = JSON.parse(fs.readFileSync(path.join(mapRoot, "countries-50m.geojson"), "utf8"));
const palette = ["#f07a32", "#efbd32", "#68bd3f", "#24ad73", "#df5542", "#bd8737", "#e7cf55", "#31a5a0"];
const temporarySvg = "/tmp/geochron-political-overlay.svg";
const temporaryPng = "/tmp/geochron-political-overlay.png";

function colorFor(feature) {
  const text = feature.properties.ADM0_A3 || feature.properties.NAME || "country";
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function polygons(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function ringPath(ring, shift) {
  let previous = ring[0][0];
  let longitude = previous;
  return ring.map(([nextLongitude, latitude], index) => {
    if (index > 0) {
      let delta = nextLongitude - previous;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      longitude += delta;
    }
    previous = nextLongitude;
    return `${index === 0 ? "M" : "L"}${(longitude + shift).toFixed(4)},${(-latitude).toFixed(4)}`;
  }).join("") + "Z";
}

const paths = [];
for (const feature of countries.features) {
  for (const polygon of polygons(feature.geometry)) {
    for (const shift of [-360, 0, 360]) {
      paths.push(`<path d="${polygon.map(ring => ringPath(ring, shift)).join("")}" fill="${colorFor(feature)}"/>`);
    }
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048" viewBox="-180 -90 360 180" preserveAspectRatio="none"><g fill-rule="evenodd" fill-opacity="0.58">${paths.join("")}</g></svg>`;
fs.writeFileSync(temporarySvg, svg);
execFileSync("magick", ["-background", "none", temporarySvg, temporaryPng]);
execFileSync("magick", [path.join(mapRoot, "natural-earth.webp"), temporaryPng, "-compose", "over", "-composite", "-quality", "88", path.join(mapRoot, "political-relief.webp")]);
console.log("Generated web/assets/maps/political-relief.webp");

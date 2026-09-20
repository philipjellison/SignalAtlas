export function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function solarFixedEarthLongitude(relativeLongitude, subsolarLongitude) {
  return normalizeLongitude(relativeLongitude + subsolarLongitude);
}

export function shouldDrawFrame(previousTime, currentTime, targetFps = 30) {
  return previousTime === null || currentTime - previousTime >= 1000 / targetFps;
}

export function textureCoordinates(relativeLongitude, latitude, subsolarLongitude) {
  const earthLongitude = solarFixedEarthLongitude(relativeLongitude, subsolarLongitude);
  return {
    u: ((earthLongitude + 180) / 360 + 1) % 1,
    v: (90 - latitude) / 180,
  };
}

export function timezoneSegments(geojson, minimumDistance = 0.15) {
  const segments = [];
  for (const feature of geojson.features || []) {
    const polygons = feature.geometry?.type === "MultiPolygon"
      ? feature.geometry.coordinates
      : feature.geometry?.type === "Polygon" ? [feature.geometry.coordinates] : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        let previous = ring[0];
        for (let index = 1; previous && index < ring.length; index += 1) {
          const current = ring[index];
          const longitudeDistance = Math.min(Math.abs(current[0] - previous[0]), 360 - Math.abs(current[0] - previous[0]));
          if (index === ring.length - 1 || Math.hypot(longitudeDistance, current[1] - previous[1]) >= minimumDistance) {
            segments.push(previous[0], previous[1], current[0], current[1]);
            previous = current;
          }
        }
      }
    }
  }
  return new Float32Array(segments);
}

export function solarFixedScreenPosition(longitude, latitude, subsolarLongitude) {
  return {
    x: (normalizeLongitude(longitude - subsolarLongitude) + 180) / 360,
    y: (75 - latitude) / 150,
  };
}

export function politicalTimezoneLabels(geojson) {
  const labels = [];
  for (const feature of geojson.features || []) {
    const places = feature.properties?.places || "";
    if (!places || /(ocean|sea|antarct)/i.test(places)) continue;
    const polygons = feature.geometry?.type === "MultiPolygon"
      ? feature.geometry.coordinates
      : feature.geometry?.type === "Polygon" ? [feature.geometry.coordinates] : [];
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring?.length) continue;
      let previous = ring[0][0];
      let longitude = previous;
      let minimumLongitude = longitude;
      let maximumLongitude = longitude;
      let minimumLatitude = ring[0][1];
      let maximumLatitude = ring[0][1];
      for (let index = 1; index < ring.length; index += 1) {
        let delta = ring[index][0] - previous;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        longitude += delta;
        minimumLongitude = Math.min(minimumLongitude, longitude);
        maximumLongitude = Math.max(maximumLongitude, longitude);
        minimumLatitude = Math.min(minimumLatitude, ring[index][1]);
        maximumLatitude = Math.max(maximumLatitude, ring[index][1]);
        previous = ring[index][0];
      }
      const width = maximumLongitude - minimumLongitude;
      const height = maximumLatitude - minimumLatitude;
      if (width <= 9.75 || width >= 180 || height <= 3.75) continue;
      labels.push({
        longitude: normalizeLongitude((minimumLongitude + maximumLongitude) / 2),
        latitude: Math.max(-70, Math.min(70, (minimumLatitude + maximumLatitude) / 2)),
        text: feature.properties.utc_format.replace(":00", ""),
        area: width * height,
      });
    }
  }
  return labels.sort((first, second) => second.area - first.area);
}

export function mapLayout(viewportWidth, viewportHeight, stretch) {
  const height = stretch ? viewportHeight : Math.min(viewportHeight, viewportWidth / 2);
  return { width: viewportWidth, height, top: (viewportHeight - height) / 2 };
}

export function centerLongitude(state, subsolarLongitude, shackLongitude) {
  if (state.map_center === "terminator") return subsolarLongitude;
  if (state.map_center === "shack") return shackLongitude;
  return 0;
}

export function timezoneLabelVerticalOffset(style, text, latitude, viewportHeight) {
  if (style === "idealized") return 20 * viewportHeight / 1080;
  const shouldLowerPolitical = style === "political"
    && latitude > 60 && (text === "UTC-12" || text === "UTC±00");
  return shouldLowerPolitical ? 10 * viewportHeight / 1080 : 0;
}

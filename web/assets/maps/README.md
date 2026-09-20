# Map assets

- `natural-earth.webp` is an optimized 4096×2048 derivative of Natural Earth II with Shaded Relief and Water, version 3.2.0.
- `political-relief.webp` is a generated 4096×2048 derivative combining that relief raster with the public-domain country geometry and the application's cartographic palette. Rebuild it with `tools/build-political-relief.mjs`.
- `blue-marble-january.webp` is an optimized 4096×2048 derivative of NASA Earth Observatory's Blue Marble: Next Generation January composite with topography and bathymetry. Source: <https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/>.
- `black-marble-2016.webp` is an optimized 4096×2048 derivative of NASA Earth Observatory's 2016 Earth at Night color composite. It is revealed through the astronomical night mask only by the separate Blue Marble + night lights style. Source: <https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/>.
- `countries-50m.geojson` is Natural Earth 1:50m Admin 0 Countries data from the Natural Earth vector repository.
- `timezones-10m.geojson` is Natural Earth 1:10m Time Zones data, version 4.0.0, from the Natural Earth vector repository. It is a cartographic UTC-offset dataset rather than a live IANA/DST rules database.

Natural Earth raster and vector data are in the public domain. Project information and terms: <https://www.naturalearthdata.com/about/terms-of-use/>.

NASA content is generally not subject to copyright in the United States. NASA is acknowledged as the source; its identifiers are not used and no endorsement is implied. Usage guidelines: <https://www.nasa.gov/nasa-brand-center/images-and-media/>.

The political-relief Canvas style applies country color at runtime; the WebGL prototype uses the equivalent precomposited texture to avoid triangulating country fills every frame. The reference photographs in the project root are not application assets and are not served to clients.

import { fromUrl } from 'geotiff';

const BASE_URL = 'https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com';
const YEAR = 2021;
const VERSION = 'v200';

// Composite tiles are 1x1 degree. NDVI is 10m (12000 px), SWIR is 20m (6000 px).
const NDVI_PX = 12000;
const SWIR_PX = 6000;

// Window searched around the coordinate (in degrees) ~= 1km radius.
const SEARCH_DEG = 0.01;

const tiffCache = new Map();
const failedTiles = new Set();

/**
 * 1x1 degree tile code for a coordinate, e.g. N30E075.
 */
function tileCode1(lat, lon) {
  const latT = Math.floor(lat);
  const lonT = Math.floor(lon);
  const latS = latT >= 0 ? `N${String(latT).padStart(2, '0')}` : `S${String(Math.abs(latT)).padStart(2, '0')}`;
  const lonS = lonT >= 0 ? `E${String(lonT).padStart(3, '0')}` : `W${String(Math.abs(lonT)).padStart(3, '0')}`;
  return `${latS}${lonS}`;
}

async function loadTile(kind, lat, lon) {
  const code = tileCode1(lat, lon);
  const key = `${kind}:${code}`;
  if (tiffCache.has(key)) return tiffCache.get(key);
  if (failedTiles.has(key)) throw new Error(`No ${kind} composite tile for ${code}`);

  const folder = kind === 'ndvi' ? 'ndvi' : 'swir';
  const suffix = kind === 'ndvi' ? 'NDVI' : 'SWIR';
  const latBand = (Math.floor(lat) >= 0 ? 'N' : 'S') + String(Math.abs(Math.floor(lat))).padStart(2, '0');
  const url = `${BASE_URL}/${folder}/${YEAR}/${latBand}/ESA_WorldCover_10m_${YEAR}_${VERSION}_${code}_${suffix}.tif`;

  const tiff = await fromUrl(url);
  const image = await tiff.getImage();

  const cached = { image, bbox: image.getBoundingBox() }; // [west, south, east, north]
  tiffCache.set(key, cached);
  return cached;
}

/**
 * Reads the NDVI percentiles at (lat, lon).
 * Bands: [p90, p50, p10], value = -1 + raw * 0.008, range roughly -1..1.
 * Returns { p90, p50, p10 } or null when unavailable.
 */
async function readNdvi(lat, lon) {
  try {
    const { image, bbox } = await loadTile('ndvi', lat, lon);
    const pxPerDeg = image.getWidth() / (bbox[2] - bbox[0]);
    const half = Math.round(SEARCH_DEG * pxPerDeg);
    const col0 = Math.floor((lon - bbox[0]) * pxPerDeg);
    const row0 = Math.floor((bbox[3] - lat) * pxPerDeg);
    const win = [
      Math.max(0, col0 - half),
      Math.max(0, row0 - half),
      Math.min(image.getWidth(), col0 + half + 1),
      Math.min(image.getHeight(), row0 + half + 1),
    ];
    const data = await image.readRasters({ window: win, samples: [0, 1, 2] });

    const valid = (arr) => arr.filter((v) => v >= 0 && v <= 250);
    const p90s = valid(data[0]);
    const p50s = valid(data[1]);
    const p10s = valid(data[2]);

    const median = (arr) =>
      arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;

    const cone = (raw) => (raw == null ? null : -1 + raw * 0.008);
    return { p90: cone(median(p90s)), p50: cone(median(p50s)), p10: cone(median(p10s)) };
  } catch (err) {
    console.warn(`[WorldCover] NDVI read failed for (${lat}, ${lon}): ${err.message}`);
    failedTiles.add(`ndvi:${tileCode1(lat, lon)}`);
    return null;
  }
}

/**
 * Reads SWIR bands at (lat, lon). Bands: [B12, B11], value = raw * 0.004 (0..1).
 * Returns { b12, b11 } or null when unavailable. Lower SWIR = wetter.
 */
async function readSwir(lat, lon) {
  try {
    const { image, bbox } = await loadTile('swir', lat, lon);
    const pxPerDeg = image.getWidth() / (bbox[2] - bbox[0]);
    const half = Math.round(SEARCH_DEG * pxPerDeg);
    const col0 = Math.floor((lon - bbox[0]) * pxPerDeg);
    const row0 = Math.floor((bbox[3] - lat) * pxPerDeg);
    const win = [
      Math.max(0, col0 - half),
      Math.max(0, row0 - half),
      Math.min(image.getWidth(), col0 + half + 1),
      Math.min(image.getHeight(), row0 + half + 1),
    ];
    const data = await image.readRasters({ window: win, samples: [0, 1] });

    const valid = (arr) => arr.filter((v) => v >= 0 && v <= 250);
    const b12s = valid(data[0]);
    const b11s = valid(data[1]);

    const median = (arr) =>
      arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;

    const toRef = (raw) => (raw == null ? null : raw * 0.004);
    return { b12: toRef(median(b12s)), b11: toRef(median(b11s)) };
  } catch (err) {
    console.warn(`[WorldCover] SWIR read failed for (${lat}, ${lon}): ${err.message}`);
    failedTiles.add(`swir:${tileCode1(lat, lon)}`);
    return null;
  }
}

const clamp01 = (v) => (v == null ? null : Math.max(0, Math.min(1, v)));

/**
 * Classifies fuel moisture/dryness and a fire fuel-type label for a coordinate.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{fuel_cat: string|null, class_code: number|null}|null} land - result of getWorldCoverContext
 * @returns {Promise<{moisture: string, fuel_type: string, dryness_index: number, metrics: object}|null>}
 */
export async function getFuelContext(lat, lon, land) {
  const [ndvi, swir] = await Promise.all([readNdvi(lat, lon), readSwir(lat, lon)]);

  // Dryness combines "not green" (low NDVI p10) with "dry" (high SWIR B12).
  // Higher value = drier/lower vegetation moisture.
  const ndviGreen = clamp01(ndvi ? ndvi.p10 : null); // 0 = bare, 1 = lush
  const swirDry = clamp01(swir ? swir.b12 * 3 : null); // 0 = wet, 1 = dry

  let dryness = null;
  if (ndviGreen != null || swirDry != null) {
    const g = ndviGreen != null ? ndviGreen : 0.5;
    const s = swirDry != null ? swirDry : 0.5;
    dryness = clamp01(-g * 0.6 + s * 0.6 + 0.3);
  }

  let moisture = 'unknown';
  if (dryness != null) {
    if (dryness > 0.7) moisture = 'dry';
    else if (dryness > 0.4) moisture = 'moderate';
    else moisture = 'moist';
  }

  const fuel_cat = land?.fuel_cat || null;
  let fuel_type = 'Unknown';
  if (fuel_cat) {
    const note = moisture === 'dry'
      ? 'high spread, low persistence'
      : moisture === 'moist'
        ? 'slow spread, high persistence'
        : 'moderate spread';
    switch (fuel_cat) {
      case 'forest':
        fuel_type = `Forest fire (${note})`;
        break;
      case 'grassland':
        fuel_type = `Grass fire (${note})`;
        break;
      case 'shrubland':
        fuel_type = `Shrub fire (${note})`;
        break;
      case 'crop':
        fuel_type = `Cropland / agricultural burn (${note})`;
        break;
      case 'built':
        fuel_type = 'Non-fuel (built-up)';
        break;
      case 'water':
        fuel_type = 'Non-fuel (water)';
        break;
      case 'bare':
        fuel_type = 'Sparse / non-fuel (bare)';
        break;
      case 'wetland':
        fuel_type = 'Wetland (low fire risk)';
        break;
      case 'snow':
        fuel_type = 'Non-fuel (snow / ice)';
        break;
      case 'moss':
        fuel_type = 'Vegetated moss / lichen';
        break;
      default:
        fuel_type = 'Unknown';
    }
  }

  const metrics = {};
  if (ndvi) metrics.ndvi = { p90: round(ndvi.p90), p50: round(ndvi.p50), p10: round(ndvi.p10) };
  if (swir) metrics.swir = { b12: round(swir.b12), b11: round(swir.b11) };

  return { moisture, fuel_type, dryness_index: round(dryness), metrics };
}

function round(v) {
  return v == null ? null : Math.round(v * 1000) / 1000;
}

export default getFuelContext;

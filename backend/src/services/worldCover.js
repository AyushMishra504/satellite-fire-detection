import { fromUrl } from 'geotiff';

const BASE_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
const YEAR = 2021;
const VERSION = 'v200';
const TILE_DEG = 3;
const PIXELS_PER_TILE = 36000;
const DEG_PER_PIXEL = TILE_DEG / PIXELS_PER_TILE; // 0.0001 deg/pixel (~10m)

// Window searched around the coordinate (in degrees) => ~3.5km radius.
const SEARCH_DEG = 0.03;

const tiffCache = new Map();
const failedTiles = new Set();

// ESA WorldCover class values (v200) -> human label.
const LABELS = {
  10: 'Tree cover',
  20: 'Shrubland',
  30: 'Grassland',
  40: 'Cropland',
  50: 'Built-up',
  60: 'Bare / sparse vegetation',
  70: 'Snow and ice',
  80: 'Permanent water bodies',
  90: 'Herbaceous wetland',
  95: 'Mangroves',
  100: 'Moss and lichen',
};

// Coarse grouping used for fire fuel-type classification.
const FUEL_CAT = {
  10: 'forest',
  20: 'shrubland',
  30: 'grassland',
  40: 'crop',
  50: 'built',
  60: 'bare',
  70: 'snow',
  80: 'water',
  90: 'wetland',
  95: 'forest',
  100: 'moss',
};

/**
 * Computes an ESA WorldCover 3x3 degree tile code (lower-left corner) for a
 * given latitude/longitude, e.g. N18E072.
 */
function tileCode(lat, lon) {
  const latT = Math.floor(lat / TILE_DEG) * TILE_DEG;
  const lonT = Math.floor(lon / TILE_DEG) * TILE_DEG;
  return coordCode(latT, lonT);
}

function coordCode(latT, lonT) {
  const latS = latT >= 0 ? `N${String(latT).padStart(2, '0')}` : `S${String(Math.abs(latT)).padStart(2, '0')}`;
  const lonS = lonT >= 0 ? `E${String(lonT).padStart(3, '0')}` : `W${String(Math.abs(lonT)).padStart(3, '0')}`;
  return `${latS}${lonS}`;
}

/**
 * Fetches a COG from S3 (cached in-memory per tile code) and returns the
 * decoded GeoTIFF image plus its bounding box.
 *
 * Throws when the tile cannot be retrieved (missing tile for a given region or
 * an S3/network failure). Callers are expected to handle this gracefully.
 */
async function loadTile(lat, lon) {
  const code = tileCode(lat, lon);
  if (tiffCache.has(code)) return tiffCache.get(code);
  if (failedTiles.has(code)) {
    throw new Error(`No ESA WorldCover tile available for ${code}`);
  }

  const url = `${BASE_URL}/${VERSION}/${YEAR}/map/ESA_WorldCover_10m_${YEAR}_${VERSION}_${code}_Map.tif`;
  const tiff = await fromUrl(url);
  const image = await tiff.getImage();

  const cached = { image, bbox: image.getBoundingBox() }; // [west, south, east, north]
  tiffCache.set(code, cached);
  return cached;
}

const UNKNOWN = 'Unknown';

/**
 * Determines the dominant land type at (lat, lon). Reads a small window around
 * the coordinate, classifies the closest WorldCover pixel, and returns the
 * full 11-class label plus a coarse fuel category.
 *
 * @returns {Promise<{land_type: string, class_code: number|null, fuel_cat: string|null}>}
 */
export async function getWorldCoverContext(lat, lon) {
  let image;
  let bbox;
  try {
    ({ image, bbox } = await loadTile(lat, lon));
  } catch (err) {
    console.warn(`[WorldCover] Failed to load tile for (${lat}, ${lon}): ${err.message}`);
    failedTiles.add(tileCode(lat, lon));
    return { land_type: UNKNOWN, class_code: null, fuel_cat: null };
  }

  const west = bbox[0];
  const north = bbox[3];

  const centerCol = (lon - west) / DEG_PER_PIXEL;
  const centerRow = (north - lat) / DEG_PER_PIXEL;

  const halfPixels = Math.round(SEARCH_DEG / DEG_PER_PIXEL);
  const col0 = Math.max(0, Math.floor(centerCol - halfPixels));
  const col1 = Math.min(image.getWidth() - 1, Math.ceil(centerCol + halfPixels));
  const row0 = Math.max(0, Math.floor(centerRow - halfPixels));
  const row1 = Math.min(image.getHeight() - 1, Math.ceil(centerRow + halfPixels));

  if (col1 < col0 || row1 < row0) {
    return { land_type: UNKNOWN, class_code: null, fuel_cat: null };
  }

  const window = [col0, row0, col1 + 1, row1 + 1];
  const data = await image.readRasters({ window, samples: [0] });
  const values = data[0];

  const width = col1 - col0 + 1;
  const pixelKM = (r, c) => {
    const pxLon = west + (col0 + c) * DEG_PER_PIXEL;
    const pxLat = north - (row0 + r) * DEG_PER_PIXEL;
    const dLat = (pxLat - lat) * 111.32;
    const dLon = (pxLon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  };

  // Find closest pixel that has a valid class label.
  let closestCode = null;
  let closestKM = Infinity;

  for (let r = 0; r < row1 - row0 + 1; r++) {
    for (let c = 0; c < width; c++) {
      const v = values[r * width + c];
      if (!(v in LABELS)) continue;
      const km = pixelKM(r, c);
      if (km < closestKM) {
        closestKM = km;
        closestCode = v;
      }
    }
  }

  if (closestCode === null) {
    return { land_type: UNKNOWN, class_code: null, fuel_cat: null };
  }

  // If the closest tracked pixel is within 50m use its exact label, otherwise
  // signal it as nearby.
  const label = closestKM <= 0.05 ? LABELS[closestCode] : `Near: ${LABELS[closestCode]}`;

  return {
    land_type: label,
    class_code: closestCode,
    fuel_cat: FUEL_CAT[closestCode] || null,
  };
}

export { LABELS, FUEL_CAT };

export default getWorldCoverContext;

import { getWorldCoverContext } from './worldCover.js';
import { getFuelContext } from './worldCoverComposites.js';
import { getCachedContext, setCachedContext } from '../db/geoCache.js';

const inFlightContexts = new Map();

const CACHE_SCHEMA_VERSION = 2;

/**
 * Retrieves enriched ground context for a given (lat, lon) coordinate using ESA
 * WorldCover 10m land-cover plus the NDVI/SWIR composite layers for fuel
 * moisture/type.
 *
 * Uses 2 decimal places rounding (~1.1km cell) and persistent SQLite cache.
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<{land_type: string, fuel: {moisture: string, fuel_type: string, dryness_index: number|null}}>}
 */
async function resolveOsmContext(lat, lon) {
  const latKey = Math.round(lat * 100) / 100;
  const lonKey = Math.round(lon * 100) / 100;

  console.log(`[OSM Context] cache miss (${latKey}, ${lonKey}). Querying ESA WorldCover...`);

  // Phase A: 11-class land cover + fuel category.
  let land = { land_type: 'Unknown', class_code: null, fuel_cat: null };
  try {
    land = await getWorldCoverContext(lat, lon);
  } catch (err) {
    console.warn(`[OSM Context] WorldCover failed for (${lat}, ${lon}): ${err.message}`);
  }

  // Phase B: NDVI + SWIR composite -> fuel moisture / type.
  let fuel = { moisture: 'unknown', fuel_type: 'Unknown', dryness_index: null };
  try {
    const fc = await getFuelContext(lat, lon, land);
    if (fc) {
      fuel = {
        moisture: fc.moisture,
        fuel_type: fc.fuel_type,
        dryness_index: fc.dryness_index,
        metrics: fc.metrics,
      };
    }
  } catch (err) {
    console.warn(`[OSM Context] Fuel context failed for (${lat}, ${lon}): ${err.message}`);
  }

  const result = {
    _v: CACHE_SCHEMA_VERSION,
    land_type: land.land_type,
    fuel,
  };

  setCachedContext(latKey, lonKey, result);

  return result;
}

export async function getOsmContext(lat, lon) {
  const latKey = Math.round(lat * 100) / 100;
  const lonKey = Math.round(lon * 100) / 100;
  const cacheKey = `${latKey},${lonKey}`;

  const cachedResult = getCachedContext(latKey, lonKey);
  if (cachedResult) return cachedResult;

  if (!inFlightContexts.has(cacheKey)) {
    const pending = resolveOsmContext(lat, lon).finally(() => {
      inFlightContexts.delete(cacheKey);
    });
    inFlightContexts.set(cacheKey, pending);
  }

  return inFlightContexts.get(cacheKey);
}

export default getOsmContext;

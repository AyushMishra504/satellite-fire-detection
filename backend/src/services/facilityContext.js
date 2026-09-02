/**
 * Nearest critical-infrastructure lookup for a detection coordinate.
 * Mirrors the style of osmContext.js / worldCover.js in this codebase.
 *
 * Feeds the risk score: a fire near a hospital/fire station should
 * outrank an identical fire in the middle of nowhere.
 */

import Database from 'better-sqlite3'; // DB-LIB SPECIFIC - match your geoCache.js
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'geo_context.db');
const db = new Database(DB_PATH, { readonly: true });

// Haversine distance in km.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bounding-box prefilter (cheap, index-friendly) before exact haversine.
// 1 degree lat ~= 111km, so this widens the box based on the search radius.
const searchStmt = db.prepare(`
  SELECT type, name, lat, lon
  FROM facilities
  WHERE lat BETWEEN ? AND ?
    AND lon BETWEEN ? AND ?
`);

/**
 * Nearest facility per category (e.g. { medical: ['hospital','clinic'], fire_station: ['fire_station'] }),
 * computed in a single DB fetch + single scan over candidates.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} maxKm
 * @param {Object<string, string[]>} categories - category name -> list of `type` values it covers
 * @returns {Object<string, object|null>} - one result per category key
 */
function getNearestByCategory(lat, lon, maxKm, categories) {
  const degPad = maxKm / 111;

  const candidates = searchStmt.all(
    lat - degPad,
    lat + degPad,
    lon - degPad,
    lon + degPad
  );

  // Build a reverse lookup: facility type -> category name, so each
  // candidate row is classified in O(1) instead of re-scanning per category.
  const typeToCategory = {};
  for (const [category, types] of Object.entries(categories)) {
    for (const t of types) typeToCategory[t] = category;
  }

  const nearest = {};
  const nearestKm = {};
  for (const category of Object.keys(categories)) {
    nearest[category] = null;
    nearestKm[category] = Infinity;
  }

  for (const c of candidates) {
    const category = typeToCategory[c.type];
    if (!category) continue; // facility type we don't care about

    const km = distanceKm(lat, lon, c.lat, c.lon);
    if (km <= maxKm && km < nearestKm[category]) {
      nearestKm[category] = km;
      nearest[category] = c;
    }
  }

  const result = {};
  for (const category of Object.keys(categories)) {
    const c = nearest[category];
    result[category] = c
      ? { type: c.type, name: c.name, distance_km: Math.round(nearestKm[category] * 100) / 100 }
      : null;
  }
  return result;
}

/**
 * Returns nearest medical facility (hospital OR clinic, whichever is
 * closer) and nearest fire station, separately, so callers can show
 * "both", "one", or "neither" rather than a single blended result.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} maxKm - default 10km
 * @returns {{ medical: object|null, fire_station: object|null }}
 */
export function getFacilitySummary(lat, lon, maxKm = 10) {
  return getNearestByCategory(lat, lon, maxKm, {
    medical: ['hospital', 'clinic'],
    fire_station: ['fire_station'],
  });
}

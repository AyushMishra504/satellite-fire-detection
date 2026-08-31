import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path at backend/geo_context.db
const DB_PATH = path.resolve(__dirname, '../../geo_context.db');

export const db = new Database(DB_PATH);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS osm_context_cache (
    lat_key REAL,
    lon_key REAL,
    context_json TEXT,
    fetched_at TEXT,
    PRIMARY KEY(lat_key, lon_key)
  )
`);

// Cache TTL: composite/land-cover data is seasonal, so a week is generous while
// keeping pre-loaded background data reasonably fresh.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Bumped whenever the cached payload shape changes, forcing stale rows out.
const CACHE_SCHEMA_VERSION = 2;

// Prepared statements for high performance
const selectStmt = db.prepare(
  'SELECT context_json, fetched_at FROM osm_context_cache WHERE lat_key = ? AND lon_key = ?'
);

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO osm_context_cache (lat_key, lon_key, context_json, fetched_at)
  VALUES (?, ?, ?, ?)
`);

/**
 * Retrieves cached context object from SQLite if present.
 * @param {number} latKey - Rounded latitude key
 * @param {number} lonKey - Rounded longitude key
 * @returns {Object|null} Parsed context object or null if not found
 */
export function getCachedContext(latKey, lonKey) {
  try {
    const row = selectStmt.get(latKey, lonKey);
    if (!row || !row.context_json) {
      return null;
    }
    const parsed = JSON.parse(row.context_json);

    // Shape change guard: rows from an older schema are ignored and refetched.
    if (!parsed || parsed._v !== CACHE_SCHEMA_VERSION) {
      return null;
    }

    // TTL guard.
    if (row.fetched_at) {
      const fetched = new Date(row.fetched_at).getTime();
      if (!Number.isNaN(fetched) && Date.now() - fetched > CACHE_TTL_MS) {
        return null;
      }
    }

    return parsed;
  } catch (err) {
    console.error(`[GeoCache] Error reading cache for (${latKey}, ${lonKey}):`, err.message);
    return null;
  }
}

/**
 * Stores context object into SQLite cache.
 * @param {number} latKey - Rounded latitude key
 * @param {number} lonKey - Rounded longitude key
 * @param {Object} contextObj - Context data object to cache
 */
export function setCachedContext(latKey, lonKey, contextObj) {
  try {
    const contextJson = JSON.stringify(contextObj);
    const fetchedAt = new Date().toISOString();
    insertStmt.run(latKey, lonKey, contextJson, fetchedAt);
  } catch (err) {
    console.error(`[GeoCache] Error saving cache for (${latKey}, ${lonKey}):`, err.message);
  }
}

export default {
  db,
  getCachedContext,
  setCachedContext,
};

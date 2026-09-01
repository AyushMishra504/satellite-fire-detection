import { db } from './geoCache.js';

// ---------------------------------------------------------------------------
// Persistent Thermal Source Tracker
//
// Tracks every hotspot by a ~1km geocell and keeps a *history of dates* it has
// been detected on. Because we backfill from FIRMS history (see
// backfillFromFirmsHistory), a source that has been burning for a week does NOT
// look like "day 1" when the app first comes online.
// ---------------------------------------------------------------------------

// Number of historical days to backfill on bootstrap (matches the FIRMS day-
// range we query for history). Used for the activity ratio denominator.
export const BACKFILL_WINDOW_DAYS = 10;

// A hotspot at the same 2-decimal rounded lat/lon (~1.1km cell) is treated as
// the same persistent source.
export function geocell(lat, lon) {
  return [Math.round(Number(lat) * 100) / 100, Math.round(Number(lon) * 100) / 100];
}

// A source is considered "persistent" when detected on this many distinct days.
export const PERSISTENT_THRESHOLD = 2;

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Ensure the table exists FIRST so the prepared statements below can be created.
db.exec(`
  CREATE TABLE IF NOT EXISTS thermal_sources (
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    seen_dates TEXT NOT NULL DEFAULT '[]',
    frp_by_date TEXT NOT NULL DEFAULT '{}',
    avg_frp REAL,
    max_frp REAL,
    first_seen TEXT,
    last_seen TEXT,
    PRIMARY KEY (lat, lon)
  )
`);

// Prepared statements
const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO thermal_sources (lat, lon, seen_dates, frp_by_date, avg_frp, max_frp, first_seen, last_seen)
  VALUES (@lat, @lon, @seenDates, @frpByDate, @avgFrp, @maxFrp, @firstSeen, @lastSeen)
`);

const selectGeocellStmt = db.prepare(
  'SELECT lat, lon, seen_dates, frp_by_date, avg_frp, max_frp, first_seen, last_seen FROM thermal_sources WHERE lat = ? AND lon = ?'
);

const selectAllStmt = db.prepare(
  'SELECT lat, lon, seen_dates, frp_by_date, avg_frp, max_frp, first_seen, last_seen FROM thermal_sources'
);

/**
 * Records one day's detections into the persistent source table.
 *
 * Groups hotspots by geocell and merges the (date -> FRP) history so the same
 * source seen across multiple days accumulates correctly.
 *
 * @param {Array<{latitude:number, longitude:number, frp:number}>} detections
 * @param {string} [dateStr] - YYYY-MM-DD. Defaults to today.
 */
export function recordDetections(detections, dateStr = todayStr()) {
  if (!Array.isArray(detections) || detections.length === 0) return 0;

  let updated = 0;
  // Aggregate per geocell first so we do one DB write per cell.
  const groups = new Map();

  for (const d of detections) {
    const lat = Number(d.latitude);
    const lon = Number(d.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const [gLat, gLon] = geocell(lat, lon);
    const key = `${gLat},${gLon}`;
    const frp = Number.isFinite(Number(d.frp)) ? Number(d.frp) : 0;
    const entry = groups.get(key) || { lat: gLat, lon: gLon, frp: 0 };
    entry.frp = Math.max(entry.frp, frp); // keep max FRP for the day
    groups.set(key, entry);
  }

  const tx = db.transaction(() => {
    for (const entry of groups.values()) {
      const row = selectGeocellStmt.get(entry.lat, entry.lon);

      let seenDates = [];
      let frpByDate = {};
      let avgFrp = entry.frp;
      let maxFrp = entry.frp;
      let firstSeen = dateStr;
      let lastSeen = dateStr;

      if (row) {
        seenDates = JSON.parse(row.seen_dates || '[]');
        frpByDate = JSON.parse(row.frp_by_date || '{}');
        avgFrp = row.avg_frp == null ? entry.frp : row.avg_frp;
        maxFrp = row.max_frp == null ? entry.frp : row.max_frp;
        firstSeen = row.first_seen || dateStr;
      }

      // Add date if not present.
      if (!seenDates.includes(dateStr)) {
        seenDates.push(dateStr);
        seenDates.sort();
      }
      // Store this day's max FRP.
      frpByDate[dateStr] = Math.max(frpByDate[dateStr] || 0, entry.frp);

      // Rolling mean/max of FRP.
      const frpValues = Object.values(frpByDate);
      avgFrp = frpValues.reduce((a, b) => a + b, 0) / frpValues.length;
      maxFrp = Math.max(...frpValues);

      insertStmt.run({
        lat: entry.lat,
        lon: entry.lon,
        seenDates: JSON.stringify(seenDates),
        frpByDate: JSON.stringify(frpByDate),
        avgFrp,
        maxFrp,
        firstSeen,
        lastSeen: dateStr > (row?.last_seen || '') ? dateStr : (row?.last_seen || dateStr),
      });
      updated++;
    }
  });

  tx();
  return updated;
}

/**
 * Reads the accumulated persistence for a coordinate.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {null|{
 *   lat:number, lon:number,
 *   persistence_days:number,
 *   activity_ratio:number,
 *   first_seen:string, last_seen:string,
 *   avg_frp:number, max_frp:number,
 *   frp_trend:number|null
 * }}
 */
export function getPersistence(lat, lon) {
  const [gLat, gLon] = geocell(lat, lon);
  const row = selectGeocellStmt.get(gLat, gLon);
  if (!row) return null;

  return summarizeRow(row);
}

/**
 * Returns all tracked persistent sources (for the /api/sources endpoint and for
 * pre-computing the industrial-distance / classification features).
 */
export function getAllSources() {
  return selectAllStmt.all().map(summarizeRow);
}

function summarizeRow(row) {
  const seenDates = JSON.parse(row.seen_dates || '[]');
  const frpByDate = JSON.parse(row.frp_by_date || '{}');

  const persistenceDays = seenDates.length;
  // Fraction of the backfill window this source was active (0..1).
  const activityRatio = Math.min(1, persistenceDays / BACKFILL_WINDOW_DAYS);

  // FRP trend: latest recorded day vs. the mean of all earlier days. Positive =
  // intensifying, negative = fading, null = not enough history.
  let frpTrend = null;
  const dates = Object.keys(frpByDate).sort();
  if (dates.length >= 2) {
    const latest = frpByDate[dates[dates.length - 1]];
    const earlier = dates.slice(0, -1).map((d) => frpByDate[d]);
    const earlierMean = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    frpTrend = Math.round((latest - earlierMean) * 100) / 100;
  }

  return {
    lat: row.lat,
    lon: row.lon,
    persistence_days: persistenceDays,
    activity_ratio: Math.round(activityRatio * 100) / 100,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    avg_frp: Math.round((row.avg_frp || 0) * 100) / 100,
    max_frp: Math.round((row.max_frp || 0) * 100) / 100,
    frp_trend: frpTrend,
    seen_dates: seenDates,
    frp_by_date: frpByDate,
    is_persistent: persistenceDays >= PERSISTENT_THRESHOLD,
  };
}

export default {
  geocell,
  recordDetections,
  getPersistence,
  getAllSources,
  BACKFILL_WINDOW_DAYS,
};

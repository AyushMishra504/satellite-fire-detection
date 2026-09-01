import { getHistoricalDetections } from './firmsService.js';
import { recordDetections, BACKFILL_WINDOW_DAYS } from '../db/sourceCache.js';
import { db } from '../db/geoCache.js';

// ---------------------------------------------------------------------------
// Persistence bootstrap + upkeep.
//
// The persistence tracker only accumulates what it *sees*. To avoid a source
// that has burned for a week looking like "day 1", we seed history from FIRMS
// on startup (backfill), then keep it current with the daily ingest.
// ---------------------------------------------------------------------------

// Small meta table to remember whether/when we backfilled, so we do it once.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
const getMetaStmt = db.prepare('SELECT value FROM app_meta WHERE key = ?');
const setMetaStmt = db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)');

export function hasBackfilled() {
  const row = getMetaStmt.get('persistence_backfilled_at');
  return Boolean(row && row.value);
}

/**
 * Seeds the persistence table with up to `days` days of FIRMS history so that
 * persistent sources are recognised from the moment the app comes online.
 *
 * Historic FIRMS returns all days in one CSV, so we bucket rows by their
 * acq_date and record each day into the date-set.
 *
 * @param {number} [days=BACKFILL_WINDOW_DAYS]
 * @returns {Promise<{ok:boolean, days:number, cells:number, error?:string}>}
 */
export async function backfillPersistence(days = BACKFILL_WINDOW_DAYS) {
  // Fail gracefully if no API key yet (won't crash startup).
  if (!process.env.MAP_KEY) {
    return { ok: false, days: 0, cells: 0, error: 'MAP_KEY not configured; persistence backfill skipped' };
  }

  try {
    const { data } = await getHistoricalDetections(days);

    // Bucket by acq_date.
    const byDate = new Map();
    for (const d of data) {
      const date = d.acq_date;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(d);
    }

    let cells = 0;
    for (const [date, dets] of byDate.entries()) {
      cells += recordDetections(dets, date);
    }

    setMetaStmt.run('persistence_backfilled_at', new Date().toISOString());
    return { ok: true, days: byDate.size, cells, backfillWindow: BACKFILL_WINDOW_DAYS };
  } catch (err) {
    console.warn(`[Persistence] Backfill failed: ${err.message}`);
    return { ok: false, days: 0, cells: 0, error: err.message };
  }
}

/**
 * Records the current day's detections (called after the normal FIRMS fetch).
 */
export function recordCurrent(detections) {
  try {
    const updated = recordDetections(detections);
    return { updated };
  } catch (err) {
    console.warn(`[Persistence] recordCurrent failed: ${err.message}`);
    return { updated: 0, error: err.message };
  }
}

/**
 * Startup sequence: re-sync FIRMS history (the query window always ends at
 * today, so this records any new days since the last run), then record the
 * current day's detections when provided.
 *
 * The history window is re-fetched on every boot rather than gated by
 * `hasBackfilled()`: a long-running server — or a restart a day later — must
 * not silently stop ingesting new days into the persistence tracker.
 */
export async function runPersistenceBootstrap(currentDetections) {
  const backfillResult = await backfillPersistence();

  if (Array.isArray(currentDetections) && currentDetections.length > 0) {
    recordCurrent(currentDetections);
  }

  return backfillResult;
}

export default { backfillPersistence, recordCurrent, runPersistenceBootstrap, hasBackfilled };

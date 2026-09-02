/**
 * Loads data/facilities.json (from fetchFacilities.js) into the SAME
 * SQLite DB your geoCache already uses (geo_context.db), as a new
 * `facilities` table.
 *
 * Run once after fetchFacilities.js:
 *   node scripts/importFacilities.js
 *
 * NOTE: assumes better-sqlite3, since your existing geoCache.js calls
 * (getCachedContext/setCachedContext) are used without await -> sync API.
 * If your project actually uses a different SQLite lib, swap the three
 * lines marked "DB-LIB SPECIFIC" below and the rest stays the same.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3'; // DB-LIB SPECIFIC

// Point this at the SAME db file geoCache.js opens. Adjust the relative
// path if your backend root differs.
const DB_PATH = path.join(process.cwd(), 'geo_context.db');

function amenityLabel(tags) {
  if (!tags) return 'unknown';
  return tags.amenity || 'unknown';
}

function main() {
  const rawPath = path.join(process.cwd(), 'data', 'facilities.json');
  if (!fs.existsSync(rawPath)) {
    throw new Error(`${rawPath} not found. Run fetchFacilities.js first.`);
  }

  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const elements = raw.elements || [];

  const db = new Database(DB_PATH); // DB-LIB SPECIFIC

  db.exec(`
    CREATE TABLE IF NOT EXISTS facilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osm_id INTEGER,
      type TEXT NOT NULL,        -- 'hospital' | 'clinic' | 'fire_station'
      name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL
    );
  `);

  // Coarse spatial index: bucket by ~0.1 degree (~11km) cell so lookups
  // can prefilter with a simple WHERE instead of scanning every row.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facilities_cell
    ON facilities (lat, lon);
  `);

  const insert = db.prepare(`
    INSERT INTO facilities (osm_id, type, name, lat, lon)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });

  const rows = [];
  for (const el of elements) {
    // Nodes have lat/lon directly; ways/relations need the "center" from
    // `out center` in the Overpass query.
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    rows.push([
      el.id ?? null,
      amenityLabel(el.tags),
      el.tags?.name || null,
      lat,
      lon,
    ]);
  }

  insertMany(rows);
  console.log(`[importFacilities] Inserted ${rows.length} facilities into ${DB_PATH}`);

  const counts = db.prepare(`SELECT type, COUNT(*) as n FROM facilities GROUP BY type`).all();
  console.table(counts);

  db.close();
}

main();

// One-time batch fetch: pull industrial infrastructure sites across India from
// the OpenStreetMap Overpass API and store them as a static local layer.
//
//   node scripts/fetch-industrial.js
//
// Split India into ~10-12 state-sized bounding boxes so no single Overpass query
// times out on a country-wide around: search. Results are normalized to
// {lat, lon, category, name} and inserted into the industrial_sites table in
// geo_context.db. This is a manual, one-time script — NOT part of the live
// request path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { db } from '../src/db/geoCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overpass endpoints, tried in order. The default overpass-api.de instance is
// frequently unreachable from some networks, so fall back to mirrors.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const USER_AGENT =
  'SIH-IndustrialFire-Watch/1.0 (satellite-thermal-event-classifier; contact: dev@example.com) +Axios';

// Server-side Overpass timeout must be generous for dense boxes; axios's own
// timeout must be HIGHER than Overpass's so we always receive a real (even if
// empty) Overpass response rather than a premature axios timeout that is
// indistinguishable from "genuinely no data".
const OVERPASS_TIMEOUT_S = 90;
const AXIOS_TIMEOUT_MS = 120 * 1000;

// ~1s pause between bbox requests — same public Overpass instance.
const RATE_LIMIT_MS = 1000;

// India split into ~10-12 state-sized bounding boxes. Bounds are approximate.
const BBOXES = [
  { name: 'jammu-kashmir-hp', west: 72.0, south: 30.0, east: 81.5, north: 37.2 },
  { name: 'punjab-haryana', west: 74.0, south: 28.5, east: 78.0, north: 32.6 },
  { name: 'rajasthan', west: 69.0, south: 23.0, east: 78.2, north: 30.2 },
  { name: 'delhi-up', west: 76.5, south: 25.0, east: 84.3, north: 30.5 },
  { name: 'gujarat', west: 68.1, south: 20.0, east: 74.5, north: 24.7 },
  { name: 'madhya-pradesh', west: 74.0, south: 21.0, east: 82.6, north: 26.9 },
  { name: 'bihar-jharkhand', west: 83.0, south: 21.5, east: 88.0, north: 27.5 },
  { name: 'west-bengal-odisha', west: 84.0, south: 17.0, east: 89.6, north: 27.2 },
  { name: 'maharashtra', west: 72.5, south: 15.5, east: 80.4, north: 22.2 },
  { name: 'telangana-ap', west: 77.0, south: 12.0, east: 84.9, north: 20.5 },
  { name: 'karnataka', west: 74.0, south: 11.5, east: 78.6, north: 18.3 },
  { name: 'tamil-nadu-kerala', west: 74.8, south: 8.0, east: 80.4, north: 13.9 },
  { name: 'northeast', west: 88.0, south: 21.5, east: 97.4, north: 29.5 },
];

function buildQuery(bb) {
  const { south, west, north, east } = bb;
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];
(
  node["industrial"](${south},${west},${north},${east});
  way["industrial"](${south},${west},${north},${east});
  way["landuse"="industrial"](${south},${west},${north},${east});
  way["landuse"="quarry"](${south},${west},${north},${east});
  way["landuse"="mine"](${south},${west},${north},${east});
  node["power"~"^(plant|generator|substation)$"](${south},${west},${north},${east});
  way["power"~"^(plant|generator|substation)$"](${south},${west},${north},${east});
  node["man_made"~"^(works|flare|storage_tank|petroleum_well)$"](${south},${west},${north},${east});
  way["man_made"~"^(works|flare|storage_tank|petroleum_well)$"](${south},${west},${north},${east});
);
out center;`;
}

// Category priority: first match wins. Note industrial=power|energy and
// power=plant|generator|substation are ALTERNATIVE matches that both feed the
// same "power_plant" category — checked as siblings, not sequential rungs
// where one shadows the other.
function categorize(tags) {
  const industrial = tags.industrial;
  const power = tags.power;
  const landuse = tags.landuse;
  const man_made = tags.man_made;

  if (typeof industrial === 'string' && /^(oil|petroleum|refinery)$/i.test(industrial)) {
    return 'refinery';
  }
  if (typeof power === 'string' && /^(plant|generator|substation)$/i.test(power)) {
    return 'power_plant';
  }
  if (typeof industrial === 'string' && /^(power|energy)$/i.test(industrial)) {
    return 'power_plant';
  }
  if (typeof industrial === 'string' && /^(steel|metal)$/i.test(industrial)) {
    return 'steel';
  }
  if (landuse === 'quarry' || landuse === 'mine') {
    return 'mining';
  }
  if (man_made === 'flare') {
    return 'flare';
  }
  if (typeof industrial === 'string' && /^(oil_gas)$/i.test(industrial)) {
    return 'oil_gas';
  }
  if (man_made === 'petroleum_well') {
    return 'oil_gas';
  }
  if (landuse === 'industrial' || typeof industrial === 'string') {
    return 'other_industrial';
  }
  return 'other_industrial';
}

function elementLocation(el) {
  // Nodes have direct lat/lon; ways/relations use `center` (from out center).
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lon: el.lon };
  }
  const c = el.center;
  if (c && typeof c.lat === 'number' && typeof c.lon === 'number') {
    return { lat: c.lat, lon: c.lon };
  }
  return null;
}

async function fetchBbox(bb) {
  const q = buildQuery(bb);
  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const resp = await axios.post(url, new URLSearchParams({ data: q }), {
        timeout: AXIOS_TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      if (resp.status !== 200) {
        lastErr = new Error(`HTTP ${resp.status} on ${url}`);
        continue;
      }
      return resp.data?.elements || [];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('all Overpass endpoints failed');
}

function dedupe(sites) {
  const seen = new Map();
  for (const s of sites) {
    const key = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, s);
    } else if (!existing.name && s.name) {
      // Prefer the one with a non-null name.
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS industrial_sites (
    lat REAL,
    lon REAL,
    category TEXT,
    name TEXT,
    PRIMARY KEY(lat, lon)
  )`);
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(',').map((s) => s.trim()) : null;

  ensureTable();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO industrial_sites (lat, lon, category, name) VALUES (?, ?, ?, ?)',
  );

  const boxes = only ? BBOXES.filter((b) => only.includes(b.name)) : BBOXES;
  if (only) {
    const missing = only.filter((n) => !BBOXES.some((b) => b.name === n));
    if (missing.length) {
      console.log(`Unknown bbox(es): ${missing.join(', ')} — aborting.`);
      process.exit(1);
    }
  }

  const allSites = [];
  const failed = [];

  for (const bb of boxes) {
    let elements;
    try {
      process.stdout.write(`[${bb.name}] querying... `);
      elements = await fetchBbox(bb);
    } catch (err) {
      process.stdout.write(`FAILED ${err.message}\n`);
      failed.push(bb.name);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
      continue;
    }

    let added = 0;
    for (const el of elements) {
      const loc = elementLocation(el);
      if (!loc) continue;
      const category = categorize(el.tags || {});
      const name = el.tags?.name || null;
      allSites.push({ lat: loc.lat, lon: loc.lon, category, name });
      added++;
    }
    process.stdout.write(`${added} raw elements\n`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  const unique = dedupe(allSites);
  const tx = db.transaction((rows) => {
    for (const s of rows) insert.run(s.lat, s.lon, s.category, s.name);
  });
  tx(unique);

  const byCat = {};
  for (const s of unique) byCat[s.category] = (byCat[s.category] || 0) + 1;

  const total = db.prepare('SELECT COUNT(*) AS c FROM industrial_sites').get().c;

  console.log('\n=== Summary ===');
  console.log(`Sites inserted this run: ${unique.length} (total in table: ${total})`);
  console.log('By category:');
  for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${n}`);
  }

  if (failed.length) {
    console.log('\nFailed bboxes (re-run just these later):');
    for (const f of failed) console.log(`  ${f}`);
  } else {
    console.log('\nAll bboxes succeeded.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

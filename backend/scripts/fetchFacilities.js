/**
 * ONE-TIME Overpass extract of critical infrastructure over India.
 * Run this once locally, save the output, then never call Overpass again
 * at runtime. This is what keeps it "static dataset", not "live OSM query".
 *
 * All of India in a single query overloads the free public instances
 * (504/500 gateway timeouts) — so this splits the bbox into a grid of
 * smaller regional chunks and queries them one at a time, pausing between
 * requests to stay within fair-use limits, then merges the results.
 *
 * Usage:
 *   node scripts/fetchFacilities.js
 *
 * Output:
 *   data/facilities.json  (merged elements from all chunks)
 */

import fs from 'fs';
import path from 'path';

// Overall India bbox, same region as firmsService.js AREA = '68,6,97,37'
// (west,south,east,north). Overpass bbox format is (south,west,north,east).
const SOUTH = 6;
const WEST = 68;
const NORTH = 37;
const EAST = 97;

// 3 lat bands x 3 lon bands = 9 smaller queries instead of 1 giant one.
// Each chunk is small enough for a free instance to finish well under
// its gateway timeout. Increase LAT_STEPS/LON_STEPS if a chunk still
// times out (smaller area = faster).
const LAT_STEPS = 3;
const LON_STEPS = 3;

function buildChunks() {
  const chunks = [];
  const latSize = (NORTH - SOUTH) / LAT_STEPS;
  const lonSize = (EAST - WEST) / LON_STEPS;

  for (let i = 0; i < LAT_STEPS; i++) {
    for (let j = 0; j < LON_STEPS; j++) {
      const south = SOUTH + i * latSize;
      const north = SOUTH + (i + 1) * latSize;
      const west = WEST + j * lonSize;
      const east = WEST + (j + 1) * lonSize;
      chunks.push(`${south},${west},${north},${east}`);
    }
  }
  return chunks;
}

// Kept deliberately narrow: hospitals + fire stations are the highest-value,
// lowest-volume categories for a risk score. Add "school" back in later
// only if you have time to test/tune it separately — it's a much bigger set.
function buildQuery(bbox) {
  return `
[out:json][timeout:60];
(
  node["amenity"="hospital"](${bbox});
  way["amenity"="hospital"](${bbox});
  node["amenity"="clinic"](${bbox});
  node["amenity"="fire_station"](${bbox});
  way["amenity"="fire_station"](${bbox});
);
out center tags;
`;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Fallback mirrors if the primary instance keeps failing on a given chunk.
const FALLBACK_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryOverpass(url, query) {
  const body = new URLSearchParams({ data: query });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'SIH-FireDetection/1.0 (student project; one-time data pull)',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function queryChunkWithFallback(bbox, chunkLabel) {
  const query = buildQuery(bbox);
  const urls = [OVERPASS_URL, ...FALLBACK_URLS];
  let lastErr;

  for (const url of urls) {
    try {
      const data = await queryOverpass(url, query);
      console.log(`[fetchFacilities] ${chunkLabel} OK via ${url} (${data.elements?.length || 0} elements)`);
      return data.elements || [];
    } catch (err) {
      console.warn(`[fetchFacilities] ${chunkLabel} failed on ${url}: ${err.message}`);
      lastErr = err;
    }
  }

  console.error(`[fetchFacilities] ${chunkLabel} FAILED on all endpoints, skipping. (${lastErr?.message})`);
  return [];
}

async function main() {
  const chunks = buildChunks();
  console.log(`[fetchFacilities] Querying ${chunks.length} regional chunks (this can take a few minutes)...`);

  const allElements = [];
  for (let i = 0; i < chunks.length; i++) {
    const label = `chunk ${i + 1}/${chunks.length} (${chunks[i]})`;
    console.log(`[fetchFacilities] ${label} ...`);
    const elements = await queryChunkWithFallback(chunks[i], label);
    allElements.push(...elements);

    // Be polite to the free public instances between requests.
    if (i < chunks.length - 1) await sleep(2000);
  }

  // Dedupe by OSM id (a way that straddles two chunk boundaries can
  // otherwise show up twice).
  const seen = new Set();
  const deduped = allElements.filter((el) => {
    if (seen.has(el.id)) return false;
    seen.add(el.id);
    return true;
  });

  console.log(`[fetchFacilities] Total unique elements: ${deduped.length} (raw: ${allElements.length})`);

  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'facilities.json');
  fs.writeFileSync(outPath, JSON.stringify({ elements: deduped }, null, 2));

  console.log(`[fetchFacilities] Saved to ${outPath}`);
  console.log('[fetchFacilities] Next: node scripts/importFacilities.js');
}

main().catch((err) => {
  console.error('[fetchFacilities] Failed:', err.message);
  process.exit(1);
});

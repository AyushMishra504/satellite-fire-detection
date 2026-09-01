import axios from 'axios';
import Papa from 'papaparse';
import dotenv from 'dotenv';

dotenv.config();

// In-memory cache storage
let cache = {
  data: null,
  lastUpdated: null,
};

// Configuration constants
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SOURCE = 'VIIRS_NOAA20_NRT';
const AREA = '68,6,97,37'; // India bounding box
const DAY_RANGE = 1;

// FIRMS area API caps DAY_RANGE at 5 per request. See:
// https://firms.modaps.eosdis.nasa.gov/api/area  ("DAY_RANGE: 1 .. 5")
export const MAX_DAY_RANGE = 5;

/**
 * Fetches raw FIRMS CSV for the area with a given day range and returns the
 * cleaned detection array (shared by the cached daily fetch and the history
 * backfill). Does NOT touch the in-memory cache.
 *
 * @param {number} dayRange - how many days to request (1..MAX_DAY_RANGE)
 * @param {string} [date] - optional start date YYYY-MM-DD for historical queries
 * @returns {Promise<Array<object>>} cleaned detections, each with an acq_date
 */
async function fetchFirmsRaw(dayRange, date) {
  const mapKey = process.env.MAP_KEY;
  if (!mapKey) {
    const error = new Error('NASA FIRMS MAP_KEY is not configured in backend environment.');
    error.status = 500;
    throw error;
  }

  const base = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${SOURCE}/${AREA}/${dayRange}`;
  const url = date ? `${base}/${date}` : base;

  let response;
  try {
    response = await axios.get(url, {
      timeout: 20000,
      responseType: 'text',
    });
  } catch (err) {
    const errorMessage = err.response
      ? `NASA FIRMS API returned status ${err.response.status}: ${err.response.statusText || 'Bad response'}`
      : `Failed to reach NASA FIRMS API: ${err.message}`;

    const customErr = new Error(errorMessage);
    customErr.status = 502; // Bad Gateway
    customErr.originalError = err.message;
    throw customErr;
  }

  // Parse CSV response
  const rawCsv = response.data;
  if (!rawCsv || typeof rawCsv !== 'string') {
    const customErr = new Error('NASA FIRMS returned empty or invalid CSV payload.');
    customErr.status = 502;
    throw customErr;
  }

  if (rawCsv.trim().startsWith('Invalid') || rawCsv.trim().startsWith('Error')) {
    const customErr = new Error(`NASA FIRMS API error: ${rawCsv.trim()}`);
    customErr.status = 502;
    throw customErr;
  }

  const parsed = Papa.parse(rawCsv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
    const customErr = new Error(`Failed to parse FIRMS CSV data: ${parsed.errors[0].message}`);
    customErr.status = 502;
    throw customErr;
  }

  return parsed.data
    .filter((row) => {
      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);
      return !isNaN(lat) && !isNaN(lon) && row.acq_date;
    })
    .map((row) => ({
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      bright_ti4: row.bright_ti4 ? parseFloat(row.bright_ti4) : null,
      scan: row.scan ? parseFloat(row.scan) : null,
      track: row.track ? parseFloat(row.track) : null,
      acq_date: row.acq_date,
      acq_time: String(row.acq_time || '').padStart(4, '0'),
      satellite: row.satellite || '',
      instrument: row.instrument || '',
      confidence: row.confidence || '',
      version: row.version || '',
      bright_ti5: row.bright_ti5 ? parseFloat(row.bright_ti5) : null,
      frp: row.frp ? parseFloat(row.frp) : 0,
      daynight: row.daynight || '',
    }));
}

/**
 * Fetches and parses active thermal anomalies from NASA FIRMS.
 * Uses 15-minute in-memory cache to prevent redundant external API calls.
 */
export async function getDetections(forceRefresh = false) {
  const now = Date.now();

  // Return cached data if still fresh
  if (!forceRefresh && cache.data && cache.lastUpdated && now - cache.lastUpdated.getTime() < CACHE_TTL_MS) {
    return {
      cached: true,
      lastUpdated: cache.lastUpdated.toISOString(),
      count: cache.data.length,
      data: cache.data,
    };
  }

  const cleanedData = await fetchFirmsRaw(DAY_RANGE);

  // Update in-memory cache
  cache = {
    data: cleanedData,
    lastUpdated: new Date(),
  };

  return {
    cached: false,
    lastUpdated: cache.lastUpdated.toISOString(),
    count: cleanedData.length,
    data: cleanedData,
  };
}

// UTC date helpers (FIRMS uses YYYY-MM-DD).
function toUTCDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/**
 * Fetches `days` days of FIRMS history (bypasses the 15-min cache) so the
 * persistence tracker can backfill real history on bootstrap. Each returned
 * detection carries its own acq_date for per-day bucketing.
 *
 * FIRMS caps DAY_RANGE per request at MAX_DAY_RANGE (5), so the requested window
 * is fetched in <=5-day chunks anchored on explicit start dates:
 *   /api/area/csv/{key}/{src}/{area}/{chunkDays}/{startDate}
 *
 * @param {number} [days=10] how many days of history to request
 */
export async function getHistoricalDetections(days = 10) {
  const total = Math.max(1, Math.min(31, Number(days) || 10));
  const today = new Date();

  const chunks = [];
  let cursor = addDays(today, -(total - 1));
  while (cursor <= today) {
    const remaining = Math.min(MAX_DAY_RANGE, total - chunks.length * MAX_DAY_RANGE);
    const startDate = toUTCDateStr(cursor);
    chunks.push(fetchFirmsRaw(remaining, startDate));
    cursor = addDays(cursor, remaining);
  }

  const results = await Promise.all(chunks);
  const data = results.flat();
  return { count: data.length, data };
}

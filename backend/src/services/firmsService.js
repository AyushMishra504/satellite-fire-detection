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

  const mapKey = process.env.MAP_KEY;
  if (!mapKey) {
    const error = new Error('NASA FIRMS MAP_KEY is not configured in backend environment.');
    error.status = 500;
    throw error;
  }

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${SOURCE}/${AREA}/${DAY_RANGE}`;

  let response;
  try {
    response = await axios.get(url, {
      timeout: 15000,
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

  // FIRMS can sometimes return an error string directly in the body (e.g. "Invalid Map Key" or "Rate limit exceeded")
  if (rawCsv.trim().startsWith('Invalid') || rawCsv.trim().startsWith('Error')) {
    const customErr = new Error(`NASA FIRMS API error: ${rawCsv.trim()}`);
    customErr.status = 502;
    throw customErr;
  }

  const parsed = Papa.parse(rawCsv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // manual typing ensures predictable floats
  });

  if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
    const customErr = new Error(`Failed to parse FIRMS CSV data: ${parsed.errors[0].message}`);
    customErr.status = 502;
    throw customErr;
  }

  // Filter out malformed/incomplete records and sanitize numeric values
  const cleanedData = parsed.data
    .filter((row) => {
      // Must have valid coordinates and date
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

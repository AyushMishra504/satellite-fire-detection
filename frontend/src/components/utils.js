/**
 * Shared utilities for the FIRMS fire detection frontend.
 */

/**
 * Creates a unique ID string for a FIRMS detection hotspot.
 * Used by both App.jsx and FireMap.jsx for marker keying and selection tracking.
 */
export function getHotspotId(detection) {
  return [
    detection.latitude,
    detection.longitude,
    detection.acq_date,
    detection.acq_time,
    detection.satellite,
    detection.instrument,
  ].join('|');
}

/**
 * Returns the geocell key for a detection (rounded to 2 decimal places).
 */
export function getContextKey(detection) {
  return geocellKey(detection.latitude, detection.longitude);
}

/**
 * Returns the canonical geocell key string for a given lat/lon.
 *
 * IMPORTANT: this is the SINGLE key format used for ML prediction cache writes
 * AND reads. It must match what the backend returns for a rounded geocell
 * (always exactly 2 decimals, e.g. "6.46,81.10"). Earlier code diverged here by
 * using `Math.round(...)/100` string concatenation, which drops trailing zeros
 * ("6.46,81.1") and made ~18% of predictions unfindable. Do not switch this to
 * a different formatting without also updating every read/write site.
 */
export function geocellKey(lat, lon) {
  const rLat = Math.round(Number(lat) * 100) / 100;
  const rLon = Math.round(Number(lon) * 100) / 100;
  return `${rLat.toFixed(2)},${rLon.toFixed(2)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Fire type styling (ML) — fill color per predicted fire type.
//
// Class set mirrors the retrained 4-class firetype model. `gas_flare` was
// merged into `industrial_fire` (flares are a subtype), and `unknown` is a
// first-class display bucket (neutral gray) so it shows up instead of hiding
// under active filters.
// ────────────────────────────────────────────────────────────────────────────
export const FIRETYPE_TYPES = [
  'industrial_fire',
  'agricultural_burn',
  'mining_activity',
  'wildfire',
  'unknown',
];

export const FIRETYPE_STYLING = {
  industrial_fire: { color: '#dc2626', label: 'Industrial Fire' },
  gas_flare: { color: '#ea580c', label: 'Gas Flare' }, // legacy merged class, kept defensively
  agricultural_burn: { color: '#d97706', label: 'Agricultural Burn' },
  mining_activity: { color: '#475569', label: 'Mining Activity' },
  wildfire: { color: '#b91c1c', label: 'Wildfire' },
  unknown: { color: '#64748b', label: 'Unknown' },
};

// Marker circumference is driven by the predicted fire type (larger = higher
// hazard / infrastructure risk). Neutral fallback if the type is unknown.
export const FIRETYPE_RADIUS = {
  industrial_fire: 12,
  gas_flare: 11,
  mining_activity: 9,
  wildfire: 8,
  agricultural_burn: 7,
};
export const FIRETYPE_DEFAULT_RADIUS = 8;

// ────────────────────────────────────────────────────────────────────────────
// Persistence risk ring (ML) — restrained neutral/semantic palette.
// ────────────────────────────────────────────────────────────────────────────
export const PERSISTENCE_TYPES = ['short', 'medium', 'long'];

export const PERSISTENCE_RING = {
  short: { color: '#94a3b8', label: 'Short-lived' },
  medium: { color: '#0284c7', label: 'Medium-lived' },
  long: { color: '#d97706', label: 'Long-lived' },
};


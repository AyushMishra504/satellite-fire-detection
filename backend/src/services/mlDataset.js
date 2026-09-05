import { getAllSources, BACKFILL_WINDOW_DAYS } from '../db/sourceCache.js';
import { db } from '../db/geoCache.js';
import { getOsmContext } from './osmContext.js';
import { getIndustrialIndex, INDUSTRIAL_CATEGORIES } from './industrialIndex.js';

// ---------------------------------------------------------------------------
// ML Feature Join
//
// Builds a flat feature vector per persistent geocell by joining:
//   - persistence history (thermal_sources)   -> avg/max FRP, activity, trend
//   - static context (osm_context_cache)      -> land class, dryness, NDVI, SWIR
// Only "history + static" features are used (per user decision: no live FRP, no
// weather, no topography).
//
// Both this builder and the Node ONNX inference MUST produce identical vectors.
// The feature order is codified in ml_features.json written here and read back
// by the inference service.
// ---------------------------------------------------------------------------

// ESA WorldCover label -> numeric class code (for a stable land feature).
const LAND_LABEL_TO_CODE = {
  'Tree cover': 10,
  'Shrubland': 20,
  'Grassland': 30,
  'Cropland': 40,
  'Built-up': 50,
  'Bare / sparse vegetation': 60,
  'Snow and ice': 70,
  'Permanent water bodies': 80,
  'Herbaceous wetland': 90,
  'Mangroves': 95,
  'Moss and lichen': 100,
};

// Stable numeric ordering of features (must match mlInference + train.py).
//
// Feature groups (see ML_RETRAIN_PLAN.md):
//   - FEATURE_NAMES           behavior / fuel-type model  (11 base features)
//   - PERSISTENCE_FEATURES    persistence FORECAST model. Uses only features
//                             available by day 1-2 of a fire (early-window FRP),
//                             NOT full-history FRP and NOT activity_ratio (which
//                             was label leakage — a monotonic transform of the
//                             persistence label).
//   - FIRETYPE_FEATURES       firetype physical-only model. Genuinely
//                             independent of the rule that constructs the label:
//                             FRP stats, persistence days, dryness/NDVI/SWIR.
//                             EXCLUDES rule features (dist_*_km,
//                             nearest_industrial_code, land_type_code).
//   - INDUSTRIAL_FEATURES     rule-features used ONLY to build the label + the
//                             deterministic primary classifier, never fed to the
//                             firetype model.
export const FEATURE_NAMES = [
  'land_type_code',
  'dryness_index',
  'ndvi_p90',
  'ndvi_p50',
  'ndvi_p10',
  'swir_b12',
  'swir_b11',
  'avg_frp',
  'max_frp',
  'activity_ratio',
  'frp_trend',
];

export const PERSISTENCE_FEATURES = [
  'land_type_code',
  'dryness_index',
  'ndvi_p90',
  'ndvi_p50',
  'ndvi_p10',
  'swir_b12',
  'swir_b11',
  'frp_early_avg',
  'frp_early_max',
  'frp_early_trend',
];

export const FIRETYPE_FEATURES = [
  'dryness_index',
  'ndvi_p90',
  'ndvi_p50',
  'ndvi_p10',
  'swir_b12',
  'swir_b11',
  'avg_frp',
  'max_frp',
  'frp_trend',
  'persistence_days',
  'land_type_code',   // ESA WorldCover — remote-sensing data, not a rule feature
  'activity_ratio',   // fraction of backfill window with detections
];

// Industrial proximity (from the static industrial_sites KD-tree layer).
// Rule features — the primary classifier / label construction only.
export const INDUSTRIAL_FEATURES = [
  'dist_refinery_km',
  'dist_power_km',
  'dist_steel_km',
  'dist_mining_km',
  'dist_flare_km',
  'dist_oilgas_km',
  'nearest_industrial_code',
];

// Union of every numeric feature column written to dataset.csv.
export const ALL_FEATURES = [
  ...new Set([
    ...FEATURE_NAMES,
    ...PERSISTENCE_FEATURES,
    ...FIRETYPE_FEATURES,
    ...INDUSTRIAL_FEATURES,
    'persistence_days',
  ]),
];

// Label maps (class index -> human label). These are the contract for both the
// Python label maps and the Node inference output.
export const PERSISTENCE_CLASSES = {
  0: 'short', // 1 day
  1: 'medium', // 2-3 days
  2: 'long', // 4+ days
};

// Behavior classes derived from fire fuel category. `wetland` was merged into
// `other` (single sample — its F1 was meaningless).
export const BEHAVIOR_CATS = ['forest', 'grassland', 'shrubland', 'crop', 'other'];
export const BEHAVIOR_CLASSES = Object.fromEntries(BEHAVIOR_CATS.map((c, i) => [i, c]));

// Fire-type classes (SIH core deliverable: segregate industrial from natural).
// `gas_flare` was merged into `industrial_fire` (flares are a subtype; 4 samples
// made its reported F1 meaningless). `unknown` is the 5th bucket for ambiguous
// cells; it is EXCLUDED from training but kept as a valid live answer.
export const FIRE_TYPE_CATS = [
  'industrial_fire',
  'agricultural_burn',
  'mining_activity',
  'wildfire',
  'unknown',
];
export const FIRE_TYPE_CLASSES = Object.fromEntries(FIRE_TYPE_CATS.map((c, i) => [i, c]));
// Keep the "real" classes (exclude unknown) as the trainable set.
export const FIRE_TYPE_TRAIN = FIRE_TYPE_CATS.filter((c) => c !== 'unknown');

// Stable int code per industrial category (used for nearest_industrial_code).
export const INDUSTRIAL_CODE = Object.fromEntries(
  INDUSTRIAL_CATEGORIES.map((c, i) => [c, i]),
);

// Canonical feature key per category. This MUST round-trip with FEATURE_NAMES:
// the generated keys are exactly the dist_*_km columns expected by the dataset
// header, train.py FIRETYPE_FEATURES, and mlInference.js at runtime.
export const INDUSTRIAL_FEATURE_KEYS = {
  refinery: 'dist_refinery_km',
  power_plant: 'dist_power_km',
  steel: 'dist_steel_km',
  mining: 'dist_mining_km',
  flare: 'dist_flare_km',
  oil_gas: 'dist_oilgas_km',
};

function landTypeToCode(landType) {
  if (!landType) return -1;
  // Strip "Near: " prefix if present.
  const base = String(landType).replace(/^Near:\s*/, '');
  return LAND_LABEL_TO_CODE[base] ?? -1;
}

function deriveBehaviorCat(fuelType) {
  const t = String(fuelType || '').toLowerCase();
  if (t.includes('forest')) return 'forest';
  if (t.includes('grass')) return 'grassland';
  if (t.includes('shrub')) return 'shrubland';
  if (t.includes('crop')) return 'crop';
  return 'other'; // wetland merged into other
}

function persistenceClass(persistenceDays) {
  if (persistenceDays >= 4) return 2; // long
  if (persistenceDays >= 2) return 1; // medium
  return 0; // short
}

function num(v, fallback = -1) {
  const n = Number(v);
  return Number.isFinite(n) && n != null ? n : fallback;
}

// Industrial proximity features for a geocell from the in-memory KD-tree.
// A category with NO site within the search radius is a genuine signal
// ("it is far"), encoded as DIST_FAR_KM (100) — NOT -1, which previously
// conflated "far" with "lookup failed". nearest_industrial_code is the int code
// of the overall nearest site, or -1 when there is none.
export const DIST_FAR_KM = 100;
export function industrialFeatures(lat, lon) {
  const ctx = getIndustrialIndex().getIndustrialContext(lat, lon);
  const out = { nearest_industrial_code: -1 };
  for (const cat of INDUSTRIAL_CATEGORIES) {
    if (INDUSTRIAL_FEATURE_KEYS[cat]) {
      out[INDUSTRIAL_FEATURE_KEYS[cat]] = ctx[cat] ? ctx[cat].dist_km : DIST_FAR_KM;
    }
  }
  if (ctx.nearest) out.nearest_industrial_code = INDUSTRIAL_CODE[ctx.nearest.category] ?? -1;
  // Attach nearest site info so explainability code can reference it.
  out._nearest = ctx.nearest;
  return out;
}

// Rule-derived fire-type label (SIH classes). This is a DETERMINISTIC function of
// industrial proximity + land cover — meant to be framed honestly in the pitch as
// a rule-derived classifier (the ML layer adds confidence/smoothing + the truly
// learned FRP/persistence/NDVI modulation), NOT as 'the model discovered fires'.
// `gas_flare` was merged into `industrial_fire`.
// Returns one of FIRE_TYPE_CATS.
export function classifyFireType(ctx) {
  const d = (v) => (v == null || v < 0 || v >= DIST_FAR_KM ? Infinity : v);
  const land = String(ctx.land_type || '').replace(/^Near:\s*/, '');
  const isVegetated = new Set(['Tree cover', 'Shrubland', 'Grassland', 'Mangroves']).has(land);

  // Tight proximity to high-signal industrial categories win.
  if (d(ctx.dist_flare_km) <= 5 || d(ctx.dist_oilgas_km) <= 3) return 'industrial_fire';
  if (d(ctx.dist_refinery_km) <= 6 || d(ctx.dist_steel_km) <= 5 || d(ctx.dist_power_km) <= 4) {
    return 'industrial_fire';
  }
  if (d(ctx.dist_mining_km) <= 4) return 'mining_activity';

  // Natural, land-cover-driven classes.
  if (land === 'Cropland' || land === 'Bare / sparse vegetation') return 'agricultural_burn';
  if (isVegetated) return 'wildfire';

  // Built-up land with no strong mining/flare signal → urban/infrastructure fire.
  if (land === 'Built-up') return 'industrial_fire';

  // Ambiguous: no strong industrial signal and no recognizable fire fuel.
  return 'unknown';
}

/**
 * Reads the static context for a geocell from the cache as raw numeric features.
 * Returns null when the static context is unavailable.
 */
function contextFeatures(lat, lon) {
  const row = db
    .prepare('SELECT context_json FROM osm_context_cache WHERE lat_key = ? AND lon_key = ?')
    .get(lat, lon);
  if (!row || !row.context_json) return null;

  let ctx;
  try {
    ctx = JSON.parse(row.context_json);
  } catch {
    return null;
  }
  if (!ctx || ctx._v !== 2) return null;

  const fuel = ctx.fuel || {};
  const metrics = fuel.metrics || {};
  return {
    land_type: ctx.land_type,
    land_type_code: landTypeToCode(ctx.land_type),
    dryness_index: fuel.dryness_index == null ? -1 : num(fuel.dryness_index, -1),
    ndvi_p90: metrics?.ndvi?.p90 == null ? -1 : num(metrics.ndvi.p90, -1),
    ndvi_p50: metrics?.ndvi?.p50 == null ? -1 : num(metrics.ndvi.p50, -1),
    ndvi_p10: metrics?.ndvi?.p10 == null ? -1 : num(metrics.ndvi.p10, -1),
    swir_b12: metrics?.swir?.b12 == null ? -1 : num(metrics.swir.b12, -1),
    swir_b11: metrics?.swir?.b11 == null ? -1 : num(metrics.swir.b11, -1),
    behavior_cat: deriveBehaviorCat(fuel.fuel_type),
  };
}

/**
 * Warms static context for every persistence geocell that doesn't have a cached
 * row yet, so the dataset is complete. Concurrency limited to be friendly.
 */
export async function warmMissingContext(concurrency = 8) {
  const srcs = getAllSources();
  const have = new Set(
    db.prepare('SELECT lat_key, lon_key FROM osm_context_cache').all().map((r) => `${r.lat_key},${r.lon_key}`)
  );
  const missing = srcs.filter((s) => !have.has(`${s.lat},${s.lon}`));

  // Fires are (land, fuel) mostly on land pixels; skip pure water quickly isn't
  // necessary — getOsmContext handles missing tiles gracefully.
  let filled = 0;
  const queue = [...missing];
  const worker = async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      try {
        await getOsmContext(s.lat, s.lon);
        filled++;
      } catch (err) {
        console.warn(`[ML] warm context failed for (${s.lat},${s.lon}): ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  return { missing: missing.length, filled };
}

/**
 * FRP stats computed ONLY from the first up-to-2 distinct detection days of a
 * source (the "temporal cutoff" for the persistence FORECAST label). A source
 * seen for a single day gets that day's FRP; no history yields zeros.
 */
function earlyFrpStats(frpByDate) {
  const dates = Object.keys(frpByDate || {}).sort();
  const early = dates.slice(0, 2).map((d) => frpByDate[d]);
  if (early.length === 0) return { avg: 0, max: 0, trend: 0 };
  const avg = early.reduce((a, b) => a + b, 0) / early.length;
  const max = Math.max(...early);
  const trend = early.length >= 2 ? Math.round((early[1] - early[0]) * 100) / 100 : 0;
  return { avg: Math.round(avg * 100) / 100, max, trend };
}

/**
 * Builds the full dataset array: one row per persistence geocell with numeric
 * features + both labels. Rows with no static context are skipped (can't train
 * behavior on unknown fuel).
 */
export function buildDataset() {
  const srcs = getAllSources();
  const rows = [];
  for (const s of srcs) {
    const ctx = contextFeatures(s.lat, s.lon);
    if (!ctx) continue;
    const ind = industrialFeatures(s.lat, s.lon);
    const firetype = classifyFireType({ land_type: ctx.land_type, ...ind });
    const firetypeIsTrain = firetype !== 'unknown' && FIRE_TYPE_TRAIN.includes(firetype);
    const early = earlyFrpStats(s.frp_by_date);
    rows.push({
      lat: s.lat,
      lon: s.lon,
      land_type_code: ctx.land_type_code,
      dryness_index: ctx.dryness_index,
      ndvi_p90: ctx.ndvi_p90,
      ndvi_p50: ctx.ndvi_p50,
      ndvi_p10: ctx.ndvi_p10,
      swir_b12: ctx.swir_b12,
      swir_b11: ctx.swir_b11,
      avg_frp: s.avg_frp,
      max_frp: s.max_frp,
      activity_ratio: s.activity_ratio,
      frp_trend: s.frp_trend == null ? 0 : s.frp_trend,
      frp_early_avg: early.avg,
      frp_early_max: early.max,
      frp_early_trend: early.trend,
      persistence_days: s.persistence_days,
      dist_refinery_km: ind.dist_refinery_km,
      dist_power_km: ind.dist_power_km,
      dist_steel_km: ind.dist_steel_km,
      dist_mining_km: ind.dist_mining_km,
      dist_flare_km: ind.dist_flare_km,
      dist_oilgas_km: ind.dist_oilgas_km,
      nearest_industrial_code: ind.nearest_industrial_code,
      persistence_class: persistenceClass(s.persistence_days),
      behavior_class: BEHAVIOR_CATS.indexOf(ctx.behavior_cat),
      behavior_cat: ctx.behavior_cat,
      firetype_class: firetypeIsTrain ? FIRE_TYPE_CATS.indexOf(firetype) : null,
      firetype_cat: firetype,
    });
  }
  return rows;
}

export { persistenceClass, landTypeToCode, deriveBehaviorCat, earlyFrpStats };

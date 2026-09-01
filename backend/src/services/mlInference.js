import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

import { getAllSources, BACKFILL_WINDOW_DAYS } from '../db/sourceCache.js';
import { db } from '../db/geoCache.js';
import {
  getIndustrialIndex,
  INDUSTRIAL_CATEGORIES,
} from './industrialIndex.js';
import {
  classifyFireType,
  DIST_FAR_KM,
  FIRETYPE_FEATURES as FIRETYPE_FEATURE_NAMES,
  PERSISTENCE_FEATURES as PERSISTENCE_FEATURE_NAMES,
} from './mlDataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../../ml/models');

// ESA WorldCover label -> numeric class code.
const LAND_LABEL_TO_CODE_LOCAL = {
  'Tree cover': 10,
  Shrubland: 20,
  Grassland: 30,
  Cropland: 40,
  'Built-up': 50,
  'Bare / sparse vegetation': 60,
  'Snow and ice': 70,
  'Permanent water bodies': 80,
  'Herbaceous wetland': 90,
  Mangroves: 95,
  'Moss and lichen': 100,
};

// Stable int code per industrial category (mirrors mlDataset.js).
const INDUSTRIAL_CODE = Object.fromEntries(
  INDUSTRIAL_CATEGORIES.map((c, i) => [c, i]),
);

// Canonical feature key per category — mirrors mlDataset.js INDUSTRIAL_FEATURE_KEYS.
const INDUSTRIAL_FEATURE_KEYS = {
  refinery: 'dist_refinery_km',
  power_plant: 'dist_power_km',
  steel: 'dist_steel_km',
  mining: 'dist_mining_km',
  flare: 'dist_flare_km',
  oil_gas: 'dist_oilgas_km',
};

const DEFAULT_PERSISTENCE_CLASSES = { 0: 'short', 1: 'medium', 2: 'long' };
const DEFAULT_BEHAVIOR_CLASSES = {
  0: 'forest', 1: 'grassland', 2: 'shrubland', 3: 'crop', 4: 'other',
};
const DEFAULT_FIRETYPE_CLASSES = {
  0: 'industrial_fire', 1: 'agricultural_burn', 2: 'mining_activity', 3: 'wildfire',
};

// Human-readable fire type labels for explanation text.
const FIRETYPE_DISPLAY = {
  industrial_fire: 'Industrial fire',
  agricultural_burn: 'Agricultural burn',
  mining_activity: 'Mining activity',
  wildfire: 'Wildfire',
  unknown: 'Unknown',
};

let persistenceSession = null;
let behaviorSession = null;
let firetypeSession = null;
let labelMaps = null;
let featureImportances = null;
let ready = false;
let loadError = null;

// Small in-memory prediction cache keyed by rounded geocell ("lat,lon"). Used by
// the batch endpoint so overlapping live + timeline batches never recompute the
// same cell. Bound to keep memory reasonable.
const PREDICTION_CACHE_MAX = 20000;
const predictionCache = new Map();

function loadLabelMaps() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'label_maps.json'), 'utf8'));
    return {
      schema_version: raw.schema_version || 2,
      persistence_feature_names: raw.persistence_feature_names || PERSISTENCE_FEATURE_NAMES,
      feature_names: raw.feature_names || [],
      firetype_feature_names: raw.firetype_feature_names || FIRETYPE_FEATURE_NAMES,
      persistence_classes: raw.persistence_classes || DEFAULT_PERSISTENCE_CLASSES,
      behavior_classes: raw.behavior_classes || DEFAULT_BEHAVIOR_CLASSES,
      firetype_classes: raw.firetype_classes || DEFAULT_FIRETYPE_CLASSES,
    };
  } catch {
    return {
      schema_version: 2,
      persistence_feature_names: PERSISTENCE_FEATURE_NAMES,
      feature_names: [],
      firetype_feature_names: FIRETYPE_FEATURE_NAMES,
      persistence_classes: DEFAULT_PERSISTENCE_CLASSES,
      behavior_classes: DEFAULT_BEHAVIOR_CLASSES,
      firetype_classes: DEFAULT_FIRETYPE_CLASSES,
    };
  }
}

function loadFeatureImportances() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'feature_importances.json'), 'utf8'));
    // Normalise both old shape ({model: {feat: imp}}) and new shape
    // ({model: {importances, top_features, medians}}) into the new shape.
    const out = {};
    for (const model of ['persistence', 'behavior', 'firetype']) {
      const m = raw[model];
      if (!m) continue;
      if (m.importances && m.top_features && m.medians) {
        out[model] = m;
      } else {
        out[model] = {
          importances: m,
          top_features: Object.keys(m).slice(0, 8),
          medians: null,
        };
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Loads all three ONNX models at startup. Called once from index.js.
 */
export async function loadModels() {
  try {
    labelMaps = loadLabelMaps();
    featureImportances = loadFeatureImportances();

    const persPath = path.join(MODELS_DIR, 'persistence.onnx');
    const behPath = path.join(MODELS_DIR, 'behavior.onnx');
    const ftPath = path.join(MODELS_DIR, 'firetype.onnx');

    const missing = [];
    if (!fs.existsSync(persPath)) missing.push('persistence.onnx');
    if (!fs.existsSync(behPath)) missing.push('behavior.onnx');
    if (!fs.existsSync(ftPath)) missing.push('firetype.onnx');
    if (missing.length > 0) {
      throw new Error(
        `Missing ML models [${missing.join(', ')}] in ${MODELS_DIR}. Run: pip install -r ml/requirements.txt && python ml/train.py`
      );
    }

    persistenceSession = await ort.InferenceSession.create(persPath);
    behaviorSession = await ort.InferenceSession.create(behPath);
    firetypeSession = await ort.InferenceSession.create(ftPath);
    ready = true;
    loadError = null;
    console.log('[ML] ONNX models loaded (persistence forecast + behavior + firetype physical).');
  } catch (err) {
    ready = false;
    loadError = err.message;
    console.warn('[ML] Model load skipped:', err.message);
  }
}

export function isMlReady() {
  return ready;
}

export function getMlStatus() {
  return { ready, error: loadError };
}

function num(v, fallback = -1) {
  const n = Number(v);
  return Number.isFinite(n) && n !== null ? n : fallback;
}

function landTypeToCode(landType) {
  if (!landType) return -1;
  const base = String(landType).replace(/^Near:\s*/, '');
  return LAND_LABEL_TO_CODE_LOCAL[base] ?? -1;
}

/**
 * Reads the static-context features for a geocell from the cached context.
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
  const m = fuel.metrics || {};
  return {
    land_type: ctx.land_type,
    land_type_code: landTypeToCode(ctx.land_type),
    dryness_index: fuel.dryness_index == null ? -1 : num(fuel.dryness_index, -1),
    ndvi_p90: m?.ndvi?.p90 == null ? -1 : num(m.ndvi.p90, -1),
    ndvi_p50: m?.ndvi?.p50 == null ? -1 : num(m.ndvi.p50, -1),
    ndvi_p10: m?.ndvi?.p10 == null ? -1 : num(m.ndvi.p10, -1),
    swir_b12: m?.swir?.b12 == null ? -1 : num(m.swir.b12, -1),
    swir_b11: m?.swir?.b11 == null ? -1 : num(m.swir.b11, -1),
  };
}

/**
 * Reads industrial proximity features for a geocell from the in-memory KD-tree.
 * Genuine "nothing within the search radius" is encoded as DIST_FAR_KM (100),
 * not -1 — see ML_RETRAIN_PLAN.md P2.
 */
function industrialFeatures(lat, lon) {
  const ctx = getIndustrialIndex().getIndustrialContext(lat, lon);
  const out = { nearest_industrial_code: -1 };
  for (const cat of INDUSTRIAL_CATEGORIES) {
    if (INDUSTRIAL_FEATURE_KEYS[cat]) {
      out[INDUSTRIAL_FEATURE_KEYS[cat]] = ctx[cat] ? ctx[cat].dist_km : DIST_FAR_KM;
    }
  }
  if (ctx.nearest) out.nearest_industrial_code = INDUSTRIAL_CODE[ctx.nearest.category] ?? -1;
  // Attach nearest site info for explanation generation.
  out._nearest = ctx.nearest;
  return out;
}

/**
 * FRP stats from only the first up-to-2 distinct detection days (temporal cutoff
 * for the persistence FORECAST model). See mlDataset.earlyFrpStats.
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
 * Builds the feature vectors for a geocell:
 *   baseVector:   behavior model   (11 features, full-history FRP)
 *   persVector:   persistence      (10 features, day 1-2 forecast)
 *   ftVector:     firetype         (10 PHYSICAL features; rule features excluded)
 */
function buildFeatureVectors(lat, lon) {
  const geocell = [Math.round(Number(lat) * 100) / 100, Math.round(Number(lon) * 100) / 100];
  const [gLat, gLon] = geocell;

  const pers = getAllSources().find((s) => s.lat === gLat && s.lon === gLon);
  const ctx = contextFeatures(gLat, gLon);
  const ind = industrialFeatures(gLat, gLon);

  const persistenceDays = pers ? pers.persistence_days : 0;
  const avgFrp = pers ? pers.avg_frp : 0;
  const maxFrp = pers ? pers.max_frp : 0;
  const activityRatio = pers ? pers.activity_ratio : 0;
  const frpTrend = pers && pers.frp_trend != null ? pers.frp_trend : 0;
  const early = earlyFrpStats(pers ? pers.frp_by_date : null);

  // Behavior model (11 base features).
  const baseVector = [
    ctx ? ctx.land_type_code : -1,
    ctx ? ctx.dryness_index : -1,
    ctx ? ctx.ndvi_p90 : -1,
    ctx ? ctx.ndvi_p50 : -1,
    ctx ? ctx.ndvi_p10 : -1,
    ctx ? ctx.swir_b12 : -1,
    ctx ? ctx.swir_b11 : -1,
    avgFrp,
    maxFrp,
    activityRatio,
    frpTrend,
  ];

  // Persistence FORECAST model (day 1-2 features, no activity_ratio).
  const persistenceVector = [
    ctx ? ctx.land_type_code : -1,
    ctx ? ctx.dryness_index : -1,
    ctx ? ctx.ndvi_p90 : -1,
    ctx ? ctx.ndvi_p50 : -1,
    ctx ? ctx.ndvi_p10 : -1,
    ctx ? ctx.swir_b12 : -1,
    ctx ? ctx.swir_b11 : -1,
    early.avg,
    early.max,
    early.trend,
  ];

  // Firetype PHYSICAL model (no rule features).
  const firetypeVector = [
    ctx ? ctx.dryness_index : -1,
    ctx ? ctx.ndvi_p90 : -1,
    ctx ? ctx.ndvi_p50 : -1,
    ctx ? ctx.ndvi_p10 : -1,
    ctx ? ctx.swir_b12 : -1,
    ctx ? ctx.swir_b11 : -1,
    avgFrp,
    maxFrp,
    frpTrend,
    persistenceDays,
  ];

  return {
    lat: gLat,
    lon: gLon,
    persistence_days: persistenceDays,
    avg_frp: avgFrp,
    max_frp: maxFrp,
    activity_ratio: activityRatio,
    frp_trend: frpTrend,
    baseVector,
    persistenceVector,
    firetypeVector,
    ctx,
    ind,
  };
}

// ---------------------------------------------------------------------------
// Feature-ablation explanations ("poor-man's SHAP"), computed in Node.
// For a given input we re-run the model, replacing one top feature at a time
// with its training-set median, and rank by how much the predicted class's
// probability drops. The reasons therefore reflect what this specific input
// leaned on — not a static threshold guess.
// ---------------------------------------------------------------------------

const HUMAN_FEATURE_STRINGS = {
  land_type_code: (v) => `land class ${v}`,
  dryness_index: (v) => `dryness ${v}`,
  ndvi_p90: (v) => `vegetation NDVI p90 (${v})`,
  ndvi_p50: (v) => `vegetation NDVI p50 (${v})`,
  ndvi_p10: (v) => `vegetation NDVI p10 (${v})`,
  swir_b12: (v) => `SWIR B12 (${v})`,
  swir_b11: (v) => `SWIR B11 (${v})`,
  avg_frp: (v) => `average FRP (${v} MW)`,
  max_frp: (v) => `peak FRP (${v} MW)`,
  frp_trend: (v) => `FRP trend (${v} MW/day)`,
  activity_ratio: (v) => `activity (${Math.round((v || 0) * 100)}%)`,
  frp_early_avg: (v) => `day-1/2 FRP (${v} MW)`,
  frp_early_max: (v) => `day-1/2 peak FRP (${v} MW)`,
  frp_early_trend: (v) => `day-1/2 FRP trend (${v} MW/day)`,
  persistence_days: (v) => `persistence (${v} of ${BACKFILL_WINDOW_DAYS} days)`,
};

async function sessionRun(session, vector) {
  const input = new ort.Tensor('float32', new Float32Array(vector), [1, vector.length]);
  return session.run({ input });
}

function parseOutput(sessionResult, classMap) {
  const probsTensor = sessionResult.probabilities;
  const labelTensor = sessionResult.label ?? sessionResult.output_label;
  const probs = probsTensor ? Array.from(probsTensor.data) : [];
  const label = labelTensor ? Number(Array.from(labelTensor.data)[0]) : 0;
  const topK = probs
    .map((p, i) => ({ class: i, prob: p }))
    .filter((o) => classMap[o.class] != null)
    .sort((a, b) => b.prob - a.prob);
  const top = topK[0] || { class: label, prob: 0 };
  return {
    class: String(top.class),
    label: classMap[top.class] != null ? classMap[top.class] : classMap[label] || 'unknown',
    confidence: Math.round(top.prob * 1000) / 1000,
    probabilities: Object.fromEntries(
      topK.map((o) => [classMap[o.class] || o.class, Math.round(o.prob * 1000) / 1000])
    ),
  };
}

/**
 * Feature-ablation reason for a model. Returns a short human string like
 * "Model leans on: peak FRP (85 MW); persistence (6 of 10 days)" or null.
 */
async function ablationReason(modelName, session, vector, featureNames, classMap, classLabel) {
  const fi = featureImportances && featureImportances[modelName];
  if (!fi || !fi.top_features || !fi.medians) return null;

  // Baseline predicted-class probability.
  const base = parseOutput(await sessionRun(session, vector), classMap);
  const baseProb = base.probabilities[classLabel] ?? base.confidence;

  const drops = [];
  for (const feat of fi.top_features) {
    const idx = featureNames.indexOf(feat);
    if (idx < 0) continue;
    const median = fi.medians[feat];
    if (median == null) continue;
    const perturbed = vector.slice();
    const prev = perturbed[idx];
    perturbed[idx] = median;
    const out = parseOutput(await sessionRun(session, perturbed), classMap);
    const probOfBase = out.probabilities[classLabel] ?? out.confidence;
    perturbed[idx] = prev;
    const drop = baseProb - probOfBase;
    if (drop > 1e-4) drops.push({ feat, drop, value: prev });
  }

  drops.sort((a, b) => b.drop - a.drop);
  const top = drops.slice(0, 3).map(
    (d) => HUMAN_FEATURE_STRINGS[d.feat] ? HUMAN_FEATURE_STRINGS[d.feat](round2(d.value)) : d.feat
  );
  if (top.length === 0) return null;
  return `Model basis: ${top.join('; ')}`;
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : v;
}

// ---------------------------------------------------------------------------
// Rule-based firetype explanation (primary classifier layer).
// ---------------------------------------------------------------------------
function generateFiretypeRuleReason(label, ind) {
  const parts = [];
  const near = (dist, km, text) => {
    if (dist != null && dist > 0 && dist <= km) parts.push(`${text} (${dist}km)`);
  };

  if (label === 'industrial_fire') {
    near(ind.dist_refinery_km, 8, 'near refinery');
    near(ind.dist_steel_km, 5, 'near steel plant');
    near(ind.dist_power_km, 4, 'near power plant');
    near(ind.dist_flare_km, 5, 'near gas flare infrastructure');
    near(ind.dist_oilgas_km, 3, 'near oil/gas facility');
    if (parts.length === 0 && ind._nearest) {
      parts.push(`near ${ind._nearest.category.replace(/_/g, ' ')} (${ind._nearest.dist_km}km)`);
    }
    if (parts.length === 0) parts.push('proximity to industrial infrastructure');
  } else if (label === 'mining_activity') {
    near(ind.dist_mining_km, 4, 'within mining operation radius');
    if (parts.length === 0) parts.push('near mining operation');
  } else if (label === 'agricultural_burn') {
    parts.push('cropland or bare vegetation with no nearby industrial source');
  } else if (label === 'wildfire') {
    parts.push('vegetated land cover with no industrial proximity signal');
  } else {
    parts.push('no dominant industrial or vegetation fuel signal');
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Classifies a geocell.
 *
 * Fire type uses the DETERMINISTIC RULE as the primary authoritative
 * classifier (explainable + reliable by construction); the physical-features
 * ONNX model is the secondary check. Persistence is a forecast from day 1-2
 * features. Results are cached per rounded geocell.
 */
export async function classifyGeocell(lat, lon) {
  const key = `${Math.round(Number(lat) * 100) / 100},${Math.round(Number(lon) * 100) / 100}`;
  const cached = predictionCache.get(key);
  if (cached) return cached;
  if (!ready) throw new Error(getMlStatus().error || 'ML models not loaded');

  const feat = buildFeatureVectors(lat, lon);

  // Run the three models in parallel.
  const [pOut, bOut, ftOut] = await Promise.all([
    persistenceSession.run({ input: new ort.Tensor('float32', new Float32Array(feat.persistenceVector), [1, feat.persistenceVector.length]) }),
    behaviorSession.run({ input: new ort.Tensor('float32', new Float32Array(feat.baseVector), [1, feat.baseVector.length]) }),
    firetypeSession.run({ input: new ort.Tensor('float32', new Float32Array(feat.firetypeVector), [1, feat.firetypeVector.length]) }),
  ]);

  const persistence = parseOutput(pOut, labelMaps.persistence_classes);
  const behavior = parseOutput(bOut, labelMaps.behavior_classes);
  const firetypeMl = parseOutput(ftOut, labelMaps.firetype_classes);

  // Primary (authoritative) fire type = deterministic rule.
  const ruleLabel = classifyFireType({ land_type: feat.ctx ? feat.ctx.land_type : null, ...feat.ind });
  const ruleClass = Object.keys(labelMaps.firetype_classes).find(
    (k) => labelMaps.firetype_classes[k] === ruleLabel
  );
  const ruleConfidence = ruleLabel === 'unknown' ? 0 : 1;
  const firetype = {
    label: ruleLabel,
    class: ruleClass != null ? ruleClass : '-1',
    confidence: ruleConfidence,
    rule: true,
  };
  const agreement =
    ruleLabel === 'unknown'
      ? 'ambiguous'
      : firetypeMl.label === ruleLabel
        ? 'agree'
        : 'disagree';

  // Ablation-based reasons (what the model actually leaned on).
  const [persReason, ftModelReason] = await Promise.all([
    ablationReason('persistence', persistenceSession, feat.persistenceVector,
      labelMaps.persistence_feature_names, labelMaps.persistence_classes, persistence.label),
    ablationReason('firetype', firetypeSession, feat.firetypeVector,
      labelMaps.firetype_feature_names, labelMaps.firetype_classes, firetypeMl.label),
  ]);

  const reasons = {
    persistence: persReason,
    behavior: generateBehaviorReason(behavior.label, feat.ctx),
    firetype: {
      rule: generateFiretypeRuleReason(ruleLabel, feat.ind),
      model: ftModelReason,
      disagreement: agreement === 'disagree'
        ? `Thermal signature is atypical for ${FIRETYPE_DISPLAY[ruleLabel] || ruleLabel}; physical behaviour suggests ${FIRETYPE_DISPLAY[firetypeMl.label] || firetypeMl.label}.`
        : null,
    },
  };

  const result = {
    persistence,
    behavior,
    firetype,
    firetype_ml: firetypeMl,
    firetype_agreement: agreement,
    reasons,
    features: {
      persistence_days: feat.persistence_days,
      avg_frp: feat.avg_frp,
      max_frp: feat.max_frp,
      activity_ratio: feat.activity_ratio,
      frp_trend: feat.frp_trend,
    },
  };

  // Cache (bounded).
  if (predictionCache.size >= PREDICTION_CACHE_MAX) {
    const oldestKey = predictionCache.keys().next().value;
    predictionCache.delete(oldestKey);
  }
  predictionCache.set(key, result);

  return result;
}

function generateBehaviorReason(label, ctx) {
  if (!ctx) return null;
  const land = String(ctx.land_type || '').replace(/^Near:\s*/, '');
  const parts = [];

  if (land && land !== -1) parts.push(`${land} land cover`);
  if (ctx.dryness_index > 0) {
    const dryness = ctx.dryness_index;
    if (dryness > 0.7) parts.push(`high dryness (${dryness.toFixed(2)})`);
    else if (dryness > 0.4) parts.push(`moderate dryness (${dryness.toFixed(2)})`);
    else parts.push(`low dryness (${dryness.toFixed(2)})`);
  }
  if (ctx.ndvi_p10 !== -1 && ctx.ndvi_p10 < 0.2) parts.push('sparse vegetation (low NDVI)');

  if (parts.length === 0) return null;

  if (label === 'forest') return `Forest classification: ${parts.join(', ')}`;
  if (label === 'grassland') return `Grassland classification: ${parts.join(', ')}`;
  if (label === 'shrubland') return `Shrubland classification: ${parts.join(', ')}`;
  if (label === 'crop') return `Cropland classification: ${parts.join(', ')}`;
  return `Fuel type: ${parts.join(', ')}`;
}

export const mlFeatureNames = (labelMaps && labelMaps.feature_names) || [
  'land_type_code', 'dryness_index', 'ndvi_p90', 'ndvi_p50', 'ndvi_p10',
  'swir_b12', 'swir_b11', 'avg_frp', 'max_frp', 'activity_ratio', 'frp_trend',
];
export const mlFiretypeFeatureNames = FIRETYPE_FEATURE_NAMES;
export const mlModelsDir = MODELS_DIR;
export function clearPredictionCache() {
  predictionCache.clear();
}
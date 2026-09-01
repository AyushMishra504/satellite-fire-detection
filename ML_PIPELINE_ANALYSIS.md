# ML Pipeline Analysis — Fires Detection & Fire-Type Classification

Comprehensive review of the ML pipeline: how a fire is classified, the data used,
model numbers, shortcomings, risk factors for wrong predictions, and the root
cause of why some hotspots show no prediction.

Where relevant, file references use `path:line`.

---

## 1. End-to-End Data Flow (how a fire gets classified)

### A. Source data acquisition
- **Live detections** come from **NASA FIRMS** (`GET /detections` → `firmsService.js`). Each record is a raw FIRMS hotspot: `{latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite, instrument, confidence, frp, daynight, ...}`. **No ML features here** — just the thermal anomaly.
- **Persistence history** is built in `sourceCache.js`: hotspots are snapped to a **~1.1 km geocell** (lat/lon rounded to 2 decimals, `geocell()` at `backend/src/db/sourceCache.js:18`). Each cell accumulates `seen_dates[]` and `frp_by_date{}`. Persistence is backfilled over a **10-day window** (`BACKFILL_WINDOW_DAYS = 10`).
- The FIRMS API key + date-range query pulls historical days so a long-burning fire doesn't look like "day 1" on first boot.

### B. Static context features (per geocell, cached in `osm_context_cache`)
Fetched from **ESA WorldCover 10m + ESA/S2 NDVI & SWIR composites** (`osmContext.js`, `worldCover.js`, `worldCoverComposites.js`):
- **land_type_code** — dominant ESA land cover class (Tree=10 … Moss=100), ~3.5 km search window, closest valid pixel within 50 m → exact label, else `Near: <label>`.
- **dryness_index** — heuristic combining low NDVI (p10) + high SWIR B12 (`-g*0.6 + s*0.6 + 0.3`, clamped 0..1).
- **ndvi_p90/p50/p10** — NDVI percentiles from ~1 km window (median, valid range 0-250 → -1..1).
- **swir_b12 / swir_b11** — SWIR reflectance (lower = wetter).
- All cached with a **schema version `_v == 2`**; missing tiles/values become **`-1`** (the sentinel).

### C. Industrial proximity features (per geocell, in-memory KD-tree)
`industrialIndex.js` builds a **KD-tree per industrial category** (refinery, power_plant, steel, mining, flare, oil_gas, other_industrial) from the static `industrial_sites` layer. Each geocell gets `dist_refinery_km … dist_oilgas_km` (nearest site within 50 km, else `-1`) plus `nearest_industrial_code`.

### D. Dataset construction (`mlDataset.js` → `dataset.csv`)
911 rows, one per persistent geocell, joining **persistence history + static context + industrial proximity**. This is the only place the **labels** are defined:
- `persistence_class` = short(<2d) / medium(2-3d) / long(≥4d) from `persistence_days`.
- `behavior_class` = fuel type derived from `fuel.fuel_type` string matching (forest/grass/shrub/crop/wetland/other).
- `firetype_cat` = **rule-derived** from `classifyFireType()` (`backend/src/services/mlDataset.js:152`): a deterministic function of industrial proximity + land cover (see Section 3.4). `unknown` bucket for ambiguous cells; **`unknown` is excluded from training** (`FIRE_TYPE_TRAIN`).

### E. Training (`train.py`)
- **3 RandomForests** (300 trees, `class_weight="balanced"`, seed 42) exported to ONNX:
  - `persistence.onnx` — 11 features, 3 classes
  - `behavior.onnx` — 11 features, 6 classes
  - `firetype.onnx` — 18 features (11 + 7 industrial), 5 classes
- ONNX export with `zipmap: False`, target opset 17.
- Holdout eval is 75/25 split, **stratified only if all classes have ≥2 members**.

### F. Inference (`mlInference.js` → `/api/ml/predict/batch`)
At runtime the service builds the **exact same 11- and 18-element vectors** and runs the 3 ONNX sessions in parallel. Returns `{ persistence, behavior, firetype, reasons, features }`. The firetype model + proximity generate a human-readable **reason** (e.g. "Near power plant (2.63km)").

### G. Frontend rendering
`App.jsx` batches geocells missing predictions (`missingPredictions`) via `runBatchPredictions`, stores results in `firetypeByCell` / `mlRiskByCell` keyed by `geocellKey`, and `FireMap.jsx` colors the marker **fill** by fire type, the **ring** by persistence, and sizes the marker by fire type.

---

## 2. Model Numbers & Class Distributions

### Class distribution (911 samples)

| Persistence | label | count | % |
|---|---|---|---|
| short | 0 | 824 | 90.4% |
| medium | 1 | 72 | 7.9% |
| long | 2 | 15 | 1.6% |

| Behavior | label | count | % |
|---|---|---|---|
| crop | 3 | 300 | 32.9% |
| forest | 0 | 274 | 30.1% |
| other | 5 | 155 | 17.0% |
| grassland | 1 | 129 | 14.2% |
| shrubland | 2 | 52 | 5.7% |
| wetland | 4 | **1** | 0.1% |

| Firetype (trainable, 890) | label | count | % |
|---|---|---|---|
| wildfire | 4 | 349 | 39.2% |
| agricultural_burn | 2 | 256 | 28.8% |
| industrial_fire | 0 | 245 | 27.5% |
| mining_activity | 3 | 36 | 4.0% |
| gas_flare | 1 | **4** | 0.4% |
| *(unknown — excluded)* | — | 21 | 2.3% |

### Reported accuracy (`metrics.json`)
- **Persistence** holdout 99.6%; but class 2 ("long") has only **4 holdout samples** → f1 0.86 on tiny support.
- **Behavior** holdout 97.4%; class 4 ("wetland") has **1 sample** → precision/recall = 0.0.
- **Firetype** holdout 96.0%; gas_flare has **1 holdout sample** (f1 "1.0" is meaningless with n=1), mining f1 = 0.63 (9 samples), agricultural f1 = 0.95 (64 samples).

### Feature importances (top, `feature_importances.json`)
- **Persistence**: `activity_ratio` 0.55 dominates (trivially — it is near-monotonic with the label), then `frp_trend` 0.14.
- **Behavior**: `land_type_code` 0.51 (nearly a lookup, since land cover → fuel).
- **Firetype**: `dist_power_km` 0.18, `land_type_code` 0.13, `ndvi_p90` 0.11, `dist_mining_km` 0.10, `dist_flare_km` 0.08.

---

## 3. Shortcomings & Risk Factors for Wrong Predictions

1. **`activity_ratio` is trivially predictive (0.55)** — it is `min(1, persistence_days / 10)`, i.e. a near-perfect monotonic transform of the label. The model is essentially "memorizing" the label rather than learning fire physics. The "99.6% persistence accuracy" is inflated/misleading.

2. **Severe class imbalance in tiny classes** — gas_flare (4 rows), wetland (1 row), long-persistence (15 rows), mining (36 rows). Holdout f1 for these rests on single-digit support and is statistically meaningless. **These classes will predict poorly/unreliably on unseen data** despite the high top-line accuracy.

3. **No temporal/weather/topography features** — intentionally scoped out, but it means persistence risk can't truly capture "will it spread" (no wind, slope, humidity). The model describes **past** persistence, not a **forecast**.

4. **Firetype is fundamentally rule-derived, not learned** — `classifyFireType` (`mlDataset.js:152`) derives the ground-truth label from **the same industrial-proximity + land-cover features the model then uses to predict it**. The model learns to reproduce its own training rule — a **self-confirming loop** that overstates realism. The top firetype feature (`dist_power_km`) confirms this.

5. **Static context is outdated/coarse** — ESA WorldCover is **2021**; NDVI/SWIR composites are static (not current-season). A fire on land that has since changed, or in a season with different dryness, gets stale features.

6. **`-1` sentinel reuse** — missing context, absent industrial sites, and "no such feature" are all encoded as `-1` (plus `Infinity` signalled as `-1` for distances). The model can conflate "missing data" with "no nearby plant", producing confident-but-wrong industrial/agricultural labels. A third of industrial features are `-1` (`dist_power_km` 314/911, `dist_mining_km` 361/911 missing → model reads them as "far").

7. **Explainability "reasons" can be wrong** — reasons are generated from nearest-site lookups + static-feature thresholds, independent of what the model actually did. For wildfire/agricultural they are generic ("no nearby industrial source") and may disagree with the model's real driver.

8. **The `unknown` class is trained to be impossible** — 5-class ONNX with a 6th `unknown` never trainable → `parseOutput` handles class-5 via a fragile fallback (see Section 4, row 9).

---

## 4. ROOT CAUSE — Why It's Not Predicting for Some Hotspots

### Primary bug (confirmed & quantified): geocell key mismatch — ~18% of cells affected
- **Write side** (`App.jsx:186`): `runBatchPredictions` stores each prediction under `r.lat.toFixed(2) + ',' + r.lon.toFixed(2)` → **always exactly 2 decimals**, e.g. `"6.46,81.10"`.
- **Read side** (`geocellKey` in `frontend/src/components/utils.js:33`, used by `missingPredictions`, `filteredDetections`, and every `FireMap` lookup): uses `Math.round(Number(lat)*100)/100` → **drops trailing zeros**, e.g. `"6.46,81.1"`.

These strings differ whenever a coordinate has a trailing zero. Across the **926 real thermal-source cells, 166 (17.9%)** produce different strings. Consequence:
1. The backend **successfully returns** a firetype/persistence prediction.
2. It is stored under key `"6.46,81.10"`.
3. The marker looks up `firetypeByCell["6.46,81.1"]` → **undefined**.
4. Marker renders **gray fallback** (`#94a3b8`, radius 8, no ring, no fire-type label).
5. `missingPredictions` uses `geocellKey` → reads `"6.46,81.1"` → still thinks the cell is missing → **re-requests the same cell on every render** (wasted API calls + repeated inference).

**This is the direct answer to "why it's not predicting for some of the hotspots"** — the predictions *are* computed, but the frontend cannot find them due to inconsistent string keying.

### Secondary causes

| # | Cause | Effect |
|---|---|---|
| 6 | **300-cell batch cap** (`mlRoute.js:60`) | `omitted` cells never get predictions **and the frontend ignores `omitted`** → silent gaps when >300 unique geocells. |
| 7 | **`missingPredictions` re-queues on any error** (`App.jsx:138`) | If a cell errors (or returns no firetype), it is re-requested every render — chatty, and errored cells stay blank forever. The 17.9% mismatched cells compound this. |
| 8 | **Filtering hides predictionless points** (`passesFilter`, `App.jsx:384`) | While any firetype filter is active, points without a firetype prediction are **completely hidden from the map**, not just grayed. |
| 9 | **Class-5 / `unknown` label gap** (`mlInference.js:437`) | `label_maps.json` has only 5 firetype classes; if the model emits class 5, `parseOutput` yields `label:'unknown'`, which has **no entry in `FIRETYPE_STYLING`** → gray marker, and `unknown` is not in `FIRETYPE_TYPES` → **hidden when filtering active**. |
| 10 | **Models-not-loaded** (`index.js`) | `loadModels()` is fire-and-forget with a `catch`; if ONNX fails to load, every cell errors → all markers gray. |

---

## 5. Concrete Recommendations (priority order)

1. **Fix the key mismatch (highest impact, one-line change)** — in `runBatchPredictions`, `missingPredictions`, and every cache access, use a **single canonical `geocellKey()`** everywhere (replace `r.lat.toFixed(2) + ',' + r.lon.toFixed(2)` with `geocellKey(r.lat, r.lon)`). This fixes ~18% of hotspots that render gray despite having valid predictions, and stops the redundant re-fetching.

2. **Handle `omitted`** in the frontend batch response (process remaining cells in follow-up requests), or raise/remove the 300-cell cap since the client already chunks to 50.

3. **Add `unknown` to the frontend `FIRETYPE_TYPES` / `FIRETYPE_STYLING`** — a neutral gray with a label — so it colors/labels instead of hiding when filtering.

4. **Make `missingPredictions` stop re-queuing permanently-failed/unknown cells** — track an "attempted" set so they aren't hammered on every render.

5. **Reconsider tiny classes** — either drop/merge `wetland` and `gas_flare` (e.g. gas_flare → industrial_fire), or require a minimum support before including a class. Current f1 scores for these are misleading.

6. **Be honest about the rule-derived labels** — the firetype model predicts its own rule; the real ML value is confidence/smoothing + FRP/NDVI modulation. Frame the demo accordingly, or derive firetype labels from independent data (e.g. verified industrial incident reports) if ground truth matters.

7. **Decay `activity_ratio` domination** — or redefine the persistence label so accuracy reflects genuine feature learning rather than a label-redundant feature.

---

### Quick reference
- Dataset: `backend/ml/dataset.csv` (911 rows)
- Training: `backend/ml/train.py`
- Feature/label builder: `backend/src/services/mlDataset.js`
- Runtime inference: `backend/src/services/mlInference.js`
- Batch API: `backend/src/routes/mlRoute.js`
- Persistence tracker: `backend/src/db/sourceCache.js`
- Static context: `backend/src/services/osmContext.js`, `worldCover.js`, `worldCoverComposites.js`
- Industrial proximity: `backend/src/services/industrialIndex.js`
- Frontend cache/lookup: `frontend/src/App.jsx`, `frontend/src/components/utils.js` (`geocellKey`)
- Model artifacts: `backend/ml/models/` (`*.onnx`, `label_maps.json`, `feature_importances.json`, `metrics.json`)

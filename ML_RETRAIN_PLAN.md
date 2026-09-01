# ML Retraining & Explainability Fix Plan

Based on `ML_PIPELINE_ANALYSIS.md`. Priority order — do P0 before judging whether
the model even needs retraining, since a chunk of "wrong categorization" you're
seeing is a rendering bug, not a model error.

---

## P0 — Fix the pipeline bugs first (no ML change, do this before anything else)

You can't evaluate model quality while ~18% of predictions are being thrown away
by a key-mismatch bug. Do these four fixes, redeploy, and *then* look at the map
again — some of what looks like "categorizing wrongly" may just disappear.

1. **Unify `geocellKey()`** — one canonical function, used in `runBatchPredictions`
   write, `missingPredictions` read, and every `FireMap` lookup. Kill the
   `toFixed(2)` vs `Math.round*100/100` divergence.
2. **Handle `omitted` cells** from the 300-cap batch response — either raise the
   cap (client already chunks to 50, so 300 is an arbitrary extra layer) or
   follow up with a second request for omitted cells.
3. **Add `unknown` to `FIRETYPE_TYPES`/`FIRETYPE_STYLING`** — neutral gray +
   label, so it displays instead of vanishing under active filters.
4. **Track an "attempted" set** in `missingPredictions` so permanently-failed or
   `unknown` cells stop being re-requested every render.

Only after these are live do you have a clean signal on how much of the
remaining "wrong" output is actually the model.

---

## P1 — Fix the two circular labels (highest-value ML fix)

This is the real problem, not hyperparameters. Two of your three models are
being trained to reproduce information they're handed, not to predict anything.

### 1a. Persistence model: reframe as forecasting, not description

`activity_ratio = min(1, persistence_days / 10)` is a near-exact transform of
the label you're binning into short/medium/long. The model isn't learning fire
behavior — it's decoding its own answer key. That's why holdout accuracy is
99.6% with a class that has 4 holdout samples: it's not a hard problem as
currently framed.

**The deeper issue:** if you already log `persistence_days` for every geocell in
`sourceCache.js`, you don't need ML to tell you whether a fire *has been*
persistent — that's a fact you already have. The genuinely useful ML task is
**forecasting**: given only what you knew on day 1 (or day 2) of a fire, predict
whether it *will become* persistent. That's actually useful (early warning) and
actually hard (real prediction, not lookup).

Fix:
- Drop `activity_ratio` from the feature vector entirely — it's label leakage.
- Rebuild the label using a **temporal cutoff**: for each geocell, take only the
  features available from its first 1–2 days of detections (FRP, brightness,
  land type, static context — everything *except* `frp_by_date` history beyond
  day 2), and the final `persistence_days` becomes the label to predict.
- This changes what "99% accuracy" means — expect it to drop, possibly a lot.
  That's not a regression, it's the number becoming honest.

### 1b. Firetype model: separate the rule-features from the physical features

`classifyFireType()` derives the label from industrial proximity + land cover
— then the model is trained on those same features to predict that same label.
`dist_power_km` being the top feature importance (0.18) is the smoking gun:
the model found the rule and is executing it back.

Fix — split into two disjoint feature groups and train on only one:

| Group | Features | Role |
|---|---|---|
| **Rule features** | `dist_*_km`, `nearest_industrial_code`, `land_type_code` | Used to *construct* the label. Never feed to the model. |
| **Physical features** | FRP stats, `frp_trend`, persistence days, day/night, `ndvi_p90/p50/p10`, `swir_b12/b11`, `dryness_index` | Genuinely independent of the label rule. Train the model on these only. |

The retrained `firetype.onnx` now answers a real question: *"given only how hot,
how persistent, and how dry/green the surroundings are — without being told
distance to infrastructure — can fire behavior alone predict the type?"* Any
accuracy above baseline here is real signal, not the rule talking to itself.

**Final architecture:** keep the deterministic rule as the primary,
authoritative classifier (it's explainable and reliable by construction). Use
the physical-features-only model as a **secondary check**:
- Rule says X, model agrees → high confidence, show both reasons.
- Rule says X, model disagrees → lower confidence, flag it, still show the
  rule's answer but surface the disagreement ("thermal signature is atypical
  for this classification") — this is a genuinely useful signal a pure rule
  can't produce alone.

### 1c. Behavior model — lower priority, defensible as-is

`land_type_code` at 0.51 importance is less circular than the other two: land
cover *genuinely* determines fuel type in the real world, so a model that
leans on it isn't reproducing a training artifact so much as learning true
domain structure. Leave this one mostly alone; optionally add NDVI/dryness
features for cases within the same land class (e.g. distinguishing "dry
grassland" from "irrigated cropland" fuel behavior).

---

## P2 — Class imbalance and missing-data encoding

### Merge or drop unusable classes
Don't train on classes with single-digit support — their reported F1 is
statistically meaningless and will mislead anyone reading the metrics.

| Class | Count | Action |
|---|---|---|
| `gas_flare` | 4 | Merge into `industrial_fire` (flares are a subtype anyway) |
| `wetland` (behavior) | 1 | Merge into `other` |
| `long` persistence | 15 | Keep, but report wide confidence bands; don't claim precision |
| `mining_activity` | 36 | Keep — borderline but usable; watch recall over time |

Add an automatic guardrail in `train.py`: if any class has fewer than ~20
samples after this pass, print a loud warning before training rather than
silently reporting a meaningless per-class F1.

### Fix the `-1` sentinel conflation
Right now "no industrial site within 50km" and "our lookup/tile fetch failed"
both become `-1` — indistinguishable from each other, and sitting among
otherwise-positive distance values where a RandomForest may read `-1` as
"very close" rather than "very far" or "unknown."

Fix:
- For **genuine "nothing found within search radius"** (real signal — it *is*
  far): use a large plausible value instead, e.g. `100` (km) rather than `-1`.
- For **actual fetch/lookup failures** (missing data, not "far"): impute the
  column with its training-set median, and add a parallel `*_missing` binary
  flag column so the model can distinguish "typical value, unknown" from "real
  measurement." This matters most for `dist_power_km` (314/911 missing) and
  `dist_mining_km` (361/911 missing) — over a third of your data currently has
  this ambiguity baked in for those two features specifically.

### Use stratified k-fold instead of one holdout split
A single 75/25 split can leave 1–4 samples of a small class in the test set —
that's not an evaluation, it's noise. Use stratified k-fold CV (as many folds
as the smallest retained class supports, e.g. 5-fold once tiny classes are
merged per above) and report averaged per-class metrics. More honest, and
costs nothing extra to compute.

---

## P3 — Explainability that matches what the model actually did

Right now "reasons" are generated independently from static thresholds — they
can (and per your own analysis, do) disagree with the model's real driver.
Since you're running ONNX in Node with no live Python, full SHAP isn't
practical at runtime, but a cheap, honest alternative is:

**Feature-ablation explanation (poor-man's SHAP), computed in Node:**
1. At training time (Python), export the top-8 features by global importance
   into `feature_importances.json` (you already have this).
2. At inference time (Node), for a given prediction, re-run the ONNX model
   K times, each time replacing one of the top-8 features with its dataset
   median (also export these medians from training).
3. Rank features by how much the predicted class's probability *drops* when
   that feature is neutralized — the biggest drops are your real "reasons,"
   because they're measuring what the model actually leaned on for *this*
   specific input, not a static rule guess.
4. Map the top 3 drops to human-readable strings the same way you do now
   (e.g. "FRP" → "High fire radiative power (85 MW)").

This is slightly more compute per prediction (K+1 forward passes instead of 1)
but ONNX inference is fast enough that this is fine at your current batch
sizes — and it fixes the "reasons disagree with the model" problem directly,
since the reasons *are* now derived from the model's own sensitivity.

Once P1b's split is in place, be explicit in the UI about which layer produced
which part of the explanation: rule-based reasons ("0.8km from refinery") vs.
model-based reasons ("sustained high FRP over 6 days, atypical for
agricultural burn pattern") are different kinds of evidence and both are more
credible shown separately than blended into one undifferentiated list.

---

## P4 — Ongoing hygiene for the nightly retrain loop

- Auto-flag in `train.py` if `activity_ratio`-style trivial features creep
  back in (feature importance > 0.4 on a single feature is worth a manual
  look before accepting a retrain).
- Log per-class support counts every retrain, not just accuracy — a class
  quietly dropping to single digits should be visible without re-reading this
  document.
- Version the `dataset.csv` schema (you already do `_v == 2` for context
  cache) so a future feature-vector change doesn't silently retrain on stale
  columns.

---

## P5 — Optional, lower priority

- **Refresh NDVI/SWIR composites periodically** (e.g. monthly) instead of one
  static pull — seasonal dryness matters more for fire behavior than the
  land-cover class does, and you already have the fetch pipeline
  (`worldCoverComposites.js`) built. Cheaper than reopening the
  weather/topography question you already closed.
- **Cross-check firetype labels against FIRMS/MODIS's own `type` attribute**
  where available (some active-fire products flag 0=vegetation, 1=volcano,
  2=static/other land source, 3=offshore) — this would be a source of ground
  truth genuinely independent of your OSM-derived rule, worth a quick check of
  whether your specific FIRMS product/endpoint exposes it before relying on it.

---

## Suggested order of work

1. P0 (bug fixes) → redeploy → re-look at the map before touching the model.
2. P1a + P1b (label/feature redesign) — this is where "categorizing wrongly"
   actually gets fixed, not by tuning `n_estimators`.
3. P2 (class merges + sentinel fix + k-fold) — do this alongside the P1
   retrain since you're rebuilding `dataset.csv` anyway.
4. P3 (explainability) — once the models are retrained on the new feature
   split, since P1b changes what "the model's reasons" even means.
5. P4/P5 as ongoing maintenance, not blocking.

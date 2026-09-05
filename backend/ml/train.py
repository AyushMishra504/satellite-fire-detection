"""
Train the FIRMS persistence + behavior + firetype classifiers and export to ONNX.

Run (from backend/):
    pip install -r ml/requirements.txt
    python ml/train.py

Produces (in ml/models/):
    persistence.onnx          - 3-class persistence FORECAST (short/medium/long) from
                                day 1-2 features only (no activity_ratio leakage)
    behavior.onnx             - fire behavior/fuel category (forest/grass/shrub/crop/other)
    firetype.onnx             - PHYSICAL-features-only 4-class fire type
                                (industrial_fire/agricultural_burn/mining_activity/wildfire);
                                the deterministic rule in mlDataset.classifyFireType is the
                                authoritative primary classifier used at runtime
    label_maps.json           - class index <-> label and feature order per model
    feature_importances.json  - per-model feature importance + top-8 features + dataset
                                medians (used for feature-ablation explanations at runtime)
    metrics.json              - k-fold CV metrics + per-class support

Changes vs. the old single-split pipeline (see ML_RETRAIN_PLAN.md):
    - persistence features are day 1-2 (early-window FRP), `activity_ratio` dropped
    - firetype model trains on physical features only; rule features are excluded
    - gas_flare merged into industrial_fire; behavior wetland merged into other
    - genuine "no industrial site within radius" now encoded as 100 km (not -1)
    - stratified k-fold CV instead of one 75/25 holdout
    - loud warnings when a class has <20 samples or one feature dominates (>0.4)
"""
import json
import os
import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, KFold
from sklearn.metrics import accuracy_score, f1_score, precision_recall_fscore_support
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "dataset.csv")
MODELS = os.path.join(HERE, "models")
os.makedirs(MODELS, exist_ok=True)

SCHEMA_VERSION = 4
MIN_CLASS_SUPPORT_WARN = 20
MAX_SINGLE_IMPORTANCE_WARN = 0.4

# ---------------------------------------------------------------------------
# Feature sets. MUST match mlDataset.js exports.
# ---------------------------------------------------------------------------
# Behavior / fuel model (11 base features) — unchanged.
BEHAVIOR_FEATURES = [
    "land_type_code",
    "dryness_index",
    "ndvi_p90",
    "ndvi_p50",
    "ndvi_p10",
    "swir_b12",
    "swir_b11",
    "avg_frp",
    "max_frp",
    "activity_ratio",
    "frp_trend",
]

# Persistence FORECAST: day 1-2 (early-window FRP) features only. No
# activity_ratio (it is a monotonic transform of the label), no full-history FRP.
PERSISTENCE_FEATURES = [
    "land_type_code",
    "dryness_index",
    "ndvi_p90",
    "ndvi_p50",
    "ndvi_p10",
    "swir_b12",
    "swir_b11",
    "frp_early_avg",
    "frp_early_max",
    "frp_early_trend",
]

# Firetype PHYSICAL-only: genuinely independent of the dist_* rule features that
# construct the label. `land_type_code` is remote-sensing data (ESA WorldCover),
# NOT derived from the industrial proximity rule, so it is safe to include.
# `activity_ratio` is a key discriminator: mining fires are consistently active.
FIRETYPE_FEATURES = [
    "dryness_index",
    "ndvi_p90",
    "ndvi_p50",
    "ndvi_p10",
    "swir_b12",
    "swir_b11",
    "avg_frp",
    "max_frp",
    "frp_trend",
    "persistence_days",
    "land_type_code",    # ESA WorldCover — remote sensing, not a rule feature
    "activity_ratio",   # fraction of backfill window with detections
]

PERSISTENCE_CLASSES = {0: "short", 1: "medium", 2: "long"}
BEHAVIOR_CLASSES = {0: "forest", 1: "grassland", 2: "shrubland", 3: "crop", 4: "other"}
FIRETYPE_CLASSES = {
    0: "industrial_fire",
    1: "agricultural_burn",
    2: "mining_activity",
    3: "wildfire",
}


def warn_class_support(name, counts):
    """Loudly warn when any class has single-digit support (meaningless F1)."""
    for cls, count in enumerate(counts):
        if count == 0:
            warnings.warn(f"[train] {name}: class index {cls} has ZERO samples — "
                          "review the dataset; a dead class inflates/deflates metrics.")
        elif count < MIN_CLASS_SUPPORT_WARN:
            warnings.warn(f"[train] {name}: class index {cls} has only {count} samples "
                          "(<{MIN_CLASS_SUPPORT_WARN}). Reported per-class F1 is unreliable.")


def warn_dominant_feature(name, importances):
    top = max(importances.values(), default=0.0)
    if top > MAX_SINGLE_IMPORTANCE_WARN:
        warnings.warn(f"[train] {name}: single feature importance {top:.3f} exceeds "
                      f"{MAX_SINGLE_IMPORTANCE_WARN}. Likely label leakage / trivial "
                      "feature — review before accepting this retrain.")


def oversample_minority(X, y, n_classes, target_ratio=0.25, noise_std=0.05, seed=42):
    """Simple synthetic minority oversampling with Gaussian jitter.

    For each minority class whose count is below `target_ratio * majority_count`,
    duplicate existing samples and add small Gaussian noise (noise_std * feature_std)
    to numeric columns. This is a lightweight SMOTE alternative that avoids the
    imbalanced-learn dependency.
    """
    rng = np.random.default_rng(seed)
    counts = np.bincount(y, minlength=n_classes)
    majority_n = counts.max()
    target_n = max(1, int(majority_n * target_ratio))

    X_aug, y_aug = [X], [y]
    feat_std = np.std(X, axis=0) + 1e-8  # per-feature std for noise scaling

    for cls in range(n_classes):
        n = counts[cls]
        if n == 0 or n >= target_n:
            continue
        idx = np.where(y == cls)[0]
        needed = target_n - n
        chosen = rng.choice(idx, size=needed, replace=True)
        noise = rng.normal(0, noise_std, size=(needed, X.shape[1])) * feat_std
        X_aug.append(X[chosen] + noise.astype(np.float32))
        y_aug.append(np.full(needed, cls, dtype=y.dtype))
        print(f"[train] oversample class {cls}: {n} -> {n + needed} samples")

    return np.vstack(X_aug), np.concatenate(y_aug)


def cross_val_eval(X, y, n_features, n_classes, seed=42, use_log2=False):
    """Stratified k-fold CV with graceful fallback when classes are tiny.

    Returns averaged accuracy + per-class precision/recall/f1/support.
    The number of folds is bounded by the smallest non-empty class count.
    """
    counts = np.bincount(y, minlength=n_classes)
    present = counts[counts > 0]
    n_splits = max(2, min(5, int(present.min())))
    y_fold = y

    try:
        if len(present) < 2 or int(present.min()) < n_splits:
            raise ValueError("too few samples for StratifiedKFold")
        folds = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed).split(X, y)
    except ValueError:
        folds = KFold(n_splits=n_splits, shuffle=True, random_state=seed).split(X)

    max_feat = "log2" if use_log2 else "sqrt"
    accs = []
    prec = np.zeros(n_classes)
    rec = np.zeros(n_classes)
    f1 = np.zeros(n_classes)
    sup = np.zeros(n_classes)
    fold_reports = []
    confusion_sum = np.zeros((n_classes, n_classes), dtype=int)

    for tr, te in folds:
        clf = RandomForestClassifier(
            n_estimators=300,
            max_features=max_feat,
            class_weight="balanced",
            random_state=seed,
            n_jobs=-1,
        )
        clf.fit(X[tr], y_fold[tr])
        pred = clf.predict(X[te])
        accs.append(accuracy_score(y_fold[te], pred))
        p, r, f, s = precision_recall_fscore_support(
            y_fold[te], pred, labels=list(range(n_classes)), zero_division=0
        )
        prec += p
        rec += r
        f1 += f
        sup += s
        # Per-class recall/f1 dict for reporting.
        fold_reports.append(
            {
                int(k): {"recall": float(rr), "f1": float(ff), "support": int(ss)}
                for k, rr, ff, ss in zip(range(n_classes), r, f, s)
            }
        )
        # Accumulate confusion matrix across folds.
        from sklearn.metrics import confusion_matrix as cm
        confusion_sum += cm(y_fold[te], pred, labels=list(range(n_classes)))

    n_folds = len(accs)
    return {
        "n_folds": n_folds,
        "accuracy": float(np.mean(accs)),
        "accuracy_std": float(np.std(accs)),
        "per_class": {
            int(i): {
                "precision": float(prec[i] / n_folds),
                "recall": float(rec[i] / n_folds),
                "f1": float(f1[i] / n_folds),
                "support": float(sup[i]),
            }
            for i in range(n_classes)
        },
        "confusion_matrix": confusion_sum.tolist(),
        "fold_reports": fold_reports,
    }


def train_and_export(df, features, label_col, name, class_map,
                     oversample=False, use_log2=False):
    """Train a RandomForest on the given features, export to ONNX, return summary.

    Args:
        oversample: if True, apply synthetic minority oversampling before training.
        use_log2:   if True, use log2 max_features (better for wide, correlated feature sets).
    """
    subset = df.dropna(subset=[label_col]).copy()
    subset[label_col] = subset[label_col].astype(int)

    X = subset[features].astype(np.float32).to_numpy()
    y = subset[label_col].to_numpy()

    # Median-impute any NaN from the CSV (also the values exported for ablation).
    col_medians = np.nanmedian(X, axis=0)
    col_medians = np.where(np.isnan(col_medians), 0.0, col_medians)
    if np.isnan(X).any():
        X = np.where(np.isnan(X), col_medians, X)

    counts = np.bincount(y, minlength=len(class_map))
    print(f"[train] {name}: {len(subset)} samples, dist: {counts.tolist()}")
    warn_class_support(name, counts)

    if oversample:
        X, y = oversample_minority(X, y, n_classes=len(class_map))
        counts_aug = np.bincount(y, minlength=len(class_map))
        print(f"[train] {name} after oversample dist: {counts_aug.tolist()}")

    max_feat = "log2" if use_log2 else "sqrt"
    rf = RandomForestClassifier(
        n_estimators=500,
        max_depth=20,
        min_samples_leaf=2,
        max_features=max_feat,
        class_weight="balanced",
        random_state=42,
        n_jobs=-1,
    )
    rf.fit(X, y)

    train_acc = accuracy_score(y, rf.predict(X))
    print(f"[train] {name} train accuracy: {train_acc:.3f}")

    importances = {feat: round(float(imp), 6) for feat, imp in zip(features, rf.feature_importances_)}
    importances = dict(sorted(importances.items(), key=lambda x: x[1], reverse=True))
    warn_dominant_feature(name, importances)

    medians = {feat: float(round(col_medians[i], 6)) for i, feat in enumerate(features)}
    top_features = list(importances.keys())[:8]

    # Holdout-style reported numbers are replaced by stratified k-fold CV.
    # Use original (pre-oversample) X, y for CV to avoid inflated metrics.
    X_orig = subset[features].astype(np.float32).to_numpy()
    y_orig = subset[label_col].to_numpy()
    if np.isnan(X_orig).any():
        X_orig = np.where(np.isnan(X_orig), col_medians, X_orig)
    cv = cross_val_eval(X_orig, y_orig, len(features), len(class_map), use_log2=use_log2)
    print(f"[train] {name} CV accuracy: {cv['accuracy']:.3f} (+/-{cv['accuracy_std']:.3f}) "
          f"over {cv['n_folds']} folds")

    # Export to ONNX.
    initial_types = [("input", FloatTensorType([None, len(features)]))]
    onx = convert_sklearn(rf, initial_types=initial_types, target_opset=17,
                          options={id(rf): {"zipmap": False}})
    onx_path = os.path.join(MODELS, f"{name}.onnx")
    with open(onx_path, "wb") as f:
        f.write(onx.SerializeToString())
    print(f"[train] wrote {onx_path}")

    return {
        "train_accuracy": float(train_acc),
        "cv_accuracy": cv["accuracy"],
        "cv_accuracy_std": cv["accuracy_std"],
        "n_folds": cv["n_folds"],
        "cv_report": cv["per_class"],
        "n_samples": int(len(subset)),
        "class_counts": {str(i): int(counts[i]) for i in range(len(class_map)) if i < len(counts)},
        "feature_importances": importances,
        "medians": medians,
        "top_features": top_features,
    }


def main():
    df = pd.read_csv(CSV)
    for col in ["frp_trend", "frp_early_trend", "avg_frp", "max_frp", "persistence_days"]:
        if col in df.columns:
            df[col] = df[col].fillna(0.0)

    print(f"[train] {len(df)} total rows, schema v{SCHEMA_VERSION}")
    summary = {
        "schema_version": SCHEMA_VERSION,
        "n_samples_total": int(len(df)),
        "behavior_n_features": len(BEHAVIOR_FEATURES),
        "persistence_n_features": len(PERSISTENCE_FEATURES),
        "firetype_n_features": len(FIRETYPE_FEATURES),
    }

    # ---------------- Persistence forecast (3-class) ----------------
    # Oversample "medium" (class 1) and "long" (class 2) — both are badly
    # underrepresented (75 and 17 samples vs 834 for "short").
    p_result = train_and_export(
        df, PERSISTENCE_FEATURES, "persistence_class", "persistence",
        PERSISTENCE_CLASSES, oversample=True,
    )
    summary["persistence"] = p_result

    # ---------------- Behavior (fuel/fire category, 5-class) ----------------
    b_result = train_and_export(
        df, BEHAVIOR_FEATURES, "behavior_class", "behavior", BEHAVIOR_CLASSES,
    )
    summary["behavior"] = b_result

    # ---------------- Firetype (physical-only, 4-class) ----------------
    # Exclude rows with null/unknown firetype_class (ambiguous cells / not trainable).
    # use_log2=True because firetype has 12 features and several are correlated (NDVI bands).
    # Oversample "mining_activity" (class 2) which had only 37 samples.
    df_firetype = df.dropna(subset=["firetype_class"]).copy()
    df_firetype["firetype_class"] = df_firetype["firetype_class"].astype(int)
    # Fill activity_ratio with 0 if missing (not in older dataset exports).
    if "activity_ratio" not in df_firetype.columns:
        df_firetype["activity_ratio"] = 0.0
    ft_result = train_and_export(
        df_firetype, FIRETYPE_FEATURES, "firetype_class", "firetype",
        FIRETYPE_CLASSES, oversample=True, use_log2=True,
    )
    summary["firetype"] = ft_result

    # ---------------- Label maps + feature order ----------------
    label_maps = {
        "schema_version": SCHEMA_VERSION,
        "feature_names": BEHAVIOR_FEATURES,
        "persistence_feature_names": PERSISTENCE_FEATURES,
        "firetype_feature_names": FIRETYPE_FEATURES,
        "persistence_classes": PERSISTENCE_CLASSES,
        "behavior_classes": BEHAVIOR_CLASSES,
        "firetype_classes": FIRETYPE_CLASSES,
    }
    with open(os.path.join(MODELS, "label_maps.json"), "w") as f:
        json.dump(label_maps, f, indent=2)
    print("[train] wrote label_maps.json")

    # ---------------- Feature importances + medians (for ablation) ----------------
    importances_out = {
        "persistence": {
            "importances": p_result["feature_importances"],
            "top_features": p_result["top_features"],
            "medians": p_result["medians"],
        },
        "behavior": {
            "importances": b_result["feature_importances"],
            "top_features": b_result["top_features"],
            "medians": b_result["medians"],
        },
        "firetype": {
            "importances": ft_result["feature_importances"],
            "top_features": ft_result["top_features"],
            "medians": ft_result["medians"],
        },
    }
    with open(os.path.join(MODELS, "feature_importances.json"), "w") as f:
        json.dump(importances_out, f, indent=2)
    print("[train] wrote feature_importances.json")

    # ---------------- Summary metrics ----------------
    with open(os.path.join(MODELS, "metrics.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("[train] wrote metrics.json")
    print("[train] done")


if __name__ == "__main__":
    warnings.simplefilter("always")
    main()
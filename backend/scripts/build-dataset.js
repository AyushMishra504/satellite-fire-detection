// Build the ML training dataset.
//
//   node scripts/build-dataset.js [--no-warm] [--out path]
//
// Warms static context for persistence geocells missing cached context, then
// joins persistence + static features into backend/ml/dataset.csv plus a
// ml_features.json contract (feature order, label maps) for the Node inference
// service. Pass --no-warm to skip the (network) warm pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDataset,
  warmMissingContext,
  ALL_FEATURES,
  FEATURE_NAMES,
  PERSISTENCE_FEATURES,
  FIRETYPE_FEATURES,
  PERSISTENCE_CLASSES,
  BEHAVIOR_CLASSES,
  FIRE_TYPE_CLASSES,
} from '../src/services/mlDataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_DIR = path.resolve(__dirname, '../ml');

const args = process.argv.slice(2);
// Warm pass is ON by default; --no-warm opts out (the help above documents it).
const doWarm = !args.includes('--no-warm');
const outIdx = args.indexOf('--out');
const outArg = outIdx >= 0 ? args[outIdx + 1] : null;
const outDir = outArg ? path.resolve(outArg) : ML_DIR;

fs.mkdirSync(outDir, { recursive: true });

// The remote ESA GeoTIFF fetch can throw detached rejections (ECONNRESET under
// load). Don't let one async failure kill the whole dataset build.
process.on('unhandledRejection', (reason) => {
  console.warn('[dataset] ignored unhandled rejection:', reason?.message || reason);
});

async function main() {
  if (doWarm) {
    console.log('[dataset] Warming static context...');
    const warm = await warmMissingContext();
    console.log(`[dataset] ${warm.missing} missing, ${warm.filled} filled.`);
  }

  const rows = buildDataset();
  if (rows.length === 0) {
    console.error('[dataset] No rows produced — nothing to train on.');
    process.exit(1);
  }

  const csvPath = path.join(outDir, 'dataset.csv');
  const header = [
    ...ALL_FEATURES,
    'persistence_class',
    'persistence_days',
    'behavior_class',
    'behavior_cat',
    'firetype_class',
    'firetype_cat',
    'lat',
    'lon',
  ];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => escape(r[h])).join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'));

  const meta = {
    feature_names: FEATURE_NAMES,
    persistence_feature_names: PERSISTENCE_FEATURES,
    firetype_feature_names: FIRETYPE_FEATURES,
    persistence_classes: PERSISTENCE_CLASSES,
    behavior_classes: BEHAVIOR_CLASSES,
    firetype_classes: FIRE_TYPE_CLASSES,
    schema_version: 3,
    backfill_window_days: undefined,
    row_count: rows.length,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'ml_features.json'), JSON.stringify(meta, null, 2));

  // Distribution summary.
  const pDist = {};
  const bDist = {};
  const fDist = {};
  for (const r of rows) {
    pDist[r.persistence_class] = (pDist[r.persistence_class] || 0) + 1;
    bDist[r.behavior_class] = (bDist[r.behavior_class] || 0) + 1;
    if (r.firetype_cat) fDist[r.firetype_cat] = (fDist[r.firetype_cat] || 0) + 1;
  }
  console.log(`[dataset] Wrote ${rows.length} rows -> ${csvPath}`);
  console.log('[dataset] persistence class dist:', JSON.stringify(pDist));
  console.log('[dataset] behavior class dist:', JSON.stringify(bDist));
  console.log('[dataset] firetype class dist:', JSON.stringify(fDist));
}

main().catch((err) => {
  console.error('[dataset] Failed:', err);
  process.exit(1);
});

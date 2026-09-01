import express from 'express';
import { classifyGeocell, getMlStatus, isMlReady } from '../services/mlInference.js';

const router = express.Router();

// GET /api/ml/status
router.get('/status', (req, res) => {
  res.status(200).json(getMlStatus());
});

// POST /api/ml/predict  body: { latitude, longitude }
router.post('/predict', async (req, res) => {
  const lat = Number(req.body?.latitude);
  const lon = Number(req.body?.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Body must include numeric 'latitude' and 'longitude'." });
  }

  if (!isMlReady()) {
    return res.status(503).json({ error: 'ML models not loaded', detail: getMlStatus().error });
  }

  try {
    const result = await classifyGeocell(lat, lon);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'ML prediction failed' });
  }
});

// POST /api/ml/predict/batch  body: { points: [{latitude, longitude}, ...] }
// Returns predictions for many geocells (used to color timeline markers).
// Processes cells with limited concurrency and bounds the batch size so a very
// large request can never run away and time out the connection.
const BATCH_CONCURRENCY = 8;
const BATCH_MAX_CELLS = 300;

router.post('/predict/batch', async (req, res) => {
  const points = Array.isArray(req.body?.points) ? req.body.points : [];

  if (points.length === 0) {
    return res.status(200).json({ results: [] });
  }
  if (!isMlReady()) {
    return res.status(503).json({ error: 'ML models not loaded', detail: getMlStatus().error });
  }

  // Dedupe identical rounded geocells to avoid redundant inference.
  const seen = new Map();
  for (const p of points) {
    const lat = Math.round(Number(p?.latitude) * 100) / 100;
    const lon = Math.round(Number(p?.longitude) * 100) / 100;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      seen.set(`${lat},${lon}`, { lat, lon });
    }
  }

  const cells = [...seen.values()];
  if (cells.length > BATCH_MAX_CELLS) {
    cells.length = BATCH_MAX_CELLS;
  }
  const omitted = seen.size > cells.length ? seen.size - cells.length : 0;

  const results = new Array(cells.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < cells.length) {
      const idx = cursor++;
      const { lat, lon } = cells[idx];
      try {
        const r = await classifyGeocell(lat, lon);
        results[idx] = { lat, lon, ...r };
      } catch (e) {
        results[idx] = { lat, lon, error: e.message };
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, cells.length) }, worker));
    return res.status(200).json({ results, omitted });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch prediction failed' });
  }
});

export default router;

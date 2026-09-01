import express from 'express';
import { getDetections } from '../services/firmsService.js';
import { recordCurrent } from '../services/persistenceService.js';

const router = express.Router();

// GET /detections
router.get('/', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const result = await getDetections(forceRefresh);
    // Keep the persistence tracker current: today's FIRMS hotspots are merged
    // into the per-geocell history (idempotent per date) so the timeline slider
    // never goes stale while the server is running.
    recordCurrent(result.data);
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 500;
    return res.status(statusCode).json({
      error: error.message || 'Internal server error while fetching detections',
      status: statusCode,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

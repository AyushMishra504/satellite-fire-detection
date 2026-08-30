import express from 'express';
import { getDetections } from '../services/firmsService.js';

const router = express.Router();

// GET /detections
router.get('/', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const result = await getDetections(forceRefresh);
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

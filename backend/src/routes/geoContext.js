import express from 'express';
import { getOsmContext } from '../services/osmContext.js';

const router = express.Router();

// GET /api/geo-context?lat=&lon=
router.get('/', async (req, res) => {
  const { lat, lon } = req.query;

  // Validate parameters presence
  if (lat === undefined || lon === undefined || lat === null || lon === null || lat === '' || lon === '') {
    return res.status(400).json({
      error: "Query parameters 'lat' and 'lon' are required.",
    });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  // Validate numeric float and coordinate bounds
  if (isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    return res.status(400).json({
      error: "Query parameters 'lat' and 'lon' must be valid numeric coordinates.",
    });
  }

  try {
    const context = await getOsmContext(latNum, lonNum);
    return res.status(200).json(context);
  } catch (error) {
    return res.status(502).json({
      error: error.message || 'Failed to retrieve OSM ground context',
    });
  }
});

export default router;

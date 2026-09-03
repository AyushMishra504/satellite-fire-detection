import express from 'express';

import { getOsmContext } from '../services/osmContext.js';
import { getFacilitySummary } from '../services/facilityContext.js';

const router = express.Router();

// GET /api/geo-context?lat=&lon=
router.get('/', async (req, res) => {
  const { lat, lon } = req.query;

  // Validate parameters presence
  if (
    lat === undefined ||
    lon === undefined ||
    lat === null ||
    lon === null ||
    lat === '' ||
    lon === ''
  ) {
    return res.status(400).json({
      error: "Query parameters 'lat' and 'lon' are required.",
    });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  // Validate numeric values and coordinate bounds
  if (
    isNaN(latNum) ||
    isNaN(lonNum) ||
    latNum < -90 ||
    latNum > 90 ||
    lonNum < -180 ||
    lonNum > 180
  ) {
    return res.status(400).json({
      error: "Query parameters 'lat' and 'lon' must be valid numeric coordinates.",
    });
  }

  try {
    // Get OSM ground context
    const context = await getOsmContext(latNum, lonNum);

    // Get nearby facility information
    // This is a synchronous SQLite lookup, so it is inexpensive.
    let facilities = {
      medical: null,
      fire_station: null,
    };

    try {
      facilities = getFacilitySummary(latNum, lonNum, 10);
    } catch (err) {
      console.warn(
        `[geoContext] Facility lookup failed for (${latNum}, ${lonNum}): ${err.message}`
      );
    }

    // Return both OSM context and facility information
    return res.status(200).json({
      ...context,
      facilities,
    });

  } catch (error) {
    return res.status(502).json({
      error: error.message || 'Failed to retrieve OSM ground context',
    });
  }
});

export default router;
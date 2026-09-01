import express from 'express';
import { getAllSources, BACKFILL_WINDOW_DAYS } from '../db/sourceCache.js';

const router = express.Router();

// GET /api/persistence/sources
// Returns all tracked persistent sources with their per-day history, plus the
// sorted list of dates available for the time slider.
router.get('/sources', (req, res) => {
  try {
    const sources = getAllSources();

    // Distinct dates across all sources, sorted ascending (used for the slider).
    const dateSet = new Set();
    for (const s of sources) {
      for (const d of s.seen_dates || []) dateSet.add(d);
    }

    // Always ensure the timeline reaches "today", even on the (common) day the
    // FIRMS pull has no detections yet — the slider should end at today.
    dateSet.add(new Date().toISOString().slice(0, 10));

    const availableDates = [...dateSet].sort();

    return res.status(200).json({
      windowDays: BACKFILL_WINDOW_DAYS,
      availableDates,
      sources,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Failed to retrieve persistent thermal sources',
    });
  }
});

export default router;

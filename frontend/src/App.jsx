import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import FireMap from './components/FireMap';
import DetailPanel from './components/DetailPanel';
import TimeSliderBar from './components/TimeSliderBar';
import FilterLegend from './components/FilterLegend';
import { getHotspotId, getContextKey, geocellKey, FIRETYPE_TYPES, PERSISTENCE_TYPES } from './components/utils';

export default function App() {
  const [detections, setDetections] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedHotspot, setSelectedHotspot] = useState(null);
  const [groundContextCache, setGroundContextCache] = useState({});
  const [groundContextLoadingKey, setGroundContextLoadingKey] = useState(null);
  const [detailHotspot, setDetailHotspot] = useState(null);
  const [isDetailPanelOpen, setIsDetailPanelOpen] = useState(false);
  const [persistenceSources, setPersistenceSources] = useState([]);
  const [availableDates, setAvailableDates] = useState([]);
  const [persistenceLoading, setPersistenceLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);
  const [minPersistence, setMinPersistence] = useState(0);
  const [mlRiskByCell, setMlRiskByCell] = useState({});
  const [firetypeByCell, setFiretypeByCell] = useState({});
  const [enabledFiretypes, setEnabledFiretypes] = useState(() => new Set(FIRETYPE_TYPES));
  const [enabledRisk, setEnabledRisk] = useState(() => new Set(PERSISTENCE_TYPES));
  const mlRiskCacheRef = useRef({});
  const firetypeCacheRef = useRef({});
  const attemptedCellsRef = useRef(new Set());
  const previousHotspotIdsRef = useRef(new Set());
  const hasLoadedDetectionsRef = useRef(false);
  const selectionRequestRef = useRef(0);
  const groundContextCacheRef = useRef({});
  const inFlightKeysRef = useRef(new Set());
  const preloadQueueRef = useRef([]);
  const bgActiveRef = useRef(false);

  const fetchDetections = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      // Use relative path (proxied by Vite) or fallback to localhost:5000
      const endpoint = forceRefresh ? '/detections?refresh=true' : '/detections';
      const response = await fetch(endpoint);
      
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `Server responded with status ${response.status}`);
      }

      const nextDetections = payload.data || [];
      const nextIds = new Set(nextDetections.map(getHotspotId));

      if (forceRefresh && hasLoadedDetectionsRef.current) {
        // No list UI anymore; refs are kept only to support future dedup logic.
      }

      previousHotspotIdsRef.current = nextIds;
      hasLoadedDetectionsRef.current = true;
      setDetections(nextDetections);
      setLastUpdated(payload.lastUpdated ? new Date(payload.lastUpdated) : new Date());
      setCached(Boolean(payload.cached));
    } catch (err) {
      console.error('Failed to load FIRMS detections:', err);
      setError(err.message || 'Unable to connect to detections backend');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDetections();
  }, [fetchDetections]);

  // Load persistent-source history once for the time slider.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/persistence/sources');
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `Server responded with status ${response.status}`);
        }
        if (cancelled) return;
        setPersistenceSources(payload.sources || []);
        const dates = payload.availableDates || [];
        setAvailableDates(dates);
        // Default the slider to the most recent available date.
        setSelectedDay((prev) => prev || (dates.length ? dates[dates.length - 1] : null));
      } catch (err) {
        console.error('Failed to load persistence sources:', err);
      } finally {
        if (!cancelled) setPersistenceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Time slider: pure client-side rendering. For the selected day we show each
  // geocell's position with that day's FRP; "persistent" is a per-location
  // property computed once (persistence_days threshold), so the badge is
  // carried regardless of the day being viewed.
  const timelineSources = useMemo(() => {
    if (!selectedDay) return [];
    return persistenceSources
      .filter((s) => (s.seen_dates || []).includes(selectedDay))
      .filter((s) => s.persistence_days >= minPersistence)
      .map((s) => ({
        lat: s.lat,
        lon: s.lon,
        latitude: s.lat,
        longitude: s.lon,
        frp: (s.frp_by_date && s.frp_by_date[selectedDay]) || 0,
        acq_date: selectedDay,
        acq_time: '0000',
        is_persistent: Boolean(s.is_persistent),
        persistence_days: s.persistence_days,
      }));
  }, [persistenceSources, selectedDay, minPersistence]);

  const timelineCount = timelineSources.length;

  // Helper: given an array of points, returns the geocells still missing ML
  // predictions (persistence + firetype), deduplicated. Cells that were already
  // attempted (permanently failed or returned unknown) are skipped so they stop
  // being re-requested on every render — combined with the unified geocellKey
  // format this removes the previous infinite re-request loop for ~18% of cells.
  const missingPredictions = useCallback((points) => {
    const missing = [];
    const seen = new Set();
    for (const p of points) {
      const key = geocellKey(p.latitude, p.longitude);
      if (seen.has(key)) continue;
      seen.add(key);
      if (attemptedCellsRef.current.has(key)) continue;
      const hasRisk = mlRiskCacheRef.current[key];
      const hasFt = firetypeCacheRef.current[key];
      if (!hasRisk || !hasFt) missing.push({ latitude: p.latitude, longitude: p.longitude });
    }
    return missing;
  }, []);

  // Fetches batch predictions for the given points and stores results into the
  // risk + firetype cell caches. Runs inside useEffect; cancellation handled by
  // the effect's own cleanup (cancelled flag), never returned as a Promise.
  // Large point sets are split into chunks sent with limited concurrency so a
  // single oversized request can't stall/timing-out the dev proxy.
  const BATCH_CHUNK = 50;
  const BATCH_CHUNK_CONCURRENCY = 4;

  const runBatchPredictions = useCallback(async (points, cancelledRef) => {
    if (!points || points.length === 0) return;
    const chunks = [];
    for (let i = 0; i < points.length; i += BATCH_CHUNK) {
      chunks.push(points.slice(i, i + BATCH_CHUNK));
    }

    const sendChunk = async (chunk, depth = 0) => {
      if (cancelledRef.current) return;
      const res = await fetch('/api/ml/predict/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: chunk }),
      });

      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (!res.ok) {
        let detail = `Status ${res.status}`;
        if (isJson) {
          try {
            detail = (await res.json()).error || detail;
          } catch {
            /* ignore bad payload */
          }
        }
        throw new Error(`ML batch failed: ${detail}`);
      }
      if (!isJson) throw new Error('ML batch returned empty/non-JSON response');

      const payload = await res.json();
      if (cancelledRef.current) return;
      const addedRisk = {};
      const addedFiretype = {};
      const processedKeys = new Set();
      for (const r of payload.results || []) {
        const key = geocellKey(r.lat, r.lon);
        if (r.error) {
          // Permanent per-cell failure — stop re-requesting this cell.
          attemptedCellsRef.current.add(key);
          continue;
        }
        processedKeys.add(key);
        const label = r.persistence?.label;
        const ftLabel = r.firetype?.label;
        if (label && !addedRisk[key]) {
          mlRiskCacheRef.current[key] = label;
          addedRisk[key] = label;
        }
        if (ftLabel && !addedFiretype[key]) {
          firetypeCacheRef.current[key] = ftLabel;
          addedFiretype[key] = ftLabel;
        }
        if (!label && !ftLabel) {
          // Backend answered but supplied no usable labels — avoid re-request loop.
          attemptedCellsRef.current.add(key);
        }
      }
      if (Object.keys(addedRisk).length > 0) {
        setMlRiskByCell((prev) => ({ ...prev, ...addedRisk }));
      }
      if (Object.keys(addedFiretype).length > 0) {
        setFiretypeByCell((prev) => ({ ...prev, ...addedFiretype }));
      }

      // Server capped its batch (omitted > 0). Re-request the cells this response
      // didn't cover (those whose geocell is not among the processed results).
      if (payload.omitted > 0 && depth < 3) {
        const unprocessed = chunk.filter(
          (p) => !processedKeys.has(geocellKey(p.latitude, p.longitude))
        );
        if (unprocessed.length > 0) {
          await sendChunk(unprocessed, depth + 1);
        }
      }
    };

    // Run chunks with limited concurrency.
    let chunkCursor = 0;
    const worker = async () => {
      while (chunkCursor < chunks.length && !cancelledRef.current) {
        const idx = chunkCursor++;
        try {
          await sendChunk(chunks[idx]);
        } catch (err) {
          console.error('[ML] batch chunk failed:', err.message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CHUNK_CONCURRENCY, chunks.length) }, worker)
    );
  }, []);

  // Predict firetype + persistence for LIVE detections so markers are colored
  // by fire type on the map (not just timeline sources).
  useEffect(() => {
    const missing = missingPredictions(detections);
    if (missing.length === 0) return;
    const cancelledRef = { current: false };
    // eslint-disable-next-line no-floating-promises
    runBatchPredictions(missing, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [detections, missingPredictions, runBatchPredictions]);

  // Batch-predict firetype + persistence for the visible timeline geocells,
  // cached per geocell so scrubbing the slider never re-fetches.
  useEffect(() => {
    const missing = missingPredictions(timelineSources);
    if (missing.length === 0) return;
    const cancelledRef = { current: false };
    // eslint-disable-next-line no-floating-promises
    runBatchPredictions(missing, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [timelineSources, missingPredictions, runBatchPredictions]);


  // Match the currently inspected hotspot to its persistence record (per-location
  // property, keyed by the rounded geocell) so the details panel can show how
  // many days this location has been active.
  const detailPersistenceSource = useMemo(() => {
    if (!detailHotspot) return null;
    const lat = Math.round(Number(detailHotspot.latitude) * 100) / 100;
    const lon = Math.round(Number(detailHotspot.longitude) * 100) / 100;
    return persistenceSources.find((s) => s.lat === lat && s.lon === lon) || null;
  }, [detailHotspot, persistenceSources]);


  const selectHotspot = useCallback((detection) => {
    selectionRequestRef.current += 1;
    setSelectedHotspot({
      id: getHotspotId(detection),
      requestId: selectionRequestRef.current,
    });
  }, []);

  // Saves both state-and-ref copies so the background queue can read the freshest
  // cache without stale-closure issues.
  const cacheGroundContext = useCallback((contextKey, payload) => {
    groundContextCacheRef.current[contextKey] = payload;
    setGroundContextCache((current) => ({ ...current, [contextKey]: payload }));
  }, []);

  // Core fetch for a single detection. When `setLoading` is true the key is
  // surfaced as the active loading key (drives popup/panel loading indicators);
  // background preloads pass false so they never steal the indicator.
  const fetchGroundContext = useCallback(
    async (detection, { setLoading = false } = {}) => {
      const contextKey = getContextKey(detection);
      if (inFlightKeysRef.current.has(contextKey)) return;
      if (setLoading) setGroundContextLoadingKey(contextKey);
      inFlightKeysRef.current.add(contextKey);
      try {
        const response = await fetch(
          `/api/geo-context?lat=${detection.latitude}&lon=${detection.longitude}`
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `Server responded with status ${response.status}`);
        }
        cacheGroundContext(contextKey, payload);
      } finally {
        inFlightKeysRef.current.delete(contextKey);
        if (setLoading) {
          setGroundContextLoadingKey((current) => (current === contextKey ? null : current));
        }
      }
    },
    [cacheGroundContext]
  );

  // Processes the background pre-load queue one item at a time. Runs alongside
  // (never blocking) user-initiated fetches, which start their own request on
  // click and therefore jump the priority queue automatically.
  const processPreloadQueue = useCallback(async () => {
    if (bgActiveRef.current) return;
    bgActiveRef.current = true;
    try {
      while (preloadQueueRef.current.length > 0) {
        const detection = preloadQueueRef.current.shift();
        const key = getContextKey(detection);
        if (groundContextCacheRef.current[key] || inFlightKeysRef.current.has(key)) {
          continue;
        }
        await fetchGroundContext(detection, { setLoading: false });
      }
    } finally {
      bgActiveRef.current = false;
    }
  }, [fetchGroundContext]);

  // Enqueue every hotspot (live + ALL historical persistence locations) not yet
  // loaded/cached for background pre-fetching, so ground context is ready by the
  // time any marker is clicked — regardless of which day the slider is on.
  useEffect(() => {
    const queuedKeys = new Set(preloadQueueRef.current.map(getContextKey));
    const candidates = [
      ...detections,
      ...persistenceSources.map((s) => ({ latitude: s.lat, longitude: s.lon })),
    ];
    candidates.forEach((detection) => {
      const key = getContextKey(detection);
      if (groundContextCacheRef.current[key] || inFlightKeysRef.current.has(key)) return;
      if (queuedKeys.has(key)) return;
      preloadQueueRef.current.push(detection);
    });
    processPreloadQueue();
  }, [detections, persistenceSources, processPreloadQueue]);

  // User-initiated load (marker click / popup). Fetches now, ahead of the queue.
  const loadGroundContext = useCallback(
    (detection) => {
      const key = getContextKey(detection);
      if (groundContextCacheRef.current[key]) return;
      fetchGroundContext(detection, { setLoading: true });
    },
    [fetchGroundContext]
  );

  // Opens the right-side details panel for a hotspot, ensuring its ground
  // context loads with priority (and shows its loading state).
  const showMoreDetails = useCallback(
    (detection) => {
      setDetailHotspot(detection);
      setIsDetailPanelOpen(true);
      loadGroundContext(detection);
    },
    [loadGroundContext]
  );

  const closeDetailsPanel = useCallback(() => {
    setIsDetailPanelOpen(false);
    setDetailHotspot(null);
  }, []);

  // Filtering: whether the user has narrowed the visible fire types/risks.
  const allTypesEnabled = enabledFiretypes.size === FIRETYPE_TYPES.length;
  const allRiskEnabled = enabledRisk.size === PERSISTENCE_TYPES.length;
  const filteringActive = !allTypesEnabled || !allRiskEnabled;

  // A point passes the filter when (no filter active) or (its predictions match
  // the enabled sets). Points without a prediction are hidden while filtering.
  const passesFilter = useCallback(
    (lat, lon) => {
      const key = geocellKey(lat, lon);
      const ft = firetypeByCell[key];
      const risk = mlRiskByCell[key];

      if (allTypesEnabled && allRiskEnabled) return true;
      if (!allTypesEnabled) {
        if (!ft || !enabledFiretypes.has(ft)) return false;
      }
      if (!allRiskEnabled) {
        if (!risk || !enabledRisk.has(risk)) return false;
      }
      return true;
    },
    [enabledFiretypes, enabledRisk, firetypeByCell, mlRiskByCell, allTypesEnabled, allRiskEnabled]
  );

  const filteredDetections = useMemo(() => {
    if (!filteringActive) return detections;
    return detections.filter((d) => passesFilter(d.latitude, d.longitude));
  }, [detections, filteringActive, passesFilter]);

  const filteredTimelineSources = useMemo(() => {
    if (!filteringActive) return timelineSources;
    return timelineSources.filter((ts) => passesFilter(ts.lat, ts.lon));
  }, [timelineSources, filteringActive, passesFilter]);

  const toggleFiretype = useCallback((ft) => {
    setEnabledFiretypes((prev) => {
      const next = new Set(prev);
      if (next.has(ft)) next.delete(ft);
      else next.add(ft);
      return next;
    });
  }, []);

  const toggleRisk = useCallback((risk) => {
    setEnabledRisk((prev) => {
      const next = new Set(prev);
      if (next.has(risk)) next.delete(risk);
      else next.add(risk);
      return next;
    });
  }, []);

  // Format timestamp for display
  const formatTimestamp = (date) => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      ' (' + date.toLocaleDateString() + ')';
  };

  return (
    <div className="app-container">
      <section className="dashboard-panel">
        <header className="overlay-header">
          <h1>Thermal Anomaly & Fire Detection</h1>
          
          <div className="status-bar">
            <span className="badge badge-count">
              {detections.length} Hotspots
            </span>

            <span className={`badge ${cached ? 'badge-cached' : 'badge-live'}`}>
              {cached ? 'Cached (15m TTL)' : 'Live FIRMS Data'}
            </span>

            <button
              className="refresh-btn"
              onClick={() => fetchDetections(true)}
              disabled={loading}
            >
              {loading ? 'Refreshing...' : '↻ Refresh Data'}
            </button>
          </div>

          <div className="last-ingested">
            <strong>Last Ingested:</strong> {lastUpdated ? formatTimestamp(lastUpdated) : 'Loading...'}
          </div>
        </header>
      </section>


      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <strong>Backend Error:</strong> {error}
        </div>
      )}

      {/* Map visualization */}
      <FireMap
        detections={filteredDetections}
        selectedHotspot={selectedHotspot}
        onHotspotSelected={selectHotspot}
        onLoadGroundContext={loadGroundContext}
        onShowMoreDetails={showMoreDetails}
        timelineSources={filteredTimelineSources}
        timelineMinPersistence={minPersistence}
        mlRiskByCell={mlRiskByCell}
        firetypeByCell={firetypeByCell}
      />

      {/* Time slider over persistence history */}
      <TimeSliderBar
        availableDates={availableDates}
        selectedDay={selectedDay}
        onDayChange={setSelectedDay}
        sourceCount={timelineCount}
        loading={persistenceLoading}
        minPersistence={minPersistence}
        onMinPersistenceChange={setMinPersistence}
      />

      {/* Right-side details panel */}
      {isDetailPanelOpen && (
        <DetailPanel
          detailHotspot={detailHotspot}
          groundData={
            detailHotspot
              ? groundContextCache[getContextKey(detailHotspot)]
              : null
          }
          persistenceSource={detailPersistenceSource}
          isLoading={
            detailHotspot
              ? groundContextLoadingKey === getContextKey(detailHotspot)
              : false
          }
          onClose={closeDetailsPanel}
        />
      )}


      {/* Map Legend + Filters */}
      <FilterLegend
        enabledFiretypes={enabledFiretypes}
        enabledRisk={enabledRisk}
        onToggleFiretype={toggleFiretype}
        onToggleRisk={toggleRisk}
      />
    </div>
  );
}

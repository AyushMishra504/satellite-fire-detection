import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import FireMap from './components/FireMap';
import DetailPanel from './components/DetailPanel';

function getHotspotId(detection) {
  return [
    detection.latitude,
    detection.longitude,
    detection.acq_date,
    detection.acq_time,
    detection.satellite,
    detection.instrument,
  ].join('|');
}

function formatDetectionTime(detection) {
  const time = String(detection.acq_time || '').padStart(4, '0');
  return `${detection.acq_date} ${time.slice(0, 2)}:${time.slice(2)} UTC`;
}

function getContextKey(detection) {
  const lat = Math.round(Number(detection.latitude) * 100) / 100;
  const lon = Math.round(Number(detection.longitude) * 100) / 100;
  return `${lat},${lon}`;
}

export default function App() {
  const [detections, setDetections] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isHotspotPanelCollapsed, setIsHotspotPanelCollapsed] = useState(true);
  const [newHotspotIds, setNewHotspotIds] = useState(new Set());
  const [selectedHotspot, setSelectedHotspot] = useState(null);
  const [groundContextCache, setGroundContextCache] = useState({});
  const [groundContextLoadingKey, setGroundContextLoadingKey] = useState(null);
  const [detailHotspot, setDetailHotspot] = useState(null);
  const [isDetailPanelOpen, setIsDetailPanelOpen] = useState(false);
  const previousHotspotIdsRef = useRef(new Set());
  const hasLoadedDetectionsRef = useRef(false);
  const newHotspotTimerRef = useRef(null);
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
        const addedIds = new Set(
          [...nextIds].filter((id) => !previousHotspotIdsRef.current.has(id))
        );

        if (newHotspotTimerRef.current) clearTimeout(newHotspotTimerRef.current);
        setNewHotspotIds(addedIds);
        if (addedIds.size > 0) {
          newHotspotTimerRef.current = setTimeout(() => {
            setNewHotspotIds(new Set());
          }, 3500);
        }
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

  useEffect(() => () => {
    if (newHotspotTimerRef.current) clearTimeout(newHotspotTimerRef.current);
  }, []);

  const sortedDetections = useMemo(
    () => [...detections].sort((a, b) => {
      const aTime = `${a.acq_date || ''}${String(a.acq_time || '').padStart(4, '0')}`;
      const bTime = `${b.acq_date || ''}${String(b.acq_time || '').padStart(4, '0')}`;
      return bTime.localeCompare(aTime);
    }),
    [detections]
  );

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

  // Enqueue every hotspot not yet loaded/cached for background pre-fetching.
  useEffect(() => {
    const queuedKeys = new Set(preloadQueueRef.current.map(getContextKey));
    detections.forEach((detection) => {
      const key = getContextKey(detection);
      if (groundContextCacheRef.current[key] || inFlightKeysRef.current.has(key)) return;
      if (queuedKeys.has(key)) return;
      preloadQueueRef.current.push(detection);
    });
    processPreloadQueue();
  }, [detections, processPreloadQueue]);

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

          <button
            className="header-hotspot-toggle"
            type="button"
            onClick={() => setIsHotspotPanelCollapsed((collapsed) => !collapsed)}
            aria-expanded={!isHotspotPanelCollapsed}
            aria-label={isHotspotPanelCollapsed ? 'Show dashboard details' : 'Hide dashboard details'}
          >
            {isHotspotPanelCollapsed ? '⌄' : '⌃'}
          </button>
        </header>

        {!isHotspotPanelCollapsed && (
          <div className="dashboard-body">
            <section className="hotspot-panel">
              <div className="hotspot-panel-header">Hotspots ({detections.length})</div>
              <div className="hotspot-list">
                {sortedDetections.map((detection, index) => {
                  const hotspotId = getHotspotId(detection);
                  return (
                    <button
                      className={`hotspot-list-item ${newHotspotIds.has(hotspotId) ? 'is-new' : ''}`}
                      key={`${hotspotId}-${index}`}
                      type="button"
                      onClick={() => selectHotspot(detection)}
                    >
                      <div className="hotspot-list-time">{formatDetectionTime(detection)}</div>
                      <div className="hotspot-list-details">
                        <span>{Number(detection.frp || 0).toFixed(1)} MW</span>
                        <span>{Number(detection.latitude).toFixed(3)}, {Number(detection.longitude).toFixed(3)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </section>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <strong>Backend Error:</strong> {error}
        </div>
      )}

      {/* Map visualization */}
      <FireMap
        detections={detections}
        selectedHotspot={selectedHotspot}
        onHotspotSelected={selectHotspot}
        groundContextCache={groundContextCache}
        groundContextLoadingKey={groundContextLoadingKey}
        onLoadGroundContext={loadGroundContext}
        onShowMoreDetails={showMoreDetails}
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
          isLoading={
            detailHotspot
              ? groundContextLoadingKey === getContextKey(detailHotspot)
              : false
          }
          onClose={closeDetailsPanel}
        />
      )}


      {/* Map Legend */}
      <div className="legend-card">
        <div className="legend-title">Fire Radiative Power (MW)</div>
        <div className="legend-item">
          <span className="legend-circle" style={{ width: 11.5, height: 11.5, background: '#dc2626' }}></span>
          <span>&gt; 25 MW (Intense)</span>
        </div>
        <div className="legend-item">
          <span className="legend-circle" style={{ width: 9.5, height: 9.5, background: '#ea580c' }}></span>
          <span>10 - 25 MW (Moderate)</span>
        </div>
        <div className="legend-item">
          <span className="legend-circle" style={{ width: 8.5, height: 8.5, background: '#f59e0b' }}></span>
          <span>5 - 10 MW (Low)</span>
        </div>
        <div className="legend-item">
          <span className="legend-circle" style={{ width: 7, height: 7, background: '#eab308' }}></span>
          <span>&lt; 5 MW (Minor)</span>
        </div>
      </div>
    </div>
  );
}

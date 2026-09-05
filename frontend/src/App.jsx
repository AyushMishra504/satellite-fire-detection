import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import FireMap from './components/FireMap';
import DetailPanel from './components/DetailPanel';
import TimeSliderBar from './components/TimeSliderBar';
import FilterLegend from './components/FilterLegend';
import ReportModal from './components/ReportModal';
import { getHotspotId, getContextKey, geocellKey, FIRETYPE_TYPES, PERSISTENCE_TYPES } from './components/utils';

/* ── SVG icon helpers (inline — no extra dep) ── */
const Icon = {
  Crosshair: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/>
      <line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/>
      <line x1="12" y1="22" x2="12" y2="18"/>
    </svg>
  ),
  Search: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  Filter: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  ),
  ChevronDown: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  ),
  ChevronLeft: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  ),
  ChevronRight: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  ),
  RefreshCw: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
  ),
  Radio: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>
    </svg>
  ),
  Signal: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="6" x2="1" y2="18"/><line x1="6" y1="3" x2="6" y2="21"/>
      <line x1="11" y1="8" x2="11" y2="16"/><line x1="16" y1="5" x2="16" y2="19"/>
      <line x1="21" y1="10" x2="21" y2="14"/>
    </svg>
  ),
  MapPin: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
    </svg>
  ),
  ShieldAlert: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
  Layers: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  Play: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ),
  Pause: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
    </svg>
  ),
};

/* ── severity colour helpers matching thermal-sentinel style ── */
function getSeverityFromFRP(frp) {
  if (frp >= 100) return 'critical';
  if (frp >= 30) return 'high';
  return 'medium';
}

const INDIAN_REGIONS = {
  'andaman': { center: [11.667, 92.735], zoom: 7, bounds: [[6.5, 92.0], [14.0, 94.0]] },
  'andhra pradesh': { center: [15.9129, 79.7400], zoom: 7, bounds: [[12.5, 76.5], [19.2, 84.8]] },
  'arunachal pradesh': { center: [28.2180, 94.7278], zoom: 7, bounds: [[26.5, 91.5], [29.5, 97.5]] },
  'assam': { center: [26.2006, 92.9376], zoom: 7, bounds: [[24.0, 89.5], [28.0, 96.0]] },
  'bihar': { center: [25.0961, 85.3131], zoom: 7, bounds: [[24.2, 83.3], [27.5, 88.3]] },
  'chhattisgarh': { center: [21.2787, 81.8661], zoom: 7, bounds: [[17.7, 80.2], [24.1, 84.4]] },
  'delhi': { center: [28.7041, 77.1025], zoom: 10, bounds: [[28.3, 76.8], [28.9, 77.4]] },
  'goa': { center: [15.2993, 74.1240], zoom: 9, bounds: [[14.8, 73.6], [15.8, 74.4]] },
  'gujarat': { center: [22.2587, 71.1924], zoom: 7, bounds: [[20.0, 68.0], [24.7, 74.5]] },
  'haryana': { center: [29.0588, 76.0856], zoom: 7, bounds: [[27.6, 74.4], [30.9, 77.6]] },
  'himachal pradesh': { center: [31.1048, 77.1734], zoom: 7, bounds: [[30.3, 75.5], [33.3, 79.0]] },
  'jammu': { center: [33.7782, 76.5762], zoom: 7, bounds: [[32.2, 73.5], [37.2, 80.5]] },
  'kashmir': { center: [34.0837, 74.7973], zoom: 7, bounds: [[32.2, 73.5], [37.2, 80.5]] },
  'jharkhand': { center: [23.6102, 85.2799], zoom: 7, bounds: [[21.9, 83.3], [25.3, 87.9]] },
  'karnataka': { center: [15.3173, 75.7139], zoom: 7, bounds: [[11.5, 74.0], [18.5, 78.6]] },
  'kerala': { center: [10.8505, 76.2711], zoom: 7, bounds: [[8.2, 74.8], [12.8, 77.5]] },
  'ladakh': { center: [34.1526, 77.5771], zoom: 7, bounds: [[32.0, 75.0], [36.0, 80.0]] },
  'madhya pradesh': { center: [22.9734, 78.6569], zoom: 6, bounds: [[21.0, 74.0], [26.9, 82.8]] },
  'maharashtra': { center: [19.7515, 75.7139], zoom: 6, bounds: [[15.6, 72.5], [22.0, 80.9]] },
  'manipur': { center: [24.6637, 93.9063], zoom: 8, bounds: [[23.8, 92.9], [25.7, 94.8]] },
  'meghalaya': { center: [25.4670, 91.3662], zoom: 8, bounds: [[25.0, 89.8], [26.1, 92.8]] },
  'mizoram': { center: [23.1645, 92.9376], zoom: 8, bounds: [[21.9, 92.2], [24.5, 93.5]] },
  'nagaland': { center: [26.1584, 94.5624], zoom: 8, bounds: [[25.1, 93.3], [27.0, 95.3]] },
  'odisha': { center: [20.9517, 85.0985], zoom: 7, bounds: [[17.8, 81.3], [22.6, 87.5]] },
  'punjab': { center: [31.1471, 75.3412], zoom: 7, bounds: [[29.5, 73.8], [32.5, 76.9]] },
  'rajasthan': { center: [27.0238, 74.2179], zoom: 6, bounds: [[23.0, 69.5], [30.2, 78.3]] },
  'sikkim': { center: [27.5330, 88.5122], zoom: 8, bounds: [[27.0, 88.0], [28.1, 88.9]] },
  'tamil nadu': { center: [11.1271, 78.6569], zoom: 7, bounds: [[8.0, 76.2], [13.6, 80.4]] },
  'telangana': { center: [18.1124, 79.0193], zoom: 7, bounds: [[15.8, 77.2], [19.9, 81.8]] },
  'tripura': { center: [23.9408, 91.9882], zoom: 8, bounds: [[22.9, 91.1], [24.5, 92.4]] },
  'uttar pradesh': { center: [26.8467, 80.9462], zoom: 6, bounds: [[23.8, 77.0], [30.4, 84.7]] },
  'uttarakhand': { center: [30.0668, 79.0193], zoom: 7, bounds: [[28.7, 77.5], [31.5, 81.1]] },
  'west bengal': { center: [22.9868, 87.8550], zoom: 7, bounds: [[21.5, 85.8], [27.2, 89.9]] }
};

const NAV_ITEMS = ['Hotspots', 'Incidents', 'Reports', 'Announcements', 'Feedback'];
const MAP_LAYERS = ['Hotspots', 'Fire Type', 'Persistence Risk', 'Activity Density', 'Infrastructure Exposure'];

export default function App() {
  /* ── Data state (unchanged) ── */
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

  /* ── UI state ── */
  const [timeRange, setTimeRange] = useState('24h');
  const [searchQuery, setSearchQuery] = useState('');
  const [flyToLocation, setFlyToLocation] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeSeverityFilter, setActiveSeverityFilter] = useState('All');
  const [locationDropOpen, setLocationDropOpen] = useState(false);
  const [threatDropOpen, setThreatDropOpen] = useState(false);
  const [layerDropOpen, setLayerDropOpen] = useState(false);
  const [activeLayer, setActiveLayer] = useState('Hotspots');
  const [timelineValue, setTimelineValue] = useState(100);
  const [isPlaying, setIsPlaying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSuccess, setRefreshSuccess] = useState(false);

  /* ── Report Discrepancy Modal state ── */
  const [reportHotspot, setReportHotspot] = useState(null);
  const [reportMlPrediction, setReportMlPrediction] = useState(null);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);

  const handleOpenReport = useCallback((hotspot, mlPred = null) => {
    setReportHotspot(hotspot);
    setReportMlPrediction(mlPred);
    setIsReportModalOpen(true);
  }, []);

  /* ── Refs ── */
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
  const playIntervalRef = useRef(null);
  const filtersRef = useRef(null);
  const locationRef = useRef(null);
  const threatRef = useRef(null);
  const layerRef = useRef(null);

  /* ════════════════════════════════════════════════════════════
     DATA FETCHING (100% unchanged from original App.jsx)
     ════════════════════════════════════════════════════════════ */
  const fetchDetections = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = forceRefresh ? '/detections?refresh=true' : '/detections';
      const response = await fetch(endpoint);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Server responded with status ${response.status}`);
      const nextDetections = payload.data || [];
      const nextIds = new Set(nextDetections.map(getHotspotId));
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

  useEffect(() => { fetchDetections(); }, [fetchDetections]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/persistence/sources');
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Server responded with status ${response.status}`);
        if (cancelled) return;
        setPersistenceSources(payload.sources || []);
        const dates = payload.availableDates || [];
        setAvailableDates(dates);
        setSelectedDay((prev) => prev || (dates.length ? dates[dates.length - 1] : null));
      } catch (err) {
        console.error('Failed to load persistence sources:', err);
      } finally {
        if (!cancelled) setPersistenceLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const timelineSources = useMemo(() => {
    if (!selectedDay) return [];
    return persistenceSources
      .filter((s) => (s.seen_dates || []).includes(selectedDay))
      .filter((s) => s.persistence_days >= minPersistence)
      .map((s) => ({
        lat: s.lat, lon: s.lon, latitude: s.lat, longitude: s.lon,
        frp: (s.frp_by_date && s.frp_by_date[selectedDay]) || 0,
        acq_date: selectedDay, acq_time: '0000',
        is_persistent: Boolean(s.is_persistent),
        persistence_days: s.persistence_days,
      }));
  }, [persistenceSources, selectedDay, minPersistence]);

  const timelineCount = timelineSources.length;

  const BATCH_CHUNK = 50;
  const BATCH_CHUNK_CONCURRENCY = 4;

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

  const runBatchPredictions = useCallback(async (points, cancelledRef) => {
    if (!points || points.length === 0) return;
    const chunks = [];
    for (let i = 0; i < points.length; i += BATCH_CHUNK) chunks.push(points.slice(i, i + BATCH_CHUNK));

    const sendChunk = async (chunk, depth = 0) => {
      if (cancelledRef.current) return;
      const res = await fetch('/api/ml/predict/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: chunk }),
      });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (!res.ok) {
        let detail = `Status ${res.status}`;
        if (isJson) { try { detail = (await res.json()).error || detail; } catch { /* ignore */ } }
        throw new Error(`ML batch failed: ${detail}`);
      }
      if (!isJson) throw new Error('ML batch returned empty/non-JSON response');
      const payload = await res.json();
      if (cancelledRef.current) return;
      const addedRisk = {}; const addedFiretype = {}; const processedKeys = new Set();
      for (const r of payload.results || []) {
        const key = geocellKey(r.lat, r.lon);
        if (r.error) { attemptedCellsRef.current.add(key); continue; }
        processedKeys.add(key);
        const label = r.persistence?.label; const ftLabel = r.firetype?.label;
        if (label && !addedRisk[key]) { mlRiskCacheRef.current[key] = label; addedRisk[key] = label; }
        if (ftLabel && !addedFiretype[key]) { firetypeCacheRef.current[key] = ftLabel; addedFiretype[key] = ftLabel; }
        if (!label && !ftLabel) attemptedCellsRef.current.add(key);
      }
      if (Object.keys(addedRisk).length > 0) setMlRiskByCell((prev) => ({ ...prev, ...addedRisk }));
      if (Object.keys(addedFiretype).length > 0) setFiretypeByCell((prev) => ({ ...prev, ...addedFiretype }));
      if (payload.omitted > 0 && depth < 3) {
        const unprocessed = chunk.filter((p) => !processedKeys.has(geocellKey(p.latitude, p.longitude)));
        if (unprocessed.length > 0) await sendChunk(unprocessed, depth + 1);
      }
    };

    let chunkCursor = 0;
    const worker = async () => {
      while (chunkCursor < chunks.length && !cancelledRef.current) {
        const idx = chunkCursor++;
        try { await sendChunk(chunks[idx]); } catch (err) { console.error('[ML] batch chunk failed:', err.message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CHUNK_CONCURRENCY, chunks.length) }, worker));
  }, []);

  useEffect(() => {
    const missing = missingPredictions(detections);
    if (missing.length === 0) return;
    const cancelledRef = { current: false };
    runBatchPredictions(missing, cancelledRef);
    return () => { cancelledRef.current = true; };
  }, [detections, missingPredictions, runBatchPredictions]);

  useEffect(() => {
    const missing = missingPredictions(timelineSources);
    if (missing.length === 0) return;
    const cancelledRef = { current: false };
    runBatchPredictions(missing, cancelledRef);
    return () => { cancelledRef.current = true; };
  }, [timelineSources, missingPredictions, runBatchPredictions]);

  const detailPersistenceSource = useMemo(() => {
    if (!detailHotspot) return null;
    const lat = Math.round(Number(detailHotspot.latitude) * 100) / 100;
    const lon = Math.round(Number(detailHotspot.longitude) * 100) / 100;
    return persistenceSources.find((s) => s.lat === lat && s.lon === lon) || null;
  }, [detailHotspot, persistenceSources]);

  const selectHotspot = useCallback((detection) => {
    selectionRequestRef.current += 1;
    setSelectedHotspot({ id: getHotspotId(detection), requestId: selectionRequestRef.current });
  }, []);

  const cacheGroundContext = useCallback((contextKey, payload) => {
    groundContextCacheRef.current[contextKey] = payload;
    setGroundContextCache((current) => ({ ...current, [contextKey]: payload }));
  }, []);

  const fetchGroundContext = useCallback(async (detection, { setLoading: setLoadingCtx = false } = {}) => {
    const contextKey = getContextKey(detection);
    if (inFlightKeysRef.current.has(contextKey)) return;
    if (setLoadingCtx) setGroundContextLoadingKey(contextKey);
    inFlightKeysRef.current.add(contextKey);
    try {
      const response = await fetch(`/api/geo-context?lat=${detection.latitude}&lon=${detection.longitude}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Server responded with status ${response.status}`);
      cacheGroundContext(contextKey, payload);
    } finally {
      inFlightKeysRef.current.delete(contextKey);
      if (setLoadingCtx) setGroundContextLoadingKey((current) => (current === contextKey ? null : current));
    }
  }, [cacheGroundContext]);

  const processPreloadQueue = useCallback(async () => {
    if (bgActiveRef.current) return;
    bgActiveRef.current = true;
    try {
      while (preloadQueueRef.current.length > 0) {
        const detection = preloadQueueRef.current.shift();
        const key = getContextKey(detection);
        if (groundContextCacheRef.current[key] || inFlightKeysRef.current.has(key)) continue;
        await fetchGroundContext(detection, { setLoading: false });
      }
    } finally { bgActiveRef.current = false; }
  }, [fetchGroundContext]);

  useEffect(() => {
    const queuedKeys = new Set(preloadQueueRef.current.map(getContextKey));
    const candidates = [...detections, ...persistenceSources.map((s) => ({ latitude: s.lat, longitude: s.lon }))];
    candidates.forEach((detection) => {
      const key = getContextKey(detection);
      if (groundContextCacheRef.current[key] || inFlightKeysRef.current.has(key)) return;
      if (queuedKeys.has(key)) return;
      preloadQueueRef.current.push(detection);
    });
    processPreloadQueue();
  }, [detections, persistenceSources, processPreloadQueue]);

  const loadGroundContext = useCallback((detection) => {
    const key = getContextKey(detection);
    if (groundContextCacheRef.current[key]) return;
    fetchGroundContext(detection, { setLoading: true });
  }, [fetchGroundContext]);

  const showMoreDetails = useCallback((detection) => {
    setDetailHotspot(detection);
    setIsDetailPanelOpen(true);
    loadGroundContext(detection);
  }, [loadGroundContext]);

  const closeDetailsPanel = useCallback(() => {
    setIsDetailPanelOpen(false);
    setDetailHotspot(null);
  }, []);

  const allTypesEnabled = enabledFiretypes.size === FIRETYPE_TYPES.length;
  const allRiskEnabled = enabledRisk.size === PERSISTENCE_TYPES.length;
  const filteringActive = !allTypesEnabled || !allRiskEnabled;

  const passesFilter = useCallback((lat, lon) => {
    const key = geocellKey(lat, lon);
    const ft = firetypeByCell[key];
    const risk = mlRiskByCell[key];
    if (allTypesEnabled && allRiskEnabled) return true;
    if (!allTypesEnabled && (!ft || !enabledFiretypes.has(ft))) return false;
    if (!allRiskEnabled && (!risk || !enabledRisk.has(risk))) return false;
    return true;
  }, [enabledFiretypes, enabledRisk, firetypeByCell, mlRiskByCell, allTypesEnabled, allRiskEnabled]);

  // Helper to handle search typing & auto-fly to region
  const onSearchChange = useCallback((val) => {
    setSearchQuery(val);
    if (!val || !val.trim()) {
      setFlyToLocation(null);
      return;
    }
    const q = val.trim().toLowerCase();
    for (const [name, info] of Object.entries(INDIAN_REGIONS)) {
      if (name === q || (q.length >= 4 && name.startsWith(q))) {
        setFlyToLocation({ center: info.center, zoom: info.zoom });
        break;
      }
    }
  }, []);

  const handleSearchSubmit = useCallback((query) => {
    if (!query || !query.trim()) {
      setFlyToLocation(null);
      return;
    }
    const q = query.trim().toLowerCase();
    // 1. Check coordinates (lat, lon)
    const coordMatch = q.match(/^(-?\d+(\.\d+)?)[,\s]+(-?\d+(\.\d+)?)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[3]);
      if (!isNaN(lat) && !isNaN(lon)) {
        setFlyToLocation({ center: [lat, lon], zoom: 9 });
        return;
      }
    }
    // 2. Check region dictionary
    for (const [name, info] of Object.entries(INDIAN_REGIONS)) {
      if (q.includes(name) || name.includes(q)) {
        setFlyToLocation({ center: info.center, zoom: info.zoom });
        return;
      }
    }
    // 3. Check first matching detection
    const match = detections.find((d) =>
      String(d.latitude).startsWith(q) ||
      String(d.longitude).startsWith(q) ||
      (d.satellite && d.satellite.toLowerCase().includes(q)) ||
      (d.instrument && d.instrument.toLowerCase().includes(q))
    );
    if (match) {
      setFlyToLocation({ center: [match.latitude, match.longitude], zoom: 8 });
    }
  }, [detections]);

  // Master filtered detections: applies ML filters, Severity filter, Time Range, and Search Query
  const filteredDetections = useMemo(() => {
    let result = detections;

    // 1. Fire type and ML persistence filters
    if (filteringActive) {
      result = result.filter((d) => passesFilter(d.latitude, d.longitude));
    }

    // 2. Severity filter
    if (activeSeverityFilter && activeSeverityFilter !== 'All') {
      const target = activeSeverityFilter.toLowerCase();
      result = result.filter((d) => getSeverityFromFRP(d.frp || 0) === target);
    }

    // 3. Time range filter
    if (timeRange && timeRange !== '30d' && result.length > 0) {
      let maxDateStr = '';
      for (const d of result) {
        if (d.acq_date && d.acq_date > maxDateStr) maxDateStr = d.acq_date;
      }
      if (maxDateStr) {
        const maxTime = new Date(maxDateStr + 'T23:59:59Z').getTime();
        const daysBack = timeRange === '24h' ? 1 : 7;
        const cutoffTime = maxTime - daysBack * 24 * 3600 * 1000;
        result = result.filter((d) => {
          if (!d.acq_date) return true;
          const t = new Date(d.acq_date + 'T00:00:00Z').getTime();
          return t >= cutoffTime;
        });
      }
    }

    // 4. Search query filter
    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      // Check region bounds match
      let matchedRegion = null;
      for (const [name, info] of Object.entries(INDIAN_REGIONS)) {
        if (q.includes(name) || name.includes(q)) {
          matchedRegion = info;
          break;
        }
      }

      if (matchedRegion) {
        const [[minLat, minLon], [maxLat, maxLon]] = matchedRegion.bounds;
        result = result.filter((d) =>
          d.latitude >= minLat && d.latitude <= maxLat &&
          d.longitude >= minLon && d.longitude <= maxLon
        );
      } else {
        result = result.filter((d) => {
          const latStr = String(d.latitude);
          const lonStr = String(d.longitude);
          const sat = (d.satellite || '').toLowerCase();
          const inst = (d.instrument || '').toLowerCase();
          const conf = (d.confidence || '').toLowerCase();
          const sev = getSeverityFromFRP(d.frp || 0);
          return (
            latStr.includes(q) ||
            lonStr.includes(q) ||
            sat.includes(q) ||
            inst.includes(q) ||
            conf.includes(q) ||
            sev.includes(q)
          );
        });
      }
    }

    return result;
  }, [detections, filteringActive, passesFilter, activeSeverityFilter, timeRange, searchQuery]);

  const filteredTimelineSources = useMemo(() => {
    let result = timelineSources;
    if (filteringActive) {
      result = result.filter((ts) => passesFilter(ts.lat, ts.lon));
    }
    if (activeSeverityFilter && activeSeverityFilter !== 'All') {
      const target = activeSeverityFilter.toLowerCase();
      result = result.filter((ts) => getSeverityFromFRP(ts.frp || 0) === target);
    }
    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      let matchedRegion = null;
      for (const [name, info] of Object.entries(INDIAN_REGIONS)) {
        if (q.includes(name) || name.includes(q)) {
          matchedRegion = info;
          break;
        }
      }
      if (matchedRegion) {
        const [[minLat, minLon], [maxLat, maxLon]] = matchedRegion.bounds;
        result = result.filter((ts) =>
          ts.lat >= minLat && ts.lat <= maxLat &&
          ts.lon >= minLon && ts.lon <= maxLon
        );
      }
    }
    return result;
  }, [timelineSources, filteringActive, passesFilter, activeSeverityFilter, searchQuery]);

  const toggleFiretype = useCallback((ft) => {
    setEnabledFiretypes((prev) => { const next = new Set(prev); if (next.has(ft)) next.delete(ft); else next.add(ft); return next; });
  }, []);

  const toggleRisk = useCallback((risk) => {
    setEnabledRisk((prev) => { const next = new Set(prev); if (next.has(risk)) next.delete(risk); else next.add(risk); return next; });
  }, []);

  /* ════════════════════════════════════════════════════════════
     UI HELPERS
     ════════════════════════════════════════════════════════════ */
  const formatTimestamp = (date) => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      ' (' + date.toLocaleDateString() + ')';
  };

  // Recent signals: top detections from current filtered set
  const recentSignals = useMemo(() => {
    return [...filteredDetections].sort((a, b) => (b.frp || 0) - (a.frp || 0)).slice(0, 6);
  }, [filteredDetections]);

  // Handle refresh: reload both detections & persistence sources, showing clean animation and feedback
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchDetections(true);
      try {
        const resp = await fetch('/api/persistence/sources?refresh=true&t=' + Date.now());
        if (resp.ok) {
          const payload = await resp.json();
          setPersistenceSources(payload.sources || []);
          const dates = payload.availableDates || [];
          setAvailableDates(dates);
        }
      } catch (pErr) {
        console.warn('Persistence sources refresh error:', pErr);
      }
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2500);
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      setTimeout(() => setRefreshing(false), 600);
    }
  }, [fetchDetections]);

  // Play/pause timeline (steps through available dates)
  useEffect(() => {
    if (!isPlaying) { clearInterval(playIntervalRef.current); return; }
    playIntervalRef.current = setInterval(() => {
      setTimelineValue((v) => {
        if (v >= 100) { setIsPlaying(false); return 100; }
        return Math.min(100, v + 1);
      });
    }, 100);
    return () => clearInterval(playIntervalRef.current);
  }, [isPlaying]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (filtersRef.current && !filtersRef.current.contains(e.target)) setFiltersOpen(false);
      if (locationRef.current && !locationRef.current.contains(e.target)) setLocationDropOpen(false);
      if (threatRef.current && !threatRef.current.contains(e.target)) setThreatDropOpen(false);
      if (layerRef.current && !layerRef.current.contains(e.target)) setLayerDropOpen(false);
    }
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, []);

  // Sync timeline slider with available dates
  const availableDateIdx = useMemo(() => {
    if (!availableDates.length) return -1;
    const idx = selectedDay ? availableDates.indexOf(selectedDay) : availableDates.length - 1;
    return idx >= 0 ? idx : availableDates.length - 1;
  }, [availableDates, selectedDay]);

  const lastDate = availableDates[availableDates.length - 1];
  const isAtLive = selectedDay === lastDate;

  function formatDateLabel(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
  }

  // Inline date-slider handler (separate from the standalone component)
  function handleDateSlider(e) {
    const i = Number(e.target.value);
    if (i >= 0 && i < availableDates.length) setSelectedDay(availableDates[i]);
  }

  // Selected hotspot stats (for map dropdowns)
  const topSignal = recentSignals[0] || null;
  const topSeverity = topSignal ? getSeverityFromFRP(topSignal.frp || 0) : 'medium';

  /* ════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════ */
  return (
    <div className="app-shell">

      {/* ══════════════════════════════════════════════════════
          TOP NAV
          ══════════════════════════════════════════════════════ */}
      <nav className="top-nav" role="navigation" aria-label="Main navigation">
        {/* Brand */}
        <div className="nav-brand">
          <div className="nav-brand-icon" aria-hidden="true">
            <Icon.Crosshair />
          </div>
          <div>
            <div className="nav-brand-text-primary">
              Satellite Fire Detection <span className="nav-brand-acronym">SFD</span>
            </div>
            <div className="nav-brand-text-sub">Geospatial Thermal Anomaly & Threat Monitoring System</div>
          </div>
        </div>

        {/* Nav links */}
        <div className="nav-links">
          {NAV_ITEMS.map((item) => (
            <button key={item} className={`nav-link${item === 'Hotspots' ? ' active' : ''}`}>
              {item}
            </button>
          ))}
        </div>

        {/* Spacer to balance layout */}
        <div className="nav-spacer" style={{ width: 320 }} />
      </nav>

      {/* ══════════════════════════════════════════════════════
          TOOLBAR
          ══════════════════════════════════════════════════════ */}
      <div className="toolbar" role="toolbar" aria-label="Page controls">
        {/* Title */}
        <div className="toolbar-title-group">
          <div className="toolbar-title">
            <h1>Threat Hotspots</h1>
            <span className="badge-live">Live</span>
          </div>
          <p className="toolbar-subtitle">
            Geospatial anomaly detection across monitored infrastructure
          </p>
        </div>

        {/* Controls row */}
        <div className="toolbar-controls">

          {/* Search */}
          <div className="search-wrap">
            <span className="search-icon" aria-hidden="true"><Icon.Search /></span>
            <input
              id="search-region"
              className="search-input"
              type="text"
              placeholder="Search region, state, or coords…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearchSubmit(searchQuery);
              }}
              aria-label="Search region"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => { setSearchQuery(''); setFlyToLocation(null); }}
                aria-label="Clear search"
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>

          {/* Filters dropdown */}
          <div className="filter-dropdown-wrap" ref={filtersRef}>
            <button
              id="filter-btn"
              className={`ctrl-btn${activeSeverityFilter !== 'All' ? ' active-filter' : ''}`}
              onClick={() => setFiltersOpen((v) => !v)}
              aria-haspopup="true"
              aria-expanded={filtersOpen}
            >
              <Icon.Filter />
              Filters
              {activeSeverityFilter !== 'All' && (
                <span className="active-filter-badge">{activeSeverityFilter}</span>
              )}
              <span style={{ display:'inline-flex', transform: filtersOpen ? 'rotate(180deg)' : 'none', transition:'transform 0.15s' }}>
                <Icon.ChevronDown />
              </span>
            </button>

            {filtersOpen && (
              <div className="filter-popover" role="menu" aria-label="Severity filter">
                {['All', 'Critical', 'High', 'Medium'].map((sev) => (
                  <button
                    key={sev}
                    className={`filter-option${activeSeverityFilter === sev ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { setActiveSeverityFilter(sev); setFiltersOpen(false); }}
                  >
                    <span className="filter-option-left">
                      {sev !== 'All' && (
                        <span className={`filter-dot ${sev.toLowerCase()}`} aria-hidden="true" />
                      )}
                      {sev}
                    </span>
                    <span className="filter-count">
                      {sev === 'All'
                        ? detections.length
                        : detections.filter((d) => getSeverityFromFRP(d.frp || 0) === sev.toLowerCase()).length
                      }
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ctrl-divider" aria-hidden="true" />

          {/* Time-period selector */}
          <select
            id="time-range-select"
            className="ctrl-select"
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            aria-label="Time period"
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>

          <div className="ctrl-divider" aria-hidden="true" />

          {/* Refresh */}
          <button
            id="refresh-btn"
            className={`ctrl-btn${refreshSuccess ? ' success' : ''}`}
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh detections"
          >
            <span className={refreshing ? 'spin' : ''} style={{ display:'inline-flex' }}>
              <Icon.RefreshCw />
            </span>
            {refreshing ? 'Refreshing…' : refreshSuccess ? 'Updated ✓' : 'Refresh'}
          </button>

          {/* Data source + ingested time */}
          <span style={{
            display:'inline-flex', alignItems:'center', gap:6,
            padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600,
            background: '#ecfdf5',
            color: '#065f46',
            border: '1px solid #a7f3d0',
            whiteSpace: 'nowrap',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
            {cached ? 'Cached SFD' : 'Live SFD'}
          </span>

          {lastUpdated && (
            <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>
              {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          {/* Export */}
          <button id="export-btn" className="ctrl-btn primary" aria-label="Export view">
            <Icon.Radio />
            Export view
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          RECENT SIGNALS STRIP
          ══════════════════════════════════════════════════════ */}
      <div className="signals-strip" role="region" aria-label="Recent signals">
        <span className="signals-label">
          <Icon.Signal />
          Recent Signals
        </span>
        <div className="signals-sep" aria-hidden="true" />
        <div className="signals-list">
          {recentSignals.length === 0 && (
            <span style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>
              {loading ? 'Loading signals…' : 'No signals detected'}
            </span>
          )}
          {recentSignals.map((det) => {
            const id = getHotspotId(det);
            const sev = getSeverityFromFRP(det.frp || 0);
            const dotColor = sev === 'critical' ? '#dc2626' : sev === 'high' ? '#d97706' : '#0284c7';
            return (
              <button
                key={id}
                className={`signal-chip${selectedHotspot?.id === id ? ' is-selected' : ''}`}
                onClick={() => selectHotspot(det)}
                aria-label={`Select hotspot at ${det.latitude.toFixed(2)}, ${det.longitude.toFixed(2)}`}
              >
                <span className="signal-dot" style={{ background: dotColor }} aria-hidden="true" />
                <span className="signal-name">
                  {det.latitude.toFixed(2)}°, {det.longitude.toFixed(2)}°
                </span>
                <span className={`signal-badge ${sev}`}>{sev.charAt(0).toUpperCase() + sev.slice(1)}</span>
                <span className="signal-secondary">
                  <span className="signal-meta">{det.frp?.toFixed(1)} MW</span>
                  <span className="signal-divider">·</span>
                  <span className="signal-meta">{det.acq_date}</span>
                </span>
              </button>
            );
          })}
        </div>
        <button className="signals-view-all" aria-label="View all signals">View all</button>
      </div>

      {/* ══════════════════════════════════════════════════════
          MAIN CONTENT (Map + Detail Panel)
          ══════════════════════════════════════════════════════ */}
      <div className="main-content">
        <div className="map-region">

          {/* Error banner */}
          {error && (
            <div className="error-banner" role="alert">
              <strong>Backend Error:</strong> {error}
            </div>
          )}

          {/* Leaflet map (full region) */}
          <FireMap
            detections={filteredDetections}
            selectedHotspot={selectedHotspot}
            onHotspotSelected={selectHotspot}
            onLoadGroundContext={loadGroundContext}
            onShowMoreDetails={showMoreDetails}
            onOpenReport={handleOpenReport}
            timelineSources={filteredTimelineSources}
            timelineMinPersistence={minPersistence}
            mlRiskByCell={mlRiskByCell}
            firetypeByCell={firetypeByCell}
            flyToLocation={flyToLocation}
          />

          {/* ── Three map info dropdowns — top-right strip ── */}
          <div
            className={`map-dropdowns${isDetailPanelOpen ? ' panel-open' : ''}`}
            aria-label="Map information controls"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >

            {/* Dropdown 1 — Location */}
            <div className="map-dropdown-wrap" ref={locationRef}>
              <button
                id="location-dropdown-btn"
                className="map-dropdown-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setLocationDropOpen((v) => !v);
                  setThreatDropOpen(false);
                  setLayerDropOpen(false);
                }}
                aria-haspopup="true"
                aria-expanded={locationDropOpen}
              >
                <span className="map-dropdown-icon"><Icon.MapPin /></span>
                Location
                <span className={`map-dropdown-chevron${locationDropOpen ? ' open' : ''}`}><Icon.ChevronDown /></span>
              </button>
              {locationDropOpen && (
                <div className="map-popover map-popover-right" role="dialog" aria-label="Location information">
                  <div className="map-popover-label">Selected Location</div>
                  {topSignal ? (
                    <>
                      <div className="map-popover-title">
                        {topSignal.latitude.toFixed(4)}°, {topSignal.longitude.toFixed(4)}°
                      </div>
                      <div className="map-popover-sub">
                        <Icon.MapPin /> Satellite detection · {topSignal.satellite || 'VIIRS'}
                      </div>
                      <div className="map-popover-divider" />
                      <div className="map-popover-row">
                        <span className="map-popover-key">Latitude</span>
                        <span className="map-popover-val">{topSignal.latitude.toFixed(4)}°</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Longitude</span>
                        <span className="map-popover-val">{topSignal.longitude.toFixed(4)}°</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Acq. date</span>
                        <span className="map-popover-val">{topSignal.acq_date}</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Instrument</span>
                        <span className="map-popover-val">{topSignal.instrument || 'VIIRS'}</span>
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>No hotspot selected</div>
                  )}
                </div>
              )}
            </div>

            {/* Dropdown 2 — Threat Data */}
            <div className="map-dropdown-wrap" ref={threatRef}>
              <button
                id="threat-dropdown-btn"
                className="map-dropdown-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setThreatDropOpen((v) => !v);
                  setLocationDropOpen(false);
                  setLayerDropOpen(false);
                }}
                aria-haspopup="true"
                aria-expanded={threatDropOpen}
              >
                <span className="map-dropdown-icon"><Icon.ShieldAlert /></span>
                Threat Data
                <span className={`map-dropdown-chevron${threatDropOpen ? ' open' : ''}`}><Icon.ChevronDown /></span>
              </button>
              {threatDropOpen && (
                <div className="map-popover map-popover-right" role="dialog" aria-label="Threat data">
                  <div className="map-popover-label">Fire Threat Intelligence</div>
                  {topSignal ? (
                    <>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 8 }}>
                        <span className={`signal-badge ${topSeverity}`} style={{ fontSize: 10 }}>
                          {topSeverity.charAt(0).toUpperCase() + topSeverity.slice(1)} Priority
                        </span>
                        <span style={{ fontFamily:'monospace', fontSize: 18, fontWeight: 700, color:'#0f172a' }}>
                          {topSignal.frp?.toFixed(1)}<span style={{ fontSize: 10, color:'#64748b' }}> MW</span>
                        </span>
                      </div>
                      <div className="score-bar-track">
                        <div className="score-bar-fill" style={{ width: `${Math.min(100, ((topSignal.frp || 0) / 300) * 100)}%` }} />
                      </div>
                      <div className="map-popover-divider" />
                      <div className="map-popover-row">
                        <span className="map-popover-key">Fire Radiative Power</span>
                        <span className="map-popover-val">{topSignal.frp?.toFixed(1)} MW</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Confidence</span>
                        <span className="map-popover-val">{topSignal.confidence || 'Nominal'}</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Brightness Temp</span>
                        <span className="map-popover-val">{topSignal.bright_ti4 ? `${topSignal.bright_ti4} K` : 'N/A'}</span>
                      </div>
                      <div className="map-popover-row">
                        <span className="map-popover-key">Active detections</span>
                        <span className="map-popover-val">{detections.length}</span>
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>No detection selected</div>
                  )}
                </div>
              )}
            </div>

            {/* Dropdown 3 — Map Layer */}
            <div className="map-dropdown-wrap" ref={layerRef}>
              <button
                id="layer-dropdown-btn"
                className="map-dropdown-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setLayerDropOpen((v) => !v);
                  setLocationDropOpen(false);
                  setThreatDropOpen(false);
                }}
                aria-haspopup="true"
                aria-expanded={layerDropOpen}
              >
                <span className="map-dropdown-icon"><Icon.Layers /></span>
                {activeLayer}
                <span className={`map-dropdown-chevron${layerDropOpen ? ' open' : ''}`}><Icon.ChevronDown /></span>
              </button>
              {layerDropOpen && (
                <div className="map-popover map-popover-right" role="dialog" aria-label="Map layer selector">
                  <div className="map-popover-label">Visualization Layer</div>
                  {MAP_LAYERS.map((layer) => (
                    <button
                      key={layer}
                      className={`layer-option${activeLayer === layer ? ' is-active' : ''}`}
                      onClick={() => { setActiveLayer(layer); setLayerDropOpen(false); }}
                    >
                      {layer}
                      {activeLayer === layer && <span className="layer-check"><Icon.Check /></span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ML Legend / Filter card */}
          <FilterLegend
            enabledFiretypes={enabledFiretypes}
            enabledRisk={enabledRisk}
            onToggleFiretype={toggleFiretype}
            onToggleRisk={toggleRisk}
          />

          {/* ── Timeline Slider ── */}
          <TimeSliderBar
            availableDates={availableDates}
            selectedDay={selectedDay}
            onDayChange={setSelectedDay}
            sourceCount={timelineCount}
            loading={persistenceLoading}
            minPersistence={minPersistence}
            onMinPersistenceChange={setMinPersistence}
          />
        </div>

        {/* Detail panel (slides in from right) */}
        {isDetailPanelOpen && (
          <DetailPanel
            detailHotspot={detailHotspot}
            groundData={detailHotspot ? groundContextCache[getContextKey(detailHotspot)] : null}
            persistenceSource={detailPersistenceSource}
            isLoading={detailHotspot ? groundContextLoadingKey === getContextKey(detailHotspot) : false}
            onClose={closeDetailsPanel}
            onOpenReport={handleOpenReport}
          />
        )}
      </div>

      {/* Discrepancy & ML Correction Report Modal */}
      <ReportModal
        hotspot={reportHotspot}
        mlPrediction={reportMlPrediction}
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
      />
    </div>
  );
}

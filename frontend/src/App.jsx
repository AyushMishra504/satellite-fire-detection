import React, { useState, useEffect, useCallback } from 'react';
import FireMap from './components/FireMap';

export default function App() {
  const [detections, setDetections] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

      setDetections(payload.data || []);
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

  // Format timestamp for display
  const formatTimestamp = (date) => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      ' (' + date.toLocaleDateString() + ')';
  };

  return (
    <div className="app-container">
      {/* HUD Header Overlay */}
      <header className="overlay-header">
        <h1>🛰️ Thermal Anomaly & Fire Detection</h1>
        
        <div className="status-bar">
          <span className="badge badge-count">
            {detections.length} Hotspots
          </span>

          <span className={`badge ${cached ? 'badge-cached' : 'badge-live'}`}>
            {cached ? '⚡ Cached (15m TTL)' : '🟢 Live FIRMS Data'}
          </span>

          <button
            className="refresh-btn"
            onClick={() => fetchDetections(true)}
            disabled={loading}
          >
            {loading ? 'Refreshing...' : '🔄 Refresh Data'}
          </button>
        </div>

        <div style={{ marginTop: '8px', fontSize: '11px', color: '#94a3b8' }}>
          <strong>Last Ingested:</strong> {lastUpdated ? formatTimestamp(lastUpdated) : 'Loading...'}
        </div>
      </header>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          ⚠️ <strong>Backend Error:</strong> {error}
        </div>
      )}

      {/* Map visualization */}
      <FireMap detections={detections} />

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

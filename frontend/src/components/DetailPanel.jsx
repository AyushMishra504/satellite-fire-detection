import React, { useState, useEffect } from 'react';

function Row({ label, value }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

function Section({ title }) {
  return <div className="detail-section-title">{title}</div>;
}

function formatDetectionTime(detection) {
  const time = String(detection.acq_time || '').padStart(4, '0');
  return `${detection.acq_date} ${time.slice(0, 2)}:${time.slice(2)} UTC`;
}

const RISK_STYLING = {
  short: { color: '#22c55e', label: 'Short-lived' },
  medium: { color: '#f59e0b', label: 'Medium-lived' },
  long: { color: '#dc2626', label: 'Long-lived' },
};

const FIRETYPE_STYLING = {
  industrial_fire: { color: '#dc2626', bg: 'rgba(220, 38, 38, 0.15)', label: 'Industrial Fire' },
  gas_flare: { color: '#f97316', bg: 'rgba(249, 115, 22, 0.15)', label: 'Gas Flare' },
  agricultural_burn: { color: '#eab308', bg: 'rgba(234, 179, 8, 0.15)', label: 'Agricultural Burn' },
  mining_activity: { color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)', label: 'Mining Activity' },
  wildfire: { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', label: 'Wildfire' },
  unknown: { color: '#9ca3af', bg: 'rgba(156, 163, 175, 0.15)', label: 'Unknown' },
};

export default function DetailPanel({
  detailHotspot,
  groundData,
  persistenceSource,
  isLoading,
  onClose,
}) {
  const [mlPrediction, setMlPrediction] = useState(null);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlError, setMlError] = useState(null);

  // Fetch the ML prediction whenever a different hotspot is shown.
  useEffect(() => {
    if (!detailHotspot) return;
    let cancelled = false;
    setMlPrediction(null);
    setMlError(null);
    setMlLoading(true);

    (async () => {
      try {
        const res = await fetch('/api/ml/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            latitude: detailHotspot.latitude,
            longitude: detailHotspot.longitude,
          }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || `Status ${res.status}`);
        if (!cancelled) setMlPrediction(payload);
      } catch (err) {
        if (!cancelled) setMlError(err.message);
      } finally {
        if (!cancelled) setMlLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [detailHotspot]);

  if (!detailHotspot) return null;

  const fuel = groundData?.fuel;
  const persLabel = mlPrediction?.persistence?.label;
  const risk = RISK_STYLING[persLabel] || null;
  const behaviorLabel = mlPrediction?.behavior?.label;
  const firetypeLabel = mlPrediction?.firetype?.label;
  const firetypeStyling = FIRETYPE_STYLING[firetypeLabel] || null;
  const reasons = mlPrediction?.reasons || {};

  return (
    <aside className="detail-panel">
      <header className="detail-panel-header">
        <span className="detail-panel-title">Hotspot Details</span>
        <button
          type="button"
          className="detail-panel-close"
          onClick={onClose}
          aria-label="Close details panel"
        >
          ×
        </button>
      </header>

      <div className="detail-panel-body">
        <Section title="ML Prediction" />
        {mlLoading ? (
          <div className="ground-summary-status">Running ML prediction...</div>
        ) : mlError ? (
          <div className="ground-summary-status">ML prediction unavailable ({mlError})</div>
        ) : mlPrediction ? (
          <>
            {/* Fire Type */}
            {firetypeStyling && (
              <Row
                label="Fire type"
                value={
                  <span
                    className="ml-firetype-badge"
                    style={{ color: firetypeStyling.color, background: firetypeStyling.bg }}
                  >
                    {firetypeStyling.label}
                  </span>
                }
              />
            )}
            {renderFiretypeReasons(reasons.firetype)}

            {/* Secondary physical model check */}
            {mlPrediction.firetype_ml && mlPrediction.firetype_ml.label !== 'unknown' && (
              <>
                <Row
                  label="Model cross-check"
                  value={
                    <span className="ml-firetype-badge" style={{ color: firetypeStyling?.color }}>
                      {mlPrediction.firetype_ml.label.replace(/_/g, ' ')} (
                      {formatPct(mlPrediction.firetype_ml.confidence)})
                    </span>
                  }
                />
                {mlPrediction.firetype_agreement === 'disagree' && (
                  <div className="ml-reason ml-reason-warn">
                    Physical model disagrees — rule is provisional.
                  </div>
                )}
              </>
            )}

            {/* Persistence Risk */}
            <Row
              label="Persistence risk"
              value={
                risk ? (
                  <span className="ml-risk-badge" style={{ color: risk.color }}>
                    {risk.label} ({mlPrediction.persistence.label})
                  </span>
                ) : (
                  mlPrediction.persistence.label
                )
              }
            />
            <Row label="Confidence" value={formatPct(mlPrediction.persistence.confidence)} />
            {reasons.persistence && (
              <div className="ml-reason">{reasons.persistence}</div>
            )}

            {/* Behavior */}
            <Row
              label="Fire behavior"
              value={behaviorLabel ? behaviorLabel.replace(/^(.)/, (c) => c.toUpperCase()) : 'Unknown'}
            />
            {reasons.behavior && (
              <div className="ml-reason">{reasons.behavior}</div>
            )}
          </>
        ) : null}

        <Section title="Fire Radiative Power" />
        <Row label="FRP" value={`${detailHotspot.frp} MW`} />
        <Row label="Confidence" value={detailHotspot.confidence || 'Nominal'} />
        {detailHotspot.bright_ti4 && (
          <Row label="Brightness Temp (I4)" value={`${detailHotspot.bright_ti4} K`} />
        )}

        <Section title="Detection" />
        <Row label="Time" value={formatDetectionTime(detailHotspot)} />
        <Row
          label="Coordinates"
          value={`${detailHotspot.latitude.toFixed(4)}, ${detailHotspot.longitude.toFixed(4)}`}
        />
        {detailHotspot.satellite && (
          <Row
            label="Satellite / Sensor"
            value={`${detailHotspot.satellite} (${detailHotspot.instrument})`}
          />
        )}

        <Section title="Persistence" />
        {persistenceSource ? (
          <>
            <Row
              label="Status"
              value={
                persistenceSource.is_persistent ? (
                  <span className="persistent-badge">
                    Persistent source ({persistenceSource.persistence_days} days)
                  </span>
                ) : (
                  'Single occurrence'
                )
              }
            />
            <Row
              label="Active days"
              value={(persistenceSource.seen_dates || []).length}
            />
            <Row label="Activity ratio" value={formatPct(persistenceSource.activity_ratio)} />
            <Row label="Peak FRP (history)" value={`${persistenceSource.max_frp} MW`} />
            <Row label="Trend" value={formatTrend(persistenceSource.frp_trend)} />
            <Row
              label="Active window"
              value={formatWindow(persistenceSource.first_seen, persistenceSource.last_seen)}
            />
          </>
        ) : (
          <div className="ground-summary-status">
            No persistence record for this location yet.
          </div>
        )}

        <Section title="Ground Context" />
        {isLoading ? (
          <div className="ground-summary-status">Retrieving ground &amp; fuel data...</div>
        ) : (
          <>
            <Row label="Land type" value={groundData?.land_type || 'Unknown'} />
            <Row label="Fuel type" value={fuel?.fuel_type || 'Unknown'} />
            <Row
              label="Vegetation moisture"
              value={fuel?.moisture ? capitalize(fuel.moisture) : 'Unknown'}
            />
            <Row
              label="Dryness index"
              value={fuel?.dryness_index != null ? fuel.dryness_index : 'N/A'}
            />
            {fuel?.metrics?.ndvi && (
              <Row
                label="NDVI (p90/p50/p10)"
                value={formatTriplet(fuel.metrics.ndvi, 'NDVI')}
              />
            )}
            {fuel?.metrics?.swir && (
              <Row
                label="SWIR (B12/B11)"
                value={formatTriplet(fuel.metrics.swir, 'SWIR')}
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function capitalize(str) {
  return String(str || '').charAt(0).toUpperCase() + String(str || '').slice(1);
}

function renderFiretypeReasons(ftReason) {
  if (!ftReason) return null;
  const parts = [];
  if (ftReason.rule) parts.push(ftReason.rule);
  if (ftReason.model) parts.push(ftReason.model);
  if (parts.length === 0) return null;
  return (
    <div className="ml-reason">{parts.join(' · ')}</div>
  );
}

function formatPct(ratio) {
  if (ratio == null) return 'N/A';
  return `${Math.round(Number(ratio) * 100)}%`;
}

function formatTrend(trend) {
  if (trend == null) return 'N/A';
  const direction = Number(trend) > 0 ? '↑ increasing' : '↓ decreasing';
  return `${direction} (${Math.abs(Number(trend)).toFixed(2)})`;
}

function formatWindow(first, last) {
  if (!first || !last) return 'N/A';
  const f = new Date(first + 'T00:00:00Z');
  const l = new Date(last + 'T00:00:00Z');
  return `${f.toLocaleDateString([], { day: '2-digit', month: 'short' })} → ` +
    l.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
}

function formatTriplet(obj, label) {
  const { p90, p50, p10, b12, b11 } = obj;
  if (label === 'NDVI') return `${p90} / ${p50} / ${p10}`;
  return `${b12} / ${b11}`;
}

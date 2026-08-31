import React from 'react';

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

export default function DetailPanel({
  detailHotspot,
  groundData,
  isLoading,
  onClose,
}) {
  if (!detailHotspot) return null;

  const fuel = groundData?.fuel;

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

function formatTriplet(obj, label) {
  const { p90, p50, p10, b12, b11 } = obj;
  if (label === 'NDVI') return `${p90} / ${p50} / ${p10}`;
  return `${b12} / ${b11}`;
}

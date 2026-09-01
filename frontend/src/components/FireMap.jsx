import React, { useEffect } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Tooltip,
  useMap,
} from "react-leaflet";
import { getHotspotId, geocellKey, FIRETYPE_STYLING, FIRETYPE_RADIUS, FIRETYPE_DEFAULT_RADIUS, PERSISTENCE_RING } from "./utils";

function LockMinZoom() {
  const map = useMap();
  useEffect(() => {
    const worldBounds = [
      [-90, -180],
      [90, 180],
    ];
    const idealMinZoom = map.getBoundsZoom(worldBounds, false); // false = fit inside, no overflow
    map.setMinZoom(idealMinZoom);
  }, [map]);
  return null;
}

function ZoomToIndiaControl() {
  const map = useMap();

  useEffect(() => {
    const CustomControl = L.Control.extend({
      options: {
        position: "topleft",
      },
      onAdd: function () {
        const container = L.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control",
        );
        const button = L.DomUtil.create(
          "a",
          "leaflet-control-zoom-to-india",
          container,
        );
        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
        button.href = "#";
        button.title = "Zoom to India";
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", "Zoom to India");
        button.style.width = "30px";
        button.style.height = "30px";
        button.style.display = "flex";
        button.style.alignItems = "center";
        button.style.justifyContent = "center";
        button.style.backgroundColor = "#fff";
        button.style.cursor = "pointer";
        button.style.color = "#333";
        button.style.fontSize = "25px";

        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, "click", function (e) {
          L.DomEvent.preventDefault(e);
          const indiaBounds = [
            [6.5, 68.0],
            [37.5, 97.5],
          ];
          map.fitBounds(indiaBounds, { animate: true, padding: [20, 20] });
        });

        return container;
      },
    });

    const control = new CustomControl();
    map.addControl(control);

    return () => {
      map.removeControl(control);
    };
  }, [map]);

  return null;
}

// Fire-type marker radius (circumference driven by predicted fire type).
function firetypeRadius(ftLabel) {
  return ftLabel && FIRETYPE_RADIUS[ftLabel] != null ? FIRETYPE_RADIUS[ftLabel] : FIRETYPE_DEFAULT_RADIUS;
}

function SelectedHotspotPopup({ selectedHotspot, markerRefs }) {
  useEffect(() => {
    if (!selectedHotspot) return;

    // Opening a popup preserves the current zoom. Leaflet pans only if needed
    // to keep that popup visible.
    markerRefs.current.get(selectedHotspot.id)?.openPopup();
  }, [selectedHotspot, markerRefs]);

  return null;
}

export default function FireMap({
  detections,
  selectedHotspot,
  onHotspotSelected,
  onLoadGroundContext,
  onShowMoreDetails,
  timelineSources,
  timelineMinPersistence = 0,
  mlRiskByCell = {},
  firetypeByCell = {},
}) {
  // Center around India [20.5937, 78.9629]
  const defaultCenter = [20.5937, 78.9629];
  const defaultZoom = 5;

  const markerRefs = React.useRef(new Map());

  // Timeline sources already carry persistence_days; this is a pure client-side
  // filter (2+/3+/4+ days) applied to what gets rendered as CircleMarkers.
  const visibleHotspots = (timelineSources || []).filter(
    (ts) => ts.persistence_days >= timelineMinPersistence
  );

  // Lookup helpers keyed by geocell.
  const riskOf = (ts) => mlRiskByCell[geocellKey(ts.lat, ts.lon)] || null;
  const ftOf = (ts) => {
    const ft = firetypeByCell[geocellKey(ts.lat, ts.lon)];
    return ft ? FIRETYPE_STYLING[ft] || null : null;
  };

  return (
    <div className="map-container">
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        maxBounds={[
          [-90, -180],
          [90, 180],
        ]}
        maxBoundsViscosity={1.0}
        worldCopyJump={false}
        style={{ height: "100vh", width: "100%" }}
      >
        <LockMinZoom />
        <ZoomToIndiaControl />
        <SelectedHotspotPopup
          selectedHotspot={selectedHotspot}
          markerRefs={markerRefs}
        />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          noWrap={true}
        />

        {detections.map((detection) => {
          const hotspotId = getHotspotId(detection);
          const key = geocellKey(detection.latitude, detection.longitude);
          const ftLabel = firetypeByCell[key];
          const ftStyle = FIRETYPE_STYLING[ftLabel] || null;
          const risk = mlRiskByCell[key] || null;
          const ring = PERSISTENCE_RING[risk] || null;
          const radius = firetypeRadius(ftLabel);

          return (
            <CircleMarker
              key={hotspotId}
              ref={(marker) => {
                if (marker) {
                  markerRefs.current.set(hotspotId, marker);
                } else {
                  markerRefs.current.delete(hotspotId);
                }
              }}
              center={[detection.latitude, detection.longitude]}
              radius={radius}
              pathOptions={{
                color: ring ? ring.color : "#ffffff",
                weight: ring ? 2.5 : 1,
                fillColor: ftStyle ? ftStyle.color : "#94a3b8",
                fillOpacity: 0.85,
              }}
              eventHandlers={{
                click: () => {
                  onHotspotSelected(detection);
                  onLoadGroundContext(detection);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
                <span>
                  <strong>FRP:</strong> {detection.frp} MW |{" "}
                  <strong>Time:</strong> {detection.acq_time} UTC
                  {ftStyle && (
                    <span> | <strong style={{ color: ftStyle.color }}>{ftStyle.label}</strong></span>
                  )}
                </span>
              </Tooltip>

              <Popup>
                <div className="popup-details">
                  <div className="popup-header">Thermal Anomaly Detected</div>

                  {ftStyle && (
                    <div className="popup-row">
                      <span className="popup-label">Detected fire type:</span>
                      <span className="popup-value" style={{ color: ftStyle.color }}>
                        {ftStyle.label}
                      </span>
                    </div>
                  )}

                  {risk && (
                    <div className="popup-row">
                      <span className="popup-label">Predicted persistence:</span>
                      <span className="popup-value" style={{ color: ring.color }}>
                        {risk.charAt(0).toUpperCase() + risk.slice(1)}-lived
                      </span>
                    </div>
                  )}

                  <div className="popup-row">
                    <span className="popup-label">
                      Fire Radiative Power (FRP):
                    </span>
                    <span className="popup-value">{detection.frp} MW</span>
                  </div>

                  <div className="popup-row">
                    <span className="popup-label">Confidence:</span>
                    <span className="popup-value">
                      {detection.confidence || "Nominal"}
                    </span>
                  </div>

                  <div className="popup-row">
                    <span className="popup-label">Acquisition Date:</span>
                    <span className="popup-value">{detection.acq_date}</span>
                  </div>

                  <div className="popup-row">
                    <span className="popup-label">Acquisition Time:</span>
                    <span className="popup-value">
                      {detection.acq_time} UTC
                    </span>
                  </div>

                  {detection.bright_ti4 && (
                    <div className="popup-row">
                      <span className="popup-label">Brightness Temp (I4):</span>
                      <span className="popup-value">
                        {detection.bright_ti4} K
                      </span>
                    </div>
                  )}

                  <div className="popup-row">
                    <span className="popup-label">Coordinates:</span>
                    <span className="popup-value">
                      {detection.latitude.toFixed(4)},{" "}
                      {detection.longitude.toFixed(4)}
                    </span>
                  </div>

                  {detection.satellite && (
                    <div className="popup-row">
                      <span className="popup-label">Satellite / Sensor:</span>
                      <span className="popup-value">
                        {detection.satellite} ({detection.instrument})
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    className="popup-more-details-btn"
                    onClick={() => onShowMoreDetails(detection)}
                  >
                    More details
                  </button>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

        {/* Timeline overlay: persistent-source positions for the selected day */}
        {visibleHotspots.map((ts, idx) => {
          const key = `ts-${ts.lat}-${ts.lon}-${idx}`;
          const firetype = ftOf(ts);
          const risk = riskOf(ts);
          const ring = PERSISTENCE_RING[risk] || null;
          const radius = firetypeRadius(firetype?.label ? firetype.label : null);

          return (
            <CircleMarker
              key={key}
              center={[ts.lat, ts.lon]}
              radius={radius + 1}
              pathOptions={{
                color: ring ? ring.color : "#ffffff",
                weight: ring ? 2.5 : 1,
                fillColor: firetype ? firetype.color : "#94a3b8",
                fillOpacity: 0.85,
                dashArray: ring ? null : '3 3',
              }}
            >
              <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
                <span>
                  <strong>FRP:</strong> {ts.frp.toFixed(1)} MW
                  {ts.is_persistent && (
                    <span> | <strong style={{ color: '#06b6d4' }}>Persistent ({ts.persistence_days}d)</strong></span>
                  )}
                  {firetype && (
                    <span> | <strong style={{ color: firetype.color }}>{firetype.label}</strong></span>
                  )}
                </span>
              </Tooltip>

              <Popup>
                <div className="popup-details">
                  <div className="popup-header">
                    Thermal Source (Historical)
                  </div>

                  {firetype && (
                    <div className="popup-row">
                      <span className="popup-label">Detected fire type:</span>
                      <span className="popup-value" style={{ color: firetype.color }}>
                        {firetype.label}
                      </span>
                    </div>
                  )}

                  {risk && (
                    <div className="popup-row">
                      <span className="popup-label">Predicted persistence:</span>
                      <span className="popup-value" style={{ color: ring.color }}>
                        {risk.charAt(0).toUpperCase() + risk.slice(1)}-lived
                      </span>
                    </div>
                  )}

                  {ts.is_persistent && (
                    <div className="popup-row">
                      <span className="popup-label">Status:</span>
                      <span className="popup-value persistent-badge">
                        Persistent Source ({ts.persistence_days} days)
                      </span>
                    </div>
                  )}

                  <div className="popup-row">
                    <span className="popup-label">FRP on selected day:</span>
                    <span className="popup-value">{ts.frp.toFixed(1)} MW</span>
                  </div>

                  <div className="popup-row">
                    <span className="popup-label">Coordinates:</span>
                    <span className="popup-value">
                      {ts.lat.toFixed(4)}, {ts.lon.toFixed(4)}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="popup-more-details-btn"
                    onClick={() => onShowMoreDetails(ts)}
                  >
                    More details
                  </button>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}

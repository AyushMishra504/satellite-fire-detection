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
          "leaflet-bar leaflet-control"
        );
        const button = L.DomUtil.create(
          "a",
          "leaflet-control-zoom-to-india",
          container
        );
        button.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: block; margin: auto;">
            <circle cx="12" cy="12" r="10"/>
            <line x1="22" y1="12" x2="18" y2="12"/>
            <line x1="6" y1="12" x2="2" y2="12"/>
            <line x1="12" y1="6" x2="12" y2="2"/>
            <line x1="12" y1="22" x2="12" y2="18"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        `;
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

// Helper to determine circle radius from FRP (Fire Radiative Power)
function getMarkerRadius(frp) {
  const value = typeof frp === "number" ? frp : parseFloat(frp) || 0;
  // Slightly increased base size (6.5px - 11.5px) with subtle scaling for higher FRP
  return Math.max(6.5, Math.min(11.5, 6.5 + Math.sqrt(value) * 0.65));
}

// Helper to color-code thermal anomalies based on intensity (FRP)
function getMarkerColor(frp) {
  const value = typeof frp === "number" ? frp : parseFloat(frp) || 0;
  if (value >= 25) return "#dc2626"; // High intensity (Red)
  if (value >= 10) return "#ea580c"; // Moderate-High (Dark Orange)
  if (value >= 5) return "#f59e0b"; // Moderate (Amber)
  return "#eab308"; // Low intensity (Yellow)
}

export default function FireMap({ detections }) {
  // Center around India [20.5937, 78.9629]
  const defaultCenter = [20.5937, 78.9629];
  const defaultZoom = 5;

  return (
    <div className="map-container">
      <MapContainer
        center={[20.5937, 78.9629]}
        zoom={5}
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
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          noWrap={true}
        />

        {detections.map((detection, index) => {
          const radius = getMarkerRadius(detection.frp);
          const color = getMarkerColor(detection.frp);

          return (
            <CircleMarker
              key={`${detection.latitude}-${detection.longitude}-${detection.acq_date}-${detection.acq_time}-${index}`}
              center={[detection.latitude, detection.longitude]}
              radius={radius}
              pathOptions={{
                color: "#ffffff",
                weight: 1,
                fillColor: color,
                fillOpacity: 0.75,
              }}
            >
              <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
                <span>
                  <strong>FRP:</strong> {detection.frp} MW |{" "}
                  <strong>Time:</strong> {detection.acq_time} UTC
                </span>
              </Tooltip>

              <Popup>
                <div className="popup-details">
                  <div className="popup-header">
                    🔥 Thermal Anomaly Detected
                  </div>

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
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}

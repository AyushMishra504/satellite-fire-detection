import React from 'react';
import {
  FIRETYPE_TYPES,
  FIRETYPE_STYLING,
  PERSISTENCE_TYPES,
  PERSISTENCE_RING,
} from './utils';

function ToggleItem({ checked, onChange, swatch, label, ring }) {
  return (
    <label className="legend-filter-item">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="legend-filter-checkbox"
      />
      <span
        className={ring ? 'legend-ring' : 'legend-swatch'}
        style={ring ? { borderColor: swatch } : { background: swatch }}
      ></span>
      <span>{label}</span>
    </label>
  );
}

export default function FilterLegend({ enabledFiretypes, enabledRisk, onToggleFiretype, onToggleRisk }) {
  return (
    <div className="legend-card">
      <div className="legend-title">Detected Fire Type (ML)</div>
      {FIRETYPE_TYPES.map((ft) => (
        <ToggleItem
          key={ft}
          checked={enabledFiretypes.has(ft)}
          onChange={() => onToggleFiretype(ft)}
          swatch={FIRETYPE_STYLING[ft].color}
          label={FIRETYPE_STYLING[ft].label}
        />
      ))}

      <div className="legend-title legend-ml-title">Persistence (ML)</div>
      {PERSISTENCE_TYPES.map((risk) => (
        <ToggleItem
          key={risk}
          checked={enabledRisk.has(risk)}
          onChange={() => onToggleRisk(risk)}
          swatch={PERSISTENCE_RING[risk].color}
          label={PERSISTENCE_RING[risk].label}
          ring
        />
      ))}
    </div>
  );
}

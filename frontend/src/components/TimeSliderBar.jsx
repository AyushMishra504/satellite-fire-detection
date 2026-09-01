import React from 'react';
import PersistenceFilter from './PersistenceFilter';

/**
 * Manual-scrub day slider over the persistence history window.
 *
 * This only selects WHICH day to render — it never triggers any classification
 * or data fetch. The map simply filters positions for the chosen day.
 *
 * The persistence filter applies at every slider position (persistence is a
 * per-location property, computed over the full history window).
 */
export default function TimeSliderBar({
  availableDates,
  selectedDay,
  onDayChange,
  sourceCount,
  loading,
  minPersistence,
  onMinPersistenceChange,
}) {
  if (loading && availableDates.length === 0) return null;
  if (availableDates.length === 0) return null;

  const lastDate = availableDates[availableDates.length - 1];
  const isAtLive = selectedDay === lastDate;
  const index = selectedDay ? availableDates.indexOf(selectedDay) : -1;
  const currentIndex = index >= 0 ? index : availableDates.length - 1;

  const handleChange = (e) => {
    const i = Number(e.target.value);
    if (i >= 0 && i < availableDates.length) {
      onDayChange(availableDates[i]);
    }
  };

  const formatLabel = (dateStr) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
  };

  return (
    <div className="time-slider-bar">
      <div className="time-slider-meta">
        <span className="time-slider-label">
          {formatLabel(availableDates[currentIndex])}
          {isAtLive && <span className="time-slider-live"> · Live</span>}
        </span>
        <span className="time-slider-count">
          {sourceCount} source{sourceCount === 1 ? '' : 's'} active
        </span>
      </div>

      <input
        type="range"
        className="time-slider-input"
        min={0}
        max={availableDates.length - 1}
        value={currentIndex}
        onChange={handleChange}
        aria-label="Timeline day"
      />

      <div className="time-slider-range">
        <span>{formatLabel(availableDates[0])}</span>
        <span>{formatLabel(lastDate)}</span>
      </div>

      <PersistenceFilter
        value={minPersistence}
        onChange={onMinPersistenceChange}
      />
    </div>
  );
}

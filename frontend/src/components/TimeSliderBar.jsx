import React, { useEffect, useRef, useState } from 'react';
import PersistenceFilter from './PersistenceFilter';

/**
 * Manual-scrub day slider over the persistence history window.
 *
 * Redesigned to match the intelligence-dashboard aesthetic:
 * - Dark glassmorphism bar anchored at the bottom of the map
 * - Play / pause + step forward / backward controls
 * - Gradient track fill with floating time tooltip
 * - Persistence filter integrated below the track
 *
 * NOTE: All hooks are called unconditionally (before any early returns)
 * to satisfy the Rules of Hooks.
 */

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const StepBackIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const StepFwdIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export default function TimeSliderBar({
  availableDates,
  selectedDay,
  onDayChange,
  sourceCount,
  loading,
  minPersistence,
  onMinPersistenceChange,
}) {
  // ── All hooks MUST be called before any early return ──
  const [isPlaying, setIsPlaying] = useState(false);
  const playRef = useRef(null);

  const lastDate = availableDates[availableDates.length - 1];
  const isAtLive = selectedDay === lastDate;
  const index = selectedDay ? availableDates.indexOf(selectedDay) : -1;
  const currentIndex = index >= 0 ? index : Math.max(0, availableDates.length - 1);

  const pct = availableDates.length > 1
    ? (currentIndex / (availableDates.length - 1)) * 100
    : 100;

  // Play/pause: step forward through dates automatically
  useEffect(() => {
    if (!isPlaying || availableDates.length === 0) {
      clearInterval(playRef.current);
      return;
    }
    playRef.current = setInterval(() => {
      const nextIdx = currentIndex + 1;
      if (nextIdx >= availableDates.length) {
        setIsPlaying(false);
        clearInterval(playRef.current);
        return;
      }
      onDayChange(availableDates[nextIdx]);
    }, 800);
    return () => clearInterval(playRef.current);
  }, [isPlaying, currentIndex, availableDates, onDayChange]);

  // ── Early returns AFTER all hooks ──
  if (loading && availableDates.length === 0) return null;
  if (availableDates.length === 0) return null;

  function formatLabel(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
  }

  function handleRangeChange(e) {
    const i = Number(e.target.value);
    if (i >= 0 && i < availableDates.length) onDayChange(availableDates[i]);
  }

  function stepBack() {
    if (currentIndex > 0) onDayChange(availableDates[currentIndex - 1]);
  }

  function stepForward() {
    if (currentIndex < availableDates.length - 1) onDayChange(availableDates[currentIndex + 1]);
  }

  return (
    <div className="time-slider-bar">
      <div className="time-slider-meta">
        <span className="time-slider-label">
          {formatLabel(availableDates[currentIndex])}
          {isAtLive && <span className="time-slider-live-badge">· Live</span>}
        </span>
        <span className="time-slider-count">
          {sourceCount} source{sourceCount === 1 ? '' : 's'} active
        </span>
      </div>

      <div className="time-slider-inner">
        {/* Play / Pause */}
        <button
          className="time-slider-play"
          onClick={() => setIsPlaying((v) => !v)}
          aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>

        {/* Step back */}
        <button
          className="time-slider-step"
          onClick={stepBack}
          disabled={currentIndex === 0}
          aria-label="Previous day"
        >
          <StepBackIcon />
        </button>

        {/* Track + tooltip + thumb */}
        <div className="time-slider-track-wrap">
          <span className="time-slider-edge">{formatLabel(availableDates[0])}</span>

          <div className="time-slider-track">
            <div className="time-slider-rail">
              <div className="time-slider-fill" style={{ width: `${pct}%` }} />
            </div>

            {/* Floating tooltip */}
            <div
              className="time-slider-tooltip"
              style={{ left: `${pct}%` }}
              aria-hidden="true"
            >
              {formatLabel(availableDates[currentIndex])}
            </div>

            {/* Visual thumb */}
            <div
              className="time-slider-thumb"
              style={{ left: `${pct}%` }}
              aria-hidden="true"
            />

            {/* Native range input (transparent, captures pointer events) */}
            <input
              type="range"
              className="time-slider-input-real"
              min={0}
              max={availableDates.length - 1}
              value={currentIndex}
              onChange={handleRangeChange}
              aria-label="Timeline day"
            />
          </div>

          <span className="time-slider-edge">{formatLabel(lastDate)}</span>
        </div>

        {/* Step forward */}
        <button
          className="time-slider-step"
          onClick={stepForward}
          disabled={currentIndex === availableDates.length - 1}
          aria-label="Next day"
        >
          <StepFwdIcon />
        </button>

        {/* Current date stamp */}
        <span className="time-slider-current">
          {formatLabel(availableDates[currentIndex])}
        </span>
      </div>

      <PersistenceFilter
        value={minPersistence}
        onChange={onMinPersistenceChange}
      />
    </div>
  );
}

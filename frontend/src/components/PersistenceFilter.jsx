import React from 'react';

const OPTIONS = [
  { value: 0, label: 'All' },
  { value: 2, label: '2+ days' },
  { value: 3, label: '3+ days' },
  { value: 4, label: '4+ days' },
];

/**
 * Segmented control that filters persistent sources by how many days they have
 * been active (persistence_days). Pure client-side — each source already carries
 * its persistence_days, so nothing is fetched here.
 *
 * Persistence is a per-location property, so the filter applies at every slider
 * position.
 */
export default function PersistenceFilter({
  value,
  onChange,
}) {
  return (
    <div className="persistence-filter" aria-disabled="false">
      <span className="persistence-filter-label">Persistent</span>
      <div className="persistence-filter-options">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`persistence-filter-option ${
              value === opt.value ? 'is-active' : ''
            }`}
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

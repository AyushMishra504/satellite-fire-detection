import React, { useState } from 'react';

export default function ReportModal({ hotspot, mlPrediction, isOpen, onClose }) {
  const [reportType, setReportType] = useState('wrong_type');
  const [correctedType, setCorrectedType] = useState('agricultural_burn');
  const [notes, setNotes] = useState('');
  const [confidence, setConfidence] = useState('confirmed');
  const [reporterName, setReporterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reportId, setReportId] = useState('');

  if (!isOpen || !hotspot) return null;

  const lat = hotspot.latitude != null ? Number(hotspot.latitude).toFixed(4) : '—';
  const lon = hotspot.longitude != null ? Number(hotspot.longitude).toFixed(4) : '—';
  const frp = hotspot.frp != null ? Number(hotspot.frp).toFixed(1) : '—';
  const predictedType = mlPrediction?.firetype?.label 
    ? mlPrediction.firetype.label.replace(/_/g, ' ') 
    : hotspot.firetype 
      ? String(hotspot.firetype).replace(/_/g, ' ')
      : 'Unknown';

  const handleSubmit = (e) => {
    e.preventDefault();
    setIsSubmitting(true);

    // Simulate network submission to ground-truth feedback queue
    setTimeout(() => {
      const generatedId = 'SFD-REP-' + Math.floor(100000 + Math.random() * 900000);
      setReportId(generatedId);
      setIsSubmitting(false);
      setSubmitted(true);
    }, 600);
  };

  const handleResetAndClose = () => {
    setSubmitted(false);
    setNotes('');
    setReporterName('');
    setIsSubmitting(false);
    onClose();
  };

  return (
    <div className="report-modal-backdrop" onClick={handleResetAndClose} role="dialog" aria-modal="true">
      <div className="report-modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="report-modal-header">
          <div>
            <div className="report-modal-badge">Ground Truth Feedback</div>
            <h2 className="report-modal-title">Report Detection / ML Discrepancy</h2>
          </div>
          <button
            type="button"
            className="report-modal-close"
            onClick={handleResetAndClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>

        {submitted ? (
          <div className="report-modal-success">
            <div className="report-success-icon">✓</div>
            <h3 className="report-success-title">Feedback Submitted Successfully</h3>
            <p className="report-success-meta">Reference ID: <strong>{reportId}</strong></p>
            <p className="report-success-desc">
              Thank you for verifying this observation. Your ground truth report for coordinates{' '}
              <strong>{lat}°, {lon}°</strong> has been logged to the anomaly validation queue and
              will be utilized for retraining satellite detection and ML classification models.
            </p>
            <button
              type="button"
              className="report-modal-btn primary"
              onClick={handleResetAndClose}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="report-modal-form">
            {/* Target Hotspot Context Card */}
            <div className="report-target-summary">
              <div className="report-target-row">
                <span className="report-target-label">Location:</span>
                <span className="report-target-val">{lat}°, {lon}°</span>
              </div>
              <div className="report-target-row">
                <span className="report-target-label">Fire Radiative Power:</span>
                <span className="report-target-val">{frp} MW</span>
              </div>
              <div className="report-target-row">
                <span className="report-target-label">ML Classification:</span>
                <span className="report-target-val capitalize">{predictedType}</span>
              </div>
              {hotspot.acq_date && (
                <div className="report-target-row">
                  <span className="report-target-label">Acquired:</span>
                  <span className="report-target-val">{hotspot.acq_date} {hotspot.acq_time || ''} UTC</span>
                </div>
              )}
            </div>

            {/* Field 1: Discrepancy Type */}
            <div className="report-form-group">
              <label className="report-field-label" htmlFor="report-type-select">
                Discrepancy Category <span className="req-star">*</span>
              </label>
              <select
                id="report-type-select"
                className="report-field-select"
                value={reportType}
                onChange={(e) => setReportType(e.target.value)}
                required
              >
                <option value="wrong_type">Incorrect Fire Type (ML predicted wrong category)</option>
                <option value="false_positive">False Alarm / No Active Fire Present on Ground</option>
                <option value="wrong_persistence">Incorrect Persistence / Duration Risk</option>
                <option value="critical_threat">Unreported Critical Infrastructure Threat</option>
                <option value="other">Other Satellite / ML Inaccuracy</option>
              </select>
            </div>

            {/* Field 2: Observed Ground Truth */}
            <div className="report-form-group">
              <label className="report-field-label" htmlFor="corrected-type-select">
                Observed Ground Truth (Actual Situation)
              </label>
              <select
                id="corrected-type-select"
                className="report-field-select"
                value={correctedType}
                onChange={(e) => setCorrectedType(e.target.value)}
              >
                <option value="agricultural_burn">Agricultural / Stubble Burning</option>
                <option value="industrial_flare">Industrial Flare / Refinery Stack</option>
                <option value="wildfire">Wildfire / Forest Fire</option>
                <option value="prescribed_burn">Controlled Forestry / Prescribed Burn</option>
                <option value="mining_kiln">Brick Kiln / Mining Anomaly</option>
                <option value="solar_glint">Solar Reflection / Bright Surface (No Fire)</option>
                <option value="urban_heat">Urban Heat Island / Hot Surface</option>
                <option value="other">Other / Unclassified</option>
              </select>
            </div>

            {/* Field 3: Evidence & Notes */}
            <div className="report-form-group">
              <label className="report-field-label" htmlFor="report-notes">
                Observation Notes &amp; Ground Evidence
              </label>
              <textarea
                id="report-notes"
                className="report-field-textarea"
                rows="3"
                placeholder="Describe field conditions, visible smoke plume, local responder reports, or reason for discrepancy..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {/* Field 4: Confidence & Reporter Details */}
            <div className="report-form-row">
              <div className="report-form-group flex-1">
                <label className="report-field-label">Verification Source</label>
                <select
                  className="report-field-select"
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                >
                  <option value="confirmed">Direct Ground / Field Observation</option>
                  <option value="local_authority">Forest / Fire Department Report</option>
                  <option value="aerial">Aerial / Drone Survey</option>
                  <option value="satellite_imagery">High-Res Optical Imagery Analysis</option>
                </select>
              </div>

              <div className="report-form-group flex-1">
                <label className="report-field-label" htmlFor="reporter-id">
                  Reporter / Station ID (Optional)
                </label>
                <input
                  id="reporter-id"
                  type="text"
                  className="report-field-input"
                  placeholder="e.g. Range Officer / Division A"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                />
              </div>
            </div>

            <footer className="report-modal-footer">
              <button
                type="button"
                className="report-modal-btn cancel"
                onClick={handleResetAndClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="report-modal-btn submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Submitting Report…' : 'Submit Discrepancy Report'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

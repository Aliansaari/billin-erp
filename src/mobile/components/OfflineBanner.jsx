import React from 'react';
import './OfflineBanner.css';

/**
 * Shown whenever a screen is rendering snapshot data instead of live data.
 *
 * Non-dismissible by design. The whole risk of an offline mode in an
 * accounting app is someone acting on a figure they believe is current, so
 * the age stays on screen for as long as the stale figure does.
 */
export default function OfflineBanner({ age, onRetry }) {
  return (
    <div className="ob" role="status">
      <span className="ob-dot" aria-hidden />
      <span className="ob-text">
        Shop computer is offline · showing saved figures from <b>{age || 'earlier'}</b>
      </span>
      {onRetry && (
        <button type="button" className="ob-retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

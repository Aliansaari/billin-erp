import React from 'react';
import './OfflineBanner.css';

/**
 * Shown whenever a screen is rendering snapshot data instead of live data.
 *
 * Non-dismissible by design. The whole risk of an offline mode in an
 * accounting app is someone acting on a figure they believe is current, so
 * the age stays on screen for as long as the stale figure does.
 */
export default function OfflineBanner({ age, note, onRetry }) {
  return (
    <div className="ob" role="status">
      <span className="ob-dot" aria-hidden />
      <span className="ob-text">
        {/* `note` replaces the whole sentence tail, for the cases where there
            is nothing to date — no saved copy at all, or one belonging to a
            different company. Squeezing those into the "from <age>" slot
            produced "showing saved figures from no saved figures for this
            company", which is worse than saying nothing. */}
        {note
          ? <>Shop computer is offline · <b>{note}</b></>
          : <>Shop computer is offline · showing saved figures from <b>{age || 'earlier'}</b></>}
      </span>
      {onRetry && (
        <button type="button" className="ob-retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

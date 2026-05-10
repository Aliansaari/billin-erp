import React from 'react';

// Placeholder screen for tabs that don't have real implementations yet
// (Ledgers / Items / Reports). Renders the same chrome as a real screen
// so the tab bar and layout stay coherent.
export default function SimpleScreen({ title, message = 'Coming soon.' }) {
  return (
    <div className="mobile-screen drill-in">
      <div className="topbar safe-area-top">
        <div className="topbar-title">
          <h1>{title}</h1>
        </div>
      </div>
      <div className="mobile-screen-body">
        <div className="empty">{message}</div>
      </div>
    </div>
  );
}

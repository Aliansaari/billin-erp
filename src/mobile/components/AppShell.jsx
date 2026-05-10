import React from 'react';
import { Outlet } from 'react-router-dom';
import TabBar from './TabBar';

// Shell that wraps the five primary screens (Home/Vouchers/Ledgers/Items/
// Reports). Renders the active route via <Outlet> with the persistent
// bottom TabBar. Drill-down screens (e.g. bill detail) sit OUTSIDE the
// shell so they can choose whether to keep the tab bar visible — for the
// first cut, bill detail also shows the bar (matches the mockup pattern
// where users can jump tabs from anywhere).
export default function AppShell() {
  return (
    <div className="app-shell">
      <div className="app-shell-body">
        <Outlet />
      </div>
      <TabBar />
    </div>
  );
}

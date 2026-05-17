import React, { useEffect, useState } from 'react';
import DeveloperGate from './DeveloperGate';

/* ── DeveloperGateMount ────────────────────────────────────────────────
 *
 * Global singleton that owns the developer-access password modal and the
 * `dev-gate:open` window-event listener (fired by GlobalSearch when the
 * operator types the hidden "/__dev" string).
 *
 * This used to live inside Sidebar.jsx — which meant the trigger silently
 * did nothing whenever the app ran in the horizontal top-nav layout
 * (Sidebar isn't mounted there, so nothing listened for the event). Mounted
 * here once at the App level, alongside GlobalSearchModal, it works in
 * every layout.
 * ──────────────────────────────────────────────────────────────────── */
export default function DeveloperGateMount() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('dev-gate:open', onOpen);
    return () => window.removeEventListener('dev-gate:open', onOpen);
  }, []);

  return <DeveloperGate open={open} onClose={() => setOpen(false)} />;
}

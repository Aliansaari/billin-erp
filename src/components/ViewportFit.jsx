import { useEffect } from 'react';

// ── Scale-to-fit ("everything stays in place at any window size") ───────
//
// The app is authored for a ~1366px-wide canvas (the most common laptop).
// This component zooms the whole document so that canvas always FILLS the
// viewport width: landscape tablets (~1024) scale down to ~0.75, big
// monitors scale up to fill — and because it's a uniform zoom, every
// element keeps its EXACT relative position (no reflow, no squish, no
// horizontal scrollbar).
//
// Why CSS `zoom` (not `transform: scale`):
//   • `zoom` is a real layout zoom in Chromium (Electron + modern browsers)
//     — text stays crisp, and the layout viewport rescales so `100vh`
//     fills correctly (no letterbox strip).
//   • Ant Design popups/modals portal to <body>, which is INSIDE <html>,
//     so zooming <html> scales them too — dropdowns and dialogs line up.
//
// Self-contained + reversible: unmounting clears the zoom and the app
// reverts to its previous fluid behaviour.
const REFERENCE_WIDTH = 1366;   // design canvas width → zoom = 1.0 here
const MIN_ZOOM = 0.6;           // floor so very narrow windows stay legible
// Never zoom IN past natural size: laptops and big monitors (≥1366) stay at
// exactly their original size (zoom 1.0) — only smaller/tablet screens scale
// DOWN to fit. (Zooming up on a 27" made everything ~1.5× and overflowed.)
const MAX_ZOOM = 1.0;

export default function ViewportFit() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      // window.innerWidth is the true physical viewport width even while a
      // CSS `zoom` is applied (verified), so the ratio stays correct and
      // there's no feedback loop.
      const w = window.innerWidth || REFERENCE_WIDTH;
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, w / REFERENCE_WIDTH));
      // Round to 3dp so sub-pixel resizes don't thrash the style.
      root.style.zoom = String(Math.round(z * 1000) / 1000);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      root.style.zoom = '';
    };
  }, []);
  return null;
}

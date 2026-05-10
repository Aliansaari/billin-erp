// When CAPACITOR_LIVE_RELOAD_URL is set, the iOS/Android shell loads its
// web content from that URL (typically the Vite dev server on the Mac)
// instead of the bundled dist-mobile/ assets. Enables instant code → device
// updates without rebuilding the native project.
//
// Set this via `npm run cap:ios:dev` — that script auto-detects your Mac's
// LAN IP and runs cap sync with the env var populated. Without it, the
// shell loads bundled assets — production behaviour.
const liveReloadUrl = process.env.CAPACITOR_LIVE_RELOAD_URL;

const baseServer = {
  androidScheme: 'https',
  iosScheme: 'capacitor',
};

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.sabina.billingerp',
  appName: 'Billing ERP',
  webDir: 'dist-mobile',
  server: liveReloadUrl
    ? { ...baseServer, url: liveReloadUrl, cleartext: true, errorPath: 'dev-error.html' }
    : baseServer,
  // ── Keyboard ────────────────────────────────────────────────────────
  // resize: 'none' means the WebView keeps its full size when the soft
  // keyboard appears — the keyboard simply overlays the bottom of the
  // screen instead of squeezing the page. Combined with
  // Keyboard.setScroll({ isDisabled: true }) at runtime (see
  // src/main.mobile.jsx), iOS stops shoving the whole login form up
  // when the user taps a field. Inputs at the bottom of the page may
  // get covered — manage with explicit scroll-into-view if/when that
  // matters; the login form is short enough to stay visible above.
  plugins: {
    Keyboard: {
      resize: 'none',
      resizeOnFullScreen: false,
    },
  },
};

module.exports = config;

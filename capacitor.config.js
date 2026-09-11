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
  cleartext: true,   // allow http:// LAN API calls (ATS exception for local network)
};

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.sabina.zehen',
  appName: 'ZEHEN',
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
    // Route fetch/XHR through native NSURLSession instead of WebKit's fetch.
    // This bypasses WKWebView's restrictions on HTTP connections to LAN IPs.
    CapacitorHttp: {
      enabled: true,
    },
    /* The on-device mirror's encrypted store.
     *
     * `iosIsEncryption` is NOT optional decoration: the plugin defaults it to
     * false when the key is absent, and every secret operation then fails
     * with "No Encryption set in capacitor.config" — which is exactly how
     * this first shipped. Encryption is a config-time decision on iOS, not a
     * runtime one, so it has to live here.
     *
     * biometricAuth stays false deliberately. Turning it on would make the
     * PLUGIN demand Face ID before the database opens, which would quietly
     * override the owner's own choice about the app lock and lock them out
     * of their books mid-sale if a scan failed. The app lock is a separate,
     * optional thing (see utils/biometric.js).
     *
     * Library/ rather than Documents/ so the file is not exposed through the
     * Files app when document sharing is enabled. */
    CapacitorSQLite: {
      iosIsEncryption: true,
      iosKeychainPrefix: 'zehen',
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosBiometric: { biometricAuth: false },
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false },
    },
  },
};

module.exports = config;

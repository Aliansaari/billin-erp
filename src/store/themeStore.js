import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { themeTokens, resolveMode } from '../theme/tokens';

/**
 * themeStore — theme style + appearance preferences.
 *
 * Shape:
 *   themeStyle: 'classic' | 'modern'
 *   appearance: 'light' | 'dark' | 'system'
 *
 * Legacy fields (colorPrimary, sidebarStyle, compactMode, …) are kept so any
 * older code that reads them via getAntdTheme() doesn't break while we finish
 * the UI overhaul. They can be removed in a later cleanup pass.
 */

const defaults = {
  themeStyle: 'classic',
  appearance: 'system',
  // menuOrientation: 'vertical' (sidebar, default) or 'horizontal' (top-nav).
  // Persisted like theme/appearance so the operator's layout choice survives
  // reloads and cross-tab navigation.
  menuOrientation: 'vertical',
  // accent: null (use theme's natural primary) or hex string ('#0EA5E9') to
  // override colorPrimary across the app. Applied in ThemeProvider via CSS
  // vars and Antd ConfigProvider, so a single setter re-skins everything.
  accent: null,

  // Legacy fields — kept for transitional compat. New code should not read these.
  colorPrimary: '#4F46E5',
  colorSuccess: '#10B981',
  colorWarning: '#F59E0B',
  colorError:   '#EF4444',
  borderRadius: 10,
  fontSize:     14,
  fontFamily:   "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sidebarStyle: 'dark',
  compactMode:  false,
  colorBgLayout:'#F0F2F5',
};

const useThemeStore = create(
  persist(
    (set, get) => ({
      ...defaults,

      /** Change theme style: 'classic' or 'modern'. */
      setThemeStyle: (style) => set({ themeStyle: style === 'modern' ? 'modern' : 'classic' }),

      /** Change appearance: 'light', 'dark', or 'system'. */
      setAppearance: (mode) =>
        set({ appearance: ['light', 'dark', 'system'].includes(mode) ? mode : 'system' }),

      /** Flip menu orientation between vertical (sidebar) and horizontal (top-nav). */
      setMenuOrientation: (orientation) =>
        set({ menuOrientation: orientation === 'horizontal' ? 'horizontal' : 'vertical' }),
      toggleMenuOrientation: () =>
        set((s) => ({ menuOrientation: s.menuOrientation === 'horizontal' ? 'vertical' : 'horizontal' })),

      /** Override the theme's natural primary colour. Pass null to clear. */
      setAccent: (hex) =>
        set({ accent: typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null }),

      /** Resolve current effective mode key (e.g. 'modern-dark'). */
      resolveMode: () => {
        const s = get();
        return resolveMode(s.themeStyle, s.appearance);
      },

      /** Current AntD ConfigProvider token object for the resolved mode. */
      getAntdTheme: () => {
        const s = get();
        const mode = resolveMode(s.themeStyle, s.appearance);
        return themeTokens[mode] || themeTokens['classic-light'];
      },

      resetTheme: () => set(defaults),

      /**
       * Back-compat — older components called updateTheme({ colorPrimary, ... })
       * to tweak individual tokens. That ad-hoc shape doesn't fit the new
       * style/appearance model, so this accepts the call but ignores payloads
       * that aren't `themeStyle` or `appearance`. Prevents crashes while we
       * migrate the UI.
       */
      updateTheme: (partial = {}) => {
        const next = {};
        if (partial.themeStyle) next.themeStyle = partial.themeStyle;
        if (partial.appearance) next.appearance = partial.appearance;
        if (Object.keys(next).length) set(next);
      },
    }),
    {
      name: 'erp-theme',
      // Migration: older stored values don't have themeStyle/appearance.
      // Fill them with defaults so rehydration never produces undefined.
      migrate: (persisted) => ({
        ...defaults,
        ...persisted,
        themeStyle: persisted?.themeStyle || defaults.themeStyle,
        appearance: persisted?.appearance || defaults.appearance,
        // v3: menuOrientation added. Older stores default to 'vertical'
        // so the switch is opt-in and nobody gets surprised by a new layout.
        menuOrientation: persisted?.menuOrientation === 'horizontal' ? 'horizontal' : 'vertical',
        // v4: accent override (null = theme default).
        accent: typeof persisted?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(persisted.accent)
          ? persisted.accent : null,
      }),
      version: 4,
    },
  ),
);

export default useThemeStore;

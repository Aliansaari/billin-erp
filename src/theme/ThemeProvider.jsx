import React, { useEffect, useMemo } from 'react';
import { ConfigProvider, App as AntApp } from 'antd';
import useThemeStore from '../store/themeStore';
import { themeTokens, resolveMode } from './tokens';

import './themes.css';
import './glass.css';
import './print.css';

// Convert "#4F46E5" → "rgba(79, 70, 229, alpha)" so theme tokens that
// expect rgba() bg/border tints can be derived from the user's pick.
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Darken a hex by `amt` (0..1). Used for hover state.
function darken(hex, amt) {
  const h = hex.replace('#', '');
  const adj = (n) => Math.max(0, Math.round(n - 255 * amt));
  const r = adj(parseInt(h.slice(0, 2), 16));
  const g = adj(parseInt(h.slice(2, 4), 16));
  const b = adj(parseInt(h.slice(4, 6), 16));
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * ThemeProvider
 *
 * Single source of truth for the active theme. It does three things:
 *   1. Sets `data-theme` on <html> so every CSS custom-property block in
 *      themes.css cascades into the page.
 *   2. Passes the matching token set into <ConfigProvider> so every AntD
 *      component re-renders with the new palette.
 *   3. Listens to `matchMedia('(prefers-color-scheme: dark)')` so Appearance
 *      = "System" tracks the OS preference live — no reload needed.
 *
 * The effective mode is `${themeStyle}-${resolvedAppearance}` where `system`
 * collapses to light or dark based on OS. Everything downstream reads from
 * CSS vars so there's no JS-level mode branching in page components.
 */
export default function ThemeProvider({ children }) {
  const themeStyle = useThemeStore((s) => s.themeStyle);
  const appearance = useThemeStore((s) => s.appearance);
  const accent     = useThemeStore((s) => s.accent);

  const mode = resolveMode(themeStyle, appearance);
  const baseConfig = themeTokens[mode] || themeTokens['classic-light'];

  // When the user picks an accent override, splice it into BOTH the
  // Antd ConfigProvider tokens AND the document's CSS vars. Antd
  // components honour colorPrimary; everything else in the app reads
  // var(--accent) / var(--accent-bg) / etc. so both layers must
  // stay in sync.
  const antdConfig = useMemo(() => {
    if (!accent) return baseConfig;
    return {
      ...baseConfig,
      token: { ...baseConfig.token, colorPrimary: accent },
    };
  }, [baseConfig, accent]);

  // Apply data-theme on <html> so CSS vars update instantly.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Override accent CSS vars on <html> (or clear them so the theme's
  // natural values take over again).
  //
  // Includes --sidebar-active because the Sidebar's selected-item
  // background and the matching TopNav active pill both read from
  // it, NOT from --accent — so without this line the side menus
  // would keep showing the theme's native primary while everything
  // else had switched to the user's pick.
  useEffect(() => {
    const root = document.documentElement;
    const props = [
      '--accent', '--accent-text', '--accent-hover',
      '--accent-bg', '--accent-border', '--sidebar-active',
    ];
    if (accent) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-text', accent);
      root.style.setProperty('--accent-hover', darken(accent, 0.1));
      root.style.setProperty('--accent-bg', hexToRgba(accent, 0.08));
      root.style.setProperty('--accent-border', hexToRgba(accent, 0.20));
      root.style.setProperty('--sidebar-active', accent);
    } else {
      props.forEach((p) => root.style.removeProperty(p));
    }
  }, [accent]);

  // When Appearance = 'system', re-render on OS change so the resolved mode
  // picks up light↔dark flips without a reload.
  useEffect(() => {
    if (appearance !== 'system' || typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      // Trigger a re-render by touching the document theme — the store value
      // is unchanged but resolveMode() output flips.
      const next = resolveMode(themeStyle, 'system');
      document.documentElement.dataset.theme = next;
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [appearance, themeStyle]);

  return (
    <ConfigProvider theme={antdConfig}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}

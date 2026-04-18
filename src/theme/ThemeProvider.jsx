import React, { useEffect } from 'react';
import { ConfigProvider, App as AntApp } from 'antd';
import useThemeStore from '../store/themeStore';
import { themeTokens, resolveMode } from './tokens';

import './themes.css';
import './glass.css';
import './print.css';

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

  const mode = resolveMode(themeStyle, appearance);
  const antdConfig = themeTokens[mode] || themeTokens['classic-light'];

  // Apply data-theme on <html> so CSS vars update instantly.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

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

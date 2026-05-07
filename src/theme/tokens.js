/**
 * AntD ConfigProvider token sets — one per theme mode.
 *
 * These keep AntD components (Button, Card, Table, Input, etc.) visually in
 * step with the CSS custom properties defined in themes.css. AntD uses
 * CSS-in-JS internally, so we pass full token objects rather than variable
 * references — otherwise hash changes on every mount would invalidate the
 * component style cache.
 *
 * The numeric scale (controlHeight, borderRadius, fontSize) is IDENTICAL
 * across modes so page layouts don't shift when the user switches themes.
 * Only colors, fills, and shadows change.
 */

import { theme as antdTheme } from 'antd';

const scale = {
  borderRadius: 10,
  fontSize: 14,
  fontFamily: "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  controlHeight: 36,
  controlHeightTall: 38,
};

// ─── Component overrides shared by all modes ────────────────────────────────
const commonComponents = {
  Button:      { borderRadius: scale.borderRadius, controlHeight: scale.controlHeight, fontWeight: 500 },
  Card:        { borderRadiusLG: scale.borderRadius + 2 },
  Table:       { borderRadius: scale.borderRadius },
  Input:       { controlHeight: scale.controlHeightTall, borderRadius: scale.borderRadius },
  Select:      { controlHeight: scale.controlHeightTall, borderRadius: scale.borderRadius },
  InputNumber: { controlHeight: scale.controlHeightTall, borderRadius: scale.borderRadius },
  DatePicker:  { controlHeight: scale.controlHeightTall, borderRadius: scale.borderRadius },
  Menu:        { itemBorderRadius: 8, itemMarginInline: 8, subMenuItemBorderRadius: 6 },
  Modal:       { borderRadiusLG: scale.borderRadius + 4 },
  Statistic:   { titleFontSize: 13, contentFontSize: 24 },
};

// ─── Mode-specific palettes ─────────────────────────────────────────────────
export const themeTokens = {
  'classic-light': {
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      ...scale,
      colorPrimary:      '#4F46E5',
      colorSuccess:      '#10B981',
      colorWarning:      '#F59E0B',
      colorError:        '#EF4444',
      colorInfo:         '#3B82F6',
      colorBgLayout:     '#f5f7fa',
      colorBgContainer:  '#ffffff',
      colorBgElevated:   '#ffffff',
      colorText:         '#1f2937',
      colorTextSecondary:'#6b7280',
      colorBorder:       '#e5e7eb',
      colorBorderSecondary:'#f0f0f0',
      motion: true,
    },
    components: {
      ...commonComponents,
      Table: {
        ...commonComponents.Table,
        headerBg:          'rgba(79,70,229,0.05)',
        headerColor:       '#1f2937',
        rowHoverBg:        'rgba(79,70,229,0.04)',
        headerSortActiveBg:'rgba(79,70,229,0.08)',
      },
      Card: { ...commonComponents.Card, boxShadowTertiary: '0 1px 2px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.02)' },
    },
  },

  /* ─── Classic-Dark "Onyx" — long-session-friendly warm charcoal ──
   * Three deliberate shifts away from the previous generic cool-slate
   * (see themes.css for full design notes): warm-charcoal backgrounds
   * instead of navy-blue (less melatonin disruption), warm-tinted
   * text instead of pure cool white (less glare), lighter accent for
   * better dark-mode visibility. */
  'classic-dark': {
    algorithm: antdTheme.darkAlgorithm,
    token: {
      ...scale,
      colorPrimary:      '#A5B4FC',
      colorSuccess:      '#4ADE80',
      colorWarning:      '#FBBF24',
      colorError:        '#FB7185',
      colorInfo:         '#7DD3FC',
      colorBgLayout:     '#0F1217',
      colorBgContainer:  '#1A1F2A',
      colorBgElevated:   '#232936',
      colorText:         '#E8ECF1',
      colorTextSecondary:'#A6AEBC',
      colorBorder:       '#2A2F3B',
      colorBorderSecondary:'#1F242F',
      motion: true,
    },
    components: {
      ...commonComponents,
      Table: {
        ...commonComponents.Table,
        headerBg:          '#141821',
        headerColor:       '#E8ECF1',
        rowHoverBg:        'rgba(165, 180, 252, 0.06)',
        headerSortActiveBg:'rgba(165, 180, 252, 0.12)',
      },
      Card: { ...commonComponents.Card, colorBgContainer: '#1A1F2A' },
      Menu: { ...commonComponents.Menu, darkItemBg: '#0A0D12', darkSubMenuItemBg: '#0A0D12' },
    },
  },

  /* ─── Modern-Light (warm cream + terracotta) ─────────────────────────── */
  'modern-light': {
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      ...scale,
      borderRadius: 10,
      colorPrimary:      '#B1472F',
      colorSuccess:      '#7A9660',
      colorWarning:      '#B8923C',
      colorError:        '#B1472F',
      colorInfo:         '#7A9660',
      colorBgLayout:     '#F5EFE3',
      colorBgContainer:  '#FDFAF2',
      colorBgElevated:   '#FFFCF4',
      colorText:         '#1D1A15',
      colorTextSecondary:'#6D5F4E',
      colorBorder:       '#E3D9C5',
      colorBorderSecondary:'#ECE2CD',
      motion: true,
    },
    components: {
      ...commonComponents,
      Button:      { ...commonComponents.Button, borderRadius: 8, fontWeight: 500 },
      Card:        { ...commonComponents.Card, borderRadiusLG: 10, boxShadowTertiary: '0 8px 24px rgba(45,31,21,0.06)' },
      Table: {
        borderRadius: 10,
        headerBg:          '#F8F2E4',
        headerColor:       '#1D1A15',
        rowHoverBg:        '#F8F2E4',
        headerSortActiveBg:'rgba(177,71,47,0.08)',
      },
      Input:       { ...commonComponents.Input,       borderRadius: 8 },
      Select:      { ...commonComponents.Select,      borderRadius: 8 },
      InputNumber: { ...commonComponents.InputNumber, borderRadius: 8 },
      DatePicker:  { ...commonComponents.DatePicker,  borderRadius: 8 },
      Modal:       { ...commonComponents.Modal,       borderRadiusLG: 14 },
      Menu:        { ...commonComponents.Menu, darkItemBg: '#1D1814', darkSubMenuItemBg: 'rgba(245,238,226,0.04)' },
    },
  },

  /* ─── Modern-Dark (warm near-black + terracotta) ───────────────────────── */
  'modern-dark': {
    algorithm: antdTheme.darkAlgorithm,
    token: {
      ...scale,
      borderRadius: 10,
      colorPrimary:      '#E26A4C',
      colorSuccess:      '#94B885',
      colorWarning:      '#D4A574',
      colorError:        '#E26A4C',
      colorInfo:         '#94B885',
      colorBgLayout:     '#0E0B08',
      colorBgContainer:  '#1A1713',
      colorBgElevated:   '#211C16',
      colorText:         '#F5EEE2',
      colorTextSecondary:'#B2A791',
      colorBorder:       '#2E2922',
      colorBorderSecondary:'#24201A',
      motion: true,
    },
    components: {
      ...commonComponents,
      Button:      { ...commonComponents.Button, borderRadius: 8, fontWeight: 500 },
      Card:        { ...commonComponents.Card, borderRadiusLG: 10, boxShadowTertiary: '0 12px 32px rgba(0,0,0,0.4)' },
      Table: {
        borderRadius: 10,
        headerBg:          '#14110D',
        headerColor:       '#F5EEE2',
        rowHoverBg:        '#24201B',
        headerSortActiveBg:'rgba(226,106,76,0.12)',
      },
      Input:       { ...commonComponents.Input,       borderRadius: 8 },
      Select:      { ...commonComponents.Select,      borderRadius: 8 },
      InputNumber: { ...commonComponents.InputNumber, borderRadius: 8 },
      DatePicker:  { ...commonComponents.DatePicker,  borderRadius: 8 },
      Modal:       { ...commonComponents.Modal,       borderRadiusLG: 14 },
      Menu:        { ...commonComponents.Menu, darkItemBg: '#0B0807', darkSubMenuItemBg: 'rgba(245,238,226,0.03)' },
    },
  },
};

export const THEME_STYLES = ['classic', 'modern'];
export const APPEARANCES  = ['light', 'dark', 'system'];

/** Resolve the effective mode key given current state + OS preference. */
export function resolveMode(themeStyle, appearance) {
  const style = THEME_STYLES.includes(themeStyle) ? themeStyle : 'classic';
  let effective = appearance;
  if (effective === 'system' || !APPEARANCES.includes(effective)) {
    effective = (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }
  return `${style}-${effective}`;
}

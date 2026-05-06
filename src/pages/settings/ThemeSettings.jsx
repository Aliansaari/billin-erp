import React from 'react';
import {
  SunOutlined, MoonOutlined, DesktopOutlined,
  CheckOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import useThemeStore from '../../store/themeStore';
import { resolveMode } from '../../theme/tokens';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ThemeSettings.css';

/**
 * Theme Settings — visual picker for theme style × appearance ×
 * menu layout, plus a live mini-app preview that updates as the
 * operator changes options.
 *
 * Each option renders as a CARD with a real preview (mini mockup,
 * colour swatch, layout diagram) so the user can see what they're
 * picking before they commit. Beats stock Segmented/radio controls
 * for a setting that's all about how the software LOOKS.
 *
 * Choices persist via the themeStore (localStorage) and propagate
 * instantly through ThemeProvider — no reload needed.
 */
export default function ThemeSettings() {
  const navigate = useNavigate();

  const themeStyle       = useThemeStore((s) => s.themeStyle);
  const appearance       = useThemeStore((s) => s.appearance);
  const menuOrientation  = useThemeStore((s) => s.menuOrientation);
  const setThemeStyle    = useThemeStore((s) => s.setThemeStyle);
  const setAppearance    = useThemeStore((s) => s.setAppearance);
  const setMenuOrientation = useThemeStore((s) => s.setMenuOrientation);
  const resetTheme       = useThemeStore((s) => s.resetTheme);

  const resolved = resolveMode(themeStyle, appearance);

  return (
    <div className="theme-page">
      <div className="theme-page-header">
        <div>
          <h1 className="theme-page-title">Theme</h1>
          <p className="theme-page-sub">
            Customize how Billing ERP looks. Changes apply instantly — no restart needed.
          </p>
        </div>
        <span className="theme-page-current" title="Active theme mode">
          {resolved}
        </span>
      </div>

      {/* ── Theme Style ── */}
      <section className="theme-section">
        <div className="theme-section-head">
          <h2 className="theme-section-title">Style</h2>
          <p className="theme-section-help">Crisp indigo vs. warm editorial palette.</p>
        </div>
        <div className="theme-grid theme-grid-2">
          <ThemeOption
            active={themeStyle === 'classic'}
            onSelect={() => setThemeStyle('classic')}
            name="Classic"
            desc="Indigo accent · crisp panels"
            preview={<StyleMock variant="classic" />}
          />
          <ThemeOption
            active={themeStyle === 'modern'}
            onSelect={() => setThemeStyle('modern')}
            name="Editorial"
            desc="Cream + terracotta · magazine feel"
            preview={<StyleMock variant="modern" />}
          />
        </div>
      </section>

      {/* ── Appearance ── */}
      <section className="theme-section">
        <div className="theme-section-head">
          <h2 className="theme-section-title">Appearance</h2>
          <p className="theme-section-help">
            Light is soft off-white. Dark uses muted slate. System follows your OS.
          </p>
        </div>
        <div className="theme-grid theme-grid-3">
          <ThemeOption
            active={appearance === 'light'}
            onSelect={() => setAppearance('light')}
            name="Light"
            desc="Soft off-white"
            preview={
              <div className="theme-swatch light">
                <SunOutlined className="theme-swatch-icon" />
              </div>
            }
          />
          <ThemeOption
            active={appearance === 'dark'}
            onSelect={() => setAppearance('dark')}
            name="Dark"
            desc="Muted slate"
            preview={
              <div className="theme-swatch dark">
                <MoonOutlined className="theme-swatch-icon" />
              </div>
            }
          />
          <ThemeOption
            active={appearance === 'system'}
            onSelect={() => setAppearance('system')}
            name="System"
            desc="Follows OS"
            preview={
              <div className="theme-swatch system">
                <DesktopOutlined className="theme-swatch-icon" />
              </div>
            }
          />
        </div>
      </section>

      {/* ── Menu Layout ── */}
      <section className="theme-section">
        <div className="theme-section-head">
          <h2 className="theme-section-title">Menu Layout</h2>
          <p className="theme-section-help">
            Sidebar runs down the left. Top nav frees the full content width.
          </p>
        </div>
        <div className="theme-grid theme-grid-2">
          <ThemeOption
            active={menuOrientation === 'vertical'}
            onSelect={() => setMenuOrientation('vertical')}
            name="Sidebar"
            desc="Left rail (default)"
            preview={<LayoutDiagram variant="vertical" />}
          />
          <ThemeOption
            active={menuOrientation === 'horizontal'}
            onSelect={() => setMenuOrientation('horizontal')}
            name="Top bar"
            desc="Horizontal nav"
            preview={<LayoutDiagram variant="horizontal" />}
          />
        </div>
      </section>

      {/* ── Live preview ── */}
      <section className="theme-section">
        <div className="theme-section-head">
          <h2 className="theme-section-title">Live preview</h2>
          <p className="theme-section-help">A mini-render of the current settings.</p>
        </div>
        <PreviewFrame layout={menuOrientation} />
      </section>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'reset', key: 'F2', label: 'Reset', icon: <ReloadOutlined />,
            danger: true,
            onAction: () => {
              if (window.confirm('Reset theme, appearance and menu layout to defaults?')) {
                resetTheme();
              }
            },
          },
        ]}
      />
    </div>
  );
}

/* ── Pieces ── */

function ThemeOption({ active, onSelect, name, desc, preview }) {
  return (
    <button
      type="button"
      className={`theme-opt${active ? ' active' : ''}`}
      onClick={onSelect}
      aria-pressed={active}
    >
      {preview}
      <div className="theme-opt-label">
        <div>
          <div className="theme-opt-name">{name}</div>
          <div className="theme-opt-desc">{desc}</div>
        </div>
        {active && <span className="theme-opt-check"><CheckOutlined /></span>}
      </div>
    </button>
  );
}

function StyleMock({ variant }) {
  return (
    <div className={`theme-mock ${variant}`}>
      <div className="theme-mock-sidebar" />
      <div className="theme-mock-main">
        <div className="theme-mock-bar lg" />
        <div className="theme-mock-cards">
          <div className="theme-mock-card" />
          <div className="theme-mock-card" />
        </div>
      </div>
    </div>
  );
}

function LayoutDiagram({ variant }) {
  return (
    <div className={`theme-layout ${variant}`}>
      <div className="theme-layout-content">
        <div className="theme-layout-row" />
        <div className="theme-layout-row short" />
        <div className="theme-layout-row" />
      </div>
    </div>
  );
}

/**
 * PreviewFrame — a real-looking mini app render so the operator sees
 * the full effect of theme/appearance/layout choices in one place,
 * not just an abstract pair of KPI cards.
 */
function PreviewFrame({ layout }) {
  return (
    <div className="theme-preview">
      <div className="theme-preview-frame">
        <div className="theme-preview-topnav">
          <span className="theme-preview-topnav-brand">B</span>
          <span className="theme-preview-topnav-title">Billing ERP</span>
          <span className="theme-preview-topnav-pill">Home</span>
          <span className="theme-preview-topnav-pill active">Sales</span>
          <span className="theme-preview-topnav-pill">Purchase</span>
          <span className="theme-preview-topnav-pill">Reports</span>
          <span style={{ flex: 1 }} />
          <span className="theme-preview-topnav-pill" style={{ fontFamily: 'ui-monospace, monospace' }}>
            ⌘K
          </span>
        </div>
        <div className="theme-preview-body">
          <div className="theme-preview-card">
            <span className="theme-preview-card-label">Sales today</span>
            <span className="theme-preview-card-value">₹ 2,48,350</span>
            <span className="theme-preview-card-tag">↑ 12.4%</span>
          </div>
          <div className="theme-preview-card">
            <span className="theme-preview-card-label">Outstanding</span>
            <span className="theme-preview-card-value">₹ 1,96,800</span>
            <span className="theme-preview-card-tag warn">14 bills pending</span>
          </div>
          <div className="theme-preview-card">
            <span className="theme-preview-card-label">Layout</span>
            <span className="theme-preview-card-value" style={{ fontSize: 15 }}>
              {layout === 'horizontal' ? 'Top bar' : 'Sidebar'}
            </span>
            <span className="theme-preview-card-tag muted">switched live</span>
          </div>
        </div>
      </div>
    </div>
  );
}

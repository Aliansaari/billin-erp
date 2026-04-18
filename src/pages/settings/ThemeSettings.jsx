import React from 'react';
import { Card, Typography, Segmented, Space, Row, Col, Tag } from 'antd';
import {
  SunOutlined, MoonOutlined, DesktopOutlined,
  LayoutOutlined, BgColorsOutlined,
} from '@ant-design/icons';
import useThemeStore from '../../store/themeStore';
import { resolveMode } from '../../theme/tokens';

const { Title, Text } = Typography;

/**
 * Theme Settings — user-facing control for Theme Style × Appearance.
 *
 * Choices persist via the themeStore (localStorage) and propagate instantly
 * through ThemeProvider — no reload needed. A live preview card below the
 * controls shows exactly how a panel looks in the chosen combination.
 */
export default function ThemeSettings() {
  const themeStyle   = useThemeStore((s) => s.themeStyle);
  const appearance   = useThemeStore((s) => s.appearance);
  const setThemeStyle = useThemeStore((s) => s.setThemeStyle);
  const setAppearance = useThemeStore((s) => s.setAppearance);

  const resolved = resolveMode(themeStyle, appearance);
  const isModern = themeStyle === 'modern';

  return (
    <div style={{ padding: '24px clamp(12px, 2vw, 32px)', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0, color: 'var(--fg-primary)' }}>
          Theme
        </Title>
        <Text style={{ color: 'var(--fg-secondary)' }}>
          Pick how the software looks. Changes apply instantly — no restart needed.
        </Text>
      </div>

      {/* ── Theme Style ── */}
      <Card
        className="erp-glass"
        bodyStyle={{ padding: 24 }}
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 20 }}
      >
        <Space align="start" size={16} style={{ display: 'flex', marginBottom: 16 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'var(--accent-bg)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>
            <LayoutOutlined />
          </div>
          <div>
            <Title level={5} style={{ margin: 0, color: 'var(--fg-primary)' }}>Theme Style</Title>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
              Classic keeps the current familiar UI. Modern uses a calm, glassy aesthetic.
            </Text>
          </div>
        </Space>
        <Segmented
          size="large"
          value={themeStyle}
          onChange={(v) => setThemeStyle(v)}
          options={[
            { label: (<SegmentLabel title="Classic"  subtitle="Current UI, crisp & opaque" />), value: 'classic' },
            { label: (<SegmentLabel title="Modern"   subtitle="Frosted glass, calm teal accent" />), value: 'modern'  },
          ]}
          block
        />
      </Card>

      {/* ── Appearance ── */}
      <Card
        className="erp-glass"
        bodyStyle={{ padding: 24 }}
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 24 }}
      >
        <Space align="start" size={16} style={{ display: 'flex', marginBottom: 16 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'var(--accent-bg)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>
            <BgColorsOutlined />
          </div>
          <div>
            <Title level={5} style={{ margin: 0, color: 'var(--fg-primary)' }}>Appearance</Title>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
              Light is soft off-white. Dark uses muted slate (not pure black). System follows your OS.
            </Text>
          </div>
        </Space>
        <Segmented
          size="large"
          value={appearance}
          onChange={(v) => setAppearance(v)}
          options={[
            { label: (<SegmentLabel icon={<SunOutlined />}     title="Light"   subtitle="Soft off-white" />), value: 'light'  },
            { label: (<SegmentLabel icon={<MoonOutlined />}    title="Dark"    subtitle="Muted slate" />),     value: 'dark'   },
            { label: (<SegmentLabel icon={<DesktopOutlined />} title="System"  subtitle="Follows OS" />),      value: 'system' },
          ]}
          block
        />
      </Card>

      {/* ── Live Preview ── */}
      <div style={{ marginBottom: 12 }}>
        <Text strong style={{ color: 'var(--fg-primary)', fontSize: 14 }}>Preview</Text>
        <Tag
          style={{
            marginLeft: 10, background: 'var(--accent-bg)', color: 'var(--accent)',
            border: '1px solid var(--accent-border)', borderRadius: 999, fontWeight: 600,
          }}
        >
          {resolved}
        </Tag>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <div
            className="erp-glass"
            style={{
              padding: 20, background: 'var(--bg-panel)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
              minHeight: 180,
            }}
          >
            <Text style={{ color: 'var(--fg-tertiary)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Today's Sales
            </Text>
            <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--fg-primary)', margin: '6px 0' }}>
              ₹ 2,48,350
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <span style={{
                fontSize: 12, fontWeight: 600,
                background: 'var(--success-bg)', color: 'var(--success)',
                padding: '3px 10px', borderRadius: 999,
              }}>
                ↑ 12.4%
              </span>
              <Text style={{ color: 'var(--fg-secondary)', fontSize: 12 }}>vs. yesterday</Text>
            </div>
          </div>
        </Col>
        <Col xs={24} md={12}>
          <div
            className="erp-glass"
            style={{
              padding: 20, background: 'var(--bg-panel)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
              minHeight: 180,
            }}
          >
            <Text style={{ color: 'var(--fg-tertiary)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Outstanding
            </Text>
            <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--fg-primary)', margin: '6px 0' }}>
              ₹ 1,96,800
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <span style={{
                fontSize: 12, fontWeight: 600,
                background: 'var(--warning-bg)', color: 'var(--warning)',
                padding: '3px 10px', borderRadius: 999,
              }}>
                14 bills pending
              </span>
            </div>
          </div>
        </Col>
      </Row>

      <div style={{ marginTop: 24, padding: 16,
                    background: 'var(--bg-muted)', borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)', fontSize: 13,
                    color: 'var(--fg-secondary)' }}>
        <Text strong style={{ color: 'var(--fg-primary)', fontSize: 13 }}>Tip:</Text>{' '}
        The full UI overhaul rolls out module by module. Modern theme looks best on
        the shells (Header/Sidebar/Login) and this Settings screen right now;
        remaining pages still render in Classic styling and will be converted
        phase-by-phase without affecting business logic.
        {isModern && ' You\'re previewing Modern — the frosted panels and muted teal accent apply app-wide.'}
      </div>
    </div>
  );
}

function SegmentLabel({ icon, title, subtitle }) {
  return (
    <div style={{ padding: '6px 4px', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
        {title}
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{subtitle}</div>
    </div>
  );
}

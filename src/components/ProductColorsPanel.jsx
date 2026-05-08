import React, { useEffect, useMemo, useState } from 'react';
import {
  Radio, Input, Switch, InputNumber, Button, Space, Tag, Tooltip, Divider, message,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, BgColorsOutlined,
} from '@ant-design/icons';
import { productColorAPI } from '../api';

/*
 * ProductColorsPanel — the Color section embedded inside the Product
 * add/edit form. Renders three modes:
 *
 *   - "No color"     : product has no color tracking (default).
 *   - "Single label" : free-text Color tag (filterable, no stock).
 *   - "Multi-color"  : per-color stock list with `+ Add color` rows
 *                       and per-color qty / threshold.
 *
 * Mutually exclusive — picking a mode clears the other mode's data.
 *
 * Behaviour:
 *   - The radio is gated by the global toggles (`single_color_enabled`,
 *     `multi_color_enabled`); options the operator hasn't enabled in
 *     Settings are shown disabled with a "(enable in Settings)" hint.
 *   - Multi-color: on edit, the existing colors load from the server.
 *     The colors array is mirrored back to the parent via `onChange`
 *     so the parent's Save handler can POST it via the bulk endpoint.
 *   - Inputs are tiny rows so the panel doesn't dominate the form.
 *
 * Props:
 *   value          { color_mode, color_label, colors[] }
 *   onChange       (value) => void
 *   productId      number | null   — when present (edit), seed initial
 *                                     colors from the server.
 *   singleEnabled  boolean         — is "Single label" mode allowed?
 *   multiEnabled   boolean         — is "Multi-color" mode allowed?
 *   readOnly       boolean         — disable the whole panel.
 */
export default function ProductColorsPanel({
  value,
  onChange,
  productId,
  singleEnabled,
  multiEnabled,
  readOnly,
}) {
  const v = value || { color_mode: 'none', color_label: '', colors: [] };
  const set = (patch) => onChange && onChange({ ...v, ...patch });

  const [loading, setLoading] = useState(false);
  const [serverHydrated, setHydrated] = useState(false);

  // On edit (productId present), pull the current color list from the
  // server so the panel reflects the saved state. Done once; subsequent
  // edits live in `v.colors` until the parent saves.
  useEffect(() => {
    if (!productId || serverHydrated) return;
    if (v.color_mode !== 'multi') {
      // Even non-multi products may have an existing color list (operator
      // toggled multi off but the rows persist). Don't hydrate unless the
      // current mode is multi, otherwise we'd surface phantom rows.
      setHydrated(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    productColorAPI.list(productId).then(({ data }) => {
      if (cancelled) return;
      const list = (data?.data || []).map((c) => ({
        color_id: c.color_id,
        color_name: c.color_name,
        opening_stock: Number(c.opening_stock) || 0,
        current_stock: Number(c.current_stock) || 0,
        low_stock_alert: c.low_stock_alert == null ? null : Number(c.low_stock_alert),
        is_active: c.is_active !== false,
      }));
      set({ colors: list });
      setHydrated(true);
    }).catch(() => { setHydrated(true); }).finally(() => setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, v.color_mode]);

  const updateColor = (idx, patch) => {
    const next = (v.colors || []).slice();
    next[idx] = { ...next[idx], ...patch };
    set({ colors: next });
  };

  const addColor = () => {
    const next = [...(v.colors || []), {
      color_id: null,
      color_name: '',
      opening_stock: 0,
      low_stock_alert: null,
      is_active: true,
    }];
    set({ colors: next });
  };

  const removeColor = (idx) => {
    const row = (v.colors || [])[idx];
    if (row?.color_id && Number(row.current_stock) > 0) {
      message.warning(`"${row.color_name}" has ${row.current_stock} in stock — adjust to 0 before removing.`);
      return;
    }
    const next = (v.colors || []).filter((_, i) => i !== idx);
    set({ colors: next });
  };

  const switchMode = (mode) => {
    if (readOnly) return;
    if (mode === 'none')   set({ color_mode: 'none', color_label: '', colors: [] });
    if (mode === 'single') set({ color_mode: 'single', colors: [] });
    if (mode === 'multi')  set({ color_mode: 'multi', color_label: '' });
  };

  const totalOpening = useMemo(
    () => (v.colors || []).reduce((s, c) => s + (Number(c.opening_stock) || 0), 0),
    [v.colors],
  );

  return (
    <div className="prod-colors-panel" style={{
      border: '1px solid var(--border)',
      background: 'var(--bg-muted)',
      borderRadius: 8,
      padding: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
      }}>
        <BgColorsOutlined style={{ color: 'var(--accent)', fontSize: 16 }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg-primary)' }}>
          Colors
        </span>
        <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>
          Track which color was sold and how many of each you have.
        </span>
      </div>

      <Radio.Group
        value={v.color_mode || 'none'}
        onChange={(e) => switchMode(e.target.value)}
        disabled={readOnly}
        style={{ marginBottom: 12 }}
      >
        <Radio.Button value="none">No color</Radio.Button>
        <Tooltip title={singleEnabled ? '' : 'Enable "Single color label" in Settings → Modules'}>
          <Radio.Button value="single" disabled={!singleEnabled}>Single label</Radio.Button>
        </Tooltip>
        <Tooltip title={multiEnabled ? '' : 'Enable "Multi-color stock" in Settings → Modules'}>
          <Radio.Button value="multi" disabled={!multiEnabled}>Multi-color tracked</Radio.Button>
        </Tooltip>
      </Radio.Group>

      {/* Single label mode — just a text field */}
      {v.color_mode === 'single' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', fontWeight: 600 }}>Color:</span>
          <Input
            value={v.color_label || ''}
            onChange={(e) => set({ color_label: e.target.value })}
            placeholder="e.g. Red, Burgundy, Navy"
            disabled={readOnly}
            maxLength={50}
            style={{ width: 220 }}
          />
          <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
            shown on the product list and filterable in reports
          </span>
        </div>
      )}

      {/* Multi-color mode — list of colors with qty and threshold */}
      {v.color_mode === 'multi' && (
        <>
          {/* Column header */}
          <div className="prod-colors-head" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 130px 130px 36px',
            gap: 8,
            alignItems: 'center',
            padding: '6px 4px',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: 'var(--fg-tertiary)',
            borderBottom: '1px solid var(--border)',
            marginBottom: 6,
          }}>
            <span>Color</span>
            <span style={{ textAlign: 'right' }}>Opening qty</span>
            <span style={{ textAlign: 'right' }}>Low alert</span>
            <span></span>
          </div>

          {/* Color rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(v.colors || []).length === 0 && (
              <div style={{ padding: '10px 4px', fontSize: 12, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
                No colors yet — add one to start tracking.
              </div>
            )}
            {(v.colors || []).map((c, idx) => (
              <div key={c.color_id || `new-${idx}`} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 130px 130px 36px',
                gap: 8,
                alignItems: 'center',
              }}>
                <Input
                  size="small"
                  value={c.color_name}
                  onChange={(e) => updateColor(idx, { color_name: e.target.value })}
                  placeholder="e.g. Red"
                  maxLength={50}
                  disabled={readOnly}
                />
                <Tooltip title={c.color_id && Number(c.current_stock) >= 0
                  ? `Currently in stock: ${c.current_stock ?? 0}`
                  : ''}>
                  <InputNumber
                    size="small"
                    value={c.opening_stock}
                    onChange={(val) => updateColor(idx, { opening_stock: val ?? 0 })}
                    min={0}
                    precision={2}
                    disabled={readOnly || (!!c.color_id && Number(c.current_stock) !== Number(c.opening_stock))}
                    style={{ width: '100%' }}
                  />
                </Tooltip>
                <InputNumber
                  size="small"
                  value={c.low_stock_alert}
                  onChange={(val) => updateColor(idx, { low_stock_alert: val })}
                  min={0}
                  precision={2}
                  placeholder="—"
                  disabled={readOnly}
                  style={{ width: '100%' }}
                />
                <Button
                  type="text" size="small" danger
                  icon={<DeleteOutlined />}
                  disabled={readOnly}
                  onClick={() => removeColor(idx)}
                />
              </div>
            ))}
          </div>

          <Divider style={{ margin: '8px 0' }} />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              icon={<PlusOutlined />}
              size="small"
              onClick={addColor}
              disabled={readOnly}
            >
              Add color
            </Button>
            <Space size="small">
              {totalOpening > 0 && (
                <Tag style={{ margin: 0 }}>
                  Σ opening = <span style={{ fontFamily: 'Geist Mono, monospace' }}>{totalOpening}</span>
                </Tag>
              )}
              <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
                {loading ? 'Loading…' : 'colors save when you save the product'}
              </span>
            </Space>
          </Space>
        </>
      )}
    </div>
  );
}

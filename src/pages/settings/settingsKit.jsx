import React, { useCallback, useEffect, useState } from 'react';
import { Form, Switch, InputNumber, message } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

/* Building blocks shared by the task pages (Sales Bill, Purchase Bill,
 * Stock & Products, Tax & Accounts). Same markup as every other settings
 * page, so they all look and behave alike. */

export function SettingsPage({ title, sub, actions, wide, children, strip }) {
  return (
    <div className={`ms-shell settings-pane-fill${wide ? ' ms-wide' : ''}`}>
      <header className="ms-page-header">
        <div className={actions ? 'ms-page-header-row' : undefined}>
          <div>
            <h1 className="ms-page-title">{title}</h1>
            {sub && <p className="ms-page-sub">{sub}</p>}
          </div>
          {actions}
        </div>
      </header>
      <div className="ms-page-body">
        <div className="ms-page-body-inner">{children}</div>
      </div>
      {strip}
    </div>
  );
}

export function Section({ title, desc, children, className = '' }) {
  return (
    <section className={`ms-section ${className}`}>
      {(title || desc) && (
        <div className="ms-section-head">
          {title && <h2 className="ms-section-title">{title}</h2>}
          {desc && <p className="ms-section-desc">{desc}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function ToggleRow({ name, label, desc, onChange, disabled }) {
  return (
    <div className="ms-row" data-disabled={disabled || undefined}>
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} valuePropName="checked" noStyle>
          <Switch onChange={onChange} disabled={disabled} />
        </Form.Item>
      </div>
    </div>
  );
}

export function NumberRow({ name, label, desc, min = 0, max, suffix, width = 150 }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} noStyle>
          <InputNumber min={min} max={max} addonAfter={suffix} style={{ width }} />
        </Form.Item>
      </div>
    </div>
  );
}

export function ControlRow({ label, desc, children }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">{children}</div>
    </div>
  );
}

export function ChoiceRow({ label, desc, children }) {
  return (
    <div className="ms-row-stacked">
      <div className="ms-row-label">{label}</div>
      {desc && <div className="ms-row-desc">{desc}</div>}
      <div className="ms-row-stacked-control">{children}</div>
    </div>
  );
}

// Option text inside a Radio — bold name, quiet note beneath.
export function Choice({ title, note }) {
  return (
    <span>
      <span style={{ fontWeight: 500 }}>{title}</span>
      {note && <span className="ms-row-desc" style={{ display: 'block', marginTop: 2 }}>{note}</span>}
    </span>
  );
}

// "Related" rows that open another settings page.
export function LinkRow({ to, label, desc }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="ms-link-row" onClick={() => navigate(to)}>
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <RightOutlined className="ms-link-chev" />
    </button>
  );
}

/* Load + save one slice of /settings/system. Each task page owns its own
 * fields and writes only those, so pages never clobber each other.
 *
 *   read(s)        → form values from the settings row
 *   write(values)  → the patch to send (may also persist local prefs);
 *                    return null to send nothing to the server
 */
export function useSystemSlice(form, { read, write, savedText = 'Settings saved' }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [raw, setRaw]         = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data } = await settingsAPI.getSystem();
        const s = (data && data.data) ? data.data : data;
        if (!s) throw new Error('No settings returned');
        if (!alive) return;
        setRaw(s);
        form.setFieldsValue(read(s));
      } catch (error) {
        console.error('settings load error:', error);
        message.error('Failed to load settings');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async (values) => {
    setSaving(true);
    try {
      const patch = write(values);
      if (patch && Object.keys(patch).length) {
        await settingsAPI.updateSystem(patch);
        // Sidebar, settings rail and every bill form read the shared cache.
        await refreshSystemSettings().catch(() => {});
      }
      message.success(savedText);
    } catch (error) {
      console.error('settings save error:', error);
      message.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [write, savedText]);

  return { loading, saving, save, raw };
}

export function SaveStrip({ form, loading, saving }) {
  const navigate = useNavigate();
  return (
    <ActionStrip
      actions={[
        { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/settings') },
        { id: 'save', key: 'F1', label: 'Save', tone: 'primary',
          disabled: saving || loading, onAction: () => form.submit() },
      ]}
    />
  );
}

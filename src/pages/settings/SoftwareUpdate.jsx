import React, { useEffect, useState } from 'react';
import { Button, Switch, Progress, Alert, Space, Tag } from 'antd';
import { SyncOutlined, DownloadOutlined, ReloadOutlined, ReadOutlined } from '@ant-design/icons';
import './ModuleSettings.css';

/*
 * Settings → Software Update.
 *
 * ZEHEN updates itself from download.zehenapp.com (electron/updater.js).
 * This page shows where that stands and holds the one choice the owner
 * makes: automatic updates on or off.
 *
 *   on  — new versions download in the background and install the next
 *         time ZEHEN is closed. Never mid-work.
 *   off — ZEHEN still checks and says when an update exists; nothing is
 *         downloaded until the owner presses Download.
 *
 * The setting belongs to this computer (it lives next to the app, not in a
 * company's books), and only the desktop app on the main computer has it.
 */

const RELEASE_NOTES_URL = 'https://zehenapp.com/releases';

function Row({ label, desc, children }) {
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

function statusLine(s) {
  switch (s.status) {
    case 'checking':    return { text: 'Checking for updates…', tone: 'processing' };
    case 'up-to-date':  return { text: 'ZEHEN is up to date.', tone: 'success' };
    case 'available':   return { text: `Version ${s.version} is available.`, tone: 'warning' };
    case 'downloading': return { text: `Downloading version ${s.version}…`, tone: 'processing' };
    case 'downloaded':  return { text: `Version ${s.version} is ready to install.`, tone: 'success' };
    case 'error':       return { text: s.error || 'Could not check for updates.', tone: 'default' };
    default:            return { text: 'Not checked yet this session.', tone: 'default' };
  }
}

function when(ts) {
  return ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
}

export default function SoftwareUpdate() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.updates : null;
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return undefined;
    api.getState().then(setS).catch(() => {});
    return api.onState(setS);
  }, [api]);

  const openNotes = () => {
    if (window.electronAPI?.openZehenUrl) window.electronAPI.openZehenUrl(RELEASE_NOTES_URL);
    else window.open(RELEASE_NOTES_URL, '_blank', 'noopener');
  };

  const run = async (fn) => {
    setBusy(true);
    try { const next = await fn(); if (next && typeof next === 'object') setS(next); }
    finally { setBusy(false); }
  };

  const header = (
    <header className="ms-page-header">
      <h1 className="ms-page-title">Software Update</h1>
      <p className="ms-page-sub">
        ZEHEN updates itself from zehenapp.com. An update installs only when ZEHEN is closed, never in the middle of work.
      </p>
    </header>
  );

  if (!api || (s && s.status === 'unavailable')) {
    const reason = s?.reason;
    return (
      <div className="ms-shell settings-pane-fill">
        {header}
        <div className="ms-page-body"><div className="ms-page-body-inner">
          <section className="ms-section">
            <Alert
              type="info"
              showIcon
              message="Updates are managed on the main computer"
              description={reason === 'client'
                ? 'This computer connects to the main ZEHEN computer. To update it, download the latest client setup from zehenapp.com.'
                : reason === 'dev'
                  ? 'Updates are turned off while running from source.'
                  : 'Open this page in the ZEHEN desktop app on the main computer to check for updates.'}
            />
            <Row label="What's new" desc="See what changed in each version.">
              <Button icon={<ReadOutlined />} onClick={openNotes}>Release notes</Button>
            </Row>
          </section>
        </div></div>
      </div>
    );
  }

  if (!s) return <div className="ms-shell settings-pane-fill">{header}</div>;

  const line = statusLine(s);

  return (
    <div className="ms-shell settings-pane-fill">
      {header}
      <div className="ms-page-body"><div className="ms-page-body-inner">
        <section className="ms-section">
          <div className="ms-section-head">
            <div className="ms-section-title">This computer</div>
          </div>

          <Row label="Installed version" desc={s.lastCheckedAt ? `Last checked ${when(s.lastCheckedAt)}` : null}>
            <Tag style={{ fontSize: 14, padding: '2px 10px' }}>ZEHEN {s.currentVersion}</Tag>
          </Row>

          <Row label="Status" desc={line.text}>
            <Space>
              {s.status === 'available' && (
                <Button type="primary" icon={<DownloadOutlined />} loading={busy} onClick={() => run(api.download)}>Download</Button>
              )}
              {s.status === 'downloaded' && (
                <Button type="primary" icon={<ReloadOutlined />} onClick={() => api.installNow()}>Restart and update</Button>
              )}
              {s.status !== 'downloading' && s.status !== 'downloaded' && (
                <Button icon={<SyncOutlined spin={s.status === 'checking'} />} loading={busy} onClick={() => run(api.check)}>Check now</Button>
              )}
            </Space>
          </Row>

          {s.status === 'downloading' && (
            <Progress percent={s.progress || 0} size="small" style={{ margin: '4px 0 10px' }} />
          )}

          {s.status === 'downloaded' && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 8 }}
              message={`ZEHEN ${s.version} is ready`}
              description={s.auto
                ? 'It installs automatically the next time ZEHEN is closed. Your data is backed up first. Or restart now to update straight away.'
                : 'Press "Restart and update" when it suits you. Your data is backed up first.'}
            />
          )}

          <Row
            label="Automatic updates"
            desc={s.auto
              ? 'On: new versions download in the background and install the next time ZEHEN is closed.'
              : 'Off: ZEHEN tells you when an update is available, and downloads nothing until you press Download.'}
          >
            <Switch checked={!!s.auto} onChange={(v) => run(() => api.setAuto(v))} />
          </Row>

          <Row label="What's new" desc="See what changed in each version.">
            <Button icon={<ReadOutlined />} onClick={openNotes}>Release notes</Button>
          </Row>
        </section>
      </div></div>
    </div>
  );
}

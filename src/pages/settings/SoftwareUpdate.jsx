import React, { useEffect, useMemo, useState } from 'react';
import { Switch, Modal } from 'antd';
import { CheckCircleFilled, SyncOutlined, WarningFilled, ArrowRightOutlined, DownOutlined, ReloadOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { ZehenMark } from '../../components/ZehenLogo';
import NOTES from '../../data/releaseNotes.json';
import './ModuleSettings.css';
import './software-update.css';

/*
 * Settings → Software Update, modelled on how a phone or a Mac does it:
 *
 *   up to date  →  "ZEHEN is up to date", Check for Updates
 *   available   →  version, size, what's new, [Update Now]. Nothing has
 *                  downloaded; the owner decides.
 *   downloading →  progress in MB and time left; work carries on.
 *   ready       →  [Restart Now] or install when ZEHEN closes.
 *
 * Two automatic settings, like Automatic Updates on a Mac:
 *   Download new updates automatically (the background check only; a
 *   check the owner starts always asks first) and Install when ZEHEN
 *   closes. The state machine lives in electron/updater.js.
 */
const RELEASE_NOTES_URL = 'https://zehenapp.com/releases';
const MB = (b) => (b ? `${(b / 1048576).toFixed(1)} MB` : '');
const niceDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
function whenChecked(ts) {
  if (!ts) return null;
  const d = new Date(ts); const today = new Date();
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `today at ${time}` : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} at ${time}`;
}
function timeLeft(s) {
  if (!s.bytesPerSecond || !s.total || !s.transferred) return null;
  const sec = (s.total - s.transferred) / s.bytesPerSecond;
  if (sec < 60) return 'less than a minute left';
  const m = Math.round(sec / 60);
  return `about ${m} minute${m === 1 ? '' : 's'} left`;
}
const notesFor = (v) => NOTES.releases.find((r) => r.version === v);

function Toggle({ label, desc, checked, onChange, disabled }) {
  return (
    <div className="su-toggle">
      <div><b>{label}</b><span>{desc}</span></div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export default function SoftwareUpdate() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.updates : null;
  const [s, setS] = useState(null);
  const [earlier, setEarlier] = useState(false);
  const [modal, modalCtx] = Modal.useModal();

  useEffect(() => {
    if (!api) return undefined;
    api.getState().then(setS).catch(() => {});
    return api.onState(setS);
  }, [api]);

  const openNotes = () => {
    if (window.electronAPI?.openZehenUrl) window.electronAPI.openZehenUrl(RELEASE_NOTES_URL);
    else window.open(RELEASE_NOTES_URL, '_blank', 'noopener');
  };
  const call = async (fn) => { try { const next = await fn(); if (next && typeof next === 'object') setS(next); } catch { /* state events report errors */ } };
  const setPrefs = (patch) => call(() => (api.setPrefs ? api.setPrefs(patch) : api.setAuto(Object.values(patch)[0])));
  const restart = () => modal.confirm({
    rootClassName: 'ar-pop', icon: <ReloadOutlined />, title: `Restart and install ZEHEN ${s.version}?`,
    content: 'ZEHEN closes, installs the update and opens again, usually within a minute. Anything you have saved is safe; finish any bill you are typing first.',
    okText: 'Restart Now', cancelText: 'Not now', onOk: () => api.installNow(),
  });

  const installed = s?.currentVersion || (typeof window !== 'undefined' && window.electronAPI?.appVersion) || null;
  const current = useMemo(() => (installed ? notesFor(installed) : null), [installed]);
  const past = NOTES.releases.filter((r) => r.version !== installed && (!installed || r.version.localeCompare(installed, undefined, { numeric: true }) < 0));

  const header = (
    <header className="ms-page-header">
      <h1 className="ms-page-title">Software Update</h1>
      <p className="ms-page-sub">ZEHEN updates itself safely from zehenapp.com. Every update is checked as genuine before it installs, and nothing ever restarts while you work.</p>
    </header>
  );

  const whatsNew = (
    <section className="su-card">
      <div className="su-card-h"><b>What's new{installed ? ` in ZEHEN ${installed}` : ''}</b>{current?.date && <span>{niceDate(current.date)}</span>}</div>
      {current ? (<>
        {current.title && <p className="su-title">{current.title}</p>}
        <ul className="su-notes">{current.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
      </>) : <p className="su-muted">Notes for this version are on the website.</p>}
      {past.length > 0 && (
        <div className="su-earlier">
          <button type="button" className="su-link" onClick={() => setEarlier((v) => !v)}>Earlier versions <DownOutlined rotate={earlier ? 180 : 0} /></button>
          {earlier && past.map((r) => (
            <div key={r.version} className="su-past"><div><b>ZEHEN {r.version}</b><span>{r.title} · {niceDate(r.date)}</span></div>
              <ul className="su-notes sm">{r.highlights.map((h) => <li key={h}>{h}</li>)}</ul></div>
          ))}
        </div>
      )}
      <button type="button" className="su-link" onClick={openNotes}>All release notes on zehenapp.com <ArrowRightOutlined /></button>
    </section>
  );

  if (!api || (s && s.status === 'unavailable')) {
    const reason = s?.reason;
    return (
      <div className="ms-shell settings-pane-fill">{header}
        <div className="ms-page-body"><div className="ms-page-body-inner su">
          <section className="su-card su-hero">
            <ZehenMark size={64} />
            <div className="su-hero-text">
              <b>Updates are managed on the main computer</b>
              <span>{reason === 'client'
                ? 'This computer connects to the main ZEHEN computer. To update it, download the latest client setup from zehenapp.com.'
                : reason === 'dev' ? 'Updates are turned off while running from source.'
                  : 'Open this page in the ZEHEN desktop app on the main computer to check for updates.'}</span>
            </div>
          </section>
          {whatsNew}
        </div></div>
      </div>
    );
  }
  if (!s) return <div className="ms-shell settings-pane-fill">{header}</div>;

  const notes = s.releaseNotes && s.releaseNotes.length ? s.releaseNotes : (notesFor(s.version)?.highlights || []);
  let hero;
  if (s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded') {
    const ready = s.status === 'downloaded'; const dl = s.status === 'downloading';
    hero = (
      <section className={`su-card su-hero su-update${ready ? ' is-ready' : ''}`}>
        <div className="su-update-top">
          <ZehenMark size={72} />
          <div className="su-hero-text">
            <span className="su-eyebrow">{ready ? 'Ready to install' : dl ? 'Downloading' : 'Update available'}</span>
            <b>ZEHEN {s.version}</b>
            <span>{[s.releaseName, MB(s.size || s.total), s.releaseDate && `Released ${niceDate(s.releaseDate)}`].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="su-update-act">
            {s.status === 'available' && <button type="button" className="su-btn primary" onClick={() => call(api.download)}>Update Now</button>}
            {ready && <button type="button" className="su-btn primary" onClick={restart}><ReloadOutlined /> Restart Now</button>}
            {ready && (s.autoInstall
              ? <span className="su-chip"><ClockCircleOutlined /> Installs when you close ZEHEN</span>
              : <button type="button" className="su-btn" onClick={() => setPrefs({ autoInstall: true })}>Install when I close ZEHEN</button>)}
          </div>
        </div>
        {dl && (
          <div className="su-progress">
            <div className="su-bar"><i style={{ width: `${s.progress || 0}%` }} /></div>
            <span>{s.transferred ? `${MB(s.transferred)} of ${MB(s.total || s.size)}` : 'Starting…'}{timeLeft(s) ? ` · ${timeLeft(s)}` : ''} · you can keep working</span>
          </div>
        )}
        {notes.length > 0 && (<>
          <div className="su-sep" />
          <p className="su-whats">What's new</p>
          <ul className="su-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </>)}
        <p className="su-fine">{ready ? 'Installing takes about a minute. Your data is not touched.' : dl ? 'Keep working as normal. When it is ready, you choose when to restart.' : 'Nothing downloads until you press Update Now. You choose when to restart.'}
          {' '}<button type="button" className="su-link inline" onClick={openNotes}>Learn more</button></p>
      </section>
    );
  } else {
    const checking = s.status === 'checking'; const err = s.status === 'error';
    hero = (
      <section className="su-card su-hero">
        <ZehenMark size={64} />
        <div className="su-hero-text">
          <b>ZEHEN {s.currentVersion}</b>
          {checking ? <span className="su-state"><SyncOutlined spin /> Checking for updates…</span>
            : err ? <span className="su-state warn"><WarningFilled /> {s.error || 'Could not check for updates.'}</span>
              : s.status === 'up-to-date' ? <span className="su-state ok"><CheckCircleFilled /> ZEHEN is up to date</span>
                : <span className="su-state">Not checked yet</span>}
          {s.lastCheckedAt && !checking && <small>Last checked {whenChecked(s.lastCheckedAt)}</small>}
        </div>
        <button type="button" className="su-btn" disabled={checking} onClick={() => call(api.check)}>{err ? 'Try Again' : 'Check for Updates'}</button>
      </section>
    );
  }

  return (
    <div className="ms-shell settings-pane-fill">{header}
      {modalCtx}
      <div className="ms-page-body"><div className="ms-page-body-inner su">
        {hero}
        <section className="su-card">
          <div className="su-card-h"><b>Automatic updates</b></div>
          <Toggle label="Download new updates automatically" checked={s.autoDownload !== false} onChange={(v) => setPrefs({ autoDownload: v })}
            desc="ZEHEN checks every few hours and quietly downloads a new version, ready to install. Checking yourself always asks first." />
          <Toggle label="Install updates when ZEHEN closes" checked={s.autoInstall !== false} onChange={(v) => setPrefs({ autoInstall: v })}
            desc="A downloaded update installs when you close ZEHEN at the end of the day. Off: it waits until you press Restart Now." />
        </section>
        {whatsNew}
      </div></div>
    </div>
  );
}

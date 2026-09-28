import React, { useEffect, useRef } from 'react';
import { notification } from 'antd';
import { useNavigate } from 'react-router-dom';
import { ZehenMark } from './ZehenLogo';
import useAuthStore from '../store/authStore';
import { hasPermission } from '../utils/perms';
import NOTES from '../data/releaseNotes.json';
import './update-notifier.css';

/*
 * The quiet "there's an update" moment, anywhere in the app (not only on the
 * Settings page), the way a phone or a Mac tells you:
 *   - available  → ZEHEN 1.1.8 is available · See what's new / Later
 *   - ready      → ZEHEN 1.1.8 is ready · Restart Now / When I close ZEHEN
 *   - just updated (first launch on a new version) → what's new, once
 * Each notice shows once per version; nothing here downloads or restarts on
 * its own. Install prompts only for people who manage the company.
 */
const SEEN_KEY = 'zehen_update_seen';           // { available: '1.1.8', downloaded: '1.1.8' }
const VERSION_KEY = 'zehen_last_version';        // last version this computer ran
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const newer = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true }) > 0;

export default function UpdateNotifier() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.updates : null;
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canManage = !!user && hasPermission(user, 'settings.manage_company');
  const [notify, holder] = notification.useNotification({ placement: 'bottomRight', bottom: 28, maxCount: 2 });
  const shown = useRef({});

  // "ZEHEN was updated" once, on the first launch of a new version.
  useEffect(() => {
    if (!api || !user) return;
    api.getState().then((s) => {
      const cur = s?.currentVersion;
      if (!cur) return;
      const last = read(VERSION_KEY, null);
      write(VERSION_KEY, cur);
      if (!last || !newer(cur, last)) return;          // first install, or same version: nothing to say
      const rel = NOTES.releases.find((r) => r.version === cur);
      notify.open({
        key: 'zu-updated', duration: 12, className: 'zu-note',
        icon: <ZehenMark size={36} />,
        message: <b>ZEHEN was updated to {cur}</b>,
        description: (
          <div className="zu-body">
            {rel?.title && <p>{rel.title}</p>}
            {rel?.highlights?.length > 0 && <ul>{rel.highlights.slice(0, 3).map((h) => <li key={h}>{h}</li>)}</ul>}
            {canManage && <button type="button" className="zu-link" onClick={() => { notify.destroy('zu-updated'); navigate('/settings/software-update'); }}>See everything that's new</button>}
          </div>
        ),
      });
    }).catch(() => {});
  }, [api, !!user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Available / ready, once per version.
  useEffect(() => {
    if (!api || !canManage) return undefined;
    const onState = (s) => {
      if (!s || !s.version) return;
      const seen = read(SEEN_KEY, {});
      const kind = s.status === 'downloaded' ? 'downloaded' : s.status === 'available' ? 'available' : null;
      if (!kind || seen[kind] === s.version || shown.current[`${kind}:${s.version}`]) return;
      // Someone who is already looking at the Software Update page doesn't need telling.
      if (window.location.hash.includes('software-update') || window.location.pathname.includes('software-update')) return;
      shown.current[`${kind}:${s.version}`] = true;
      const done = () => { write(SEEN_KEY, { ...read(SEEN_KEY, {}), [kind]: s.version }); notify.destroy(`zu-${kind}`); };
      const notes = (s.releaseNotes && s.releaseNotes.length ? s.releaseNotes : NOTES.releases.find((r) => r.version === s.version)?.highlights) || [];
      notify.open({
        key: `zu-${kind}`, duration: 0, className: 'zu-note', onClose: done,
        icon: <ZehenMark size={36} />,
        message: <b>{kind === 'downloaded' ? `ZEHEN ${s.version} is ready to install` : `ZEHEN ${s.version} is available`}</b>,
        description: (
          <div className="zu-body">
            {s.releaseName && <p>{s.releaseName}</p>}
            {notes.length > 0 && <ul>{notes.slice(0, 2).map((h) => <li key={h}>{h}</li>)}</ul>}
            <div className="zu-act">
              {kind === 'available' ? (<>
                <button type="button" className="zu-btn primary" onClick={() => { done(); navigate('/settings/software-update'); }}>See what's new</button>
                <button type="button" className="zu-btn" onClick={done}>Later</button>
              </>) : (<>
                <button type="button" className="zu-btn primary" onClick={() => { done(); api.installNow(); }}>Restart Now</button>
                <button type="button" className="zu-btn" onClick={() => { done(); if (!s.autoInstall && api.setPrefs) api.setPrefs({ autoInstall: true }); }}>When I close ZEHEN</button>
              </>)}
            </div>
          </div>
        ),
      });
    };
    api.getState().then(onState).catch(() => {});
    return api.onState(onState);
  }, [api, canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  return holder;
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AudioOutlined, LoadingOutlined } from '@ant-design/icons';
import { partyAPI, salesAPI } from '../api';
import useVoiceSettings from './voiceSettings';
import { VoiceEngine, voiceAvailable } from './engine';
import { parseCommand } from './commands.js';
import { findBest } from './match.js';
import { matchScreen } from './screens';
import { callVoiceTarget, hasVoiceTarget } from './bus';
import './voice.css';

/*
 * Voice commands — mounted once in AppLayout. Renders nothing unless the
 * owner turned voice on in Settings → Voice Commands on this computer.
 *
 *   Hold Ctrl+Space (or hold the mic button) and speak; let go to run it.
 *   Whisper turns the speech into text on this PC (electron/voice.js).
 *
 * Every command does what the keyboard would: open a screen, pick the
 * customer, add a line. Nothing is saved, printed or deleted by voice.
 */

const PARTY_CACHE_MS = 5 * 60_000;
const SHOW_MS = 2600;

function speak(text, on) {
  if (!on || !text || typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    u.rate = 1.1;
    window.speechSynthesis.speak(u);
  } catch { /* no voices installed */ }
}

export default function VoiceCommands() {
  const { enabled, lang, model, speakBack, modelRev } = useVoiceSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const engineRef = useRef(null);
  const [state, setState] = useState('off');      // off | loading | ready | listening | working | error
  const [bubble, setBubble] = useState(null);     // { text, kind: 'heard' | 'ok' | 'warn' }
  const [level, setLevel] = useState(0);          // microphone loudness while the key is held
  const [problem, setProblem] = useState(null);   // why voice isn't ready (shown on the mic)
  const bubbleTimer = useRef(null);
  const holdingRef = useRef(false);
  const holdStartRef = useRef(null);
  const partiesRef = useRef({ at: 0, list: [] });
  const lastBillRef = useRef(null);
  const settingsRef = useRef({ speakBack });
  settingsRef.current = { speakBack };

  const show = useCallback((text, kind = 'ok', stay = false) => {
    clearTimeout(bubbleTimer.current);
    setBubble(text ? { text, kind } : null);
    if (text && !stay) bubbleTimer.current = setTimeout(() => setBubble(null), SHOW_MS);
  }, []);
  const tell = useCallback((text, kind = 'ok') => {
    show(text, kind);
    speak(text, settingsRef.current.speakBack);
  }, [show]);

  // The last sales bill opened, for "open that bill".
  useEffect(() => {
    const m = location.pathname.match(/^\/sale\/edit\/(\d+)/);
    if (m) lastBillRef.current = m[1];
  }, [location.pathname]);

  // ── engine lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !voiceAvailable()) { setState('off'); return undefined; }
    let cancelled = false;
    const engine = new VoiceEngine();
    engineRef.current = engine;
    setState('loading');
    engine.load(lang, model)
      .then(() => { if (!cancelled) { setState('ready'); setProblem(null); show(null); } })
      .catch((e) => {
        if (cancelled) return;
        setState('error');
        setProblem(e.code === 'model-missing'
          ? 'Download the speech model in Settings → Voice Commands'
          : `Voice could not start: ${e.message || 'unknown error'}`);
      });
    return () => { cancelled = true; engine.unload(); engineRef.current = null; };
  }, [enabled, lang, model, modelRev, show]);

  // ── names ─────────────────────────────────────────────────────────
  const loadParties = useCallback(async () => {
    const c = partiesRef.current;
    if (c.list.length && Date.now() - c.at < PARTY_CACHE_MS) return c.list;
    const [cu, su] = await Promise.allSettled([
      partyAPI.getCustomers({ limit: 5000 }),
      partyAPI.getSuppliers({ limit: 5000 }),
    ]);
    const pick = (r) => (r.status === 'fulfilled' ? r.value.data?.data || [] : []);
    const list = [...pick(cu), ...pick(su)].filter((p) => p.is_active !== false);
    partiesRef.current = { at: Date.now(), list };
    return list;
  }, []);

  const findParty = useCallback(async (spoken, type) => {
    const all = await loadParties();
    const pool = type ? all.filter((p) => !p.party_type || p.party_type === type || p.party_type === 'Both') : all;
    return findBest(spoken, pool, (p) => p.party_name);
  }, [loadParties]);

  // ── run one command ───────────────────────────────────────────────
  const run = useCallback(async (cmd) => {
    switch (cmd.intent) {
      case 'new_sale': {
        let party = null;
        if (cmd.party) {
          const m = await findParty(cmd.party, 'Customer');
          if (!m.best) { navigate('/sale/new'); tell(`No customer called ${cmd.party}`, 'warn'); return; }
          if (m.ambiguous) {
            navigate('/sale/new');
            tell(`Which one: ${m.matches.slice(0, 3).map((x) => x.item.party_name).join(', ')}?`, 'warn');
            return;
          }
          party = m.best;
        }
        navigate('/sale/new');
        if (party) {
          const r = await callVoiceTarget('sale-form', 'setCustomer', party, { waitMs: 4000 });
          tell(r?.ok ? `${party.party_name} selected. Scan items` : 'Sales bill opened', r?.ok ? 'ok' : 'warn');
        } else {
          await callVoiceTarget('sale-form', 'focusScan', null, { waitMs: 4000 });
          tell('New sales bill');
        }
        return;
      }
      case 'new_purchase':
        navigate('/purchase/new');
        tell('Purchase bill opened');
        return;
      case 'show_ledger': {
        const m = await findParty(cmd.party);
        if (!m.best) { tell(`No party called ${cmd.party}`, 'warn'); return; }
        if (m.ambiguous) { tell(`Which one: ${m.matches.slice(0, 3).map((x) => x.item.party_name).join(', ')}?`, 'warn'); return; }
        navigate(`/parties/${m.best.party_id}`);
        tell(`${m.best.party_name} ledger`);
        return;
      }
      case 'open_bill': {
        if (!cmd.billNo) {
          let id = lastBillRef.current;
          if (!id) {
            const { data } = await salesAPI.getAll({ limit: 1 });
            id = data?.data?.[0]?.sales_bill_id;
          }
          if (!id) { tell('No sales bill yet', 'warn'); return; }
          navigate(`/sale/edit/${id}`);
          tell('Opening the bill');
          return;
        }
        const { data } = await salesAPI.getAll({ search: cmd.billNo, limit: 20 });
        const rows = data?.data || [];
        const digits = (b) => String(b.bill_number || '').replace(/\D/g, '');
        const hit = rows.find((b) => digits(b) === cmd.billNo)
          || rows.find((b) => digits(b).endsWith(cmd.billNo))
          || rows[0];
        if (!hit) { tell(`Bill ${cmd.billNo} not found`, 'warn'); return; }
        navigate(`/sale/edit/${hit.sales_bill_id}`);
        tell(`Bill ${hit.bill_number}`);
        return;
      }
      case 'set_qty':
      case 'add_barcode':
      case 'add_product':
      case 'focus_scan': {
        if (!hasVoiceTarget('sale-form')) { tell('Open a sales bill first', 'warn'); return; }
        if (cmd.intent === 'focus_scan') { await callVoiceTarget('sale-form', 'focusScan'); tell('Ready to scan'); return; }
        if (cmd.intent === 'set_qty') {
          const r = await callVoiceTarget('sale-form', 'setQty', cmd.qty);
          tell(r?.ok ? `Quantity ${cmd.qty}` : (r?.error || 'Could not change quantity'), r?.ok ? 'ok' : 'warn');
          return;
        }
        if (cmd.intent === 'add_barcode') {
          const r = await callVoiceTarget('sale-form', 'addBarcode', cmd.code);
          show(r?.name ? `Added ${r.name}` : `Barcode ${cmd.code}`);
          speak(r?.name ? `Added ${r.name}` : null, settingsRef.current.speakBack);
          return;
        }
        const r = await callVoiceTarget('sale-form', 'addProduct', { query: cmd.query, qty: cmd.qty });
        if (r?.ok) tell(`Added ${r.name}`);
        else if (r?.choices?.length) tell(`Pick one: ${r.choices.join(', ')}`, 'warn');
        else tell(`No product like ${cmd.query}`, 'warn');
        return;
      }
      case 'navigate': {
        const screen = matchScreen(cmd.query);
        if (screen) { navigate(screen.route); tell(screen.label); return; }
        tell(`Didn't understand "${cmd.query}"`, 'warn');
        return;
      }
      default:
        show(null);
    }
  }, [findParty, navigate, show, tell]);

  const handleText = useCallback(async (text) => {
    if (!text) { show(`Didn't hear anything`, 'warn'); return; }
    const cmd = parseCommand(text);
    if (cmd.intent === 'none' || cmd.intent === 'wake') { show(`Heard "${text}", but that isn't a command`, 'warn'); return; }
    show(text, 'heard', true);
    setState('working');
    try { await run(cmd); } catch { tell('Something went wrong', 'warn'); }
    setState('ready');
  }, [run, show, tell]);

  // ── push-to-talk ──────────────────────────────────────────────────
  const startHold = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine?.model || holdingRef.current) return;
    holdingRef.current = true;
    engine.onLevel = (l) => setLevel(l);
    setLevel(0);
    show(null);
    setState('listening');
    holdStartRef.current = engine.hold();
    try { await holdStartRef.current; } catch { holdingRef.current = false; setState('ready'); show('Microphone not available', 'warn'); }
  }, [show]);

  const endHold = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !holdingRef.current) return;
    holdingRef.current = false;
    // A quick tap can let go before the microphone has even opened.
    try { await holdStartRef.current; } catch { return; }
    engine.onLevel = null;
    setState('working');
    show('Understanding…', 'heard', true);
    let text;
    try {
      text = await engine.release();
    } catch (e) {
      setState('ready');
      show(e.code === 'model-missing' ? 'Download the speech model in Settings → Voice Commands' : `Voice could not run: ${e.message}`, 'warn');
      return;
    }
    setState('ready');
    await handleText(text);
  }, [handleText, show]);

  useEffect(() => {
    if (state === 'off' || state === 'error') return undefined;
    const down = (e) => {
      if (e.code === 'Space' && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (!e.repeat) startHold();
      }
    };
    const up = (e) => {
      if (holdingRef.current && (e.code === 'Space' || e.key === 'Control')) { e.preventDefault(); endHold(); }
    };
    const blur = () => { if (holdingRef.current) endHold(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [state, startHold, endHold]);

  if (state === 'off') return null;
  const listening = state === 'listening';
  const title = state === 'error' ? `${problem || 'Voice is not ready'} (click to open settings)`
    : state === 'loading' ? 'Getting voice ready…'
      : 'Hold to talk (Ctrl+Space)';
  return (
    <>
      {listening && (
        <div className="zv-listen" aria-live="polite">
          <span className="zv-bars" aria-hidden="true" style={{ '--lvl': level.toFixed(2) }}><i /><i /><i /><i /></span>
          <span className="zv-live">Listening… speak now</span>
          <span className="zv-hint">Let go to run</span>
        </div>
      )}
      <div className="zv-dock" aria-live="polite">
        {bubble && <div className={`zv-bubble zv-${bubble.kind}`}>{bubble.text}</div>}
        <button
          type="button"
          className={`zv-mic is-${state}`}
          title={title}
          aria-label={title}
          onPointerDown={(e) => {
            if (state === 'error') return;
            e.preventDefault();
            startHold();
          }}
          onPointerUp={endHold}
          onPointerLeave={() => { if (holdingRef.current) endHold(); }}
          onClick={() => { if (state === 'error') navigate('/settings/voice'); }}
        >
          {state === 'loading' || state === 'working' ? <LoadingOutlined /> : <AudioOutlined />}
          {state === 'error' && <span className="zv-badge zv-badge-warn" />}
        </button>
      </div>
    </>
  );
}

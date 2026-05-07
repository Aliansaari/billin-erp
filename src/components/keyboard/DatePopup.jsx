import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import dayjs from 'dayjs';
import './DatePopup.css';

// ── Tally-style F2 Date popup ─────────────────────────────────────────
//
// One popup, two modes:
//   mode='single' → returns a dayjs date
//   mode='range'  → returns [from, to] dayjs dates
//
// Smart input parser handles every shape an operator might type:
//   "today" / "tomorrow" / "yesterday"
//   "15"               → 15th of current month, current year
//   "15-3" / "15/3"    → 15 March, current year
//   "15-3-26" / "15/3/2026" / "15.3.26" → full date (2-digit year → 2000s)
//   "+1d" / "-2w" / "+3m" / "+1y" → relative offset from the "base"
//                                   value the popup was opened with
//
// Preset chips (single mode):  Today · Yesterday · Tomorrow ·
//                              Start of month · End of month · Today
// Preset chips (range mode):   Today · This Week · This Month · This Q ·
//                              This FY · Last FY · Last 7d · Last 30d
//
// Triggered globally via the useDatePopup() hook from any F2 action:
//
//   const { openDate } = useDatePopup();
//   { id: 'date', key: 'F2', label: 'Date',
//     onAction: () => openDate({
//       mode: 'single',
//       value: dayjs(currentValue),
//       title: 'Bill Date',
//       onConfirm: (d) => form.setFieldValue('bill_date', d),
//     }),
//   }
//
// The provider mounts the popup once at the app root; pages don't
// render anything themselves.

// Compute the start of the financial year for a given date. India runs
// April–March, so anything before April rolls back to the previous year.
function fyStart(d = dayjs()) {
  const m = d.month(); // 0-indexed
  const y = d.year();
  return m < 3 ? dayjs(`${y - 1}-04-01`) : dayjs(`${y}-04-01`);
}
function fyEnd(d = dayjs()) {
  return fyStart(d).add(1, 'year').subtract(1, 'day');
}

// ── Smart parser ──────────────────────────────────────────────────────
// Returns a dayjs instance on success, null on parse failure.
export function parseSmartDate(input, baseDate) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;
  const base = baseDate ? dayjs(baseDate) : dayjs();

  if (raw === 'today')     return dayjs();
  if (raw === 'tomorrow')  return dayjs().add(1, 'day');
  if (raw === 'yesterday') return dayjs().subtract(1, 'day');

  // Relative offset: +1d -2w +3m +1y
  const rel = /^([+-])(\d+)\s*([dwmy])$/.exec(raw);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const amount = parseInt(rel[2], 10) * sign;
    const unit = { d: 'day', w: 'week', m: 'month', y: 'year' }[rel[3]];
    return base.add(amount, unit);
  }

  // Numeric forms — split on -, /, .
  const parts = raw.split(/[-/.]/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && /^\d+$/.test(parts[0])) {
    const day = parseInt(parts[0], 10);
    if (day < 1 || day > 31) return null;
    return base.date(day);
  }
  if (parts.length === 2 && parts.every(p => /^\d+$/.test(p))) {
    const [d, m] = parts.map(Number);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return base.month(m - 1).date(d);
  }
  if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
    const [d, m, yRaw] = parts.map(Number);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    const result = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return result.isValid() ? result : null;
  }
  return null;
}

// ── Single-date popup ─────────────────────────────────────────────────
function SingleDatePopup({ value, title, onConfirm, onCancel }) {
  const initial = value ? dayjs(value) : dayjs();
  const [text, setText] = useState(initial.format('DD-MM-YYYY'));
  const inputRef = useRef(null);

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  const parsed = useMemo(() => parseSmartDate(text, initial) || null, [text, initial]);
  const valid  = parsed && parsed.isValid();

  const handleConfirm = () => {
    if (!valid) return;
    onConfirm(parsed);
  };

  // Capture-phase Esc/Enter handler — runs BEFORE any other window
  // keydown listener (e.g. the form's ActionStrip Esc → Back). Without
  // this, pressing Esc while the popup is open would close the form
  // instead of the popup. stopImmediatePropagation kills any other
  // capture-phase listeners on the same target too.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleConfirm();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="dp-backdrop" onMouseDown={onCancel}>
      <div className="dp-popup" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title || 'Date'}>
        <div className="dp-head">
          <span className="dp-title">{title || 'Date'}</span>
          <span className="dp-hint">Enter to confirm · Esc to cancel</span>
        </div>
        <input
          ref={inputRef}
          className={`dp-input${!valid && text ? ' invalid' : ''}`}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="DD-MM-YYYY"
          autoComplete="off"
          spellCheck={false}
        />
        <div className={`dp-preview${valid ? ' ok' : ''}`}>
          {valid ? (
            <>
              <span className="arr">→</span>
              {parsed.format('DD MMM YYYY')}
              <span className="dow">{parsed.format('ddd')}</span>
            </>
          ) : (
            text ? <span className="bad">Couldn't parse — try DD-MM-YYYY</span> : <span>&nbsp;</span>
          )}
        </div>
        <div className="dp-foot">
          <button type="button" className="dp-btn" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
          <button type="button" className="dp-btn primary" disabled={!valid} onClick={handleConfirm}>
            Confirm <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Range popup ───────────────────────────────────────────────────────
function RangeDatePopup({ value, title, onConfirm, onCancel }) {
  const [from0, to0] = Array.isArray(value) ? value : [null, null];
  const initFrom = from0 ? dayjs(from0) : fyStart();
  const initTo   = to0   ? dayjs(to0)   : fyEnd();
  const [fromText, setFromText] = useState(initFrom.format('DD-MM-YYYY'));
  const [toText,   setToText]   = useState(initTo.format('DD-MM-YYYY'));
  const fromRef = useRef(null);
  const toRef   = useRef(null);

  useEffect(() => {
    setTimeout(() => {
      fromRef.current?.focus();
      fromRef.current?.select();
    }, 0);
  }, []);

  const parsedFrom = useMemo(() => parseSmartDate(fromText, initFrom) || null, [fromText, initFrom]);
  const parsedTo   = useMemo(() => parseSmartDate(toText,   initTo)   || null, [toText, initTo]);
  const valid = parsedFrom && parsedTo
    && parsedFrom.isValid() && parsedTo.isValid()
    && !parsedFrom.isAfter(parsedTo);

  const handleConfirm = () => {
    if (!valid) return;
    onConfirm([parsedFrom, parsedTo]);
  };

  // Capture-phase keydown — same logic as the single popup. Stops the
  // form's strip Esc handler from firing while the popup is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleConfirm();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="dp-backdrop" onMouseDown={onCancel}>
      <div className="dp-popup wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title || 'Period'}>
        <div className="dp-head">
          <span className="dp-title">{title || 'Period'}</span>
          <span className="dp-hint">Enter to confirm · Esc to cancel</span>
        </div>
        <div className="dp-range">
          <div className="dp-range-fld">
            <label>From</label>
            <input
              ref={fromRef}
              className={`dp-input${parsedFrom ? '' : ' invalid'}`}
              type="text" value={fromText}
              onChange={(e) => setFromText(e.target.value)}
              placeholder="DD-MM-YYYY"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="dp-range-arr">→</div>
          <div className="dp-range-fld">
            <label>To</label>
            <input
              ref={toRef}
              className={`dp-input${parsedTo ? '' : ' invalid'}`}
              type="text" value={toText}
              onChange={(e) => setToText(e.target.value)}
              placeholder="DD-MM-YYYY"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className={`dp-preview${valid ? ' ok' : ''}`}>
          {valid ? (
            <>
              <span className="arr">→</span>
              {parsedFrom.format('DD MMM YYYY')} — {parsedTo.format('DD MMM YYYY')}
              <span className="dow">{parsedTo.diff(parsedFrom, 'day') + 1} days</span>
            </>
          ) : (
            <span className="bad">{parsedFrom && parsedTo && parsedFrom.isAfter(parsedTo)
              ? '"From" must be on or before "To"'
              : 'Invalid date'}</span>
          )}
        </div>
        <div className="dp-foot">
          <button type="button" className="dp-btn" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
          <button type="button" className="dp-btn primary" disabled={!valid} onClick={handleConfirm}>
            Confirm <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Provider + hook ───────────────────────────────────────────────────
const DatePopupContext = createContext(null);

export function DatePopupProvider({ children }) {
  const [state, setState] = useState({ open: false, opts: null });

  const openDate = useCallback((opts) => {
    setState({ open: true, opts });
  }, []);
  const closeDate = useCallback(() => {
    setState({ open: false, opts: null });
  }, []);

  // Stable handlers that resolve through the live opts.
  const handleConfirm = useCallback((value) => {
    const opts = state.opts;
    closeDate();
    try { opts?.onConfirm?.(value); } catch (e) { console.error('[DatePopup]', e); }
  }, [state.opts, closeDate]);
  const handleCancel = useCallback(() => {
    const opts = state.opts;
    closeDate();
    try { opts?.onCancel?.(); } catch (e) { console.error('[DatePopup]', e); }
  }, [state.opts, closeDate]);

  const node = !state.open ? null : ReactDOM.createPortal(
    state.opts?.mode === 'range'
      ? <RangeDatePopup
          value={state.opts.value}
          title={state.opts.title}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      : <SingleDatePopup
          value={state.opts?.value}
          title={state.opts?.title}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />,
    document.body,
  );

  return (
    <DatePopupContext.Provider value={{ openDate, closeDate, isOpen: state.open }}>
      {children}
      {node}
    </DatePopupContext.Provider>
  );
}

export function useDatePopup() {
  const ctx = useContext(DatePopupContext);
  if (!ctx) {
    // Soft-fail in tests / detached renders. In production the provider
    // is mounted at the app root so this branch shouldn't fire.
    return {
      openDate: () => console.warn('[DatePopup] no provider'),
      closeDate: () => {},
      isOpen: false,
    };
  }
  return ctx;
}

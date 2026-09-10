import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { ledgerAPI, settingsAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import { useBack } from '../utils/useBack';
import { buildStatementPdf } from '../../utils/ledgerPdf';
import { shareViaNative } from '../utils/sharePdf';
import useKeyboardInset from '../hooks/useKeyboardInset';
import './ReportList.css';
import { friendlyError } from '../utils/offlineSnapshot';

// ── Icons ──────────────────────────────────────────────────────────────
const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);
const ChevDown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6"/>
  </svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>
  </svg>
);
const ShareIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>
  </svg>
);
const CloseIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12"/>
  </svg>
);

// ── Company cache (for PDF header) ─────────────────────────────────────
let _companyCache = null;
let _companyAt = 0;
async function loadCompany() {
  if (_companyCache && Date.now() - _companyAt < 60_000) return _companyCache;
  try {
    const r = await settingsAPI.getSystem();
    _companyCache = r.data?.data || r.data || {};
    _companyAt = Date.now();
  } catch { _companyCache = {}; }
  return _companyCache;
}

// ── Period presets ─────────────────────────────────────────────────────
function buildPresets() {
  const today = new Date();
  const fy = defaultFY();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return [
    { key: 'month', label: 'Month', from: isoDate(monthStart), to: isoDate(today) },
    { key: 'fy',    label: 'FY',    from: isoDate(fy.from),    to: isoDate(fy.to)  },
  ];
}

const PRESETS = buildPresets();
const TODAY = isoDate();

// ── Voucher type → route map ───────────────────────────────────────────
const TYPE_ROUTE = {
  Sales:             'sales',
  'Sales Return':    'sales-return',
  Purchase:          'purchase',
  'Purchase Return': 'purchase-return',
  Receipt:           'receipt',
  Payment:           'payment',
  Journal:           'journal',
  'Journal Voucher': 'journal',
  Expense:           'expense',
};

const TYPE_STYLE = {
  'Sales':           { bg: 'rgba(14,175,202,0.15)', color: '#0EAFCA' },
  'Sales Return':    { bg: '#fef3c7', color: '#92400e' },
  'Receipt':         { bg: '#dcfce7', color: '#166534' },
  'Purchase':        { bg: '#fef3c7', color: '#b45309' },
  'Purchase Return': { bg: '#dcfce7', color: '#166534' },
  'Payment':         { bg: '#fee2e2', color: '#991b1b' },
  'Journal':         { bg: '#dbeafe', color: '#1e40af' },
  'Journal Voucher': { bg: '#dbeafe', color: '#1e40af' },
  'Expense':         { bg: '#f3e8ff', color: '#7c3aed' },
};
const DEFAULT_TYPE_STYLE = { bg: '#f1f5f9', color: '#64748b' };

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

function fmtBal(value, side) {
  if (value === undefined || value === null) return '';
  const amt = Math.abs(Number(value));
  const s = side || (Number(value) >= 0 ? 'Dr' : 'Cr');
  return `₹${formatINR(amt)} ${s}`;
}

// ── Component ──────────────────────────────────────────────────────────
export default function LedgerPage() {
  const navigate = useNavigate();
  const goBack = useBack('/reports');
  const [urlParams, setUrlParams] = useSearchParams();

  const fy = defaultFY();
  const [fromDate,    setFromDate]    = useState(() => urlParams.get('from') || isoDate(fy.from));
  const [toDate,      setToDate]      = useState(() => urlParams.get('to')   || isoDate(fy.to));
  const [accounts,    setAccounts]    = useState([]);
  const [accountId,   setAccountId]   = useState(() => {
    const raw = urlParams.get('account_id');
    return raw ? Number(raw) : null;
  });
  const [accountName, setAccountName] = useState(() => urlParams.get('account_name') || '');
  const [entries,     setEntries]     = useState([]);
  const [meta,        setMeta]        = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [acctLoading, setAcctLoading] = useState(true);
  const [sheetOpen,   setSheetOpen]   = useState(false);
  const [sheetSearch, setSheetSearch] = useState('');
  const [searchOn,    setSearchOn]    = useState(false);
  const [search,      setSearch]      = useState('');
  const [preset,      setPreset]      = useState('fy');
  const [pdfUrl,      setPdfUrl]      = useState(null);
  const [pdfBusy,     setPdfBusy]     = useState(false);
  const searchRef      = useRef(null);
  const sheetSearchRef = useRef(null);
  const pdfUrlRef      = useRef(null);
  const kbdInset       = useKeyboardInset();

  useEffect(() => {
    const p = { from: fromDate, to: toDate };
    if (accountId)   p.account_id   = accountId;
    if (accountName) p.account_name = accountName;
    setUrlParams(p, { replace: true });
  }, [fromDate, toDate, accountId, accountName, setUrlParams]);

  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  useEffect(() => {
    if (sheetOpen) setTimeout(() => sheetSearchRef.current?.focus(), 80);
    if (!sheetOpen) setSheetSearch('');
  }, [sheetOpen]);

  useEffect(() => {
    setAcctLoading(true);
    ledgerAPI.listAccounts()
      .then((res) => {
        const list = res.data?.data || res.data || [];
        const all = Array.isArray(list) ? list : [];
        setAccounts(all.filter((a) => !a.is_party_ledger));
      })
      .catch(() => {})
      .finally(() => setAcctLoading(false));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    ledgerAPI.statement(accountId, { from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const d = res.data?.data || res.data;
        setEntries(d?.entries || []);
        setMeta({
          opening_balance: d?.opening_balance,
          closing_balance: d?.closing_balance,
          opening_side:    d?.opening_side,
          closing_side:    d?.closing_side,
          total_debit:     d?.total_debit,
          total_credit:    d?.total_credit,
          account:         d?.account,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load ledger') });
        setEntries([]);
        setMeta(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, fromDate, toDate]);

  function applyPreset(p) {
    setPreset(p.key);
    setFromDate(p.from);
    setToDate(p.to);
  }

  function selectAccount(acc) {
    setAccountId(acc.ledger_id);
    setAccountName(acc.ledger_name || '');
    setSheetOpen(false);
  }

  // Running balance from opening
  const entriesWithRunning = useMemo(() => {
    if (!meta || entries.length === 0) return entries;
    const opening = Number(meta.opening_balance ?? 0);
    let running = (meta.opening_side || 'Dr') === 'Dr' ? opening : -opening;
    return entries.map((e) => {
      running += Number(e.debit || 0) - Number(e.credit || 0);
      return {
        ...e,
        _runningAmt:  Math.abs(running),
        _runningSide: running >= 0 ? 'Dr' : 'Cr',
      };
    });
  }, [entries, meta]);

  const filtered = useMemo(() => {
    if (!search.trim()) return entriesWithRunning;
    const q = search.trim().toLowerCase();
    return entriesWithRunning.filter((e) =>
      (e.voucher_no   || '').toLowerCase().includes(q) ||
      (e.narration    || '').toLowerCase().includes(q) ||
      (e.voucher_type || '').toLowerCase().includes(q)
    );
  }, [entriesWithRunning, search]);

  const groupedAccounts = useMemo(() => {
    if (!sheetSearch.trim()) {
      const groups = {};
      for (const acc of accounts) {
        const g = acc.sub_group || acc.group_name || 'Other';
        if (!groups[g]) groups[g] = [];
        groups[g].push(acc);
      }
      return groups;
    }
    const q = sheetSearch.trim().toLowerCase();
    const matches = accounts.filter((a) =>
      (a.ledger_name || '').toLowerCase().includes(q) ||
      (a.sub_group   || '').toLowerCase().includes(q)
    );
    return { 'Search results': matches };
  }, [accounts, sheetSearch]);

  function drillVoucher(entry) {
    const vType = TYPE_ROUTE[entry.voucher_type];
    const sourceId = entry.source_id || entry.voucher_id;
    if (vType && sourceId) navigate(`/vouchers/${vType}/${sourceId}`);
  }

  const handleViewPdf = useCallback(async () => {
    if (!accountId || !meta) return;
    setPdfBusy(true);
    try {
      const company = await loadCompany();
      const companyName = company?.company_name || company?.name;
      const entriesForPdf = filtered.map((e) => ({
        ...e,
        date:    e.entry_date || e.date,
        balance: e._runningAmt !== undefined
          ? (e._runningSide === 'Dr' ? e._runningAmt : -e._runningAmt)
          : (e.balance || 0),
      }));
      const statement = {
        entries:         entriesForPdf,
        period:          { from: fromDate, to: toDate },
        opening_balance: meta.opening_balance,
        opening_side:    meta.opening_side,
        closing_balance: meta.closing_balance,
        closing_side:    meta.closing_side,
        total_debit:     meta.total_debit,
        total_credit:    meta.total_credit,
      };
      const result = await buildStatementPdf({ title: 'Ledger Statement', subtitle: accountName, statement, party: null, companyName });
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } catch {
      Toast.show({ icon: 'fail', content: 'PDF generation failed' });
    } finally {
      setPdfBusy(false);
    }
  }, [accountId, meta, filtered, fromDate, toDate, accountName]);

  const closePdfViewer = useCallback(() => {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }, []);

  const handleSharePdf = useCallback(async () => {
    if (!accountId || !meta) return;
    setPdfBusy(true);
    try {
      const company = await loadCompany();
      const companyName = company?.company_name || company?.name;
      const entriesForPdf = filtered.map((e) => ({
        ...e,
        date:    e.entry_date || e.date,
        balance: e._runningAmt !== undefined
          ? (e._runningSide === 'Dr' ? e._runningAmt : -e._runningAmt)
          : (e.balance || 0),
      }));
      const statement = {
        entries:         entriesForPdf,
        period:          { from: fromDate, to: toDate },
        opening_balance: meta.opening_balance,
        opening_side:    meta.opening_side,
        closing_balance: meta.closing_balance,
        closing_side:    meta.closing_side,
        total_debit:     meta.total_debit,
        total_credit:    meta.total_credit,
      };
      const result = await buildStatementPdf({ title: 'Ledger Statement', subtitle: accountName, statement, party: null, companyName });
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const safe = (accountName || 'ledger').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const ok = await shareViaNative(result.blob, `ledger-${safe}.pdf`, 'Ledger Statement');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } catch {
      Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally {
      setPdfBusy(false);
    }
  }, [accountId, meta, filtered, fromDate, toDate, accountName]);

  const hasData    = !loading && accountId && entries.length > 0;
  const closingBal  = meta?.closing_balance ?? 0;
  const closingSide = meta?.closing_side || 'Dr';

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Ledger <em>statement</em></h1>
        {accountId && (
          <button
            className="rl-icon-btn"
            onClick={handleViewPdf}
            disabled={pdfBusy}
            aria-label="PDF preview"
            style={{ color: !pdfBusy ? 'var(--c-primary)' : undefined }}
          >
            {pdfBusy
              ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-primary)' }}>…</span>
              : <PdfIcon />}
          </button>
        )}
        {accountId && (
          <button className="rl-icon-btn" onClick={handleSharePdf} disabled={pdfBusy} aria-label="Share PDF">
            <ShareIcon />
          </button>
        )}
        {accountId && (
          <button
            className={`rl-icon-btn${searchOn ? ' active' : ''}`}
            onClick={() => setSearchOn((v) => !v)}
            aria-label="Search entries"
          >
            <SearchIcon />
          </button>
        )}
      </div>

      {/* ── Account picker button ── */}
      <button className="rl-account-btn" onClick={() => setSheetOpen(true)} disabled={acctLoading}>
        <span className="rl-account-label">Account</span>
        {accountName
          ? <span className="rl-account-name">{accountName}</span>
          : <span className="rl-account-placeholder">
              {acctLoading ? 'Loading accounts…' : 'Tap to select account'}
            </span>
        }
        <span className="rl-account-chev"><ChevDown /></span>
      </button>

      {/* ── Date range ── */}
      <div className="rl-range" style={{ marginTop: 8 }}>
        <label className="rl-date">
          <span className="rl-date-key">FROM</span>
          <span className="rl-date-val">{prettyDate(fromDate)}</span>
          <input type="date" value={fromDate} max={TODAY}
            onChange={(e) => { if (e.target.value) { setFromDate(e.target.value); setPreset(''); } }} />
        </label>
        <span className="rl-range-arrow">→</span>
        <label className="rl-date">
          <span className="rl-date-key">TO</span>
          <span className="rl-date-val">{prettyDate(toDate)}</span>
          <input type="date" value={toDate} min={fromDate}
            onChange={(e) => { if (e.target.value) { setToDate(e.target.value); setPreset(''); } }} />
        </label>
      </div>

      {/* ── Period presets ── */}
      <div className="rl-presets">
        {PRESETS.map((p) => (
          <button key={p.key} className={`rl-preset${preset === p.key ? ' active' : ''}`}
            onClick={() => applyPreset(p)}>{p.label}</button>
        ))}
      </div>

      {/* ── Search (collapsible) ── */}
      {searchOn && (
        <div className="rl-search">
          <input ref={searchRef} placeholder="Voucher no, narration, type…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false" />
        </div>
      )}

      {/* ── Column header ── */}
      {accountId && (
        <div className="ps-col-header">
          <span className="ps-col-info">Type &amp; Date</span>
          <span className="ps-col-dr">Debit</span>
          <span className="ps-col-cr">Credit</span>
          <span className="ps-col-bal">Balance</span>
        </div>
      )}

      {/* ── Entry list ── */}
      <div className="rl-list">

        {/* Opening balance row */}
        {!loading && meta && (
          <div className="ps-special-row">
            <div className="ps-special-left">
              <span className="ps-special-label">Opening Balance</span>
              <span className="ps-special-date">{prettyDate(fromDate)}</span>
            </div>
            <span className="ps-col-dr ps-special-dash">—</span>
            <span className="ps-col-cr ps-special-dash">—</span>
            <span className={`ps-col-bal ps-special-bal ${(meta.opening_side || 'Dr').toLowerCase()}`}>
              {meta.opening_balance !== undefined ? fmtBal(meta.opening_balance, meta.opening_side) : '₹0 Dr'}
            </span>
          </div>
        )}

        {!accountId && !loading && (
          <div className="rl-empty">Select an account to view its ledger</div>
        )}
        {accountId && loading && <SkeletonRows />}
        {accountId && !loading && filtered.length === 0 && entries.length > 0 && (
          <div className="rl-empty">No entries matching &ldquo;{search}&rdquo;</div>
        )}
        {accountId && !loading && entries.length === 0 && meta && (
          <div className="rl-empty">No entries in this period</div>
        )}

        {accountId && !loading && filtered.map((entry, i) => (
          <LedgerEntryRow key={entry.id ?? entry.entry_id ?? i} entry={entry}
            onClick={() => drillVoucher(entry)} />
        ))}
      </div>

      {/* ── Sticky footer: totals + closing balance ── */}
      {hasData && meta && (
        <div className="ps-stmt-footer">
          <div className="ps-stmt-footer-row ps-stmt-footer-totals">
            <span className="ps-stmt-footer-label">Total</span>
            <span className="ps-col-dr ps-stmt-amt dr">₹{formatINR(meta.total_debit ?? 0)}</span>
            <span className="ps-col-cr ps-stmt-amt cr">₹{formatINR(meta.total_credit ?? 0)}</span>
            <span className="ps-col-bal" />
          </div>
          <div className="ps-stmt-footer-row ps-stmt-footer-closing">
            <span className="ps-stmt-footer-label ps-stmt-closing-lbl">Closing Balance</span>
            <span className="ps-col-dr ps-special-dash">—</span>
            <span className="ps-col-cr ps-special-dash">—</span>
            <span className={`ps-col-bal ps-stmt-closing-val ${closingSide.toLowerCase()}`}>
              {fmtBal(closingBal, closingSide)}
            </span>
          </div>
        </div>
      )}

      {/* ── PDF viewer overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Ledger Statement</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                const safe = (accountName || 'ledger').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
                await shareViaNative(blob, `ledger-${safe}.pdf`, 'Ledger Statement');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Ledger Statement PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}

      {/* ── Account picker bottom sheet ── */}
      {sheetOpen && (
        <>
          <div className="rl-sheet-scrim" onClick={() => setSheetOpen(false)} />
          <div
            className="rl-sheet"
            role="dialog"
            aria-label="Select account"
            style={kbdInset > 0 ? { bottom: kbdInset, maxHeight: `calc(100vh - ${kbdInset + 28}px)` } : undefined}
          >
            <div className="rl-sheet-handle" />
            <div className="rl-sheet-head">
              <h2 className="rl-sheet-title">Select <em>account</em></h2>
            </div>
            <div className="rl-sheet-search">
              <input ref={sheetSearchRef}
                placeholder={`Search ${accounts.length} accounts…`}
                value={sheetSearch}
                onChange={(e) => setSheetSearch(e.target.value)}
                autoCorrect="off" autoCapitalize="none" />
            </div>
            <div className="rl-sheet-list">
              {Object.entries(groupedAccounts).map(([group, accs]) => (
                <React.Fragment key={group}>
                  <div className="rl-sheet-group">{group}</div>
                  {accs.map((acc) => (
                    <button key={acc.ledger_id}
                      className={`rl-sheet-item${acc.ledger_id === accountId ? ' active' : ''}`}
                      onClick={() => selectAccount(acc)}
                    >
                      <span className="rl-sheet-item-name">{acc.ledger_name}</span>
                      {acc.current_balance !== undefined && Number(acc.current_balance) !== 0 && (
                        <span className="rl-sheet-item-meta">₹{formatINR(Math.abs(acc.current_balance))}</span>
                      )}
                    </button>
                  ))}
                </React.Fragment>
              ))}
              {accounts.length === 0 && !acctLoading && (
                <div className="rl-empty">No accounts found</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Ledger entry row ────────────────────────────────────────────────────
function LedgerEntryRow({ entry, onClick }) {
  const debit  = Number(entry.debit  || 0);
  const credit = Number(entry.credit || 0);
  const hasVoucher = !!(TYPE_ROUTE[entry.voucher_type] && (entry.source_id || entry.voucher_id));
  const ts = TYPE_STYLE[entry.voucher_type] || DEFAULT_TYPE_STYLE;

  return (
    <div className="ps-entry" onClick={hasVoucher ? onClick : undefined}
      style={{ cursor: hasVoucher ? 'pointer' : 'default' }}>
      {/* Line 1: type chip */}
      <div className="ps-entry-head">
        <span className="ps-type-chip" style={{ background: ts.bg, color: ts.color }}>
          {entry.voucher_type || 'Entry'}
        </span>
      </div>
      {/* Line 2: date / narration | DR | CR | Balance */}
      <div className="ps-entry-main">
        <div className="ps-entry-info">
          <span className="ps-edate">{prettyDate(entry.entry_date || entry.date)}</span>
          {entry.voucher_no && <span className="ps-voucher">· {entry.voucher_no}</span>}
          {entry.narration  && <span className="ps-voucher ps-narration">· {entry.narration}</span>}
        </div>
        <span className={`ps-col-dr ps-amt${debit > 0 ? ' dr' : ' zero'}`}>
          {debit > 0 ? `₹${formatINR(debit)}` : '—'}
        </span>
        <span className={`ps-col-cr ps-amt${credit > 0 ? ' cr' : ' zero'}`}>
          {credit > 0 ? `₹${formatINR(credit)}` : '—'}
        </span>
        <span className={`ps-col-bal ps-running-bal ${(entry._runningSide || 'Dr').toLowerCase()}`}>
          {entry._runningAmt !== undefined ? `₹${formatINR(entry._runningAmt)}` : ''}
        </span>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 11, width: '28%', borderRadius: 4, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 9, width: '50%' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="rl-skel" style={{ height: 13, width: 52 }} />
            <div className="rl-skel" style={{ height: 13, width: 52 }} />
            <div className="rl-skel" style={{ height: 13, width: 64 }} />
          </div>
        </div>
      ))}
    </>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { ledgerAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import './ReportList.css';

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

// ── Voucher type → route map for drill-down ────────────────────────────
const TYPE_ROUTE = {
  Sales:            'sales',
  'Sales Return':   'sales-return',
  Purchase:         'purchase',
  'Purchase Return':'purchase-return',
  Receipt:          'receipt',
  Payment:          'payment',
  Journal:          'journal',
  'Journal Voucher':'journal',
  Expense:          'expense',
};

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Component ──────────────────────────────────────────────────────────
export default function LedgerPage() {
  const navigate = useNavigate();
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
  const [meta,        setMeta]        = useState(null); // { opening_balance, closing_balance, total_debit, total_credit }
  const [loading,     setLoading]     = useState(false);
  const [acctLoading, setAcctLoading] = useState(true);
  const [sheetOpen,   setSheetOpen]   = useState(false);
  const [sheetSearch, setSheetSearch] = useState('');
  const [searchOn,    setSearchOn]    = useState(false);
  const [search,      setSearch]      = useState('');
  const [preset,      setPreset]      = useState('fy');
  const searchRef = useRef(null);
  const sheetSearchRef = useRef(null);

  // Sync URL
  useEffect(() => {
    const p = { from: fromDate, to: toDate };
    if (accountId)   p.account_id   = accountId;
    if (accountName) p.account_name = accountName;
    setUrlParams(p, { replace: true });
  }, [fromDate, toDate, accountId, accountName, setUrlParams]);

  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  useEffect(() => {
    if (sheetOpen) setTimeout(() => sheetSearchRef.current?.focus(), 80);
    if (!sheetOpen) setSheetSearch('');
  }, [sheetOpen]);

  // Load account list once — exclude party ledgers (customers/suppliers
  // have their own statement pages)
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

  // Load statement when account + dates change
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    ledgerAPI.statement(accountId, { from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const d = res.data?.data || res.data; // API wraps in { data: {...} }
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
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load ledger' });
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

  // Client-side search on loaded entries
  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.trim().toLowerCase();
    return entries.filter((e) =>
      (e.voucher_no   || '').toLowerCase().includes(q) ||
      (e.narration    || '').toLowerCase().includes(q) ||
      (e.voucher_type || '').toLowerCase().includes(q)
    );
  }, [entries, search]);

  // Group accounts by sub_group for the picker sheet
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
    // Flat search results
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
    if (vType && sourceId) {
      navigate(`/vouchers/${vType}/${sourceId}`);
    }
  }

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/reports'))} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Ledger <em>statement</em></h1>
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
      <button
        className="rl-account-btn"
        onClick={() => setSheetOpen(true)}
        disabled={acctLoading}
      >
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
          <input
            type="date" value={fromDate} max={TODAY}
            onChange={(e) => { if (e.target.value) { setFromDate(e.target.value); setPreset(''); } }}
          />
        </label>
        <span className="rl-range-arrow">→</span>
        <label className="rl-date">
          <span className="rl-date-key">TO</span>
          <span className="rl-date-val">{prettyDate(toDate)}</span>
          <input
            type="date" value={toDate} min={fromDate}
            onChange={(e) => { if (e.target.value) { setToDate(e.target.value); setPreset(''); } }}
          />
        </label>
      </div>

      {/* ── Period presets ── */}
      <div className="rl-presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`rl-preset${preset === p.key ? ' active' : ''}`}
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ── Search (collapsible) ── */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Voucher no, narration, type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* ── Balance header card ── */}
      {!loading && meta && (
        <div className="rl-balance-card">
          <div className="rl-balance-item">
            <div className={`rl-balance-val ${meta.opening_side === 'Cr' ? 'cr' : 'dr'}`}>
              {meta.opening_balance !== undefined
                ? `₹${formatINR(Math.abs(meta.opening_balance))} ${meta.opening_side || ''}`
                : '—'}
            </div>
            <div className="rl-balance-key">Opening</div>
          </div>
          <div className="rl-balance-item">
            <div className="rl-balance-val dr">₹{formatINR(meta.total_debit ?? 0)}</div>
            <div className="rl-balance-key">Dr</div>
          </div>
          <div className="rl-balance-item">
            <div className="rl-balance-val cr">₹{formatINR(meta.total_credit ?? 0)}</div>
            <div className="rl-balance-key">Cr</div>
          </div>
          <div className="rl-balance-item">
            <div className={`rl-balance-val ${meta.closing_side === 'Cr' ? 'cr' : 'dr'}`}>
              {meta.closing_balance !== undefined
                ? `₹${formatINR(Math.abs(meta.closing_balance))} ${meta.closing_side || ''}`
                : '—'}
            </div>
            <div className="rl-balance-key">Closing</div>
          </div>
        </div>
      )}

      {/* ── Entry list ── */}
      <div className="rl-list" style={{ marginTop: (!loading && meta) ? 8 : 0 }}>
        {!accountId && !loading && (
          <div className="rl-empty">Select an account to view its ledger</div>
        )}

        {accountId && loading && <SkeletonRows />}

        {accountId && !loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim()
              ? `No entries matching "${search}"`
              : 'No entries in this period'}
          </div>
        )}

        {accountId && !loading && filtered.map((entry, i) => (
          <LedgerEntryRow
            key={entry.id ?? i}
            entry={entry}
            onClick={() => drillVoucher(entry)}
          />
        ))}

        {accountId && !loading && filtered.length > 0 && (
          <div className="rl-footer">
            <span>{filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}</span>
            <span>
              Dr ₹{formatINR(meta?.total_debit ?? 0)} · Cr ₹{formatINR(meta?.total_credit ?? 0)}
            </span>
          </div>
        )}
      </div>

      {/* ── Account picker bottom sheet ── */}
      {sheetOpen && (
        <>
          <div className="rl-sheet-scrim" onClick={() => setSheetOpen(false)} />
          <div className="rl-sheet" role="dialog" aria-label="Select account">
            <div className="rl-sheet-handle" />
            <div className="rl-sheet-head">
              <h2 className="rl-sheet-title">Select <em>account</em></h2>
            </div>
            <div className="rl-sheet-search">
              <input
                ref={sheetSearchRef}
                placeholder={`Search ${accounts.length} accounts…`}
                value={sheetSearch}
                onChange={(e) => setSheetSearch(e.target.value)}
                autoCorrect="off" autoCapitalize="none"
              />
            </div>
            <div className="rl-sheet-list">
              {Object.entries(groupedAccounts).map(([group, accs]) => (
                <React.Fragment key={group}>
                  <div className="rl-sheet-group">{group}</div>
                  {accs.map((acc) => (
                    <button
                      key={acc.ledger_id}
                      className={`rl-sheet-item${acc.ledger_id === accountId ? ' active' : ''}`}
                      onClick={() => selectAccount(acc)}
                    >
                      <span className="rl-sheet-item-name">{acc.ledger_name}</span>
                      {acc.current_balance !== undefined && Number(acc.current_balance) !== 0 && (
                        <span className="rl-sheet-item-meta">
                          ₹{formatINR(Math.abs(acc.current_balance))}
                        </span>
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
  const isDr   = debit > 0;
  const amount = isDr ? debit : credit;
  const hasVoucher = !!(TYPE_ROUTE[entry.voucher_type] && (entry.source_id || entry.voucher_id));

  function fmtBalance(value, side) {
    if (value === undefined || value === null) return '';
    const abs = Math.abs(Number(value));
    return `₹${formatINR(abs)} ${side || (Number(value) >= 0 ? 'Dr' : 'Cr')}`;
  }

  return (
    <div className="rl-entry-row" onClick={hasVoucher ? onClick : undefined}
      style={{ cursor: hasVoucher ? 'pointer' : 'default' }}>
      <div className="rl-entry-main">
        <div className="rl-entry-type">{entry.voucher_type || 'Entry'}</div>
        <div className="rl-entry-narration">
          {entry.narration || entry.voucher_no || '—'}
        </div>
        <div className="rl-entry-meta">
          {entry.entry_date && prettyDate(entry.entry_date)}
          {entry.voucher_no && ` · ${entry.voucher_no}`}
        </div>
      </div>
      <div className="rl-entry-side">
        <div className={`rl-side-pill ${isDr ? 'dr' : 'cr'}`}>{isDr ? 'Dr' : 'Cr'}</div>
        <div className={`rl-entry-amount ${isDr ? 'dr' : 'cr'}`}>
          ₹{formatINR(amount)}
        </div>
        {entry.balance !== undefined && (
          <div className="rl-entry-balance">
            bal {fmtBalance(entry.balance, entry.balance_side)}
          </div>
        )}
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
            <div className="rl-skel" style={{ height: 10, width: '25%', marginBottom: 5 }} />
            <div className="rl-skel" style={{ height: 13, width: '65%', marginBottom: 4 }} />
            <div className="rl-skel" style={{ height: 10, width: '40%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 10, width: 24, borderRadius: 4 }} />
            <div className="rl-skel" style={{ height: 14, width: 60 }} />
            <div className="rl-skel" style={{ height: 10, width: 52 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ── Bank Reconciliation (cross-bank) ──────────────────────────────────
//
// One screen that lists every uncleared cheque / transfer across every
// bank in the company. Solves the month-end workflow that BankStatement
// can't: "show me everything in transit, regardless of which bank, so I
// can chase them in one pass against the bank statements I've got."
//
// Layout:
//
//   ┌─ Title strip ────────────────────────────────────────────────┐
//   │  Bank Reconciliation                                         │
//   │  [status filter] [bank filter] [date range] [refresh]        │
//   ├──────────────────────────────────────────────────────────────┤
//   │  KPI strip — Uncleared count · Value · Banks affected · Oldest│
//   ├──────────────────────────────────────────────────────────────┤
//   │  Aging strip   ┃ 0–7 days ┃ 8–30 ┃ 31–90 ┃ 90+ ┃              │
//   │  (chips, click to filter the table)                          │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Per-bank tiles — one tile per bank, colour-coded             │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Table — Date, Bank, Particulars, Cheque/UTR, Withdrawal,    │
//   │          Deposit, Days, Cleared (toggle)                     │
//   │  Sticky header.                                              │
//   └──────────────────────────────────────────────────────────────┘
//
// Sharing: same bankAPI.markCleared / markUncleared as BankStatement,
// optimistic updates, revert on failure. Stays in sync because both
// pages read from the same payment_receipts.cleared_at field.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, Select, DatePicker, message, Tooltip } from 'antd';
import {
  ReloadOutlined, CheckCircleFilled, BankOutlined,
  WarningFilled, FieldTimeOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { bankAPI } from '../../api';
import './banks.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};
const fmtDate = (s) => s ? dayjs(s).format('DD MMM YYYY') : '—';

// Aging-bucket helper for a single days_outstanding value.  Mirrors the
// server-side bucketing exactly — must stay in sync, otherwise the chip
// counts and table rows won't agree.
const ageBucket = (d) => {
  if (d == null) return null;
  if (d <= 7)  return '0-7';
  if (d <= 30) return '8-30';
  if (d <= 90) return '31-90';
  return '90+';
};

const BUCKET_LABELS = {
  '0-7':   'This week',
  '8-30':  '8–30 days',
  '31-90': '1–3 months',
  '90+':   'Over 3 months',
};

// Tone for an aging bucket — fresh = neutral, old = warning, ancient = danger.
const BUCKET_TONE = {
  '0-7':   'fresh',
  '8-30':  'warm',
  '31-90': 'warn',
  '90+':   'danger',
};

export default function BankReconciliation() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ─── Filter state. URL-driven so refresh / share-link preserves it.
  const [status,  setStatus]  = useState(() => searchParams.get('status')  || 'uncleared');
  const [bankId,  setBankId]  = useState(() => searchParams.get('bank_id') || '');
  const [bucket,  setBucket]  = useState(() => searchParams.get('bucket')  || ''); // client-side only
  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate,   setToDate]   = useState(() => searchParams.get('to_date')   || '');

  // Sync filters → URL (status / bank / dates only — bucket is a
  // client-side overlay so we don't need it in the URL, but we add it
  // anyway so refresh keeps the chip selected).
  useEffect(() => {
    const next = {};
    if (status   && status !== 'uncleared') next.status   = status;
    if (bankId)                              next.bank_id  = bankId;
    if (bucket)                              next.bucket   = bucket;
    if (fromDate)                            next.from_date = fromDate;
    if (toDate)                              next.to_date   = toDate;
    setSearchParams(next, { replace: true });
  }, [status, bankId, bucket, fromDate, toDate, setSearchParams]);

  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);

  // ─── Data load. The server query is the source of truth for entries +
  // per-bank summary + aging totals; bucket chips do client-side filter
  // on top of the entries array (cheap, avoids an extra round-trip).
  const load = useCallback(() => {
    setLd(true);
    bankAPI.reconciliation({
      status,
      ...(bankId   ? { bank_id:   bankId   } : {}),
      ...(fromDate ? { from_date: fromDate } : {}),
      ...(toDate   ? { to_date:   toDate   } : {}),
    })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load reconciliation'))
      .finally(() => setLd(false));
  }, [status, bankId, fromDate, toDate]);
  useEffect(load, [load]);

  // ─── Toggle a single row. Optimistic, revert on failure, then reload
  // to refresh per-bank counts + aging buckets from server truth.
  const toggleCleared = useCallback(async (entry) => {
    if (!entry.transaction_id) return;
    const wasCleared = !!entry.cleared_at;

    setData((d) => ({
      ...d,
      entries: d.entries.map((e) =>
        e.transaction_id === entry.transaction_id
          ? { ...e, cleared_at: wasCleared ? null : new Date().toISOString() }
          : e,
      ),
    }));

    try {
      if (wasCleared) await bankAPI.markUncleared(entry.transaction_id);
      else            await bankAPI.markCleared(entry.transaction_id);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to update clearance');
      setData((d) => ({
        ...d,
        entries: d.entries.map((e2) =>
          e2.transaction_id === entry.transaction_id
            ? { ...e2, cleared_at: wasCleared ? entry.cleared_at : null }
            : e2,
        ),
      }));
    }
  }, [load]);

  // ─── Apply bucket filter (client-side overlay).
  const visibleEntries = useMemo(() => {
    if (!data) return [];
    if (!bucket) return data.entries;
    return data.entries.filter((e) => ageBucket(e.days_outstanding) === bucket);
  }, [data, bucket]);

  const totals  = data?.totals  || {};
  const aging   = data?.aging   || {};
  const perBank = data?.per_bank || [];

  // Bank options for the dropdown — sorted by uncleared count desc so
  // the "where the action is" banks are at the top.
  const bankOptions = useMemo(() => {
    const opts = perBank
      .slice()
      .sort((a, b) => b.count - a.count)
      .map((b) => ({
        value: String(b.bank_id),
        label: `${b.bank_name}${b.count > 0 ? ` · ${b.count} uncleared` : ''}`,
      }));
    return [{ value: '', label: 'All banks' }, ...opts];
  }, [perBank]);

  return (
    <div className="bank-page bank-recon-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Bank Reconciliation</h1>
          <div className="rpt-sub">
            Cross-bank uncleared entries
            <span className="sep">·</span>
            <span>{totals.banks_affected || 0} bank{totals.banks_affected === 1 ? '' : 's'} affected</span>
            {totals.oldest_days > 0 && (
              <>
                <span className="sep">·</span>
                <span>oldest {totals.oldest_days} day{totals.oldest_days === 1 ? '' : 's'}</span>
              </>
            )}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Select
            className="bank-recon-select"
            value={status}
            onChange={setStatus}
            style={{ width: 130 }}
            options={[
              { value: 'uncleared', label: 'Uncleared' },
              { value: 'cleared',   label: 'Cleared' },
              { value: 'all',       label: 'All' },
            ]}
          />
          <Select
            className="bank-recon-select"
            value={bankId || ''}
            onChange={(v) => setBankId(v || '')}
            style={{ width: 220 }}
            options={bankOptions}
          />
          <DatePicker.RangePicker
            className="rpt-date"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) { setFromDate(''); setToDate(''); return; }
              setFromDate(vals[0].format('YYYY-MM-DD'));
              setToDate(vals[1].format('YYYY-MM-DD'));
            }}
            format="DD MMM YYYY"
            allowClear
            placeholder={['All time', '']}
          />
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ──────────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <div className={`rpt-kpi ${totals.count > 0 ? 'tone-warning' : 'tone-success'}`}>
          <div className="rpt-kpi-k">
            {status === 'uncleared' ? 'Uncleared entries' :
             status === 'cleared'   ? 'Cleared entries'   :
                                       'Entries'}
          </div>
          <div className="rpt-kpi-v">{totals.count || 0}</div>
          <div className="bank-kpi-sub">
            {totals.count > 0 ? 'tap a row to mark cleared' : 'all clear · nothing in transit'}
          </div>
        </div>
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total value</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.value)}</div>
          <div className="bank-kpi-sub">Σ |amount| across rows</div>
        </div>
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Net exposure</div>
          <div className="rpt-kpi-v">
            {totals.net_exposure >= 0 ? '+' : '−'}{fmtRupees(Math.abs(totals.net_exposure || 0))}
          </div>
          <div className="bank-kpi-sub">deposits − withdrawals (in transit)</div>
        </div>
        <div className={`rpt-kpi ${(totals.oldest_days || 0) > 30 ? 'tone-danger' : 'tone-success'}`}>
          <div className="rpt-kpi-k">Oldest</div>
          <div className="rpt-kpi-v">{totals.oldest_days || 0}d</div>
          <div className="bank-kpi-sub">days outstanding</div>
        </div>
      </section>

      {/* ─── Aging chips ──────────────────────────────────────────── */}
      {status === 'uncleared' && (
        <section className="bank-aging">
          <div className="bank-aging-lbl">
            <FieldTimeOutlined /> Aging
          </div>
          <button
            className={'bank-aging-chip' + (bucket === '' ? ' on' : '')}
            onClick={() => setBucket('')}
          >
            <span className="lbl">All</span>
            <span className="cnt">{totals.count || 0}</span>
          </button>
          {Object.entries(aging).map(([k, v]) => (
            <button
              key={k}
              className={`bank-aging-chip tone-${BUCKET_TONE[k]}` + (bucket === k ? ' on' : '')}
              onClick={() => setBucket(bucket === k ? '' : k)}
              disabled={v.count === 0}
            >
              <span className="lbl">{BUCKET_LABELS[k]}</span>
              <span className="cnt">{v.count}</span>
              {v.value > 0 && <span className="amt">{fmtRupees(v.value)}</span>}
            </button>
          ))}
        </section>
      )}

      {/* ─── Per-bank tiles ─────────────────────────────────────── */}
      {perBank.length > 1 && (
        <section className="bank-tile-row">
          {perBank.map((b) => {
            const tone = b.count === 0 ? 'ok' : b.count > 5 ? 'danger' : 'warn';
            const isSelected = String(b.bank_id) === bankId;
            return (
              <button
                key={b.bank_id}
                className={`bank-tile bank-tile-${tone}` + (isSelected ? ' on' : '')}
                onClick={() => setBankId(isSelected ? '' : String(b.bank_id))}
                title={`Filter to ${b.bank_name}`}
              >
                <div className="bank-tile-hd">
                  <BankOutlined />
                  <span className="name">{b.bank_name}</span>
                  {b.is_overdraft && <span className="od-badge">OD</span>}
                </div>
                <div className="bank-tile-body">
                  {b.count === 0 ? (
                    <>
                      <CheckCircleFilled className="ic ok" />
                      <span className="msg">All clear</span>
                    </>
                  ) : (
                    <>
                      <span className="cnt">{b.count}</span>
                      <span className="msg">uncleared · {fmtRupees(b.value)}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </section>
      )}

      {/* ─── Main table ─────────────────────────────────────────── */}
      <div className="bank-tbl-wrap">
        <table className="bank-tbl bank-recon-tbl">
          <thead>
            <tr>
              <th className="l">Date</th>
              <th className="l">Bank</th>
              <th className="l">Particulars</th>
              <th className="l">Cheque / UTR</th>
              <th>Withdrawal</th>
              <th>Deposit</th>
              <th className="c">Aging</th>
              <th className="c">Cleared</th>
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={8} className="bank-empty">{loading ? 'Loading…' : '—'}</td></tr>
            ) : visibleEntries.length === 0 ? (
              <tr><td colSpan={8} className="bank-empty">
                {status === 'uncleared' && totals.count === 0
                  ? <>
                      <CheckCircleFilled style={{ fontSize: 32, color: '#34A853', marginBottom: 12, display: 'block' }} />
                      <b>Everything's reconciled.</b>
                      <div style={{ fontSize: 13, marginTop: 8, fontWeight: 400 }}>
                        No cheques or transfers in transit across any bank.
                      </div>
                    </>
                  : bucket
                  ? `No entries in the ${BUCKET_LABELS[bucket].toLowerCase()} bucket.`
                  : 'No entries match the current filters.'}
              </td></tr>
            ) : visibleEntries.map((e, i) => {
              const isCleared = !!e.cleared_at;
              const bk = ageBucket(e.days_outstanding);
              return (
                <tr key={e.transaction_id || i} className={isCleared ? 'cleared' : ''}>
                  <td className="l">
                    <span className="bank-num">{fmtDate(e.entry_date)}</span>
                  </td>
                  <td className="l">
                    <button
                      className="bank-recon-banklink"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        navigate(`/banks/${e.bank_id}/statement`);
                      }}
                      title="Open this bank's statement"
                    >
                      <BankOutlined /> {e.bank_name}
                      {e.is_overdraft && <span className="od-badge sm">OD</span>}
                    </button>
                  </td>
                  <td className="l">
                    <div className="bank-particulars">
                      <span className="primary">{e.party || e.narration || '—'}</span>
                      {e.mode && (
                        <span className="meta">
                          <span className="mode-pill">{e.mode}</span>
                          {e.transaction_type && (
                            <span className="bank-recon-txtype">{e.transaction_type}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="l">
                    {e.cheque
                      ? <span className="bank-cheque">{e.cheque}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td>
                    {e.withdrawal > 0
                      ? <span className="bank-num neg">{fmtN(e.withdrawal)}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td>
                    {e.deposit > 0
                      ? <span className="bank-num pos">{fmtN(e.deposit)}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td className="c">
                    {bk ? (
                      <Tooltip title={`${e.days_outstanding} days outstanding`}>
                        <span className={`bank-age-pill tone-${BUCKET_TONE[bk]}`}>
                          {e.days_outstanding}d
                        </span>
                      </Tooltip>
                    ) : <span className="bank-dash">—</span>}
                  </td>
                  <td className="c">
                    <button
                      className={'bank-tick' + (isCleared ? ' on' : '')}
                      onClick={() => toggleCleared(e)}
                      title={isCleared
                        ? `Cleared on ${fmtDate(e.cleared_at)} — click to undo`
                        : 'Mark as cleared on the bank'}
                    >
                      {isCleared && <CheckCircleFilled />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Footer ──────────────────────────────────────────── */}
      <footer className="bank-foot">
        <span>
          Showing <b>{visibleEntries.length}</b> of <b>{data?.entries.length || 0}</b> entries
          {bucket && <> · filtered to <b>{BUCKET_LABELS[bucket]}</b></>}
          {bankId && perBank.find((b) => String(b.bank_id) === bankId) && (
            <> · in <b>{perBank.find((b) => String(b.bank_id) === bankId).bank_name}</b></>
          )}
        </span>
        <span className="bank-foot-keys">
          {totals.count > 0 ? (
            <span>Tick the <b>○</b> to mark a row as cleared on the bank.</span>
          ) : null}
        </span>
      </footer>
    </div>
  );
}

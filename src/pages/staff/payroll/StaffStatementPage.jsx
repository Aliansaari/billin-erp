// ── StaffStatementPage ─────────────────────────────────────────────────
//
// Staff Statement (/reports/staff-statement?id=<staff_id>&from=&to=).
// Built line for line on PartyStatementPage (Customer / Supplier
// Statement): same header (back, title, period presets, range, Refresh,
// Customize, PDF), same picker bar and meta pills, same type chips, same
// print letterhead, the shared LedgerStatement table and the same F-key
// strip. Only the data source differs: GET /payroll/people/:id/statement
// (services/staffStatement.js), which reads what payroll recorded.
//
// Signs follow the books (a staff member is a ledger like any party):
//   Credit  salary earned (payable to the staff member)
//   Debit   salary paid, advances, money given
//   Balance Cr = the shop owes them · Dr = advance with them
//
// ?back=payroll returns Esc to Payroll instead of Reports.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, DatePicker, Modal, Popover, Select, Tooltip, message } from 'antd';
import { ArrowLeftOutlined, FilePdfOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { payrollAPI } from '../../../api';
import { useFinancialYear } from '../../../hooks/useFinancialYear';
import { downloadStatementPdf } from '../../../utils/ledgerPdf';
import LedgerStatement, { ALL_COLUMNS } from '../../../components/LedgerStatement';
import ActionStrip from '../../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../../components/keyboard/DatePopup';
import { getPref, setPref } from '../../../store/prefSync';
import '../../../components/ledger-statement.css';
import '../../../components/party-picker.css';
import '../../../components/party-statement-page.css';
import './payroll-home.css';

const { RangePicker } = DatePicker;
const TITLE = 'Staff Statement';
const CATEGORIES = ['Salary', 'Payment', 'Advance'];
const KIND_TO_TYPE = { salary: 'Salary', paid: 'Payment', advance: 'Advance' };
const COLS_PREF_KEY = 'ssp_visible_cols';
// Same columns and defaults as the party statements.
const STAFF_DEFAULT = {};

// Same presets, labels and behaviour as PartyStatementPage.
function presets(fyStart, fyEnd) {
  const today = dayjs();
  const thisFyStart = fyStart ? dayjs(fyStart) : today.month(3).startOf('month').subtract(today.month() < 3 ? 1 : 0, 'year');
  const thisFyEnd = fyEnd ? dayjs(fyEnd) : thisFyStart.add(1, 'year').subtract(1, 'day');
  return [
    { v: 'this_fy', l: 'This FY', from: thisFyStart, to: thisFyEnd },
    { v: 'last_fy', l: 'Last FY', from: thisFyStart.subtract(1, 'year'), to: thisFyEnd.subtract(1, 'year') },
    { v: 'this_q', l: 'This Q', from: today.startOf('quarter'), to: today.endOf('quarter') },
    { v: 'this_month', l: 'This Month', from: today.startOf('month'), to: today.endOf('month') },
    { v: 'custom', l: 'Custom', from: null, to: null },
  ];
}

/** Payroll statement → the shape LedgerStatement / ledgerPdf render. */
function toLedger(st) {
  if (!st) return null;
  return {
    party: { party_name: st.staff.name },
    period: { from: st.from, to: st.to },
    opening_balance: -st.opening,
    total_debit: st.paid,
    total_credit: st.earned,
    closing_balance: -st.closing,
    entries: st.rows.map((r) => ({
      entry_id: r.ref,
      date: r.date,
      voucher_type: KIND_TO_TYPE[r.kind] || 'Journal',
      source_type: 'staff',
      voucher_no: r.voucher_no || '',
      // Short reason in brackets, like a party statement's narration: "Money given (Festival)".
      narration: r.detail ? `${r.text} (${r.detail})` : r.text,
      payment_mode: r.mode || '',
      remarks: r.detail || '',
      debit: r.paid,
      credit: r.earned,
      balance: -r.balance,
      cancel: r.cancel || null,
      amount: r.paid || r.earned,
    })),
  };
}

async function downloadExcel({ filename, rows, headers }) {
  const ExcelJS = await import('exceljs').then((m) => m.default || m);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// Same money / Dr-Cr formatting as PartyPicker's balance pill.
const fmtBal = (v) => Math.abs(parseFloat(v || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const drCr = (v) => (parseFloat(v || 0) >= 0 ? 'Dr' : 'Cr');
const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());

export default function StaffStatementPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();
  const backToPayroll = searchParams.get('back') === 'payroll';
  const goBack = () => navigate(backToPayroll ? '/staff-payroll' : '/reports');

  const [people, setPeople] = useState([]);
  const [staffId, setStaffId] = useState(() => Number(searchParams.get('id')) || null);
  const [from, setFrom] = useState(searchParams.get('from') || fyStart || null);
  const [to, setTo] = useState(searchParams.get('to') || fyEnd || null);
  const [st, setSt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [voucherFilter, setVoucherFilter] = useState(() => new Set());
  const [modal, modalCtx] = Modal.useModal();
  const { openDate } = useDatePopup();
  const selectRef = useRef(null);

  useEffect(() => { payrollAPI.home().then(({ data }) => setPeople(data?.people || [])).catch(() => {}); }, []);
  useEffect(() => { if (!from && fyStart && !searchParams.get('from')) setFrom(fyStart); if (!to && fyEnd && !searchParams.get('to')) setTo(fyEnd); }, [fyStart, fyEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch whenever the person or the period changes; stale responses are dropped.
  useEffect(() => {
    if (!staffId) { setSt(null); return undefined; }
    let stale = false;
    setLoading(true);
    payrollAPI.statement(staffId, { from: from || undefined, to: to || undefined })
      .then(({ data }) => { if (!stale) setSt(data); })
      .catch((e) => { if (!stale) { message.error(e?.response?.data?.error || e?.response?.data?.message || 'Failed to load statement.'); setSt(null); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [staffId, from, to, tick]);

  // URL writeback, as on the party statements (refresh / bookmarks keep the view).
  useEffect(() => {
    const next = new URLSearchParams();
    if (staffId) next.set('id', String(staffId));
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    if (backToPayroll) next.set('back', 'payroll');
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    setSearchParams(next, { replace: true });
  }, [staffId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const statement = useMemo(() => toLedger(st), [st]);
  const person = people.find((p) => p.staff_id === staffId) || null;

  const activePreset = useMemo(() => {
    const hit = presets(fyStart, fyEnd).find((p) => ((p.from?.format('YYYY-MM-DD') || null) === (from || null))
      && ((p.to?.format('YYYY-MM-DD') || null) === (to || null)));
    return hit?.v || 'custom';
  }, [from, to, fyStart, fyEnd]);
  const setPreset = (p) => { if (p.v === 'custom') return; setFrom(p.from?.format('YYYY-MM-DD') || null); setTo(p.to?.format('YYYY-MM-DD') || null); };

  const toggleVoucher = (cat) => setVoucherFilter((prev) => { const n = new Set(prev); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });

  // ── Column visibility (same Customize popover as the party statements) ──
  const [colVis, setColVis] = useState(() => {
    const saved = getPref(COLS_PREF_KEY, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
    return ALL_COLUMNS.reduce((acc, c) => ({ ...acc, [c.key]: STAFF_DEFAULT[c.key] ?? c.default }), {});
  });
  const toggleCol = (key) => setColVis((prev) => {
    if (ALL_COLUMNS.find((c) => c.key === key)?.required) return prev;
    const next = { ...prev, [key]: !prev[key] };
    setPref(COLS_PREF_KEY, next);
    return next;
  });
  const visibleColumns = useMemo(() => ALL_COLUMNS.filter((c) => c.required || colVis[c.key]).map((c) => c.key), [colVis]);
  const customizeContent = (
    <div className="cols-menu">
      <div className="grp">
        <div className="mh">Columns</div>
        {ALL_COLUMNS.map((c) => (
          <label key={c.key} className={`opt${c.required ? ' fixed' : ''}`}>
            <input type="checkbox" checked={c.required || !!colVis[c.key]} disabled={c.required} onChange={() => toggleCol(c.key)} />
            <span>{c.label}</span>
            {c.required && <span className="pin">Required</span>}
          </label>
        ))}
      </div>
    </div>
  );

  // ── Actions ──
  const refresh = () => setTick((t) => t + 1);
  const name = titleCase(st?.staff?.name || person?.name || '');
  const onPdf = async () => {
    if (!statement) { message.info('Nothing to export.'); return; }
    try {
      await downloadStatementPdf({ title: TITLE, subtitle: name, statement, voucherFilter, party: { mobile_1: st?.staff?.phone || null } });
    } catch (e) { console.error(e); message.error('PDF export failed.'); }
  };
  const onExcel = () => {
    if (!statement?.entries?.length) { message.info('Nothing to export.'); return; }
    const rows = [
      [from || '', '', '', 'Opening Balance', '', '', statement.opening_balance],
      ...statement.entries.map((e) => [e.date, e.voucher_type, e.voucher_no || '', e.narration, e.debit || '', e.credit || '', e.balance]),
      ['', '', '', 'Period Totals', statement.total_debit, statement.total_credit, ''],
      [to || '', '', '', 'Closing Balance', '', '', statement.closing_balance],
    ];
    downloadExcel({ filename: `staff-statement-${(name || 'staff').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`,
      rows, headers: ['Date', 'Type', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Balance'] });
  };

  // Clicking an advance / money given that no salary has taken back yet
  // offers to cancel it (reverses the cash or bank entry).
  const onRowClick = (row) => {
    if (!row.cancel) return;
    modal.confirm({
      rootClassName: 'ar-pop', title: `Cancel this ₹${Number(row.amount).toLocaleString('en-IN')} ${row.narration.toLowerCase()}?`,
      okText: 'Cancel it', cancelText: 'Keep', okButtonProps: { danger: true },
      content: `Dated ${dayjs(row.date).format('DD-MM-YYYY')}. It comes off the statement and the cash or bank entry is reversed.`,
      onOk: async () => {
        try {
          if (row.cancel.type === 'advance') await payrollAPI.voidAdvance(row.cancel.id, 'Cancelled from staff statement');
          else await payrollAPI.voidMoney(row.cancel.id, 'Cancelled from staff statement');
          refresh();
        } catch (e) { message.error(e?.response?.data?.message || e?.response?.data?.error || 'Could not cancel'); throw e; }
      },
    });
  };

  const due = person?.due && person.due.amount > 0 && !person.due.hold ? person.due.amount : 0;
  const balNow = st ? -st.balance_now : 0;   // ledger sign: Dr = advance with staff, Cr = payable
  const toEntry = (mode) => staffId && navigate(`/staff-payroll?entry=${mode}&id=${staffId}`);

  return (
    <div className={`psp-page ssp-page${visibleColumns.includes('voucher_no') ? ' has-vno' : ''}`}>
      {modalCtx}
      <div className="psp-header">
        <div className="psp-titles">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={goBack} className="psp-back" />
          <h1 className="psp-title">{TITLE}</h1>
        </div>
        <div className="psp-header-period">
          <div className="rpt-period">
            {presets(fyStart, fyEnd).map((p) => (
              <button key={p.v} className={activePreset === p.v ? 'on' : ''} onClick={() => setPreset(p)}>{p.l}</button>
            ))}
          </div>
          <RangePicker className="rpt-date" value={[from ? dayjs(from) : null, to ? dayjs(to) : null]} format="DD/MM/YYYY" allowClear={false}
            onChange={(r) => { setFrom(r?.[0]?.format('YYYY-MM-DD') || null); setTo(r?.[1]?.format('YYYY-MM-DD') || null); }} />
        </div>
        <div className="psp-actions">
          <Tooltip title="Refresh"><Button className="rpt-btn" icon={<ReloadOutlined />} onClick={refresh} disabled={!staffId} /></Tooltip>
          <Popover content={customizeContent} title="Show columns" trigger="click" placement="bottomRight">
            <Tooltip title="Customize columns"><Button className="rpt-btn" icon={<SettingOutlined />} /></Tooltip>
          </Popover>
          <Tooltip title="Export PDF"><Button className="rpt-btn" icon={<FilePdfOutlined />} onClick={onPdf} disabled={!statement} /></Tooltip>
        </div>
      </div>

      <div className="psp-sticky">
        <div className={`pp-bar${staffId ? ' has-selection' : ''}`}>
          <div className="pp-row">
            <div className="pp-select-wrap">
              <Select ref={selectRef} showSearch allowClear placeholder="Select staff — type to search" value={staffId || undefined}
                onChange={(v) => setStaffId(v || null)} optionFilterProp="label"
                options={people.map((p) => ({ value: p.staff_id, label: titleCase(p.name), p }))}
                dropdownStyle={{ minWidth: 520, padding: 0 }} popupMatchSelectWidth={false}
                popupRender={(menu) => (
                  <div>
                    <div className="pp-opt-head">
                      <span style={{ flex: '0 0 200px' }}>Staff Name</span>
                      <span style={{ flex: '0 0 150px' }}>Designation</span>
                      <span style={{ flex: '0 0 130px', textAlign: 'right' }}>Salary</span>
                    </div>
                    {menu}
                  </div>
                )}
                optionRender={(o) => {
                  const p = o.data.p;
                  return (
                    <div className="pp-opt-row">
                      <span style={{ flex: '0 0 200px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}>{o.data.label}</span>
                      <span style={{ flex: '0 0 150px', color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.designation || '—'}</span>
                      <span style={{ flex: '0 0 130px', textAlign: 'right', fontWeight: 600, paddingRight: 8 }}>
                        {p.amount ? `₹${Number(p.amount).toLocaleString('en-IN')}${p.pay_type === 'daily' ? '/day' : p.pay_type === 'hourly' ? '/hr' : '/mo'}` : '—'}
                      </span>
                    </div>
                  );
                }} />
            </div>
            {staffId && st && (
              <div className="pp-meta">
                {st.staff.designation && <span className="pp-meta-pill">{st.staff.designation}</span>}
                {st.staff.phone && <span className="pp-meta-pill">📞 {st.staff.phone}</span>}
                <span className={`pp-meta-pill pp-meta-bal${balNow >= 0 ? ' pos' : ' neg'}`}>
                  ₹{fmtBal(balNow)} <span className="pp-meta-drcr">{drCr(balNow)}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="psp-vt-chips">
          <button className={`psp-vt-chip${voucherFilter.size === 0 ? ' on' : ''}`} onClick={() => setVoucherFilter(new Set())}>All</button>
          {CATEGORIES.map((c) => (
            <button key={c} className={`psp-vt-chip${voucherFilter.has(c) ? ' on' : ''}`} onClick={() => toggleVoucher(c)}>{c}</button>
          ))}
        </div>
      </div>

      {staffId && st && (
        <div className="psp-print-letter">
          <div className="psp-letter-from"><h2>{window.__APP_COMPANY_NAME__ || 'Statement of Account'}</h2></div>
          <div className="psp-letter-to">
            <div className="psp-letter-to-lbl">Staff:</div>
            <div className="psp-letter-to-name">{name}</div>
            {st.staff.designation && <div>{st.staff.designation}</div>}
            {st.staff.phone && <div>Mobile: {st.staff.phone}</div>}
          </div>
          <div className="psp-letter-period">Period: {from || 'inception'} to {to || 'today'}</div>
        </div>
      )}

      <div className="psp-body">
        <LedgerStatement statement={statement} loading={loading} onRowClick={onRowClick} voucherFilter={voucherFilter}
          columns={visibleColumns} emptyHint="Pick a staff member above to load the statement." />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: goBack },
          { id: 'period', key: 'F2', label: 'Period', onAction: () => openDate({
            mode: 'range', title: 'Period', value: [from ? dayjs(from) : null, to ? dayjs(to) : null],
            onConfirm: ([f, t]) => { setFrom(f.format('YYYY-MM-DD')); setTo(t.format('YYYY-MM-DD')); },
          }) },
          { id: 'give', key: 'F3', label: 'Give Money', disabled: !staffId, onAction: () => toEntry('give') },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: refresh, disabled: !staffId },
          { id: 'print', key: 'F9', label: 'Print', onAction: () => window.print(), disabled: !statement },
          { id: 'export', key: 'F10', label: 'Export', onAction: onExcel, disabled: !statement?.entries?.length },
          { id: 'pay', key: 'F1', label: 'Pay Salary', tone: 'primary', disabled: !due, onAction: () => toEntry('pay') },
        ]}
      />
    </div>
  );
}

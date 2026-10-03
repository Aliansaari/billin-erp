// ── StaffStatementPage ─────────────────────────────────────────────────
//
// Staff Statement, built from the same parts as Customer / Supplier
// Statement (PartyStatementPage): psp-* header with period chips, picker
// bar, type chips, the shared LedgerStatement table, print letterhead,
// PDF / Excel export and the F-key strip. Only the data source differs:
// GET /payroll/people/:id/statement (services/staffStatement.js), which
// reads what the payroll engines recorded and computes nothing new.
//
// Signs follow the books (a staff member is a ledger like any party):
//   Credit  salary earned (payable to the staff member)
//   Debit   salary paid, advances, money given
//   Balance Cr = the shop owes them · Dr = advance with them

import React, { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Modal, Select, Tooltip, message } from 'antd';
import { ArrowLeftOutlined, FilePdfOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { payrollAPI } from '../../../api';
import { useFinancialYear } from '../../../hooks/useFinancialYear';
import { downloadStatementPdf } from '../../../utils/ledgerPdf';
import LedgerStatement from '../../../components/LedgerStatement';
import ActionStrip from '../../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../../components/keyboard/DatePopup';
import '../../../components/ledger-statement.css';
import '../../../components/party-picker.css';
import '../../../components/party-statement-page.css';
import { cap, errText, inr0, ordinal } from './shared';

const { RangePicker } = DatePicker;
const TITLE = 'Staff Statement';
const CATEGORIES = ['Salary', 'Payment', 'Advance'];
const KIND_TO_TYPE = { salary: 'Salary', paid: 'Payment', advance: 'Advance' };

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
      voucher_no: '',
      narration: r.detail ? `${r.text} · ${r.detail}` : r.text,
      debit: r.paid,
      credit: r.earned,
      balance: -r.balance,
      remarks: r.detail || '',
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

const drcr = (v) => (v > 0 ? 'Dr' : 'Cr');
const balWords = (v) => (Math.abs(v) < 0.5 ? 'Settled' : v > 0 ? 'advance with staff' : 'payable to staff');

export default function StaffStatementPage({ staffId, company, onBack, onPick, onPay, onGive }) {
  const [people, setPeople] = useState([]);
  useEffect(() => { payrollAPI.home().then(({ data }) => setPeople(data?.people || [])).catch(() => {}); }, []);
  const { fyStart, fyEnd } = useFinancialYear();
  const [from, setFrom] = useState(fyStart || null);
  const [to, setTo] = useState(fyEnd || null);
  const [st, setSt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [voucherFilter, setVoucherFilter] = useState(() => new Set());
  const [modal, modalCtx] = Modal.useModal();
  const { openDate } = useDatePopup();

  useEffect(() => { if (!from && fyStart) setFrom(fyStart); if (!to && fyEnd) setTo(fyEnd); }, [fyStart, fyEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  const person = people.find((p) => p.staff_id === staffId) || null;

  useEffect(() => {
    if (!staffId) { setSt(null); return undefined; }
    let stale = false;
    setLoading(true);
    payrollAPI.statement(staffId, { from: from || undefined, to: to || undefined })
      .then(({ data }) => { if (!stale) setSt(data); })
      .catch((e) => { if (!stale) { message.error(errText(e, 'Failed to load statement.')); setSt(null); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [staffId, from, to, tick]);

  const statement = useMemo(() => toLedger(st), [st]);

  const activePreset = useMemo(() => {
    const hit = presets(fyStart, fyEnd).find((p) => ((p.from?.format('YYYY-MM-DD') || null) === (from || null))
      && ((p.to?.format('YYYY-MM-DD') || null) === (to || null)));
    return hit?.v || 'custom';
  }, [from, to, fyStart, fyEnd]);
  const setPreset = (p) => { if (p.v === 'custom') return; setFrom(p.from?.format('YYYY-MM-DD') || null); setTo(p.to?.format('YYYY-MM-DD') || null); };

  const toggleVoucher = (cat) => setVoucherFilter((prev) => { const n = new Set(prev); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });

  const refresh = () => setTick((t) => t + 1);
  const subtitle = person ? cap(person.name) : '';
  const onPdf = async () => {
    if (!statement) return;
    try {
      await downloadStatementPdf({ title: TITLE, subtitle, statement, voucherFilter, party: { mobile_1: st?.staff?.phone || null } });
    } catch (e) { console.error(e); message.error('PDF export failed.'); }
  };
  const onExcel = () => {
    if (!statement?.entries?.length) { message.info('Nothing to export.'); return; }
    const rows = [
      [from || '', '', 'Opening Balance', '', '', statement.opening_balance],
      ...statement.entries.map((e) => [e.date, e.voucher_type, e.narration, e.debit || '', e.credit || '', e.balance]),
      ['', '', 'Period Totals', statement.total_debit, statement.total_credit, ''],
      [to || '', '', 'Closing Balance', '', '', statement.closing_balance],
    ];
    downloadExcel({ filename: `staff-statement-${(person?.name || 'staff').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`,
      rows, headers: ['Date', 'Type', 'Particulars', 'Debit', 'Credit', 'Balance'] });
  };

  // Clicking a fresh advance / money given that nothing has taken back yet
  // offers to cancel it (reverses the cash or bank entry).
  const onRow = (row) => {
    if (!row.cancel) return;
    modal.confirm({
      rootClassName: 'ar-pop', title: `Cancel this ${inr0(row.amount)}?`, okText: 'Cancel it', cancelText: 'Keep', okButtonProps: { danger: true },
      content: `${row.narration} on ${dayjs(row.date).format('DD-MM-YYYY')}. It comes off the statement and the cash or bank entry is reversed.`,
      onOk: async () => {
        try {
          if (row.cancel.type === 'advance') await payrollAPI.voidAdvance(row.cancel.id, 'Cancelled from staff statement');
          else await payrollAPI.voidMoney(row.cancel.id, 'Cancelled from staff statement');
          refresh();
        } catch (e) { message.error(errText(e, 'Could not cancel')); throw e; }
      },
    });
  };

  const due = person?.due && person.due.amount > 0 && !person.due.hold ? person.due.amount : 0;
  const nowBal = st ? -st.balance_now : 0;           // ledger sign: Dr = advance, Cr = payable
  const options = people.map((p) => ({ value: p.staff_id, label: cap(p.name), p }));

  return (
    <div className="psp-page">
      {modalCtx}
      <div className="psp-header">
        <div className="psp-titles">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} className="psp-back" />
          <h1 className="psp-title">{TITLE}</h1>
        </div>
        <div className="psp-header-period">
          <div className="rpt-period">
            {presets(fyStart, fyEnd).map((p) => (
              <button key={p.v} type="button" className={activePreset === p.v ? 'on' : ''} onClick={() => setPreset(p)}>{p.l}</button>
            ))}
          </div>
          <RangePicker className="rpt-date" value={[from ? dayjs(from) : null, to ? dayjs(to) : null]} format="DD/MM/YYYY" allowClear={false}
            onChange={(r) => { setFrom(r?.[0]?.format('YYYY-MM-DD') || null); setTo(r?.[1]?.format('YYYY-MM-DD') || null); }} />
        </div>
        <div className="psp-actions">
          <Tooltip title="Refresh"><Button className="rpt-btn" icon={<ReloadOutlined />} onClick={refresh} disabled={!staffId} /></Tooltip>
          <Tooltip title="Export PDF"><Button className="rpt-btn" icon={<FilePdfOutlined />} onClick={onPdf} disabled={!statement} /></Tooltip>
        </div>
      </div>

      <div className="psp-sticky">
        <div className={`pp-bar${person ? ' has-selection' : ''}`}>
          <div className="pp-row">
            <div className="pp-select-wrap">
              <Select showSearch value={staffId || undefined} placeholder="Select staff — type to search" optionFilterProp="label"
                options={options} onChange={onPick} popupClassName="ar-pop"
                optionRender={(o) => (
                  <div className="pp-opt-row">
                    <span style={{ flex: '1 1 auto', fontWeight: 600 }}>{o.data.label}</span>
                    <span style={{ flex: '0 0 140px', color: 'var(--fg-tertiary)' }}>{o.data.p.designation || 'Staff'}</span>
                  </div>
                )} />
            </div>
            {person && (
              <div className="pp-meta">
                {person.designation && <span className="pp-meta-pill">{person.designation}</span>}
                {person.amount > 0 && <span className="pp-meta-pill">{inr0(person.amount)} {person.pay_type === 'daily' ? 'a day' : person.pay_type === 'hourly' ? 'an hour' : 'a month'} · {person.mode === 'settle' ? `paid on the ${ordinal(person.cycle_day)}` : 'monthly'}</span>}
                {st?.staff?.phone && <span className="pp-meta-pill">📞 {st.staff.phone}</span>}
                {st && (
                  <span className={`pp-meta-pill pp-meta-bal${nowBal > 0 ? ' neg' : ' pos'}`} title="Balance today, all entries">
                    ₹{Math.abs(nowBal).toLocaleString('en-IN', { minimumFractionDigits: 2 })} <span className="pp-meta-drcr">{Math.abs(nowBal) < 0.005 ? '' : drcr(nowBal)}</span> · {balWords(nowBal)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="psp-vt-chips">
          <button type="button" className={`psp-vt-chip${voucherFilter.size === 0 ? ' on' : ''}`} onClick={() => setVoucherFilter(new Set())}>All</button>
          {CATEGORIES.map((c) => (
            <button key={c} type="button" className={`psp-vt-chip${voucherFilter.has(c) ? ' on' : ''}`} onClick={() => toggleVoucher(c)}>{c}</button>
          ))}
          {person?.so_far && <span className="ss2-sofar">Earned so far this cycle (not yet due): <b>{inr0(person.so_far.earned)}</b></span>}
        </div>
      </div>

      {person && (
        <div className="psp-print-letter">
          <div className="psp-letter-from"><h2>{company?.company_name || window.__APP_COMPANY_NAME__ || TITLE}</h2></div>
          <div className="psp-letter-to">
            <div className="psp-letter-to-lbl">Staff:</div>
            <div className="psp-letter-to-name">{cap(person.name)}</div>
            {person.designation && <div>{person.designation}</div>}
            {st?.staff?.phone && <div>Phone: {st.staff.phone}</div>}
          </div>
          <div className="psp-letter-period">Period: {from || 'inception'} to {to || 'today'}</div>
        </div>
      )}

      <div className="psp-body">
        <LedgerStatement statement={statement} loading={loading} voucherFilter={voucherFilter} onRowClick={onRow}
          columns={['date', 'voucher_type', 'particulars', 'debit', 'credit', 'balance']}
          emptyHint="Pick a staff member above to load the statement." />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: onBack },
          { id: 'period', key: 'F2', label: 'Period', onAction: () => openDate({
            mode: 'range', title: 'Period', value: [from ? dayjs(from) : null, to ? dayjs(to) : null],
            onConfirm: ([f, t]) => { setFrom(f.format('YYYY-MM-DD')); setTo(t.format('YYYY-MM-DD')); },
          }) },
          { id: 'give', key: 'F3', label: 'Give money', disabled: !person, onAction: () => person && onGive(person.staff_id) },
          { id: 'refresh', key: 'F5', label: 'Refresh', disabled: !staffId, onAction: refresh },
          { id: 'print', key: 'F9', label: 'Print', disabled: !statement, onAction: () => window.print() },
          { id: 'export', key: 'F10', label: 'Export', disabled: !statement?.entries?.length, onAction: onExcel },
          { id: 'pay', key: 'F1', label: due ? `Pay ${inr0(due)}` : 'Pay', tone: 'primary', disabled: !due, onAction: () => person && onPay(person.staff_id) },
        ]}
      />
    </div>
  );
}

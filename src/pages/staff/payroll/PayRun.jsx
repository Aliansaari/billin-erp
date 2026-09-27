import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DatePicker, Dropdown, Modal, message, Alert, Tooltip } from 'antd';
import {
  LeftOutlined, RightOutlined, DownOutlined, CheckOutlined, LockOutlined, WalletOutlined, PrinterOutlined,
  MoreOutlined, UnlockOutlined, DownloadOutlined, EyeOutlined, PauseCircleOutlined, TeamOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StaffAvatar from '../StaffAvatar';
import { payrollAPI } from '../../../api';
import PayslipDrawer from './PayslipDrawer';
import PayDialog from './PayDialog';
import { printPayslips } from './printPayslip';
import { inr0, monthLabel, cap, initials, errText, lineStatus, PAY_TYPES } from './shared';

export default function PayRun({ period, setPeriod, staff, company, onGoTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);          // staff_id of the payslip drawer
  const [paying, setPaying] = useState(null);      // [lines] for the pay dialog
  const [busy, setBusy] = useState(false);
  const photos = useMemo(() => new Map((staff || []).map((s) => [s.staff_id, s.photo_thumb])), [staff]);
  const photoOf = (id) => photos.get(id) || null;
  const [modal, modalCtx] = Modal.useModal();

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data: d } = await payrollAPI.getRun(period); setData(d); }
    catch (e) { message.error(errText(e, 'Could not load the month')); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { load(); }, [load]);

  const final = data?.status === 'finalized';
  const lines = useMemo(() => [...(data?.lines || [])].sort((a, b) => a.slip.staff.name.localeCompare(b.slip.staff.name)), [data]);
  const dueLines = lines.filter((l) => final && !l.hold && l.due > 0);
  // Review → Finalize → Pay. Finalizing completes the first two; paying everyone completes the third.
  const step = !final ? 1 : dueLines.length ? 3 : 4;
  const isFuture = dayjs(`${period}-01`).isAfter(dayjs(), 'month');
  const current = dayjs(`${period}-01`).isSame(dayjs(), 'month');

  const finalize = () => modal.confirm({
    rootClassName: 'ar-pop',
    title: `Finalize ${monthLabel(period)}?`,
    icon: <LockOutlined />,
    width: 480,
    content: (
      <div className="pr-confirm">
        <p>This locks every payslip for the month at <b>{inr0(data.totals.net)}</b> net pay for {data.totals.staff} staff.</p>
        <ul>
          {data.settings.post_to_accounts && <li>Salary is booked in your accounts (Salaries & Wages, Salary Payable{data.totals.deductions ? ', deductions' : ''}).</li>}
          <li>Later changes to attendance or salaries will not change this month.</li>
          <li>You can reopen it until any salary is paid.</li>
        </ul>
        {current && !data.month_complete && <p className="pr-warn">{monthLabel(period)} is not over yet. Days still to come are counted as worked.</p>}
      </div>
    ),
    okText: 'Finalize month',
    onOk: async () => {
      try { const { data: d } = await payrollAPI.finalize(period); setData(d); message.success(`${monthLabel(period)} finalized.`); }
      catch (e) { message.error(errText(e, 'Could not finalize')); throw e; }
    },
  });
  const reopen = () => modal.confirm({
    rootClassName: 'ar-pop', title: `Reopen ${monthLabel(period)}?`, icon: <UnlockOutlined />,
    content: 'Payslips go back to draft and are worked out again from today’s attendance and salaries. The accounting entry is reversed.',
    okText: 'Reopen',
    onOk: async () => {
      try { const { data: d } = await payrollAPI.reopen(period); setData(d); message.success('Month reopened.'); }
      catch (e) { message.error(errText(e, 'Could not reopen')); throw e; }
    },
  });
  const toggleHold = async (l) => {
    setBusy(true);
    try { const { data: d } = await payrollAPI.saveLine(period, l.staff_id, { adjustments: l.adjustments, recoveries: l.recoveries, hold: !l.hold }); setData(d); }
    catch (e) { message.error(errText(e, 'Could not update')); } finally { setBusy(false); }
  };
  const exportBank = () => {
    const rows = [['Name', 'Account holder', 'Account number', 'IFSC', 'Bank', 'Amount', 'Reference']];
    for (const l of dueLines) {
      const b = l.slip.bank || {};
      rows.push([l.slip.staff.name, b.holder || l.slip.staff.name, b.account || '', b.ifsc || '', b.bank || '', l.due.toFixed(2), `Salary ${period}`]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' }));
    a.download = `salary-transfer-${period}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const t = data?.totals || {};
  const cut = (s) => s.attendance.lop_days || 0;
  const daysCell = (s) => {
    if (s.pay_type === 'hourly') return <><b>{s.attendance.paid_hours} h</b><div className="ar-cellsub">{s.attendance.worked_hours} h on the clock</div></>;
    if (s.pay_type === 'daily') return <><b>{s.attendance.paid_days} days</b><div className="ar-cellsub">at {inr0(s.rate)} a day</div></>;
    return <><b>{s.attendance.paid_days}</b><span className="pr-of"> / {s.basis_days}</span>
      {cut(s) > 0 ? <div className="ar-cellsub tx-late">{cut(s)} day{cut(s) === 1 ? '' : 's'} cut</div>
        : s.staff.joined_on?.startsWith(period) ? <div className="ar-cellsub">Joined {dayjs(s.staff.joined_on).format('D MMM')}</div>
          : s.staff.left_on?.startsWith(period) ? <div className="ar-cellsub">Left {dayjs(s.staff.left_on).format('D MMM')}</div>
            : <div className="ar-cellsub">{s.tracked ? 'Full month' : 'Not tracked'}</div>}</>;
  };
  const rowMenu = (l) => ({ items: [
    { key: 'view', icon: <EyeOutlined />, label: 'View payslip', onClick: () => setOpen(l.staff_id) },
    final && l.due > 0 && !l.hold && { key: 'pay', icon: <WalletOutlined />, label: 'Pay', onClick: () => setPaying([l]) },
    final && { key: 'print', icon: <PrinterOutlined />, label: 'Print payslip', onClick: () => printPayslips([l], company, period) },
    !final && { key: 'hold', icon: <PauseCircleOutlined />, label: l.hold ? 'Release hold' : 'Hold this salary', onClick: () => toggleHold(l) },
  ].filter(Boolean) });
  const moreMenu = { items: [
    final && { key: 'print', icon: <PrinterOutlined />, label: 'Print all payslips', onClick: () => printPayslips(lines, company, period) },
    final && dueLines.length > 0 && { key: 'csv', icon: <DownloadOutlined />, label: 'Bank transfer sheet (CSV)', onClick: exportBank },
    final && { type: 'divider' },
    final && { key: 'reopen', icon: <UnlockOutlined />, label: 'Reopen month', onClick: reopen },
    !final && { key: 'none', disabled: true, label: 'Finalize the month to print or pay' },
  ].filter(Boolean) };

  return (
    <>
      {modalCtx}
      <div className="pr-toolbar">
        <div className="ar-datenav">
          <button type="button" className="ar-dn-btn" onClick={() => setPeriod(dayjs(`${period}-01`).subtract(1, 'month').format('YYYY-MM'))} aria-label="Previous month"><LeftOutlined /></button>
          <DatePicker picker="month" value={dayjs(`${period}-01`)} onChange={(d) => d && setPeriod(d.format('YYYY-MM'))} allowClear={false} inputReadOnly
            format="MMMM YYYY" variant="borderless" suffixIcon={<DownOutlined />} className="ar-datepick" disabledDate={(d) => d.isAfter(dayjs(), 'month')} />
          <button type="button" className="ar-dn-btn" onClick={() => setPeriod(dayjs(`${period}-01`).add(1, 'month').format('YYYY-MM'))} disabled={current || isFuture} aria-label="Next month"><RightOutlined /></button>
        </div>
        <ol className="pr-steps">
          {[['Review', 'Check pay, add bonus or deductions'], ['Finalize', 'Lock the month'], ['Pay', 'Record salary paid']].map(([k, sub], i) => (
            <li key={k} className={step > i + 1 ? 'is-done' : step === i + 1 ? 'is-now' : ''}>
              <span className="n">{step > i + 1 ? <CheckOutlined /> : i + 1}</span><div><b>{k}</b><small>{sub}</small></div>
            </li>
          ))}
        </ol>
        <div className="plv-actions">
          {!final && <button type="button" className="plv-btn primary" disabled={!lines.length || loading} onClick={finalize}><LockOutlined /> Finalize month</button>}
          {final && dueLines.length > 0 && <button type="button" className="plv-btn primary" onClick={() => setPaying(dueLines)}><WalletOutlined /> Pay salaries</button>}
          {final && !dueLines.length && lines.length > 0 && <span className="pr-allpaid"><CheckOutlined /> All paid</span>}
          <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight" overlayClassName="ar-menu">
            <button type="button" className="plv-iconbtn square" aria-label="More"><MoreOutlined /></button>
          </Dropdown>
        </div>
      </div>

      {data?.missing?.length > 0 && !final && (
        <Alert className="ar-alert" type="warning" showIcon
          message={`${data.missing.length} staff ${data.missing.length === 1 ? 'has' : 'have'} no salary set, so ${data.missing.length === 1 ? 'is' : 'are'} not in this month`}
          description={data.missing.map((m) => cap(m.name)).join(', ')}
          action={<button type="button" className="plv-btn" onClick={() => onGoTab('salaries')}>Set salaries</button>} />
      )}

      {data?.settle_staff?.length > 0 && (
        <p className="pr-settlenote">{data.settle_staff.map((x) => cap(x.name)).join(', ')} {data.settle_staff.length === 1 ? 'is' : 'are'} paid on their own cycle in{' '}
          <button type="button" className="ar-link" onClick={() => onGoTab('accounts')}>Staff accounts</button>, so not in this pay run.</p>
      )}

      <section className="ar-cards">
        <div className="plv-age-card ar-card is-static tone-ok"><div className="k">Net pay</div><div className="v">{inr0(t.net)}</div><div className="sub">{t.staff || 0} staff · {monthLabel(period)}</div></div>
        <div className="plv-age-card ar-card is-static"><div className="k">Gross pay</div><div className="v">{inr0(t.gross)}</div><div className="sub">Before deductions</div></div>
        <div className="plv-age-card ar-card is-static tone-late"><div className="k">Deductions</div><div className="v">{inr0(t.deductions)}</div><div className="sub">PF, ESI, tax, advances, other</div></div>
        {t.employer_cost > t.gross && <div className="plv-age-card ar-card is-static"><div className="k">Cost to company</div><div className="v">{inr0(t.employer_cost)}</div><div className="sub">Gross + employer PF/ESI</div></div>}
        <div className={`plv-age-card ar-card is-static ${final ? (t.due > 0 ? 'tone-leave' : 'tone-ok') : ''}`}>
          <div className="k">{final ? 'Still to pay' : 'Paid'}</div><div className="v">{final ? inr0(t.due) : '—'}</div>
          <div className="sub">{final ? `${inr0(t.paid)} paid so far` : 'Finalize to start paying'}</div>
          {final && t.net > 0 && <div className="bar"><div className="fill" style={{ width: `${Math.min(100, (t.paid / t.net) * 100)}%` }} /></div>}
        </div>
      </section>

      <section className="plv-table-card ar-tablecard">
        <div className="ar-tbar">
          <div className="ar-tbar-l"><b>{monthLabel(period)}</b><span className={`plv-status-tag ar-tag tone-${final ? 'ok' : 'idle'}`}>{final ? 'Finalized' : 'Draft'}</span>
            {final && data.finalized_at && <span className="pr-muted">on {dayjs(data.finalized_at).format('D MMM, h:mm A')}</span>}</div>
          {!final && lines.length > 0 && <span className="pr-muted">Figures update live from attendance until you finalize.</span>}
        </div>
        <div className="plv-table-scroll">
          <table className="plv-table ar-table pr-table">
            <colgroup><col className="c-staff" /><col className="c-days" /><col className="c-amt" /><col className="c-amt" /><col className="c-net" /><col className="c-amt" /><col className="c-st" /><col className="c-act" /></colgroup>
            <thead><tr><th>Staff</th><th>Paid days</th><th className="r">Gross</th><th className="r">Deductions</th><th className="r">Net pay</th><th className="r">Paid</th><th>Status</th><th /></tr></thead>
            <tbody>
              {loading && !data ? <tr><td colSpan={8}><div className="plv-empty">Loading…</div></td></tr> : !lines.length ? (
                <tr><td colSpan={8}><div className="plv-empty ar-empty"><TeamOutlined className="icon" /><div>Nobody to pay for {monthLabel(period)}</div>
                  <div className="sub"><button type="button" className="ar-link" onClick={() => onGoTab('salaries')}>Set salaries</button> for your staff to start.</div></div></td></tr>
              ) : lines.map((l) => {
                const s = l.slip; const st = lineStatus(l, data.status);
                return (
                  <tr key={l.staff_id} className={`row${l.hold ? ' is-hold' : ''}`} onClick={() => setOpen(l.staff_id)}>
                    <td><div className="plv-party-inline"><StaffAvatar name={s.staff.name} photo={photoOf(l.staff_id)} />
                      <div className="plv-party-nm"><div className="main"><span className="txt">{cap(s.staff.name)}</span></div>
                        <div className="sub">{[s.staff.designation, PAY_TYPES[s.pay_type]?.label].filter(Boolean).join(' · ')}</div></div></div></td>
                    <td className="ar-num">{daysCell(s)}</td>
                    <td className="r ar-num">{inr0(s.gross)}</td>
                    <td className="r ar-num">{s.total_deductions ? <span className="tx-late">−{inr0(s.total_deductions)}</span> : <span className="ar-dash">—</span>}</td>
                    <td className="r ar-num pr-net">{inr0(s.net)}{s.warnings?.length > 0 && <Tooltip title={s.warnings.join(' ')}><span className="pr-warnDot" /></Tooltip>}</td>
                    <td className="r ar-num">{final ? (l.paid ? inr0(l.paid) : <span className="ar-dash">—</span>) : <span className="ar-dash">—</span>}</td>
                    <td><span className={`plv-status-tag ar-tag tone-${st.tone}`}>{st.label}</span></td>
                    <td className="ar-actcell" onClick={(e) => e.stopPropagation()}>
                      <Dropdown menu={rowMenu(l)} trigger={['click']} placement="bottomRight" overlayClassName="ar-menu" disabled={busy}>
                        <button type="button" className="ar-more" aria-label="More"><MoreOutlined /></button>
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {lines.length > 1 && (
              <tfoot><tr><td>Total · {lines.length} staff</td><td /><td className="r">{inr0(t.gross)}</td><td className="r">{t.deductions ? `−${inr0(t.deductions)}` : '—'}</td>
                <td className="r pr-net">{inr0(t.net)}</td><td className="r">{final ? inr0(t.paid) : '—'}</td><td colSpan={2} /></tr></tfoot>
            )}
          </table>
        </div>
      </section>

      <PayslipDrawer
        open={open != null} line={lines.find((l) => l.staff_id === open)} lines={lines} period={period} status={data?.status} company={company}
        photo={photoOf(open)} onClose={() => setOpen(null)} onNavigate={setOpen} onData={setData} onPay={(l) => setPaying([l])} reload={load}
      />
      <PayDialog photoOf={photoOf} open={!!paying} lines={paying || []} period={period} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />
    </>
  );
}

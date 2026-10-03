import React, { useCallback, useEffect, useState } from 'react';
import { message, Dropdown, Tooltip } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { payrollAPI, staffAttendanceAPI, settingsAPI } from '../../../api';
import PayrollHome, { MORE_VIEWS, RULES_ICON, MORE_ICON } from './PayrollHome';
import PayRun from './PayRun';
import Salaries, { SalaryDrawer } from './Salaries';
import Advances from './Advances';
import Accounts from './Accounts';
import Rules from './Rules';
import StaffStatementPage from './StaffStatementPage';
import { errText } from './shared';
import '../../parties/party-list-view.css';
import '../attendance-register.css';
import './payroll.css';
import './payroll-home.css';

/*
 * Payroll. The home screen (PayrollHome) is where an owner lives: who is
 * owed what, pay, give money, set salaries. Everything detailed (month
 * payslips and PF/ESI, salary breakups, statements, rules) is one click
 * away under "More" and the gear, not in the owner's way.
 */
const VIEWS = { month: 'Month details', salaries: 'Salaries', accounts: 'Settle a date range', advances: 'Advances', rules: 'Payroll rules' };

export default function Payroll() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS[params.get('view')] || params.get('view') === 'statement' ? params.get('view') : 'home';
  const statementId = Number(params.get('id')) || null;
  // setView('statement', staffId) opens a person's statement; other views take no id.
  const setView = (v, id) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'home') n.delete('view'); else n.set('view', v); n.delete('tab');
    if (v === 'statement' && id) n.set('id', String(id)); else n.delete('id'); return n; });
  // Pay / Give pressed on a statement: back to the home with that person in the entry line.
  const [entryReq, setEntryReq] = useState(null);
  const [period, setPeriod] = useState(() => (dayjs().date() >= 25 ? dayjs() : dayjs().subtract(1, 'month')).format('YYYY-MM'));
  const [staff, setStaff] = useState([]);
  const [structures, setStructures] = useState({});
  const [settings, setSettings] = useState(null);
  const [meta, setMeta] = useState({ pt_presets: {}, standard_components: [] });
  const [company, setCompany] = useState({});
  const [salaryFor, setSalaryFor] = useState(null);
  const [homeKey, setHomeKey] = useState(0);

  const loadBase = useCallback(async () => {
    try {
      const [st, sr, se] = await Promise.all([staffAttendanceAPI.listStaff(), payrollAPI.structures(), payrollAPI.getSettings()]);
      setStaff(st.data || []); setStructures(sr.data || {}); setSettings(se.data.settings);
      setMeta({ pt_presets: se.data.pt_presets, standard_components: se.data.standard_components });
    } catch (e) { message.error(errText(e, 'Could not load payroll')); }
  }, []);
  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { settingsAPI.getSystem().then(({ data }) => setCompany(data?.data || data || {})).catch(() => {}); }, []);

    const person = salaryFor ? (() => { const s = staff.find((x) => x.staff_id === salaryFor); return s ? { ...s, hist: structures[s.staff_id] || [] } : null; })() : null;

  const menus = (
    <>
      <Tooltip title="Payroll rules: working days, holidays, overtime, PF / ESI / PT, accounts">
        <button type="button" className={`plv-iconbtn square${view === 'rules' ? ' is-on' : ''}`} onClick={() => setView(view === 'rules' ? 'home' : 'rules')} aria-label="Payroll rules">{RULES_ICON}</button>
      </Tooltip>
      <Dropdown trigger={['click']} placement="bottomRight" overlayClassName="ar-menu"
        menu={{ items: MORE_VIEWS.map(([k, label, icon]) => ({ key: k, label, icon, onClick: () => setView(k) })) }}>
        <button type="button" className="plv-iconbtn square" aria-label="More payroll screens">{MORE_ICON}</button>
      </Dropdown>
    </>
  );
  const drawer = (
    <SalaryDrawer person={person} settings={settings} meta={meta} onClose={() => setSalaryFor(null)}
      onSaved={async () => { setSalaryFor(null); await loadBase(); setHomeKey((k) => k + 1); }} onGoTab={setView} />
  );

  if (view === 'statement') {
    return (
      <StaffStatementPage staffId={statementId} company={company} onBack={() => setView('home')}
          onPick={(id) => setView('statement', id)}
          onPay={(id) => { setEntryReq({ id, mode: 'pay' }); setView('home'); }}
          onGive={(id) => { setEntryReq({ id, mode: 'give' }); setView('home'); }} />
    );
  }

  // The home is a ZEHEN list page of its own (header, cards, table, F-key strip).
  if (view === 'home') {
    return (
      <div className="plv-page ar pr pr-home">
        <PayrollHome key={homeKey} entryReq={entryReq} onEntryReqDone={() => setEntryReq(null)} reloadBase={loadBase} onOpenView={setView} onEditSalary={setSalaryFor}
          overlayOpen={!!salaryFor} menus={menus} notPosted={settings && !settings.post_to_accounts} />
        {drawer}
      </div>
    );
  }

  return (
    <div className="ar pr">
      <header className="plv-hdr ar-hdr pr-hdr">
        <div className="plv-title">
          <h1 className="pr-back"><button type="button" onClick={() => setView('home')} aria-label="Back to payroll"><ArrowLeftOutlined /></button>{VIEWS[view]}</h1>
          <div className="sub"><button type="button" className="ar-link" onClick={() => setView('home')}>Back to payroll</button></div>
        </div>
        <div className="plv-actions">{menus}</div>
      </header>
      <div className="ar-body pr-body">
        {view === 'month' && <PayRun period={period} setPeriod={setPeriod} staff={staff} company={company} onGoTab={(t) => setView(t === 'salaries' ? 'salaries' : t)} />}
        {view === 'accounts' && <Accounts staff={staff} onGoTab={setView} />}
        {view === 'salaries' && <Salaries staff={staff} structures={structures} settings={settings} meta={meta} reload={loadBase} onGoTab={setView} />}
        {view === 'advances' && <Advances staff={staff} />}
        {view === 'rules' && settings && <Rules settings={settings} meta={meta} onSaved={(s) => setSettings(s)} />}
      </div>
      {drawer}
    </div>
  );
}

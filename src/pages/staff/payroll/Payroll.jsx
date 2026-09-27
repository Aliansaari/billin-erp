import React, { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { payrollAPI, staffAttendanceAPI, settingsAPI } from '../../../api';
import PayRun from './PayRun';
import Salaries from './Salaries';
import Advances from './Advances';
import Accounts from './Accounts';
import Rules from './Rules';
import { errText } from './shared';
import '../../parties/party-list-view.css';
import '../attendance-register.css';
import './payroll.css';

/*
 * Payroll — one page, five tabs, in the order an owner meets them:
 *   Pay run   the month: review → finalize → pay (where they live every month)
 *   Salaries  who earns what, from when (set once, changed on a raise)
 *   Staff accounts  own-cycle staff: give money any day, settle any dates
 *   Advances  money given ahead of salary, recovered from pay
 *   Rules     how a day's pay is worked out, statutory, accounts
 * A two-person shop only ever needs Salaries once and Pay run monthly; the
 * corporate switches all live in Rules and in each salary's "breakup".
 */
const TABS = [['run', 'Pay run'], ['accounts', 'Staff accounts'], ['salaries', 'Salaries'], ['advances', 'Advances'], ['rules', 'Rules']];

export default function Payroll() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'run';
  const setTab = (k) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', k); return n; }, { replace: true });
  // Default to last month once the month is nearly over, else this month.
  const [period, setPeriod] = useState(() => (dayjs().date() >= 25 ? dayjs() : dayjs().subtract(1, 'month')).format('YYYY-MM'));
  const [staff, setStaff] = useState([]);
  const [structures, setStructures] = useState({});
  const [settings, setSettings] = useState(null);
  const [meta, setMeta] = useState({ pt_presets: {}, standard_components: [] });
  const [company, setCompany] = useState({});

  const loadBase = useCallback(async () => {
    try {
      const [st, sr, se] = await Promise.all([staffAttendanceAPI.listStaff(), payrollAPI.structures(), payrollAPI.getSettings()]);
      setStaff(st.data || []); setStructures(sr.data || {}); setSettings(se.data.settings);
      setMeta({ pt_presets: se.data.pt_presets, standard_components: se.data.standard_components });
    } catch (e) { message.error(errText(e, 'Could not load payroll')); }
  }, []);
  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { settingsAPI.getSystem().then(({ data }) => setCompany(data?.data || data || {})).catch(() => {}); }, []);

  const withSalary = staff.filter((s) => s.is_active && structures[s.staff_id]?.length).length;
  const active = staff.filter((s) => s.is_active).length;

  return (
    <div className="ar pr">
      <header className="plv-hdr ar-hdr pr-hdr">
        <div className="plv-title">
          <h1>Payroll</h1>
          <div className="sub">
            {active ? <><b>{withSalary}</b> of {active} staff have a salary set</> : 'Add your staff in Staff & Rules first'}
            {settings && <> · {settings.post_to_accounts ? 'Posts to your accounts' : 'Not posted to accounts'}</>}
          </div>
        </div>
      </header>
      <nav className="pr-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      <div className="ar-body pr-body">
        {tab === 'run' && <PayRun period={period} setPeriod={setPeriod} staff={staff} company={company} onGoTab={setTab} />}
        {tab === 'accounts' && <Accounts staff={staff} onGoTab={setTab} />}
        {tab === 'salaries' && <Salaries staff={staff} structures={structures} settings={settings} meta={meta} reload={loadBase} onGoTab={setTab} />}
        {tab === 'advances' && <Advances staff={staff} />}
        {tab === 'rules' && settings && <Rules settings={settings} meta={meta} onSaved={(s) => setSettings(s)} />}
      </div>
    </div>
  );
}

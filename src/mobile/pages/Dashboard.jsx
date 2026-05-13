import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import useAuthStore from '../../store/authStore';
import ActivityRow from '../components/ActivityRow';
import {
  formatINR,
  formatGreetingDate,
  greetingPrefix,
  isoDate,
} from '../utils/format';
import './Dashboard.css';

// SVG icons — kept inline to avoid an icon-lib dep and to match the
// editorial stroke weight.
const I = {
  bell: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
  ),
  invoice: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
  ),
  receive: (
    /* Down-arrow into a tray — "money in / receipt". */
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
  ),
  send: (
    /* Up-arrow out of a tray — "money out / payment". */
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21V9M7 14l5-5 5 5"/><path d="M5 3h14"/></svg>
  ),
  cart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
  ),
  userPlus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
  ),
  truck: (
    /* Supplier — a small delivery truck. */
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
  ),
  clock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
  ),
  cal: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/></svg>
  ),
  box: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>
  ),
  chev: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  ),
  chevTiny: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  ),
};

// Tiny utility: GSTR-1 is filed by the 11th of the following month for the
// previous month's outward supplies. Returns { dueDate, daysLeft } so the
// attention card can show "11 May · 2 days remaining".
function gstr1Due(now = new Date()) {
  // Filing month = current month if today <= 11th; else next month.
  const due = new Date(now);
  due.setHours(0, 0, 0, 0);
  if (due.getDate() > 11) due.setMonth(due.getMonth() + 1);
  due.setDate(11);
  const days = Math.max(0, Math.ceil((due - new Date(now.toDateString())) / (1000 * 60 * 60 * 24)));
  return { due, days };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { setPanelOpen } = useOutletContext();
  const user = useAuthStore((s) => s.user);

  const [stats, setStats]       = useState(null);
  const [insights, setInsights] = useState(null);
  const [today, setToday]       = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    let cancelled = false;
    const todayIso = isoDate();
    Promise.allSettled([
      reportAPI.getDashboard(),
      reportAPI.getDashboardInsights(),
      reportAPI.dayBook({ from_date: todayIso, to_date: todayIso }),
    ])
      .then(([s, ins, db]) => {
        if (cancelled) return;
        if (s.status === 'fulfilled')   setStats(s.value.data);
        if (ins.status === 'fulfilled') setInsights(ins.value.data);
        if (db.status === 'fulfilled')  setToday((db.value.data?.data || []).slice(0, 6));
      })
      .catch(() => {
        if (!cancelled) Toast.show({ icon: 'fail', content: 'Failed to load dashboard' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Header context ────────────────────────────────────────────────
  // The greeting name + avatar reflect the active COMPANY (not the user)
  // so when an owner switches firms the brand they're operating under is
  // front-and-centre. Login persists the picked company's name when the
  // session starts; if it's missing (e.g. activation flow before that
  // store key existed) we fall back to the user's name so the screen
  // never reads "Hello, undefined".
  const companyName = (() => {
    try {
      const stored = localStorage.getItem('billing_erp_last_company_name');
      if (stored) return stored;
    } catch {}
    return user?.company_name || (user?.full_name || user?.username || 'there').split(' ')[0];
  })();
  const initial = (companyName || '?').trim().charAt(0).toUpperCase();
  const greetingDate = formatGreetingDate(new Date(), user?.company_city || '');
  const greeting = greetingPrefix();

  // ── Hero metrics ──────────────────────────────────────────────────
  const todaySales       = stats?.today_sales?.total ?? 0;
  const todaySalesCount  = stats?.today_sales?.count ?? 0;
  const yesterdaySales   = stats?.prior?.today_sales?.total ?? 0;
  const deltaPct = useMemo(() => {
    if (!yesterdaySales) return null;
    return ((todaySales - yesterdaySales) / yesterdaySales) * 100;
  }, [todaySales, yesterdaySales]);

  const receiptsTotal    = stats?.today_receipts?.total ?? 0;
  const receiptsCount    = stats?.today_receipts?.count ?? 0;
  const receivablesTotal = stats?.receivables?.total ?? 0;
  const receivablesCount = stats?.receivables?.count ?? 0;

  // ── Attention queue (3 items max) ─────────────────────────────────
  const overdueRow = useMemo(() => {
    const list = insights?.overdue_receivables || [];
    if (list.length === 0) return null;
    const total = list.reduce((s, r) => s + Number(r.balance || 0), 0);
    const top = list.slice(0, 2).map((r) => r.party_name).join(' · ');
    const more = list.length > 2 ? ` · +${list.length - 2}` : '';
    return {
      title: `${list.length} invoice${list.length === 1 ? '' : 's'} overdue`,
      sub:   `${top}${more}`,
      total,
    };
  }, [insights]);

  const gstr1 = useMemo(() => gstr1Due(), []);

  const lowStock = useMemo(() => {
    const count = stats?.low_stock_count ?? 0;
    if (!count) return null;
    return {
      title: `${count} item${count === 1 ? '' : 's'} below reorder level`,
      sub:   'Stock · review purchase plan',
    };
  }, [stats]);

  // ── Handlers ──────────────────────────────────────────────────────
  const goVouchers = (type) => navigate(`/vouchers?type=${type}`);
  const openBillDetail = (entry) => {
    const r = String(entry.drill_route || '');
    const idMatch = r.match(/\/(\d+)\s*$/);
    const typeMap = { Sales: 'sales', Purchase: 'purchase', Receipt: 'receipt', Payment: 'payment' };
    const vType = typeMap[entry.voucher_type];
    if (vType && idMatch) { navigate(`/vouchers/${vType}/${idMatch[1]}`); return; }
    if (vType && entry.voucher_no) { navigate(`/vouchers/${vType}/search?no=${encodeURIComponent(entry.voucher_no)}`); return; }
    navigate(`/day-book?date=${entry?.entry_date || isoDate()}`);
  };

  // ── Notifications (built from attention items) ─────────────────────
  const notifications = useMemo(() => {
    const items = [];
    if (overdueRow) items.push({ key: 'overdue', type: 'danger', icon: I.clock, ...overdueRow, action: () => goVouchers('sales') });
    if (gstr1.days <= 7) items.push({ key: 'gstr1', type: 'info', icon: I.cal, title: 'GSTR-1 filing due', sub: `${gstr1.due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${gstr1.days} day${gstr1.days === 1 ? '' : 's'} remaining`, action: () => Toast.show({ content: 'GSTR-1 filing — open on desktop' }) });
    if (lowStock) items.push({ key: 'stock', type: 'warn', icon: I.box, ...lowStock, action: () => navigate('/stock') });
    return items;
  }, [overdueRow, gstr1, lowStock]);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  useEffect(() => {
    if (!notifOpen) return;
    function onTap(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
    }
    document.addEventListener('pointerdown', onTap);
    return () => document.removeEventListener('pointerdown', onTap);
  }, [notifOpen]);

  return (
    <div className="dash">
      {/* Header — fixed at top, content scrolls underneath. */}
      <div className="dash-header">
        <button className="dash-avatar" onClick={() => setPanelOpen(true)} aria-label="profile menu">
          {initial}
        </button>
        <div className="dash-brand-wrap">
          <div className="dash-brand">{companyName}</div>
          <div className="dash-date">{greetingDate}</div>
        </div>
        <div className="dash-actions">
          <button className="icon-btn" aria-label="search" onClick={() => navigate('/search')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          </button>
          <div className="notif-wrap" ref={notifRef}>
            <button className="icon-btn" aria-label="notifications" onClick={() => setNotifOpen((v) => !v)}>
              {I.bell}
              {notifications.length > 0 && (
                <span className="notif-badge">{notifications.length}</span>
              )}
            </button>
            {notifOpen && (
              <div className="notif-dropdown">
                <div className="notif-dropdown-head">Notifications</div>
                {notifications.length === 0 && (
                  <div className="notif-dropdown-empty">All clear — nothing needs attention.</div>
                )}
                {notifications.map((n) => (
                  <button key={n.key} className="notif-dropdown-item" onClick={() => { setNotifOpen(false); n.action(); }}>
                    <span className={`att-icon ${n.type}`}>{n.icon}</span>
                    <span className="att-content">
                      <span className="att-title">{n.title}</span>
                      <span className="att-sub">{n.sub}</span>
                    </span>
                    {n.total != null && (
                      <span className="att-amount">
                        <span className="currency">₹</span>{formatINR(n.total)}
                      </span>
                    )}
                    {n.total == null && <span className="att-chevron">{I.chev}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="dash-header-spacer" />

      {/* Hero card */}
      <div className="hero-card">
        <div className="hero-top" onClick={() => navigate(`/day-book?date=${isoDate()}`)}>
          <div className="hero-label">Today's sales</div>
          {deltaPct !== null && (
            <div className={`hero-badge ${deltaPct >= 0 ? 'up' : 'down'}`}>
              {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%
            </div>
          )}
        </div>
        <div className="hero-amount" onClick={() => navigate(`/day-book?date=${isoDate()}`)}>
          <span className="currency">₹</span>{formatINR(todaySales)}
        </div>
        <div className="hero-sub" onClick={() => navigate(`/day-book?date=${isoDate()}`)}>
          {todaySalesCount} transaction{todaySalesCount === 1 ? '' : 's'}
        </div>

        <div className="hero-boxes">
          <button className="hero-box" onClick={() => goVouchers('receipt')}>
            <div className="hero-box-label">Payment received</div>
            <div className="hero-box-value">
              <span className="currency">₹</span>{formatINR(receiptsTotal)}
            </div>
            <div className="hero-box-sub">
              {receiptsCount} receipt{receiptsCount === 1 ? '' : 's'}
            </div>
          </button>
          <button className="hero-box" onClick={() => navigate('/outstanding')}>
            <div className="hero-box-label">Outstanding</div>
            <div className="hero-box-value">
              <span className="currency">₹</span>{formatINR(receivablesTotal)}
            </div>
            <div className="hero-box-sub">
              {receivablesCount} customer{receivablesCount === 1 ? '' : 's'}
            </div>
          </button>
        </div>
      </div>

      {/* Quick actions — horizontally scrollable now that we have
          5+ buttons. Each tile keeps a fixed width so the row swipes
          like a carousel. */}
      <div className="qa-scroll">
        <button className="qa-btn primary" onClick={() => navigate('/sale/new')}>
          <span className="qa-icon">{I.invoice}</span>
          <span className="qa-label">New<br/>Invoice</span>
        </button>
        <button className="qa-btn" onClick={() => navigate('/receipt/new')}>
          <span className="qa-icon">{I.receive}</span>
          <span className="qa-label">Receipt</span>
        </button>
        <button className="qa-btn" onClick={() => navigate('/purchase/new')}>
          <span className="qa-icon">{I.cart}</span>
          <span className="qa-label">New<br/>Purchase</span>
        </button>
        <button className="qa-btn" onClick={() => navigate('/payment/new')}>
          <span className="qa-icon">{I.send}</span>
          <span className="qa-label">Payment</span>
        </button>
        <button className="qa-btn" onClick={() => navigate('/customer/new')}>
          <span className="qa-icon">{I.userPlus}</span>
          <span className="qa-label">Add<br/>Customer</span>
        </button>
        <button className="qa-btn" onClick={() => navigate('/supplier/new')}>
          <span className="qa-icon">{I.userPlus}</span>
          <span className="qa-label">Add<br/>Supplier</span>
        </button>
      </div>

      {/* Recent activity (Day Book preview) */}
      <div className="dash-section">
        <h2>Recent <em>activity</em></h2>
        <button className="dash-section-link" onClick={() => navigate(`/day-book?date=${isoDate()}`)}>
          View all {I.chevTiny}
        </button>
      </div>
      <div className="act-list">
        {loading && (
          <div className="act-empty">Loading today's day book…</div>
        )}
        {!loading && today.length === 0 && (
          <div className="act-empty">No transactions yet today.</div>
        )}
        {!loading && today.map((entry) => (
          <ActivityRow
            key={entry.entry_number}
            entry={entry}
            onClick={() => openBillDetail(entry)}
          />
        ))}
      </div>

    </div>
  );
}

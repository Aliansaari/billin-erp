import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { message, Modal, Spin } from 'antd';
import dayjs from 'dayjs';
import { partyAPI, authAPI, dataAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import PartyForm from './PartyForm';
import './party-list-view.css';

/* ════════════════════════════════════════════════════════════════════════════
 * PartyListView — full-page Customer/Supplier list (editorial v5, refined).
 *
 * Structure:
 *   1. Header     — big title + 4 CTAs (Receipt · Sale · New · Export for
 *                   Customers; Payment · Purchase · New · Export for Suppliers)
 *   2. Aging hero — 5 cards (Total + 0-30 + 31-60 + 61-90 + 90+) sourced
 *                   from partyAPI.getAging. Blurred behind admin password
 *                   when the eye toggle is pressed.
 *   3. Filter bar — lens chips + status chips inline + search + sort +
 *                   columns (admin-gated) + eye (admin-gated).
 *   4. Table      — data-dense row per party; expandable row loads ledger
 *                   on demand and shows last-5 + 30-day stats + lifetime.
 *
 * Row actions (3): View full report · Edit details · Deactivate/Activate
 *   - Large screens show all three as labelled buttons.
 *   - Small screens collapse them into a "⋯" menu (same three options).
 *
 * Admin gates (eye toggle + columns dropdown) call POST /auth/verify-password
 * before flipping state. Who can pass the gate is governed by user roles.
 * ════════════════════════════════════════════════════════════════════════════ */

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtCompact = (v) => {
  const n = parseFloat(v || 0);
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹ ${(n / 1e7).toFixed(1)} Cr`;
  if (abs >= 1e5) return `₹ ${(n / 1e5).toFixed(1)} L`;
  if (abs >= 1e3) return `₹ ${(n / 1e3).toFixed(0)}k`;
  return `₹ ${n.toFixed(0)}`;
};
const fmtDate = (d) => d ? dayjs(d).format('DD MMM') : '—';
const daysAgo = (d) => d ? dayjs().diff(dayjs(d), 'day') : null;

// Inline SVG icon set — keeps the component self-contained, no @ant-design/icons
// mass-import needed in this file. Each is a thin-stroke 24×24 Lucide-style icon.
const Ico = {
  ChevRight: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" {...props}><polyline points="9 18 15 12 9 6"/></svg>),
  Phone: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.92.35 1.82.66 2.68a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 2.11-.45 13 13 0 0 0 2.68.66A2 2 0 0 1 22 16.92z"/></svg>),
  WhatsApp: (props) => (<svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M20.52 3.48A12 12 0 0 0 3.7 19.36L2 22l2.72-1.65A12 12 0 1 0 20.52 3.48zm-8.52 18a9.93 9.93 0 0 1-5.12-1.42l-.37-.22-2.42 1.47.5-2.4-.26-.39A10 10 0 1 1 12 21.48z"/></svg>),
  Email: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>),
  Plus: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" {...props}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>),
  Download: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>),
  Search: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>),
  Sort: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M3 6h18M6 12h12M10 18h4"/></svg>),
  Columns: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>),
  Eye: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>),
  EyeOff: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>),
  Lock: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>),
  Info: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>),
  Edit: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>),
  Report: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>),
  Block: (props) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>),
  More: (props) => (<svg viewBox="0 0 24 24" fill="currentColor" {...props}><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>),
};

// Default visible columns — persisted in localStorage so admin's choice
// survives reload. The schema is the same for customers & suppliers; the
// contextual labels differ and are rendered in the header only.
const DEFAULT_COLS = { status: true, contact: true, outstanding: true, aging: true, credit: true, last: true, actions: true };
const COLS_KEY = (partyType) => `plv_cols_${partyType}`;

export default function PartyListView({ partyType }) {
  const isCustomer = partyType === 'Customer';
  const navigate = useNavigate();

  // Data
  const [parties, setParties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aging, setAging] = useState(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [lensFilter, setLensFilter] = useState('all');
  const [bucketFilter, setBucketFilter] = useState(null); // 'b0' | 'b30' | 'b60' | 'b90' | null
  const [sortBy, setSortBy] = useState(isCustomer ? 'outstanding-desc' : 'balance-desc');

  // UI state
  const [expandedId, setExpandedId] = useState(null);
  const [expandData, setExpandData] = useState(null);
  const [hideTotals, setHideTotals] = useState(false);
  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY(partyType)) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef(null);

  // F4 = Find target — focused by the action strip.
  const searchInputRef = useRef(null);

  // Party form (Edit/Create modal)
  const [formOpen, setFormOpen] = useState(false);
  const [editingParty, setEditingParty] = useState(null);
  const [formLoading, setFormLoading] = useState(false);

  // Admin password modal
  const [pwModal, setPwModal] = useState(null);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const pwInputRef = useRef(null);

  /* ── Load ──────────────────────────────────────────────────────────────── */
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Ensure current_balance is fresh before fetching — Party.current_balance
      // is a denormalised cache and can drift if older code forgot to call
      // recalculatePartyBalance after a mutation. Cheap to call, very helpful.
      await partyAPI.recalculateBalances().catch(() => {});

      const params = { search, limit: 500 };
      if (statusFilter !== 'all') params.status = statusFilter;

      const [partiesRes, agingRes] = await Promise.all([
        isCustomer ? partyAPI.getCustomers(params) : partyAPI.getSuppliers(params),
        partyAPI.getAging({ party_type: partyType }).catch(() => ({ data: null })),
      ]);

      setParties(partiesRes.data.data || []);
      setAging(agingRes.data || null);
    } catch {
      message.error(`Failed to load ${partyType.toLowerCase()}s`);
    }
    setLoading(false);
  }, [search, statusFilter, isCustomer, partyType]);

  useEffect(() => { loadData(); }, [loadData]);

  // Close the columns menu when clicking outside.
  useEffect(() => {
    const handler = (e) => {
      if (colsOpen && colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [colsOpen]);

  // Persist column choices so admin's picks stick across reloads.
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY(partyType), JSON.stringify(cols)); } catch {}
  }, [cols, partyType]);

  /* ── Derived views ─────────────────────────────────────────────────────── */
  const statusCounts = useMemo(() => ({
    all: parties.length,
    Regular:   parties.filter(p => (p.party_status || 'Regular') === 'Regular').length,
    Priority:  parties.filter(p => p.party_status === 'Priority').length,
    VIP:       parties.filter(p => p.party_status === 'VIP').length,
    Blacklist: parties.filter(p => p.party_status === 'Blacklist').length,
  }), [parties]);

  const owingBalance = (p) => {
    // Customers: positive = receivable (dues). Suppliers: negative = payable.
    const b = parseFloat(p.current_balance || 0);
    return isCustomer ? b : -b;
  };

  const lensCounts = useMemo(() => {
    const overdue = parties.filter(p => owingBalance(p) > 0.01).length;
    const hi = parties.filter(p => Math.abs(parseFloat(p.current_balance || 0)) >= 100000).length;
    const near = parties.filter(p => {
      const limit = parseFloat(p.credit_limit || 0);
      const used = owingBalance(p);
      return limit > 0 && used / limit >= 0.8;
    }).length;
    const dormant = parties.filter(p => Math.abs(parseFloat(p.current_balance || 0)) < 1).length;
    return { all: parties.length, overdue, highvalue: hi, nearlimit: near, dormant };
  }, [parties, isCustomer]);

  // Aging bucket boundaries come from the server (admin-configurable). Client
  // mirrors the same math so the list filter agrees with the hero-card totals.
  const buckets = aging?.buckets || { b1: 30, b2: 60, b3: 90 };

  const filteredParties = useMemo(() => {
    let list = parties;
    if (lensFilter === 'overdue')   list = list.filter(p => owingBalance(p) > 0.01);
    if (lensFilter === 'highvalue') list = list.filter(p => Math.abs(parseFloat(p.current_balance || 0)) >= 100000);
    if (lensFilter === 'nearlimit') list = list.filter(p => {
      const limit = parseFloat(p.credit_limit || 0);
      const used = owingBalance(p);
      return limit > 0 && used / limit >= 0.8;
    });
    if (lensFilter === 'dormant')   list = list.filter(p => Math.abs(parseFloat(p.current_balance || 0)) < 1);

    // Aging-bucket filter — only include parties whose oldest-open-bill age
    // (already anchored on bill_date + credit_days by the server) lands inside
    // the selected bucket. Parties with no open bills are filtered out.
    if (bucketFilter) {
      list = list.filter(p => {
        const d = p._aging_days;
        if (d == null) return false;
        if (bucketFilter === 'b0')  return d <= buckets.b1;
        if (bucketFilter === 'b30') return d >  buckets.b1 && d <= buckets.b2;
        if (bucketFilter === 'b60') return d >  buckets.b2 && d <= buckets.b3;
        if (bucketFilter === 'b90') return d >  buckets.b3;
        return true;
      });
    }

    // Sort — aging-days (oldest first) takes precedence when a bucket is
    // active so the user sees the worst offenders in that band at the top.
    const sorted = [...list];
    if (bucketFilter) {
      sorted.sort((a,b) => (b._aging_days ?? -1) - (a._aging_days ?? -1));
    } else if (sortBy === 'outstanding-desc') sorted.sort((a,b) => owingBalance(b) - owingBalance(a));
    else if (sortBy === 'balance-desc') sorted.sort((a,b) => Math.abs(parseFloat(b.current_balance || 0)) - Math.abs(parseFloat(a.current_balance || 0)));
    else if (sortBy === 'name-asc')  sorted.sort((a,b) => (a.party_name||'').localeCompare(b.party_name||''));
    else if (sortBy === 'name-desc') sorted.sort((a,b) => (b.party_name||'').localeCompare(a.party_name||''));
    return sorted;
  }, [parties, lensFilter, bucketFilter, sortBy, isCustomer, buckets.b1, buckets.b2, buckets.b3]);

  /* ── Row expand ────────────────────────────────────────────────────────── */
  const [profitPeriod, setProfitPeriod] = useState('fy-current');
  const handleExpand = async (p) => {
    if (expandedId === p.party_id) { setExpandedId(null); setExpandData(null); return; }
    setExpandedId(p.party_id);
    setExpandData({ loading: true });
    try {
      // Fire three requests in parallel: ledger (for the last-5 + stats),
      // profit (COGS-backed gross profit for the current FY), and we reuse
      // the aging_days already on the row. Reduces time-to-expand from
      // ~500ms sequential to ~200ms parallel on slow connections.
      const [ledgerRes, profitRes] = await Promise.all([
        partyAPI.getLedger(p.party_id, {}),
        partyAPI.getProfit(p.party_id, { period: profitPeriod }).catch(() => ({ data: null })),
      ]);
      const data = ledgerRes.data;
      const entries = data.entries || [];

      // Stats from entries: 30-day, lifetime, txn count.
      const thirtyAgo = dayjs().subtract(30, 'day');
      const in30 = entries.filter(e => dayjs(e.date).isAfter(thirtyAgo));
      const sum = (arr, key) => arr.reduce((s, e) => s + parseFloat(e[key] || 0), 0);

      // Customer side: sales are debits, receipts are credits.
      // Supplier side: purchases are credits, payments are debits.
      const stats = isCustomer ? {
        sales30:    sum(in30.filter(e => e.particulars === 'Sales Bill'), 'debit'),
        receipts30: sum(in30.filter(e => ['Receipt','Payment at Billing'].includes(e.particulars)), 'credit'),
        lifetimeSales: sum(entries.filter(e => e.particulars === 'Sales Bill'), 'debit'),
        txCount: entries.length,
      } : {
        purchases30: sum(in30.filter(e => e.particulars === 'Purchase Bill'), 'credit'),
        payments30:  sum(in30.filter(e => ['Payment','Payment at Billing'].includes(e.particulars)), 'debit'),
        lifetimePurchases: sum(entries.filter(e => e.particulars === 'Purchase Bill'), 'credit'),
        txCount: entries.length,
      };

      // Last 5 entries, newest first.
      const sortedEntries = [...entries].sort((a,b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());
      const recent = sortedEntries.slice(0, 5);

      setExpandData({ loading: false, recent, stats, profit: profitRes.data });
    } catch {
      setExpandData({ loading: false, error: true });
    }
  };

  // Refetch profit when the user toggles FY dropdown inside an open expanded row.
  const handleProfitPeriodChange = async (newPeriod) => {
    setProfitPeriod(newPeriod);
    if (!expandedId) return;
    try {
      const { data } = await partyAPI.getProfit(expandedId, { period: newPeriod });
      setExpandData(prev => prev ? { ...prev, profit: data } : prev);
    } catch {}
  };

  /* ── Admin-gated actions ───────────────────────────────────────────────── */
  const requirePassword = (action) => {
    setPwInput(''); setPwError(''); setPwModal(action);
    // Focus the password field after the modal transition settles.
    setTimeout(() => pwInputRef.current?.focus(), 120);
  };

  const pwCopy = () => {
    if (!pwModal) return { title: 'Admin access required', sub: '' };
    if (pwModal === 'toggle-totals') {
      return {
        title: 'Admin access required',
        sub: hideTotals
          ? <>Enter the admin password to <b>reveal the totals band</b>. Action logged.</>
          : <>Enter the admin password to <b>hide the totals band</b>. Action logged.</>,
      };
    }
    if (pwModal === 'open-columns') {
      return {
        title: 'Admin access required',
        sub: <>Enter the admin password to <b>change visible columns</b>. Applies to all users.</>,
      };
    }
    return { title: 'Admin access required', sub: '' };
  };

  const handleVerifyPassword = async (e) => {
    e?.preventDefault?.();
    if (!pwInput) return;
    setPwLoading(true); setPwError('');
    try {
      await authAPI.verifyPassword(pwInput);
      if (pwModal === 'toggle-totals') setHideTotals(!hideTotals);
      else if (pwModal === 'open-columns') setColsOpen(!colsOpen);
      setPwModal(null);
    } catch (err) {
      setPwError(err.response?.data?.error || 'Invalid password');
    }
    setPwLoading(false);
  };

  /* ── Row actions ───────────────────────────────────────────────────────── */
  const handleEditParty = (p) => {
    setEditingParty(p); setFormOpen(true);
  };
  const handleViewReport = (p) => {
    // Route to the proper Customer / Supplier Statement page (with the
    // party pre-selected via ?id=). The legacy /parties/:id detail view
    // is no longer the destination — it's been retired in favour of the
    // unified statement pages.
    const route = isCustomer ? '/reports/customer-statement' : '/reports/supplier-statement';
    navigate(`${route}?id=${p.party_id}`);
  };
  // Toggle active state for one or many parties. Single-row preserves
  // the original confirm copy. Multi-row counts the to-activate vs
  // to-deactivate split and asks once. Both go through partyAPI.toggleActive
  // serially so per-row error semantics survive.
  const handleBulkToggleActive = (rowsToToggle) => {
    if (!rowsToToggle || rowsToToggle.length === 0) return;
    if (rowsToToggle.length === 1) {
      const p = rowsToToggle[0];
      Modal.confirm({
        title: `${p.is_active ? 'Deactivate' : 'Activate'} ${p.party_name}?`,
        content: p.is_active
          ? `Deactivated ${partyType.toLowerCase()}s are hidden from selection lists. Transactions stay intact.`
          : `Reactivate this ${partyType.toLowerCase()} so they appear in selection lists again.`,
        okText: p.is_active ? 'Deactivate' : 'Activate',
        cancelText: 'Cancel',
        okButtonProps: { danger: !!p.is_active, size: 'large', style: { minWidth: 140 } },
        cancelButtonProps: { size: 'large', style: { minWidth: 100 } },
        centered: true,
        onOk: async () => {
          try {
            await partyAPI.toggleActive(p.party_id);
            message.success(p.is_active ? 'Deactivated' : 'Activated');
            loadData();
          } catch (err) {
            message.error(err.response?.data?.error || 'Failed to update');
          }
        },
      });
      return;
    }
    // Multi: split by current state so the confirm dialog is honest about
    // what's about to happen. Each row still flips individually server-side.
    const toDeactivate = rowsToToggle.filter(p => p.is_active).length;
    const toActivate   = rowsToToggle.length - toDeactivate;
    const parts = [];
    if (toDeactivate) parts.push(`${toDeactivate} to deactivate`);
    if (toActivate)   parts.push(`${toActivate} to activate`);
    Modal.confirm({
      title: `Toggle ${rowsToToggle.length} ${partyType.toLowerCase()}s?`,
      content: `${parts.join(' · ')}. Each row's active state will be flipped.`,
      okText: 'Continue',
      cancelText: 'Cancel',
      okButtonProps: { danger: toDeactivate > 0, size: 'large', style: { minWidth: 140 } },
      cancelButtonProps: { size: 'large', style: { minWidth: 100 } },
      centered: true,
      onOk: async () => {
        let ok = 0, fail = 0;
        for (const p of rowsToToggle) {
          try { await partyAPI.toggleActive(p.party_id); ok++; }
          catch { fail++; }
        }
        loadData();
        if (fail === 0) message.success(`Updated ${ok} ${partyType.toLowerCase()}s.`);
        else message.warning(`${ok} updated, ${fail} failed.`);
      },
    });
  };

  /* ── Form submit (Edit/Create) ─────────────────────────────────────────── */
  const handleFormSubmit = async (values) => {
    setFormLoading(true);
    try {
      if (editingParty) {
        await partyAPI.update(editingParty.party_id, values);
        message.success(`${partyType} updated`);
      } else {
        await partyAPI.create({ ...values, party_type: partyType });
        message.success(`${partyType} added`);
      }
      setFormOpen(false); setEditingParty(null);
      loadData();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save');
    }
    setFormLoading(false);
  };
  const handleFormDeleted = (partyId) => {
    setFormOpen(false); setEditingParty(null);
    setParties(prev => prev.filter(p => p.party_id !== partyId));
  };

  /* ── Export ────────────────────────────────────────────────────────────── */
  const handleExport = async () => {
    try {
      const { data } = await dataAPI.exportExcel(
        isCustomer ? 'customers' : 'suppliers',
        search ? { search } : {}
      );
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${partyType.toLowerCase()}s_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* ── Selection model — cursor + multi-select ──
     Plain <table> means we drive cursor/selection from useListSelection
     directly (no VRT). Cursor index runs over `filteredParties` (the
     currently visible list, not the unfiltered `parties` array) so
     navigation tracks what the operator can actually see. */
  const sel = useListSelection({ totalCount: filteredParties.length, rows: filteredParties });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;

  // Click handler shared by every row. Plain click = move cursor + let
  // the existing expand toggle run. Shift / Ctrl click extend or toggle
  // selection without expanding (we'd otherwise expand 100 rows in a
  // shift-drag).
  const handleRowClick = useCallback((idx, ev, p) => {
    if (ev.shiftKey)             { sel.extendTo(idx);   ev.stopPropagation(); return false; }
    if (ev.ctrlKey || ev.metaKey){ sel.toggleRow(idx);  ev.stopPropagation(); return false; }
    sel.setCursor(idx);
    return true;  // allow the row to also expand
  }, [sel]);

  /* ── Render ────────────────────────────────────────────────────────────── */
  const overdueCount = aging?.overdue_count ?? lensCounts.overdue;
  const totalReceivable = aging?.total ?? parties.reduce((s, p) => s + Math.max(0, owingBalance(p)), 0);

  return (
    <div className="plv-page">

      {/* ── HEADER ── */}
      <div className="plv-hdr">
        <div className="plv-title">
          <h1>{isCustomer ? 'Customers' : 'Suppliers'}</h1>
          <div className="sub">
            <b>{parties.length}</b> active
            {totalReceivable > 0 && <> · <b>{fmt(totalReceivable)}</b> {isCustomer ? 'receivable' : 'payable'}</>}
            {overdueCount > 0 && <> · <b className="crit">{overdueCount}</b> overdue</>}
          </div>
        </div>

        <div className="plv-actions">
          <button className="plv-btn receipt" onClick={() => navigate(isCustomer ? '/receipt/new' : '/payment/new')}>
            <Ico.Plus/> {isCustomer ? 'Receipt' : 'Payment'}
          </button>
          <button className="plv-btn sale" onClick={() => navigate(isCustomer ? '/sale/new' : '/purchase/new')}>
            <Ico.Plus/> {isCustomer ? 'Sale Bill' : 'Purchase Bill'}
          </button>
          <button className="plv-btn primary" onClick={() => { setEditingParty(null); setFormOpen(true); }}>
            <Ico.Plus/> New {partyType.toLowerCase()}
          </button>
          <button className="plv-btn" onClick={handleExport}>
            <Ico.Download/> Export
          </button>
        </div>
      </div>

      {/* ── AGING HERO ── */}
      {aging && (
        <div className="plv-hero-wrap">
          <div className="plv-hero-head">
            <span className="title">
              {isCustomer ? 'Receivables · Aging buckets' : 'Payables · Aging buckets'}
            </span>
          </div>
          <div className={`plv-hero${hideTotals ? ' hidden' : ''}`}>
            <div
              className={`plv-age-card total${bucketFilter === null ? ' on' : ''}`}
              onClick={() => setBucketFilter(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setBucketFilter(null)}
            >
              <div className="k">Total {isCustomer ? 'Receivable' : 'Payable'}</div>
              <div className="v plv-num">{fmt(aging.total)}</div>
              <div className="sub">{aging.party_count || 0} {isCustomer ? 'customers' : 'suppliers'} owing</div>
              <div className="bar"><div className="fill" style={{ background: 'var(--accent)', width: '100%' }}/></div>
            </div>
            {[
              { cls: 'b0',  k: 'Not yet due', label: `0 – ${buckets.b1} days`,            amount: aging.b0_30,   count: aging.c0_30 },
              { cls: 'b30', k: 'Watchful',    label: `${buckets.b1 + 1} – ${buckets.b2} days`, amount: aging.b31_60,  count: aging.c31_60 },
              { cls: 'b60', k: 'Chase',       label: `${buckets.b2 + 1} – ${buckets.b3} days`, amount: aging.b61_90,  count: aging.c61_90 },
              { cls: 'b90', k: 'Critical',    label: `${buckets.b3}+ days`,                amount: aging.b90plus, count: aging.c90plus },
            ].map(b => {
              const pct = aging.total > 0 ? Math.round((b.amount / aging.total) * 100) : 0;
              const active = bucketFilter === b.cls;
              return (
                <div
                  key={b.cls}
                  className={`plv-age-card ${b.cls}${active ? ' on' : ''}`}
                  onClick={() => setBucketFilter(active ? null : b.cls)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setBucketFilter(active ? null : b.cls)}
                  title={`${active ? 'Clear' : 'Filter to'} ${b.k.toLowerCase()} — ${b.count || 0} parties`}
                >
                  <span className="pct">{pct}%</span>
                  <div className="k">{b.k}</div>
                  <div className="v plv-num">{fmt(b.amount)}</div>
                  <div className="sub">{b.label} · {b.count || 0} parties</div>
                  <div className="bar"><div className="fill" style={{ width: `${pct}%` }}/></div>
                </div>
              );
            })}
          </div>
          <div className="plv-hero-hidden-pill">
            <Ico.EyeOff/> Totals hidden · admin only
          </div>
        </div>
      )}

      {/* ── FILTER BAR ── */}
      <div className="plv-filter-bar">
        <div className="plv-chips">
          {/* Lens chips */}
          <button className={`plv-chip${lensFilter === 'all' ? ' on' : ''}`} onClick={() => setLensFilter('all')}>
            All <span className="count plv-num">{lensCounts.all}</span>
          </button>
          <button className={`plv-chip alarm${lensFilter === 'overdue' ? ' on' : ''}`} onClick={() => setLensFilter('overdue')}>
            Overdue <span className="count plv-num">{lensCounts.overdue}</span>
          </button>
          <button className={`plv-chip${lensFilter === 'highvalue' ? ' on' : ''}`} onClick={() => setLensFilter('highvalue')}>
            High value · &gt; ₹1L <span className="count plv-num">{lensCounts.highvalue}</span>
          </button>
          <button className={`plv-chip${lensFilter === 'nearlimit' ? ' on' : ''}`} onClick={() => setLensFilter('nearlimit')}>
            Near credit limit <span className="count plv-num">{lensCounts.nearlimit}</span>
          </button>
          <button className={`plv-chip${lensFilter === 'dormant' ? ' on' : ''}`} onClick={() => setLensFilter('dormant')}>
            Settled · no dues <span className="count plv-num">{lensCounts.dormant}</span>
          </button>

          {/* Divider */}
          <span className="plv-chip divider" aria-hidden="true"/>

          {/* Status chips inline — the `status` label was removed per feedback. */}
          <button className={`plv-chip${statusFilter === 'all' ? ' on' : ''}`} onClick={() => setStatusFilter('all')}>
            All status <span className="count plv-num">{statusCounts.all}</span>
          </button>
          <button className={`plv-chip regular${statusFilter === 'Regular' ? ' on' : ''}`} onClick={() => setStatusFilter('Regular')}>
            <span className="dot regular"/>Regular <span className="count plv-num">{statusCounts.Regular}</span>
          </button>
          <button className={`plv-chip priority${statusFilter === 'Priority' ? ' on' : ''}`} onClick={() => setStatusFilter('Priority')}>
            <span className="dot priority"/>Priority <span className="count plv-num">{statusCounts.Priority}</span>
          </button>
          <button className={`plv-chip vip${statusFilter === 'VIP' ? ' on' : ''}`} onClick={() => setStatusFilter('VIP')}>
            <span className="dot vip"/>VIP <span className="count plv-num">{statusCounts.VIP}</span>
          </button>
          <button className={`plv-chip blacklist${statusFilter === 'Blacklist' ? ' on' : ''}`} onClick={() => setStatusFilter('Blacklist')}>
            <span className="dot blacklist"/>Blacklist <span className="count plv-num">{statusCounts.Blacklist}</span>
          </button>
        </div>

        <div className="plv-search-group">
          <div className="plv-search">
            <Ico.Search/>
            <input
              ref={searchInputRef}
              type="text"
              placeholder={`Search ${partyType.toLowerCase()}s…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="plv-iconbtn"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ paddingRight: 8 }}
          >
            <option value="outstanding-desc">Sort: {isCustomer ? 'Receivable' : 'Payable'} ↓</option>
            <option value="balance-desc">Sort: Balance (abs) ↓</option>
            <option value="name-asc">Sort: Name A → Z</option>
            <option value="name-desc">Sort: Name Z → A</option>
          </select>

          {/* Columns + Eye (admin-gated) */}
          <div style={{ position: 'relative' }} ref={colsRef}>
            <button className="plv-iconbtn" onClick={() => requirePassword('open-columns')}>
              <Ico.Columns/> Columns
              <span className="lock-dot"><Ico.Lock style={{ width: 7, height: 7 }}/></span>
            </button>
            {colsOpen && (
              <div className="plv-dd">
                <div className="mh">
                  <span className="mh-title">Show columns</span>
                  <span className="mh-pad">Admin · saves for all users</span>
                </div>
                <label className="opt"><input type="checkbox" checked disabled/> {isCustomer ? 'Customer' : 'Supplier'} <span className="pin">Pinned</span></label>
                {[
                  { k: 'status',      l: 'Status' },
                  { k: 'contact',     l: 'Contact' },
                  { k: 'outstanding', l: isCustomer ? 'Outstanding' : 'Payable' },
                  { k: 'aging',       l: 'Aging (oldest days)' },
                  { k: 'credit',      l: 'Credit usage' },
                  { k: 'last',        l: 'Last transaction' },
                ].map(c => (
                  <label key={c.k} className="opt">
                    <input
                      type="checkbox"
                      checked={cols[c.k]}
                      onChange={(e) => setCols(prev => ({ ...prev, [c.k]: e.target.checked }))}
                    /> {c.l}
                  </label>
                ))}
                <label className="opt"><input type="checkbox" checked disabled/> Actions <span className="pin">Pinned</span></label>
              </div>
            )}
          </div>

          <button
            className="plv-iconbtn square"
            onClick={() => requirePassword('toggle-totals')}
            title={hideTotals ? 'Show totals' : 'Hide totals'}
          >
            {hideTotals ? <Ico.EyeOff/> : <Ico.Eye/>}
            <span className="lock-dot"><Ico.Lock style={{ width: 7, height: 7 }}/></span>
          </button>
        </div>
      </div>

      {/* ── TABLE ── */}
      <div className="plv-table-wrap">
        <div className="plv-table-card">
          {loading ? (
            <div className="plv-empty" style={{ padding: 60 }}><Spin/></div>
          ) : filteredParties.length === 0 ? (
            <div className="plv-empty">
              <span className="icon">{isCustomer ? '◉' : '◎'}</span>
              <div>No {partyType.toLowerCase()}s match the current filters.</div>
              <div className="sub">Try clearing lens / status chips above or search.</div>
            </div>
          ) : (
            <div className="plv-table-scroll">
              <table className="plv-table">
                <colgroup>
                  <col className="c-party"/>
                  {cols.status      && <col className="c-status"/>}
                  {cols.contact     && <col className="c-contact"/>}
                  {cols.outstanding && <col className="c-out"/>}
                  {cols.aging       && <col className="c-aging"/>}
                  {cols.credit      && <col className="c-credit"/>}
                  {cols.last        && <col className="c-last"/>}
                  <col className="c-act"/>
                </colgroup>
                <thead>
                  <tr>
                    <th>{isCustomer ? 'Customer' : 'Supplier'}</th>
                    {cols.status      && <th>Status</th>}
                    {cols.contact     && <th>Contact</th>}
                    {cols.outstanding && <th className="r">{isCustomer ? 'Outstanding' : 'Payable'}</th>}
                    {cols.aging       && <th>Aging</th>}
                    {cols.credit      && <th>Credit usage</th>}
                    {cols.last        && <th>Last transaction</th>}
                    <th className="r">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredParties.map((p, idx) => (
                    <PartyRow
                      key={p.party_id}
                      p={p}
                      idx={idx}
                      cols={cols}
                      isCustomer={isCustomer}
                      expanded={expandedId === p.party_id}
                      expandData={expandedId === p.party_id ? expandData : null}
                      onClickRow={handleRowClick}
                      onExpand={() => handleExpand(p)}
                      isCursor={sel.cursorIdx === idx}
                      isMultiSelected={sel.selectedSet.has(idx) && sel.cursorIdx !== idx}
                      profitPeriod={profitPeriod}
                      onProfitPeriodChange={handleProfitPeriodChange}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom action strip — all party actions on F-keys.
          F1 Open jumps to the statement page; F2 opens the edit modal;
          F3 opens "new party" form; F6 quick-creates a Receipt (cust)
          / Payment (sup) preselected to the cursored party; F7 same
          for Sale / Purchase; F8 toggles active state (multi-bulk);
          F10 exports the current filtered view to Excel. F4 focuses
          search; F5 reloads from server. */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && handleViewReport(single),
          },
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single,
            onAction: () => single && handleEditParty(single),
          },
          {
            id: 'new', key: 'F3', label: `New ${partyType}`,
            onAction: () => { setEditingParty(null); setFormOpen(true); },
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => loadData(),
          },
          {
            id: 'recv-pay', key: 'F6',
            label: isCustomer ? 'Receipt' : 'Payment',
            disabled: isMulti || !single,
            onAction: () => single && navigate(
              isCustomer ? '/receipt/new' : '/payment/new',
              { state: { preselect: { party_id: single.party_id } } },
            ),
          },
          {
            id: 'sale-pur', key: 'F7',
            label: isCustomer ? 'Sale' : 'Purchase',
            disabled: isMulti || !single,
            onAction: () => single && navigate(
              isCustomer ? '/sale/new' : '/purchase/new',
              { state: { preselect: { party_id: single.party_id } } },
            ),
          },
          {
            id: 'toggle', key: 'F8',
            label: (single && !single.is_active) ? 'Activate' : 'Deactivate',
            tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkToggleActive(isMulti ? selectedRows : [single]),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            onAction: () => handleExport(),
          },
        ]}
      />

      {/* ── Party form modal (Edit/Create) ── */}
      <PartyForm
        visible={formOpen}
        onCancel={() => { setFormOpen(false); setEditingParty(null); }}
        onSubmit={handleFormSubmit}
        onDeleted={handleFormDeleted}
        initialValues={editingParty}
        partyType={partyType}
        loading={formLoading}
      />

      {/* ── Admin password modal ── */}
      <div className={`plv-scrim${pwModal ? ' open' : ''}`} onClick={() => !pwLoading && setPwModal(null)}/>
      <div className={`plv-pwmodal${pwModal ? ' open' : ''}`} role="dialog" aria-modal="true">
        <form onSubmit={handleVerifyPassword}>
          <div className="plv-pw-hd">
            <div className="icon"><Ico.Lock/></div>
            <div>
              <div className="title">{pwCopy().title}</div>
              <div className="sub">{pwCopy().sub}</div>
            </div>
          </div>
          <div className="plv-pw-body">
            <div className="fl">Admin password</div>
            <input
              ref={pwInputRef}
              type="password"
              placeholder="Enter your password"
              value={pwInput}
              onChange={(e) => { setPwInput(e.target.value); setPwError(''); }}
              disabled={pwLoading}
            />
            {pwError && <div className="err">{pwError}</div>}
            <div className="hint">
              <Ico.Info/>
              Who can toggle this? Configured in <b>Settings · User roles &amp; permissions</b>
            </div>
          </div>
          <div className="plv-pw-ft">
            <button type="button" className="plv-btn" onClick={() => setPwModal(null)} disabled={pwLoading}>Cancel</button>
            <button type="submit" className="plv-btn primary" disabled={pwLoading || !pwInput}>
              {pwLoading ? 'Verifying…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Row component ────────────────────────────────────────────────────────── */
function PartyRow({ p, idx, cols, isCustomer, expanded, expandData, onExpand, onClickRow, isCursor, isMultiSelected, profitPeriod, onProfitPeriodChange }) {
  const bal = parseFloat(p.current_balance || 0);
  const owing = isCustomer ? bal : -bal;
  const absBal = Math.abs(bal);
  const status = p.party_status || 'Regular';
  const statusCls = status.toLowerCase();

  // Credit cell
  const creditLimit = parseFloat(p.credit_limit || 0);
  const creditPct = creditLimit > 0 ? Math.min(100, Math.round((owing / creditLimit) * 100)) : 0;
  const creditFillCls = creditPct >= 90 ? 'over' : creditPct >= 70 ? 'high' : creditPct >= 40 ? 'mid' : '';

  // Cursor / multi-select painting — reuses the .vrt-row-* classes from
  // VirtualReportTable's stylesheet so the visual treatment matches the
  // rest of the app (accent wash + left border on cursor; softer wash
  // for non-cursor multi rows). Plain-table rows pick these classes up
  // because the selectors target generic `tr.vrt-row-active > td`.
  const cursorClass = isCursor ? ' vrt-row-active' : (isMultiSelected ? ' vrt-row-multi' : '');

  // Last transaction (not loaded until expand — show dash for now)
  const lastTxn = null;

  return (
    <>
      <tr
        className={`row${expanded ? ' expanded' : ''}${cursorClass}`}
        onClick={(e) => {
          // Selection-modifier clicks bypass the expand toggle so a
          // shift-drag through 50 rows doesn't expand 50 ledgers.
          const allowExpand = onClickRow ? onClickRow(idx, e, p) : true;
          if (allowExpand) onExpand();
        }}
      >
        <td>
          <div className="plv-party-inline">
            <Ico.ChevRight className="plv-chev"/>
            <div className="plv-party-nm">
              <div className="main">
                <span className="txt">{p.party_name}</span>
              </div>
              <div className="sub">
                {[p.city, p.gstin].filter(Boolean).join(' · ') || '—'}
              </div>
            </div>
          </div>
        </td>

        {cols.status && (
          <td>
            <span className={`plv-status-tag ${statusCls}`}>{status}</span>
            {!p.is_active && <span className="plv-status-tag blacklist" style={{ marginLeft: 4 }}>Inactive</span>}
          </td>
        )}

        {cols.contact && (
          <td>
            <div className="plv-contact-icons">
              {p.mobile_1 && (
                <>
                  <a className="plv-cib" href={`tel:+91${p.mobile_1}`} onClick={(e) => e.stopPropagation()} title={`Call ${p.mobile_1}`}><Ico.Phone/></a>
                  <a className="plv-cib" href={`https://wa.me/91${p.mobile_1}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`WhatsApp ${p.mobile_1}`}><Ico.WhatsApp/></a>
                </>
              )}
              {p.email && (
                <a className="plv-cib" href={`mailto:${p.email}`} onClick={(e) => e.stopPropagation()} title={p.email}><Ico.Email/></a>
              )}
            </div>
            <div className="plv-contact-phone">{p.mobile_1 || '—'}</div>
          </td>
        )}

        {cols.outstanding && (
          <td className="r">
            {absBal < 0.01 ? (
              <span className="plv-out-v zero plv-num">₹ 0</span>
            ) : (
              <>
                <span className={`plv-out-v plv-num ${owing > 0 ? 'dr' : 'cr'}`}>
                  {fmt(absBal)}
                </span>
                <span className="plv-out-tag">{owing > 0 ? 'Dr' : 'Cr'}</span>
              </>
            )}
          </td>
        )}

        {cols.aging && (
          <td>
            <AgingCell days={p._aging_days} buckets={p._aging_buckets}/>
          </td>
        )}

        {cols.credit && (
          <td>
            <div className="plv-credit-cell">
              {creditLimit > 0 ? (
                <>
                  <div className="plv-credit-num"><b>{creditPct}%</b> of {fmtCompact(creditLimit)}</div>
                  <div className="plv-credit-bar"><div className={`plv-credit-fill ${creditFillCls}`} style={{ width: `${Math.max(2, creditPct)}%` }}/></div>
                </>
              ) : (
                <span className="no-credit">{p.credit_allowed ? 'No limit set' : 'Cash only'}</span>
              )}
            </div>
          </td>
        )}

        {cols.last && (
          <td>
            <LastTxnCell tx={p._last_transaction}/>
          </td>
        )}

        {/* Per-row actions column removed — actions live in the bottom
            ActionStrip and operate on the cursored / selected rows.
            Keeping the <td> empty preserves the existing colgroup width
            so the table layout doesn't shift. */}
        <td className="plv-actions-cell" onClick={(e) => e.stopPropagation()}>
          {!p.is_active && <span className="plv-status-tag blacklist">Inactive</span>}
        </td>
      </tr>

      {/* Expanded row */}
      {expanded && (
        <tr className="exp-content">
          <td colSpan={1 + (cols.status?1:0) + (cols.contact?1:0) + (cols.outstanding?1:0) + (cols.aging?1:0) + (cols.credit?1:0) + (cols.last?1:0) + 1}>
            {expandData?.loading ? (
              <div className="plv-exp-loading"><Spin/> Loading transactions…</div>
            ) : expandData?.error ? (
              <div className="plv-exp-empty">Failed to load transactions for this {isCustomer ? 'customer' : 'supplier'}.</div>
            ) : !expandData?.recent?.length ? (
              <div className="plv-exp-empty">No transactions yet.</div>
            ) : (
              <div className="plv-exp-inner">
                <div>
                  <div className="plv-exp-title">Last 5 transactions</div>
                  {expandData.recent.map((e, i) => <MiniTxnRow key={`${e.ref_number}-${i}`} e={e}/>)}
                </div>
                <div className="plv-stat-panel">
                  {isCustomer ? (
                    <>
                      <div className="plv-stat"><span className="k">30-day sales</span><span className="v plv-num">{fmt(expandData.stats.sales30)}</span></div>
                      <div className="plv-stat"><span className="k">30-day receipts</span><span className="v u plv-num">{fmt(expandData.stats.receipts30)}</span></div>
                      <ProfitStat profit={expandData.profit} period={profitPeriod} onChange={onProfitPeriodChange} isCustomer/>
                      <div className="plv-stat"><span className="k">Lifetime sales</span><span className="v plv-num">{fmtCompact(expandData.stats.lifetimeSales)}</span></div>
                      <div className="plv-stat"><span className="k">Total transactions</span><span className="v plv-num">{expandData.stats.txCount}</span></div>
                    </>
                  ) : (
                    <>
                      <div className="plv-stat"><span className="k">30-day purchases</span><span className="v plv-num">{fmt(expandData.stats.purchases30)}</span></div>
                      <div className="plv-stat"><span className="k">30-day payments</span><span className="v u plv-num">{fmt(expandData.stats.payments30)}</span></div>
                      <ProfitStat profit={expandData.profit} period={profitPeriod} onChange={onProfitPeriodChange} isCustomer={false}/>
                      <div className="plv-stat"><span className="k">Lifetime purchases</span><span className="v plv-num">{fmtCompact(expandData.stats.lifetimePurchases)}</span></div>
                      <div className="plv-stat"><span className="k">Total transactions</span><span className="v plv-num">{expandData.stats.txCount}</span></div>
                    </>
                  )}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* Mini transaction row rendered inside the expanded detail. */
function MiniTxnRow({ e }) {
  const isSale     = e.particulars === 'Sales Bill';
  const isReceipt  = e.particulars === 'Receipt' || e.particulars === 'Payment at Billing';
  const isPurchase = e.particulars === 'Purchase Bill';
  const isPayment  = e.particulars === 'Payment';
  const isOpening  = e.particulars === 'Opening Balance';

  const cls = isSale ? 'sale' : isReceipt ? 'receipt' : isPurchase ? 'purchase' : isPayment ? 'payment' : isOpening ? 'opening' : '';
  const label = e.particulars || 'Entry';
  const debit = parseFloat(e.debit || 0);
  const credit = parseFloat(e.credit || 0);

  return (
    <div className="plv-mini">
      <span className={`type-chip ${cls}`}>{label}</span>
      <button type="button" className="ref-link">{e.ref_number || '—'}</button>
      <span className="d">{fmtDate(e.date)}</span>
      <span style={{ color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.remarks || e.particulars}</span>
      <span className={`r ${debit > 0 ? 'dr' : 'mut'}`}>{debit > 0 ? fmt(debit) : '—'}</span>
      <span className={`r ${credit > 0 ? 'cr' : 'mut'}`}>{credit > 0 ? fmt(credit) : '—'}</span>
    </div>
  );
}

/* Aging cell — how old this party's oldest open bill is, plus a stacked bar
   showing how their open-balance is distributed across the four buckets.
   `days` and `buckets` both come from the list endpoint's enrichment pass.
   `null` means no open bill → show dash. */
function AgingCell({ days, buckets }) {
  if (days == null) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 12 }}>—</span>;
  const cls = days <= 30 ? 'a0' : days <= 60 ? 'a30' : days <= 90 ? 'a60' : 'a90';
  const label = days <= 30 ? 'Not yet due' : days <= 60 ? 'Watchful' : days <= 90 ? 'Chase' : 'Critical';
  const colorKey = cls === 'a0' ? '0' : cls === 'a30' ? '30' : cls === 'a60' ? '60' : '90';
  // Normalise the bucket sums into percentages for a stacked bar. When the
  // server hasn't sent buckets (older cache, empty response), fall back to a
  // single solid fill in the "oldest-bucket" colour so the layout doesn't
  // collapse.
  const segs = (() => {
    if (!buckets) return [{ cls, w: 100 }];
    const tot = (buckets.b0 || 0) + (buckets.b30 || 0) + (buckets.b60 || 0) + (buckets.b90 || 0);
    if (tot <= 0) return [{ cls, w: 100 }];
    return [
      { cls: 'a0',  w: (buckets.b0  || 0) / tot * 100 },
      { cls: 'a30', w: (buckets.b30 || 0) / tot * 100 },
      { cls: 'a60', w: (buckets.b60 || 0) / tot * 100 },
      { cls: 'a90', w: (buckets.b90 || 0) / tot * 100 },
    ].filter(s => s.w > 0);
  })();
  return (
    <div className="plv-aging-cell">
      <div className="plv-aging-days">
        <span className={`plv-num aging-days-${cls}`} style={{ fontSize: 14, fontWeight: 700, color: `var(--plv-age-${colorKey})` }}>
          {days}
        </span>
        <span style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>days oldest</span>
      </div>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
        color: `var(--plv-age-${colorKey})`,
      }}>{label}</span>
      <div className="plv-aging-bar">
        {segs.map((s, i) => (
          <span key={i} className={`plv-aging-seg ${s.cls}`} style={{ width: `${s.w}%` }}/>
        ))}
      </div>
    </div>
  );
}

/* Last transaction cell — renders the single most recent ledger entry
   enriched onto the party list row. Type chip + ref + date. */
function LastTxnCell({ tx }) {
  if (!tx) return (
    <div className="plv-last-cell"><span className="na">No transactions yet</span></div>
  );
  const type = tx.type || '';
  const cls =
    type === 'Sales Bill'    ? 'sale-bill' :
    type === 'Purchase Bill' ? 'purchase-bill' :
    type === 'Receipt'       ? 'receipt' :
    type === 'Payment'       ? 'payment' :
    'opening';
  return (
    <div className="plv-last-cell">
      <span className={`type ${cls}`}>{type}</span>
      <span className="ref">{tx.ref}{tx.amt ? ` · ${fmt(tx.amt)}` : ''}</span>
      <span className="dt">{fmtDate(tx.dt)}</span>
    </div>
  );
}

/* Profit stat — gross profit for the selected period with an inline FY /
   lifetime toggle. Pulls from GET /api/parties/:id/profit which uses the
   COGS snapshot stored on each sales_bill_items row. For suppliers this
   shows gross purchase spend instead (see backend for why). */
function ProfitStat({ profit, period, onChange, isCustomer }) {
  // Render a neutral placeholder while the first fetch is in flight.
  if (!profit) {
    return (
      <div className="plv-stat">
        <span className="k">{isCustomer ? 'Gross profit' : 'Gross spend'}</span>
        <span className="v plv-num" style={{ color: 'var(--fg-tertiary)' }}>…</span>
      </div>
    );
  }
  const value = isCustomer ? profit.profit : profit.purchases;
  const isPos = (value || 0) >= 0;
  return (
    <div className="plv-stat" style={{
      background: isCustomer ? 'linear-gradient(135deg, var(--success-bg), transparent 65%)' : undefined,
      borderColor: isCustomer ? 'color-mix(in srgb, var(--success) 24%, var(--border))' : undefined,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span className="k">{isCustomer ? 'Gross profit' : 'Gross spend'}</span>
        <select
          value={period}
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          style={{
            appearance: 'none',
            WebkitAppearance: 'none',
            padding: '1px 18px 1px 7px',
            background: `var(--bg-panel) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239B8F7E' stroke-width='3'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 5px center`,
            border: '1px solid var(--border)',
            borderRadius: 99,
            fontSize: 10, fontWeight: 700, color: 'var(--fg-secondary)',
            cursor: 'pointer',
            width: 'fit-content',
          }}
        >
          <option value="fy-current">{profit.period === 'fy-current' ? profit.label : 'FY (current)'}</option>
          <option value="fy-previous">FY (previous)</option>
          <option value="lifetime">Lifetime</option>
        </select>
      </div>
      <span className="v plv-num" style={{ color: isCustomer && isPos ? 'var(--success)' : isCustomer ? 'var(--danger)' : 'var(--fg-primary)' }}>
        {fmt(value || 0)}
        {isCustomer && profit.margin_pct != null && (
          <span style={{ fontSize: 10, color: 'var(--fg-tertiary)', marginLeft: 6, fontWeight: 600 }}>
            {profit.margin_pct.toFixed(1)}%
          </span>
        )}
      </span>
    </div>
  );
}

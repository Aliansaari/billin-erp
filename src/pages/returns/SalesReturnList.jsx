import React, { useEffect, useState, useCallback } from 'react';
import {
  Tag, Typography, message, DatePicker, Select, Tooltip,
  Modal, Descriptions, Divider, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined, MoreOutlined,
  CopyOutlined, SettingOutlined, FileTextOutlined, LinkOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesReturnAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import '../../styles/bill-list.css';
import './return-list.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  SalesReturnList — virtualized list with editorial visual treatment
 *  preserved via column renders. Mirrors SalesList's structure with return
 *  semantics:
 *    · bill_number     → return_number (SR-xxxx)
 *    · payment_status  → refund_status (Refunded / Partial / Pending)
 *    · paid_amount     → refund_amount (cash paid back to customer)
 *    · balance_amount  → credit still owed to the customer
 *    · total_amount    → credit note value (we owe this to the customer)
 * ═══════════════════════════════════════════════════════════════════════════ */

const OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'ref',      label: 'Reference bill' },
  { key: 'mode',     label: 'Return mode' },
  { key: 'reason',   label: 'Reason' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
// Toggleable page sections (not data columns).
const SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v2 introduces the `time` column + `totalRow` section toggle. Existing
// users on v1 get the new keys merged with their saved prefs.
const COLS_STORAGE_KEY = 'salesReturnList_cols_v2';
const DEFAULT_COLS = {
  time: true, ref: true, mode: true, reason: false, gst: false, discount: false,
  totalRow: true,
};

const { Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

// ── View Modal ─────────────────────────────────────────────────────────────────
function SummaryRow({ label, value, color, bold, borderTop }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', borderTop: borderTop ? '1px solid var(--border)' : undefined,
      fontWeight: bold ? 700 : 400, fontSize: bold ? 14 : 13, color: color || undefined,
    }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function ViewModal({ bill, onClose }) {
  if (!bill) return null;
  const items = bill.items || [];
  const cgst = parseFloat(bill.cgst_amount || 0);
  const sgst = parseFloat(bill.sgst_amount || 0);
  const igst = parseFloat(bill.igst_amount || 0);
  const discount = parseFloat(bill.discount_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Barcode', dataIndex: 'barcode', width: 110, render: v => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70 },
    { title: 'Qty', dataIndex: 'quantity', width: 65, align: 'right' },
    { title: 'Rate', dataIndex: 'rate', width: 90, align: 'right', render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
    { title: 'Amount', dataIndex: 'total_amount', width: 100, align: 'right', render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
  ];

  return (
    <Modal open onCancel={onClose} width={960} footer={null}
      title={<span style={{ fontWeight: 700 }}>Sales Return — {bill.return_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Return No">{bill.return_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.return_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Customer">{bill.customer?.party_name || '—'}</Descriptions.Item>
        <Descriptions.Item label="Mode">
          <Tag color={bill.return_mode === 'Amount' ? 'purple' : 'blue'}>{bill.return_mode}</Tag>
        </Descriptions.Item>
        {bill.reference_bill_number && (
          <Descriptions.Item label="Against bill" span={2}>
            <span style={{ fontWeight: 600 }}>{bill.reference_bill_number}</span>
          </Descriptions.Item>
        )}
        {bill.reason && <Descriptions.Item label="Reason" span={2}>{bill.reason}</Descriptions.Item>}
        <Descriptions.Item label="Status">
          <Tag color={bill.refund_status === 'Refunded' ? 'green' : bill.refund_status === 'Partial' ? 'orange' : 'red'}>
            {bill.refund_status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Refund mode">{bill.refund_method}</Descriptions.Item>
        {bill.remarks && <Descriptions.Item label="Remarks" span={2}>{bill.remarks}</Descriptions.Item>}
      </Descriptions>

      {bill.return_mode !== 'Amount' && (
        <Table columns={itemColumns} dataSource={items} rowKey="item_id"
          pagination={false} size="small" scroll={{ x: 600 }} />
      )}

      <Divider style={{ margin: '12px 0' }} />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: 300 }}>
          <SummaryRow label="Sub Total" value={fmt(bill.sub_total)} />
          {discount > 0 && (
            <SummaryRow label={`Discount${bill.discount_percentage > 0 ? ` (${bill.discount_percentage}%)` : ''}`}
              value={`- ${fmt(discount)}`} color="#d97706" />
          )}
          {igst > 0 && (<SummaryRow label={`IGST${bill.igst_pct > 0 ? ` (${bill.igst_pct}%)` : ''}`} value={fmt(igst)} />)}
          {cgst > 0 && (<SummaryRow label={`CGST${bill.cgst_pct > 0 ? ` (${bill.cgst_pct}%)` : ''}`} value={fmt(cgst)} />)}
          {sgst > 0 && (<SummaryRow label={`SGST${bill.sgst_pct > 0 ? ` (${bill.sgst_pct}%)` : ''}`} value={fmt(sgst)} />)}
          {roundOff !== 0 && (<SummaryRow label="Round Off" value={roundOff.toFixed(2)} />)}
          <SummaryRow label="Credit Total" value={fmt(bill.total_amount)} bold borderTop />
          <SummaryRow label="Refunded" value={fmt(bill.refund_amount)} color="var(--success)" />
          <SummaryRow label="Credit pending" value={fmt(balance)}
            color={balance > 0 ? 'var(--danger)' : 'var(--success)'} bold borderTop />
        </div>
      </div>
    </Modal>
  );
}

// ── Circular ring ──────────────────────────────────────────────────────────────
function Ring({ pct, tone = 'ok' }) {
  const C = 138.23;
  const p = Math.max(0, Math.min(100, pct));
  const offset = C * (1 - p / 100);
  return (
    <div className="kpi-ring" aria-label={`${Math.round(p)}%`}>
      <svg viewBox="0 0 56 56">
        <circle className="track" cx="28" cy="28" r="22" fill="none" strokeWidth="3.5"/>
        <circle className={tone === 'bad' ? 'fill-bad' : 'fill-ok'}
          cx="28" cy="28" r="22" fill="none" strokeWidth="3.5"
          strokeDasharray={C} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 28 28)"/>
      </svg>
      <span className="label">{Math.round(p)}%</span>
    </div>
  );
}

// ── Main list ──────────────────────────────────────────────────────────────────
export default function SalesReturnList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({ search: '', refund_status: null, from_date: fyStart, to_date: fyEnd });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [viewBill, setViewBill]       = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [companyName, setCompanyName] = useState('');

  // Virtualized data layer — server returns paginated chunks + summary.
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => salesReturnAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); } catch {}
  }, [cols]);
  const visibleOptionalCount = OPTIONAL_COLS.filter((c) => cols[c.key]).length;

  const navigate = useNavigate();

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
  }, []);

  const handleCancel = async (id) => {
    try {
      await salesReturnAPI.cancel(id);
      message.success('Return cancelled');
      refresh();
    } catch (e) {
      Modal.error({
        title: 'Cannot cancel return', icon: null, width: 500,
        content: (
          <div style={{ paddingTop: 8 }}>
            <div style={{ background:'#fef2f2', border:'1px solid #fca5a5', borderRadius:8, padding:'12px 16px', marginBottom:12, color:'#7f1d1d', fontSize:13, lineHeight:1.6 }}>
              {e.response?.data?.error || 'Failed to cancel'}
            </div>
            <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#1e40af', lineHeight:1.6 }}>
              💡 Cancelling restores the returned stock and reverses the customer credit.
            </div>
          </div>
        ),
        okText: 'Got it', okButtonProps: { danger: true },
      });
    }
  };

  const fetchBill = useCallback(async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: true }));
    try {
      const { data } = await salesReturnAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load return');
      return null;
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
    }
  }, []);

  const handleView  = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint = (id) => printDocument({ docType: 'sales_return', id });
  const handleEdit  = (id) => navigate(`/sales-return/edit/${id}`);

  // KPI values from server-aggregated summary so they reflect the full
  // filtered set, not just chunks the user has scrolled past.
  const totalAmount = parseFloat(summary?.total_amount || 0);
  const refunded    = parseFloat(summary?.total_refund || 0);
  const pending     = parseFloat(summary?.total_pending || 0);
  const openCredits = summary?.open_count || 0;
  const returnCount = summary?.count || totalCount;
  const avg         = returnCount > 0 ? totalAmount / returnCount : 0;
  const refundedPct = totalAmount > 0 ? (refunded / totalAmount) * 100 : 0;
  const pendingPct  = totalAmount > 0 ? (pending  / totalAmount) * 100 : 0;

  const columns = [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>,
    },
    {
      key: 'bill', title: 'Return #', dataIndex: 'return_number', width: 130,
      render: (v, r) => (
        <span className="bill-no">
          {v}
          {r.godown && (
            <span title={`Godown: ${r.godown.name}`} style={{
              marginLeft: 6, padding: '1px 5px', fontSize: 10, fontWeight: 600,
              border: '1px solid var(--border, #e5e7eb)', borderRadius: 4,
              color: 'var(--fg-secondary, #6b7280)', background: 'var(--bg-subtle, #f9fafb)',
              fontFamily: 'var(--font-mono, monospace)', verticalAlign: 'middle',
            }}>{r.godown.code}</span>
          )}
        </span>
      ),
    },
    {
      key: 'date', title: 'Date', dataIndex: 'return_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    cols.time && {
      key: 'time', title: 'Time', width: 90,
      render: (_v, r) => {
        const timeSource = r.createdAt || r.created_date || null;
        const t = timeSource ? dayjs(timeSource) : null;
        return t
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{t.format('h:mm a')}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    {
      key: 'cust', title: 'Customer', dataIndex: ['customer', 'party_name'], width: 200,
      render: (v, r) => (
        <div className="stk">
          <span className="m">{v || '—'}</span>
          <span className="s">{r.customer?.mobile_1 || ' '}</span>
        </div>
      ),
    },
    cols.ref && {
      key: 'ref', title: 'Ref bill', dataIndex: 'reference_bill_number', width: 160,
      render: (v) => v
        ? <div className="stk">
            <span className="m ref-num"><LinkOutlined /> {v}</span>
            <span className="s">Linked invoice</span>
          </div>
        : <span className="amt zero" style={{ fontStyle: 'italic' }}>Standalone</span>,
    },
    cols.mode && {
      key: 'mode', title: 'Mode', dataIndex: 'return_mode', width: 110,
      render: (v) => (
        <span className={`mode-pill mode-${(v || 'items').toLowerCase()}`}>
          {v === 'Amount' ? <FileTextOutlined /> : null}
          {v}
        </span>
      ),
    },
    cols.reason && {
      key: 'reason', title: 'Reason', dataIndex: 'reason', width: 200,
      render: (v) => <span className="reason-text" title={v || ''}>{v || '—'}</span>,
    },
    {
      key: 'total', title: 'Total', dataIndex: 'total_amount', width: 120, align: 'right',
      render: (v, r) => (
        <span className={`amt${r.is_cancelled ? ' muted' : ''}`}>
          <span className="rs">₹</span>{Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}
        </span>
      ),
    },
    cols.gst && {
      key: 'gst', title: 'GST', width: 100, align: 'right',
      render: (_, r) => {
        const amt = parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0) + parseFloat(r.igst_amount || 0);
        return amt > 0.01
          ? <span className="amt"><span className="rs">₹</span>{Math.round(amt).toLocaleString('en-IN')}</span>
          : <span className="amt zero">—</span>;
      },
    },
    cols.discount && {
      key: 'discount', title: 'Discount', dataIndex: 'discount_amount', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    {
      key: 'refunded', title: 'Refunded', dataIndex: 'refund_amount', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    {
      key: 'pending', title: 'Pending', dataIndex: 'balance_amount', width: 130, align: 'right',
      render: (v, r) => {
        const balance = parseFloat(v || 0);
        if (r.is_cancelled) return <span className="voided-tag">Voided</span>;
        if (balance < 0.01) return <span className="settled-tag">Settled</span>;
        return <span className="amt due"><span className="rs">₹</span>{Math.round(balance).toLocaleString('en-IN')}</span>;
      },
    },
    {
      key: 'actions', title: '', width: 130, align: 'center', fixed: 'right',
      render: (_, r) => {
        const cancelled = !!r.is_cancelled;
        const moreMenu = {
          items: [
            { key: 'edit',  icon: <EditOutlined />, label: 'Edit return', onClick: () => handleEdit(r.sales_return_id), disabled: cancelled },
            { key: 'dup',   icon: <CopyOutlined />, label: 'Duplicate to new return', onClick: () => handleEdit(r.sales_return_id), disabled: cancelled },
            { type: 'divider' },
            {
              key: 'cancel', icon: <StopOutlined />,
              label: cancelled ? 'Already cancelled' : 'Cancel return',
              danger: true, disabled: cancelled,
              onClick: () => {
                Modal.confirm({
                  title: `Cancel return ${r.return_number}?`,
                  content: 'Cancelling reverses the customer credit, removes the stock-ledger "Sales Return" row, and pulls the returned stock back out of inventory.',
                  okText: 'Cancel this return', okButtonProps: { danger: true },
                  cancelText: 'Keep it',
                  onOk: () => handleCancel(r.sales_return_id),
                });
              },
            },
          ],
        };
        const isLoading = !!actionLoading[r.sales_return_id];
        // Override the legacy `.act-box .group { opacity:0 }` hover-reveal —
        // it depended on `.brow.data:hover` which no longer matches inside
        // an Antd table cell.
        const groupStyle = { justifyContent: 'center', opacity: 1, transform: 'none', pointerEvents: 'auto' };
        return (
          <div className="act-box">
            <div className="group" style={groupStyle}>
              <Tooltip title="View">
                <button className="abtn" onClick={(e) => { e.stopPropagation(); handleView(r.sales_return_id); }} disabled={isLoading}>
                  <EyeOutlined />
                </button>
              </Tooltip>
              <Tooltip title="Print">
                <button className="abtn" onClick={(e) => { e.stopPropagation(); handlePrint(r.sales_return_id); }} disabled={isLoading}>
                  <PrinterOutlined />
                </button>
              </Tooltip>
              <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight">
                <button className="abtn" onClick={(e) => e.stopPropagation()} disabled={isLoading}>
                  <MoreOutlined />
                </button>
              </Dropdown>
            </div>
          </div>
        );
      },
    },
  ].filter(Boolean);

  // Bottom Total strip — driven by server-aggregated summary.
  const SUMMABLE_KEYS = new Set(['total', 'refunded', 'pending', 'gst', 'discount']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const totalForKey = (k) => {
    switch (k) {
      case 'total':    return <strong><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_amount  || 0)).toLocaleString('en-IN')}</strong>;
      case 'refunded': return <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_refund || 0)).toLocaleString('en-IN')}</span>;
      case 'pending':  return <span className="amt due"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_pending || 0)).toLocaleString('en-IN')}</span>;
      case 'gst':      return parseFloat(summary?.total_gst      || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_gst)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      case 'discount': return parseFloat(summary?.total_discount || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_discount)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      default:         return null;
    }
  };
  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount} return${totalCount === 1 ? '' : 's'})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    return totalForKey(col.key);
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  return (
    <div className="blist-page rlist-page">

      <div className="blist-hd">
        <div className="blist-title">
          <h1>Sales Returns</h1>
          <div className="sub"><b>{totalCount}</b> credit note{totalCount === 1 ? '' : 's'}</div>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              type="text"
              placeholder="Search return no or ref bill"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <DatePicker.RangePicker
            size="middle" format="DD MMM"
            placeholder={['From', 'To']}
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => setFilters(f => ({
              ...f,
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date:   v?.[1]?.format('YYYY-MM-DD') || null,
            }))}
            style={{ height: 34, width: 220 }}
          />
          <Select
            placeholder="All statuses" allowClear
            style={{ width: 130, height: 34 }}
            onChange={(v) => setFilters(f => ({ ...f, refund_status: v }))}
            options={[
              { value: 'Refunded', label: 'Refunded' },
              { value: 'Partial',  label: 'Partial'  },
              { value: 'Pending',  label: 'Pending'  },
            ]}
          />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => (
              <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
                <div className="mh">Optional columns</div>
                {OPTIONAL_COLS.map(c => (
                  <label key={c.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[c.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
                    />
                    {c.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh">Sections</div>
                {SECTIONS.map(s => (
                  <label key={s.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[s.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [s.key]: e.target.checked }))}
                    />
                    {s.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Return # · Date · Customer</span><span className="pin">Pinned</span></label>
                <label className="opt"><span>Total · Refunded · Pending</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <SettingOutlined /> Customize
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
          <button className="blist-cta" onClick={() => navigate('/sales-return/new')}>
            <PlusOutlined /> New Return
          </button>
        </div>
      </div>

      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Returns · This View</div>
            <div className="v">{fmt(totalAmount)}</div>
            <div className="sub">{returnCount} returns · avg {fmtShort(avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Refunded</div>
            <div className="v">{fmt(refunded)}</div>
            <div className="sub">of {fmtShort(totalAmount)} credited</div>
          </div>
          <Ring pct={refundedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Credit Pending</div>
            <div className="v">{fmt(pending)}</div>
            <div className="sub">from {openCredits} open credit note{openCredits === 1 ? '' : 's'}</div>
          </div>
          <Ring pct={pendingPct} tone="bad" />
        </div>
      </div>

      <div className="blist-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="sales_return_id"
          scroll={{ x: 1200 }}
          rowClassName={(r) => r && r.is_cancelled ? 'blist-row-cancelled' : ''}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
        />
      </div>

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  LeftOutlined,
  SearchOutlined,
  FilterOutlined,
  FilePdfOutlined,
} from '@ant-design/icons';
import { Toast } from 'antd-mobile';
import { salesAPI, purchaseAPI, paymentAPI } from '../../api';
import {
  formatINRWithSymbol,
  formatShortDate,
  defaultFY,
  formatDateRange,
} from '../utils/format';

// Voucher types we surface in the chip row. Each maps to (a) the API call,
// (b) the field that holds the party name in the response row, and (c) the
// drill route prefix used to open the bill detail. Adding a type means adding
// a row here — no other place needs touching.
const TYPES = [
  { key: 'sales',     label: 'Sales',        api: salesAPI,    party: 'customer_name', idField: 'sales_bill_id',    route: 'sales'    },
  { key: 'purchase',  label: 'Purchase',     api: purchaseAPI, party: 'supplier_name', idField: 'purchase_bill_id', route: 'purchase' },
  { key: 'receipt',   label: 'Receipt',      api: paymentAPI,  party: 'party_name',    idField: 'payment_id',       route: 'receipt'  },
  { key: 'payment',   label: 'Payment',      api: paymentAPI,  party: 'party_name',    idField: 'payment_id',       route: 'payment'  },
];

function fetchFor(type) {
  // Receipt / Payment share the same payments endpoint; the type filter is
  // applied client-side until we get a dedicated server-side filter.
  if (type.key === 'receipt')  return type.api.getAll({ payment_type: 'Receipt' });
  if (type.key === 'payment')  return type.api.getAll({ payment_type: 'Payment' });
  return type.api.getAll({ limit: 50 });
}

function rowsFromResponse(type, data) {
  // Each list endpoint returns either { data: [...] } or a bare array.
  // Normalize so the renderer below stays simple.
  const raw = Array.isArray(data) ? data : (data?.data || []);
  return raw.map((r) => ({
    id:        r[type.idField],
    number:    r.bill_number || r.payment_number || r.transaction_number || `#${r[type.idField]}`,
    date:      r.bill_date    || r.payment_date  || r.transaction_date,
    party:     r[type.party]  || r.party_name    || 'Cash',
    amount:    Number(r.total_amount || r.amount || 0),
  }));
}

export default function VouchersList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialType = params.get('type') || 'sales';
  const [activeType, setActiveType] = useState(
    TYPES.find((t) => t.key === initialType) ? initialType : 'sales'
  );
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const fy = defaultFY();

  useEffect(() => {
    setParams({ type: activeType }, { replace: true });
  }, [activeType, setParams]);

  useEffect(() => {
    const type = TYPES.find((t) => t.key === activeType);
    if (!type) return;
    let cancelled = false;
    setLoading(true);
    fetchFor(type)
      .then((res) => { if (!cancelled) setRows(rowsFromResponse(type, res.data)); })
      .catch((e) => {
        if (cancelled) return;
        const msg = e?.response?.data?.error || e?.message || 'Failed to load vouchers';
        Toast.show({ icon: 'fail', content: msg });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeType]);

  const total = useMemo(() => rows.reduce((sum, r) => sum + (r.amount || 0), 0), [rows]);

  const openBill = (row) => {
    const type = TYPES.find((t) => t.key === activeType);
    navigate(`/vouchers/${type.route}/${row.id}`);
  };

  return (
    <div className="mobile-screen drill-in">
      <div className="topbar safe-area-top">
        <button className="topbar-icon-btn" onClick={() => navigate(-1)} aria-label="back">
          <LeftOutlined />
        </button>
        <div className="topbar-title">
          <h1>Vouchers</h1>
          <div className="sub">{formatINRWithSymbol(total)} · {formatDateRange(fy.from, fy.to)}</div>
        </div>
        <button className="topbar-icon-btn" aria-label="search"><SearchOutlined /></button>
        <button className="topbar-icon-btn" aria-label="filter"><FilterOutlined /></button>
        <button className="topbar-icon-btn" aria-label="export pdf">
          <FilePdfOutlined style={{ color: 'var(--c-error)' }} />
        </button>
      </div>

      <div className="mobile-screen-body">
        <div className="chip-row">
          {TYPES.map((t) => (
            <button
              key={t.key}
              className={`chip${activeType === t.key ? ' active' : ''}`}
              onClick={() => setActiveType(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="empty">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="empty">No vouchers in this period.</div>
        )}

        {!loading && rows.length > 0 && (
          <div className="voucher-list">
            {rows.map((r) => (
              <div key={r.id} className="voucher-row tap-surface" onClick={() => openBill(r)}>
                <div className="vr-main">
                  <div className="vr-meta">
                    <span className="vr-num">{r.number}</span>
                    <span>·</span>
                    <span>{formatShortDate(r.date)}</span>
                  </div>
                  <div className="vr-name">{r.party}</div>
                </div>
                <div className="vr-amount">{formatINRWithSymbol(r.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

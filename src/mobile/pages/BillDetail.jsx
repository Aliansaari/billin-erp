import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LeftOutlined, ShareAltOutlined, FilePdfOutlined } from '@ant-design/icons';
import { Toast } from 'antd-mobile';
import { salesAPI, purchaseAPI, paymentAPI } from '../../api';
import { formatINRWithSymbol, formatShortDate } from '../utils/format';

// Drill target shapes vary slightly per voucher type. This map lets the
// component fetch + render any of them with the same code path.
const TYPE_CONFIG = {
  sales: {
    label:    'Sales',
    fetch:    (id) => salesAPI.getById(id),
    nameKey:  'customer_name',
    items:    'items',          // line items array on the bill
  },
  purchase: {
    label:    'Purchase',
    fetch:    (id) => purchaseAPI.getById(id),
    nameKey:  'supplier_name',
    items:    'items',
  },
  receipt: {
    label:    'Receipt',
    fetch:    (id) => paymentAPI.getById(id),
    nameKey:  'party_name',
    items:    null,             // payments don't carry product lines
  },
  payment: {
    label:    'Payment',
    fetch:    (id) => paymentAPI.getById(id),
    nameKey:  'party_name',
    items:    null,
  },
};

export default function BillDetail() {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const cfg = TYPE_CONFIG[type];

  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    setLoading(true);
    cfg.fetch(id)
      .then((res) => { if (!cancelled) setBill(res.data); })
      .catch((e) => {
        if (cancelled) return;
        const msg = e?.response?.data?.error || e?.message || 'Failed to load bill';
        Toast.show({ icon: 'fail', content: msg });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, id, cfg]);

  if (!cfg) {
    return (
      <div className="mobile-screen drill-in">
        <div className="topbar safe-area-top">
          <button className="topbar-icon-btn" onClick={() => navigate(-1)} aria-label="back">
            <LeftOutlined />
          </button>
          <div className="topbar-title"><h1>Unknown voucher type</h1></div>
        </div>
      </div>
    );
  }

  const billNumber = bill?.bill_number || bill?.payment_number || bill?.transaction_number || `#${id}`;
  const billDate   = bill?.bill_date   || bill?.payment_date   || bill?.transaction_date;
  const partyName  = bill?.[cfg.nameKey] || bill?.party_name   || 'Cash';
  const items      = cfg.items ? (bill?.[cfg.items] || []) : [];
  const total      = Number(bill?.total_amount ?? bill?.amount ?? 0);
  const subtotal   = Number(bill?.subtotal ?? bill?.taxable_amount ?? total);
  const tax        = Number((bill?.cgst_amount || 0)) + Number((bill?.sgst_amount || 0))
                   + Number((bill?.igst_amount || 0)) + Number((bill?.cess_amount || 0));
  const balance    = Number(bill?.balance_amount ?? 0);

  return (
    <div className="mobile-screen drill-in">
      <div className="topbar safe-area-top">
        <button className="topbar-icon-btn" onClick={() => navigate(-1)} aria-label="back">
          <LeftOutlined />
        </button>
        <div className="topbar-title">
          <h1>{billNumber}</h1>
          <div className="sub">{cfg.label} · {formatShortDate(billDate)}</div>
        </div>
        <button className="topbar-icon-btn" aria-label="share"><ShareAltOutlined /></button>
        <button className="topbar-icon-btn" aria-label="pdf">
          <FilePdfOutlined style={{ color: 'var(--c-error)' }} />
        </button>
      </div>

      <div className="mobile-screen-body">
        {loading && <div className="empty">Loading…</div>}

        {!loading && bill && (
          <>
            <div className="detail-card">
              <div className="detail-row">
                <span className="dr-key">{cfg.label === 'Purchase' ? 'Supplier' : (cfg.label === 'Sales' ? 'Customer' : 'Party')}</span>
                <span className="dr-val">{partyName}</span>
              </div>
              <div className="detail-row">
                <span className="dr-key">Date</span>
                <span className="dr-val">{formatShortDate(billDate)}</span>
              </div>
              {balance > 0 && (
                <div className="detail-row">
                  <span className="dr-key">Balance Due</span>
                  <span className="dr-val" style={{ color: 'var(--c-warning)' }}>
                    {formatINRWithSymbol(balance)}
                  </span>
                </div>
              )}
            </div>

            {items.length > 0 && (
              <div className="detail-card">
                <div style={{ fontSize: 13, color: 'var(--c-text-soft)', fontWeight: 600, marginBottom: 4 }}>
                  Items
                </div>
                {items.map((it, i) => (
                  <div key={it.sales_bill_item_id || it.purchase_bill_item_id || i} className="detail-item">
                    <div className="di-main">
                      <div className="di-name">{it.product_name || it.description || 'Item'}</div>
                      <div className="di-meta">
                        {Number(it.quantity || 0)} {it.unit || 'pcs'} × {formatINRWithSymbol(Number(it.rate || 0))}
                      </div>
                    </div>
                    <div className="di-amount">{formatINRWithSymbol(Number(it.total_amount || 0))}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="detail-card">
              <div className="detail-row">
                <span className="dr-key">Subtotal</span>
                <span className="dr-val">{formatINRWithSymbol(subtotal)}</span>
              </div>
              {tax > 0 && (
                <div className="detail-row">
                  <span className="dr-key">Tax</span>
                  <span className="dr-val">{formatINRWithSymbol(tax)}</span>
                </div>
              )}
              <div className="detail-row total">
                <span className="dr-key">Total</span>
                <span className="dr-val">{formatINRWithSymbol(total)}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

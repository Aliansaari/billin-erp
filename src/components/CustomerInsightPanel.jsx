/**
 * CustomerInsightPanel.jsx
 *
 * F8 Party Insight Modal — FY + all-time metrics, profit, visit/purchase
 * behavior (incl. average pay time), and top products. Works for BOTH
 * customers (sales form) and suppliers (purchase form) via the `role` prop.
 *
 * Props:
 *   open      {boolean}
 *   onClose   {Function}                       — Esc / X / F8
 *   partyId   {number}
 *   settings  {object}                          — system settings (toggles)
 *   role      {'customer'|'supplier'}           — defaults to 'customer'
 */

import React, { useEffect, useRef, useState } from 'react';
import { Modal, Skeleton, Button } from 'antd';
import {
  CalendarOutlined, ClockCircleOutlined, CreditCardOutlined,
  RiseOutlined, TeamOutlined, FieldTimeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { partyAPI } from '../api';
import './CustomerInsightPanel.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtMoney(val) {
  const n = parseFloat(val || 0);
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtNum(val) {
  return parseFloat(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtPayTime(days) {
  if (days == null) return null;
  const d = Number(days);
  if (d <= 0) return 'Same day';
  if (d < 1)  return '< 1 day';
  const rounded = d % 1 === 0 ? d : d.toFixed(1);
  return `${rounded} day${d >= 2 ? 's' : ''}`;
}
/** A settings toggle is ON unless explicitly false (defaults to true). */
function tog(settings, key) {
  if (!settings) return true;
  const v = settings[key];
  return v === null || v === undefined ? true : !!v;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function StatCell({ label, value, sub, className = '' }) {
  return (
    <div className="cip-stat">
      <div className="cip-stat-label">{label}</div>
      <div className={`cip-stat-value ${className}`}>{value}</div>
      {sub && <div className="cip-stat-sub">{sub}</div>}
    </div>
  );
}
function SectionCard({ title, children }) {
  return (
    <div className="cip-card">
      {title && <div className="cip-card-title">{title}</div>}
      {children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CustomerInsightPanel({ open, onClose, partyId, settings, role = 'customer' }) {
  const navigate = useNavigate();
  const isSupplier = role === 'supplier';
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const reqRef                = useRef(0);

  // Load whenever the panel opens for a party
  useEffect(() => {
    if (!open || !partyId) return;
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    partyAPI.getInsights(partyId, isSupplier ? 'supplier' : 'customer')
      .then(res => { if (myReq === reqRef.current) setData(res.data); })
      .catch(() => { if (myReq === reqRef.current) setError('Failed to load insights.'); })
      .finally(() => { if (myReq === reqRef.current) setLoading(false); });
  }, [open, partyId, isSupplier]);

  // F8 closes
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'F8') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const party   = data?.party           || {};
  const fy      = data?.fy_metrics       || {};
  const at      = data?.alltime_metrics  || {};
  const beh     = data?.behavior         || {};
  const tops    = data?.top_products     || [];
  const fyLabel = data?.fy_label         || 'Current FY';

  const displayName   = party.display_name || party.party_name || '';
  const mobile        = party.mobile_1 || '';
  const city          = party.city || '';
  const isActive      = party.is_active !== false;
  const creditAllowed = !!party.credit_allowed;
  const isBlacklisted = party.party_status === 'Blacklisted';
  const balance       = parseFloat(party.current_balance || 0);
  const balanceAbs    = Math.abs(balance);
  const balanceDrCr   = balance > 0 ? 'Dr' : balance < 0 ? 'Cr' : '';
  const balanceWord   = isSupplier ? 'Payable' : 'Outstanding';
  const creditLimit   = parseFloat(party.credit_limit || 0);
  const creditUsedPct = creditLimit > 0 ? Math.min((balanceAbs / creditLimit) * 100, 100) : 0;
  const creditBarCls  = creditUsedPct >= 100 ? 'cip-credit-over' : creditUsedPct >= 80 ? 'cip-credit-warn' : '';

  const noFyActivity = !fy.bill_count;

  // Role-aware labels
  const revLabel      = isSupplier ? 'Purchases'       : 'Revenue';
  const lifeRevLabel  = isSupplier ? 'Lifetime Spend'  : 'Lifetime Revenue';
  const behTitle      = isSupplier ? 'Purchase Behavior' : 'Visit Behavior';
  const lastLabel     = isSupplier ? 'Last purchase'   : 'Last visit';
  const firstLabel    = isSupplier ? 'First purchase'  : 'First visit';
  const freqLabel     = isSupplier ? 'Purchase frequency' : 'Visit frequency';
  const payTimeLabel  = isSupplier ? 'Avg time to pay' : 'Avg pay time';
  const topValHeader  = isSupplier ? 'Value' : 'Revenue';

  // Toggles
  const showFy        = tog(settings, 'insight_show_fy_metrics');
  const showAt        = tog(settings, 'insight_show_alltime_metrics');
  const showProfit    = tog(settings, 'insight_show_profit') && !isSupplier;
  const showBehavior  = tog(settings, 'insight_show_behavior');
  const showTopProd   = tog(settings, 'insight_show_top_products');
  const showBillStat  = tog(settings, 'insight_show_bill_stats');
  const showPayTime   = tog(settings, 'insight_show_pay_time');
  const showLifeProfit = tog(settings, 'insight_show_lifetime_profit') && !isSupplier;

  const payTimeText = fmtPayTime(beh.avg_pay_days);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={920}
      className="cip-modal"
      footer={null}
      centered
      title={null}
      destroyOnClose
    >
      {/* Header */}
      <div className="cip-header">
        <div className="cip-header-top">
          <div className="cip-header-left">
            <div className="cip-name">{displayName || '—'}</div>
            <div className="cip-sub">{[mobile, city].filter(Boolean).join('  ·  ')}</div>
          </div>
          {balance !== 0 && (
            <div className="cip-header-right">
              <div className="cip-balance">{fmtMoney(balanceAbs)}</div>
              <div className="cip-balance-label">{balanceDrCr} {balanceWord}</div>
            </div>
          )}
        </div>

        <div className="cip-badges">
          <span className="cip-badge cip-badge-role">{isSupplier ? 'Supplier' : 'Customer'}</span>
          <span className={`cip-badge ${isActive ? 'cip-badge-active' : 'cip-badge-inactive'}`}>
            {isActive ? 'Active' : 'Inactive'}
          </span>
          {creditAllowed && !isBlacklisted && <span className="cip-badge cip-badge-credit">Credit Allowed</span>}
          {isBlacklisted && <span className="cip-badge cip-badge-blacklisted">Blacklisted</span>}
        </div>

        {creditLimit > 0 && (
          <div className="cip-credit-bar-wrap">
            <div className="cip-credit-bar-meta">
              <span>Credit used: {fmtMoney(balanceAbs)} / {fmtMoney(creditLimit)}</span>
              <span>{creditUsedPct.toFixed(0)}%</span>
            </div>
            <div className="cip-credit-bar">
              <div className={`cip-credit-bar-fill ${creditBarCls}`} style={{ width: `${creditUsedPct}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      {loading && (
        <div className="cip-skeleton">
          <Skeleton active paragraph={{ rows: 3 }} />
          <Skeleton active paragraph={{ rows: 3 }} />
        </div>
      )}

      {!loading && error && <div className="cip-body"><div className="cip-empty">{error}</div></div>}

      {!loading && !error && data && (
        <div className="cip-body">

          {/* Row 1: FY + All-time */}
          {(showFy || showAt) && (
            <div className={`cip-row${(!showFy || !showAt) ? ' cip-row-full' : ''}`}>
              {showFy && (
                <SectionCard title={`${fyLabel} Overview`}>
                  {noFyActivity ? (
                    <div className="cip-empty">No activity this financial year</div>
                  ) : (
                    <>
                      <div className="cip-stats">
                        <StatCell label="Bills" value={fy.bill_count} />
                        <StatCell label={revLabel} value={fmtMoney(fy.revenue)} />
                        <StatCell label="Avg Bill" value={fmtMoney(fy.avg_bill)} />
                        <StatCell label="Discount" value={fmtMoney(fy.discount_amount)}
                          sub={fy.avg_discount_pct > 0 ? `${fy.avg_discount_pct}% of value` : undefined} />
                      </div>

                      {showProfit && fy.profit != null && (
                        <div className="cip-stats">
                          <StatCell label="Gross Profit" value={fmtMoney(fy.profit)}
                            className={fy.profit >= 0 ? 'cip-pos' : 'cip-neg'} />
                          <StatCell label="Margin" value={`${fmtNum(fy.margin_pct)}%`} sub="of taxable revenue"
                            className={fy.margin_pct >= 0 ? 'cip-pos' : 'cip-neg'} />
                          <StatCell label="COGS" value={fmtMoney(fy.cogs)} />
                        </div>
                      )}

                      {showBillStat && (fy.paid_count + fy.partial_count + fy.unpaid_count) > 0 && (
                        <div className="cip-pay-chips">
                          {fy.paid_count > 0    && <span className="cip-chip cip-chip-paid">Paid {fy.paid_count}</span>}
                          {fy.partial_count > 0 && <span className="cip-chip cip-chip-partial">Partial {fy.partial_count}</span>}
                          {fy.unpaid_count > 0  && <span className="cip-chip cip-chip-unpaid">Unpaid {fy.unpaid_count}</span>}
                        </div>
                      )}
                    </>
                  )}
                </SectionCard>
              )}

              {showAt && (
                <SectionCard title="All-Time Summary">
                  {at.bill_count === 0 ? (
                    <div className="cip-empty">No bills on record</div>
                  ) : (
                    <>
                      <div className="cip-stats">
                        <StatCell label="Total Bills" value={at.bill_count} />
                        <StatCell label={lifeRevLabel} value={fmtMoney(at.revenue)} />
                        <StatCell label="Avg Bill" value={fmtMoney(at.avg_bill)} />
                        <StatCell label="Total Disc." value={fmtMoney(at.discount_amount)}
                          sub={at.avg_discount_pct > 0 ? `${at.avg_discount_pct}% avg` : undefined} />
                      </div>

                      {showLifeProfit && at.lifetime_profit != null && (
                        <div className="cip-stats">
                          <StatCell label="Lifetime Profit" value={fmtMoney(at.lifetime_profit)}
                            className={at.lifetime_profit >= 0 ? 'cip-pos' : 'cip-neg'} />
                          <StatCell label="Lifetime Margin" value={`${fmtNum(at.lifetime_margin_pct)}%`}
                            className={at.lifetime_margin_pct >= 0 ? 'cip-pos' : 'cip-neg'} />
                        </div>
                      )}

                      {showBillStat && at.largest_bill > 0 && (
                        <div className="cip-stats">
                          <StatCell label="Largest Bill" value={fmtMoney(at.largest_bill)} />
                          {at.smallest_bill > 0 && <StatCell label="Smallest Bill" value={fmtMoney(at.smallest_bill)} />}
                        </div>
                      )}
                    </>
                  )}
                </SectionCard>
              )}
            </div>
          )}

          {/* Row 2: Behavior + Top products */}
          {(showBehavior || showTopProd) && (
            <div className={`cip-row${(!showBehavior || !showTopProd) ? ' cip-row-full' : ''}`}>
              {showBehavior && (
                <SectionCard title={behTitle}>
                  {!beh.last_visit ? (
                    <div className="cip-empty">No history</div>
                  ) : (
                    <div className="cip-behavior-grid">
                      <div className="cip-behavior-item">
                        <CalendarOutlined className="cip-behavior-icon" />
                        <div className="cip-behavior-text">
                          <div className="cip-behavior-label">{lastLabel}</div>
                          <div className="cip-behavior-value">
                            {beh.last_visit}
                            {beh.days_since_last_visit != null && (
                              <span className="cip-behavior-muted"> ({beh.days_since_last_visit}d ago)</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="cip-behavior-item">
                        <ClockCircleOutlined className="cip-behavior-icon" />
                        <div className="cip-behavior-text">
                          <div className="cip-behavior-label">{firstLabel}</div>
                          <div className="cip-behavior-value">{beh.first_visit || '—'}</div>
                        </div>
                      </div>

                      {beh.avg_days_between_visits != null && (
                        <div className="cip-behavior-item">
                          <RiseOutlined className="cip-behavior-icon" />
                          <div className="cip-behavior-text">
                            <div className="cip-behavior-label">{freqLabel}</div>
                            <div className="cip-behavior-value">Every ~{beh.avg_days_between_visits} days</div>
                          </div>
                        </div>
                      )}

                      {beh.longest_gap_days != null && (
                        <div className="cip-behavior-item">
                          <TeamOutlined className="cip-behavior-icon" />
                          <div className="cip-behavior-text">
                            <div className="cip-behavior-label">Longest gap</div>
                            <div className="cip-behavior-value">{beh.longest_gap_days} days</div>
                          </div>
                        </div>
                      )}

                      {showPayTime && payTimeText && (
                        <div className="cip-behavior-item">
                          <FieldTimeOutlined className="cip-behavior-icon" />
                          <div className="cip-behavior-text">
                            <div className="cip-behavior-label">{payTimeLabel}</div>
                            <div className="cip-behavior-value">{payTimeText}</div>
                          </div>
                        </div>
                      )}

                      {beh.preferred_payment_mode && (
                        <div className="cip-behavior-item">
                          <CreditCardOutlined className="cip-behavior-icon" />
                          <div className="cip-behavior-text">
                            <div className="cip-behavior-label">Preferred payment</div>
                            <div className="cip-behavior-value">
                              <span className="cip-pm-badge">{beh.preferred_payment_mode}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </SectionCard>
              )}

              {showTopProd && (
                <SectionCard title="Top Products">
                  {tops.length === 0 ? (
                    <div className="cip-empty">No product data available</div>
                  ) : (
                    <table className="cip-products-table">
                      <thead>
                        <tr>
                          <th className="rank">#</th>
                          <th>Product</th>
                          <th className="num">{topValHeader}</th>
                          <th className="num">Qty</th>
                          <th className="num">Bills</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tops.map((p) => (
                          <tr key={p.product_id || p.rank}>
                            <td className="rank">{p.rank}</td>
                            <td className="cip-product-name" title={p.product_name}>{p.product_name}</td>
                            <td className="num">{fmtMoney(p.total_revenue)}</td>
                            <td className="num">{fmtNum(p.total_qty)}</td>
                            <td className="num">{p.bill_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </SectionCard>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="cip-footer">
        <Button type="link" size="small" style={{ padding: 0 }}
          onClick={() => {
            onClose();
            navigate(isSupplier
              ? `/reports/supplier-statement?id=${partyId}`
              : `/reports/customer-statement?id=${partyId}`);
          }}>
          View Full Statement
        </Button>
        <span className="cip-footer-hint"><kbd>F8</kbd> to close</span>
      </div>
    </Modal>
  );
}

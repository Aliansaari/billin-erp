import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR } from '../utils/format';

export default function Outstanding() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    reportAPI
      .getPartyOutstanding({ party_type: 'Customer' })
      .then((res) => {
        setRows(res.data?.data || []);
        setTotal(res.data?.total || 0);
      })
      .catch(() => Toast.show({ icon: 'fail', content: 'Failed to load' }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="os-page">
      <div className="os-header">
        <button className="os-back" onClick={() => navigate(-1)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div className="os-title">Customer Outstanding</div>
      </div>

      <div className="os-summary">
        <span className="os-summary-label">Total outstanding</span>
        <span className="os-summary-value">
          <span className="currency">₹</span>{formatINR(total)}
        </span>
      </div>

      <div className="os-list">
        {loading && <div className="os-empty">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="os-empty">No outstanding balances.</div>
        )}
        {!loading &&
          rows.map((r) => (
            <div className="os-row" key={r.party_id}>
              <div className="os-party">
                <div className="os-party-name">{r.party_name}</div>
                {r.mobile_1 && (
                  <div className="os-party-phone">{r.mobile_1}</div>
                )}
              </div>
              <div className="os-balance">
                <span className="currency">₹</span>
                {formatINR(Math.abs(r.current_balance))}
              </div>
            </div>
          ))}
      </div>

      <style>{`
        .os-page {
          flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
          background: var(--c-bg-app);
          padding: calc(env(safe-area-inset-top, 0px) + 8px) var(--pad)
                   calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 16px);
        }
        .os-header {
          display: flex; align-items: center; gap: 8px;
          margin: 8px 0 20px; padding: 6px 0 0;
        }
        .os-back {
          width: 36px; height: 36px; border-radius: 50%;
          background: var(--c-bg-surface); border: 1px solid var(--c-border);
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; color: var(--c-text); padding: 0;
        }
        .os-title {
          font-size: 18px; font-weight: 600; letter-spacing: -0.02em;
          color: var(--c-text);
        }
        .os-summary {
          background: linear-gradient(160deg, #1F1B17 0%, #0F0C09 100%);
          color: var(--c-bg-surface); border-radius: var(--r-hero);
          padding: 18px 20px; margin-bottom: 16px;
          display: flex; justify-content: space-between; align-items: center;
        }
        .os-summary-label {
          font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
          color: rgba(251,248,241,0.55);
        }
        .os-summary-value {
          font-size: 24px; font-weight: 400; letter-spacing: -0.03em;
          font-variant-numeric: tabular-nums;
        }
        .os-summary-value .currency { font-size: 15px; opacity: 0.7; margin-right: 1px; }
        .os-list {
          background: var(--c-bg-surface); border: 1px solid var(--c-border);
          border-radius: 20px; padding: 4px 0; overflow: hidden;
        }
        .os-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 18px; border-bottom: 1px solid var(--c-border-soft);
        }
        .os-row:last-child { border-bottom: none; }
        .os-party { flex: 1; min-width: 0; }
        .os-party-name {
          font-size: 14px; font-weight: 600; color: var(--c-text);
          letter-spacing: -0.01em; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
        .os-party-phone {
          font-size: 11px; color: var(--c-text-mute); margin-top: 2px;
        }
        .os-balance {
          font-size: 16px; font-weight: 500; color: var(--c-primary);
          letter-spacing: -0.025em; font-variant-numeric: tabular-nums;
          white-space: nowrap; flex-shrink: 0; margin-left: 12px;
        }
        .os-balance .currency { font-size: 11px; opacity: 0.65; margin-right: 1px; }
        .os-empty {
          padding: 32px 18px; text-align: center; color: var(--c-text-mute);
          font-style: italic; font-size: 13.5px;
        }
      `}</style>
    </div>
  );
}

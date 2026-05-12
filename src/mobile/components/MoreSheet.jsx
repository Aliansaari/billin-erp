import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import './sheet.css';

/* MoreSheet — bill-level options that live behind the ⋯ menu:
 * salesman, sale type, payment method, due date, remarks. Per the
 * editorial mockup, these are rarely changed mid-bill so they stay
 * out of the main scan-first scroll. */
export default function MoreSheet(props) {
  return ReactDOM.createPortal(<MoreSheetInner {...props} />, document.body);
}

function MoreSheetInner({ type, values, onClose, onSave }) {
  const isPurchase = type === 'purchase';
  const [draft, setDraft] = useState(values || {});

  const set = (key) => (e) => {
    const v = e?.target ? e.target.value : e;
    setDraft((d) => ({ ...d, [key]: v }));
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">Bill options</h2>
          <button className="sheet-close" onClick={onClose}>Cancel</button>
        </div>

        <div className="sheet-body sheet-body--form">
          {/* Purchase: paperwork strip — supplier bill, vehicle, LR,
              transport name. The desktop carries these as separate
              header fields; on mobile they live behind ⋯. */}
          {isPurchase && (
            <>
              <label className="sf-field">
                <span className="sf-label">Supplier bill #</span>
                <input
                  className="sf-input"
                  placeholder="e.g. 4521"
                  value={draft.supplier_bill_number || ''}
                  onChange={set('supplier_bill_number')}
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck="false"
                />
              </label>
              <div className="sf-grid">
                <label className="sf-field">
                  <span className="sf-label">Vehicle #</span>
                  <input
                    className="sf-input"
                    placeholder="MH12-AB-8821"
                    value={draft.vehicle_number || ''}
                    onChange={set('vehicle_number')}
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck="false"
                  />
                </label>
                <label className="sf-field">
                  <span className="sf-label">LR #</span>
                  <input
                    className="sf-input"
                    placeholder="9921"
                    value={draft.lr_number || ''}
                    onChange={set('lr_number')}
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck="false"
                  />
                </label>
              </div>
              <label className="sf-field">
                <span className="sf-label">Transport name</span>
                <input
                  className="sf-input"
                  placeholder="Optional"
                  value={draft.transport_name || ''}
                  onChange={set('transport_name')}
                  autoCorrect="off"
                  autoCapitalize="words"
                  spellCheck="false"
                />
              </label>
            </>
          )}

          {!isPurchase && (
            <label className="sf-field">
              <span className="sf-label">Sale type</span>
              <div className="sf-chips">
                {['Retail', 'Wholesale'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`sf-chip${draft.sale_type === t ? ' sf-chip--active' : ''}`}
                    onClick={() => set('sale_type')(t)}
                  >{t}</button>
                ))}
              </div>
            </label>
          )}

          {!isPurchase && (
            <label className="sf-field">
              <span className="sf-label">Payment mode</span>
              <div className="sf-chips">
                {['Cash', 'UPI', 'Card', 'Credit'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`sf-chip${draft.payment_method === t ? ' sf-chip--active' : ''}`}
                    onClick={() => set('payment_method')(t)}
                  >{t}</button>
                ))}
              </div>
            </label>
          )}

          <label className="sf-field">
            <span className="sf-label">{isPurchase ? 'Due date' : 'Due date (credit)'}</span>
            <input
              type="date"
              className="sf-input"
              value={draft.due_date || ''}
              onChange={set('due_date')}
            />
          </label>

          {!isPurchase && (
            <label className="sf-field">
              <span className="sf-label">Salesman</span>
              <input
                className="sf-input"
                placeholder="Optional"
                value={draft.salesman_name || ''}
                onChange={set('salesman_name')}
              />
            </label>
          )}

          <label className="sf-field">
            <span className="sf-label">Notes</span>
            <textarea
              className="sf-input sf-textarea"
              placeholder="Any remarks for this bill"
              rows={3}
              value={draft.remarks || ''}
              onChange={set('remarks')}
            />
          </label>
        </div>

        <div className="sheet-footer">
          <button className="sf-save" onClick={() => onSave(draft)}>Apply</button>
        </div>
      </div>
    </div>
  );
}

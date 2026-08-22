import React, { useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import dayjs from 'dayjs';
import { printParcelTags } from '../../utils/parcelTag';
import { partyAddressLines } from '../../utils/parcelTag';
import MembershipCard from '../membership/MembershipCard';
import './customer-detail-modal.css';

/* ════════════════════════════════════════════════════════════════════════════
 * CustomerDetailModal — the F8 "full details" popup.
 *
 * Shows everything on file for the cursored party in one scannable card, and
 * carries the owner-facing quick actions (edit, statement, receipt, WhatsApp
 * reminder, activate/deactivate) plus the 10×10cm parcel-tag printer.
 * Presentational only — every action is delegated to the parent so the list
 * page stays the single source of truth for data + navigation.
 * ══════════════════════════════════════════════════════════════════════════ */

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const I = {
  Close: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>),
  Phone: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.92.35 1.82.66 2.68a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 2.11-.45 13 13 0 0 0 2.68.66A2 2 0 0 1 22 16.92z"/></svg>),
  WhatsApp: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M20.52 3.48A12 12 0 0 0 3.7 19.36L2 22l2.72-1.65A12 12 0 1 0 20.52 3.48zm-8.52 18a9.93 9.93 0 0 1-5.12-1.42l-.37-.22-2.42 1.47.5-2.4-.26-.39A10 10 0 1 1 12 21.48z"/></svg>),
  Edit: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>),
  Report: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>),
  Receipt: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/></svg>),
  Box: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>),
  Print: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>),
  Block: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>),
};

// A single label/value cell in the detail grid. Skips render when empty
// unless `always` is set, so the card never shows a wall of dashes.
function Cell({ label, value, mono, always, span, children }) {
  const empty = value == null || value === '' || (typeof value === 'string' && !value.trim());
  if (empty && !children && !always) return null;
  return (
    <div className={`cdm-cell${span ? ' span' : ''}`}>
      <div className="k">{label}</div>
      {children || <div className={`v${mono ? ' mono' : ''}`}>{empty ? '—' : value}</div>}
    </div>
  );
}

export default function CustomerDetailModal({
  open, party, isCustomer = true, company,
  onClose, onEdit, onStatement, onReceipt, onRemind, onToggleActive,
}) {
  const [parcelOpen, setParcelOpen] = useState(false);
  const [billNumber, setBillNumber] = useState('');
  const [parcels, setParcels] = useState(1);
  const [note, setNote] = useState('');
  const [printing, setPrinting] = useState(false);

  // Reset the parcel form each time a different party opens.
  useEffect(() => {
    if (open) {
      setParcelOpen(false);
      setBillNumber(''); setParcels(1); setNote('');
    }
  }, [open, party?.party_id]);

  // Esc closes the modal (parcel panel first, then the whole modal).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (parcelOpen) setParcelOpen(false);
        else onClose?.();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, parcelOpen, onClose]);

  const bal = parseFloat(party?.current_balance || 0);
  const owing = isCustomer ? bal : -bal;
  const absBal = Math.abs(bal);
  const status = party?.party_status || 'Regular';
  const addrLines = useMemo(() => partyAddressLines(party || {}), [party]);
  const initials = (party?.party_name || '?').trim().slice(0, 2).toUpperCase();

  const handlePrintTags = async () => {
    setPrinting(true);
    try {
      await printParcelTags({ company, party, billNumber: billNumber.trim(), totalParcels: parcels, note: note.trim() });
      message.success(`Sent ${Math.max(1, parcels)} parcel tag${parcels > 1 ? 's' : ''} to printer`);
    } catch (e) {
      message.error('Could not print parcel tag: ' + (e?.message || 'unknown error'));
    }
    setPrinting(false);
  };

  return (
    <>
      <div className={`cdm-scrim${open ? ' open' : ''}`} onClick={() => onClose?.()} />
      <div className={`cdm-modal${open ? ' open' : ''}`} role="dialog" aria-modal="true">
        {party && (
          <>
            {/* Header */}
            <div className="cdm-hd">
              <div className={`cdm-avatar ${status.toLowerCase()}`}>{initials}</div>
              <div className="cdm-hd-main">
                <div className="cdm-name">{party.party_name}</div>
                <div className="cdm-badges">
                  <span className={`cdm-tag ${status.toLowerCase()}`}>{status}</span>
                  {!party.is_active && <span className="cdm-tag inactive">Inactive</span>}
                  {party.display_name && party.display_name !== party.party_name && (
                    <span className="cdm-alias">“{party.display_name}”</span>
                  )}
                </div>
              </div>
              <div className="cdm-hd-bal">
                <div className="k">{isCustomer ? 'Outstanding' : 'Payable'}</div>
                {absBal < 0.01
                  ? <div className="v zero">₹ 0</div>
                  : <div className={`v ${owing > 0 ? 'dr' : 'cr'}`}>{fmt(absBal)} <span className="tag">{owing > 0 ? 'Dr' : 'Cr'}</span></div>}
              </div>
              <button className="cdm-x" onClick={() => onClose?.()} title="Close (Esc)"><I.Close/></button>
            </div>

            {/* Detail grid */}
            <div className="cdm-body">
              <div className="cdm-sec">
                <div className="cdm-sec-h">Contact</div>
                <div className="cdm-grid">
                  <Cell label="Mobile" always>
                    {party.mobile_1 ? (
                      <div className="v with-actions">
                        <span className="mono">{party.mobile_1}</span>
                        <a className="cdm-mini" href={`tel:+91${party.mobile_1}`} title="Call"><I.Phone/></a>
                        <a className="cdm-mini wa" href={`https://wa.me/91${party.mobile_1}`} target="_blank" rel="noopener noreferrer" title="WhatsApp"><I.WhatsApp/></a>
                      </div>
                    ) : <div className="v">—</div>}
                  </Cell>
                  <Cell label="Alternate mobile" value={party.mobile_2} mono/>
                  <Cell label="Email" value={party.email} span/>
                </div>
              </div>

              <div className="cdm-sec">
                <div className="cdm-sec-h">Address</div>
                <div className="cdm-grid">
                  <Cell label="Full address" span always>
                    <div className="v addr">{addrLines.length ? addrLines.map((l, i) => <div key={i}>{l}</div>) : '—'}</div>
                  </Cell>
                </div>
              </div>

              <div className="cdm-sec">
                <div className="cdm-sec-h">Tax &amp; ID</div>
                <div className="cdm-grid">
                  <Cell label="GSTIN" value={party.gstin} mono/>
                  <Cell label="PAN" value={party.pan_number} mono/>
                  <Cell label="Aadhar" value={party.aadhar_number} mono/>
                </div>
              </div>

              <div className="cdm-sec">
                <div className="cdm-sec-h">Credit &amp; Balances</div>
                <div className="cdm-grid">
                  <Cell label="Credit allowed" value={party.credit_allowed ? 'Yes' : 'No'} always/>
                  <Cell label="Credit limit" value={parseFloat(party.credit_limit || 0) > 0 ? fmt(party.credit_limit) : 'No limit'} always/>
                  <Cell label="Credit days" value={party.credit_days ? `${party.credit_days} days` : null}/>
                  <Cell label="Interest rate" value={parseFloat(party.interest_rate || 0) > 0 ? `${party.interest_rate}%` : null}/>
                  <Cell label="Opening balance" value={parseFloat(party.opening_balance || 0) > 0 ? `${fmt(party.opening_balance)} ${party.opening_balance_type || ''}`.trim() : null}/>
                  <Cell label="Oldest open bill" value={party._aging_days != null ? `${party._aging_days} days` : null}/>
                </div>
              </div>

              {/* Membership — self-contained; renders nothing unless the module
                  is on and this is a customer. Enrol / manage happens inline. */}
              {isCustomer && <MembershipCard party={party} />}
            </div>

            {/* Parcel tag panel */}
            <div className={`cdm-parcel${parcelOpen ? ' open' : ''}`}>
              <button className="cdm-parcel-toggle" onClick={() => setParcelOpen((o) => !o)}>
                <I.Box/> Print parcel tag <span className="sz">10 × 10 cm</span>
                <span className="chev">{parcelOpen ? '▾' : '▸'}</span>
              </button>
              {parcelOpen && (
                <div className="cdm-parcel-body">
                  <div className="cdm-parcel-fields">
                    <label className="cdm-fld">
                      <span>Bill / LR number</span>
                      <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="e.g. 14612" />
                    </label>
                    <label className="cdm-fld sm">
                      <span>No. of parcels</span>
                      <input type="number" min="1" max="99" value={parcels}
                        onChange={(e) => setParcels(Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)))} />
                    </label>
                    <label className="cdm-fld">
                      <span>Transport / note <em>(optional)</em></span>
                      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. VRL Logistics" />
                    </label>
                  </div>
                  <div className="cdm-parcel-foot">
                    <span className="hint">
                      Prints {parcels > 1 ? <b>{parcels} labels</b> : <b>1 label</b>} — each 10×10cm with From/To, big mobile
                      number and parcel {parcels > 1 ? `1…${parcels}` : '1/1'}.
                    </span>
                    <button className="cdm-btn primary" disabled={printing} onClick={handlePrintTags}>
                      <I.Print/> {printing ? 'Printing…' : `Print ${parcels > 1 ? parcels + ' tags' : 'tag'}`}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="cdm-ft">
              <div className="cdm-ft-left">
                {isCustomer && party.mobile_1 && owing > 0.01 && (
                  <button className="cdm-btn wa" onClick={() => onRemind?.(party)}><I.WhatsApp/> Remind</button>
                )}
                <button className={`cdm-btn ${party.is_active ? 'danger' : ''}`} onClick={() => onToggleActive?.(party)}>
                  <I.Block/> {party.is_active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
              <div className="cdm-ft-right">
                <button className="cdm-btn" onClick={() => onReceipt?.(party)}><I.Receipt/> {isCustomer ? 'Receipt' : 'Payment'}</button>
                <button className="cdm-btn" onClick={() => onStatement?.(party)}><I.Report/> Statement</button>
                <button className="cdm-btn primary" onClick={() => onEdit?.(party)}><I.Edit/> Edit</button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

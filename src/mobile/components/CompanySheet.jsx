import React, { useEffect } from 'react';
import './CompanySheet.css';

// Editorial bottom-sheet company picker. Renders a scrim + slide-up sheet
// with the list of firms returned by /api/companies/list-public. Last-used
// firm carries a coloured "Last used" tag so the salesman / owner can pick
// without reading every row.
//
// Controlled component:
//   open          — boolean, mount the sheet
//   companies     — array of { company_id, company_name, gstin?, city?, role?, is_last_used? }
//   selectedId    — currently picked id (controlled)
//   onSelect(id)  — fired on tap of a firm row
//   onConfirm()   — fired on the bottom Continue button
//   onClose()     — fired on scrim tap or close button
export default function CompanySheet({
  open,
  companies,
  selectedId,
  onSelect,
  onConfirm,
  onClose,
}) {
  // Lock background scroll while the sheet is open so dragging on the
  // login form behind it doesn't move the page.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const selectedCompany = companies.find((c) => c.company_id === selectedId);
  const sub = `${companies.length} firm${companies.length === 1 ? '' : 's'}`;

  return (
    <>
      <div className="cs-scrim" onClick={onClose} aria-hidden />
      <div className="cs-sheet" role="dialog" aria-label="Choose company">
        <div className="cs-handle" aria-hidden />

        <div className="cs-header">
          <div className="cs-title-block">
            <h2 className="cs-title">Choose <em>company</em></h2>
            <div className="cs-sub">
              {sub} <span className="cs-sub-acc">·</span> sign in to your firm
            </div>
          </div>
          <button className="cs-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="cs-list">
          {companies.length === 0 && (
            <div className="cs-empty">No firms available yet.</div>
          )}

          {companies.map((c, i) => {
            const isSelected = c.company_id === selectedId;
            const tone = i % 3;
            const initial = (c.company_name || '?').trim().charAt(0).toUpperCase();
            return (
              <button
                key={c.company_id}
                className={`cs-firm${isSelected ? ' selected' : ''}`}
                onClick={() => onSelect(c.company_id)}
              >
                <div className={`cs-firm-avatar tone-${tone}`}>{initial}</div>
                <div className="cs-firm-info">
                  <div className="cs-firm-name-row">
                    <span className="cs-firm-name">{c.company_name}</span>
                    {c.is_last_used && <span className="cs-firm-tag last">Last used</span>}
                    {!c.is_last_used && c.role && (
                      <span className="cs-firm-tag">{c.role}</span>
                    )}
                  </div>
                  <div className="cs-firm-meta">
                    {[c.gstin, c.city].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                {isSelected ? (
                  <span className="cs-firm-check">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                ) : (
                  <span className="cs-firm-radio" />
                )}
              </button>
            );
          })}
        </div>

        <div className="cs-footer">
          <button
            className="cs-continue"
            onClick={onConfirm}
            disabled={!selectedCompany}
          >
            {selectedCompany ? `Continue with ${selectedCompany.company_name}` : 'Pick a firm'}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}

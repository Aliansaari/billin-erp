import React from 'react';
import { formatINR, formatShortDate } from '../utils/format';
import { displayVoucherNo } from '../utils/voucherNumber';

// One row in either the dashboard "Recent activity" or the full DayBook.
// Layout (top → bottom on the left, top → bottom on the right):
//
//   ┃ Chennai Silks Pvt Ltd                  [Cr] ₹1,062
//   ┃ Sale INV-1010 · 8 May '26                    [⌬]
//
//   • Party name at the top, big.
//   • Voucher type + number + date in mono on the meta line. No time —
//     the day-book API doesn't ship per-entry timestamps and the placeholder
//     "12:00 pm" was a distraction in the list view.
//   • A small Cr / Dr pill before the amount so users see which side
//     this entry sits on at a glance (matches standard accounting).
//   • A circular WhatsApp button. Tap → opens WhatsApp with a pre-filled
//     bill summary so the user can send it to the customer / supplier in
//     one move. We use `whatsapp://send?text=...` first (handled natively
//     in Capacitor and most mobile browsers); browsers that don't recognise
//     the scheme fall through to the wa.me HTTPS form.

const IN_TYPES = new Set(['Receipt', 'Receipts']);
const isIn = (t) => IN_TYPES.has(String(t || ''));

function rowLabel(entry) {
  const t = String(entry.voucher_type || '');
  if (t === 'Sales')    return 'Sale';
  return t || 'Voucher';
}

// "Sale INV-1010" / "Purchase #2014" / "Receipt #1011" — but a shop whose
// numbers already read "INV-0623" gets that, not "INV-INV-0623".
function voucherIdLabel(entry) {
  const num = displayVoucherNo(entry.voucher_no, entry.voucher_type === 'Sales' ? 'sale' : '');
  if (!num) return rowLabel(entry);
  return `${rowLabel(entry)} ${num}`;
}

function amountInfo(entry) {
  const debit  = Number(entry.debit  || 0);
  const credit = Number(entry.credit || 0);
  if (credit > 0) return { side: 'Cr', amount: credit };
  if (debit  > 0) return { side: 'Dr', amount: debit  };
  return { side: '',   amount: 0 };
}

function whatsappMessage(entry) {
  const { side, amount } = amountInfo(entry);
  const lines = [
    `*${voucherIdLabel(entry)}*`,
    entry.party_or_account || '',
    entry.entry_date ? formatShortDate(entry.entry_date) : '',
    amount ? `${side ? side + ' ' : ''}₹${formatINR(amount)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

const WhatsappIcon = () => (
  // Official WhatsApp glyph (Simple Icons, MIT-licensed). The smaller
  // hand-rolled path I tried first didn't close cleanly at this size and
  // rendered as a blob — this version is built specifically for tiny sizes.
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
  </svg>
);

export default function ActivityRow({ entry, onClick, todayImplied = false }) {
  const { side, amount } = amountInfo(entry);
  const incoming = isIn(entry.voucher_type);
  /* Hiding today's date is only correct where the list IS today.
   *
   * On the home screen "Recent activity" is today's, so printing 10 Sep '26 on
   * every row is the same seven characters repeated down the list, pushing the
   * voucher number — the part that differs — off to the side.
   *
   * The Vouchers tab and the Day Book are the opposite: they span a chosen
   * range, often a whole financial year, and a row without its date there is
   * a row you cannot place. So this is opt-in, and off by default: a shared
   * row must not quietly drop information because one of its three callers
   * happens not to need it. */
  const isToday = String(entry.entry_date || '').slice(0, 10) === new Date().toISOString().slice(0, 10);
  const showDate = entry.entry_date && !(todayImplied && isToday);
  const dateLabel = showDate ? formatShortDate(entry.entry_date) : '';

  function openWhatsapp(e) {
    // Stop the row's own click so we don't drill INTO the bill while
    // trying to share a summary OF it.
    e.stopPropagation();
    const text = whatsappMessage(entry);
    // wa.me works on every platform; whatsapp:// is the iOS/Android
    // app intent. We try the app first via location.href (Capacitor's
    // WebView will hand it to iOS), then fall back to wa.me in a new tab.
    const encoded = encodeURIComponent(text);
    const appUrl  = `whatsapp://send?text=${encoded}`;
    const webUrl  = `https://wa.me/?text=${encoded}`;
    try { window.location.href = appUrl; }
    catch { window.open(webUrl, '_blank'); }
    // Browser fallback if the scheme handler refuses (no whatsapp installed):
    setTimeout(() => {
      try { window.open(webUrl, '_blank'); } catch {}
    }, 700);
  }

  return (
    <div className="act-row" onClick={onClick} role="button">
      <span className={`act-bar ${incoming ? 'in' : 'out'}`} aria-hidden />
      <div className="act-content">
        <div className="act-name">{entry.party_or_account || '—'}</div>
        <div className="act-meta">
          <span>{voucherIdLabel(entry)}</span>
          {dateLabel && <span>·</span>}
          {dateLabel && <span>{dateLabel}</span>}
        </div>
      </div>
      <div className="act-side">
        {/* The DR/CR chip is gone from the home screen.
         *
         * Every sale is a debit, so on a list of today's sales the chip read
         * DR on every row — a field that never varies carries no information
         * and costs the width the amount wanted. The direction is already in
         * the colour and in the bar down the left edge.
         *
         * It stays on the Vouchers tab and the Day Book, where receipts and
         * payments sit alongside sales and the letter genuinely distinguishes
         * them — and where the reader is an accountant, not a shopkeeper
         * glancing at their phone. */}
        <div className={`act-amount ${incoming ? 'in' : 'out'}`}>
          {side && !todayImplied && (
            <span className={`act-side-label ${side === 'Cr' ? 'cr' : 'dr'}`}>{side}</span>
          )}
          <span className="act-amount-value">
            <span className="currency">₹</span>{formatINR(amount)}
          </span>
        </div>
        {/* Quieter than it was. Three filled green circles down a list of
            three rows competed with the amounts for attention, and the amount
            is what the row is for. Same action, same target size, less voice. */}
        <button
          className="act-share"
          onClick={openWhatsapp}
          aria-label={`Share ${voucherIdLabel(entry)} via WhatsApp`}
        >
          <WhatsappIcon />
        </button>
      </div>
    </div>
  );
}

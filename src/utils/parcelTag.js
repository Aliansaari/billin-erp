// ── parcelTag ─────────────────────────────────────────────────────────────
//
// Build + print 10cm × 10cm parcel / shipping labels for a customer's goods.
// Wholesale/distribution owners stick one of these on each carton before it
// goes to a transport company, so the label is optimised for the two things a
// delivery boy / transporter actually needs at a glance:
//
//   • WHERE it goes  — big TO name + address + a large, callable mobile number
//   • WHICH parcel   — "1 / 3" so a split consignment is obvious
//
// Plus: the bill number, today's date, and an optional transport note. One
// page per parcel; @page pins the sheet to 100mm × 100mm so it prints
// true-to-size on a label printer or gets centred on A4.

import { printRawHTML } from '../services/printer';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Compose the multi-line "TO" address from the party's address fields, dropping
// blanks so we never print empty lines or stray commas.
export function partyAddressLines(p) {
  const l1 = (p?.address_line_1 || '').trim();
  const l2 = (p?.address_line_2 || '').trim();
  const cityState = [p?.city, p?.state].filter(Boolean).join(', ');
  const pin = (p?.pincode || '').trim();
  const cityLine = [cityState, pin].filter(Boolean).join(' - ');
  return [l1, l2, cityLine].filter(Boolean);
}

// One-line "FROM" address for the shop, from system settings. Prefers the
// structured address fields, falls back to the legacy single-line field.
function fromAddressLine(co) {
  const structured = [co?.company_address_line_1, co?.company_address_line_2, co?.company_city, co?.company_state, co?.company_pincode]
    .map((x) => (x || '').trim()).filter(Boolean).join(', ');
  return structured || (co?.company_address || '').trim();
}

function fromPhone(co) {
  return [co?.company_phone, co?.company_phone_2].map((x) => (x || '').trim()).filter(Boolean).join(' · ');
}

// Name size steps down with length so even long shop names fit (up to
// three lines) beside the parcel counter.
function nameSize(name) {
  const n = String(name || '').length;
  if (n <= 10) return 12;
  if (n <= 16) return 9.4;
  if (n <= 24) return 7.6;
  if (n <= 34) return 6.1;
  return 5.1;
}

// City steps down too, so a long town name never gets cut off.
function citySize(city) {
  const n = String(city || '').length;
  if (n <= 7) return 8;
  if (n <= 9) return 6.8;
  if (n <= 12) return 5.6;
  if (n <= 16) return 4.6;
  return 3.8;
}

// 9876543210 → 98765 43210, easier to read out and dial.
const fmtMobile = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : String(m || '');
};

// A crisp handset glyph (prints sharper than an emoji or font icon).
const PHONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';

// Build one label, laid out like a courier label: where it goes first and
// biggest, the carton count where nobody can miss it, the sender and the
// paperwork quietly at the bottom. Black and white only, so it prints
// cleanly on a thermal label printer.
function labelHTML({ from, to, streetLines, city, pin, mobile, billNumber, note, index, total, dateStr }) {
  const fromBits = [esc(from.addr), from.phone ? `<span class="nb">Ph ${esc(from.phone)}</span>` : ''].filter(Boolean).join(' · ');
  return `
    <div class="label">
      <div class="head">
        <div class="to">
          <div class="cap">Deliver to</div>
          <div class="to-name" style="font-size:${nameSize(to)}mm">${esc(to) || '&nbsp;'}</div>
          ${streetLines.length ? `<div class="to-addr">${streetLines.map(esc).join(', ')}</div>` : ''}
        </div>
        <div class="pc">
          <div class="pc-n">${index}</div>
          <div class="pc-of">of ${total}</div>
        </div>
      </div>

      <div class="mid">
      ${(city || pin) ? `
      <div class="city">
        <span class="city-n" style="font-size:${citySize(city)}mm">${esc(city)}</span>
        ${pin ? `<span class="pin">${esc(pin)}</span>` : ''}
      </div>` : ''}

      ${mobile ? `<div class="mob">${PHONE_SVG}<span class="mnum">${esc(fmtMobile(mobile))}</span></div>` : ''}
      </div>

      <div class="foot">
        <div class="from">
          <div class="cap">From</div>
          <div class="shop">${esc(from.name)}</div>
          ${fromBits ? `<div class="fromline">${fromBits}</div>` : ''}
        </div>
        <div class="meta">
          ${billNumber ? `<div><span>Bill</span><b>${esc(billNumber)}</b></div>` : ''}
          <div><span>Date</span><b>${esc(dateStr)}</b></div>
          ${note ? `<div><span>Via</span><b>${esc(note)}</b></div>` : ''}
        </div>
      </div>
    </div>`;
}

const DOC_CSS = `
  @page { size: 100mm 100mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
    font-family: 'Source Sans 3', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
  .label { width: 100mm; height: 100mm; padding: 5.5mm 5.5mm 4.6mm; overflow: hidden;
    display: flex; flex-direction: column; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .nb { white-space: nowrap; }
  .cap { font-size: 2.4mm; font-weight: 700; letter-spacing: 0.7mm; text-transform: uppercase; }

  /* Deliver to + parcel counter */
  .head { display: flex; align-items: flex-start; gap: 4mm; }
  .to { flex: 1; min-width: 0; }
  .to-name { font-weight: 800; line-height: 1.02; margin-top: 1mm; letter-spacing: -0.12mm;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
  .to-addr { font-size: 3.8mm; line-height: 1.3; margin-top: 1.6mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pc { flex: 0 0 21mm; height: 21mm; border-radius: 2.4mm; background: #000; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .pc-n { font-size: 11.5mm; font-weight: 800; line-height: 0.95; font-variant-numeric: tabular-nums; }
  .pc-of { font-size: 2.8mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; margin-top: 0.6mm; }

  /* City + PIN: what the transporter sorts by */
  .mid { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 3.4mm; padding: 3.4mm 0; }
  .city { display: flex; align-items: baseline; justify-content: space-between; gap: 3mm;
    padding: 2mm 0 1.8mm; border-top: 0.8mm solid #000; border-bottom: 0.8mm solid #000; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.3mm; line-height: 1.1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 7mm; font-weight: 800; letter-spacing: 0.6mm; line-height: 1.1;
    font-variant-numeric: tabular-nums; flex-shrink: 0; }

  /* Mobile */
  .mob { display: flex; align-items: center; gap: 2.8mm; }
  .mob svg { width: 7mm; height: 7mm; flex-shrink: 0; }
  .mnum { font-size: 9.6mm; font-weight: 800; letter-spacing: 0.3mm; line-height: 1; font-variant-numeric: tabular-nums; }

  /* Sender + paperwork */
  .foot { padding-top: 2.4mm; border-top: 0.3mm dashed #000;
    display: flex; align-items: flex-end; justify-content: space-between; gap: 4mm; }
  .from { flex: 1; min-width: 0; }
  .shop { font-size: 3.8mm; font-weight: 800; line-height: 1.15; margin-top: 0.6mm;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.5mm; line-height: 1.3; margin-top: 0.5mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { flex: 0 1 auto; max-width: 50mm; display: flex; flex-direction: column; gap: 0.5mm; }
  .meta div { display: flex; justify-content: flex-end; align-items: baseline; gap: 1.8mm; font-size: 3mm; line-height: 1.2; }
  .meta span { font-size: 2.3mm; font-weight: 700; letter-spacing: 0.4mm; text-transform: uppercase; }
  .meta b { font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42mm; }
`;

/**
 * Build the full multi-page label document (one page per parcel).
 * Exported separately so a preview surface can show the exact printed markup.
 */
export async function buildParcelTagHTML({ company, party, billNumber, totalParcels = 1, note = '' }) {
  const total = Math.max(1, Math.min(99, parseInt(totalParcels, 10) || 1));
  const from = {
    name: company?.company_name || 'Our Store',
    addr: fromAddressLine(company),
    phone: fromPhone(company),
    gstin: (company?.company_gstin || '').trim(),
  };
  const to = party?.party_name || '';
  // Street lines in the address block; city + PIN get their own band.
  const streetLines = [party?.address_line_1, party?.address_line_2].map((x) => (x || '').trim()).filter(Boolean);
  // No city on file: fall back to the state, so the band still says where it goes.
  const city = (party?.city || '').trim() || (party?.state || '').trim();
  const pin = (party?.pincode || '').trim();
  const mobile = (party?.mobile_1 || '').trim();
  const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const labels = [];
  for (let i = 1; i <= total; i++) {
    labels.push(labelHTML({ from, to, streetLines, city, pin, mobile, billNumber, note, index: i, total, dateStr }));
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Parcel Tag</title><style>${DOC_CSS}</style></head><body>${labels.join('')}</body></html>`;
}

/**
 * Build + send the labels to the printer. Uses the print dialog (silent:false)
 * so the owner can pick the label printer and confirm the 100mm size the first
 * time. Returns true on success.
 */
export async function printParcelTags(opts) {
  const html = await buildParcelTagHTML(opts);
  await printRawHTML(html, { silent: false });
  return true;
}

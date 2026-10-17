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

// Name size steps down with length so long shop names still fit two lines.
function nameSize(name) {
  const n = String(name || '').length;
  if (n <= 14) return 9.5;
  if (n <= 22) return 8;
  if (n <= 32) return 6.6;
  return 5.4;
}

// 9876543210 → 98765 43210, easier to read out and dial.
const fmtMobile = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : String(m || '');
};

// Build one label's inner HTML. Design goals: the transporter reads the TO
// name, city and mobile from across the room, the parcel counter is
// unmistakable, and it prints cleanly on a black-only label printer.
function labelHTML({ from, to, streetLines, city, pin, mobile, billNumber, note, index, total, dateStr }) {
  const fromBits = [esc(from.addr), from.phone ? `<span class="nb">Ph ${esc(from.phone)}</span>` : ''].filter(Boolean).join(' · ');
  return `
    <div class="label">
      <div class="top">
        <div class="from">
          <div class="cap">From</div>
          <div class="shop">${esc(from.name)}</div>
          ${fromBits ? `<div class="fromline">${fromBits}</div>` : ''}
        </div>
        <div class="pc">
          <div class="pc-cap">Parcel</div>
          <div class="pc-n">${index}<span>/${total}</span></div>
        </div>
      </div>

      <div class="to">
        <div class="cap">Deliver to</div>
        <div class="to-name" style="font-size:${nameSize(to)}mm">${esc(to) || '&nbsp;'}</div>
        ${streetLines.length ? `<div class="to-addr">${streetLines.map(esc).join('<br/>')}</div>` : ''}
      </div>

      ${(city || pin) ? `<div class="city"><span class="city-n">${esc(city)}</span>${pin ? `<span class="pin">${esc(pin)}</span>` : ''}</div>` : ''}

      ${mobile ? `<div class="mob"><span class="mob-cap">Call</span><span class="mnum">${esc(fmtMobile(mobile))}</span></div>` : ''}

      <div class="foot">
        <span>${billNumber ? `Bill <b>${esc(billNumber)}</b>` : ''}</span>
        <span>${esc(dateStr)}</span>
        ${note ? `<span class="note">${esc(note)}</span>` : ''}
      </div>
    </div>`;
}

const DOC_CSS = `
  @page { size: 100mm 100mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
    font-family: 'Source Sans 3', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
  .label { width: 100mm; height: 100mm; padding: 5mm 5mm 4.2mm; overflow: hidden;
    display: flex; flex-direction: column; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .nb { white-space: nowrap; }
  .cap { font-size: 2.5mm; font-weight: 700; letter-spacing: 0.6mm; text-transform: uppercase; }

  /* From + parcel counter */
  .top { display: flex; align-items: stretch; gap: 3mm; padding-bottom: 2.6mm; border-bottom: 0.6mm solid #000; }
  .from { flex: 1; min-width: 0; }
  .shop { font-size: 4.6mm; font-weight: 800; line-height: 1.1; margin-top: 0.6mm;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.6mm; line-height: 1.3; margin-top: 0.8mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pc { flex: 0 0 auto; min-width: 19mm; border: 0.6mm solid #000; border-radius: 2mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 2mm; }
  .pc-cap { font-size: 2.2mm; font-weight: 700; letter-spacing: 0.4mm; text-transform: uppercase; }
  .pc-n { font-size: 8.5mm; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .pc-n span { font-size: 4.4mm; font-weight: 700; }

  /* Deliver to */
  .to { margin-top: 3mm; min-height: 0; }
  .to-name { font-weight: 800; line-height: 1.02; margin-top: 0.8mm; letter-spacing: -0.1mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
  .to-addr { font-size: 3.5mm; line-height: 1.3; margin-top: 1.4mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* City band: what the transporter sorts by */
  .city { margin-top: 2.8mm; background: #000; color: #fff; border-radius: 1.6mm;
    display: flex; align-items: center; justify-content: space-between; gap: 3mm; padding: 1.8mm 3mm; }
  .city-n { font-size: 5.6mm; font-weight: 800; text-transform: uppercase; letter-spacing: 0.2mm;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 5.6mm; font-weight: 800; letter-spacing: 0.5mm; font-variant-numeric: tabular-nums; }

  /* Mobile */
  .mob { margin-top: 2.4mm; border: 0.6mm solid #000; border-radius: 1.6mm;
    display: flex; align-items: center; gap: 3mm; padding: 1.4mm 3mm; }
  .mob-cap { font-size: 2.6mm; font-weight: 700; letter-spacing: 0.5mm; text-transform: uppercase; }
  .mnum { font-size: 7mm; font-weight: 800; letter-spacing: 0.3mm; font-variant-numeric: tabular-nums; }

  /* Footer */
  .foot { margin-top: auto; padding-top: 1.8mm; border-top: 0.3mm solid #000;
    display: flex; align-items: baseline; gap: 3mm; font-size: 3.2mm; }
  .foot b { font-weight: 800; }
  .foot .note { margin-left: auto; font-weight: 700; text-align: right;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 38mm; }
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

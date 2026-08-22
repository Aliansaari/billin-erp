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

// Build one label's inner HTML. Design goals: the transporter reads the TO
// name + mobile from across the room, the parcel counter is unmistakable, and
// the whole thing looks like a designed shipping label, not a printout.
function labelHTML({ from, to, addrLines, mobile, billNumber, note, index, total, dateStr }) {
  return `
    <div class="label">
      <div class="head">
        <div class="shop">${esc(from.name)}</div>
        <div class="pc"><span class="pc-n">${index}</span><span class="pc-d">/${total}</span></div>
      </div>
      <div class="fromline">${[from.addr, from.phone ? '☎ ' + from.phone : ''].filter(Boolean).map(esc).join(' · ')}</div>

      <div class="tolabel">Deliver&nbsp;to</div>
      <div class="to-name">${esc(to)}</div>
      <div class="to-addr">${addrLines.map(esc).join('<br/>') || '—'}</div>

      ${mobile ? `<div class="mob"><span class="mic">☎</span><span class="mnum">${esc(mobile)}</span></div>` : ''}

      <div class="foot">
        <div class="foot-row">
          <div class="bill">${billNumber ? `Bill <b>${esc(billNumber)}</b>` : '&nbsp;'}</div>
          <div class="date">${esc(dateStr)}${note ? ` · ${esc(note)}` : ''}</div>
        </div>
      </div>
    </div>`;
}

const DOC_CSS = `
  @page { size: 100mm 100mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111;
    font-family: 'Helvetica Neue', Arial, 'Segoe UI', sans-serif; }
  .label { width: 100mm; height: 100mm; padding: 4mm; overflow: hidden;
    display: flex; flex-direction: column; page-break-after: always; }
  .label:last-child { page-break-after: auto; }

  /* Header band: shop name + parcel counter badge */
  .head { display: flex; align-items: stretch; justify-content: space-between;
    background: #111; color: #fff; border-radius: 2mm; overflow: hidden; }
  .head .shop { font-size: 5mm; font-weight: 800; letter-spacing: 0.2px;
    padding: 2.2mm 3mm; align-self: center; line-height: 1.05;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head .pc { background: #fff; color: #111; display: flex; align-items: baseline;
    padding: 0 3.2mm; justify-content: center; align-items: center; }
  .head .pc-n { font-size: 8mm; font-weight: 800; line-height: 1; }
  .head .pc-d { font-size: 4.2mm; font-weight: 700; opacity: 0.75; }

  .fromline { font-size: 2.9mm; color: #444; margin: 1.5mm 0.5mm 0;
    line-height: 1.25; padding-bottom: 2.2mm; border-bottom: 0.4mm solid #ddd; }

  /* Deliver-to hero block */
  .tolabel { font-size: 3mm; letter-spacing: 3px; font-weight: 800; color: #888;
    text-transform: uppercase; margin: 2.6mm 0.5mm 0; }
  .to-name { font-size: 8mm; font-weight: 800; line-height: 1.02; color: #000;
    margin: 0.6mm 0.5mm 1.4mm; word-break: break-word; }
  .to-addr { font-size: 4mm; line-height: 1.32; color: #222; margin: 0 0.5mm; }

  /* Big boxed mobile — the number the transporter actually calls */
  .mob { display: flex; align-items: center; gap: 2.5mm; margin-top: 2.8mm;
    border: 0.5mm solid #111; border-radius: 2mm; padding: 1.8mm 3mm; }
  .mob .mic { font-size: 5.2mm; }
  .mob .mnum { font-size: 7.2mm; font-weight: 800; letter-spacing: 0.6px;
    font-variant-numeric: tabular-nums; }

  /* Footer */
  .foot { margin-top: auto; }
  .foot-row { display: flex; align-items: baseline; justify-content: space-between;
    gap: 3mm; font-size: 3.8mm; color: #111; border-top: 0.5mm solid #111;
    padding-top: 1.8mm; }
  .foot-row .bill b { font-weight: 800; }
  .foot-row .date { font-size: 3.2mm; color: #555; text-align: right; }
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
  const addrLines = partyAddressLines(party);
  const mobile = (party?.mobile_1 || '').trim();
  const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const labels = [];
  for (let i = 1; i <= total; i++) {
    labels.push(labelHTML({ from, to, addrLines, mobile, billNumber, note, index: i, total, dateStr }));
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

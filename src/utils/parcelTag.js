// ── parcelTag ─────────────────────────────────────────────────────────────
//
// Build + print 10cm × 10cm parcel / shipping labels for a customer's goods.
// Wholesale/distribution owners stick one of these on each carton before it
// goes to a transport company, so every design is built around the few
// things a transporter actually needs at a glance:
//
//   • WHERE it goes  — the TO name, the city + PIN, a large callable mobile
//   • WHICH parcel   — "1 of 3" so a split consignment is obvious
//
// Plus the sender, the bill number, the date and an optional transport note.
// One page per parcel; @page pins the sheet to 100mm × 100mm so it prints
// true-to-size on a label printer. Every design is black and white only, so
// it prints cleanly on a thermal label printer.
//
// The shop picks a default design in Settings → Parcel Labels
// (system_settings.parcel_tag_design); the print dialog can switch per print.

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

// Pick a size from [maxLength, mm] steps; the last step covers anything longer.
const stepSize = (text, steps) => {
  const n = String(text || '').length;
  for (const [max, mm] of steps) if (n <= max) return mm;
  return steps[steps.length - 1][1];
};

// 9876543210 → 98765 43210, easier to read out and dial.
const fmtMobile = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : String(m || '');
};

// A crisp handset glyph (prints sharper than an emoji or font icon).
const PHONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';

const fromBitsOf = (from) => [esc(from.addr), from.phone ? `<span class="nb">Ph ${esc(from.phone)}</span>` : ''].filter(Boolean).join(' · ');

// Shared by every design: the sheet, the label box, small caps.
const BASE_CSS = `
  @page { size: 100mm 100mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
    font-family: 'Source Sans 3', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
  .label { width: 100mm; height: 100mm; overflow: hidden;
    display: flex; flex-direction: column; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .nb { white-space: nowrap; }
  .cap { font-size: 2.4mm; font-weight: 700; letter-spacing: 0.7mm; text-transform: uppercase; }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .clamp3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
`;

/* ── Design 1: Courier — deliver-to first, carton count in a black tile,
 * city + PIN between heavy rules, sender and paperwork at the bottom. ── */
const courier = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      <div class="head">
        <div class="to">
          <div class="cap">Deliver to</div>
          <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[10, 12], [16, 9.4], [24, 7.6], [34, 6.1], [999, 5.1]])}mm">${esc(c.to) || '&nbsp;'}</div>
          ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
        </div>
        <div class="pc"><div class="pc-n">${c.index}</div><div class="pc-of">of ${c.total}</div></div>
      </div>
      <div class="mid">
        ${(c.city || c.pin) ? `<div class="city"><span class="city-n" style="font-size:${stepSize(c.city, [[7, 8], [9, 6.8], [12, 5.6], [16, 4.6], [999, 3.8]])}mm">${esc(c.city)}</span>${c.pin ? `<span class="pin">${esc(c.pin)}</span>` : ''}</div>` : ''}
        ${c.mobile ? `<div class="mob">${PHONE_SVG}<span class="mnum">${esc(fmtMobile(c.mobile))}</span></div>` : ''}
      </div>
      <div class="foot">
        ${c.showFrom ? `<div class="from">
          <div class="cap">From</div>
          <div class="shop">${esc(c.from.name)}</div>
          ${fromBitsOf(c.from) ? `<div class="fromline clamp2">${fromBitsOf(c.from)}</div>` : ''}
        </div>` : ''}
        <div class="meta">
          ${c.billNumber ? `<div><span>Bill</span><b>${esc(c.billNumber)}</b></div>` : ''}
          <div><span>Date</span><b>${esc(c.dateStr)}</b></div>
          ${c.note ? `<div><span>Via</span><b>${esc(c.note)}</b></div>` : ''}
        </div>
      </div>
    </div>`,
  css: `
  .label { padding: 5.5mm 5.5mm 4.6mm; }
  .no-from .foot { justify-content: flex-start; }
  .no-from .meta { flex-direction: row; flex-wrap: wrap; gap: 1mm 6mm; max-width: none; }
  .no-from .meta div { justify-content: flex-start; font-size: 3.4mm; }
  .head { display: flex; align-items: flex-start; gap: 4mm; }
  .to { flex: 1; min-width: 0; }
  .to-name { font-weight: 800; line-height: 1.02; margin-top: 1mm; letter-spacing: -0.12mm; }
  .to-addr { font-size: 3.8mm; line-height: 1.3; margin-top: 1.6mm; }
  .pc { flex: 0 0 21mm; height: 21mm; border-radius: 2.4mm; background: #000; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .pc-n { font-size: 11.5mm; font-weight: 800; line-height: 0.95; font-variant-numeric: tabular-nums; }
  .pc-of { font-size: 2.8mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; margin-top: 0.6mm; }
  .mid { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 3.4mm; padding: 3.4mm 0; }
  .city { display: flex; align-items: baseline; justify-content: space-between; gap: 3mm;
    padding: 2mm 0 1.8mm; border-top: 0.8mm solid #000; border-bottom: 0.8mm solid #000; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.3mm; line-height: 1.1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 7mm; font-weight: 800; letter-spacing: 0.6mm; line-height: 1.1; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .mob { display: flex; align-items: center; gap: 2.8mm; }
  .mob svg { width: 7mm; height: 7mm; flex-shrink: 0; }
  .mnum { font-size: 9.6mm; font-weight: 800; letter-spacing: 0.3mm; line-height: 1; font-variant-numeric: tabular-nums; }
  .foot { padding-top: 2.4mm; border-top: 0.3mm dashed #000; display: flex; align-items: flex-end; justify-content: space-between; gap: 4mm; }
  .from { flex: 1; min-width: 0; }
  .shop { font-size: 3.8mm; font-weight: 800; line-height: 1.15; margin-top: 0.6mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.5mm; line-height: 1.3; margin-top: 0.5mm; }
  .meta { flex: 0 1 auto; max-width: 50mm; display: flex; flex-direction: column; gap: 0.5mm; }
  .meta div { display: flex; justify-content: flex-end; align-items: baseline; gap: 1.8mm; font-size: 3mm; line-height: 1.2; }
  .meta span { font-size: 2.3mm; font-weight: 700; letter-spacing: 0.4mm; text-transform: uppercase; }
  .meta b { font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42mm; }
  `,
};

/* ── Design 2: Bold band — sender on top beside a boxed counter, a solid
 * black city band, the mobile in a box. Maximum contrast. ── */
const band = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      ${c.showFrom ? `<div class="top">
        <div class="from">
          <div class="cap">From</div>
          <div class="shop">${esc(c.from.name)}</div>
          ${fromBitsOf(c.from) ? `<div class="fromline clamp2">${fromBitsOf(c.from)}</div>` : ''}
        </div>
        <div class="pc"><div class="pc-cap">Parcel</div><div class="pc-n">${c.index}<span>/${c.total}</span></div></div>
      </div>` : ''}
      <div class="to-row">
        <div class="to">
          <div class="cap">Deliver to</div>
          <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[14, 9.5], [22, 8], [32, 6.4], [999, 5.2]])}mm">${esc(c.to) || '&nbsp;'}</div>
          ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
        </div>
        ${c.showFrom ? '' : `<div class="pc"><div class="pc-cap">Parcel</div><div class="pc-n">${c.index}<span>/${c.total}</span></div></div>`}
      </div>
      ${(c.city || c.pin) ? `<div class="city"><span class="city-n" style="font-size:${stepSize(c.city, [[9, 5.8], [12, 5], [16, 4.2], [999, 3.6]])}mm">${esc(c.city)}</span>${c.pin ? `<span class="pin">${esc(c.pin)}</span>` : ''}</div>` : ''}
      ${c.mobile ? `<div class="mob"><span class="mob-cap">Call</span><span class="mnum">${esc(fmtMobile(c.mobile))}</span></div>` : ''}
      <div class="foot">
        ${c.billNumber ? `<span>Bill <b>${esc(c.billNumber)}</b></span>` : ''}
        <span>${esc(c.dateStr)}</span>
        ${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}
      </div>
    </div>`,
  css: `
  .label { padding: 5mm 5mm 4.2mm; }
  .cap { letter-spacing: 0.6mm; }
  .top { display: flex; align-items: stretch; gap: 3mm; padding-bottom: 2.6mm; border-bottom: 0.6mm solid #000; }
  .from { flex: 1; min-width: 0; }
  .shop { font-size: 4.6mm; font-weight: 800; line-height: 1.1; margin-top: 0.6mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.6mm; line-height: 1.3; margin-top: 0.8mm; }
  .pc { flex: 0 0 auto; min-width: 19mm; border: 0.6mm solid #000; border-radius: 2mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 2mm; }
  .pc-cap { font-size: 2.2mm; font-weight: 700; letter-spacing: 0.4mm; text-transform: uppercase; }
  .pc-n { font-size: 8.5mm; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .pc-n span { font-size: 4.4mm; font-weight: 700; }
  .to-row { display: flex; align-items: flex-start; gap: 3mm; margin-top: 3mm; }
  .no-from .to-row { margin-top: 0; }
  .to { flex: 1; min-width: 0; }
  .to-name { font-weight: 800; line-height: 1.02; margin-top: 0.8mm; letter-spacing: -0.1mm; }
  .to-addr { font-size: 3.5mm; line-height: 1.3; margin-top: 1.4mm; }
  .no-from .pc { min-height: 17mm; }
  .city { margin-top: auto; background: #000; color: #fff; border-radius: 1.6mm;
    display: flex; align-items: center; justify-content: space-between; gap: 3mm; padding: 1.8mm 3mm; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.2mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 5.6mm; font-weight: 800; letter-spacing: 0.5mm; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .mob { margin-top: 2.4mm; border: 0.6mm solid #000; border-radius: 1.6mm; display: flex; align-items: center; gap: 3mm; padding: 1.4mm 3mm; }
  .mob-cap { font-size: 2.6mm; font-weight: 700; letter-spacing: 0.5mm; text-transform: uppercase; }
  .mnum { font-size: 7mm; font-weight: 800; letter-spacing: 0.3mm; font-variant-numeric: tabular-nums; }
  .foot { margin-top: 2.6mm; padding-top: 1.8mm; border-top: 0.3mm solid #000; display: flex; align-items: baseline; gap: 3mm; font-size: 3.2mm; }
  .foot b { font-weight: 800; }
  .foot .note { margin-left: auto; font-weight: 700; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42mm; }
  `,
};

/* ── Design 3: Boxed — a ruled transport docket: every field in its own
 * cell, so nothing runs into anything else. ── */
const boxed = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      <div class="grid">
        <div class="cell to">
          <div class="cap">Deliver to</div>
          <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[10, 10], [16, 8.2], [24, 6.8], [34, 5.6], [999, 4.8]])}mm">${esc(c.to) || '&nbsp;'}</div>
          ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
        </div>
        <div class="cell pc"><div class="cap">Parcel</div><div class="pc-n">${c.index}</div><div class="pc-of">of ${c.total}</div></div>
        <div class="cell city"><div class="cap">City</div><div class="city-n" style="font-size:${stepSize(c.city, [[8, 6.6], [11, 5.4], [15, 4.4], [999, 3.6]])}mm">${esc(c.city) || '&nbsp;'}</div></div>
        <div class="cell pin"><div class="cap">PIN</div><div class="pin-n">${esc(c.pin) || '&nbsp;'}</div></div>
        <div class="cell mob"><div class="cap">Mobile</div><div class="mnum">${c.mobile ? esc(fmtMobile(c.mobile)) : '&nbsp;'}</div></div>
        ${c.showFrom ? `<div class="cell from">
          <div class="cap">From</div>
          <div class="shop">${esc(c.from.name)}</div>
          ${fromBitsOf(c.from) ? `<div class="fromline clamp2">${fromBitsOf(c.from)}</div>` : ''}
        </div>` : ''}
        <div class="cell meta">
          ${c.billNumber ? `<div><span>Bill</span><b>${esc(c.billNumber)}</b></div>` : ''}
          <div><span>Date</span><b>${esc(c.dateStr)}</b></div>
          ${c.note ? `<div><span>Via</span><b>${esc(c.note)}</b></div>` : ''}
        </div>
      </div>
    </div>`,
  css: `
  .label { padding: 3.5mm; }
  .grid { flex: 1; display: grid; grid-template-columns: 1fr 31mm;
    grid-template-rows: 1fr auto auto auto;
    grid-template-areas: "to pc" "city pin" "mob mob" "from meta";
    border: 0.7mm solid #000; border-radius: 1.6mm; overflow: hidden; }
  .cell { padding: 2mm 2.6mm; border-right: 0.35mm solid #000; border-bottom: 0.35mm solid #000; min-width: 0; }
  .cell.pc, .cell.pin, .cell.mob, .cell.meta { border-right: 0; }
  .cell.from, .cell.meta { border-bottom: 0; }
  .no-from .grid { grid-template-areas: "to pc" "city pin" "mob mob" "meta meta"; }
  .no-from .meta { flex-direction: row; flex-wrap: wrap; justify-content: flex-start; gap: 0.8mm 5mm; padding-top: 2.4mm; padding-bottom: 2.4mm; }
  .no-from .meta div { gap: 2mm; font-size: 3.2mm; min-width: 0; }
  .no-from .meta b { max-width: 52mm; }
  .cap { font-size: 2.1mm; letter-spacing: 0.5mm; }
  .to { grid-area: to; display: flex; flex-direction: column; }
  .to-name { font-weight: 800; line-height: 1.03; margin-top: 1mm; letter-spacing: -0.1mm; }
  .to-addr { font-size: 3.3mm; line-height: 1.3; margin-top: 1.4mm; }
  .pc { grid-area: pc; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .pc-n { font-size: 14mm; font-weight: 800; line-height: 0.95; font-variant-numeric: tabular-nums; }
  .pc-of { font-size: 3mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; }
  .city { grid-area: city; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.2mm; line-height: 1.15; margin-top: 0.6mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { grid-area: pin; }
  .pin-n { font-size: 6mm; font-weight: 800; letter-spacing: 0.4mm; line-height: 1.15; margin-top: 0.6mm; font-variant-numeric: tabular-nums; }
  .mob { grid-area: mob; display: flex; align-items: baseline; gap: 3mm; }
  .mnum { font-size: 7.6mm; font-weight: 800; letter-spacing: 0.3mm; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .from { grid-area: from; }
  .shop { font-size: 3.6mm; font-weight: 800; line-height: 1.15; margin-top: 0.5mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.4mm; line-height: 1.3; margin-top: 0.4mm; }
  .meta { grid-area: meta; display: flex; flex-direction: column; justify-content: center; gap: 0.6mm; }
  .meta div { display: flex; justify-content: space-between; align-items: baseline; gap: 1.4mm; font-size: 2.8mm; line-height: 1.2; }
  .meta span { font-size: 2.1mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; }
  .meta b { font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
};

/* ── Design 4: Minimal — hairlines and type only; saves ink and reads as
 * a calm, boutique label. ── */
const minimal = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      <div class="head">
        <div class="cap">To</div>
        <div class="pc">${c.index}<span>/${c.total}</span></div>
      </div>
      <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[10, 11], [16, 8.8], [24, 7.2], [34, 5.8], [999, 4.9]])}mm">${esc(c.to) || '&nbsp;'}</div>
      ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
      ${(c.city || c.pin) ? `<div class="city"><span class="city-n" style="font-size:${stepSize(c.city, [[9, 6.2], [12, 5.2], [16, 4.4], [999, 3.6]])}mm">${esc(c.city)}</span>${c.pin ? `<span class="pin">${esc(c.pin)}</span>` : ''}</div>` : ''}
      ${c.mobile ? `<div class="mob"><span class="cap">Mobile</span><span class="mnum">${esc(fmtMobile(c.mobile))}</span></div>` : ''}
      <div class="foot">
        ${c.showFrom ? `<div class="from"><b>${esc(c.from.name)}</b>${fromBitsOf(c.from) ? `<div class="clamp2">${fromBitsOf(c.from)}</div>` : ''}</div>` : ''}
        <div class="meta">${[c.billNumber ? esc(c.billNumber) : '', esc(c.dateStr), c.note ? esc(c.note) : ''].filter(Boolean).map((x) => `<div>${x}</div>`).join('')}</div>
      </div>
    </div>`,
  css: `
  .label { padding: 6.5mm 6.5mm 5.5mm; }
  .head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 2mm; border-bottom: 0.25mm solid #000; }
  .head .cap { font-size: 2.6mm; letter-spacing: 1mm; }
  .pc { font-size: 6mm; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .pc span { font-size: 3.6mm; font-weight: 600; }
  .to-name { font-weight: 700; line-height: 1.05; margin-top: 3mm; letter-spacing: -0.15mm; }
  .to-addr { font-size: 3.6mm; line-height: 1.35; margin-top: 1.8mm; }
  .city { margin-top: auto; display: flex; align-items: baseline; gap: 3.5mm; }
  .city-n { font-weight: 600; text-transform: uppercase; letter-spacing: 0.8mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 5.4mm; font-weight: 400; letter-spacing: 0.6mm; font-variant-numeric: tabular-nums; padding-left: 3.5mm; border-left: 0.25mm solid #000; }
  .mob { margin-top: 2.4mm; display: flex; align-items: baseline; gap: 3mm; }
  .mob .cap { font-size: 2.3mm; }
  .mnum { font-size: 8.4mm; font-weight: 700; letter-spacing: 0.2mm; line-height: 1; font-variant-numeric: tabular-nums; }
  .foot { margin-top: 4mm; padding-top: 2.2mm; border-top: 0.25mm solid #000; display: flex; justify-content: space-between; gap: 4mm; font-size: 2.6mm; line-height: 1.35; }
  .from { flex: 1; min-width: 0; }
  .from b { display: block; font-size: 3.2mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; }
  .meta { text-align: right; flex-shrink: 0; max-width: 40mm; }
  .meta div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta div:first-child { font-weight: 700; font-size: 3mm; }
  .no-from .foot { justify-content: flex-start; }
  .no-from .meta { display: flex; gap: 5mm; text-align: left; max-width: none; font-size: 3mm; }
  `,
};

/* ── Design 5: City first — a black banner across the top with the city,
 * PIN and carton count, for transporters who sort by destination. ── */
const hub = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      <div class="banner">
        <div class="where">
          <div class="city-n" style="font-size:${stepSize(c.city, [[6, 10], [8, 8.4], [10, 7], [13, 5.8], [17, 4.8], [999, 4]])}mm">${esc(c.city) || '&nbsp;'}</div>
          ${c.pin ? `<div class="pin">PIN ${esc(c.pin)}</div>` : ''}
        </div>
        <div class="pc"><div class="pc-n">${c.index}</div><div class="pc-of">of ${c.total}</div></div>
      </div>
      <div class="body">
        <div class="cap">Deliver to</div>
        <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[10, 10], [16, 8.2], [24, 6.8], [34, 5.6], [999, 4.8]])}mm">${esc(c.to) || '&nbsp;'}</div>
        ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
        ${c.mobile ? `<div class="mob">${PHONE_SVG}<span class="mnum">${esc(fmtMobile(c.mobile))}</span></div>` : ''}
      </div>
      <div class="foot">
        ${c.showFrom ? `<div class="from"><span class="cap">From</span> <b>${esc(c.from.name)}</b>${c.from.phone ? ` · <span class="nb">${esc(c.from.phone)}</span>` : ''}</div>` : ''}
        <div class="meta">${[c.billNumber ? `Bill <b>${esc(c.billNumber)}</b>` : '', esc(c.dateStr), c.note ? `<b>${esc(c.note)}</b>` : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`,
  css: `
  .label { padding: 0; }
  .banner { background: #000; color: #fff; display: flex; align-items: stretch; min-height: 27mm; }
  .where { flex: 1; min-width: 0; padding: 4mm 5mm 3.4mm; display: flex; flex-direction: column; justify-content: center; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.3mm; line-height: 1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { margin-top: 1.6mm; font-size: 5mm; font-weight: 700; letter-spacing: 0.8mm; font-variant-numeric: tabular-nums; }
  .pc { flex: 0 0 24mm; background: #fff; color: #000; margin: 3mm 3mm 3mm 0; border-radius: 2mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .pc-n { font-size: 12mm; font-weight: 800; line-height: 0.95; font-variant-numeric: tabular-nums; }
  .pc-of { font-size: 2.8mm; font-weight: 700; letter-spacing: 0.3mm; text-transform: uppercase; margin-top: 0.6mm; }
  .body { flex: 1; min-height: 0; padding: 4.4mm 5mm 0; display: flex; flex-direction: column; }
  .to-name { font-weight: 800; line-height: 1.03; margin-top: 1mm; letter-spacing: -0.1mm; }
  .to-addr { font-size: 3.7mm; line-height: 1.3; margin-top: 1.6mm; }
  .mob { margin-top: auto; padding-bottom: 3mm; display: flex; align-items: center; gap: 2.6mm; }
  .mob svg { width: 6.4mm; height: 6.4mm; flex-shrink: 0; }
  .mnum { font-size: 8.8mm; font-weight: 800; letter-spacing: 0.3mm; line-height: 1; font-variant-numeric: tabular-nums; }
  .foot { margin: 0 5mm; padding: 2.2mm 0 4mm; border-top: 0.4mm solid #000; font-size: 2.9mm; line-height: 1.4; }
  .foot .cap { font-size: 2.2mm; }
  .foot b { font-weight: 800; }
  .from { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .no-from .meta { font-size: 3.3mm; }
  `,
};

/* ── Design 6: Sidebar — a black column down the left carries the carton
 * count; the delivery details read across the rest. ── */
const side = {
  html: (c) => `
    <div class="label${c.showFrom ? '' : ' no-from'}">
      <div class="rail">
        <div class="cap">Parcel</div>
        <div class="pc-n">${c.index}</div>
        <div class="pc-of">of ${c.total}</div>
        <div class="rail-foot">${c.billNumber ? `<b>${esc(c.billNumber)}</b>` : ''}<span>${esc(c.dateStr)}</span></div>
      </div>
      <div class="main">
        <div class="cap">Deliver to</div>
        <div class="to-name clamp3" style="font-size:${stepSize(c.to, [[9, 10], [14, 8], [22, 6.6], [32, 5.4], [999, 4.6]])}mm">${esc(c.to) || '&nbsp;'}</div>
        ${c.streetLines.length ? `<div class="to-addr clamp2">${c.streetLines.map(esc).join(', ')}</div>` : ''}
        ${(c.city || c.pin) ? `<div class="city"><span class="city-n" style="font-size:${stepSize(c.city, [[7, 6.2], [9, 5.2], [11, 4.4], [15, 3.8], [999, 3.2]])}mm">${esc(c.city)}</span>${c.pin ? `<span class="pin">${esc(c.pin)}</span>` : ''}</div>` : ''}
        ${c.mobile ? `<div class="mob"><span class="cap">Mobile</span><span class="mnum">${esc(fmtMobile(c.mobile))}</span></div>` : ''}
        ${c.note ? `<div class="via"><span class="cap">Via</span> <b>${esc(c.note)}</b></div>` : ''}
        ${c.showFrom ? `<div class="from">
          <div class="cap">From</div>
          <div class="shop">${esc(c.from.name)}</div>
          ${fromBitsOf(c.from) ? `<div class="fromline clamp2">${fromBitsOf(c.from)}</div>` : ''}
        </div>` : ''}
      </div>
    </div>`,
  css: `
  .label { flex-direction: row; padding: 0; }
  .rail { flex: 0 0 23mm; background: #000; color: #fff; padding: 5mm 2mm 4.4mm;
    display: flex; flex-direction: column; align-items: center; text-align: center; }
  .rail .cap { font-size: 2.3mm; letter-spacing: 0.6mm; }
  .pc-n { font-size: 17mm; font-weight: 800; line-height: 0.95; margin-top: 2mm; font-variant-numeric: tabular-nums; }
  .pc-of { font-size: 3.2mm; font-weight: 700; letter-spacing: 0.4mm; text-transform: uppercase; margin-top: 1mm; }
  .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 0.6mm; font-size: 2.6mm; line-height: 1.25; }
  .rail-foot b { font-size: 2.9mm; font-weight: 800; word-break: break-all; }
  .main { flex: 1; min-width: 0; padding: 5mm 5mm 4.4mm; display: flex; flex-direction: column; }
  .to-name { font-weight: 800; line-height: 1.03; margin-top: 1mm; letter-spacing: -0.1mm; }
  .to-addr { font-size: 3.4mm; line-height: 1.3; margin-top: 1.4mm; }
  .city { margin-top: 3mm; padding: 1.6mm 0; border-top: 0.6mm solid #000; border-bottom: 0.6mm solid #000;
    display: flex; align-items: baseline; justify-content: space-between; gap: 2.4mm; }
  .city-n { font-weight: 800; text-transform: uppercase; letter-spacing: 0.2mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { font-size: 5.4mm; font-weight: 800; letter-spacing: 0.4mm; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .mob { margin-top: 2.6mm; display: flex; align-items: baseline; gap: 2.4mm; }
  .mob .cap { font-size: 2.2mm; }
  .mnum { font-size: 7.6mm; font-weight: 800; letter-spacing: 0.2mm; line-height: 1; font-variant-numeric: tabular-nums; }
  .via { margin-top: 2mm; font-size: 3.2mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .via .cap { font-size: 2.2mm; }
  .via b { font-weight: 800; }
  .from { margin-top: auto; padding-top: 2mm; border-top: 0.3mm dashed #000; }
  .from .cap { font-size: 2.1mm; }
  .shop { font-size: 3.4mm; font-weight: 800; line-height: 1.15; margin-top: 0.4mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fromline { font-size: 2.3mm; line-height: 1.3; margin-top: 0.3mm; }
  .no-from .mob { margin-top: auto; }
  `,
};

const RENDERERS = { courier, band, boxed, minimal, hub, side };

/** The designs offered in Settings and in the print dialog. */
export const PARCEL_DESIGNS = [
  { v: 'courier', l: 'Courier',   d: 'Customer first and biggest, carton number in a black tile, your details at the bottom.' },
  { v: 'band',    l: 'Bold band', d: 'Your shop on top, a solid black city band and a boxed mobile. Highest contrast.' },
  { v: 'boxed',   l: 'Boxed',     d: 'A ruled docket: every detail in its own cell, like a transport form.' },
  { v: 'minimal', l: 'Minimal',   d: 'Thin lines and clean type only. Uses the least ink.' },
  { v: 'hub',     l: 'City first', d: 'A black banner with the city, PIN and carton count up top, for sorting at the transport office.' },
  { v: 'side',    l: 'Sidebar',   d: 'A black column down the left with the carton number; the delivery details read beside it.' },
];
export const DEFAULT_PARCEL_DESIGN = 'courier';
export const normaliseParcelDesign = (v) => (RENDERERS[v] ? v : DEFAULT_PARCEL_DESIGN);

/**
 * Build the full multi-page label document (one page per parcel).
 * Exported separately so a preview surface can show the exact printed markup.
 * `party` can be a saved customer or a typed-in one (same field names).
 * `design` falls back to the shop's default (company.parcel_tag_design);
 * `showFrom` to company.parcel_tag_show_from (on unless turned off).
 */
export async function buildParcelTagHTML({ company, party, billNumber, totalParcels = 1, note = '', design, showFrom }) {
  const r = RENDERERS[normaliseParcelDesign(design || company?.parcel_tag_design)];
  const total = Math.max(1, Math.min(99, parseInt(totalParcels, 10) || 1));
  const ctx = {
    from: {
      name: company?.company_name || 'Our Store',
      addr: fromAddressLine(company),
      phone: fromPhone(company),
    },
    to: (party?.party_name || '').trim(),
    streetLines: [party?.address_line_1, party?.address_line_2].map((x) => (x || '').trim()).filter(Boolean),
    // No city on file: fall back to the state, so the label still says where it goes.
    city: (party?.city || '').trim() || (party?.state || '').trim(),
    pin: (party?.pincode || '').trim(),
    mobile: (party?.mobile_1 || '').trim(),
    billNumber: String(billNumber || '').trim(),
    note: String(note || '').trim(),
    dateStr: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    total,
    // Print the sender block? Per-print choice wins, else the shop's default.
    showFrom: showFrom !== undefined ? !!showFrom : company?.parcel_tag_show_from !== false,
  };

  const labels = [];
  for (let i = 1; i <= total; i++) labels.push(r.html({ ...ctx, index: i }));

  return `<!doctype html><html><head><meta charset="utf-8"><title>Parcel Tag</title><style>${BASE_CSS}${r.css}</style></head><body>${labels.join('')}</body></html>`;
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

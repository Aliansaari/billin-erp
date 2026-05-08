// ── Bill / Invoice → PDF ───────────────────────────────────────────────
//
// Replaces the Electron `webContents.printToPDF` route (which produced
// PDFs that some viewers couldn't render — the page object was valid
// but the content stream came out malformed because Chromium was being
// asked to render an HTML page that didn't match the offscreen window
// geometry, then squish that into a thermal page size).
//
// Uses jsPDF + jspdf-autotable in the renderer process — the SAME
// engine that's powering the working Customer / Supplier Statement
// exports. No Electron round-trip, no offscreen window, no font
// subsetting drama: we hand jsPDF plain text + autoTable hands it back
// a valid PDF blob.
//
// Layout (A4 portrait):
//   ┌─────────────────────────────────────────────────────┐
//   │ <Company name>                                       │ ← letterhead
//   │ <Address line>                                       │
//   │ GSTIN: ... · PAN: ...                                │
//   │                                       [TAX INVOICE]  │ ← doc-type chip
//   ├─────────────────────────────────────────────────────┤
//   │ Bill #..   Date: ..   Due: ..                        │ ← bill meta
//   │ Bill To:                                             │
//   │   Party Name | Address | City, State                 │
//   │   GSTIN | Mobile                                     │
//   ├─────────────────────────────────────────────────────┤
//   │ # | Item | HSN | Qty | Rate | MRP | Disc% | Amount   │ ← items table
//   ├─────────────────────────────────────────────────────┤
//   │                            Sub Total :  Σ items      │
//   │                            Discount  :  ...          │
//   │                            CGST      :  ...          │
//   │                            SGST      :  ...          │
//   │                            Round Off :  ...          │
//   │                       ┌─ GRAND TOTAL :  ___ ─┐      │
//   │ Amount in words: ...                                 │
//   ├─────────────────────────────────────────────────────┤
//   │ Bank: ...        Authorised Signatory                │ ← footer
//   └─────────────────────────────────────────────────────┘
//
// Thermal-paper sizes (80mm) are NOT supported by this generator —
// thermal prints don't go through "Export PDF" on a list, they go
// through the silent-print path on bill creation. If a user has set a
// thermal profile as their default for sales/purchase exports, we
// still produce A4 — better than the broken thermal printToPDF flow.

import dayjs from 'dayjs';

const PT_PER_MM = 2.834645669;

/* ── Theme presets ─────────────────────────────────────────────────────
 * Each preset maps a Print-Profile theme to a small bundle of jsPDF
 * styling decisions: font family, accent colour, table chrome, header
 * weight. The on-screen renderer (printRenderer.js) implements these
 * with CSS for the live preview / silent print; the same theme names
 * map here for the Export-PDF / WhatsApp flow so what the user previews
 * is what they download.
 *
 * Colours are RGB triplets (jsPDF expects three numeric args). Fonts are
 * one of jsPDF's built-in three: helvetica / times / courier. Anything
 * else would need a separately-embedded TTF, which we deliberately avoid
 * here to keep PDFs round-trippable in every viewer.
 */
const THEME_PRESETS = {
  // Bordered, traditional. The starting point if nothing else is picked.
  classic: {
    bodyFont: 'helvetica',
    titleStyle: 'bold',
    titleSize: 15,
    docTypeStyle: { variant: 'plain', size: 10.5, weight: 'bold' },
    accentRgb: [20, 20, 20],
    rule: { color: [200, 200, 200], width: 0.5 },
    table: {
      headFill: [248, 245, 240],
      headText: [60, 60, 60],
      bodyText: [40, 40, 40],
      lineColor: [220, 220, 220],
      lineWidth: 0.4,
    },
    grandTotal: { mode: 'rule', textColor: [20, 20, 20] },
    pageBorder: false,
    headerBlock: false,
  },
  // Sans-serif, accent-coloured title, borderless headers, soft separator.
  modern: {
    bodyFont: 'helvetica',
    titleStyle: 'bold',
    titleSize: 17,
    docTypeStyle: { variant: 'chip', size: 9, weight: 'bold' },
    accentRgb: [79, 70, 229], // indigo
    rule: { color: [230, 230, 230], width: 0.4 },
    table: {
      headFill: null,
      headText: [110, 110, 110],
      bodyText: [40, 40, 40],
      lineColor: [240, 240, 240],
      lineWidth: 0.35,
      headRule: true,
    },
    grandTotal: { mode: 'pill', textColor: [255, 255, 255] },
    pageBorder: false,
    headerBlock: false,
  },
  // Zero borders, ultra light, generous whitespace.
  minimal: {
    bodyFont: 'helvetica',
    titleStyle: 'normal',
    titleSize: 16,
    docTypeStyle: { variant: 'underline', size: 9, weight: 'normal' },
    accentRgb: [60, 60, 60],
    rule: { color: [240, 240, 240], width: 0.3 },
    table: {
      headFill: null,
      headText: [150, 150, 150],
      bodyText: [50, 50, 50],
      lineColor: [245, 245, 245],
      lineWidth: 0.3,
      headRule: true,
    },
    grandTotal: { mode: 'rule', textColor: [40, 40, 40] },
    pageBorder: false,
    headerBlock: false,
  },
  // Serif, italic title — boutique / professional.
  elegant: {
    bodyFont: 'times',
    titleStyle: 'italic',
    titleSize: 19,
    docTypeStyle: { variant: 'rules', size: 9, weight: 'normal' },
    accentRgb: [139, 92, 246],
    rule: { color: [220, 220, 220], width: 0.4 },
    table: {
      headFill: null,
      headText: [100, 100, 100],
      bodyText: [40, 40, 40],
      lineColor: [225, 225, 225],
      lineWidth: 0.35,
      headRule: true,
    },
    grandTotal: { mode: 'rule', textColor: [80, 60, 160] },
    pageBorder: false,
    headerBlock: false,
  },
  // Full page border, accent-coloured header band, white-on-accent text.
  boxed: {
    bodyFont: 'helvetica',
    titleStyle: 'bold',
    titleSize: 16,
    docTypeStyle: { variant: 'chip', size: 9, weight: 'bold' },
    accentRgb: [177, 71, 47], // terracotta
    rule: { color: [177, 71, 47], width: 0.6 },
    table: {
      headFill: [177, 71, 47],
      headText: [255, 255, 255],
      bodyText: [40, 40, 40],
      lineColor: [220, 220, 220],
      lineWidth: 0.4,
    },
    grandTotal: { mode: 'fill', textColor: [255, 255, 255] },
    pageBorder: true,
    headerBlock: true,
  },
  // Studio — modern editorial look with a left accent rule on the title
  // and very generous whitespace. Same palette base as `modern` but with
  // a cleaner signal/chrome ratio.
  studio: {
    bodyFont: 'helvetica',
    titleStyle: 'bold',
    titleSize: 19,
    docTypeStyle: { variant: 'plain', size: 10, weight: 'normal' },
    accentRgb: [33, 96, 76], // forest
    rule: { color: [220, 220, 220], width: 0.4 },
    table: {
      headFill: null,
      headText: [120, 120, 120],
      bodyText: [40, 40, 40],
      lineColor: [240, 240, 240],
      lineWidth: 0.3,
      headRule: true,
    },
    grandTotal: { mode: 'rule', textColor: [33, 96, 76] },
    pageBorder: false,
    headerBlock: false,
    titleAccentBar: true,
  },
  // Cash Memo — classic Indian retail cash-memo print. Full-page hairline
  // frame, large centered serif title, bordered ruled item table, and a
  // bordered totals block flush with the frame. The HTML preview renders
  // a dedicated CASH-MEMO box on the right side of the meta band; the
  // PDF keeps the standard left/right meta columns but matches the rest
  // of the visual language so the printed PDF looks plausibly close to
  // the silent-print output. Pairs naturally with `doc_label = "CASH MEMO"`.
  cashmemo: {
    bodyFont: 'helvetica',
    titleFont: 'times',          // serif title only — body keeps helvetica for table legibility
    titleStyle: 'bold',
    titleSize: 22,
    titleAlign: 'center',
    docTypeStyle: { variant: 'plain', size: 11, weight: 'bold' },
    accentRgb: [20, 20, 20],
    rule: { color: [0, 0, 0], width: 0.5 },
    table: {
      headFill: null,
      headText: [20, 20, 20],
      bodyText: [20, 20, 20],
      lineColor: [0, 0, 0],
      lineWidth: 0.5,
      headRule: false,           // every cell has a full hairline border
    },
    grandTotal: { mode: 'rule', textColor: [0, 0, 0] },
    pageBorder: true,
    headerBlock: false,
  },
  // Wholesale — dense tabular feel with a courier numeric column. Built
  // for B2B trade where everyone reads bills at a glance and wants the
  // numbers to align column-wise.
  wholesale: {
    bodyFont: 'helvetica',
    titleStyle: 'bold',
    titleSize: 14,
    docTypeStyle: { variant: 'plain', size: 11, weight: 'bold' },
    accentRgb: [50, 50, 50],
    rule: { color: [180, 180, 180], width: 0.5 },
    table: {
      headFill: [240, 240, 240],
      headText: [40, 40, 40],
      bodyText: [30, 30, 30],
      lineColor: [200, 200, 200],
      lineWidth: 0.4,
      monoNumeric: true,
    },
    grandTotal: { mode: 'fill', fillRgb: [40, 40, 40], textColor: [255, 255, 255] },
    pageBorder: false,
    headerBlock: false,
  },
};

// Resolve a profile.theme name to a preset. Falls back to classic for
// unknown names so a deleted/typoed theme still produces a clean PDF.
function resolveTheme(profile) {
  const name = (profile?.theme || 'classic').toLowerCase();
  const base = THEME_PRESETS[name] || THEME_PRESETS.classic;
  // The user-picked accent on the print profile overrides the theme's
  // default accent — themes ship a sensible default but the operator
  // gets the final say from the colour picker.
  const accent = parseHexRgb(profile?.accent_color) || base.accentRgb;
  return { ...base, accentRgb: accent };
}

// Convert "#4F46E5" → [79, 70, 229]. Returns null if input is anything
// other than a 6-char hex (e.g. user cleared the field, or typed a name).
function parseHexRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Render the doc-type label (e.g. "TAX INVOICE") in the variant the
// theme prescribes. `xRight` is the right-aligned anchor; the chip
// extends leftward from there. `yTop` is roughly the top of the chip.
function drawDocTypeChip(doc, label, xRight, yTop, T) {
  const v = T.docTypeStyle || { variant: 'plain', size: 10.5, weight: 'bold' };
  const A = T.accentRgb;
  doc.setFont(T.bodyFont, v.weight === 'bold' ? 'bold' : 'normal').setFontSize(v.size);
  const w = doc.getTextWidth(label);
  const padX = 8, padY = 4;

  if (v.variant === 'chip') {
    // Solid accent rectangle, inverted text.
    const fillH = v.size + padY * 2;
    const x0 = xRight - w - padX * 2;
    const y0 = yTop;
    doc.setFillColor(A[0], A[1], A[2]);
    if (doc.roundedRect) {
      doc.roundedRect(x0, y0, w + padX * 2, fillH, 4, 4, 'F');
    } else {
      doc.rect(x0, y0, w + padX * 2, fillH, 'F');
    }
    doc.setTextColor(255, 255, 255);
    doc.text(label, xRight - padX, y0 + v.size + 2);
  } else if (v.variant === 'underline') {
    // Plain text with a thin underline beneath.
    doc.setTextColor(A[0], A[1], A[2]);
    doc.text(label, xRight, yTop + v.size, { align: 'right' });
    doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(0.4);
    doc.line(xRight - w - 2, yTop + v.size + 3, xRight + 2, yTop + v.size + 3);
  } else if (v.variant === 'rules') {
    // Text bracketed by horizontal rules above + below.
    doc.setTextColor(A[0], A[1], A[2]);
    doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(0.4);
    doc.line(xRight - w - 4, yTop, xRight + 2, yTop);
    doc.text(label, xRight, yTop + v.size + 1, { align: 'right' });
    doc.line(xRight - w - 4, yTop + v.size + 5, xRight + 2, yTop + v.size + 5);
  } else {
    // Plain — bare text in the theme's accent colour.
    doc.setTextColor(A[0], A[1], A[2]);
    doc.text(label, xRight, yTop + v.size, { align: 'right' });
  }
  // Restore default text colour for whatever the caller paints next.
  doc.setTextColor(20, 20, 20);
}

const esc = (s) => (s == null ? '' : String(s));
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fmtQty = (v) => {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
};
const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '');

// Indian-system number-to-words. Mirrors printRenderer.numberToWords so
// the PDF and on-screen render read the same.
function numberToWords(num) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const conv = (n) => {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + ' ' + conv(n % 10);
    return ones[Math.floor(n / 100)] + ' Hundred ' + conv(n % 100);
  };
  const n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return 'Zero Rupees Only';
  let s = '';
  if (Math.floor(n / 10000000)) { s += conv(Math.floor(n / 10000000)) + 'Crore '; }
  if (Math.floor((n % 10000000) / 100000)) { s += conv(Math.floor((n % 10000000) / 100000)) + 'Lakh '; }
  if (Math.floor((n % 100000) / 1000)) { s += conv(Math.floor((n % 100000) / 1000)) + 'Thousand '; }
  if (Math.floor((n % 1000))) { s += conv(n % 1000); }
  return 'Rupees ' + s.trim() + ' Only';
}

const DOC_LABEL = {
  sales:           'TAX INVOICE',
  purchase:        'PURCHASE BILL',
  sales_return:    'CREDIT NOTE',
  purchase_return: 'DEBIT NOTE',
  receipt:         'RECEIPT',
  payment:         'PAYMENT VOUCHER',
};

/**
 * Build a PDF blob for the given bill and trigger a download.
 *
 * @param {object} opts
 * @param {string} opts.docType   sales | purchase | sales_return | purchase_return
 * @param {object} opts.bill      Full bill (with items[] and *_amount fields)
 * @param {object} opts.profile   Print profile (paper size, toggles, header html, …)
 * @param {object} opts.company   System settings (company_name, gstin, …)
 * @param {string} opts.fileName  Suggested file name (e.g. "Cash-25-261677.pdf")
 *
 * Returns the produced Blob. The caller is responsible for saving / sharing
 * (we expose the blob so an Electron path can write it to Downloads while
 * a plain-browser path can fall back to a navigator-blob download).
 */
export async function buildBillPdf({ docType, bill, profile, company, fileName }) {
  if (!bill) throw new Error('bill is required');

  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  // Resolve the visual theme up front. Every paint operation below
  // reads from `T` so a single switch in Print Settings cascades through
  // the whole document — letterhead, table, totals, footer.
  const T = resolveTheme(profile);
  const A = T.accentRgb;       // [r, g, b]
  const RULE = T.rule;

  // A4 portrait. We always emit A4 — the print profile may say "thermal"
  // for the silent-print pipeline, but Export PDF deliberately ignores
  // that and produces a proper office-doc.
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 40;             // page margin
  let y = M;

  /* Boxed theme — full-page accent border. Drawn first so all subsequent
   * content sits inside it. */
  if (T.pageBorder) {
    doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(1);
    doc.rect(20, 20, pageW - 40, pageH - 40);
  }

  /* Boxed theme — accent-coloured header band that holds the company
   * name + tax info in inverted text. */
  if (T.headerBlock) {
    doc.setFillColor(A[0], A[1], A[2]);
    doc.rect(20, 20, pageW - 40, 70, 'F');
  }

  /* Studio theme — short accent vertical rule to the left of the title,
   * gives the letterhead a magazine-spread feel. */
  if (T.titleAccentBar) {
    doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(3);
    doc.line(M - 6, y - 3, M - 6, y + 14);
  }

  /* ── Letterhead ─────────────────────────────────────────────────── */
  // titleFont may differ from bodyFont (e.g. cashmemo prints the shop
  // name in `times` for that classic serif look while keeping the rest
  // of the bill in helvetica). titleAlign='center' anchors the title
  // and the address/GSTIN sub-lines to the page centre — used by the
  // cashmemo theme. Defaults preserve the prior left-aligned layout.
  const titleFont  = T.titleFont || T.bodyFont;
  const titleAlign = T.titleAlign || 'left';
  const isCenterTitle = titleAlign === 'center' && !T.headerBlock;
  const subX  = isCenterTitle ? pageW / 2 : M;
  const subOpts = isCenterTitle ? { align: 'center' } : undefined;

  const titleColor = T.headerBlock ? [255, 255, 255] : (T.titleAccentBar ? A : [20, 20, 20]);
  doc.setFont(titleFont, T.titleStyle).setFontSize(T.titleSize)
     .setTextColor(titleColor[0], titleColor[1], titleColor[2]);
  const companyName = profile?.header_title || company?.company_name || 'Company Name';
  doc.text(companyName, isCenterTitle ? pageW / 2 : M, y + 4, isCenterTitle ? { align: 'center' } : undefined);
  y += T.titleSize + 4;

  const subColor = T.headerBlock ? [240, 240, 240] : [80, 80, 80];
  doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(subColor[0], subColor[1], subColor[2]);
  if (company?.company_address) {
    // When centering, the address gets the full inner page width so a
    // long line of "City · State · PIN" doesn't truncate awkwardly.
    const addrW = isCenterTitle ? pageW - 2 * M : pageW - 2 * M - 160;
    const addrLines = doc.splitTextToSize(company.company_address, addrW);
    for (const ln of addrLines) {
      doc.text(ln, subX, y, subOpts);
      y += 11;
    }
  }
  if (company?.gstin) {
    const taxLine = `GSTIN: ${company.gstin}` + (company?.pan_number ? ` | PAN: ${company.pan_number}` : '');
    doc.text(taxLine, subX, y, subOpts);
    y += 11;
  }

  /* Doc-type chip pinned to the top-right — variant depends on theme.
   *   chip      — solid accent rounded rectangle, white text (modern, boxed)
   *   underline — text with a thin underline beneath (minimal)
   *   rules     — text bracketed by horizontal rules above + below (elegant)
   *   plain     — bare text (classic, studio, wholesale)
   * Themes with a centered title (cashmemo) skip the top-right chip
   * altogether — having a left-edge centered title AND a right-pinned
   * subtitle clashes visually. Those themes get the subtitle drawn
   * inline under the centered address instead. */
  // User-overridable doc subtitle — Print Settings > Header > Document title.
  // Blank falls back to the built-in default per docType.
  const docLabel = (profile?.doc_label || '').trim() || DOC_LABEL[docType] || 'DOCUMENT';
  if (isCenterTitle) {
    // Centered subtitle under the address. Bracketed by hairline rules so it
    // reads as a doc-type ("CASH MEMO" / "TAX INVOICE") rather than a tagline.
    y += 4;
    doc.setFont(T.bodyFont, 'bold').setFontSize(11).setTextColor(20);
    const labelW = doc.getTextWidth(docLabel);
    doc.setDrawColor(0, 0, 0).setLineWidth(0.4);
    doc.line(pageW / 2 - labelW / 2 - 14, y, pageW / 2 + labelW / 2 + 14, y);
    doc.text(docLabel, pageW / 2, y + 12, { align: 'center' });
    doc.line(pageW / 2 - labelW / 2 - 14, y + 16, pageW / 2 + labelW / 2 + 14, y + 16);
    y += 16;
  } else {
    drawDocTypeChip(doc, docLabel, pageW - M, M + 6, T);
  }

  // Letterhead separator — skipped for boxed theme since the band is the separator.
  if (!T.headerBlock) {
    y = Math.max(y, M + 50) + 6;
    doc.setDrawColor(RULE.color[0], RULE.color[1], RULE.color[2]).setLineWidth(RULE.width);
    doc.line(M, y, pageW - M, y);
    y += 14;
  } else {
    y = 90 + 14;  // below the boxed header band
  }

  /* ── Bill meta + party block (two columns) ──────────────────────── */
  const metaX = M;
  const partyX = pageW / 2 + 10;
  const metaY = y;

  // Left column: bill meta
  doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(110);
  // "Invoice No" reads naturally on a sales invoice; everything else
  // (purchase / return / receipt / payment) gets the more generic "Bill No".
  // Switch on docType directly — comparing against `docLabel` would break
  // as soon as the user overrides the subtitle in Print Settings.
  doc.text(docType === 'sales' ? 'Invoice No:' : 'Bill No:', metaX, y);
  doc.setFont(T.bodyFont, 'bold').setTextColor(20);
  doc.text(esc(bill.bill_number || bill.transaction_number || '—'), metaX + 70, y);

  doc.setFont(T.bodyFont, 'normal').setTextColor(110);
  doc.text('Date:', metaX, y + 14);
  doc.setFont(T.bodyFont, 'bold').setTextColor(20);
  doc.text(fmtDate(bill.bill_date || bill.transaction_date), metaX + 70, y + 14);

  if (bill.due_date) {
    doc.setFont(T.bodyFont, 'normal').setTextColor(110);
    doc.text('Due Date:', metaX, y + 28);
    doc.setFont(T.bodyFont, 'bold').setTextColor(20);
    doc.text(fmtDate(bill.due_date), metaX + 70, y + 28);
  }

  // Right column: party block
  const party = bill.customer || bill.supplier || bill.party || {};
  const isCash = !party.party_name || party.is_system_cash;
  const walkIn = String(bill.walk_in_name || '').trim();

  doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(110);
  const billToLabel = (docType === 'purchase' || docType === 'purchase_return') ? 'Supplier:' : 'Bill To:';
  doc.text(billToLabel, partyX, metaY);
  let py = metaY + 14;
  doc.setFont(T.bodyFont, 'bold').setFontSize(10).setTextColor(20);
  if (isCash) {
    doc.text('Cash', partyX, py);
    py += 12;
    if (walkIn) {
      doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(60);
      const wraps = doc.splitTextToSize(walkIn, pageW - partyX - M);
      for (const ln of wraps) { doc.text(ln, partyX, py); py += 11; }
    }
  } else {
    const wraps = doc.splitTextToSize(party.party_name, pageW - partyX - M);
    for (const ln of wraps) { doc.text(ln, partyX, py); py += 12; }

    doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(80);
    const addrParts = [party.address_line1, [party.city, party.state].filter(Boolean).join(', ')]
      .filter(Boolean);
    for (const ap of addrParts) {
      const wraps2 = doc.splitTextToSize(ap, pageW - partyX - M);
      for (const ln of wraps2) { doc.text(ln, partyX, py); py += 11; }
    }
    if (party.gstin)    { doc.text(`GSTIN: ${party.gstin}`, partyX, py); py += 11; }
    if (party.mobile_1) { doc.text(`Mobile: ${party.mobile_1}`, partyX, py); py += 11; }
  }

  y = Math.max(y + 42, py + 6);
  doc.setDrawColor(RULE.color[0], RULE.color[1], RULE.color[2]).setLineWidth(RULE.width);
  doc.line(M, y, pageW - M, y);
  y += 8;

  /* ── Items table ────────────────────────────────────────────────── */
  const showHsn      = profile?.show_hsn      !== false;
  const showMrp      = profile?.show_mrp      !== false;
  const showDiscount = profile?.show_discount !== false;
  const showBatch    = !!profile?.show_batch;

  const cols = ['#', 'Item'];
  if (showHsn)      cols.push('HSN');
  if (showBatch)    cols.push('Batch');
  cols.push('Qty', 'Rate');
  if (showMrp)      cols.push('MRP');
  if (showDiscount) cols.push('Disc%');
  cols.push('Amount');

  const items = Array.isArray(bill.items) ? bill.items : [];
  const body = items.map((it, i) => {
    const row = [
      String(i + 1),
      esc(it.product_name || ''),
    ];
    if (showHsn)      row.push(esc(it.hsn_code || ''));
    if (showBatch)    row.push(esc(it.batch_number || it.batch?.batch_number || ''));
    row.push(fmtQty(it.quantity));
    row.push(fmt(it.rate || it.purchase_rate));
    if (showMrp)      row.push(fmt(it.mrp));
    if (showDiscount) row.push((Number(it.discount_percentage || 0)).toFixed(2));
    row.push(fmt(it.total_amount));
    return row;
  });

  // Build column styles by index so right-align is applied to numeric
  // columns regardless of which optional columns are present.
  const colStyles = {};
  let idx = 0;
  colStyles[idx++] = { cellWidth: 22, halign: 'center' };       // #
  colStyles[idx++] = { cellWidth: 'auto' };                      // Item
  if (showHsn)   { colStyles[idx++] = { cellWidth: 50 }; }
  if (showBatch) { colStyles[idx++] = { cellWidth: 60 }; }
  colStyles[idx++] = { cellWidth: 50, halign: 'right' };         // Qty
  colStyles[idx++] = { cellWidth: 60, halign: 'right' };         // Rate
  if (showMrp)      { colStyles[idx++] = { cellWidth: 55, halign: 'right' }; }
  if (showDiscount) { colStyles[idx++] = { cellWidth: 45, halign: 'right' }; }
  colStyles[idx++] = { cellWidth: 70, halign: 'right' };         // Amount

  // Theme-driven autoTable styling. Two visual modes:
  //   - "grid"  → boxed cells (classic, boxed, wholesale themes)
  //   - "plain" → borderless body, single rule under the header
  //               (modern, minimal, elegant, studio)
  const tableMode = T.table.headRule ? 'plain' : 'grid';
  const headStyles = T.table.headFill
    ? { fillColor: T.table.headFill, textColor: T.table.headText, fontStyle: 'bold', fontSize: 8.5 }
    : { fillColor: false,             textColor: T.table.headText, fontStyle: 'bold', fontSize: 8.5,
        lineColor: A, lineWidth: 0.6 };
  const monoColumnPatch = T.table.monoNumeric
    ? { font: 'courier', fontStyle: 'normal' }
    : null;
  const styledColStyles = monoColumnPatch
    ? Object.fromEntries(Object.entries(colStyles).map(([k, v]) => [
        k,
        v.halign === 'right' ? { ...v, ...monoColumnPatch } : v,
      ]))
    : colStyles;

  doc.autoTable({
    startY: y,
    head: [cols],
    body: body.length ? body : [['', items.length === 0 ? '(no items)' : '', ...new Array(cols.length - 2).fill('')]],
    theme: tableMode,
    styles: {
      font: T.bodyFont,
      fontSize: 9,
      cellPadding: 5,
      lineColor: T.table.lineColor,
      lineWidth: T.table.lineWidth,
      textColor: T.table.bodyText,
    },
    headStyles,
    columnStyles: styledColStyles,
    margin: { left: M, right: M },
  });

  y = doc.lastAutoTable.finalY + 8;

  /* ── Totals block (right column) ────────────────────────────────── */
  const totals = [];
  const sub = Number(bill.sub_total || 0);
  const disc = Number(bill.discount_amount || 0);
  const cgst = Number(bill.cgst_amount || 0);
  const sgst = Number(bill.sgst_amount || 0);
  const igst = Number(bill.igst_amount || 0);
  const cess = Number(bill.cess_amount || 0);
  const freight = Number(bill.freight_charges || 0);
  const sd      = Number(bill.special_discount || 0);
  const ro      = Number(bill.round_off || 0);
  const grand   = Number(bill.total_amount || 0);
  const ret     = Number(bill.return_amount || 0);
  const bal     = Number(bill.balance_amount != null ? bill.balance_amount : 0);

  if (sub)           totals.push(['Sub Total', fmt(sub)]);
  if (disc)          totals.push(['Discount',  '-' + fmt(disc)]);
  if (cgst)          totals.push(['CGST',      fmt(cgst)]);
  if (sgst)          totals.push(['SGST',      fmt(sgst)]);
  if (igst)          totals.push(['IGST',      fmt(igst)]);
  if (cess)          totals.push(['Cess',      fmt(cess)]);
  if (freight)       totals.push(['Freight',   fmt(freight)]);
  if (sd)            totals.push(['Special Disc', '-' + fmt(sd)]);
  if (ro)            totals.push(['Round Off', (ro >= 0 ? '+' : '') + fmt(Math.abs(ro))]);

  const totalsX = pageW - M - 200;
  const labelX  = totalsX;
  const valueX  = pageW - M;

  doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(60);
  for (const [label, value] of totals) {
    if (y > pageH - 100) { doc.addPage(); y = M; }
    doc.text(label, labelX, y);
    doc.text(value, valueX, y, { align: 'right' });
    y += 13;
  }

  // Grand total bar — variant per theme:
  //   rule  — accent-coloured rules above + below (classic, minimal, elegant, studio)
  //   pill  — solid accent rounded rectangle, white text (modern)
  //   fill  — solid accent rectangle, white text (boxed, wholesale)
  if (y > pageH - 80) { doc.addPage(); y = M; }
  const gtMode = T.grandTotal.mode || 'rule';
  if (gtMode === 'fill' || gtMode === 'pill') {
    const fillRgb = T.grandTotal.fillRgb || A;
    const txt     = T.grandTotal.textColor || [255, 255, 255];
    const radius  = gtMode === 'pill' ? 5 : 0;
    doc.setFillColor(fillRgb[0], fillRgb[1], fillRgb[2]);
    if (radius && doc.roundedRect) {
      doc.roundedRect(totalsX - 8, y - 4, valueX - totalsX + 16, 22, radius, radius, 'F');
    } else {
      doc.rect(totalsX - 8, y - 4, valueX - totalsX + 16, 22, 'F');
    }
    doc.setFont(T.bodyFont, 'bold').setFontSize(11).setTextColor(txt[0], txt[1], txt[2]);
    doc.text('GRAND TOTAL', labelX, y + 11);
    doc.text(fmt(grand), valueX, y + 11, { align: 'right' });
    y += 28;
  } else {
    const txt = T.grandTotal.textColor || [20, 20, 20];
    doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(1);
    doc.line(totalsX, y, valueX, y);
    y += 14;
    doc.setFont(T.bodyFont, 'bold').setFontSize(11).setTextColor(txt[0], txt[1], txt[2]);
    doc.text('GRAND TOTAL', labelX, y);
    doc.text(fmt(grand), valueX, y, { align: 'right' });
    y += 4;
    doc.line(totalsX, y + 2, valueX, y + 2);
    y += 16;
    doc.setTextColor(20, 20, 20);
  }

  // Balance / paid (sales side)
  if (ret) {
    doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(60);
    doc.text('Return Credit', labelX, y);
    doc.text('-' + fmt(ret), valueX, y, { align: 'right' });
    y += 13;
  }
  if (bal !== grand && bal !== 0) {
    const paid = Math.max(0, grand - ret - bal);
    if (paid > 0) {
      doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(60);
      doc.text('Paid', labelX, y);
      doc.text(fmt(paid), valueX, y, { align: 'right' });
      y += 13;
    }
    doc.setFont(T.bodyFont, 'bold').setFontSize(10).setTextColor(180, 50, 50);
    doc.text('Balance Due', labelX, y);
    doc.text(fmt(bal), valueX, y, { align: 'right' });
    doc.setTextColor(20);
    y += 14;
  }

  /* ── Amount in words ────────────────────────────────────────────── */
  if (y > pageH - 70) { doc.addPage(); y = M; }
  y += 8;
  doc.setFont(T.bodyFont, 'italic').setFontSize(9).setTextColor(80);
  const words = numberToWords(grand);
  const wordWraps = doc.splitTextToSize(words, pageW - 2 * M);
  for (const ln of wordWraps) {
    doc.text(ln, M, y);
    y += 11;
  }

  /* ── Footer (bank / terms / signature) ──────────────────────────── */
  const footerY = pageH - M - 60;
  doc.setDrawColor(220).setLineWidth(0.4);
  doc.line(M, footerY, pageW - M, footerY);

  const bankText = profile?.bank_details ? String(profile.bank_details) : '';
  const tcText   = profile?.terms_and_conditions ? String(profile.terms_and_conditions) : '';
  let ftY = footerY + 14;
  if (bankText) {
    doc.setFont(T.bodyFont, 'bold').setFontSize(8.5).setTextColor(80);
    doc.text('Bank Details', M, ftY);
    doc.setFont(T.bodyFont, 'normal').setFontSize(8).setTextColor(100);
    const lines = doc.splitTextToSize(bankText, pageW / 2 - M - 10);
    let by = ftY + 11;
    for (const ln of lines.slice(0, 3)) {
      doc.text(ln, M, by);
      by += 10;
    }
  }
  if (tcText) {
    doc.setFont(T.bodyFont, 'bold').setFontSize(8.5).setTextColor(80);
    doc.text('Terms & Conditions', M, ftY + 38);
    doc.setFont(T.bodyFont, 'normal').setFontSize(7.5).setTextColor(110);
    const lines = doc.splitTextToSize(tcText, pageW / 2 - M - 10);
    let ty = ftY + 49;
    for (const ln of lines.slice(0, 2)) {
      doc.text(ln, M, ty);
      ty += 9;
    }
  }

  // Signature block on the right.
  if (profile?.show_signature !== false) {
    const sigW = 130;
    const sigX = pageW - M - sigW;
    doc.setFont(T.bodyFont, 'normal').setFontSize(9).setTextColor(60);
    doc.text('For ' + (profile?.header_title || company?.company_name || ''), sigX + sigW, ftY, { align: 'right' });
    doc.setDrawColor(120).setLineWidth(0.4);
    doc.line(sigX, footerY + 48, pageW - M, footerY + 48);
    doc.setFontSize(8).setTextColor(110);
    doc.text(profile?.signature_label || 'Authorised Signatory', pageW - M, footerY + 58, { align: 'right' });
  }

  /* ── Page number footers ────────────────────────────────────────── */
  const generatedAt = dayjs().format('DD MMM YYYY · HH:mm');
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont(T.bodyFont, 'normal').setFontSize(7).setTextColor(150);
    doc.text(`Generated ${generatedAt}`, M, pageH - 12);
    if (totalPages > 1) {
      doc.text(`Page ${i} of ${totalPages}`, pageW - M, pageH - 12, { align: 'right' });
    }
  }

  return doc.output('blob');
}

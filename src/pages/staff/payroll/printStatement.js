import dayjs from 'dayjs';

/*
 * Printable staff statement (A4). Same approach as printPayslip.js: built
 * into a hidden iframe and printed from there, so it behaves the same in the
 * browser and in Electron. Figures come from the statement API as-is.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = (iso) => dayjs(iso).format('DD-MM-YYYY');
const balWords = (n) => (Math.abs(n) < 0.5 ? 'Settled' : n > 0 ? `₹${money(n)} payable to staff` : `₹${money(-n)} advance with staff`);

export function printStatement(st, { company, periodLabel, person }) {
  const shop = company?.company_name || '';
  const addr = String(company?.company_address || '').replace(/\s*\n\s*/g, ', ');
  const s = st.staff;
  let rows = '';
  if (st.from) rows += `<tr class="muted"><td>${fmtD(st.from)}</td><td>Opening balance</td><td></td><td></td><td class="r">${money(st.opening)}</td></tr>`;
  for (const r of st.rows) {
    rows += `<tr><td>${fmtD(r.date)}</td><td>${esc(r.text)}${r.detail ? `<div class="sub">${esc(r.detail)}</div>` : ''}</td>`
      + `<td class="r">${r.earned ? money(r.earned) : ''}</td><td class="r">${r.paid ? money(r.paid) : ''}</td><td class="r">${money(r.balance)}</td></tr>`;
  }
  if (!st.rows.length) rows += '<tr><td colspan="5" class="muted c">No entries in this period.</td></tr>';

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Staff statement · ${esc(s.name)}</title><style>
    @page { size: A4; margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1d1814; font-size: 11.5px; margin: 0; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1d1814; padding-bottom: 8px; }
    .shop b { font-size: 17px; display: block; } .shop span { color: #555; font-size: 10.5px; }
    .ttl { text-align: right; } .ttl b { font-size: 14px; letter-spacing: .5px; text-transform: uppercase; display: block; } .ttl span { color: #555; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 12px 0 14px; }
    .meta div { display: flex; gap: 8px; } .meta span { color: #666; min-width: 82px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #555; border-bottom: 1px solid #1d1814; padding: 6px 6px; }
    td { padding: 6px; border-bottom: 1px solid #e3ddd3; vertical-align: top; }
    .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } .c { text-align: center; }
    .sub { color: #777; font-size: 10px; margin-top: 1px; } .muted { color: #777; }
    tfoot td { border-top: 1.5px solid #1d1814; border-bottom: 0; font-weight: 700; }
    .bal { margin-top: 14px; padding: 10px 12px; border: 1px solid #1d1814; display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; }
    .sign { display: flex; justify-content: space-between; margin-top: 48px; color: #555; }
    .sign div { border-top: 1px solid #999; padding-top: 4px; width: 38%; text-align: center; }
    .note { color: #777; font-size: 9.5px; margin-top: 10px; }
  </style></head><body>
    <div class="top"><div class="shop"><b>${esc(shop)}</b><span>${esc(addr)}</span></div>
      <div class="ttl"><b>Staff statement</b><span>${esc(periodLabel)}</span></div></div>
    <div class="meta">
      <div><span>Name</span><b>${esc(s.name)}</b></div>
      <div><span>Printed on</span>${dayjs().format('DD-MM-YYYY')}</div>
      <div><span>Designation</span>${esc(s.designation || '—')}</div>
      <div><span>Salary</span>${person?.amount ? `₹${money(person.amount)} ${person.pay_type === 'daily' ? 'a day' : person.pay_type === 'hourly' ? 'an hour' : 'a month'}` : '—'}</div>
      ${s.phone ? `<div><span>Phone</span>${esc(s.phone)}</div>` : ''}
      ${s.joined_on ? `<div><span>Joined</span>${fmtD(s.joined_on)}</div>` : ''}
    </div>
    <table>
      <thead><tr><th style="width:84px">Date</th><th>Details</th><th class="r" style="width:96px">Earned</th><th class="r" style="width:96px">Paid</th><th class="r" style="width:104px">Balance</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2">Total for the period</td><td class="r">${money(st.earned)}</td><td class="r">${money(st.paid)}</td><td class="r">${money(st.closing)}</td></tr></tfoot>
    </table>
    <div class="bal"><span>Closing balance</span><span>${balWords(st.closing)}</span></div>
    <p class="note">Earned is salary after PF, ESI and other deductions. Advances are shown as paid on the day given.</p>
    <div class="sign"><div>Staff signature</div><div>For ${esc(shop || 'the employer')}</div></div>
  </body></html>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (_) { /* print dialog unavailable */ }
    setTimeout(() => iframe.remove(), 2000);
  }, 300);
}

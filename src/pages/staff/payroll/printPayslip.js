import dayjs from 'dayjs';

/*
 * Printable payslips (A4, one per page). Rendered into a hidden iframe and
 * printed from there, which works the same in the browser and in Electron and
 * never touches the app's own page or styles. Figures come straight from the
 * server's snapshot; nothing is recalculated here.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Indian numbering in words, for the "net pay in words" line.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function three(n) { return `${n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${n % 100 ? two(n % 100) : ''}`; }
export function rupeesInWords(amount) {
  let n = Math.round(Number(amount) || 0);
  if (!n) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return `${parts.join(' ')} Rupees Only`;
}

function slipHtml(line, company, period) {
  const s = line.slip; const a = s.attendance;
  const shop = company?.company_name || 'Payslip';
  const addr = String(company?.company_address || '').replace(/\s*\n\s*/g, ', ');
  const rows = Math.max(s.earnings.length, s.deductions.length + (s.round_off ? 1 : 0));
  const ded = [...s.deductions, ...(s.round_off ? [{ label: 'Rounding', amount: -s.round_off }] : [])];
  let body = '';
  for (let i = 0; i < rows; i++) {
    const e = s.earnings[i]; const d = ded[i];
    body += `<tr><td>${e ? esc(e.label) : ''}</td><td class="r">${e ? money(e.amount) : ''}</td><td>${d ? esc(d.label) : ''}</td><td class="r">${d ? money(d.amount) : ''}</td></tr>`;
  }
  const att = s.pay_type === 'hourly'
    ? [['Paid hours', a.paid_hours], ['Hours worked', a.worked_hours], ['Days present', a.present], ['Paid leave', a.paid_leave]]
    : [['Paid days', s.pay_type === 'monthly' ? `${a.paid_days} / ${s.basis_days}` : a.paid_days], ['Present', a.present], ['Paid leave', a.paid_leave],
      ['Unpaid leave', a.unpaid_leave], ['Absent', a.absent], ['Late', a.late], ...(a.ot_hours ? [['Overtime (h)', a.ot_hours]] : [])];
  const ids = [
    ['Employee', s.staff.name], ['Designation', s.staff.designation], ['Pay type', { monthly: 'Monthly', daily: 'Daily wage', hourly: 'Hourly' }[s.pay_type]],
    ['Bank A/c', s.bank?.account ? `••••${String(s.bank.account).slice(-4)}${s.bank.ifsc ? ` (${s.bank.ifsc})` : ''}` : null],
    ['PAN', s.ids?.pan], ['UAN', s.ids?.uan], ['ESIC No.', s.ids?.esic],
  ].filter(([, v]) => v);
  return `
  <section class="slip">
    <header><div><h1>${esc(shop)}</h1>${addr ? `<p>${esc(addr)}</p>` : ''}${company?.gstin ? `<p>GSTIN ${esc(company.gstin)}</p>` : ''}</div>
      <div class="ttl"><b>Payslip</b><span>${esc(dayjs(`${period}-01`).format('MMMM YYYY'))}</span></div></header>
    <div class="ids">${ids.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="att">${att.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
    <table class="lines"><thead><tr><th>Earnings</th><th class="r">Amount</th><th>Deductions</th><th class="r">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Gross pay</td><td class="r">${money(s.gross)}</td><td>Total deductions</td><td class="r">${money(s.total_deductions - (s.round_off || 0))}</td></tr></tfoot></table>
    <div class="net"><div><span>Net pay</span><b>${money(s.net)}</b></div><p>${esc(rupeesInWords(s.net))}</p></div>
    ${s.employer.length ? `<p class="er">Paid by the employer in addition: ${s.employer.map((e) => `${esc(e.label)} ${money(e.amount)}`).join(', ')}. Cost to company ${money(s.employer_cost)}.</p>` : ''}
    ${line.paid ? `<p class="er">Paid so far: ${money(line.paid)}${line.due > 0 ? ` · Balance ${money(line.due)}` : ''}.</p>` : ''}
    <footer><span>This is a computer-generated payslip.</span><span>Generated ${esc(dayjs().format('D MMM YYYY'))} · ZEHEN</span></footer>
  </section>`;
}

const CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif; color: #1d1a15; margin: 0; font-size: 12px; }
  .slip { page-break-after: always; }
  .slip:last-child { page-break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1d1a15; padding-bottom: 10px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  header p { margin: 0; color: #6d5f4e; font-size: 11px; }
  .ttl { text-align: right; } .ttl b { display: block; font-size: 16px; letter-spacing: 1px; text-transform: uppercase; } .ttl span { color: #6d5f4e; }
  .ids { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; margin: 14px 0; }
  .ids span, .att span { display: block; color: #6d5f4e; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .ids b { font-size: 12.5px; }
  .att { display: flex; gap: 0; border: 1px solid #d8cfbd; border-radius: 6px; margin-bottom: 14px; }
  .att > div { flex: 1; padding: 8px 10px; border-left: 1px solid #d8cfbd; } .att > div:first-child { border-left: 0; }
  .att b { font-size: 14px; }
  table.lines { width: 100%; border-collapse: collapse; }
  .lines th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6d5f4e; border-bottom: 1px solid #1d1a15; padding: 6px 8px; }
  .lines td { padding: 6px 8px; border-bottom: 1px solid #ece2cd; }
  .lines tfoot td { font-weight: 700; border-top: 1px solid #1d1a15; border-bottom: 0; }
  .lines td:nth-child(3), .lines th:nth-child(3) { border-left: 1px solid #d8cfbd; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .net { margin-top: 14px; padding: 12px 14px; background: #f5efe3; border-radius: 6px; }
  .net div { display: flex; justify-content: space-between; align-items: baseline; } .net span { font-weight: 600; } .net b { font-size: 20px; }
  .net p { margin: 4px 0 0; color: #6d5f4e; font-size: 11px; }
  .er { color: #6d5f4e; font-size: 11px; margin: 8px 0 0; }
  footer { display: flex; justify-content: space-between; margin-top: 28px; color: #9b8f7e; font-size: 10px; border-top: 1px solid #ece2cd; padding-top: 6px; }
`;

export function printPayslips(lines, company, period) {
  const list = (lines || []).filter((l) => l?.slip);
  if (!list.length) return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslips ${esc(period)}</title><style>${CSS}</style></head><body>${list.map((l) => slipHtml(l, company, period)).join('')}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1500);
  }, 250);
}

export { slipHtml, CSS as PAYSLIP_CSS };

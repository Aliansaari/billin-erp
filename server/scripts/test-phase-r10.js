#!/usr/bin/env node
// Phase-R10 v2 self-test: Tally-style Monthly Register
//
// Drives monthlyRegisterController.monthlySummary directly with the
// live seed data. Validates the new Tally-faithful shape:
//   { period, company_name, primary: { rows: [{month, dr, cr, closing,
//     closing_side}], opening_balance, opening_side, totals }, overlay }
//
// Coverage map:
//
//   1.x  Sales register: full FY produces 12 month rows               4 checks
//   2.x  Closing balance is a running cumulative                       3 checks
//   3.x  Sales is Cr-natural (closing_side='Cr' when positive)         2 checks
//   4.x  Purchase register: Dr-natural                                 3 checks
//   5.x  Payment register: voucher-aggregate, Dr-natural               3 checks
//   6.x  Receipt register: voucher-aggregate, Cr-natural               3 checks
//   7.x  Overlay produces parallel section                             3 checks
//   8.x  Period override + opening balance from prior history          2 checks
//   9.x  Edge cases (unknown mode → defaults to sales, empty period)   2 checks
//
// Run: node server/scripts/test-phase-r10.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const ctrl = require('../controllers/monthlySummaryController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function call(query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = {
      status(c) { this._s = c; return this; },
      json(b)   { resolve({ status: this._s || 200, body: b }); },
    };
    ctrl.monthlySummary(req, res).catch(reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

async function t_sales_shape() {
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('1.1 Sales: status 200', r.status === 200);
  check('1.2 Sales: 12 month rows (full FY)', r.body.primary.rows.length === 12);
  check('1.3 Sales: ledger_name = Sales Account', r.body.primary.ledger_name === 'Sales Account');
  check('1.4 Sales: row has month_iso/month_name/dr/cr/closing/closing_side',
    r.body.primary.rows[0].month_iso === '2025-04-01'
    && r.body.primary.rows[0].month_name === 'April'
    && typeof r.body.primary.rows[0].dr === 'number'
    && typeof r.body.primary.rows[0].cr === 'number'
    && typeof r.body.primary.rows[0].closing === 'number'
    && (r.body.primary.rows[0].closing_side === 'Cr' || r.body.primary.rows[0].closing_side === 'Dr'));
}

async function t_running_closing() {
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2026-03-31' });
  const rows = r.body.primary.rows;
  // Closing balance is monotonic (non-decreasing) when there are no
  // returns to the Sales ledger — typical for the seed data.
  let monotonic = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].closing + 0.01 < rows[i-1].closing) { monotonic = false; break; }
  }
  check('2.1 Sales closing balance monotonic (non-decreasing in seed)', monotonic);

  // Each closing = previous + (cr − dr) for Cr-natural ledger.
  const opening = r.body.primary.opening_balance * (r.body.primary.opening_side === 'Cr' ? 1 : -1);
  let running = opening;
  let mathOK = true;
  for (const row of rows) {
    running = r2(running + (row.cr - row.dr));
    const expected = Math.abs(running);
    if (Math.abs(expected - row.closing) > 0.01) { mathOK = false; break; }
  }
  check('2.2 Sales running closing math: prev + cr − dr matches each row', mathOK);

  // Final closing equals opening + sum of (cr − dr) over all rows.
  const totalCr = r2(rows.reduce((s, r) => s + r.cr, 0));
  const totalDr = r2(rows.reduce((s, r) => s + r.dr, 0));
  const finalExpected = r2(opening + totalCr - totalDr);
  check('2.3 Sales final closing = opening + ΣCr − ΣDr',
    Math.abs(rows[rows.length - 1].closing - Math.abs(finalExpected)) < 0.01);
}

async function t_sales_natural_side() {
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('3.1 Sales: natural_side = Cr', r.body.primary.natural_side === 'Cr');
  // With sales > 0, closing_side should be Cr for every populated row.
  const populated = r.body.primary.rows.filter((r) => r.cr > 0 || r.closing > 0);
  const allCr = populated.every((r) => r.closing_side === 'Cr');
  check('3.2 Sales: closing_side = Cr on every populated row', allCr);
}

async function t_purchase() {
  const r = await call({ mode: 'purchase', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('4.1 Purchase: ledger_name = Purchase Account', r.body.primary.ledger_name === 'Purchase Account');
  check('4.2 Purchase: natural_side = Dr', r.body.primary.natural_side === 'Dr');
  // Closing should grow with purchases (Dr-natural).
  const rows = r.body.primary.rows;
  const allDr = rows.filter((r) => r.dr > 0 || r.closing > 0).every((r) => r.closing_side === 'Dr');
  check('4.3 Purchase: closing_side = Dr on populated rows', allDr);
}

async function t_payment() {
  const r = await call({ mode: 'payment', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('5.1 Payment: status 200', r.status === 200);
  check('5.2 Payment: natural_side = Dr (voucher register)', r.body.primary.natural_side === 'Dr');
  // Payments populate Dr column only (voucher-aggregate); cr column = 0.
  const rows = r.body.primary.rows;
  const allDrSide = rows.every((r) => r.cr === 0);
  check('5.3 Payment: cr column always 0 (Dr-side aggregate)', allDrSide);
}

async function t_receipt() {
  const r = await call({ mode: 'receipt', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('6.1 Receipt: status 200', r.status === 200);
  check('6.2 Receipt: natural_side = Cr', r.body.primary.natural_side === 'Cr');
  // Receipts populate Cr column only.
  const allCrSide = r.body.primary.rows.every((r) => r.dr === 0);
  check('6.3 Receipt: dr column always 0 (Cr-side aggregate)', allCrSide);
}

async function t_overlay() {
  const r = await call({ mode: 'sales', overlay: 'purchase', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('7.1 Overlay: primary + overlay both present',
    r.body.primary && r.body.overlay && r.body.overlay.ledger_name === 'Purchase Account');
  check('7.2 Overlay: equal row counts', r.body.primary.rows.length === r.body.overlay.rows.length);
  // Receipt overlay on Payment.
  const r2 = await call({ mode: 'payment', overlay: 'receipt', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('7.3 Overlay: payment ↔ receipt produces both sections',
    r2.body.primary.label === 'Payment Register' && r2.body.overlay.label === 'Receipt Register');
}

async function t_opening_balance() {
  // Period starting mid-FY should produce an opening balance reflecting
  // pre-period activity. Use a from_date beyond which there's seed data.
  const r = await call({ mode: 'sales', from_date: '2025-09-01', to_date: '2025-12-31' });
  // Either opening > 0 (typical — Apr/May/.../Aug had sales) OR rows
  // are empty (no seed sales in the chosen window). Both are valid;
  // the assertion is just that the field is present and numeric.
  check('8.1 Opening balance present and numeric',
    typeof r.body.primary.opening_balance === 'number'
    && (r.body.primary.opening_side === 'Cr' || r.body.primary.opening_side === 'Dr'));
  // Period meta should echo the dates chosen.
  check('8.2 Period meta echoes chosen dates',
    r.body.period.from_date === '2025-09-01' && r.body.period.to_date === '2025-12-31');
}

async function t_with_tax() {
  // Net view: per-bill SUM(sub_total - discount + freight + other) ≈ ledger Cr − Dr
  // With-tax view: per-bill SUM(total_amount) — strictly larger when GST > 0.
  const net = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2026-03-31' });
  const tax = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2026-03-31', with_tax: 'true' });
  const netTotalCr = net.body.primary.totals.cr;
  const taxTotalCr = tax.body.primary.totals.cr;
  check('with_tax.1 Sales: with_tax flag echoed', tax.body.primary.with_tax === true && net.body.primary.with_tax === false);
  check('with_tax.2 Sales: with-tax credit total ≥ net credit total (GST included)',
    taxTotalCr >= netTotalCr - 0.01,
    `tax=${taxTotalCr} net=${netTotalCr}`);

  // Closing balance under with_tax = SUM(total_amount of bills − returns) over period.
  // Verify directly.
  const [{ expected }] = await sequelize.query(
    `SELECT (
       (SELECT COALESCE(SUM(total_amount), 0) FROM sales_bills
         WHERE is_cancelled = false AND bill_date BETWEEN '2025-04-01' AND '2026-03-31')
       - (SELECT COALESCE(SUM(total_amount), 0) FROM sales_return_bills
         WHERE is_cancelled = false AND return_date BETWEEN '2025-04-01' AND '2026-03-31')
     )::float AS expected`,
    { type: sequelize.QueryTypes.SELECT },
  );
  // Final closing = opening + cumulative net. Opening should be 0 if no
  // bills before from_date. We compare final closing to expected sum.
  const finalClosing = tax.body.primary.rows.length > 0
    ? tax.body.primary.rows[tax.body.primary.rows.length - 1].closing
    : 0;
  // Add opening (if any) to compare apples-to-apples — opening_balance
  // is the magnitude; closing has same sign.
  const opening = tax.body.primary.opening_balance || 0;
  check('with_tax.3 Sales: closing matches SUM(total_amount) bills − returns',
    Math.abs((finalClosing - opening) - r2(expected)) < 0.01 || Math.abs(finalClosing - r2(expected) - opening) < 0.01,
    `closing=${finalClosing} expected_in_period=${expected} opening=${opening}`);

  // Payment register: with_tax should be a no-op (already total).
  const payNet = await call({ mode: 'payment', from_date: '2025-04-01', to_date: '2026-03-31' });
  const payTax = await call({ mode: 'payment', from_date: '2025-04-01', to_date: '2026-03-31', with_tax: 'true' });
  check('with_tax.4 Payment: with_tax flag false (voucher already total)',
    payTax.body.primary.with_tax === false);
  check('with_tax.5 Payment: totals identical with/without with_tax',
    Math.abs(payTax.body.primary.totals.dr - payNet.body.primary.totals.dr) < 0.01);
}

async function t_edges() {
  // Unknown mode → controller defaults to sales rather than 500.
  const r = await call({ mode: 'banana', from_date: '2025-04-01', to_date: '2026-03-31' });
  check('9.1 Unknown mode defaults to sales', r.body.primary.label === 'Sales Register');
  // Empty-period (future range, no data) — controller returns empty
  // rows array, no error. month_series still populates the months.
  const r2 = await call({ mode: 'sales', from_date: '2030-08-01', to_date: '2030-09-30' });
  const allEmpty = r2.body.primary.rows.every((r) => r.cr === 0 && r.dr === 0);
  check('9.2 Empty period: rows present but all zero', r2.body.primary.rows.length === 2 && allEmpty);
}

(async () => {
  console.log('──────────────────────────────────────────────');
  console.log('Phase R10 v2 — Tally-style Monthly Register');
  console.log('──────────────────────────────────────────────');
  try {
    await t_sales_shape();
    await t_running_closing();
    await t_sales_natural_side();
    await t_purchase();
    await t_payment();
    await t_receipt();
    await t_overlay();
    await t_opening_balance();
    await t_with_tax();
    await t_edges();
  } catch (err) {
    console.error('Test runner error:', err);
    fail++;
  }
  for (const r of results) console.log(r);
  console.log('──────────────────────────────────────────────');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  console.log('──────────────────────────────────────────────');
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})();

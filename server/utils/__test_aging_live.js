/*
 * Live DB integration test for aging.
 * Loads real bills, runs them through aggregateAging, checks invariants.
 *
 *   node server/utils/__test_aging_live.js
 */
'use strict';

process.env.NODE_ENV = 'test';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Op } = require('sequelize');
const { SalesBill, PurchaseBill, Party, SystemSettings } = require('../models');
const { aggregateAging, round2 } = require('./aging');

function localDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadBills(partyType) {
  const isCustomer = partyType === 'Customer';
  const Bill = isCustomer ? SalesBill : PurchaseBill;
  const billIdKey = isCustomer ? 'sales_bill_id' : 'purchase_bill_id';
  const partyAssoc = isCustomer ? 'customer' : 'supplier';

  const rows = await Bill.findAll({
    where: { is_cancelled: false, balance_amount: { [Op.gt]: 0 } },
    attributes: ['bill_number','bill_date','due_date','total_amount','paid_amount','balance_amount', billIdKey],
    include: [{ model: Party, as: partyAssoc,
      attributes: ['party_id','party_name','mobile_1','city','state','credit_days'] }],
    order: [['bill_date', 'ASC']],
  });

  return rows.map(r => ({
    bill_id: r[billIdKey],
    bill_number: r.bill_number,
    bill_date: r.bill_date,
    due_date: r.due_date || null,
    total_amount: Number(r.total_amount) || 0,
    paid_amount:  Number(r.paid_amount)  || 0,
    balance_amount: Number(r.balance_amount) || 0,
    party: r[partyAssoc] ? {
      party_id: r[partyAssoc].party_id,
      party_name: r[partyAssoc].party_name,
      mobile_1: r[partyAssoc].mobile_1,
      city: r[partyAssoc].city,
      state: r[partyAssoc].state,
      credit_days: r[partyAssoc].credit_days,
    } : null,
  }));
}

async function validate(partyType) {
  console.log(`\n══ ${partyType} ══`);
  const settings = await SystemSettings.findOne();
  const bounds = {
    b1: parseInt(settings?.aging_bucket_1_days ?? 30, 10),
    b2: parseInt(settings?.aging_bucket_2_days ?? 60, 10),
    b3: parseInt(settings?.aging_bucket_3_days ?? 90, 10),
  };
  const asOf = localDateString();

  const bills = await loadBills(partyType);
  console.log(`  loaded ${bills.length} open bills`);
  if (!bills.length) return true;

  const result = aggregateAging(bills, asOf, bounds);
  console.log(`  → ${result.rows.length} parties`);
  console.log(`  grand: ${JSON.stringify(result.grand)}`);

  let allOk = true;

  // Invariant 1: For each party, total = current + b1 + b2 + b3 + b4
  for (const r of result.rows) {
    const sum = round2(r.current + r.b1 + r.b2 + r.b3 + r.b4);
    if (Math.abs(sum - r.total) > 0.01) {
      console.log(`  FAIL — party ${r.party_name}: bucket_sum=${sum} !== total=${r.total}`);
      allOk = false;
    }
  }

  // Invariant 2: For each party, total = sum(bill balances)
  for (const r of result.rows) {
    const billSum = round2(r.bills.reduce((a,b) => a + b.balance_amount, 0));
    if (Math.abs(billSum - r.total) > 0.01) {
      console.log(`  FAIL — party ${r.party_name}: bill_sum=${billSum} !== total=${r.total}`);
      allOk = false;
    }
  }

  // Invariant 3: grand.total = sum of row.total (within rounding tolerance)
  const rowTotalSum = round2(result.rows.reduce((a,r) => a + r.total, 0));
  if (Math.abs(rowTotalSum - result.grand.total) > 0.05) {
    console.log(`  FAIL — grand.total=${result.grand.total} !== sum(rows)=${rowTotalSum}`);
    allOk = false;
  }

  // Invariant 4: grand.{bucket} = sum of row.{bucket}
  for (const k of ['current','b1','b2','b3','b4']) {
    const s = round2(result.rows.reduce((a,r) => a + r[k], 0));
    if (Math.abs(s - result.grand[k]) > 0.05) {
      console.log(`  FAIL — grand.${k}=${result.grand[k]} !== sum(rows.${k})=${s}`);
      allOk = false;
    }
  }

  // Invariant 5: Every bill's overdue_days is non-negative
  for (const r of result.rows) {
    for (const b of r.bills) {
      if (b.overdue_days < 0 || !Number.isInteger(b.overdue_days)) {
        console.log(`  FAIL — bill ${b.bill_number}: invalid overdue_days=${b.overdue_days}`);
        allOk = false;
      }
    }
  }

  // Invariant 6: oldest_days = max of bill overdue_days for that party
  for (const r of result.rows) {
    const actualOldest = r.bills.reduce((m,b) => Math.max(m, b.overdue_days), 0);
    if (actualOldest !== r.oldest_days) {
      console.log(`  FAIL — party ${r.party_name}: oldest_days=${r.oldest_days} !== max(bills)=${actualOldest}`);
      allOk = false;
    }
  }

  // Invariant 7: Each bill lands in the bucket that matches its overdue_days
  const { bucketFor } = require('./aging');
  for (const r of result.rows) {
    for (const b of r.bills) {
      const expected = bucketFor(b.overdue_days, bounds);
      if (expected !== b.bucket) {
        console.log(`  FAIL — bill ${b.bill_number}: overdue=${b.overdue_days} expected bucket ${expected}, got ${b.bucket}`);
        allOk = false;
      }
    }
  }

  // Invariant 8: Rows sorted by total descending
  for (let i = 1; i < result.rows.length; i++) {
    if (result.rows[i].total > result.rows[i-1].total + 1e-6) {
      console.log(`  FAIL — rows not sorted descending at i=${i}`);
      allOk = false;
      break;
    }
  }

  if (allOk) console.log('  ✓ all 8 invariants held');

  // Show top-3 parties
  console.log('  top parties:');
  for (const r of result.rows.slice(0, 3)) {
    console.log(`    ${r.party_name.padEnd(30)} total ₹${r.total.toFixed(2)}  (${r.bill_count} bills, oldest ${r.oldest_days}d)`);
  }

  return allOk;
}

(async () => {
  try {
    const a = await validate('Customer');
    const b = await validate('Supplier');
    console.log(a && b ? '\n✓ ALL CHECKS PASSED' : '\n✗ SOME CHECKS FAILED');
    process.exit(a && b ? 0 : 1);
  } catch (e) {
    console.error('Test failed with error:', e);
    process.exit(2);
  }
})();

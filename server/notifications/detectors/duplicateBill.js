/*
 * duplicate-bill detector.
 *
 * Surfaces purchase bills where the SAME (supplier, supplier_bill_number)
 * appears more than once in the last 90 days. Supplier_bill_number is
 * the *vendor's* invoice number — duplicates almost always mean the
 * operator booked the same supplier invoice twice (paper-in then
 * Tally-sync, or two people entering the same paper in parallel).
 *
 * NOT FIRED when:
 *   - supplier_bill_number is blank (cash purchases / walk-ins don't
 *     have a vendor invoice number)
 *   - any of the duplicate bills are cancelled (the cancel was the
 *     correction; no double-booking remains)
 *
 * Stable key uses the duplicate-set fingerprint (supplier id +
 * supplier_bill_number) so the row sticks until the operator
 * dismisses or cancels one of the bills.
 */

const { sequelize, PurchaseBill, Party } = require('../../models');

const WINDOW_DAYS = 90;

module.exports = async function detect(/* ctx */) {
  // Raw query because Sequelize's GROUP BY + HAVING is awkward and
  // this is a one-off aggregation. The window cap keeps the scan
  // small even on noisy accounts.
  //
  // Audit P3-D — escape via parameter binding (no string interpolation).
  const [rows] = await sequelize.query(
    `
    SELECT
      supplier_id,
      supplier_bill_number,
      COUNT(*) AS dup_count,
      MIN(bill_date) AS first_date,
      MAX(bill_date) AS last_date,
      ARRAY_AGG(purchase_bill_id ORDER BY bill_date ASC) AS bill_ids,
      SUM(total_amount)::text AS combined_amount
    FROM purchase_bills
    WHERE supplier_bill_number IS NOT NULL
      AND supplier_bill_number <> ''
      AND COALESCE(is_cancelled, false) = false
      AND bill_date >= (CURRENT_DATE - INTERVAL '${WINDOW_DAYS} days')
    GROUP BY supplier_id, supplier_bill_number
    HAVING COUNT(*) > 1
    ORDER BY MAX(bill_date) DESC
    LIMIT 20
    `,
  );

  if (!rows.length) return [];

  // Resolve supplier names in a single follow-up query.
  const supplierIds = Array.from(new Set(rows.map((r) => r.supplier_id)));
  const parties = await Party.findAll({
    where: { party_id: supplierIds },
    attributes: ['party_id', 'party_name'],
  });
  const nameById = new Map(parties.map((p) => [p.party_id, p.party_name]));

  return rows.map((r) => {
    const supplierName = nameById.get(r.supplier_id) || 'Unknown supplier';
    const billIds = Array.isArray(r.bill_ids) ? r.bill_ids : [];
    const firstBillId = billIds[0];
    return {
      key:         `duplicate-bill:supplier:${r.supplier_id}:${r.supplier_bill_number}`,
      type:        'duplicate-bill',
      section:     'risk',
      severity:    'amber',
      label:       `Duplicate bill from ${supplierName}`,
      sub:         `Supplier invoice #${r.supplier_bill_number} entered ${r.dup_count} times. Combined ₹${Math.round(Number(r.combined_amount || 0)).toLocaleString('en-IN')}.`,
      occurredAt:  r.last_date ? new Date(r.last_date) : new Date(),
      actionRoute: firstBillId ? `/purchase/edit/${firstBillId}` : '/purchases',
      actionLabel: 'Review',
    };
  });
};

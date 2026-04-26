// ── Ledger admin controller ────────────────────────────────────────────
//
// Read-only diagnostics + chart-of-accounts listing for the JV form and
// the Ledger Integrity admin screen.
//
// Endpoints:
//   GET /api/ledger/accounts   — chart of accounts (system + party ledgers)
//   GET /api/ledger/integrity  — totals tie-out + per-source-type counts
//   GET /api/ledger/unposted   — bills/payments without ledger entries

const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { LedgerAccount, LedgerEntry, Party } = require('../models');

exports.listAccounts = async (req, res) => {
  try {
    const { search } = req.query || {};
    const where = { is_active: true };
    if (search) where.ledger_name = { [Op.iLike]: `%${search}%` };
    const rows = await LedgerAccount.findAll({
      where,
      order: [['is_system_ledger', 'DESC'], ['ledger_group', 'ASC'], ['ledger_name', 'ASC']],
      attributes: ['ledger_id', 'ledger_name', 'ledger_group', 'sub_group', 'is_system_ledger', 'is_party_ledger', 'party_id'],
    });
    res.json({ data: rows });
  } catch (err) {
    console.error('listAccounts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Totals tie-out plus a per-source-type breakdown of vouchers that have
// (or are missing) ledger entries. The "unposted" count for each type is
// the number of source rows lacking a corresponding live entry; the
// expectation post-Phase-2 is zero for everything created from now on
// (older bills predating the wiring will appear here until backfilled).
exports.integrity = async (req, res) => {
  try {
    // Lifetime totals — every row, including reversal mirrors. Useful as
    // an audit-trail volume metric; will keep growing on every edit.
    const lifetime = (await sequelize.query(
      `SELECT
         COUNT(*)::int                         AS rows,
         COALESCE(SUM(debit_amount), 0)::float AS dr,
         COALESCE(SUM(credit_amount), 0)::float AS cr
       FROM ledger_entries`,
      { type: sequelize.QueryTypes.SELECT },
    ))[0];
    // Active totals — exclude both the reversal mirrors AND their original
    // forward entries (the pair sums to zero by construction). What's left
    // is the current state of the books. This is what users normally want
    // to see; this is also what the reports / party-ledger derive from.
    const active = (await sequelize.query(
      `SELECT
         COUNT(*)::int                         AS rows,
         COALESCE(SUM(debit_amount), 0)::float AS dr,
         COALESCE(SUM(credit_amount), 0)::float AS cr
       FROM ledger_entries le
       WHERE le.reversal_of_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ledger_entries m
            WHERE m.reversal_of_id = le.entry_id
         )`,
      { type: sequelize.QueryTypes.SELECT },
    ))[0];

    const sources = [
      { source_type: 'sales_bill',           table: 'sales_bills',           id: 'sales_bill_id',     numCol: 'bill_number' },
      { source_type: 'purchase_bill',        table: 'purchase_bills',        id: 'purchase_bill_id',  numCol: 'bill_number' },
      { source_type: 'sales_return_bill',    table: 'sales_return_bills',    id: 'sales_return_id',   numCol: 'return_number' },
      { source_type: 'purchase_return_bill', table: 'purchase_return_bills', id: 'purchase_return_id',numCol: 'return_number' },
      { source_type: 'payment_receipt',      table: 'payments_receipts',     id: 'transaction_id',    numCol: 'transaction_number' },
      { source_type: 'journal_voucher',      table: 'journal_vouchers',      id: 'id',                numCol: 'voucher_number' },
    ];

    const breakdown = [];
    for (const s of sources) {
      const totalRow = (await sequelize.query(
        `SELECT COUNT(*)::int AS c FROM ${s.table}`,
        { type: sequelize.QueryTypes.SELECT },
      ))[0];
      // posted = source rows that have at least one live forward entry.
      const postedRow = (await sequelize.query(
        `SELECT COUNT(DISTINCT t.${s.id})::int AS c
           FROM ${s.table} t
           JOIN ledger_entries le ON le.source_type = :st AND le.reference_id = t.${s.id}
          WHERE le.reversal_of_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries m
               WHERE m.reversal_of_id = le.entry_id
            )`,
        { replacements: { st: s.source_type }, type: sequelize.QueryTypes.SELECT },
      ))[0];
      breakdown.push({
        source_type: s.source_type,
        total: totalRow.c,
        posted: postedRow.c,
        unposted: totalRow.c - postedRow.c,
      });
    }

    // Opening Balances: party_opening JVs don't have a parent table —
    // they're posted directly into ledger_entries by the Party afterCreate
    // hook. Surface them as their own row in the breakdown so they don't
    // disappear. "Total Records" = distinct entry_numbers (one per party);
    // unposted is always zero by construction.
    const openingRow = (await sequelize.query(
      `SELECT COUNT(DISTINCT entry_number)::int AS c
         FROM ledger_entries
        WHERE source_type = 'party_opening'
          AND reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m
             WHERE m.reversal_of_id = ledger_entries.entry_id
          )`,
      { type: sequelize.QueryTypes.SELECT },
    ))[0];
    breakdown.push({
      source_type: 'party_opening',
      total: openingRow.c,
      posted: openingRow.c,
      unposted: 0,
    });

    // Stock drift — products where current_stock disagrees with the
    // sum across stock_ledger. Healthy systems should always have zero
    // drift; non-zero indicates a write-side bug or a manual edit that
    // bypassed both sides. Cap at 50 rows so the response stays small.
    const driftRows = await sequelize.query(
      `SELECT p.product_id,
              p.product_name,
              p.barcode,
              p.current_stock::float AS current_stock,
              COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::float AS ledger_balance,
              (p.current_stock - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0))::float AS drift
         FROM products p
         LEFT JOIN stock_ledger sl ON sl.product_id = p.product_id
         GROUP BY p.product_id, p.product_name, p.barcode, p.current_stock
        HAVING ABS(p.current_stock - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)) > 0.005
        ORDER BY ABS(p.current_stock - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)) DESC
        LIMIT 50`,
      { type: sequelize.QueryTypes.SELECT },
    );
    const driftCountRow = (await sequelize.query(
      `SELECT COUNT(*)::int AS c
         FROM (
           SELECT p.product_id
             FROM products p
             LEFT JOIN stock_ledger sl ON sl.product_id = p.product_id
            GROUP BY p.product_id, p.current_stock
           HAVING ABS(p.current_stock - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)) > 0.005
         ) sub`,
      { type: sequelize.QueryTypes.SELECT },
    ))[0];

    res.json({
      stock: {
        drifted_count: driftCountRow.c,
        balanced: driftCountRow.c === 0,
        sample: driftRows,
      },
      totals: {
        // Lifetime — full audit trail, including reversal pairs.
        lifetime: {
          rows: lifetime.rows,
          debits: lifetime.dr,
          credits: lifetime.cr,
          difference: Math.round((lifetime.dr - lifetime.cr) * 100) / 100,
          balanced: Math.abs(lifetime.dr - lifetime.cr) < 0.01,
        },
        // Active — current state of the books (reversal pairs excluded).
        active: {
          rows: active.rows,
          debits: active.dr,
          credits: active.cr,
          difference: Math.round((active.dr - active.cr) * 100) / 100,
          balanced: Math.abs(active.dr - active.cr) < 0.01,
        },
        // Back-compat alias — earlier shape exposed `totals.{rows,debits,...}`
        // at the top level. Keep it pointing at lifetime so existing callers
        // (none yet outside the screen, but still) don't break.
        rows: lifetime.rows,
        debits: lifetime.dr,
        credits: lifetime.cr,
        difference: Math.round((lifetime.dr - lifetime.cr) * 100) / 100,
        balanced: Math.abs(lifetime.dr - lifetime.cr) < 0.01,
      },
      breakdown,
    });
  } catch (err) {
    console.error('integrity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.unposted = async (req, res) => {
  try {
    const sources = [
      { source_type: 'sales_bill',           table: 'sales_bills',           id: 'sales_bill_id',     numCol: 'bill_number',        dateCol: 'bill_date' },
      { source_type: 'purchase_bill',        table: 'purchase_bills',        id: 'purchase_bill_id',  numCol: 'bill_number',        dateCol: 'bill_date' },
      { source_type: 'sales_return_bill',    table: 'sales_return_bills',    id: 'sales_return_id',   numCol: 'return_number',      dateCol: 'return_date' },
      { source_type: 'purchase_return_bill', table: 'purchase_return_bills', id: 'purchase_return_id',numCol: 'return_number',      dateCol: 'return_date' },
      { source_type: 'payment_receipt',      table: 'payments_receipts',     id: 'transaction_id',    numCol: 'transaction_number', dateCol: 'transaction_date' },
      { source_type: 'journal_voucher',      table: 'journal_vouchers',      id: 'id',                numCol: 'voucher_number',     dateCol: 'voucher_date' },
    ];
    const out = {};
    for (const s of sources) {
      const rows = await sequelize.query(
        `SELECT t.${s.id}     AS id,
                t.${s.numCol} AS number,
                t.${s.dateCol} AS date
           FROM ${s.table} t
          WHERE NOT EXISTS (
            SELECT 1 FROM ledger_entries le
             WHERE le.source_type = :st AND le.reference_id = t.${s.id}
               AND le.reversal_of_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ledger_entries m
                  WHERE m.reversal_of_id = le.entry_id
               )
          )
          ORDER BY t.${s.dateCol} DESC LIMIT 50`,
        { replacements: { st: s.source_type }, type: sequelize.QueryTypes.SELECT },
      );
      out[s.source_type] = rows;
    }
    res.json({ data: out });
  } catch (err) {
    console.error('unposted error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Migration: legacy "Cash Sales" / "Cash Purchases" stub → system Cash ─
//
// Auto-runs once on server startup (called from server/index.js after
// seedDefaultData). Idempotent: a second run finds no candidate stubs
// and exits silently. Splits cleanly from the synchronous SQL migration
// block in server/index.js because it needs Sequelize models + the
// posting service (reverse / repost) to mutate ledger_entries safely.
//
// Goal: every bill currently FK'd at a legacy cash stub party
// (party_name matches /^cash/i, is_system_cash = false) gets pivoted
// to the seeded system Cash party. The stub's old name is preserved
// on the bill as walk_in_name so the operator's print history doesn't
// lose information ("Cash Sales — Mr Sharma" → walk_in_name = ""
// because the stub name itself is generic; we only set walk_in_name if
// the stub name is more specific than "Cash" / "Cash Sales" / "Cash
// Purchases", which is not the case for current Tally imports).
//
// Steps per stub:
//   1. Reverse every live voucher posted against the stub's bills via
//      ledgerPostingService.reverseVoucher (mirror entries → live count
//      drops to zero, originals stay for audit).
//   2. Update each bill row: customer_id / supplier_id → system Cash
//      party_id; paid_amount = total_amount; balance_amount = 0;
//      payment_status = 'Paid'; payment_method = 'Cash'.
//   3. Re-post via the standard voucher builder. The builder branches
//      on customer.is_system_cash and posts Cash Dr / Sales Cr (or
//      Purchase Dr / Cash Cr) directly — no party-ledger leg.
//   4. Soft-delete the stub party + its old Sundry Debtors/Creditors
//      ledger (is_active = false). Hard-delete is rejected by the
//      ON DELETE RESTRICT FK; even if it weren't, the audit trail
//      (originals + reversal mirrors) must persist.
//
// Active Dr/Cr stays balanced throughout: reversal pairs sum to zero,
// re-posts are themselves balanced, no values created or destroyed.

const sequelize = require('../config/database');
const {
  Party, LedgerAccount, SalesBill, PurchaseBill,
} = require('../models');
const { reverseVoucher, postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers } = require('../services/voucherBuilders');

const CASH_NAME_RE = /^\s*cash(\s+(sales|purchases?))?\s*$/i;

async function migrateStubsToSystemCash() {
  // Find candidate stubs: still active, in the Sundry Debtors/Creditors
  // group (so they have ledger history that must be cleaned up), with
  // a name matching the cash regex AND is_system_cash=false (so we
  // don't pick up the new seeded system party itself).
  const candidates = await sequelize.query(
    `SELECT p.party_id, p.party_name, p.party_type, p.ledger_account_id,
            la.sub_group
       FROM parties p
       JOIN ledger_accounts la ON la.ledger_id = p.ledger_account_id
      WHERE p.is_active = true
        AND la.is_active = true
        AND COALESCE(p.is_system_cash, false) = false
        AND la.sub_group IN ('Sundry Debtors', 'Sundry Creditors')
        AND p.party_name ~* '^\\s*cash(\\s+(sales|purchases?))?\\s*$'`,
    { type: sequelize.QueryTypes.SELECT },
  );

  if (candidates.length === 0) return { migrated: 0, billsRepointed: 0 };

  // Resolve the system Cash party once (seeder must have run first;
  // server/index.js calls us strictly after seedDefaultData).
  const systemCash = await Party.findOne({ where: { is_system_cash: true } });
  if (!systemCash) {
    throw new Error('migrateStubsToSystemCash: system Cash party missing — seeder did not run before this migration?');
  }

  let totalBills = 0;
  for (const c of candidates) {
    const isCustomer = c.party_type === 'Customer' || c.party_type === 'Both';
    // Some legacy stubs were created as 'Both' (early Tally imports).
    // We migrate them under their dominant role: pick the bill table
    // they have history on. For pure Customer / Supplier stubs the
    // role is unambiguous.
    const Bill = isCustomer ? SalesBill : PurchaseBill;
    const idCol = isCustomer ? 'sales_bill_id' : 'purchase_bill_id';
    const fkCol = isCustomer ? 'customer_id' : 'supplier_id';
    const sourceType = isCustomer ? 'sales_bill' : 'purchase_bill';
    const subType    = isCustomer ? 'sales_bill_receipt' : 'purchase_bill_payment';
    const builder    = isCustomer ? buildSalesBillVouchers : buildPurchaseBillVouchers;
    const includeAs  = isCustomer ? 'customer' : 'supplier';

    const bills = await Bill.findAll({ where: { [fkCol]: c.party_id } });
    if (bills.length === 0) {
      // No bills — just soft-delete the orphan stub.
      await sequelize.transaction(async (t) => {
        await sequelize.query(
          `UPDATE parties SET is_active = false WHERE party_id = :id`,
          { replacements: { id: c.party_id }, transaction: t },
        );
        await sequelize.query(
          `UPDATE ledger_accounts SET is_active = false WHERE ledger_id = :id`,
          { replacements: { id: c.ledger_account_id }, transaction: t },
        );
      });
      continue;
    }

    const t = await sequelize.transaction();
    try {
      // 1. Reverse every voucher posted against the stub's bills (both
      //    the primary Sales/Purchase voucher and any at-billing
      //    Receipt/Payment leg from a non-zero paid_amount).
      for (const b of bills) {
        await reverseVoucher({ sourceType,         sourceId: b[idCol], reason: 'stub→system-Cash migration', transaction: t });
        await reverseVoucher({ sourceType: subType, sourceId: b[idCol], reason: 'stub→system-Cash migration', transaction: t });
      }

      // 2. Repoint each bill at the system Cash party + book paid-in-full.
      //    walk_in_name stays NULL — the stub name "Cash Sales" /
      //    "Cash Purchases" is generic chrome, not a real walk-in name.
      for (const b of bills) {
        await b.update({
          [fkCol]: systemCash.party_id,
          paid_amount:    b.total_amount,
          balance_amount: 0,
          payment_status: 'Paid',
          payment_method: 'Cash',
        }, { transaction: t });
      }

      // 3. Re-post via the standard voucher builder. With customer/supplier
      //    set to the system Cash party, the builder's is_system_cash
      //    branch posts Cash Dr / Sales Cr (or Purchase Dr / Cash Cr)
      //    directly — no party-ledger leg, no party_id tag.
      for (const b of bills) {
        const refreshed = await Bill.findByPk(b[idCol], {
          include: [{ model: Party, as: includeAs }],
          transaction: t,
        });
        const vouchers = await builder(refreshed, { transaction: t });
        for (const v of vouchers) {
          await postVoucher({ ...v, transaction: t });
        }
      }

      // 4. Soft-delete stub party + its old party-ledger row. Both stay
      //    in the DB (FK is ON DELETE RESTRICT, audit trail must
      //    persist) but is_active=false hides them from every list,
      //    dropdown, and is_active-filtered report.
      await sequelize.query(
        `UPDATE parties SET is_active = false WHERE party_id = :id`,
        { replacements: { id: c.party_id }, transaction: t },
      );
      await sequelize.query(
        `UPDATE ledger_accounts SET is_active = false WHERE ledger_id = :id`,
        { replacements: { id: c.ledger_account_id }, transaction: t },
      );

      await t.commit();
      totalBills += bills.length;
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      throw err;
    }
  }

  return { migrated: candidates.length, billsRepointed: totalBills };
}

module.exports = { migrateStubsToSystemCash, CASH_NAME_RE };

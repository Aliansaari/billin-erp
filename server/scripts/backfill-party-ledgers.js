#!/usr/bin/env node
// Backfill ledger_account_id on parties that pre-date the auto-link hook.
// Idempotent — re-running skips parties that already have a ledger.
//
// Run with: node server/scripts/backfill-party-ledgers.js
//
// What it does, per party with ledger_account_id IS NULL:
//   1. Picks ledger_group/sub_group from party_type (Supplier → Sundry
//      Creditors, else Sundry Debtors).
//   2. Creates a LedgerAccount row (is_party_ledger=true, party_id set).
//   3. Sets parties.ledger_account_id.
//   4. If opening_balance > 0, posts the opening-balance Journal Voucher
//      via the Posting Service.
//
// All four steps run inside one transaction per party, so a partial
// failure on one party doesn't corrupt the next.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Party, LedgerAccount, SystemSettings } = require('../models');
const { postVoucher } = require('../services/ledgerPostingService');

async function backfillOne(party) {
  const t = await sequelize.transaction();
  try {
    if (party.ledger_account_id) {
      await t.commit();
      return { skipped: true, reason: 'already linked' };
    }

    // System Cash party must link to the Cash-in-Hand ledger, NOT an
    // auto-created Sundry Debtors/Creditors party-ledger. Without this
    // guard the Cash party gets a "Cash (#N)" ledger in the Sundry
    // Debtors sub_group, so every cash sale booked against it pollutes
    // the Sundry Debtors control account and surfaces as a reconciliation
    // drift. Mirrors the is_system_cash branch in the Party afterCreate
    // hook (models/Party.js).
    if (party.is_system_cash) {
      const cashLedger = await LedgerAccount.findOne({
        where: { ledger_name: 'Cash' }, transaction: t,
      });
      if (cashLedger) {
        await Party.update(
          { ledger_account_id: cashLedger.ledger_id },
          { where: { party_id: party.party_id }, transaction: t, hooks: false },
        );
        await t.commit();
        return { skipped: false, systemCash: true };
      }
    }

    const isSupplierOnly = party.party_type === 'Supplier';
    const ledgerGroup = isSupplierOnly ? 'Liabilities' : 'Assets';
    const subGroup    = isSupplierOnly ? 'Sundry Creditors' : 'Sundry Debtors';

    let ledgerName = party.party_name;
    const collision = await LedgerAccount.findOne({
      where: { ledger_name: ledgerName },
      transaction: t,
    });
    if (collision) ledgerName = `${ledgerName} (#${party.party_id})`;

    const ledger = await LedgerAccount.create({
      ledger_name: ledgerName,
      ledger_group: ledgerGroup,
      sub_group: subGroup,
      is_system_ledger: false,
      is_party_ledger: true,
      party_id: party.party_id,
      is_active: true,
    }, { transaction: t });

    await Party.update(
      { ledger_account_id: ledger.ledger_id },
      { where: { party_id: party.party_id }, transaction: t, hooks: false },
    );

    const opening = Number(party.opening_balance) || 0;
    if (opening > 0.005) {
      const obe = await LedgerAccount.findOne({
        where: { ledger_name: 'Opening Balance Equity' },
        transaction: t,
      });
      if (!obe) throw new Error('Opening Balance Equity ledger missing');

      const settings = await SystemSettings.findOne({ where: { setting_id: 1 }, transaction: t });
      let openingDate = new Date();
      if (settings && settings.financial_year_start) {
        const fy = new Date(settings.financial_year_start);
        fy.setDate(fy.getDate() - 1);
        openingDate = fy;
      } else {
        openingDate.setDate(openingDate.getDate() - 1);
      }

      const isReceivable = (party.opening_balance_type || 'Receivable') === 'Receivable';
      const lines = isReceivable
        ? [
            { ledgerAccountId: ledger.ledger_id, debit: opening, credit: 0, partyId: party.party_id },
            { ledgerAccountId: obe.ledger_id,    debit: 0,       credit: opening },
          ]
        : [
            { ledgerAccountId: obe.ledger_id,    debit: opening, credit: 0 },
            { ledgerAccountId: ledger.ledger_id, debit: 0,       credit: opening, partyId: party.party_id },
          ];

      await postVoucher({
        voucherType: 'Journal',
        sourceType: 'party_opening',
        sourceId: party.party_id,
        voucherDate: openingDate,
        referenceNumber: `OB-${party.party_id}`,
        narration: `Opening balance for ${party.party_name}`,
        lines,
        userId: party.created_by || null,
        transaction: t,
      });
    }

    await t.commit();
    return { skipped: false, posted: opening > 0.005 };
  } catch (err) {
    await t.rollback();
    return { error: err.message };
  }
}

async function main() {
  const all = await Party.findAll({
    where: { ledger_account_id: null },
    order: [['party_id', 'ASC']],
  });

  console.log(`Found ${all.length} parties without a ledger link.`);
  let ok = 0, skipped = 0, failed = 0, postedOpening = 0;

  for (const p of all) {
    const r = await backfillOne(p);
    if (r.error) {
      failed++;
      console.error(`  ✗ #${p.party_id} ${p.party_name}: ${r.error}`);
    } else if (r.skipped) {
      skipped++;
    } else {
      ok++;
      if (r.posted) postedOpening++;
    }
  }

  console.log(`Done. linked=${ok}, skipped=${skipped}, failed=${failed}, opening_jvs_posted=${postedOpening}`);
  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Backfill crashed:', err);
  process.exit(1);
});

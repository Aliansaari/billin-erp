// ── Cheque ───────────────────────────────────────────────────────────
//
// One row per physical cheque the business handles, in either direction:
//
//   • INWARD  — received from a customer / debtor. Lives in our drawer
//               until we deposit it; sits in the bank "in clearing"
//               until the bank confirms (or rejects) it.
//
//   • OUTWARD — issued to a supplier / creditor. Hands the supplier a
//               claim against our bank; clears (debits us) when the
//               supplier presents it; can bounce if our balance is short.
//
// The financial impact is recorded by ledgerPostingService. Each event
// in the lifecycle posts (or reverses) its OWN voucher with a distinct
// `source_type`, so the (source_type, cheque_id) idempotency guard in
// postVoucher gives every event its own slot:
//
//   cheque_inward_receipt   — created (Cheques in Hand Dr / Customer Cr)
//   cheque_inward_deposit   — deposited (Bank Dr / Cheques in Hand Cr)
//   cheque_outward_issue    — issued (Supplier Dr / Bank-or-PDC-Cr)
//   cheque_outward_clear    — PDC matured (PDC liability Dr / Bank Cr)
//   cheque_bounce           — optional bank charges on a bounce
//
// Clearance (the bank confirming a deposit / presentation) is a flag,
// not a voucher — same convention as the existing payment_receipts
// cleared_at flow on Bank Reconciliation. Bouncing reverses every
// voucher posted up to that point, so the books snap back to the
// pre-cheque state plus an optional bank charge.
//
// Editing financial details (amount, party, direction) is only allowed
// while the cheque is PENDING — once it's DEPOSITED / CLEARED /
// BOUNCED, only notes and bounce_reason can change.

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const Cheque = sequelize.define('Cheque', {
    cheque_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
  
    // INWARD = received from a customer; OUTWARD = issued to a supplier.
    // The direction picks the party type, the posting legs, and the
    // valid action set (you can deposit an inward, present an outward).
    direction: {
      type: DataTypes.ENUM('INWARD', 'OUTWARD'),
      allowNull: false,
    },
  
    // Cheque number printed on the instrument. Not unique system-wide
    // (different banks reuse the same numbering). Uniqueness is enforced
    // per (bank_ledger_id, cheque_number, direction) by the controller —
    // good enough to catch the obvious "I entered this cheque twice"
    // mistake without rejecting legitimate cross-bank collisions.
    cheque_number: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
  
    // Date written on the cheque face (the "pay on or after" date for
    // post-dated cheques). Distinct from instrument_date below — that's
    // the date the cheque physically changed hands.
    cheque_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  
    // Cheque amount. Always positive — direction tells us in/out.
    amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: { min: 0.01 },
    },
  
    // The customer (INWARD) or supplier (OUTWARD) on the other end.
    // Required: cash-counter cheque exchanges aren't a real workflow,
    // and the receivable/payable adjustment needs a party leg to post
    // against.
    party_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'parties', key: 'party_id' },
    },
  
    // OUR bank ledger (sub_group 'Bank Accounts' or 'Bank OD A/c').
    //   • OUTWARD: which bank we wrote the cheque on.  Required at create.
    //   • INWARD: which bank we deposited / will deposit it into.
    //     Optional at PENDING (the cheque is in our drawer, no bank
    //     involvement yet); becomes required at DEPOSITED.
    bank_ledger_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'ledger_accounts', key: 'ledger_id' },
    },
  
    // Free-text bank name printed on an INWARD cheque (the customer's
    // bank, NOT ours). Useful for the bookkeeper when chasing a cheque
    // — "HDFC ICICI 4422" is a much better identifier than "ICICI 4422".
    drawee_bank_name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
  
    // Lifecycle state.
    //
    //   INWARD:
    //     PENDING   — received, not yet deposited (in our drawer)
    //     DEPOSITED — sent to the bank, awaiting clearance
    //     CLEARED   — bank credited our account (terminal happy path)
    //     BOUNCED   — bank rejected; vouchers reversed (terminal sad)
    //     CANCELLED — voided (any state); vouchers reversed (terminal)
    //
    //   OUTWARD:
    //     PENDING   — issued, awaiting presentation by supplier (or PDC
    //                 awaiting maturity)
    //     CLEARED   — supplier presented + bank debited (terminal happy)
    //     BOUNCED   — our bank rejected; vouchers reversed (terminal sad)
    //     CANCELLED — voided (any state); vouchers reversed (terminal)
    //
    // CLEARED + BOUNCED + CANCELLED are terminal — no further state
    // transitions allowed. The controller enforces this.
    status: {
      type: DataTypes.ENUM('PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
  
    // True when the cheque_date is later than the instrument_date —
    // i.e. the cheque is post-dated. Computed at create time and
    // refreshed when cheque_date is edited. The OUTWARD voucher posts
    // to "Cheques Issued (PDC)" liability instead of Bank when this is
    // true, mirroring how common accounting software tracks post-dated outflows.
    is_pdc: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  
    // Date the instrument physically changed hands. For INWARD this is
    // when we received the cheque; for OUTWARD it's when we handed it
    // over. Defaults to today at create. Defines the voucher_date of
    // the receipt/issue posting.
    instrument_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  
    // INWARD only — when we deposited the cheque at the bank. Drives
    // the deposit voucher's date and lets the operator look up "what's
    // sitting in transit since 5 days ago".
    deposit_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  
    // When the bank confirmed clearance (INWARD) or supplier presentation
    // landed (OUTWARD). Set when transitioning to CLEARED.
    clearance_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  
    // BOUNCED metadata.
    bounce_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    bounce_reason: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    bounce_charges: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
    },
  
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  
    // Audit trail. cleared_by also doubles as bounced_by / cancelled_by
    // for the user who took the terminal action — we keep one column
    // since only one terminal transition can happen per cheque.
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'user_id' },
    },
    cleared_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'user_id' },
    },
  
    // ── Sync columns ────────────────────────────────────────────────
    //
    // When a payment is created via the Make / Receive Payment forms
    // with payment_mode='Cheque', a Cheque row is auto-inserted so the
    // user has one register for every paper instrument the business
    // touches.  The auto-inserted row points back at the source payment
    // via these two columns:
    //
    //   source_payment_id        → payments_receipts.transaction_id
    //   source_payment_split_id  → payment_splits.split_id
    //
    // Crucially, synced rows DO NOT post their own
    // `cheque_inward_receipt` / `cheque_outward_issue` voucher — the
    // payment voucher (Bank Dr / Customer Cr or Supplier Dr / Bank Cr)
    // already moved the money. Posting again would double-count.
    //
    // The UI shows a "from payment PMT-X" badge on synced rows so the
    // user can jump back to the source. Lifecycle actions on synced
    // rows are gated — voiding requires going through the Payments
    // page so the bill allocations and the underlying voucher get
    // reversed together.
    source_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'payments_receipts', key: 'transaction_id' },
    },
    source_payment_split_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'payment_splits', key: 'split_id' },
    },
  }, {
    tableName: 'cheques',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['direction', 'status'] },
      { fields: ['party_id'] },
      { fields: ['bank_ledger_id'] },
      { fields: ['cheque_date'] },
      { fields: ['status'] },
      // The partial UNIQUE on source_payment_split_id is created via the
      // ALTER TABLE migration in server/index.js so it can use a
      // `WHERE source_payment_split_id IS NOT NULL` clause (Sequelize's
      // unique-index spec doesn't accept partial-where). Listing it
      // here as `unique: true` would also make sync try to ensure it,
      // which fails when the column itself is added by the same boot
      // migration block.
    ],
  });
  return Cheque;
};

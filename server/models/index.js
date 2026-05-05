const sequelize = require('../config/database');
const Role = require('./Role');
const User = require('./User');
const Party = require('./Party');
const Category = require('./Category');
const Product = require('./Product');
const PurchaseBill = require('./PurchaseBill');
const PurchaseBillItem = require('./PurchaseBillItem');
const PurchaseBillDraft = require('./PurchaseBillDraft');
const SalesBill = require('./SalesBill');
const SalesBillItem = require('./SalesBillItem');
const SalesBillDraft = require('./SalesBillDraft');
const SalesReturnBill = require('./SalesReturnBill');
const SalesReturnBillItem = require('./SalesReturnBillItem');
const PurchaseReturnBill = require('./PurchaseReturnBill');
const PurchaseReturnBillItem = require('./PurchaseReturnBillItem');
const PaymentReceipt = require('./PaymentReceipt');
const PaymentSplit = require('./PaymentSplit');
const StockLedger = require('./StockLedger');
const LedgerAccount = require('./LedgerAccount');
const LedgerEntry = require('./LedgerEntry');
const JournalVoucher = require('./JournalVoucher');
const ImportJob = require('./ImportJob');
const ImportBatch = require('./ImportBatch');
const TallyLedgerMapping = require('./TallyLedgerMapping');
const BarcodeSettings = require('./BarcodeSettings');
const SystemSettings = require('./SystemSettings');
const PrintProfile = require('./PrintProfile');
const Godown = require('./Godown');
const ProductGodownStock = require('./ProductGodownStock');
const StockTransfer = require('./StockTransfer');
const StockTransferItem = require('./StockTransferItem');
const ProductBatch = require('./ProductBatch');
const ProductBatchStock = require('./ProductBatchStock');
const UserReportFavorite = require('./UserReportFavorite');
const LoanAccount = require('./LoanAccount');
const Cheque = require('./Cheque');

// ── Associations ──

// User <-> Role
Role.hasMany(User, { foreignKey: 'role_id' });
User.belongsTo(Role, { foreignKey: 'role_id' });

// Category self-reference (parent/sub-category)
Category.hasMany(Category, { as: 'subCategories', foreignKey: 'parent_category_id' });
Category.belongsTo(Category, { as: 'parentCategory', foreignKey: 'parent_category_id' });

// Product <-> Category
Category.hasMany(Product, { foreignKey: 'category_id' });
Product.belongsTo(Category, { foreignKey: 'category_id' });

// PurchaseBill <-> Party (Supplier)
Party.hasMany(PurchaseBill, { foreignKey: 'supplier_id' });
PurchaseBill.belongsTo(Party, { foreignKey: 'supplier_id', as: 'supplier' });

// PurchaseBill <-> PurchaseBillItem
PurchaseBill.hasMany(PurchaseBillItem, { foreignKey: 'purchase_bill_id', as: 'items' });
PurchaseBillItem.belongsTo(PurchaseBill, { foreignKey: 'purchase_bill_id' });

// PurchaseBillItem <-> Product
Product.hasMany(PurchaseBillItem, { foreignKey: 'product_id', as: 'purchaseItems' });
PurchaseBillItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

// SalesBill <-> Party (Customer)
Party.hasMany(SalesBill, { foreignKey: 'customer_id' });
SalesBill.belongsTo(Party, { foreignKey: 'customer_id', as: 'customer' });

// SalesBill <-> User (Salesperson)
User.hasMany(SalesBill, { foreignKey: 'sales_person' });
SalesBill.belongsTo(User, { foreignKey: 'sales_person', as: 'salesperson' });

// SalesBill <-> SalesBillItem
SalesBill.hasMany(SalesBillItem, { foreignKey: 'sales_bill_id', as: 'items' });
SalesBillItem.belongsTo(SalesBill, { foreignKey: 'sales_bill_id' });

// SalesBillItem <-> Product
// Use the same `as: 'product'` alias as PurchaseBillItem so controllers can
// include( { model: Product, as: 'product' } ) consistently for both sides.
Product.hasMany(SalesBillItem, { foreignKey: 'product_id', as: 'salesItems' });
SalesBillItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

// ── SalesReturnBill <-> Party (Customer) ──
Party.hasMany(SalesReturnBill, { foreignKey: 'customer_id', as: 'salesReturns' });
SalesReturnBill.belongsTo(Party, { foreignKey: 'customer_id', as: 'customer' });

// SalesReturnBill ↔ SalesReturnBillItem
SalesReturnBill.hasMany(SalesReturnBillItem, { foreignKey: 'sales_return_id', as: 'items' });
SalesReturnBillItem.belongsTo(SalesReturnBill, { foreignKey: 'sales_return_id' });

// SalesReturnBillItem <-> Product
Product.hasMany(SalesReturnBillItem, { foreignKey: 'product_id', as: 'salesReturnItems' });
SalesReturnBillItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

// SalesBillDraft <-> Party (held customer; nullable for walk-ins)
SalesBillDraft.belongsTo(Party, { foreignKey: 'customer_id', as: 'customer' });
// SalesBillDraft <-> User (operator who held the bill — for the list UI)
SalesBillDraft.belongsTo(User,  { foreignKey: 'created_by',  as: 'creator' });
// Note: deliberately NO `Party.hasMany(SalesBillDraft)` — drafts are not
// part of party history and must NOT appear in party-ledger queries.

// PurchaseBillDraft <-> Party (held supplier; nullable when not yet picked)
PurchaseBillDraft.belongsTo(Party, { foreignKey: 'supplier_id', as: 'supplier' });
// PurchaseBillDraft <-> User (operator who held the bill — for the list UI)
PurchaseBillDraft.belongsTo(User,  { foreignKey: 'created_by',  as: 'creator' });
// Same omission as SalesBillDraft: NO `Party.hasMany(PurchaseBillDraft)` —
// drafts must not surface in supplier-ledger queries.

// Reference back to original SalesBill (nullable — amount-only / free-form returns)
SalesBill.hasMany(SalesReturnBill, { foreignKey: 'reference_bill_id', as: 'returns' });
SalesReturnBill.belongsTo(SalesBill, { foreignKey: 'reference_bill_id', as: 'referenceBill' });

// ── PurchaseReturnBill <-> Party (Supplier) ──
Party.hasMany(PurchaseReturnBill, { foreignKey: 'supplier_id', as: 'purchaseReturns' });
PurchaseReturnBill.belongsTo(Party, { foreignKey: 'supplier_id', as: 'supplier' });

// PurchaseReturnBill ↔ PurchaseReturnBillItem
PurchaseReturnBill.hasMany(PurchaseReturnBillItem, { foreignKey: 'purchase_return_id', as: 'items' });
PurchaseReturnBillItem.belongsTo(PurchaseReturnBill, { foreignKey: 'purchase_return_id' });

// PurchaseReturnBillItem <-> Product
Product.hasMany(PurchaseReturnBillItem, { foreignKey: 'product_id', as: 'purchaseReturnItems' });
PurchaseReturnBillItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

// Reference back to original PurchaseBill (nullable — amount-only / free-form returns)
PurchaseBill.hasMany(PurchaseReturnBill, { foreignKey: 'reference_bill_id', as: 'returns' });
PurchaseReturnBill.belongsTo(PurchaseBill, { foreignKey: 'reference_bill_id', as: 'referenceBill' });

// PaymentReceipt <-> Party
Party.hasMany(PaymentReceipt, { foreignKey: 'party_id' });
PaymentReceipt.belongsTo(Party, { foreignKey: 'party_id', as: 'party' });

// PaymentReceipt <-> PaymentSplit
PaymentReceipt.hasMany(PaymentSplit, { foreignKey: 'transaction_id', as: 'splits' });
PaymentSplit.belongsTo(PaymentReceipt, { foreignKey: 'transaction_id' });

// StockLedger <-> Product
Product.hasMany(StockLedger, { foreignKey: 'product_id' });
StockLedger.belongsTo(Product, { foreignKey: 'product_id' });

// LedgerEntry <-> LedgerAccount
// onDelete: RESTRICT — ledger_entries is the books-integrity source of
// truth and must outlive its parents. Sequelize's hasMany default of
// CASCADE silently wiped ₹8,606 of debits when a stub ledger account
// was deleted (Apr 2026 incident). Removing a ledger now requires
// reversing all its postings first, then setting is_active=false —
// never hard-deleting. The DB-level RESTRICT enforces this even when
// admin SQL bypasses the ORM hooks.
LedgerAccount.hasMany(LedgerEntry, { foreignKey: 'ledger_id', onDelete: 'RESTRICT' });
LedgerEntry.belongsTo(LedgerAccount, { foreignKey: 'ledger_id' });

// Party → LedgerAccount (single direction to avoid Sequelize's cyclic-FK
// sync path which surfaces unrelated enum-default issues on print_profiles).
// Reverse lookups (ledger → party) use a direct query on
// LedgerAccount.party_id, no association needed.
Party.belongsTo(LedgerAccount, { foreignKey: 'ledger_account_id', as: 'ledger' });

// LedgerEntry self-link (reversal)
LedgerEntry.belongsTo(LedgerEntry, { foreignKey: 'reversal_of_id', as: 'reversalOf' });
LedgerEntry.hasOne(LedgerEntry, { foreignKey: 'reversal_of_id', as: 'reversedBy' });

// LedgerEntry ↔ Party (per-line tag)
// Same RESTRICT rationale as the ledger_id FK above — never silently
// wipe ledger history by deleting a parent party row.
Party.hasMany(LedgerEntry, { foreignKey: 'party_id', onDelete: 'RESTRICT' });
LedgerEntry.belongsTo(Party, { foreignKey: 'party_id', as: 'party' });

// ── Godown associations ──
//
// Godown is the issuing/receiving location for bills and the partition for
// stock_ledger movements. We deliberately do NOT cascade-delete on FK
// removal: a godown that has ever issued a bill cannot be hard-deleted
// (controller-level guard). Soft-delete via is_active=false is the only
// supported path once a godown has activity.
Godown.hasMany(StockLedger,        { foreignKey: 'godown_id' });
StockLedger.belongsTo(Godown,      { foreignKey: 'godown_id', as: 'godown' });
Godown.hasMany(SalesBill,          { foreignKey: 'godown_id' });
SalesBill.belongsTo(Godown,        { foreignKey: 'godown_id', as: 'godown' });
Godown.hasMany(PurchaseBill,       { foreignKey: 'godown_id' });
PurchaseBill.belongsTo(Godown,     { foreignKey: 'godown_id', as: 'godown' });
Godown.hasMany(SalesReturnBill,    { foreignKey: 'godown_id' });
SalesReturnBill.belongsTo(Godown,  { foreignKey: 'godown_id', as: 'godown' });
Godown.hasMany(PurchaseReturnBill, { foreignKey: 'godown_id' });
PurchaseReturnBill.belongsTo(Godown, { foreignKey: 'godown_id', as: 'godown' });

// Product ↔ Godown m:m through ProductGodownStock — each pair carries
// per-godown current_stock + opening_stock. The `as` aliases let
// reports include() either side cleanly.
Product.belongsToMany(Godown, {
  through: ProductGodownStock,
  foreignKey: 'product_id', otherKey: 'godown_id',
  as: 'godowns',
});
Godown.belongsToMany(Product, {
  through: ProductGodownStock,
  foreignKey: 'godown_id', otherKey: 'product_id',
  as: 'products',
});
Product.hasMany(ProductGodownStock,    { foreignKey: 'product_id', as: 'godownStock' });
ProductGodownStock.belongsTo(Product,  { foreignKey: 'product_id', as: 'product' });
Godown.hasMany(ProductGodownStock,     { foreignKey: 'godown_id',  as: 'productStock' });
ProductGodownStock.belongsTo(Godown,   { foreignKey: 'godown_id',  as: 'godown' });

// Stock transfers — header → items, plus from/to godown aliases used by
// the list view + transfer-register report.
StockTransfer.hasMany(StockTransferItem,   { foreignKey: 'transfer_id', as: 'items', onDelete: 'CASCADE' });
StockTransferItem.belongsTo(StockTransfer, { foreignKey: 'transfer_id' });
StockTransfer.belongsTo(Godown,            { foreignKey: 'from_godown_id', as: 'fromGodown' });
StockTransfer.belongsTo(Godown,            { foreignKey: 'to_godown_id',   as: 'toGodown'   });
StockTransferItem.belongsTo(Product,       { foreignKey: 'product_id',     as: 'product'    });
StockTransfer.belongsTo(User,              { foreignKey: 'created_by',     as: 'creator'    });
StockTransfer.belongsTo(User,              { foreignKey: 'received_by',    as: 'receiver'   });

// User ↔ ReportFavorites — cascade ensures favorite rows go with
// the user if the user is removed.
User.hasMany(UserReportFavorite,   { foreignKey: 'user_id', as: 'reportFavorites', onDelete: 'CASCADE' });
UserReportFavorite.belongsTo(User, { foreignKey: 'user_id' });

// LoanAccount sidecar — 1:1 to LedgerAccount, many:1 to Party (lender
// or borrower). Loans are first-class ledgers (visible in trial
// balance, journal posting, etc.); the sidecar holds the loan-only
// metadata (principal, rate, tenure, EMI dates).
LedgerAccount.hasOne(LoanAccount,   { foreignKey: 'ledger_id', as: 'loan',   onDelete: 'CASCADE' });
LoanAccount.belongsTo(LedgerAccount,{ foreignKey: 'ledger_id', as: 'ledger' });
Party.hasMany(LoanAccount,          { foreignKey: 'party_id',  as: 'loans' });
LoanAccount.belongsTo(Party,        { foreignKey: 'party_id',  as: 'party' });

// Cheque associations.
//
// RESTRICT on the party FK because a cheque is part of the audit
// trail — silently wiping cheque rows when a party is hard-deleted
// would lose the underlying paper-trail for cleared / bounced
// instruments. Same rationale that applies to LedgerEntry.party_id.
//
// SET NULL on the bank FK so deactivating / removing a bank doesn't
// orphan-delete the cheque history; the row keeps its lifecycle data
// even if the bank ledger is gone (the link is informational at that
// point, since the financial impact already lives in ledger_entries).
Party.hasMany(Cheque,         { foreignKey: 'party_id', as: 'cheques', onDelete: 'RESTRICT' });
Cheque.belongsTo(Party,       { foreignKey: 'party_id', as: 'party' });
LedgerAccount.hasMany(Cheque, { foreignKey: 'bank_ledger_id', as: 'cheques', onDelete: 'SET NULL' });
Cheque.belongsTo(LedgerAccount, { foreignKey: 'bank_ledger_id', as: 'bank' });
Cheque.belongsTo(require('./User'), { foreignKey: 'created_by', as: 'creator' });
Cheque.belongsTo(require('./User'), { foreignKey: 'cleared_by', as: 'closer' });

// Sync link to the originating PaymentReceipt — when the user records
// a payment via Make/Receive Payment with mode='Cheque', the Cheque
// register row points back at that payment so the UI can show a
// "from PMT-N" badge and route lifecycle actions appropriately.
PaymentReceipt.hasMany(Cheque,   { foreignKey: 'source_payment_id', as: 'cheques' });
Cheque.belongsTo(PaymentReceipt, { foreignKey: 'source_payment_id', as: 'sourcePayment' });

// ── Batch tracking associations ─────────────────────────────────────
//
// ProductBatch is the lot definition; ProductBatchStock is the per-
// (product, batch, godown) on-hand. We do NOT cascade-delete a batch
// when its product is removed — products with batch movements can't be
// hard-deleted (controller-level guard), and a soft-deleted product
// keeps its batch history for audit/integrity. RESTRICT keeps the FK
// honest if SQL bypass ever attempts a hard delete.
Product.hasMany(ProductBatch,        { foreignKey: 'product_id', as: 'batches', onDelete: 'RESTRICT' });
ProductBatch.belongsTo(Product,      { foreignKey: 'product_id', as: 'product' });

ProductBatch.hasMany(ProductBatchStock,    { foreignKey: 'batch_id', as: 'stock', onDelete: 'RESTRICT' });
ProductBatchStock.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

Product.hasMany(ProductBatchStock,         { foreignKey: 'product_id', as: 'batchStock' });
ProductBatchStock.belongsTo(Product,       { foreignKey: 'product_id', as: 'product' });

Godown.hasMany(ProductBatchStock,          { foreignKey: 'godown_id', as: 'batchStock' });
ProductBatchStock.belongsTo(Godown,        { foreignKey: 'godown_id', as: 'godown' });

// Batch presence on movement / item rows. SET NULL on delete so that if
// a batch is somehow purged, the historical movement row survives with
// batch_id=NULL (degraded but not lost). In practice batches are never
// hard-deleted; the alias keeps the integrity-screen include() readable.
ProductBatch.hasMany(StockLedger,    { foreignKey: 'batch_id' });
StockLedger.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

ProductBatch.hasMany(SalesBillItem,    { foreignKey: 'batch_id' });
SalesBillItem.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

ProductBatch.hasMany(PurchaseBillItem,    { foreignKey: 'batch_id' });
PurchaseBillItem.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

ProductBatch.hasMany(SalesReturnBillItem,    { foreignKey: 'batch_id' });
SalesReturnBillItem.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

ProductBatch.hasMany(PurchaseReturnBillItem,    { foreignKey: 'batch_id' });
PurchaseReturnBillItem.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

ProductBatch.hasMany(StockTransferItem,    { foreignKey: 'batch_id' });
StockTransferItem.belongsTo(ProductBatch,  { foreignKey: 'batch_id', as: 'batch' });

module.exports = {
  sequelize,
  Role,
  User,
  Party,
  Category,
  Product,
  PurchaseBill,
  PurchaseBillItem,
  PurchaseBillDraft,
  SalesBill,
  SalesBillItem,
  SalesBillDraft,
  SalesReturnBill,
  SalesReturnBillItem,
  PurchaseReturnBill,
  PurchaseReturnBillItem,
  PaymentReceipt,
  PaymentSplit,
  StockLedger,
  LedgerAccount,
  LedgerEntry,
  JournalVoucher,
  ImportJob,
  ImportBatch,
  TallyLedgerMapping,
  BarcodeSettings,
  SystemSettings,
  PrintProfile,
  Godown,
  ProductGodownStock,
  StockTransfer,
  StockTransferItem,
  ProductBatch,
  ProductBatchStock,
  UserReportFavorite,
  LoanAccount,
  Cheque,
};

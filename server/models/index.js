/**
 * Models module — multi-tenant.
 *
 * See scripts/rewrite-models-index.js for the design notes. Briefly:
 *
 *   - Each individual model file is a factory: `(sequelize) => sequelize.define(...)`
 *   - This file orchestrates them: a defineModels(sequelize) factory
 *     returns a fully-associated model bag for any sequelize instance.
 *   - Master models are defined once on the global sequelize at module
 *     load (preserving existing behaviour for boot / seed).
 *   - Per-company models are created on demand by the connection pool
 *     (server/services/companyConnections.js).
 *   - Controllers continue to do `const { SalesBill } = require('../models')`
 *     unchanged — the destructured value is a Proxy that forwards every
 *     method call to the active company's real model via AsyncLocalStorage.
 *
 * If no AsyncLocalStorage context is set (boot, seeders, scheduled
 * jobs, integration tests), the proxy falls back to the master models.
 * That keeps every existing code path working without changes.
 */

const masterSequelize = require('../config/database');

const RoleFactory = require('./Role');
const UserFactory = require('./User');
const PartyFactory = require('./Party');
const CategoryFactory = require('./Category');
const ProductFactory = require('./Product');
const PurchaseBillFactory = require('./PurchaseBill');
const PurchaseBillItemFactory = require('./PurchaseBillItem');
const PurchaseBillDraftFactory = require('./PurchaseBillDraft');
const SalesBillFactory = require('./SalesBill');
const SalesBillItemFactory = require('./SalesBillItem');
const SalesBillDraftFactory = require('./SalesBillDraft');
const SalesReturnBillFactory = require('./SalesReturnBill');
const SalesReturnBillItemFactory = require('./SalesReturnBillItem');
const PurchaseReturnBillFactory = require('./PurchaseReturnBill');
const PurchaseReturnBillItemFactory = require('./PurchaseReturnBillItem');
const PaymentReceiptFactory = require('./PaymentReceipt');
const PaymentSplitFactory = require('./PaymentSplit');
const StockLedgerFactory = require('./StockLedger');
const LedgerAccountFactory = require('./LedgerAccount');
const LedgerEntryFactory = require('./LedgerEntry');
const JournalVoucherFactory = require('./JournalVoucher');
const ImportJobFactory = require('./ImportJob');
const ImportBatchFactory = require('./ImportBatch');
const TallyLedgerMappingFactory = require('./TallyLedgerMapping');
const BarcodeSettingsFactory = require('./BarcodeSettings');
const SystemSettingsFactory = require('./SystemSettings');
const PrintProfileFactory = require('./PrintProfile');
const GodownFactory = require('./Godown');
const ProductGodownStockFactory = require('./ProductGodownStock');
const ProductColorFactory = require('./ProductColor');
const StockTransferFactory = require('./StockTransfer');
const StockTransferItemFactory = require('./StockTransferItem');
const ProductBatchFactory = require('./ProductBatch');
const ProductBatchStockFactory = require('./ProductBatchStock');
const UserReportFavoriteFactory = require('./UserReportFavorite');
const LoanAccountFactory = require('./LoanAccount');
const ChequeFactory = require('./Cheque');
const ExpenseVoucherFactory = require('./ExpenseVoucher');
const ExpenseVoucherItemFactory = require('./ExpenseVoucherItem');
const CostLayerFactory = require('./CostLayer');
const SaleLineLayerConsumptionFactory = require('./SaleLineLayerConsumption');
const IndianStateFactory = require('./IndianState');
const NotificationStateFactory = require('./NotificationState');
const NotificationSettingsFactory = require('./NotificationSettings');

/**
 * Define all models + associations on a given Sequelize instance.
 * Returns the model bag + the sequelize itself for symmetry with the
 * old export shape.
 *
 * Idempotent ONLY when called with distinct sequelize instances.
 * Calling twice on the same instance would re-register associations
 * and Sequelize would warn / throw.
 */
function defineModels(sequelize) {
  const Role = RoleFactory(sequelize);
  const User = UserFactory(sequelize);
  const Party = PartyFactory(sequelize);
  const Category = CategoryFactory(sequelize);
  const Product = ProductFactory(sequelize);
  const PurchaseBill = PurchaseBillFactory(sequelize);
  const PurchaseBillItem = PurchaseBillItemFactory(sequelize);
  const PurchaseBillDraft = PurchaseBillDraftFactory(sequelize);
  const SalesBill = SalesBillFactory(sequelize);
  const SalesBillItem = SalesBillItemFactory(sequelize);
  const SalesBillDraft = SalesBillDraftFactory(sequelize);
  const SalesReturnBill = SalesReturnBillFactory(sequelize);
  const SalesReturnBillItem = SalesReturnBillItemFactory(sequelize);
  const PurchaseReturnBill = PurchaseReturnBillFactory(sequelize);
  const PurchaseReturnBillItem = PurchaseReturnBillItemFactory(sequelize);
  const PaymentReceipt = PaymentReceiptFactory(sequelize);
  const PaymentSplit = PaymentSplitFactory(sequelize);
  const StockLedger = StockLedgerFactory(sequelize);
  const LedgerAccount = LedgerAccountFactory(sequelize);
  const LedgerEntry = LedgerEntryFactory(sequelize);
  const JournalVoucher = JournalVoucherFactory(sequelize);
  const ImportJob = ImportJobFactory(sequelize);
  const ImportBatch = ImportBatchFactory(sequelize);
  const TallyLedgerMapping = TallyLedgerMappingFactory(sequelize);
  const BarcodeSettings = BarcodeSettingsFactory(sequelize);
  const SystemSettings = SystemSettingsFactory(sequelize);
  const PrintProfile = PrintProfileFactory(sequelize);
  const Godown = GodownFactory(sequelize);
  const ProductGodownStock = ProductGodownStockFactory(sequelize);
  const ProductColor = ProductColorFactory(sequelize);
  const StockTransfer = StockTransferFactory(sequelize);
  const StockTransferItem = StockTransferItemFactory(sequelize);
  const ProductBatch = ProductBatchFactory(sequelize);
  const ProductBatchStock = ProductBatchStockFactory(sequelize);
  const UserReportFavorite = UserReportFavoriteFactory(sequelize);
  const LoanAccount = LoanAccountFactory(sequelize);
  const Cheque = ChequeFactory(sequelize);
  const ExpenseVoucher = ExpenseVoucherFactory(sequelize);
  const ExpenseVoucherItem = ExpenseVoucherItemFactory(sequelize);
  const CostLayer = CostLayerFactory(sequelize);
  const SaleLineLayerConsumption = SaleLineLayerConsumptionFactory(sequelize);
  const IndianState = IndianStateFactory(sequelize);
  const NotificationState = NotificationStateFactory(sequelize);
  const NotificationSettings = NotificationSettingsFactory(sequelize);

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

  // User ↔ Notifications — both state and settings cascade with the
  // user; deleting a user removes their per-key seen/dismissed state
  // and their preference row. No cross-user reads of either table.
  User.hasMany(NotificationState,       { foreignKey: 'user_id', as: 'notificationStates',   onDelete: 'CASCADE' });
  NotificationState.belongsTo(User,     { foreignKey: 'user_id' });
  User.hasOne(NotificationSettings,     { foreignKey: 'user_id', as: 'notificationSettings', onDelete: 'CASCADE' });
  NotificationSettings.belongsTo(User,  { foreignKey: 'user_id' });
  
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
  Cheque.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
  Cheque.belongsTo(User, { foreignKey: 'cleared_by', as: 'closer' });
  
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
  
  // ── Expense Voucher associations ──────────────────────────────────────
  //
  // Header → items: cascade on delete because the line breakdown is
  // purely descriptive (the financial truth lives in ledger_entries)
  // and cancelling/deleting the header makes lines orphan rows that
  // only confuse reports.
  //
  // Header → vendor party: SET NULL on the FK at DB level so a party
  // hard-delete (vanishingly rare; usually soft-deleted) doesn't cascade
  // through the audit trail. Sequelize-level RESTRICT would have served
  // equally well; we mirror the JV-side `Party.hasMany(LedgerEntry)`
  // RESTRICT semantics by guarding party.delete on the controller.
  //
  // Header → bank ledger: SET NULL on FK; same rationale as Cheque ↔
  // LedgerAccount — a bank ledger going inactive shouldn't orphan-delete
  // expense history.
  ExpenseVoucher.hasMany(ExpenseVoucherItem, {
    foreignKey: 'expense_id', as: 'items', onDelete: 'CASCADE',
  });
  ExpenseVoucherItem.belongsTo(ExpenseVoucher, { foreignKey: 'expense_id' });
  
  ExpenseVoucherItem.belongsTo(LedgerAccount, {
    foreignKey: 'expense_ledger_id', as: 'expenseLedger',
  });
  
  Party.hasMany(ExpenseVoucher, { foreignKey: 'party_id', as: 'expenses' });
  ExpenseVoucher.belongsTo(Party, { foreignKey: 'party_id', as: 'party' });
  
  LedgerAccount.hasMany(ExpenseVoucher, { foreignKey: 'bank_ledger_id', as: 'expensesPaidFromBank' });
  ExpenseVoucher.belongsTo(LedgerAccount, { foreignKey: 'bank_ledger_id', as: 'bank' });
  
  ExpenseVoucher.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
  ExpenseVoucher.belongsTo(User, { foreignKey: 'cancelled_by', as: 'canceller' });
  
  // ── ProductColor associations ────────────────────────────────────
  //
  // Product → its color list. RESTRICT on delete because a color row
  // is referenced by historical bill-item rows (color_id FK); deleting
  // the parent product would leave dangling bill-item references.
  // Products with billing history can't be hard-deleted anyway (existing
  // controller guard); this just enforces the same rule at the DB level
  // for the color table.
  Product.hasMany(ProductColor, { foreignKey: 'product_id', as: 'colors', onDelete: 'RESTRICT' });
  ProductColor.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
  
  // Bill-item rows carry color_id (FK at DB level via the migration
  // block). We declare belongsTo here so include-able color drilldowns
  // work in the controllers (e.g. "include color name on the sales
  // list"). RESTRICT mirrors the LedgerEntry pattern — a color with
  // billing history can't be hard-deleted, only soft-deleted.
  ProductColor.hasMany(SalesBillItem,    { foreignKey: 'color_id', onDelete: 'RESTRICT' });
  SalesBillItem.belongsTo(ProductColor,  { foreignKey: 'color_id', as: 'color' });
  ProductColor.hasMany(PurchaseBillItem, { foreignKey: 'color_id', onDelete: 'RESTRICT' });
  PurchaseBillItem.belongsTo(ProductColor, { foreignKey: 'color_id', as: 'color' });

  return {
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
    ProductColor,
    StockTransfer,
    StockTransferItem,
    ProductBatch,
    ProductBatchStock,
    UserReportFavorite,
    LoanAccount,
    Cheque,
    ExpenseVoucher,
    ExpenseVoucherItem,
    CostLayer,
    SaleLineLayerConsumption,
    IndianState,
    NotificationState,
    NotificationSettings,
  };
}

// Master model bag — defined once at module load on the global
// sequelize. Used as the fallback target when no ALS context is set
// AND as the boot-time target for sequelize.sync() + the seeder.
const masterBag = defineModels(masterSequelize);

// AsyncLocalStorage for per-request company routing. The SAME
// instance is exported by ../services/companyContext (which
// config/database.js also imports for its proxy) — re-importing
// here so models/index.js, config/database.js, the middleware, and
// every controller all read/write the same store. Two AsyncLocalStorage
// instances would silently route differently and produce hard-to-find
// bugs (e.g. middleware sets one, controllers read the other).
const { companyContext } = require('../services/companyContext');

// Build a Proxy over a master model that forwards every property
// access to the ACTIVE per-company model (or master if no ALS ctx).
// Method calls are bound to the active model so `this` resolves
// correctly inside Sequelize internals.
function makeProxy(modelName) {
  const masterModel = masterBag[modelName];
  return new Proxy(masterModel, {
    get(target, prop, receiver) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      const val = m[prop];
      // Bind functions to the active model so 'this' works inside
      // Sequelize's chained calls (e.g. `Model.findOne().then(row => row.update())`).
      if (typeof val === 'function') return val.bind(m);
      return val;
    },
    // Forward instanceof / Symbol.hasInstance / set / has so the proxy
    // is observationally identical to the underlying model. Most callers
    // don't poke these, but the few that do (Sequelize internals around
    // includes) will work without surprises.
    set(target, prop, value, receiver) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      m[prop] = value;
      return true;
    },
    has(target, prop) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      return prop in m;
    },
    getPrototypeOf(target) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      return Object.getPrototypeOf(m);
    },
  });
}

// Sequelize instance proxy — same idea but for the bare sequelize
// object that controllers use for transactions + raw queries.
const sequelizeProxy = new Proxy(masterSequelize, {
  get(target, prop) {
    const ctx = companyContext.getStore();
    const s = (ctx && ctx.sequelize) || target;
    const val = s[prop];
    if (typeof val === 'function') return val.bind(s);
    return val;
  },
});

module.exports = {
  // Backward-compatible exports — these are the Proxies. Controllers
  // that did `const { SalesBill } = require('../models')` continue to
  // work unchanged; the destructured value just routes via ALS.
  sequelize: sequelizeProxy,
  Role: makeProxy('Role'),
  User: makeProxy('User'),
  Party: makeProxy('Party'),
  Category: makeProxy('Category'),
  Product: makeProxy('Product'),
  PurchaseBill: makeProxy('PurchaseBill'),
  PurchaseBillItem: makeProxy('PurchaseBillItem'),
  PurchaseBillDraft: makeProxy('PurchaseBillDraft'),
  SalesBill: makeProxy('SalesBill'),
  SalesBillItem: makeProxy('SalesBillItem'),
  SalesBillDraft: makeProxy('SalesBillDraft'),
  SalesReturnBill: makeProxy('SalesReturnBill'),
  SalesReturnBillItem: makeProxy('SalesReturnBillItem'),
  PurchaseReturnBill: makeProxy('PurchaseReturnBill'),
  PurchaseReturnBillItem: makeProxy('PurchaseReturnBillItem'),
  PaymentReceipt: makeProxy('PaymentReceipt'),
  PaymentSplit: makeProxy('PaymentSplit'),
  StockLedger: makeProxy('StockLedger'),
  LedgerAccount: makeProxy('LedgerAccount'),
  LedgerEntry: makeProxy('LedgerEntry'),
  JournalVoucher: makeProxy('JournalVoucher'),
  ImportJob: makeProxy('ImportJob'),
  ImportBatch: makeProxy('ImportBatch'),
  TallyLedgerMapping: makeProxy('TallyLedgerMapping'),
  BarcodeSettings: makeProxy('BarcodeSettings'),
  SystemSettings: makeProxy('SystemSettings'),
  PrintProfile: makeProxy('PrintProfile'),
  Godown: makeProxy('Godown'),
  ProductGodownStock: makeProxy('ProductGodownStock'),
  ProductColor: makeProxy('ProductColor'),
  StockTransfer: makeProxy('StockTransfer'),
  StockTransferItem: makeProxy('StockTransferItem'),
  ProductBatch: makeProxy('ProductBatch'),
  ProductBatchStock: makeProxy('ProductBatchStock'),
  UserReportFavorite: makeProxy('UserReportFavorite'),
  LoanAccount: makeProxy('LoanAccount'),
  Cheque: makeProxy('Cheque'),
  ExpenseVoucher: makeProxy('ExpenseVoucher'),
  ExpenseVoucherItem: makeProxy('ExpenseVoucherItem'),
  CostLayer: makeProxy('CostLayer'),
  SaleLineLayerConsumption: makeProxy('SaleLineLayerConsumption'),
  IndianState: makeProxy('IndianState'),
  NotificationState: makeProxy('NotificationState'),
  NotificationSettings: makeProxy('NotificationSettings'),

  // Multi-tenant escape hatches — used by the connection pool +
  // middleware. Don't import these from controllers; stick with the
  // proxied models above so the routing stays automatic.
  defineModels,
  companyContext,
  masterSequelize,
  masterModels: masterBag,
};

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
LedgerAccount.hasMany(LedgerEntry, { foreignKey: 'ledger_id' });
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
Party.hasMany(LedgerEntry, { foreignKey: 'party_id' });
LedgerEntry.belongsTo(Party, { foreignKey: 'party_id', as: 'party' });

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
};

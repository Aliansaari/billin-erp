const sequelize = require('../config/database');
const Role = require('./Role');
const User = require('./User');
const Party = require('./Party');
const Category = require('./Category');
const Product = require('./Product');
const PurchaseBill = require('./PurchaseBill');
const PurchaseBillItem = require('./PurchaseBillItem');
const SalesBill = require('./SalesBill');
const SalesBillItem = require('./SalesBillItem');
const PaymentReceipt = require('./PaymentReceipt');
const PaymentSplit = require('./PaymentSplit');
const StockLedger = require('./StockLedger');
const LedgerAccount = require('./LedgerAccount');
const LedgerEntry = require('./LedgerEntry');
const BarcodeSettings = require('./BarcodeSettings');
const SystemSettings = require('./SystemSettings');

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

module.exports = {
  sequelize,
  Role,
  User,
  Party,
  Category,
  Product,
  PurchaseBill,
  PurchaseBillItem,
  SalesBill,
  SalesBillItem,
  PaymentReceipt,
  PaymentSplit,
  StockLedger,
  LedgerAccount,
  LedgerEntry,
  BarcodeSettings,
  SystemSettings,
};

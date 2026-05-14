const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const PurchaseBill = sequelize.define('PurchaseBill', {
    purchase_bill_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    bill_number: {
      type: DataTypes.STRING(30),
      unique: true,
      allowNull: false,
    },
    // Receiving godown — drives stock addition (which warehouse gains
    // inventory) and Place-of-Supply for inward GST. Same nullable-then-NOT-NULL
    // migration story as SalesBill.godown_id.
    godown_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'godowns', key: 'godown_id' },
    },
    supplier_id: {
      type: DataTypes.INTEGER,
      // Was NOT NULL — relaxed so the in-flight stub→Cash migration can
      // pivot rows to the system Cash party without a constraint conflict.
      // The form still hard-requires a supplier (system Cash counts).
      references: { model: 'parties', key: 'party_id' },
    },
    // Walk-in vendor name shown alongside the system "Cash" party on
    // cash purchases. See SalesBill.walk_in_name for the same rationale.
    walk_in_name: {
      type: DataTypes.STRING(120),
    },
    supplier_bill_number: {
      type: DataTypes.STRING(50),
    },
    bill_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    due_date: {
      type: DataTypes.DATEONLY,
    },
    transport_name: {
      type: DataTypes.STRING(100),
    },
    vehicle_number: {
      type: DataTypes.STRING(20),
    },
    lr_number: {
      type: DataTypes.STRING(50),
    },
    total_items: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    total_quantity: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    sub_total: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    discount_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    discount_percentage: {
      // See SalesBill for the DECIMAL(9, 4) rationale.
      type: DataTypes.DECIMAL(9, 4),
      defaultValue: 0,
    },
    cgst_pct: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    sgst_pct: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    igst_pct: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    cgst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    sgst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    igst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    cess_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    round_off: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    other_charges: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    freight_charges: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    paid_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    balance_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    payment_status: {
      type: DataTypes.ENUM('Paid', 'Partial', 'Unpaid'),
      defaultValue: 'Unpaid',
    },
    remarks: {
      type: DataTypes.TEXT,
    },
    // Audit H8 — reverse-charge flag for inward supplies liable to RCM
    // (legal services, GTA, security, etc.) under CGST Sec 9(3)/(4) and
    // IGST Sec 5(3)/(4). When true, the supply is reported in:
    //   • GSTR-3B 3.1(d)  "Inward supplies liable to reverse charge"
    //   • GSTR-3B 4(A)(3) "Inward supplies liable to RCM other than imports"
    // Default false so existing bills behave unchanged. The supplier doesn't
    // collect tax on these — the recipient (us) does, and claims it back as
    // ITC in the same return.
    reverse_charge: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    // 'item' (default — itemised purchase with line items) or 'amount' (a
    // single synthetic line for service / freight / on-account purchases).
    // Amount-mode bills behave identically downstream (party balance, GST
    // routing, payment) but never touch stock — synthetic line is product_id=null.
    bill_mode: {
      type: DataTypes.STRING(10),
      defaultValue: 'item',
    },
    // Free-text description for the synthetic line in amount-mode bills.
    // Becomes the line's product_name in purchase_bill_items; rendered as
    // the item text on print. Distinct from `remarks` (footer note).
    description: {
      type: DataTypes.TEXT,
    },
    created_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
    is_cancelled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    cancelled_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
    cancelled_date: {
      type: DataTypes.DATE,
    },
    cancellation_reason: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'purchase_bills',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { unique: true, fields: ['bill_number'] },
      { fields: ['bill_date'] },
      { fields: ['supplier_id'] },
    ],
  });
  return PurchaseBill;
};

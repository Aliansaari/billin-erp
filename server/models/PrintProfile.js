const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * PrintProfile — named print preset.
 *
 * A single row represents one combination of:
 *   • paper format  (a4 | a5 | thermal)
 *   • document type (sales | purchase | sales_return | purchase_return |
 *                    receipt | payment | report)
 *   • field/layout/font/printer settings
 *
 * One profile per (doc_type, is_default=true) is honored by the client as the
 * auto-print profile for that type. Users can maintain as many non-default
 * profiles as they want and pick one ad-hoc via the Print button dropdown.
 */
const PrintProfile = sequelize.define('PrintProfile', {
  profile_id:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name:         { type: DataTypes.STRING(100), allowNull: false },
  doc_type:     {
    type: DataTypes.ENUM(
      'sales', 'purchase', 'sales_return', 'purchase_return',
      'receipt', 'payment', 'quotation', 'challan', 'report',
    ),
    allowNull: false,
  },
  format:       { type: DataTypes.ENUM('a4', 'a5', 'thermal'), allowNull: false, defaultValue: 'a4' },
  // Visual theme applied on top of the format's structural layout. Does NOT
  // change which fields print — only fonts, borders, spacing, colors.
  theme:        { type: DataTypes.ENUM('classic', 'modern', 'minimal', 'elegant', 'boxed'), defaultValue: 'classic' },
  accent_color: { type: DataTypes.STRING(9), defaultValue: '#111111' },
  // Thermal-only visual style. Applies when format='thermal' and supersedes
  // `theme` for the receipt render. String (not ENUM) so adding a new option
  // later is just a code change — no ALTER TYPE dance in PostgreSQL.
  // Valid: 'simple' | 'standard' | 'compact' | 'bold' | 'spacious' | 'modern'
  thermal_style: { type: DataTypes.STRING(20), defaultValue: 'simple' },
  // Darkness / weight level — thermal paper prints faintly unless text is
  // genuinely bold. 'heavy' renders everything at 800 + stroke; 'light' is
  // the old default. Valid: 'light' | 'normal' | 'bold' | 'heavy'.
  bold_level:   { type: DataTypes.STRING(20), defaultValue: 'bold' },
  is_default:   { type: DataTypes.BOOLEAN, defaultValue: false },

  // Paper + margins (all in mm; thermal uses widthMm and a 0 bottom margin).
  paper_width_mm:  { type: DataTypes.DECIMAL(6,2), defaultValue: 210 },
  paper_height_mm: { type: DataTypes.DECIMAL(6,2), defaultValue: 297 },  // 0 = roll / auto
  margin_top_mm:    { type: DataTypes.DECIMAL(5,2), defaultValue: 10 },
  margin_right_mm:  { type: DataTypes.DECIMAL(5,2), defaultValue: 10 },
  margin_bottom_mm: { type: DataTypes.DECIMAL(5,2), defaultValue: 10 },
  margin_left_mm:   { type: DataTypes.DECIMAL(5,2), defaultValue: 10 },

  // Typography.
  font_family:  { type: DataTypes.STRING(60),  defaultValue: 'Inter, system-ui, sans-serif' },
  font_size_pt: { type: DataTypes.DECIMAL(4,1), defaultValue: 10 },
  line_spacing: { type: DataTypes.DECIMAL(4,2), defaultValue: 1.35 },

  // Header (HTML blob so the user can paste formatted text if they want).
  show_logo:      { type: DataTypes.BOOLEAN, defaultValue: true },
  header_title:   { type: DataTypes.STRING(200), defaultValue: '' },  // overrides company name if set
  header_html:    { type: DataTypes.TEXT, defaultValue: '' },
  header_align:   { type: DataTypes.ENUM('left', 'center', 'right'), defaultValue: 'center' },

  // Columns to render for item rows (bit-field style; each toggle independent).
  show_hsn:            { type: DataTypes.BOOLEAN, defaultValue: true },
  show_batch:          { type: DataTypes.BOOLEAN, defaultValue: false },
  show_mrp:            { type: DataTypes.BOOLEAN, defaultValue: true },
  show_discount:       { type: DataTypes.BOOLEAN, defaultValue: true },
  show_tax_breakdown:  { type: DataTypes.BOOLEAN, defaultValue: true },   // per-line CGST/SGST/IGST columns (A4 items table)
  // Totals-section toggles. Independent of show_tax_breakdown — a user can
  // hide per-line tax columns but still keep the summary GST line at the
  // bottom, or vice-versa. When a toggle is OFF the corresponding row is
  // omitted from A4, A5, thermal-standard, and thermal-simple.
  show_gst:            { type: DataTypes.BOOLEAN, defaultValue: true },
  // Return amount = goods customer returned within THIS bill (credit against the
  // sale). Stored on SalesBill.return_amount. This is NOT change due to the
  // customer when they overpay — that's a different concept and isn't printed.
  show_return_amount:  { type: DataTypes.BOOLEAN, defaultValue: true },
  // Previous balance = party's outstanding dues carried forward from prior
  // bills. When ON we print it above Sub Total so the customer sees their
  // running total. Taken from bill.previous_balance if set by the API,
  // otherwise derived from party.current_balance - balance_amount.
  show_previous_balance: { type: DataTypes.BOOLEAN, defaultValue: false },
  show_barcode:        { type: DataTypes.BOOLEAN, defaultValue: false },
  show_qr_upi:         { type: DataTypes.BOOLEAN, defaultValue: false },
  upi_id:              { type: DataTypes.STRING(120), defaultValue: '' },

  // Tax summary mode.
  tax_summary_mode: { type: DataTypes.ENUM('consolidated', 'lineWise'), defaultValue: 'consolidated' },

  // Footer.
  footer_html:        { type: DataTypes.TEXT, defaultValue: '' },
  show_signature:     { type: DataTypes.BOOLEAN, defaultValue: true },
  signature_label:    { type: DataTypes.STRING(80), defaultValue: 'Authorised Signatory' },
  bank_details:       { type: DataTypes.TEXT, defaultValue: '' },  // bank name / ac / ifsc
  terms_and_conditions: { type: DataTypes.TEXT, defaultValue: '' },

  // Copies.
  copies:       { type: DataTypes.INTEGER, defaultValue: 1 },
  copy_labels:  { type: DataTypes.STRING(200), defaultValue: 'Original' },  // comma-separated
                                                                             // e.g. "Original,Duplicate,Triplicate"

  // Number format.
  currency_symbol: { type: DataTypes.STRING(6), defaultValue: 'Rs ' },
  locale_format:   { type: DataTypes.STRING(10), defaultValue: 'en-IN' },  // affects thousand separators

  // Printer assignment.
  printer_name:   { type: DataTypes.STRING(200), defaultValue: '' },   // from Electron printer enum; '' = last-used
  silent_print:   { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName: 'print_profiles',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { fields: ['doc_type'] },
    { fields: ['is_default'] },
  ],
});

module.exports = PrintProfile;

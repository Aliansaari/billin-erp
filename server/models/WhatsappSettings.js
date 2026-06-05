const { DataTypes } = require('sequelize');

/*
 * WhatsappSettings — per-company WhatsApp delivery configuration (singleton).
 *
 * Exactly one row per company DB (we read/write whatsapp_settings_id = 1). Holds
 * the provider choice, message templates, the ban-resistance pacing knobs, and
 * the official Cloud-API credentials. The live connection (Baileys socket /
 * Cloud-API client) is NOT stored here — that lives in the in-memory manager
 * (server/services/whatsapp/manager.js); this table only persists the durable
 * configuration + the last-known connection snapshot for the Settings UI.
 *
 * Provider values:
 *   'off'      — feature disabled (sends fall back to the legacy deep-link share)
 *   'web'      — Baileys (the owner's own WhatsApp, linked by QR). Free.
 *   'official' — generic Cloud-API (Meta direct OR any BSP endpoint). Paid.
 *
 * Security: official_access_token is sensitive. The controller masks it on GET
 * and never logs it. Stored per-company; treat like a password.
 *
 * NOTE (multi-tenant): factory pattern — see server/models/index.js. Indexes are
 * intentionally NOT declared here (singleton table, no need) to keep sync() from
 * touching existing per-company DBs.
 */
module.exports = (sequelize) => {
  const WhatsappSettings = sequelize.define('WhatsappSettings', {
    whatsapp_settings_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // ── Provider selection ──
    provider: {
      // 'off' | 'web' | 'official'. STRING (not pg ENUM) so adding a future
      // provider needs no CREATE TYPE migration. Validated in the controller.
      type: DataTypes.STRING(12),
      allowNull: false,
      defaultValue: 'off',
    },
    enabled: {
      // Master kill-switch independent of provider — lets the owner pause all
      // sending without losing their linked session / config.
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // ── Message templates (placeholders: {name} {billno} {amount} {shop} {date}) ──
    // *text* renders bold in WhatsApp; \n is a line break. Kept in sync with
    // DEFAULT_TEMPLATES in services/whatsapp/templates.js (used for auto-upgrade).
    msg_template_bill: {
      type: DataTypes.TEXT,
      defaultValue: 'Hello {name},\n\nThank you for shopping with *{shop}*. Your bill *{billno}* for *{amount}* is attached below.\nPrevious balance: {previous}\nTotal outstanding: *{outstanding}*\n\nWe truly value your business!',
    },
    msg_template_ledger: {
      type: DataTypes.TEXT,
      defaultValue: 'Hello {name},\n\nHere is your account statement from *{shop}*. Current balance: *{amount}*.\n\nThank you for your continued trust.',
    },
    msg_template_receipt: {
      type: DataTypes.TEXT,
      defaultValue: 'Hello {name},\n\nWe have received your payment of *{amount}* — thank you! Receipt *{billno}* from *{shop}* is attached.\nRemaining balance: *{balance}*',
    },

    // ── Auto-send default for the post-save print prompt toggle ──
    auto_send_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // ── Ban-resistance pacing (web provider) ──
    min_delay_s: { type: DataTypes.INTEGER, defaultValue: 4 },   // min gap between sends
    max_delay_s: { type: DataTypes.INTEGER, defaultValue: 15 },  // max gap between sends
    daily_cap:   { type: DataTypes.INTEGER, defaultValue: 80 },  // hard ceiling per day
    warmup_start:{ type: DataTypes.INTEGER, defaultValue: 20 },  // day-1 effective cap
    warmup_step: { type: DataTypes.INTEGER, defaultValue: 20 },  // +N per day until daily_cap
    warmup_started_on: { type: DataTypes.DATEONLY },             // ramp anchor date

    // ── Quiet hours (no sends in this window). 'HH:mm', local time. ──
    quiet_start: { type: DataTypes.STRING(5), defaultValue: '21:00' },
    quiet_end:   { type: DataTypes.STRING(5), defaultValue: '08:00' },
    validate_numbers: {
      // Skip+mark numbers that aren't on WhatsApp (avoids bounce flags).
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // ── Self-service BOT (customers message the number to check their account) ──
    bot_enabled:        { type: DataTypes.BOOLEAN, defaultValue: false },
    bot_show_balance:   { type: DataTypes.BOOLEAN, defaultValue: true },
    bot_show_bills:     { type: DataTypes.BOOLEAN, defaultValue: true },
    bot_show_payments:  { type: DataTypes.BOOLEAN, defaultValue: true },
    bot_show_statement: { type: DataTypes.BOOLEAN, defaultValue: true },
    // JSON array of normalized numbers blocked from using the bot.
    bot_blocked:        { type: DataTypes.TEXT, defaultValue: '[]' },
    // JSON array of OWNER numbers — these get the privileged owner panel
    // (today's sales, outstanding, customer lookup) instead of the customer menu.
    bot_owner_numbers:  { type: DataTypes.TEXT, defaultValue: '[]' },
    // Optional extra welcome line shown atop the menu (blank → built-in greeting).
    bot_welcome:        { type: DataTypes.TEXT },

    // ── Owner stock-lookup controls ──
    // Owner messages  A <article> / B <barcode> / S <name>  to pull a stock
    // card. These toggles choose which figures appear (so a shopkeeper can
    // hide cost / MRP from a glance over the shoulder).
    bot_stock_lookup:            { type: DataTypes.BOOLEAN, defaultValue: true }, // master enable for A/B/S
    bot_owner_show_sale_rate:    { type: DataTypes.BOOLEAN, defaultValue: true },
    bot_owner_show_purchase_rate:{ type: DataTypes.BOOLEAN, defaultValue: true },
    bot_owner_show_stock:        { type: DataTypes.BOOLEAN, defaultValue: true },
    bot_owner_show_mrp:          { type: DataTypes.BOOLEAN, defaultValue: true },
    // Let customers fetch a specific bill / receipt PDF by replying with its number.
    bot_doc_request:             { type: DataTypes.BOOLEAN, defaultValue: true },

    // ── Owner panel feature switches (JSON map: feature → bool) ──
    // One JSON column instead of ~14 boolean columns. A MISSING key means the
    // feature is ON (so existing installs light up everything by default; the
    // owner turns OFF what they don't want). Keys: today, yesterday, week,
    // month, receivables, payables, top_customers, top_products, low_stock,
    // cash_bank, expenses, cheques, customer_lookup, supplier_lookup.
    bot_owner_panel:    { type: DataTypes.TEXT, defaultValue: '{}' },
    // ── Supplier self-service (a supplier messages the number) ──
    // JSON map: { enabled, balance, bills, payments, statement }. Missing key
    // = ON when enabled. `enabled` defaults ON so suppliers on file get a menu.
    bot_supplier_panel: { type: DataTypes.TEXT, defaultValue: '{}' },

    // ── Daily owner digest (auto-sent end-of-day summary) ──
    bot_daily_digest:    { type: DataTypes.BOOLEAN, defaultValue: false },   // opt-in
    bot_digest_time:     { type: DataTypes.STRING(5), defaultValue: '21:00' }, // local HH:mm
    bot_digest_last_sent:{ type: DataTypes.DATEONLY },                        // dedupe across restarts

    // ── Official (generic Cloud-API) credentials ──
    official_api_base: {
      // Meta direct default; a BSP would paste its own base URL.
      type: DataTypes.STRING(200),
      defaultValue: 'https://graph.facebook.com/v21.0',
    },
    official_phone_number_id: { type: DataTypes.STRING(60) },
    official_access_token:    { type: DataTypes.TEXT },          // sensitive — masked on GET
    official_template_name:   { type: DataTypes.STRING(120) },
    official_template_lang:   { type: DataTypes.STRING(12), defaultValue: 'en' },

    // ── Last-known connection snapshot (web) for the Settings UI ──
    linked_number:    { type: DataTypes.STRING(30) },
    connection_state: { type: DataTypes.STRING(16), defaultValue: 'disconnected' }, // disconnected | connecting | connected
    connected_at:     { type: DataTypes.DATE },
  }, {
    tableName: 'whatsapp_settings',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return WhatsappSettings;
};

const { DataTypes } = require('sequelize');

/*
 * WhatsappOutbox — the per-company send queue + delivery log.
 *
 * Every "send this PDF on WhatsApp" request lands here as a row first; the
 * background outbox worker (server/services/whatsapp/manager.js) then drains it
 * one-at-a-time with human-like pacing, caps, and quiet-hours — never a burst.
 * This is the heart of the ban-resistance design: the UI can never blast.
 *
 * The PDF bytes ride along as base64 in `payload_base64` so a queued send
 * survives a brief disconnect / restart. After a successful send the worker
 * NULLs `payload_base64` (keeping the row for status/audit without the weight).
 *
 * status flow:
 *   queued → sending → sent → delivered → read     (happy path; acks are async)
 *   queued → skipped                                 (number not on WhatsApp / opted-out)
 *   sending → failed                                 (retries exhausted; error stored)
 *
 * NOTE (multi-tenant): factory pattern — see server/models/index.js. The worker's
 * hot query (status + scheduled_at) is backed by an index created in the
 * schema-migration helpers, not declared here, to avoid sync() index churn on
 * existing per-company DBs.
 */
module.exports = (sequelize) => {
  const WhatsappOutbox = sequelize.define('WhatsappOutbox', {
    outbox_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    provider: { type: DataTypes.STRING(12) },   // 'web' | 'official' (resolved at enqueue)

    // ── Recipient ──
    to_number: { type: DataTypes.STRING(30), allowNull: false }, // normalized digits (E.164 w/o +)
    to_jid:    { type: DataTypes.STRING(40) },                   // <number>@s.whatsapp.net (web)
    party_id:  { type: DataTypes.INTEGER },                      // nullable FK → parties

    // ── What's being sent ──
    doc_type:  { type: DataTypes.STRING(20) },                  // sales | purchase | ledger | receipt | ...
    doc_id:    { type: DataTypes.INTEGER },
    file_name: { type: DataTypes.STRING(160) },
    caption:   { type: DataTypes.TEXT },
    payload_base64: { type: DataTypes.TEXT },                   // PDF bytes; NULLed after success

    // ── Lifecycle ──
    status:   { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'queued' },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    error:    { type: DataTypes.TEXT },
    wa_message_id: { type: DataTypes.STRING(80) },

    scheduled_at: { type: DataTypes.DATE },   // earliest eligible send time (pacing/quiet-hours)
    sent_at:      { type: DataTypes.DATE },
    delivered_at: { type: DataTypes.DATE },
    read_at:      { type: DataTypes.DATE },
  }, {
    tableName: 'whatsapp_outbox',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return WhatsappOutbox;
};

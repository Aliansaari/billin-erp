/**
 * Sales bill draft controller — handles the Hold / Recall / Discard
 * flow for in-progress sales bills.
 *
 * Drafts are stored in `sales_bill_drafts`, a table completely
 * isolated from `sales_bills`. This means:
 *
 *   - No bill_number is consumed at hold time.
 *   - Drafts are invisible to every existing report (GSTR-1, GSTR-3B,
 *     party ledger, party balance, P&L, aging, stock) without changing
 *     a single WHERE clause.
 *   - Stock is never touched.
 *   - Discard = clean DELETE; no foreign-key fan-out.
 *
 * The draft_number is auto-allocated ("DRAFT-001", "DRAFT-002") inside
 * the create transaction with a FOR-UPDATE lock on the last row,
 * mirroring the bill_number race fix in salesController.create.
 */
'use strict';

const { sequelize, SalesBillDraft, Party, User } = require('../models');

// Allocate the next "DRAFT-NNN" inside an active transaction.
// Reads MAX(draft_id) with FOR UPDATE so two concurrent holds can't
// collide. Pads to at least 3 digits but lets longer numbers grow.
async function _allocateDraftNumber(t) {
  const last = await SalesBillDraft.findOne({
    order: [['draft_id', 'DESC']],
    lock:   t.LOCK.UPDATE,
    transaction: t,
  });
  let lastN = 0;
  if (last && last.draft_number) {
    const m = String(last.draft_number).match(/(\d+)$/);
    if (m) lastN = parseInt(m[1], 10) || 0;
  }
  return 'DRAFT-' + String(lastN + 1).padStart(3, '0');
}

exports.list = async (req, res) => {
  try {
    const rows = await SalesBillDraft.findAll({
      include: [
        { model: Party, as: 'customer', attributes: ['party_id', 'party_name', 'mobile_1', 'gstin'] },
        { model: User,  as: 'creator',  attributes: ['user_id', 'username', 'full_name'] },
      ],
      order: [['created_date', 'DESC']],
      limit: 200,
    });
    res.json({ data: rows });
  } catch (err) {
    console.error('Drafts list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const draft = await SalesBillDraft.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'customer', attributes: ['party_id', 'party_name', 'mobile_1', 'gstin', 'state'] },
        { model: User,  as: 'creator',  attributes: ['user_id', 'username', 'full_name'] },
      ],
    });
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (err) {
    console.error('Draft get error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const draftNumber = await _allocateDraftNumber(t);
    // Stamp the payload schema version so future field renames can be
    // forward-migrated by a switch in the recall path.
    const payload = { ...req.body, _schema_version: 1 };
    const draft = await SalesBillDraft.create({
      draft_number: draftNumber,
      customer_id:  payload.customer_id || null,
      // Use the held bill_date if provided, else today
      draft_date:   payload.bill_date || new Date(),
      payload,
      item_count:    Array.isArray(payload.items) ? payload.items.length : 0,
      // Client computes the running total and sends it for the list UI;
      // we don't recompute server-side because the held form may be
      // mid-entry and not yet valid for full GST math.
      total_preview: Number(payload._total_preview) || 0,
      created_by:    req.user?.user_id || null,
    }, { transaction: t });
    await t.commit();
    res.status(201).json(draft);
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error('Draft create error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const draft = await SalesBillDraft.findByPk(req.params.id, { transaction: t });
    if (!draft) {
      await t.rollback();
      return res.status(404).json({ error: 'Draft not found' });
    }
    const payload = { ...req.body, _schema_version: 1 };
    await draft.update({
      customer_id:  payload.customer_id || null,
      draft_date:   payload.bill_date || draft.draft_date,
      payload,
      item_count:    Array.isArray(payload.items) ? payload.items.length : 0,
      total_preview: Number(payload._total_preview) || 0,
    }, { transaction: t });
    await t.commit();
    res.json(draft);
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error('Draft update error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const n = await SalesBillDraft.destroy({ where: { draft_id: req.params.id } });
    if (n === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json({ deleted: n });
  } catch (err) {
    console.error('Draft delete error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

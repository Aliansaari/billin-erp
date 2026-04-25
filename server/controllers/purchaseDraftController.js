/**
 * Purchase bill draft controller — Hold / Recall / Discard for in-progress
 * purchase bills. Mirrors salesDraftController.
 *
 * Drafts live in `purchase_bill_drafts` (separate table from purchase_bills)
 * so they're invisible to GSTR-2 / aging / supplier ledger / stock and don't
 * consume a bill_number until the bill is actually committed.
 */
'use strict';

const { sequelize, PurchaseBillDraft, Party, User } = require('../models');

// Allocate the next "PDRAFT-NNN" inside an active transaction. Reads
// MAX(draft_id) with FOR UPDATE so two concurrent holds can't collide.
async function _allocateDraftNumber(t) {
  const last = await PurchaseBillDraft.findOne({
    order: [['draft_id', 'DESC']],
    lock:   t.LOCK.UPDATE,
    transaction: t,
  });
  let lastN = 0;
  if (last && last.draft_number) {
    const m = String(last.draft_number).match(/(\d+)$/);
    if (m) lastN = parseInt(m[1], 10) || 0;
  }
  return 'PDRAFT-' + String(lastN + 1).padStart(3, '0');
}

exports.list = async (req, res) => {
  try {
    const rows = await PurchaseBillDraft.findAll({
      include: [
        { model: Party, as: 'supplier', attributes: ['party_id', 'party_name', 'mobile_1', 'gstin'] },
        { model: User,  as: 'creator',  attributes: ['user_id', 'username', 'full_name'] },
      ],
      order: [['created_date', 'DESC']],
      limit: 200,
    });
    res.json({ data: rows });
  } catch (err) {
    console.error('Purchase drafts list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const draft = await PurchaseBillDraft.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'supplier', attributes: ['party_id', 'party_name', 'mobile_1', 'gstin', 'state'] },
        { model: User,  as: 'creator',  attributes: ['user_id', 'username', 'full_name'] },
      ],
    });
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (err) {
    console.error('Purchase draft get error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const draftNumber = await _allocateDraftNumber(t);
    const payload = { ...req.body, _schema_version: 1 };
    const draft = await PurchaseBillDraft.create({
      draft_number: draftNumber,
      supplier_id:  payload.supplier_id || null,
      draft_date:   payload.bill_date || new Date(),
      payload,
      item_count:    Array.isArray(payload.items) ? payload.items.length : 0,
      total_preview: Number(payload._total_preview) || 0,
      created_by:    req.user?.user_id || null,
    }, { transaction: t });
    await t.commit();
    res.status(201).json(draft);
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error('Purchase draft create error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const draft = await PurchaseBillDraft.findByPk(req.params.id, { transaction: t });
    if (!draft) {
      await t.rollback();
      return res.status(404).json({ error: 'Draft not found' });
    }
    const payload = { ...req.body, _schema_version: 1 };
    await draft.update({
      supplier_id:  payload.supplier_id || null,
      draft_date:   payload.bill_date || draft.draft_date,
      payload,
      item_count:    Array.isArray(payload.items) ? payload.items.length : 0,
      total_preview: Number(payload._total_preview) || 0,
    }, { transaction: t });
    await t.commit();
    res.json(draft);
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error('Purchase draft update error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const n = await PurchaseBillDraft.destroy({ where: { draft_id: req.params.id } });
    if (n === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json({ deleted: n });
  } catch (err) {
    console.error('Purchase draft delete error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

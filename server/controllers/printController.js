const { PrintProfile, sequelize } = require('../models');

/*
 * Print Profile CRUD.
 *
 * Defaults: exactly one `is_default=true` per (doc_type). The controller
 * enforces this — setting a profile default clears the flag on its siblings
 * in the same transaction.
 */

exports.list = async (req, res) => {
  try {
    const { doc_type } = req.query;
    const where = doc_type ? { doc_type } : {};
    const rows = await PrintProfile.findAll({ where, order: [['doc_type', 'ASC'], ['name', 'ASC']] });
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const row = await PrintProfile.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    res.json({ data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Return the default profile for a given doc_type, or the first profile for
// that type if none is explicitly flagged default, or null if none exist.
exports.getDefault = async (req, res) => {
  try {
    const { doc_type } = req.params;
    let row = await PrintProfile.findOne({ where: { doc_type, is_default: true } });
    if (!row) row = await PrintProfile.findOne({ where: { doc_type }, order: [['profile_id', 'ASC']] });
    res.json({ data: row || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.create = async (req, res) => {
  try {
    const row = await sequelize.transaction(async (t) => {
      const created = await PrintProfile.create(req.body, { transaction: t });
      // Enforce single-default invariant per doc_type.
      if (created.is_default) {
        await PrintProfile.update(
          { is_default: false },
          { where: { doc_type: created.doc_type, profile_id: { [require('sequelize').Op.ne]: created.profile_id } }, transaction: t },
        );
      }
      return created;
    });
    res.status(201).json({ data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const row = await PrintProfile.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    await sequelize.transaction(async (t) => {
      await row.update(req.body, { transaction: t });
      if (row.is_default) {
        await PrintProfile.update(
          { is_default: false },
          { where: { doc_type: row.doc_type, profile_id: { [require('sequelize').Op.ne]: row.profile_id } }, transaction: t },
        );
      }
    });
    res.json({ data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const n = await PrintProfile.destroy({ where: { profile_id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'Profile not found' });
    res.json({ deleted: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Duplicate a profile — useful for "Start from A4 default and tweak".
exports.duplicate = async (req, res) => {
  try {
    const src = await PrintProfile.findByPk(req.params.id);
    if (!src) return res.status(404).json({ error: 'Profile not found' });
    const values = src.toJSON();
    delete values.profile_id;
    delete values.created_date;
    delete values.modified_date;
    values.name = `${values.name} (copy)`;
    values.is_default = false;
    const copy = await PrintProfile.create(values);
    res.status(201).json({ data: copy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

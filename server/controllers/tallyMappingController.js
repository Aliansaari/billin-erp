// ── Tally ledger-mapping controller ────────────────────────────────────
//
// Two endpoints:
//   GET  /api/tally/ledger-mapping?names=foo,bar
//   POST /api/tally/ledger-mapping   { mappings: [{ tally_ledger_name, mapped_ledger_account_id, confidence? }, ...] }

const { suggestMappings, saveMappings } = require('../services/tallyLedgerMapper');
const { TallyLedgerMapping } = require('../models');
const { respondWithError } = require('../utils/helpers');

exports.suggest = async (req, res) => {
  try {
    let names = req.query.names || '';
    if (typeof names === 'string') {
      names = names.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const out = await suggestMappings(names);
    res.json({ data: out });
  } catch (err) {
    console.error('tally mapping suggest error:', err);
    respondWithError(res, err);
  }
};

exports.save = async (req, res) => {
  try {
    const rows = (req.body && req.body.mappings) || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'mappings array required.' });
    }
    const saved = await saveMappings(rows);
    res.json({ data: saved });
  } catch (err) {
    console.error('tally mapping save error:', err);
    respondWithError(res, err);
  }
};

exports.list = async (req, res) => {
  try {
    const rows = await TallyLedgerMapping.findAll({ order: [['tally_ledger_name', 'ASC']] });
    res.json({ data: rows });
  } catch (err) {
    respondWithError(res, err);
  }
};

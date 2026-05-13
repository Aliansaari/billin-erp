/*
 * statesController — read-only access to the Indian states reference
 * table for state-dropdown UIs. No write endpoints — this is a curated
 * list, not a free-form CRUD surface. If/when an operator needs to edit
 * the list, the table is plain SQL away.
 *
 * Returns the rows already sorted by `sort_order, state_name` so the
 * dropdown can render straight from the response without re-sorting.
 */

const { IndianState } = require('../models');

exports.listStates = async (req, res) => {
  try {
    const rows = await IndianState.findAll({
      where: { is_active: true },
      order: [['sort_order', 'ASC'], ['state_name', 'ASC']],
      attributes: ['state_id', 'state_name', 'gst_code', 'is_union_territory'],
    });
    res.json({ data: rows });
  } catch (error) {
    // Defensive: if the table doesn't exist yet (e.g. migration mid-run),
    // return 200 with empty data instead of 500. The frontend has the
    // hardcoded fallback list so a temporary failure here is graceful.
    console.error('[statesController.listStates] error:', error.message);
    res.json({ data: [] });
  }
};

/*
 * Per-user UI preferences — read all / write one / write many / reset.
 *
 * Every endpoint is scoped to req.user.user_id. There is no cross-user
 * read and no cross-user write, not even for an admin: these are the
 * operator's own cosmetic choices, and an admin reaching into them
 * would be surprising rather than useful.
 *
 * The server treats each value as opaque JSON (see models/UserPreference).
 * It enforces three things only, all of them about keeping the table
 * sane rather than about meaning:
 *
 *   - key shape   — /^[A-Za-z0-9_.:-]{1,64}$/
 *   - value size  — MAX_VALUE_BYTES per key
 *   - key count   — MAX_KEYS per user
 *
 * Shape of GET /api/user/preferences:
 *   { values: { theme: {...}, home: {...} },
 *     updated_at: { theme: '2026-09-20T…', home: '…' } }
 *
 * The client keeps a local copy in localStorage for a flicker-free first
 * paint and reconciles against this response once the session is up.
 */

const { UserPreference } = require('../models');

const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// 64 KB per key is far beyond anything the UI stores today (the biggest,
// the dashboard tile layout, is under 2 KB) and still small enough that a
// buggy client cannot bloat the database.
const MAX_VALUE_BYTES = 64 * 1024;
// A generous ceiling on distinct keys. The client registry has ~12.
const MAX_KEYS = 200;

function keyError(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    return 'Invalid preference key';
  }
  return null;
}

function valueError(value) {
  if (value === undefined) return 'Preference value is required';
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    // Circular structures never survive JSON transport, so this only
    // fires on something pathological — refuse rather than store junk.
    return 'Preference value is not serialisable';
  }
  if (size > MAX_VALUE_BYTES) return 'Preference value is too large';
  return null;
}

/** Upsert one (user, key) row. Shared by the single and bulk writers. */
async function writeOne(userId, key, value) {
  const [row, created] = await UserPreference.findOrCreate({
    where: { user_id: userId, pref_key: key },
    defaults: { user_id: userId, pref_key: key, value, updated_at: new Date() },
  });
  if (!created) {
    // Replace wholesale — see the model's note on why this is not a merge.
    row.value = value;
    row.updated_at = new Date();
    await row.save();
  }
  return row;
}

exports.list = async (req, res) => {
  try {
    const rows = await UserPreference.findAll({
      where: { user_id: req.user.user_id },
      attributes: ['pref_key', 'value', 'updated_at'],
    });
    const values = {};
    const updated_at = {};
    for (const r of rows) {
      values[r.pref_key] = r.value;
      updated_at[r.pref_key] = r.updated_at;
    }
    res.json({ values, updated_at });
  } catch (err) {
    console.error('[preferences.list]', err);
    res.status(500).json({ error: err.message });
  }
};

/** PUT /api/user/preferences/:key  body: { value } */
exports.put = async (req, res) => {
  try {
    const { key } = req.params;
    const bad = keyError(key) || valueError(req.body?.value);
    if (bad) return res.status(400).json({ error: bad });

    const count = await UserPreference.count({ where: { user_id: req.user.user_id } });
    if (count >= MAX_KEYS) {
      const exists = await UserPreference.findOne({
        where: { user_id: req.user.user_id, pref_key: key },
        attributes: ['pref_id'],
      });
      // Updating an existing key stays allowed at the ceiling; only a
      // NEW key is refused, so a user can never get stuck unable to
      // change a setting they already have.
      if (!exists) return res.status(400).json({ error: 'Too many preferences stored' });
    }

    const row = await writeOne(req.user.user_id, key, req.body.value);
    res.json({ pref_key: row.pref_key, updated_at: row.updated_at });
  } catch (err) {
    console.error('[preferences.put]', err);
    res.status(500).json({ error: err.message });
  }
};

/** PUT /api/user/preferences  body: { values: { key: value, … } }
 *
 * One round trip for the first-login migration, where the client adopts
 * whatever this device had in localStorage and hands the whole set up at
 * once. Partial success is reported rather than failing the batch: a
 * single malformed key should not cost the operator their other settings.
 */
exports.putMany = async (req, res) => {
  try {
    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return res.status(400).json({ error: 'values object is required' });
    }
    const entries = Object.entries(values);
    if (entries.length > MAX_KEYS) {
      return res.status(400).json({ error: 'Too many preferences in one request' });
    }

    const written = {};
    const rejected = {};
    for (const [key, value] of entries) {
      const bad = keyError(key) || valueError(value);
      if (bad) { rejected[key] = bad; continue; }
      const row = await writeOne(req.user.user_id, key, value);
      written[key] = row.updated_at;
    }
    res.json({ updated_at: written, rejected });
  } catch (err) {
    console.error('[preferences.putMany]', err);
    res.status(500).json({ error: err.message });
  }
};

/** DELETE /api/user/preferences/:key — back to the app default. */
exports.remove = async (req, res) => {
  try {
    const { key } = req.params;
    if (keyError(key)) return res.status(400).json({ error: 'Invalid preference key' });
    await UserPreference.destroy({ where: { user_id: req.user.user_id, pref_key: key } });
    // 204 whether or not a row existed — resetting an already-default
    // setting is a no-op from the operator's point of view.
    res.status(204).end();
  } catch (err) {
    console.error('[preferences.remove]', err);
    res.status(500).json({ error: err.message });
  }
};

/** DELETE /api/user/preferences — "reset everything to defaults". */
exports.clear = async (req, res) => {
  try {
    const n = await UserPreference.destroy({ where: { user_id: req.user.user_id } });
    res.json({ cleared: n });
  } catch (err) {
    console.error('[preferences.clear]', err);
    res.status(500).json({ error: err.message });
  }
};

/*
 * Staff attendance — owner-facing API.
 *
 * Settings, the staff roster (with PINs and "Reset phone"), the register,
 * selfies, and corrections. The phone-facing half lives on the control
 * plane (cloud/src/attendance.js); services/staffAttendance.js connects them.
 *
 * Corrections are append-only: the owner can ADD a punch or VOID one, each
 * with a mandatory reason, and never edit or delete. Staff see both on their
 * own phone, which is what makes the record trustworthy in both directions.
 *
 * Nothing here touches any money figure. Payroll is a later phase.
 */

const crypto = require('crypto');
const sequelize = require('../config/database');
const { companyContext } = require('../services/companyContext');
const att = require('../services/staffAttendance');

const q = (sql, opts = {}) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT, ...opts });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// PINs a staff member (or a colleague) would guess first.
const WEAK_PINS = new Set(['0000', '1111', '1234', '4321', '2222', '9999', '12345', '123456', '000000', '111111']);

function currentCompanyId() {
  return companyContext.getStore()?.companyId || null;
}

/** Push changes to the control plane soon, without making the request wait. */
function kick() {
  const companyId = currentCompanyId();
  if (!companyId) return;
  setTimeout(() => {
    att.syncNow(companyId).catch((e) => console.error('[attendance] background sync:', e.message));
  }, 300).unref?.();
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// ── settings ────────────────────────────────────────────────────────

function cleanConfig(input) {
  const c = att.mergeConfig(input);
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const time = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : fallback);
  const num = (v) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const lat = num(c.geo.lat); const lng = num(c.geo.lng);
  return {
    wifi_mode: pick(c.wifi_mode, ['off', 'flag', 'require'], 'require'),
    passkey: pick(c.passkey, ['optional', 'required'], 'required'),
    selfie: pick(c.selfie, ['off', 'in', 'both'], 'in'),
    geo: {
      enabled: !!c.geo.enabled && lat !== null && lng !== null,
      lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
      lng: lng !== null && Math.abs(lng) <= 180 ? lng : null,
      radius_m: Math.min(2000, Math.max(30, Math.round(num(c.geo.radius_m) || 150))),
    },
    open_time: time(c.open_time, '10:00'),
    close_time: time(c.close_time, '21:00'),
    grace_min: Math.min(180, Math.max(0, Math.round(num(c.grace_min) ?? 15))),
    weekly_off: [...new Set((Array.isArray(c.weekly_off) ? c.weekly_off : []).map(Number).filter((d) => d >= 0 && d <= 6))],
    tz_offset_min: Math.min(840, Math.max(-720, Math.round(num(c.tz_offset_min) ?? 330))),
  };
}

exports.getSettings = async (req, res) => {
  try {
    const s = await att.getSettingsRow();
    res.json({
      enabled: s.enabled,
      config: s.config,
      shop_code: s.shop_code,
      network: s.network,
      last_sync_at: s.last_sync_at,
      last_sync_error: s.last_sync_error,
      staff_url: s.shop_code ? `${att.STAFF_PAGE_URL}?s=${s.shop_code}` : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const config = cleanConfig(req.body?.config || {});
    if (req.body?.config?.geo?.enabled && !config.geo.enabled) {
      return bad(res, 'Enter the shop location (latitude and longitude) to turn on the location check.');
    }
    await att.saveSettings({ enabled: !!req.body?.enabled, config });
    kick();
    return exports.getSettings(req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.syncNow = async (req, res) => {
  try {
    const result = await att.syncNow(currentCompanyId());
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

// ── staff ───────────────────────────────────────────────────────────

const STAFF_COLUMNS = `
  s.staff_id, s.name, s.phone, s.salesman_id, s.attendance_enabled, s.is_active, s.joined_on,
  s.notes, s.pin_set_at, s.cloud_status, s.created_date, (s.pin_hash IS NOT NULL) AS has_pin,
  sm.name AS salesman_name`;

exports.listStaff = async (req, res) => {
  try {
    const rows = await q(
      `SELECT ${STAFF_COLUMNS}
         FROM staff_members s LEFT JOIN salesmen sm ON sm.salesman_id = s.salesman_id
        ORDER BY s.is_active DESC, s.name`,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

async function validateStaff(body, staffId = null) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Name is required.' };
  if (name.length > 100) return { error: 'Name is too long (100 characters max).' };

  const phone = normalizePhone(body.phone);
  if (!phone || phone.length < 10 || phone.length > 13) {
    return { error: 'Enter the staff member\'s mobile number. They sign in with it.' };
  }
  const clash = await q(
    `SELECT staff_id, name, phone FROM staff_members
      WHERE is_active AND staff_id <> :id`,
    { replacements: { id: staffId || 0 } },
  );
  const dup = clash.find((r) => normalizePhone(r.phone) === phone);
  if (dup) return { error: `${dup.name} already uses this mobile number.` };

  let salesmanId = body.salesman_id ? Number(body.salesman_id) : null;
  if (salesmanId) {
    const sm = await q('SELECT salesman_id FROM salesmen WHERE salesman_id = :id', { replacements: { id: salesmanId } });
    if (!sm.length) salesmanId = null;
  }
  const joined = /^\d{4}-\d{2}-\d{2}$/.test(String(body.joined_on || '')) ? body.joined_on : null;

  return {
    value: {
      name,
      phone,
      salesman_id: salesmanId,
      attendance_enabled: body.attendance_enabled === undefined ? true : !!body.attendance_enabled,
      is_active: body.is_active === undefined ? true : !!body.is_active,
      joined_on: joined,
      notes: body.notes ? String(body.notes).slice(0, 500) : null,
    },
  };
}

exports.createStaff = async (req, res) => {
  try {
    const v = await validateStaff(req.body || {});
    if (v.error) return bad(res, v.error);
    const [row] = await q(
      `INSERT INTO staff_members (name, phone, salesman_id, attendance_enabled, is_active, joined_on, notes)
       VALUES (:name, :phone, :salesman_id, :attendance_enabled, :is_active, :joined_on, :notes)
       RETURNING staff_id`,
      { replacements: v.value, type: sequelize.QueryTypes.SELECT },
    );
    kick();
    res.status(201).json({ staff_id: row.staff_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [current] = await q('SELECT * FROM staff_members WHERE staff_id = :id', { replacements: { id } });
    if (!current) return bad(res, 'Staff member not found.', 404);
    const v = await validateStaff({ ...current, ...req.body }, id);
    if (v.error) return bad(res, v.error);
    await sequelize.query(
      `UPDATE staff_members SET name = :name, phone = :phone, salesman_id = :salesman_id,
              attendance_enabled = :attendance_enabled, is_active = :is_active, joined_on = :joined_on,
              notes = :notes, modified_date = NOW()
        WHERE staff_id = :id`,
      { replacements: { ...v.value, id } },
    );
    kick();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.setPin = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pin = String(req.body?.pin || '');
    if (!/^\d{4,8}$/.test(pin)) return bad(res, 'The PIN must be 4 to 8 digits.');
    if (WEAK_PINS.has(pin) || /^(\d)\1+$/.test(pin)) return bad(res, 'That PIN is too easy to guess. Pick another.');
    const [row] = await q('SELECT staff_id FROM staff_members WHERE staff_id = :id', { replacements: { id } });
    if (!row) return bad(res, 'Staff member not found.', 404);
    await sequelize.query(
      'UPDATE staff_members SET pin_hash = :h, pin_set_at = NOW(), modified_date = NOW() WHERE staff_id = :id',
      { replacements: { h: att.hashPin(pin), id } },
    );
    kick();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/**
 * "Reset phone": the staff member's next sign-in may come from a new phone.
 * The old phone's session and fingerprint key stop working on the next sync.
 */
exports.resetDevice = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await sequelize.query(
      `UPDATE staff_members SET device_reset_seq = device_reset_seq + 1, cloud_status = NULL, modified_date = NOW()
        WHERE staff_id = :id`,
      { replacements: { id } },
    );
    kick();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/** Create a staff record for every active salesman who does not have one. */
exports.importSalesmen = async (req, res) => {
  try {
    const rows = await q(
      `SELECT sm.salesman_id, sm.name, sm.phone FROM salesmen sm
        WHERE sm.is_active
          AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE s.salesman_id = sm.salesman_id)`,
    );
    let added = 0;
    const skipped = [];
    for (const r of rows) {
      const phone = normalizePhone(r.phone);
      const clash = await q('SELECT phone FROM staff_members WHERE is_active');
      if (phone && clash.some((c) => normalizePhone(c.phone) === phone)) { skipped.push(r.name); continue; }
      await sequelize.query(
        `INSERT INTO staff_members (name, phone, salesman_id) VALUES (:name, :phone, :sid)`,
        { replacements: { name: r.name, phone: phone || null, sid: r.salesman_id } },
      );
      added++;
    }
    if (added) kick();
    res.json({ added, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── register ────────────────────────────────────────────────────────

exports.getRegister = async (req, res) => {
  try {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from || '');
    const to = String(req.query.to || from);
    if (!iso.test(from) || !iso.test(to) || to < from) return bad(res, 'Pick a valid date range.');
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span > 62) return bad(res, 'Pick at most two months at a time.');
    const register = await att.buildRegister(from, to, { includeInactive: req.query.include_inactive === 'true' });
    res.json(register);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getSelfie = async (req, res) => {
  try {
    const rows = await q('SELECT selfie FROM staff_punches WHERE punch_id = :id', { replacements: { id: String(req.params.id) } });
    if (!rows[0]?.selfie) return res.status(404).end();
    res.set('content-type', 'image/jpeg');
    res.set('cache-control', 'private, max-age=86400');
    res.send(rows[0].selfie);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/** Owner adds a punch the phone could not record (forgot, phone dead…). */
exports.addPunch = async (req, res) => {
  try {
    const { staff_id: staffId, kind, date, time } = req.body || {};
    const reason = String(req.body?.reason || '').trim();
    if (!['in', 'out'].includes(kind)) return bad(res, 'Choose IN or OUT.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
      return bad(res, 'Enter the date and time.');
    }
    if (reason.length < 3) return bad(res, 'Write the reason. The staff member will see it.');
    const [staff] = await q('SELECT staff_id FROM staff_members WHERE staff_id = :id', { replacements: { id: Number(staffId) } });
    if (!staff) return bad(res, 'Staff member not found.', 404);

    const { config } = await att.getSettingsRow();
    const [y, m, d] = String(date).split('-').map(Number);
    const [hh, mm] = String(time).split(':').map(Number);
    const at = Date.UTC(y, m - 1, d, hh, mm) - (Number(config.tz_offset_min) || 0) * 60_000;
    if (at > Date.now() + 60_000) return bad(res, 'That time is in the future.');

    const id = `man_${crypto.randomBytes(8).toString('hex')}`;
    await sequelize.query(
      `INSERT INTO staff_punches (punch_id, staff_id, kind, punched_at, source, reason, created_by)
       VALUES (:id, :sid, :kind, :at, 'manual', :reason, :uid)`,
      { replacements: { id, sid: staff.staff_id, kind, at: new Date(at), reason: reason.slice(0, 300), uid: req.user?.user_id || null } },
    );
    kick();
    res.status(201).json({ punch_id: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.voidPunch = async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return bad(res, 'Write the reason. The staff member will see it.');
    const [result] = await sequelize.query(
      `UPDATE staff_punches SET voided_at = NOW(), void_reason = :reason, voided_by = :uid
        WHERE punch_id = :id AND voided_at IS NULL
        RETURNING punch_id`,
      { replacements: { id: String(req.params.id), reason: reason.slice(0, 300), uid: req.user?.user_id || null } },
    );
    if (!result.length) return bad(res, 'That punch was not found or is already removed.', 404);
    kick();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

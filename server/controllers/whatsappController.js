/**
 * WhatsApp controller.
 * ────────────────────
 * Thin HTTP layer over the manager (server/services/whatsapp/manager.js). The
 * request already runs inside the company's AsyncLocalStorage context (set by
 * the auth middleware), so the proxied models route to the right company DB and
 * we just pass companyId through to the manager for its own background context.
 *
 * Security: official_access_token is sensitive. getSettings NEVER returns it —
 * it returns a boolean `official_token_set` instead — and saveSettings only
 * overwrites it when a non-empty value is supplied (so re-saving the form
 * without re-typing the token keeps the stored one).
 */
const manager = require('../services/whatsapp/manager');
const { upgradePatch } = require('../services/whatsapp/templates');
const { companyContext, WhatsappSettings, WhatsappOutbox } = require('../models');

function cid(req) {
  const ctx = companyContext.getStore();
  return (ctx && ctx.companyId) || (req.user && req.user.company_id) || 1;
}

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

async function getSettingsRow() {
  const [row] = await WhatsappSettings.findOrCreate({
    where: { whatsapp_settings_id: 1 },
    defaults: { whatsapp_settings_id: 1 },
  });
  // Refresh untouched old-default wording to the current polished default.
  const patch = upgradePatch(row);
  if (Object.keys(patch).length) { try { await row.update(patch); } catch { /* non-fatal */ } }
  return row;
}

// GET /api/whatsapp/status — used by the send surfaces to decide whether to
// auto-send vs. fall back to the deep-link. Allowed to any authenticated user.
exports.getStatus = async (req, res) => {
  try { res.json(await manager.getStatus(cid(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// POST /api/whatsapp/connect — start a WEB (Baileys) link. Returns status with
// the QR string once Baileys emits it (the page polls /status to pick it up).
exports.connect = async (req, res) => {
  try { res.json(await manager.connectWeb(cid(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// POST /api/whatsapp/logout — unlink the web session + wipe local creds.
exports.logout = async (req, res) => {
  try { res.json(await manager.logoutWeb(cid(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// GET /api/whatsapp/settings — full config MINUS the access token.
exports.getSettings = async (req, res) => {
  try {
    const row = await getSettingsRow();
    const j = row.toJSON();
    j.official_token_set = !!j.official_access_token;
    delete j.official_access_token;
    res.json(j);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

// PUT /api/whatsapp/settings — whitelist + validate + clamp.
exports.saveSettings = async (req, res) => {
  try {
    const b = req.body || {};
    const row = await getSettingsRow();
    const patch = {};

    if (b.provider !== undefined) {
      if (!['off', 'web', 'official'].includes(b.provider)) {
        return res.status(400).json({ error: 'Invalid provider' });
      }
      patch.provider = b.provider;
    }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.auto_send_default !== undefined) patch.auto_send_default = !!b.auto_send_default;
    if (b.validate_numbers !== undefined) patch.validate_numbers = !!b.validate_numbers;

    // ── Self-service bot ──
    if (b.bot_enabled !== undefined) patch.bot_enabled = !!b.bot_enabled;
    if (b.bot_show_balance !== undefined) patch.bot_show_balance = !!b.bot_show_balance;
    if (b.bot_show_bills !== undefined) patch.bot_show_bills = !!b.bot_show_bills;
    if (b.bot_show_payments !== undefined) patch.bot_show_payments = !!b.bot_show_payments;
    if (b.bot_show_statement !== undefined) patch.bot_show_statement = !!b.bot_show_statement;
    if (b.bot_welcome !== undefined) patch.bot_welcome = String(b.bot_welcome).slice(0, 500);
    // Customer doc-request + owner stock-lookup controls.
    for (const k of ['bot_doc_request', 'bot_stock_lookup', 'bot_owner_show_sale_rate',
      'bot_owner_show_purchase_rate', 'bot_owner_show_stock', 'bot_owner_show_mrp']) {
      if (b[k] !== undefined) patch[k] = !!b[k];
    }
    // Owner-panel + supplier-panel feature maps (JSON of feature→bool). Coerce
    // values to booleans and keep only known keys so the column stays clean.
    const normMap = (val, keys) => {
      let o = val; if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
      if (!o || typeof o !== 'object') o = {};
      const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = !!o[k];
      return JSON.stringify(out);
    };
    if (b.bot_owner_panel !== undefined) {
      patch.bot_owner_panel = normMap(b.bot_owner_panel, ['today', 'yesterday', 'week', 'month',
        'receivables', 'payables', 'top_customers', 'top_products', 'low_stock', 'cash_bank',
        'expenses', 'cheques', 'customer_lookup', 'supplier_lookup']);
    }
    if (b.bot_supplier_panel !== undefined) {
      patch.bot_supplier_panel = normMap(b.bot_supplier_panel, ['enabled', 'balance', 'bills', 'payments', 'statement']);
    }
    // Daily digest: enable + send-time (HH:mm, 24h). Invalid time → keep 21:00.
    if (b.bot_daily_digest !== undefined) patch.bot_daily_digest = !!b.bot_daily_digest;
    if (b.bot_digest_time !== undefined) {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(b.bot_digest_time).trim());
      patch.bot_digest_time = m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : '21:00';
    }
    const normNumList = (arr) => {
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
      if (!Array.isArray(arr)) arr = [];
      return JSON.stringify([...new Set(arr.map((x) => String(x).replace(/[^\d]/g, '')).filter((x) => x.length >= 6).slice(0, 2000))]);
    };
    if (b.bot_blocked !== undefined) patch.bot_blocked = normNumList(b.bot_blocked);
    if (b.bot_owner_numbers !== undefined) patch.bot_owner_numbers = normNumList(b.bot_owner_numbers);

    for (const k of ['msg_template_bill', 'msg_template_ledger', 'msg_template_receipt']) {
      if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, 2000);
    }

    if (b.min_delay_s !== undefined) patch.min_delay_s = clampInt(b.min_delay_s, 1, 120, 4);
    if (b.max_delay_s !== undefined) patch.max_delay_s = clampInt(b.max_delay_s, 1, 300, 15);
    if (b.daily_cap !== undefined) patch.daily_cap = clampInt(b.daily_cap, 1, 100000, 80);
    if (b.warmup_start !== undefined) patch.warmup_start = clampInt(b.warmup_start, 1, 100000, 20);
    if (b.warmup_step !== undefined) patch.warmup_step = clampInt(b.warmup_step, 0, 100000, 20);
    // Keep min<=max.
    const lo = patch.min_delay_s != null ? patch.min_delay_s : row.min_delay_s;
    const hi = patch.max_delay_s != null ? patch.max_delay_s : row.max_delay_s;
    if (lo > hi) patch.max_delay_s = lo;

    if (b.quiet_start !== undefined) patch.quiet_start = String(b.quiet_start).slice(0, 5);
    if (b.quiet_end !== undefined) patch.quiet_end = String(b.quiet_end).slice(0, 5);

    if (b.official_api_base !== undefined) patch.official_api_base = String(b.official_api_base).slice(0, 200);
    if (b.official_phone_number_id !== undefined) patch.official_phone_number_id = String(b.official_phone_number_id).slice(0, 60);
    if (b.official_template_name !== undefined) patch.official_template_name = String(b.official_template_name).slice(0, 120);
    if (b.official_template_lang !== undefined) patch.official_template_lang = String(b.official_template_lang).slice(0, 12);
    // Token: only overwrite when a non-empty value is supplied.
    if (b.official_access_token) patch.official_access_token = String(b.official_access_token);

    await row.update(patch);

    // Lazy-register so a saved web session reconnects + the worker starts.
    if (row.provider === 'web' && row.enabled) {
      manager.ensureRegistered(cid(req)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

// POST /api/whatsapp/send — enqueue a PDF for paced delivery.
exports.send = async (req, res) => {
  try {
    const { to, pdfBase64, fileName, caption, vars, party_id, doc_type, doc_id } = req.body || {};
    const r = await manager.enqueue(cid(req), { to, pdfBase64, fileName, caption, vars, party_id, doc_type, doc_id });
    res.json(r);
  } catch (e) {
    const status = e.code === 'NOT_CONNECTED' ? 409 : 400;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
};

// GET /api/whatsapp/outbox — recent send log (without the heavy PDF payload).
exports.outbox = async (req, res) => {
  try {
    const rows = await WhatsappOutbox.findAll({
      attributes: { exclude: ['payload_base64'] },
      include: [{ association: 'party', attributes: ['party_name'], required: false }],
      order: [['created_date', 'DESC']],
      limit: 50,
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

// POST /api/whatsapp/test — send a text test message to verify connectivity.
exports.test = async (req, res) => {
  try { res.json(await manager.sendTest(cid(req), (req.body || {}).to)); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

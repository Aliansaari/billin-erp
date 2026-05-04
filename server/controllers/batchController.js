/*
 * Batch controller — admin-side endpoints for the Batches list page,
 * Batch detail page, and Expiry Report (Commit 5 of batch tracking).
 *
 * Read-only surface: every endpoint here returns existing rows from
 * product_batches / product_batch_stock / stock_ledger. Creates and
 * mutations live on the bill controllers (purchaseController for batch
 * inception, salesController / stockTransferController for movement).
 *
 * Status taxonomy (computed in SQL, mirrored on the client):
 *   active           — has stock and not expired (or no expiry on file)
 *   expiring_soon    — has stock, expiry within `batch_expiry_alert_days`
 *   expired          — has stock and expiry < today (operator hot-list)
 *   out_of_stock     — no stock anywhere
 * The client renders a status chip for each.
 */

const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  ProductBatch, ProductBatchStock, Product, Godown, StockLedger,
  SystemSettings, Party,
} = require('../models');
const { scopeWhereByGodown } = require('../middleware/godownScope');

/**
 * Resolve the current alert window from SystemSettings — falls back to
 * 30 days if the column is unset (older databases that haven't run the
 * Commit-1 migration yet).
 */
async function getAlertDays() {
  const s = await SystemSettings.findByPk(1);
  const ad = parseInt(s?.batch_expiry_alert_days, 10);
  return Number.isFinite(ad) && ad > 0 ? ad : 30;
}

/**
 * GET /api/batches
 *   List every batch in the system, with on-hand totals + computed
 *   status. Supports product / status / godown / search filters.
 *
 * Query params:
 *   product_id     — single product filter
 *   godown_id      — only batches with stock at this godown
 *   status         — comma-separated: expired,expiring_soon,active,out_of_stock
 *   q              — substring match on batch_number OR product_name
 *   start_date     — manufacture_date >= start_date  (or expiry_date if date_field=expiry)
 *   end_date       — manufacture_date <= end_date
 *   date_field     — 'mfg' (default) | 'expiry'
 *
 * Response: { data: [...], summary: { total, active, expired, expiring_soon, expired_value } }
 */
exports.list = async (req, res) => {
  try {
    const alertDays = await getAlertDays();
    const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
    const godownId  = req.query.godown_id  ? parseInt(req.query.godown_id, 10)  : null;
    const statuses  = req.query.status ? String(req.query.status).split(',').filter(Boolean) : null;
    const q         = req.query.q ? String(req.query.q).trim() : '';
    const dateField = req.query.date_field === 'expiry' ? 'expiry_date' : 'manufacture_date';
    const startDate = req.query.start_date || null;
    const endDate   = req.query.end_date   || null;

    // Build the per-batch totals first (across all godowns or a single
    // godown), then join the batch row + product, then derive status.
    const stockJoin = godownId
      ? `LEFT JOIN (
           SELECT batch_id,
                  SUM(current_stock)::float AS total_stock
             FROM product_batch_stock
            WHERE godown_id = :godown_id
            GROUP BY batch_id
         ) bs ON bs.batch_id = pb.batch_id`
      : `LEFT JOIN (
           SELECT batch_id,
                  SUM(current_stock)::float AS total_stock
             FROM product_batch_stock
            GROUP BY batch_id
         ) bs ON bs.batch_id = pb.batch_id`;

    const where = ['pb.is_active = true'];
    const repl  = { product_id: productId, godown_id: godownId, alert_days: alertDays };
    if (productId)              { where.push('pb.product_id = :product_id'); }
    if (q) {
      where.push('(pb.batch_number ILIKE :q OR p.product_name ILIKE :q)');
      repl.q = `%${q}%`;
    }
    if (startDate)              { where.push(`pb.${dateField} >= :start_date`); repl.start_date = startDate; }
    if (endDate)                { where.push(`pb.${dateField} <= :end_date`);   repl.end_date   = endDate; }

    const baseQuery = `
      SELECT pb.batch_id,
             pb.batch_number,
             pb.product_id,
             pb.manufacture_date,
             pb.expiry_date,
             pb.purchase_rate::float                 AS purchase_rate,
             pb.notes,
             p.product_name,
             p.barcode,
             p.is_batch_tracked,
             c.category_name,
             COALESCE(bs.total_stock, 0)::float       AS total_stock,
             (COALESCE(bs.total_stock, 0) * COALESCE(pb.purchase_rate, 0))::float AS stock_value,
             CASE
               WHEN pb.expiry_date IS NOT NULL AND pb.expiry_date < CURRENT_DATE THEN 'expired'
               WHEN pb.expiry_date IS NOT NULL AND pb.expiry_date <= CURRENT_DATE + (:alert_days || ' days')::INTERVAL THEN 'expiring_soon'
               WHEN COALESCE(bs.total_stock, 0) <= 0 THEN 'out_of_stock'
               ELSE 'active'
             END                                     AS status,
             CASE
               WHEN pb.expiry_date IS NULL THEN NULL
               ELSE (pb.expiry_date - CURRENT_DATE)
             END                                     AS days_to_expiry
        FROM product_batches pb
        JOIN products p   ON p.product_id = pb.product_id
   LEFT JOIN categories c ON c.category_id = p.category_id
        ${stockJoin}
       WHERE ${where.join(' AND ')}`;

    let rows = await sequelize.query(baseQuery, { replacements: repl, type: sequelize.QueryTypes.SELECT });

    // Status filter applied client-side here so the SQL stays simple.
    if (statuses && statuses.length > 0) {
      rows = rows.filter((r) => statuses.includes(r.status));
    }

    // Sort: status priority (expired → expiring_soon → active → out_of_stock),
    // then expiry ascending (nulls last), then batch_id ascending.
    const order = { expired: 0, expiring_soon: 1, active: 2, out_of_stock: 3 };
    rows.sort((a, b) => {
      const so = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (so !== 0) return so;
      const ax = a.expiry_date ? new Date(a.expiry_date).getTime() : Number.POSITIVE_INFINITY;
      const bx = b.expiry_date ? new Date(b.expiry_date).getTime() : Number.POSITIVE_INFINITY;
      if (ax !== bx) return ax - bx;
      return a.batch_id - b.batch_id;
    });

    const summary = rows.reduce((acc, r) => {
      acc.total++;
      if (r.status === 'active')        acc.active++;
      if (r.status === 'expiring_soon') acc.expiring_soon++;
      if (r.status === 'expired') {
        acc.expired++;
        acc.expired_value += parseFloat(r.stock_value || 0);
      }
      if (r.status === 'out_of_stock')  acc.out_of_stock++;
      return acc;
    }, { total: 0, active: 0, expiring_soon: 0, expired: 0, out_of_stock: 0, expired_value: 0 });

    res.json({ data: rows, summary, alert_days: alertDays });
  } catch (err) {
    console.error('[batches.list]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/batches/:batch_id
 *   Batch detail — header (batch row + product), per-godown stock
 *   breakdown, full ledger movement (this batch only), and a distinct
 *   list of bills that touched this batch.
 *
 * Movement rows are filtered to stock_ledger.batch_id = :batch_id; per
 * Commit 4's wiring this is correctly populated for sales / sales
 * returns / purchase returns / stock transfers (in + out legs).
 */
exports.detail = async (req, res) => {
  try {
    const batchId = parseInt(req.params.batch_id, 10);
    if (!batchId) return res.status(400).json({ error: 'batch_id required' });

    const alertDays = await getAlertDays();

    const batch = await ProductBatch.findByPk(batchId, {
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'barcode', 'is_batch_tracked', 'sale_rate', 'unit_of_measurement'] }],
    });
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    // Stock by godown — only rows with non-zero stock in the response.
    const byGodown = await sequelize.query(
      `SELECT pbs.godown_id,
              g.name           AS godown_name,
              g.code           AS godown_code,
              pbs.current_stock::float AS current_stock,
              (pbs.current_stock * COALESCE(:purchase_rate, 0))::float AS value
         FROM product_batch_stock pbs
         JOIN godowns g ON g.godown_id = pbs.godown_id
        WHERE pbs.product_id = :product_id
          AND pbs.batch_id   = :batch_id
        ORDER BY pbs.current_stock DESC`,
      {
        replacements: { batch_id: batchId, product_id: batch.product_id, purchase_rate: parseFloat(batch.purchase_rate || 0) },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Movement — every stock_ledger row for this batch, ordered chronologically.
    // Running balance computed in JS (deterministic across DBs without window-fn games).
    const movement = await sequelize.query(
      `SELECT sl.ledger_id,
              sl.transaction_date,
              sl.transaction_type,
              sl.reference_id,
              sl.reference_number,
              sl.godown_id,
              g.name AS godown_name,
              g.code AS godown_code,
              sl.quantity_in::float  AS quantity_in,
              sl.quantity_out::float AS quantity_out,
              sl.rate::float         AS rate,
              sl.remarks
         FROM stock_ledger sl
    LEFT JOIN godowns g ON g.godown_id = sl.godown_id
        WHERE sl.batch_id = :batch_id
        ORDER BY sl.transaction_date ASC, sl.ledger_id ASC`,
      { replacements: { batch_id: batchId }, type: sequelize.QueryTypes.SELECT },
    );

    let running = 0;
    const movementWithBalance = movement.map((m) => {
      running += parseFloat(m.quantity_in || 0) - parseFloat(m.quantity_out || 0);
      return { ...m, running_balance: +running.toFixed(3) };
    });

    // Bills touched — distinct (reference_id, transaction_type) pairs.
    // We re-aggregate qty per bill so a single bill that hit multiple
    // godowns (rare for this batch) shows one row with summed qty.
    const billsTouched = await sequelize.query(
      `SELECT sl.reference_id,
              sl.reference_number,
              sl.transaction_type,
              MIN(sl.transaction_date)::text AS transaction_date,
              SUM(sl.quantity_in)::float    AS qty_in,
              SUM(sl.quantity_out)::float   AS qty_out,
              MAX(sl.rate)::float           AS rate
         FROM stock_ledger sl
        WHERE sl.batch_id = :batch_id
          AND sl.reference_id IS NOT NULL
        GROUP BY sl.reference_id, sl.reference_number, sl.transaction_type
        ORDER BY MIN(sl.transaction_date) DESC, sl.reference_id DESC`,
      { replacements: { batch_id: batchId }, type: sequelize.QueryTypes.SELECT },
    );

    const totalStock = byGodown.reduce((s, r) => s + parseFloat(r.current_stock || 0), 0);
    const totalValue = totalStock * parseFloat(batch.purchase_rate || 0);
    const daysToExpiry = batch.expiry_date
      ? Math.floor((new Date(batch.expiry_date) - new Date(new Date().toISOString().slice(0, 10))) / 86400000)
      : null;

    let status = 'active';
    if (batch.expiry_date && daysToExpiry < 0) status = 'expired';
    else if (batch.expiry_date && daysToExpiry <= alertDays) status = 'expiring_soon';
    else if (totalStock <= 0) status = 'out_of_stock';

    res.json({
      batch: {
        batch_id:         batch.batch_id,
        batch_number:     batch.batch_number,
        product_id:       batch.product_id,
        product_name:     batch.product?.product_name,
        product_barcode:  batch.product?.barcode,
        manufacture_date: batch.manufacture_date,
        expiry_date:      batch.expiry_date,
        purchase_rate:    parseFloat(batch.purchase_rate || 0),
        notes:            batch.notes,
        is_active:        batch.is_active,
        days_to_expiry:   daysToExpiry,
        status,
        total_stock:      +totalStock.toFixed(3),
        total_value:      +totalValue.toFixed(2),
        bills_count:      billsTouched.length,
      },
      stock_by_godown: byGodown,
      movement:        movementWithBalance,
      bills_touched:   billsTouched,
      alert_days:      alertDays,
    });
  } catch (err) {
    console.error('[batches.detail]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/batches/expiry-report
 *   Expiry-bucket roll-up across all batches with `expiry_date IS NOT NULL`,
 *   plus a "no expiry" group. Same row shape as `list` but pre-bucketed
 *   so the report page can chip-filter quickly.
 */
exports.expiryReport = async (req, res) => {
  try {
    const alertDays = await getAlertDays();
    const godownId  = req.query.godown_id ? parseInt(req.query.godown_id, 10) : null;
    const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
    const buckets   = req.query.bucket ? String(req.query.bucket).split(',').filter(Boolean) : null;

    const stockJoin = godownId
      ? `LEFT JOIN (
           SELECT batch_id, SUM(current_stock)::float AS total_stock
             FROM product_batch_stock WHERE godown_id = :godown_id
            GROUP BY batch_id
         ) bs ON bs.batch_id = pb.batch_id`
      : `LEFT JOIN (
           SELECT batch_id, SUM(current_stock)::float AS total_stock
             FROM product_batch_stock GROUP BY batch_id
         ) bs ON bs.batch_id = pb.batch_id`;

    const where = ['pb.is_active = true'];
    const repl  = { godown_id: godownId, alert_days: alertDays, product_id: productId };
    if (productId) where.push('pb.product_id = :product_id');

    const rows = await sequelize.query(
      `SELECT pb.batch_id,
              pb.batch_number,
              pb.product_id,
              pb.manufacture_date,
              pb.expiry_date,
              pb.purchase_rate::float                 AS purchase_rate,
              p.product_name,
              p.barcode,
              c.category_name,
              COALESCE(bs.total_stock, 0)::float       AS total_stock,
              (COALESCE(bs.total_stock, 0) * COALESCE(pb.purchase_rate, 0))::float AS stock_value,
              CASE
                WHEN pb.expiry_date IS NULL THEN NULL
                ELSE (pb.expiry_date - CURRENT_DATE)
              END                                      AS days_to_expiry,
              CASE
                WHEN pb.expiry_date IS NULL                                                THEN 'no_expiry'
                WHEN pb.expiry_date <  CURRENT_DATE                                        THEN 'expired'
                WHEN pb.expiry_date <= CURRENT_DATE + INTERVAL '30 days'                   THEN '0_30'
                WHEN pb.expiry_date <= CURRENT_DATE + INTERVAL '60 days'                   THEN '31_60'
                WHEN pb.expiry_date <= CURRENT_DATE + INTERVAL '90 days'                   THEN '61_90'
                ELSE '91_plus'
              END                                      AS bucket
         FROM product_batches pb
         JOIN products p ON p.product_id = pb.product_id
    LEFT JOIN categories c ON c.category_id = p.category_id
         ${stockJoin}
        WHERE ${where.join(' AND ')}`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT },
    );

    let filtered = rows;
    if (buckets && buckets.length > 0) {
      filtered = rows.filter((r) => buckets.includes(r.bucket));
    }
    // Days-to-expiry ascending (most expired / soonest to expire first),
    // nulls last (no_expiry rows trail).
    filtered.sort((a, b) => {
      const ax = a.days_to_expiry == null ? Number.POSITIVE_INFINITY : a.days_to_expiry;
      const bx = b.days_to_expiry == null ? Number.POSITIVE_INFINITY : b.days_to_expiry;
      return ax - bx;
    });

    const summary = rows.reduce((acc, r) => {
      acc.total++;
      acc[r.bucket] = (acc[r.bucket] || 0) + 1;
      acc.values[r.bucket] = (acc.values[r.bucket] || 0) + parseFloat(r.stock_value || 0);
      return acc;
    }, { total: 0, values: {} });

    res.json({ data: filtered, summary, alert_days: alertDays });
  } catch (err) {
    console.error('[batches.expiryReport]', err);
    res.status(500).json({ error: err.message });
  }
};

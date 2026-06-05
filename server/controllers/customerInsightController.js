/**
 * customerInsightController.js
 *
 * Single-endpoint analytics for the Party Insight Panel (F8). Works for
 * BOTH customers (sales side) and suppliers (purchase side) — the `role`
 * query param selects which tables/columns to read:
 *
 *   role=customer (default) → sales_bills / sales_bill_items, profit via COGS,
 *                             receipts as the settlement side.
 *   role=supplier           → purchase_bills / purchase_bill_items, NO profit
 *                             (we don't attribute margin to a supplier),
 *                             payments as the settlement side.
 *
 * Everything is real data — no placeholders. Each metric is its own scalar
 * query so granularities never cross-contaminate (a 3-item bill's single
 * bill-level discount is never counted 3×).
 */

const sequelize = require('../config/database');
const { Party } = require('../models');
const { respondWithError } = require('../utils/helpers');

// ── Indian Financial Year helpers ────────────────────────────────────────────
function getFyBounds() {
  const today    = new Date();
  const curYear  = today.getFullYear();
  const curMonth = today.getMonth() + 1; // 1-based
  const fyStartYear = curMonth >= 4 ? curYear : curYear - 1;
  const fyEndYear   = fyStartYear + 1;
  return {
    fyStart: `${fyStartYear}-04-01`,
    fyLabel: `FY ${String(fyStartYear).slice(2)}-${String(fyEndYear).slice(2)}`,
  };
}

// Per-role table/column config. Names are fixed server-side constants (never
// user input), so it's safe to interpolate them into the SQL strings below.
function roleConfig(role) {
  if (role === 'supplier') {
    return {
      role:        'supplier',
      billTable:   'purchase_bills',
      billPk:      'purchase_bill_id',
      itemTable:   'purchase_bill_items',
      partyCol:    'supplier_id',
      allocType:   'Purchase',   // bill_payment_allocations.bill_type
      hasProfit:   false,        // purchase_bill_items has no cost_rate / margin
      hasAdjust:   false,        // purchase_bills has no special_discount/return_amount
      hasPayMode:  false,        // purchase_bills has no payment_method column
    };
  }
  return {
    role:        'customer',
    billTable:   'sales_bills',
    billPk:      'sales_bill_id',
    itemTable:   'sales_bill_items',
    partyCol:    'customer_id',
    allocType:   'Sales',
    hasProfit:   true,
    hasAdjust:   true,
    hasPayMode:  true,
  };
}

exports.getInsights = async (req, res) => {
  try {
    const partyId = parseInt(req.params.id, 10);
    if (!partyId || isNaN(partyId)) {
      return res.status(400).json({ error: 'Invalid party id' });
    }

    const role = req.query.role === 'supplier' ? 'supplier' : 'customer';
    const cfg  = roleConfig(role);

    const party = await Party.findByPk(partyId);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const { fyStart, fyLabel } = getFyBounds();
    const today = new Date();

    const P = cfg.partyCol;
    const T = cfg.billTable;
    const PK = cfg.billPk;
    const IT = cfg.itemTable;

    // ── FY bill metrics ──────────────────────────────────────────────────
    const [fy] = await sequelize.query(`
      SELECT
        COUNT(*)                                            AS bill_count,
        COALESCE(SUM(total_amount),    0)                  AS revenue,
        COALESCE(AVG(total_amount),    0)                  AS avg_bill,
        COALESCE(SUM(discount_amount), 0)                  AS discount_amount,
        COALESCE(SUM(sub_total),       0)                  AS sub_total,
        COUNT(*) FILTER (WHERE payment_status = 'Paid')    AS paid_count,
        COUNT(*) FILTER (WHERE payment_status = 'Partial') AS partial_count,
        COUNT(*) FILTER (WHERE payment_status = 'Unpaid')  AS unpaid_count
      FROM ${T}
      WHERE ${P} = :partyId
        AND bill_date >= :fyStart
        AND (is_cancelled IS NULL OR is_cancelled = FALSE)
    `, { replacements: { partyId, fyStart }, type: sequelize.QueryTypes.SELECT });

    // ── All-time bill metrics ────────────────────────────────────────────
    const [at] = await sequelize.query(`
      SELECT
        COUNT(*)                                            AS bill_count,
        COALESCE(SUM(total_amount),    0)                  AS revenue,
        COALESCE(AVG(total_amount),    0)                  AS avg_bill,
        COALESCE(SUM(discount_amount), 0)                  AS discount_amount,
        COALESCE(SUM(sub_total),       0)                  AS sub_total,
        COALESCE(MAX(total_amount),    0)                  AS largest_bill,
        COALESCE(MIN(CASE WHEN total_amount > 0 THEN total_amount END), 0) AS smallest_bill
      FROM ${T}
      WHERE ${P} = :partyId
        AND (is_cancelled IS NULL OR is_cancelled = FALSE)
    `, { replacements: { partyId }, type: sequelize.QueryTypes.SELECT });

    // ── Profit (customer only): FY + lifetime taxable revenue & COGS ──────
    let pf = { fy_rev: 0, fy_cogs: 0, life_rev: 0, life_cogs: 0 };
    let adj = { fy_adj: 0, life_adj: 0 };
    if (cfg.hasProfit) {
      const [r] = await sequelize.query(`
        SELECT
          COALESCE(SUM(sbi.taxable_amount) FILTER (WHERE sb.bill_date >= :fyStart), 0) AS fy_rev,
          COALESCE(SUM(sbi.taxable_amount), 0)                                          AS life_rev,
          COALESCE(SUM(sbi.quantity * sbi.cost_rate) FILTER (WHERE sb.bill_date >= :fyStart), 0) AS fy_cogs,
          COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)                                AS life_cogs
        FROM ${IT} sbi
        JOIN ${T} sb ON sb.${PK} = sbi.${PK}
        WHERE sb.${P} = :partyId
          AND (sb.is_cancelled IS NULL OR sb.is_cancelled = FALSE)
      `, { replacements: { partyId, fyStart }, type: sequelize.QueryTypes.SELECT });
      pf = r;

      const [a] = await sequelize.query(`
        SELECT
          COALESCE(SUM(COALESCE(special_discount,0) + COALESCE(return_amount,0))
                   FILTER (WHERE bill_date >= :fyStart), 0) AS fy_adj,
          COALESCE(SUM(COALESCE(special_discount,0) + COALESCE(return_amount,0)), 0) AS life_adj
        FROM ${T}
        WHERE ${P} = :partyId
          AND (is_cancelled IS NULL OR is_cancelled = FALSE)
      `, { replacements: { partyId, fyStart }, type: sequelize.QueryTypes.SELECT });
      adj = a;
    }

    // ── Visit dates (first / last) ────────────────────────────────────────
    const [vr] = await sequelize.query(`
      SELECT MAX(bill_date) AS last_visit, MIN(bill_date) AS first_visit
      FROM ${T}
      WHERE ${P} = :partyId AND (is_cancelled IS NULL OR is_cancelled = FALSE)
    `, { replacements: { partyId }, type: sequelize.QueryTypes.SELECT });

    // ── Visit gap (avg / longest) over distinct dates ─────────────────────
    const [gr] = await sequelize.query(`
      SELECT ROUND(AVG(gap_days))::INTEGER AS avg_gap_days, MAX(gap_days) AS max_gap_days
      FROM (
        SELECT bill_date - LAG(bill_date) OVER (ORDER BY bill_date) AS gap_days
        FROM (
          SELECT DISTINCT bill_date FROM ${T}
          WHERE ${P} = :partyId AND (is_cancelled IS NULL OR is_cancelled = FALSE)
        ) d
      ) g
      WHERE gap_days IS NOT NULL
    `, { replacements: { partyId }, type: sequelize.QueryTypes.SELECT });

    // ── Preferred payment mode (customer only — purchase bills lack it) ───
    let pm = {};
    if (cfg.hasPayMode) {
      const [r] = await sequelize.query(`
        SELECT payment_method, COUNT(*) AS cnt
        FROM ${T}
        WHERE ${P} = :partyId AND (is_cancelled IS NULL OR is_cancelled = FALSE)
          AND payment_method IS NOT NULL AND payment_method <> ''
        GROUP BY payment_method ORDER BY cnt DESC LIMIT 1
      `, { replacements: { partyId }, type: sequelize.QueryTypes.SELECT });
      pm = r || {};
    }

    // ── Average pay time: days from bill to full settlement ───────────────
    // Reads bill_payment_allocations → payments_receipts. Wrapped so a
    // missing table (older install) returns null instead of failing the
    // whole endpoint. Only fully-paid bills count; a settled bill's pay
    // time = (last allocating payment date − bill_date).
    let avgPayDays = null;
    try {
      const [r] = await sequelize.query(`
        SELECT ROUND(AVG(d)::numeric, 1) AS avg_pay_days
        FROM (
          SELECT (MAX(pr.transaction_date) - b.bill_date) AS d
          FROM ${T} b
          JOIN bill_payment_allocations bpa
            ON bpa.bill_type = :allocType AND bpa.bill_id = b.${PK}
          JOIN payments_receipts pr
            ON pr.transaction_id = bpa.transaction_id
           AND (pr.is_cancelled IS NULL OR pr.is_cancelled = FALSE)
          WHERE b.${P} = :partyId
            AND (b.is_cancelled IS NULL OR b.is_cancelled = FALSE)
            AND b.payment_status = 'Paid'
          GROUP BY b.${PK}, b.bill_date
        ) t
        WHERE d >= 0
      `, { replacements: { partyId, allocType: cfg.allocType }, type: sequelize.QueryTypes.SELECT });
      avgPayDays = r && r.avg_pay_days != null ? parseFloat(r.avg_pay_days) : null;
    } catch (e) {
      avgPayDays = null; // table absent or query unsupported — degrade gracefully
    }

    // ── Top 5 products ────────────────────────────────────────────────────
    const topProducts = await sequelize.query(`
      SELECT
        it.product_id,
        COALESCE(p.product_name, it.product_name, 'Unknown') AS product_name,
        ROUND(SUM(it.taxable_amount)::numeric, 2) AS total_revenue,
        ROUND(SUM(it.quantity)::numeric, 2)       AS total_qty,
        COUNT(DISTINCT b.${PK})                   AS bill_count
      FROM ${IT} it
      JOIN ${T} b ON b.${PK} = it.${PK}
      LEFT JOIN products p ON p.product_id = it.product_id
      WHERE b.${P} = :partyId
        AND (b.is_cancelled IS NULL OR b.is_cancelled = FALSE)
        AND it.product_id IS NOT NULL
      GROUP BY it.product_id, COALESCE(p.product_name, it.product_name, 'Unknown')
      ORDER BY SUM(it.taxable_amount) DESC
      LIMIT 5
    `, { replacements: { partyId }, type: sequelize.QueryTypes.SELECT });

    // ── Derive ────────────────────────────────────────────────────────────
    const num = (v) => parseFloat(v || 0);

    // FY profit
    const fyRev    = num(pf.fy_rev);
    const fyCogs   = num(pf.fy_cogs);
    const fyAdj    = num(adj.fy_adj);
    const fyProfit = fyRev - fyCogs - fyAdj;
    const fyMargin = fyRev > 0 ? (fyProfit / fyRev) * 100 : 0;

    // Lifetime profit
    const lifeRev    = num(pf.life_rev);
    const lifeCogs   = num(pf.life_cogs);
    const lifeAdj    = num(adj.life_adj);
    const lifeProfit = lifeRev - lifeCogs - lifeAdj;
    const lifeMargin = lifeRev > 0 ? (lifeProfit / lifeRev) * 100 : 0;

    // Discount %
    const fySub  = num(fy.sub_total);
    const fyDisc = num(fy.discount_amount);
    const atSub  = num(at.sub_total);
    const atDisc = num(at.discount_amount);

    const lastVisit = vr.last_visit || null;
    const daysSince = lastVisit ? Math.floor((today - new Date(lastVisit)) / 864e5) : null;

    res.json({
      role: cfg.role,
      party: party.toJSON(),
      fy_label: fyLabel,

      fy_metrics: {
        bill_count:       parseInt(fy.bill_count || 0, 10),
        revenue:          num(fy.revenue),
        avg_bill:         num(fy.avg_bill),
        discount_amount:  fyDisc,
        avg_discount_pct: fySub > 0 ? +((fyDisc / fySub) * 100).toFixed(2) : 0,
        profit:           cfg.hasProfit ? +fyProfit.toFixed(2) : null,
        margin_pct:       cfg.hasProfit ? +fyMargin.toFixed(2) : null,
        cogs:             cfg.hasProfit ? +fyCogs.toFixed(2) : null,
        paid_count:       parseInt(fy.paid_count || 0, 10),
        partial_count:    parseInt(fy.partial_count || 0, 10),
        unpaid_count:     parseInt(fy.unpaid_count || 0, 10),
      },

      alltime_metrics: {
        bill_count:        parseInt(at.bill_count || 0, 10),
        revenue:           num(at.revenue),
        avg_bill:          num(at.avg_bill),
        discount_amount:   atDisc,
        avg_discount_pct:  atSub > 0 ? +((atDisc / atSub) * 100).toFixed(2) : 0,
        largest_bill:      num(at.largest_bill),
        smallest_bill:     num(at.smallest_bill),
        lifetime_profit:   cfg.hasProfit ? +lifeProfit.toFixed(2) : null,
        lifetime_margin_pct: cfg.hasProfit ? +lifeMargin.toFixed(2) : null,
      },

      behavior: {
        last_visit:              lastVisit,
        days_since_last_visit:   daysSince,
        first_visit:             vr.first_visit || null,
        avg_days_between_visits: gr && gr.avg_gap_days != null ? parseInt(gr.avg_gap_days, 10) : null,
        longest_gap_days:        gr && gr.max_gap_days != null ? parseInt(gr.max_gap_days, 10) : null,
        preferred_payment_mode:  pm.payment_method || null,
        avg_pay_days:            avgPayDays,
      },

      top_products: (topProducts || []).map((r, i) => ({
        rank:          i + 1,
        product_id:    r.product_id,
        product_name:  r.product_name,
        total_revenue: num(r.total_revenue),
        total_qty:     num(r.total_qty),
        bill_count:    parseInt(r.bill_count || 0, 10),
      })),
    });
  } catch (err) {
    console.error('customerInsightController.getInsights error:', err);
    respondWithError(res, err);
  }
};

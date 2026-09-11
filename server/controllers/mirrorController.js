/**
 * The mirror feed — what the phone is allowed to keep a copy of.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * Every figure here is computed HERE and shipped as a finished number. The
 * phone stores answers; it never derives them.
 *
 * A party's balance is `parties.current_balance`, the column the posting
 * service maintains — the same source the dashboard tiles, the customer list
 * and the outstanding report all read, which is why those three agree. See
 * the long note above reportController.partyOutstanding for what happened the
 * last time a balance was derived instead: a bill-derived formula broke on
 * imported data, overstated every supplier and flipped the net sign.
 *
 * A phone that caches answers can show an OLD number. A phone that computes
 * them can show a WRONG one, and a wrong one gets quoted to a customer's
 * face. That is the whole reason this endpoint exists rather than letting the
 * device sync raw ledger rows and add them up itself.
 *
 * ── WHY WHOLE SETS, NOT DELTAS ───────────────────────────────────────
 *
 * None of the money tables carry `updated_at`, and ledger_entries,
 * bill_payment_allocations and stock_ledger have no soft-delete either — rows
 * are hard-deleted. A delta feed therefore has no way to tell a phone that a
 * row is GONE, so a cancelled bill would live on the device forever and keep
 * being counted. Whole-set replacement is immune to that by construction: if
 * a row is not in the new set, it is not in the mirror.
 */
const sequelize = require('../config/database');
const { respondWithError } = require('../utils/helpers');

/* Money is compared in integer paise, never in floats.
 *
 * The point of the checksum is for the phone to prove it stored exactly what
 * was sent. Summing rupees as doubles on two different platforms reintroduces
 * the very class of disagreement the checksum is meant to detect — so the sum
 * is an integer count of paise, which is exact on both sides. */
const toPaise = (v) => Math.round(Number(v || 0) * 100);

const checksumOf = (rows, field) => ({
  count: rows.length,
  paise: rows.reduce((acc, r) => acc + toPaise(r[field]), 0),
});

const SETS = {
  /* Parties and what they owe. Small — a few hundred rows even for a large
   * wholesaler — so it is replaced whole on every sync. */
  parties: async () => {
    const rows = await sequelize.query(
      `SELECT p.party_id,
              p.party_name,
              p.party_type,
              p.mobile_1,
              COALESCE(p.credit_limit, 0)::float                   AS credit_limit,
              COALESCE(p.credit_days, 0)::int                      AS credit_days,
              ROUND(COALESCE(p.current_balance, 0)::numeric, 2)::float AS current_balance
         FROM parties p
        ORDER BY p.party_id`,
      { type: sequelize.QueryTypes.SELECT },
    );
    return { rows, checksum: checksumOf(rows, 'current_balance') };
  },
};

/**
 * GET /api/mirror/pull?set=parties
 *
 * `generated_at` is the SERVER's clock on purpose. The phone shows this as
 * "synced at …" when it cannot reach the shop, and a phone with a wrong clock
 * must not be able to make stale figures look fresh.
 */
exports.pull = async (req, res) => {
  try {
    const set = String(req.query.set || '');
    const loader = SETS[set];
    if (!loader) {
      return res.status(400).json({ message: `Unknown mirror set: ${set || '(none)'}` });
    }
    const { rows, checksum } = await loader();
    return res.json({
      set,
      generated_at: Date.now(),
      rows,
      checksum,
    });
  } catch (error) {
    console.error('Mirror pull error:', error);
    return respondWithError(res, error);
  }
};

/**
 * GET /api/mirror/checksum?set=parties
 *
 * The cheap half of the contract. Standing in front of a customer, the phone
 * needs to know whether the figure it holds is still the figure the shop
 * holds — and it needs to know in milliseconds, without pulling every row.
 * Same computation as `pull`, so agreement here means the mirror is current.
 */
exports.checksum = async (req, res) => {
  try {
    const set = String(req.query.set || '');
    const loader = SETS[set];
    if (!loader) {
      return res.status(400).json({ message: `Unknown mirror set: ${set || '(none)'}` });
    }
    const { checksum } = await loader();
    return res.json({ set, generated_at: Date.now(), checksum });
  } catch (error) {
    console.error('Mirror checksum error:', error);
    return respondWithError(res, error);
  }
};

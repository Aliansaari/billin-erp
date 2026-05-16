// ── Day Book ──────────────────────────────────────────────────────────
//
// Classic accounting-style chronological list of every voucher posted in a date range.
// Source of truth: ledger_entries grouped by entry_number (the voucher
// group key — multiple Dr/Cr legs share the same entry_number).
//
// Display rules per voucher:
//   • Voucher Type — derived from source_type when more specific than
//     voucher_type (e.g. source_type 'sales_return_bill' → "Sales Return"
//     even though voucher_type is 'Sales').
//   • Party / Account — picked from the "primary" leg. Preference:
//        1. The leg flagged as a party ledger (la.is_party_ledger = true)
//        2. Otherwise the first non-cash/bank ledger
//        3. Otherwise the first leg
//     This matches the standard accounting convention of showing the customer/supplier
//     name on Sales/Purchase rows and the bank/cash on Receipt/Payment.
//   • Debit / Credit — net Dr or net Cr of the chosen primary leg. The
//     header shows the *sign* of money flow on that party row, which is
//     what the operator scans for.
//   • Narration — the voucher's narration if any leg has one (legs of
//     the same voucher usually share narration).
//
// Reversal pairs are excluded so the day book reflects the live state of
// the books (a posting that was later reversed doesn't double-up).

const sequelize = require('../config/database');
const { SystemSettings } = require('../models');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function resolvePeriod(query) {
  let from = (query && query.from_date) ? String(query.from_date).slice(0, 10) : null;
  let to   = (query && query.to_date)   ? String(query.to_date).slice(0, 10)   : null;
  if (!from || !to) {
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = today;
    if (!to)   to   = today;
  }
  return { from, to };
}

// Map (voucher_type, source_type) → operator-facing display label.
// source_type is finer-grained: a return posts under voucher_type 'Sales'
// but with source_type 'sales_return_bill'.
function displayVoucherType(voucher_type, source_type) {
  if (source_type === 'sales_return_bill')    return 'Sales Return';
  if (source_type === 'purchase_return_bill') return 'Purchase Return';
  return voucher_type;  // Sales | Purchase | Receipt | Payment | Journal | Contra
}

// Drill-down route on click. Mirrors the existing edit pages.
function drillRoute(source_type, reference_id) {
  if (!reference_id) return null;
  switch (source_type) {
    case 'sales_bill':           return `/sale/edit/${reference_id}`;
    case 'purchase_bill':        return `/purchase/edit/${reference_id}`;
    case 'sales_return_bill':    return `/sales-return/edit/${reference_id}`;
    case 'purchase_return_bill': return `/purchase-return/edit/${reference_id}`;
    case 'payment_receipt':      return `/payments`;
    case 'journal_voucher':      return `/accounts/journal/edit/${reference_id}`;
    default:                     return null;
  }
}

exports.dayBook = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const sortDir = (req.query.sort_dir === 'desc') ? 'DESC' : 'ASC';

    // Optional voucher-type filter — accept comma-separated list. Filter
    // on the *display* label so 'Sales Return' / 'Purchase Return' work
    // alongside the raw voucher_type values.
    const typesParam = req.query.voucher_types
      ? String(req.query.voucher_types).split(',').map(s => s.trim()).filter(Boolean)
      : null;

    // Optional party filter — match any leg with this party_id (either
    // via le.party_id directly or via the joined la.party_id).
    const partyId = req.query.party_id ? parseInt(req.query.party_id, 10) : null;

    // Pull every live (non-reversed) leg in the period, with its account
    // and party display info. We aggregate per-voucher in JS — small
    // payloads (a typical day has tens of vouchers, not thousands).
    const replacements = { from, to };
    let partyFilter = '';
    if (partyId) {
      partyFilter = ` AND (le.party_id = :party_id OR la.party_id = :party_id)`;
      replacements.party_id = partyId;
    }

    const rows = await sequelize.query(
      `SELECT le.entry_id,
              le.entry_number,
              le.entry_date,
              le.voucher_type,
              le.source_type,
              le.reference_id,
              le.reference_number,
              le.debit_amount::float  AS debit_amount,
              le.credit_amount::float AS credit_amount,
              le.narration,
              le.party_id AS leg_party_id,
              la.ledger_id,
              la.ledger_name,
              la.ledger_group,
              la.sub_group,
              la.is_party_ledger,
              la.party_id AS ledger_party_id,
              p.party_name
         FROM ledger_entries le
         JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
         LEFT JOIN parties p
           ON p.party_id = COALESCE(le.party_id, la.party_id)
        WHERE le.entry_date BETWEEN :from AND :to
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
          )
          ${partyFilter}
        ORDER BY le.entry_date ${sortDir}, le.entry_number ${sortDir}, le.entry_id ASC`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );

    // Group by entry_number (the voucher key). For each voucher, pick the
    // primary leg (party leg preferred). The voucher's Dr/Cr column shows
    // the primary leg's amount on its natural side.
    const byVoucher = new Map();
    for (const r of rows) {
      const key = r.entry_number;
      if (!byVoucher.has(key)) {
        byVoucher.set(key, {
          entry_number: r.entry_number,
          entry_date:   r.entry_date,
          voucher_type: r.voucher_type,
          source_type:  r.source_type,
          reference_id: r.reference_id,
          reference_number: r.reference_number,
          narration:    r.narration || '',
          legs:         [],
        });
      }
      const v = byVoucher.get(key);
      v.legs.push(r);
      if (!v.narration && r.narration) v.narration = r.narration;
    }

    // Pick primary leg per voucher.
    //
    // LED-H7 — deterministic pick. When the voucher has MULTIPLE party
    // legs (e.g. inter-party JV transferring balance from Acme → Acme
    // Subsidiary), the previous `Array.find` returned whichever party
    // leg came first in SQL order — non-deterministic across queries
    // because there's no ORDER BY on the leg fetch. Same call from
    // Day Book and from Ledger Statement could show different party
    // names for the same voucher.
    //
    // New rule: when multiple candidates exist, prefer the one with
    // the highest signed amount (party with the larger movement); on
    // a tie, fall back to the lowest entry_id so the ordering is at
    // least stable.
    function pickPrimary(legs) {
      const partyLegs = legs.filter(l => l.is_party_ledger || l.leg_party_id || l.ledger_party_id);
      if (partyLegs.length > 0) {
        return partyLegs
          .slice()
          .sort((a, b) => {
            const amtA = Math.max(Number(a.debit_amount) || 0, Number(a.credit_amount) || 0);
            const amtB = Math.max(Number(b.debit_amount) || 0, Number(b.credit_amount) || 0);
            if (amtB !== amtA) return amtB - amtA;
            return (Number(a.entry_id) || 0) - (Number(b.entry_id) || 0);
          })[0];
      }
      // Skip cash + bank + bank-OD so the counterparty surfaces on
      // Receipt/Payment vouchers. Match the same exclusion as
      // autoReceiptService._config (audit L2).
      const nonCashSubgroups = new Set(['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']);
      const nonCash = legs
        .filter(l => !nonCashSubgroups.has(l.sub_group))
        .sort((a, b) => (Number(a.entry_id) || 0) - (Number(b.entry_id) || 0));
      if (nonCash.length) return nonCash[0];
      // Fallback: stable-sort by entry_id, pick the first.
      return legs.slice().sort((a, b) => (Number(a.entry_id) || 0) - (Number(b.entry_id) || 0))[0];
    }

    const vouchers = [];
    let totalDr = 0, totalCr = 0;
    // Track all-legs totals separately so the response can advertise BOTH
    // the per-row "movement" (primary-leg) total and the bookkeeping
    // Σ Dr = Σ Cr total. Audit H14: the previous response only exposed
    // primary-leg sums but called them total_debit / total_credit, so an
    // operator reading the day-book summary on a sales-only day saw
    // Cr = 0, which is correct for "classic accounting-style movement" but misleading
    // when read as "total debits / total credits."
    let totalDrAllLegs = 0, totalCrAllLegs = 0;

    for (const v of byVoucher.values()) {
      const primary = pickPrimary(v.legs);
      const dispType = displayVoucherType(v.voucher_type, v.source_type);

      // Apply voucher-type filter at the voucher level (not leg level).
      if (typesParam && typesParam.length > 0 && !typesParam.includes(dispType)) continue;

      const dr = num(primary.debit_amount);
      const cr = num(primary.credit_amount);
      totalDr += dr;
      totalCr += cr;

      // Sum across every leg of this voucher (always balanced per voucher).
      for (const l of v.legs) {
        totalDrAllLegs += num(l.debit_amount);
        totalCrAllLegs += num(l.credit_amount);
      }

      vouchers.push({
        entry_number:     v.entry_number,
        entry_date:       v.entry_date,
        voucher_type:     dispType,
        voucher_no:       v.reference_number || v.entry_number,
        party_or_account: primary.party_name || primary.ledger_name,
        is_party:         !!(primary.is_party_ledger || primary.party_name),
        debit:            dr,
        credit:           cr,
        narration:        v.narration || '',
        drill_route:      drillRoute(v.source_type, v.reference_id),
        // include all legs for an inline drill-down view if the UI wants it later
        legs:             v.legs.map(l => ({
          ledger_id:    l.ledger_id,
          ledger_name:  l.ledger_name,
          debit:        num(l.debit_amount),
          credit:       num(l.credit_amount),
          is_party:     !!l.is_party_ledger,
          party_name:   l.party_name,
        })),
      });
    }

    // Re-sort because Map insertion order followed SQL ordering, but
    // type-filter exclusions may leave gaps. Stable sort by date.
    vouchers.sort((a, b) => {
      const da = String(a.entry_date), db = String(b.entry_date);
      if (da !== db) return sortDir === 'DESC' ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
      return String(a.entry_number).localeCompare(String(b.entry_number));
    });

    // Counts by display type — useful for client-side filter chip badges.
    const counts = {};
    for (const v of vouchers) {
      counts[v.voucher_type] = (counts[v.voucher_type] || 0) + 1;
    }

    return res.json({
      data: vouchers,
      total: vouchers.length,
      summary: {
        voucher_count: vouchers.length,
        // Per-row primary-leg totals (classic accounting-style "movement"). Asymmetric
        // for single-direction days — e.g. a pure-sales day has
        // total_credit_primary = 0 because every voucher's primary leg is
        // a Customer Dr. Suitable for "money in / money out" framing.
        total_debit:           Math.round(totalDr * 100) / 100,
        total_credit:          Math.round(totalCr * 100) / 100,
        total_debit_primary:   Math.round(totalDr * 100) / 100,
        total_credit_primary:  Math.round(totalCr * 100) / 100,
        // Σ across every leg of every voucher in the result set. Balanced
        // by construction (each voucher is balanced). Suitable for the
        // "total debits = total credits" reconciliation banner. Audit H14.
        total_debit_all_legs:  Math.round(totalDrAllLegs * 100) / 100,
        total_credit_all_legs: Math.round(totalCrAllLegs * 100) / 100,
        counts_by_type: counts,
      },
      from_date: from,
      to_date:   to,
    });
  } catch (err) {
    console.error('Day Book error:', err);
    return res.status(500).json({ error: 'Failed to load Day Book', detail: err.message });
  }
};

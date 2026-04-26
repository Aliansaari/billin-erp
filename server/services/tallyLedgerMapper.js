// ── Tally Ledger Mapper ────────────────────────────────────────────────
//
// Suggests a system ledger_account for each Tally ledger name encountered
// during import. Confidence stamps:
//   • high   — exact match OR strong rule match (CGST 9% → CGST Output etc.)
//   • medium — fuzzy match (Levenshtein ≤ 3) or shared key tokens
//   • low    — weak suggestion (Suspense Account fallback)
//   • unmapped — no suggestion at all; user MUST pick before commit
//
// Persistence: persisted suggestions in `tally_ledger_mappings` are returned
// directly without re-running the heuristics — once the user has confirmed
// a Tally name → system ledger pairing, the import flow trusts that pairing
// for the lifetime of the install (until the user explicitly re-maps).
//
// No external fuzzy-match dependency — Levenshtein is ~30 lines.

const { LedgerAccount, TallyLedgerMapping } = require('../models');

// Inline Levenshtein. Returns the edit distance between two strings.
function lev(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const al = a.length, bl = b.length;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // delete
        curr[j - 1] + 1,    // insert
        prev[j - 1] + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Token-set overlap score: |A ∩ B| / max(|A|, |B|). Range 0–1.
function tokenOverlap(a, b) {
  const ta = new Set(norm(a).split(' ').filter(Boolean));
  const tb = new Set(norm(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.max(ta.size, tb.size);
}

// Specialised tax-ledger detection. Tally names like "CGST @ 9% Output",
// "Output IGST 18%", "Input SGST" should land on CGST Output / IGST Output /
// SGST Input respectively, with 'high' confidence regardless of fuzzy match.
function detectTaxLedger(name) {
  const n = norm(name);
  if (!/(c|s|i)gst/.test(n)) return null;
  const tax    = /\bcgst\b/.test(n) ? 'CGST' : /\bsgst\b/.test(n) ? 'SGST' : /\bigst\b/.test(n) ? 'IGST' : null;
  if (!tax) return null;
  // direction inference. "output" / "sales" / "outward" → output side.
  // "input" / "purchase" / "inward" → input side.
  const isOutput = /\b(output|outward|sales|sale)\b/.test(n);
  const isInput  = /\b(input|inward|purchase|purchases|purchasing)\b/.test(n);
  // Default: if neither says, guess from whether it's already known (some
  // installs label tax ledgers without direction). Default to OUTPUT —
  // safer to flag for manual review on the rarer Input side than to
  // silently mis-route revenue tax.
  const direction = isOutput ? 'Output' : isInput ? 'Input' : 'Output';
  return { name: `${tax} ${direction}`, confidence: 'high' };
}

// Specialised mapping rules. These run before fuzzy match so well-known
// patterns short-circuit to 'high' confidence. Order matters — first hit
// wins.
function ruleMatch(name) {
  const n = norm(name);

  const tax = detectTaxLedger(name);
  if (tax) return tax;

  if (/\b(round\s*off|round\s*ing)\b/.test(n))           return { name: 'Round Off',          confidence: 'high' };
  if (/\b(discount\s*allowed|disc\s*allowed)\b/.test(n)) return { name: 'Discount Allowed',   confidence: 'high' };
  if (/\b(discount\s*received|disc\s*received)\b/.test(n)) return { name: 'Discount Received', confidence: 'high' };
  if (/\bsales?\s*return\b/.test(n))                     return { name: 'Sales Return',       confidence: 'high' };
  if (/\bpurchase\s*return\b/.test(n))                   return { name: 'Purchase Return',    confidence: 'high' };
  // norm() collapses slashes/punctuation to spaces, so "Sales A/C" becomes
  // "sales a c". These regexes match the normalised form.
  if (/^sales?(\s+a\s*c|\s+account|\s+ledger)?$/.test(n))
    return { name: 'Sales Account', confidence: 'high' };
  if (/^purchases?(\s+a\s*c|\s+account|\s+ledger)?$/.test(n))
    return { name: 'Purchase Account', confidence: 'high' };
  if (/^cash(\s+a\s*c|\s+account|\s+in\s*hand)?$/.test(n))
    return { name: 'Cash', confidence: 'high' };
  if (/^bank(\s+a\s*c|\s+account)?$/.test(n))
    return { name: 'Bank Account', confidence: 'high' };
  if (/\bopening\s*balance\b|\bcapital\b.*\bequity\b/.test(n))
    return { name: 'Opening Balance Equity', confidence: 'high' };
  if (/\bcapital\s*(a\/c|account)?$/.test(n))
    return { name: 'Capital Account', confidence: 'high' };
  if (/\bstock\s*(in\s*hand)?$/.test(n))
    return { name: 'Stock-in-Hand', confidence: 'high' };
  if (/\bsuspense\b/.test(n))
    return { name: 'Suspense Account', confidence: 'manual' };

  return null;
}

// Best fuzzy match against the chart of accounts. Returns the ledger plus
// a confidence based on edit distance / token overlap.
function fuzzyAgainstChart(name, chart) {
  let best = null;
  let bestScore = -1;
  for (const lg of chart) {
    if (lg.is_party_ledger) continue; // never auto-route to a party ledger
    const distance = lev(norm(name), norm(lg.ledger_name));
    const overlap  = tokenOverlap(name, lg.ledger_name);
    // Combined score: invert distance, weight by overlap. Higher = better.
    const score = (overlap * 10) - distance;
    if (score > bestScore) {
      bestScore = score;
      best = { ledger: lg, distance, overlap };
    }
  }
  if (!best) return null;
  // Confidence thresholds. Identical normalised names = high.
  if (best.distance === 0) return { ledgerId: best.ledger.ledger_id, name: best.ledger.ledger_name, confidence: 'high' };
  if (best.distance <= 3 && best.overlap >= 0.5)
    return { ledgerId: best.ledger.ledger_id, name: best.ledger.ledger_name, confidence: 'medium' };
  if (best.overlap >= 0.34)
    return { ledgerId: best.ledger.ledger_id, name: best.ledger.ledger_name, confidence: 'low' };
  return null;
}

// ── Public: suggest mappings for an array of Tally ledger names ────────
//
// Returns array<{
//   tally_ledger_name,
//   suggested_ledger_id,    // null when unmapped
//   suggested_ledger_name,  // human-readable for the UI
//   confidence,             // high | medium | low | manual | unmapped
//   from_persisted,         // true if pulled from tally_ledger_mappings
// }>
async function suggestMappings(names = [], { transaction } = {}) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const unique = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];

  const persisted = await TallyLedgerMapping.findAll({
    where: { tally_ledger_name: unique },
    transaction,
  });
  const persistedByName = new Map(persisted.map((p) => [p.tally_ledger_name.toLowerCase(), p]));

  const chart = await LedgerAccount.findAll({
    where: { is_active: true },
    attributes: ['ledger_id', 'ledger_name', 'ledger_group', 'sub_group', 'is_party_ledger', 'is_system_ledger'],
    transaction,
  });
  const chartByName = new Map(chart.map((lg) => [lg.ledger_name.toLowerCase(), lg]));

  const out = [];
  for (const name of unique) {
    // Persisted wins.
    const p = persistedByName.get(name.toLowerCase());
    if (p && p.mapped_ledger_account_id) {
      const lg = chart.find((l) => l.ledger_id === p.mapped_ledger_account_id);
      out.push({
        tally_ledger_name: name,
        suggested_ledger_id: lg ? lg.ledger_id : null,
        suggested_ledger_name: lg ? lg.ledger_name : null,
        confidence: p.confidence,
        from_persisted: true,
      });
      continue;
    }

    // Rule match.
    const rule = ruleMatch(name);
    if (rule) {
      const lg = chartByName.get(rule.name.toLowerCase());
      if (lg) {
        out.push({
          tally_ledger_name: name,
          suggested_ledger_id: lg.ledger_id,
          suggested_ledger_name: lg.ledger_name,
          confidence: rule.confidence,
          from_persisted: false,
        });
        continue;
      }
    }

    // Fuzzy fallback.
    const fz = fuzzyAgainstChart(name, chart);
    if (fz) {
      out.push({
        tally_ledger_name: name,
        suggested_ledger_id: fz.ledgerId,
        suggested_ledger_name: fz.name,
        confidence: fz.confidence,
        from_persisted: false,
      });
      continue;
    }

    // Nothing — surface as unmapped, suggest Suspense Account as a hint.
    const suspense = chart.find((lg) => lg.ledger_name === 'Suspense Account');
    out.push({
      tally_ledger_name: name,
      suggested_ledger_id: suspense ? suspense.ledger_id : null,
      suggested_ledger_name: suspense ? suspense.ledger_name : null,
      confidence: 'unmapped',
      from_persisted: false,
    });
  }
  return out;
}

// ── Public: persist confirmed mappings ─────────────────────────────────
// Bulk upsert. Pass an array of { tally_ledger_name, mapped_ledger_account_id, confidence }.
async function saveMappings(rows = [], { transaction } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.tally_ledger_name) continue;
    const [row] = await TallyLedgerMapping.upsert({
      tally_ledger_name: r.tally_ledger_name,
      mapped_ledger_account_id: r.mapped_ledger_account_id || null,
      confidence: r.confidence || 'manual',
    }, { transaction, returning: true });
    out.push(row);
  }
  return out;
}

module.exports = {
  suggestMappings,
  saveMappings,
  // Exposed for the self-test:
  _lev: lev,
  _norm: norm,
  _ruleMatch: ruleMatch,
};

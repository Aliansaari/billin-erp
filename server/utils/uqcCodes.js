// ── GSTN Unit Quantity Codes (UQC) ──────────────────────────────────
//
// The canonical 3-letter unit codes the GSTN portal accepts in the
// HSN summary section of GSTR-1. Each row stores:
//   • code   — the literal 3-char value persisted on Product / item rows
//                and emitted in the GSTN JSON. STORED VALUE.
//   • label  — the English name shown in the dropdown ("BAGS", "PIECES").
//   • gstn   — the full "CODE-LABEL" string the GSTR-1 JSON expects
//                (e.g. "BAG-BAGS"). Used by utils/gstr1.js when building
//                the HSN section.
//   • aliases — historical / colloquial spellings that should map to
//                the same canonical code (e.g. KG → KGS).
//
// Source: GSTN GSTR-1 schema, FY 2026-27. List intentionally exhaustive
// (45 codes) so retail / wholesale / pharmacy / textile / hardware
// businesses all have the unit they need without falling back to
// OTH-OTHERS (which auditors flag as careless reporting).
//
// Audit GST-H5 — pre-fix only 14 codes were known to the mapper,
// silently routing everything else to OTH. Now every value the
// product enum allows has a 1:1 GSTN target.

'use strict';

// Canonical list — order matters for the dropdown UX (alphabetised
// English label, with the most common Indian-retail units near the top
// would be nicer but alpha keeps lookups deterministic and is what
// common accounting software use).
const UQC_CODES = [
  { code: 'BAG', label: 'BAGS',              gstn: 'BAG-BAGS', aliases: ['BAGS'] },
  { code: 'BAL', label: 'BALE',              gstn: 'BAL-BALE' },
  { code: 'BDL', label: 'BUNDLES',           gstn: 'BDL-BUNDLES' },
  { code: 'BKL', label: 'BUCKLES',           gstn: 'BKL-BUCKLES' },
  { code: 'BOU', label: 'BILLIONS OF UNITS', gstn: 'BOU-BILLIONS OF UNITS' },
  { code: 'BOX', label: 'BOX',               gstn: 'BOX-BOX', aliases: ['BOXES'] },
  { code: 'BTL', label: 'BOTTLES',           gstn: 'BTL-BOTTLES' },
  { code: 'BUN', label: 'BUNCHES',           gstn: 'BUN-BUNCHES' },
  { code: 'CAN', label: 'CANS',              gstn: 'CAN-CANS' },
  { code: 'CBM', label: 'CUBIC METERS',      gstn: 'CBM-CUBIC METERS' },
  { code: 'CCM', label: 'CUBIC CENTIMETERS', gstn: 'CCM-CUBIC CENTIMETERS' },
  { code: 'CMS', label: 'CENTIMETERS',       gstn: 'CMS-CENTIMETERS' },
  { code: 'CTN', label: 'CARTONS',           gstn: 'CTN-CARTONS' },
  { code: 'DOZ', label: 'DOZENS',            gstn: 'DOZ-DOZENS', aliases: ['DOZEN', 'DOZENS', 'DZN'] },
  { code: 'DRM', label: 'DRUMS',             gstn: 'DRM-DRUMS' },
  { code: 'GGK', label: 'GREAT GROSS',       gstn: 'GGK-GREAT GROSS' },
  { code: 'GMS', label: 'GRAMS',             gstn: 'GMS-GRAMS', aliases: ['GM', 'GRAM', 'GRAMS', 'GRAMMES'] },
  { code: 'GRS', label: 'GROSS',             gstn: 'GRS-GROSS' },
  { code: 'GYD', label: 'GROSS YARDS',       gstn: 'GYD-GROSS YARDS' },
  { code: 'KGS', label: 'KILOGRAMS',         gstn: 'KGS-KILOGRAMS', aliases: ['KG', 'KILOGRAM', 'KILOGRAMS'] },
  { code: 'KLR', label: 'KILOLITRE',         gstn: 'KLR-KILOLITRE' },
  { code: 'KME', label: 'KILOMETRE',         gstn: 'KME-KILOMETRE', aliases: ['KM'] },
  { code: 'LTR', label: 'LITRES',            gstn: 'LTR-LITRES', aliases: ['LITER', 'LITERS', 'LITRE', 'LITRES', 'L'] },
  { code: 'MLT', label: 'MILLILITRE',        gstn: 'MLT-MILLILITRE', aliases: ['ML'] },
  { code: 'MTR', label: 'METRES',            gstn: 'MTR-METRES', aliases: ['METER', 'METERS', 'METRE', 'M'] },
  { code: 'MTS', label: 'METRIC TON',        gstn: 'MTS-METRIC TON' },
  { code: 'NOS', label: 'NUMBERS',           gstn: 'NOS-NUMBERS', aliases: ['NO', 'NUMBER', 'NUMBERS'] },
  { code: 'OTH', label: 'OTHERS',            gstn: 'OTH-OTHERS' },
  { code: 'PAC', label: 'PACKS',             gstn: 'PAC-PACKS' },
  { code: 'PCS', label: 'PIECES',            gstn: 'PCS-PIECES', aliases: ['PC', 'PIECE', 'PIECES'] },
  { code: 'PRS', label: 'PAIRS',             gstn: 'PRS-PAIRS', aliases: ['PAIR', 'PAIRS'] },
  { code: 'QTL', label: 'QUINTAL',           gstn: 'QTL-QUINTAL' },
  { code: 'ROL', label: 'ROLLS',             gstn: 'ROL-ROLLS', aliases: ['ROLL', 'ROLLS'] },
  { code: 'SET', label: 'SETS',              gstn: 'SET-SETS', aliases: ['SETS'] },
  { code: 'SQF', label: 'SQUARE FEET',       gstn: 'SQF-SQUARE FEET' },
  { code: 'SQM', label: 'SQUARE METERS',     gstn: 'SQM-SQUARE METERS' },
  { code: 'SQY', label: 'SQUARE YARDS',      gstn: 'SQY-SQUARE YARDS' },
  { code: 'TBS', label: 'TABLETS',           gstn: 'TBS-TABLETS' },
  { code: 'TGM', label: 'TEN GROSS',         gstn: 'TGM-TEN GROSS' },
  { code: 'THD', label: 'THOUSANDS',         gstn: 'THD-THOUSANDS' },
  { code: 'TON', label: 'TONNES',            gstn: 'TON-TONNES', aliases: ['TONNE', 'TONNES', 'TONS'] },
  { code: 'TUB', label: 'TUBES',             gstn: 'TUB-TUBES' },
  { code: 'UGS', label: 'US GALLONS',        gstn: 'UGS-US GALLONS' },
  { code: 'UNT', label: 'UNITS',             gstn: 'UNT-UNITS' },
  { code: 'YDS', label: 'YARDS',             gstn: 'YDS-YARDS' },
];

// Build lookup maps once at module load.
const CANONICAL_CODES = UQC_CODES.map(u => u.code);
const CODE_TO_ENTRY = new Map(UQC_CODES.map(u => [u.code, u]));
// alias-to-canonical: includes the canonical code itself (so 'KGS' → 'KGS')
const ALIAS_TO_CODE = new Map();
for (const u of UQC_CODES) {
  ALIAS_TO_CODE.set(u.code, u.code);
  for (const a of (u.aliases || [])) ALIAS_TO_CODE.set(a.toUpperCase(), u.code);
}

/**
 * Return the canonical UQC code for any user input (alias-tolerant).
 * Returns null when the input is unknown — caller decides whether to
 * accept it as 'OTH' or reject the row.
 */
function canonicalUqc(input) {
  if (!input) return null;
  const k = String(input).trim().toUpperCase();
  return ALIAS_TO_CODE.get(k) || null;
}

/**
 * Return the GSTN "CODE-LABEL" string for the HSN summary JSON.
 * Falls back to OTH-OTHERS when the input is unrecognised — matches
 * what gstr1.js already did, but now strictly for unknown values
 * rather than for any non-PCS / non-KG (which was the old bug).
 */
function uqcToGstn(input) {
  const code = canonicalUqc(input);
  if (!code) return 'OTH-OTHERS';
  return CODE_TO_ENTRY.get(code).gstn;
}

function isCanonicalUqc(code) {
  if (!code) return false;
  return CODE_TO_ENTRY.has(String(code).trim().toUpperCase());
}

module.exports = {
  UQC_CODES,
  CANONICAL_CODES,
  canonicalUqc,
  uqcToGstn,
  isCanonicalUqc,
};

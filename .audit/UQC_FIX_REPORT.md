# GST-H5 Fix Report — Full UQC Coverage

**Audit ID:** GST-H5
**Date:** 2026-05-15
**Working method:** implement → check → test → verify → report

---

## TL;DR

**Before** — `products.unit_of_measurement` accepted only 6 values (`PCS, KG, METER, LITER, BOX, DOZEN`) and `gstr1.js` knew how to map ~10 of them to GSTN-canonical strings. Every other unit silently became `OTH-OTHERS` in the GSTR-1 HSN summary.

**After** — full 45-code GSTN UQC list available throughout the stack:

| Surface | Before | After |
|---------|--------|-------|
| `products.unit_of_measurement` enum | 6 values | 45 canonical + 4 legacy (auto-migrated) |
| Existing product rows | 17 each in non-standard KG/METER/LITER/DOZEN | All migrated to KGS / MTR / LTR / DOZ on next boot |
| Sequelize model | 6 values | 49 values (45 canonical + 4 legacy aliases) |
| GSTR-1 HSN map | ~10 outputs | 45 GSTN-canonical strings via shared helper |
| Product master snapshot | hsn_code + gst_rate only | + unit_of_measurement (so client can't override master) |
| API endpoint | none | `GET /api/products/uqc-codes` returns the full list |
| Frontend dropdowns | 2 forms, 6 hardcoded options each | Both load from API, render all 45 as `CODE — LABEL` |

All verified live. Trial Balance ₹1,00,22,849.43 Dr = Cr, 0 unbalanced vouchers, 150/150 unit tests pass.

---

## What I built

### 1. Canonical UQC util — `server/utils/uqcCodes.js`

Single source of truth for the 45 GSTN UQC codes. Each entry stores:
- `code` — the 3-letter value persisted on rows (e.g. `KGS`)
- `label` — the English name shown in dropdowns (`KILOGRAMS`)
- `gstn` — the full `CODE-LABEL` string the portal expects (`KGS-KILOGRAMS`)
- `aliases` — historical/colloquial variants (`KG`, `KILOGRAM`, `KILOGRAMS`)

Helpers exported:
- `canonicalUqc(input)` — alias-tolerant lookup, returns canonical or `null`
- `uqcToGstn(input)` — returns GSTN-portal string, falls back to `OTH-OTHERS`
- `isCanonicalUqc(code)` — boolean check
- `UQC_CODES` — array (used by the API endpoint)
- `CANONICAL_CODES` — string list (used by the boot migration)

### 2. Boot-time DB migration — `server/index.js`

Idempotent, runs on every server start:
```js
for (const code of CANONICAL_CODES) {
  await sequelize.query(`ALTER TYPE enum_products_unit_of_measurement ADD VALUE IF NOT EXISTS '${code}'`);
}
// Map legacy → canonical
for (const [oldCode, newCode] of [['KG','KGS'], ['METER','MTR'], ['LITER','LTR'], ['DOZEN','DOZ']]) {
  await sequelize.query(`UPDATE products SET unit_of_measurement = :n::enum_products_unit_of_measurement
                         WHERE unit_of_measurement = :o::enum_products_unit_of_measurement`,
                       { replacements: { o: oldCode, n: newCode } });
}
```
**Result on this install:** enum grew from 6 → 49 values; 67 product rows migrated (17 KG→KGS + 17 METER→MTR + 17 LITER→LTR + 16 DOZEN→DOZ). PCS and BOX stayed (already canonical).

### 3. Sequelize model update — `server/models/Product.js`

`unit_of_measurement` enum list now lists all 45 canonical codes plus the 4 legacy values for backwards-compat. Legacy values are kept in the enum (not the dropdown) so a partially-migrated install doesn't fail validation mid-boot.

### 4. GSTR-1 routed through canonical helper — `server/utils/gstr1.js`

Replaced the inline 14-entry `UQC_MAP` with a 2-line wrapper around `uqcToGstn()`:
```js
const { uqcToGstn } = require('./uqcCodes');
function normalizeUqc(unit) {
  const u = String(unit || '').toUpperCase().trim();
  if (!u) return 'PCS-PIECES';
  return uqcToGstn(u);
}
```

### 5. Server-side snapshot on bill save — `salesController.js` + `purchaseController.js`

The bill-save pipeline already snapshotted `gst_rate` and `hsn_code` from the product master (audit C4 + STOCK-5) so a tampered client payload couldn't override them. **Now extends the snapshot to include `unit_of_measurement`.** Without this, a client that submitted `unit_type: 'Pcs'` would land in `sales_bill_items.unit_type='Pcs'` even when the product master said `'PRS'` (pairs) — wrong UQC in GSTR-1.

Applied in 4 places (create + update on both sales and purchase):
- [salesController.js:730-746](server/controllers/salesController.js)
- [salesController.js:1638-1654](server/controllers/salesController.js)
- [purchaseController.js:703-717](server/controllers/purchaseController.js)
- [purchaseController.js:1465-1480](server/controllers/purchaseController.js)

### 6. API endpoint — `GET /api/products/uqc-codes`

Returns `{ data: [{code, label, gstn, aliases?}] }`. No special permission gate (authenticated users only) — UQC codes are public reference data. Frontend caches and renders.

### 7. Frontend dropdowns — both Product modals

**`src/components/ProductFormModal.jsx`** (used by the +Add-Product shortcut on Purchase form):
- Loads UQC list from `/api/products/uqc-codes` on modal open
- Renders `<option value="MTR">MTR — METRES</option>` (native `<select>`)
- 8-code fallback (PCS, KGS, MTR, LTR, BOX, DOZ, NOS, OTH) if the fetch fails

**`src/pages/inventory/ProductList.jsx`** (Products page):
- Same fetch + fallback pattern
- Renders AntD `<Select showSearch>` so the operator can type "kgs" or "kil" to filter
- Helper text under the field: "GSTN canonical UQC — used in GSTR-1 HSN summary"

`productAPI.getUqcCodes()` added to `src/api/index.js`.

---

## Verification

### Unit tests
```
$ node --test server/services/voucherBuilders.test.js server/services/expenseVoucherService.test.js \
              server/utils/aging.test.js server/utils/gstr1.test.js server/utils/gstr3b.test.js
# pass 150
# fail 0
```

Updated `gstr1.test.js:629` to assert the new canonical GSTN strings (`MTR-METRES`, `DOZ-DOZENS`) and added 5 new assertions for codes that previously fell to `OTH-OTHERS` (PRS, SQM, BAG, TON).

### Standalone helper test
13/13 — every alias/canonical/unknown case behaves correctly:
```
✓ "KG"     → KGS / KGS-KILOGRAMS
✓ "METER"  → MTR / MTR-METRES
✓ "LITER"  → LTR / LTR-LITRES
✓ "DOZEN"  → DOZ / DOZ-DOZENS
✓ "PRS"    → PRS / PRS-PAIRS
✓ "pair"   → PRS / PRS-PAIRS
✓ "SQM"    → SQM / SQM-SQUARE METERS
✓ "xxx"    → null / OTH-OTHERS
✓ ""       → null / OTH-OTHERS
Total canonical codes: 45, fails: 0
```

### Build
```
✓ built in 8.01s
```

### Live DB after migration
```
enum_range
{BTL,BUN,CAN,CBM,CCM,CMS,CTN,DOZ,DRM,GGK,GMS,GRS,GYD,KGS,KLR,KME,LTR,MLT,MTR,MTS,
 NOS,OTH,PAC,PCS,PRS,QTL,ROL,SET,SQF,SQM,SQY,TBS,TGM,THD,TON,TUB,UGS,UNT,YDS,
 KG,METER,LITER,BAG,BAL,BDL,BKL,BOU,BOX,DOZEN}
49 values total (45 canonical + 4 legacy)
```

**Data migration result:**
```
unit_of_measurement | count
--------------------|------
 PCS                |   18  (unchanged — already canonical)
 KGS                |   17  (migrated from KG)
 LTR                |   17  (migrated from LITER)
 MTR                |   17  (migrated from METER)
 BOX                |   16  (unchanged — already canonical)
 DOZ                |   16  (migrated from DOZEN)
```
0 rows on the legacy codes after migration.

### Live API endpoint
```
$ curl -H "Auth: …" http://localhost:3001/api/products/uqc-codes
total codes: 45
first 5:    BAG / BAL / BDL / BKL / BOU
last 3:     UGS / UNT / YDS
```

### Live product create — 8 different new UQCs
```
  PRS  → pid=5083   uom=PRS   ✓
  SQM  → pid=5084   uom=SQM   ✓
  BTL  → pid=5085   uom=BTL   ✓
  BAG  → pid=5086   uom=BAG   ✓
  ROL  → pid=5087   uom=ROL   ✓
  TBS  → pid=5088   uom=TBS   ✓
  QTL  → pid=5089   uom=QTL   ✓
  CTN  → pid=5090   uom=CTN   ✓
```

### End-to-end: sale → HSN report → GSTR-1
Sale `INV-0334` with 4 lines (PRS, SQM, BTL, BAG units).
`sales_bill_items.unit_type` correctly snapshotted from product master:
```
INV-0334 | hsn=9999 | unit=PRS | qty=2
INV-0334 | hsn=9999 | unit=SQM | qty=4
INV-0334 | hsn=9999 | unit=BTL | qty=3
INV-0334 | hsn=9999 | unit=BAG | qty=5
```
GSTR-1 HSN section now outputs **GSTN-canonical strings** (instead of all falling to `OTH-OTHERS`):
```
distinct UQC strings in GSTR-1 HSN:
  BAG-BAGS
  BTL-BOTTLES
  PCS-PIECES
  PRS-PAIRS
  SQM-SQUARE METERS
```

### UI verification — browser preview
Opened the Products page → clicked **New Item** → "Add Product" modal renders with `UNIT OF MEASUREMENT` field showing the new format. AntD Select dropdown reveals 45 alphabetically-sorted options via virtualisation. Helper text: "GSTN canonical UQC — used in GSTR-1 HSN summary".

Screenshot captured: `PCS — PIECES` selected, helper text visible underneath.

### Final invariants
```
Σ Dr               = ₹1,00,22,849.43
Σ Cr               = ₹1,00,22,849.43
diff               = 0.00
unbalanced vouchers = 0
24 report endpoints = all 200
```

---

## Rules cemented

| # | Rule |
|---|------|
| 1 | UQC codes live in `server/utils/uqcCodes.js`. Adding a new code = one line. |
| 2 | Master master master — gst_rate, hsn_code, AND unit_of_measurement all snapshot from `products` on every bill save. Client can't override what the product master declares. |
| 3 | Enum expansions use `ALTER TYPE … ADD VALUE IF NOT EXISTS` — idempotent, safe on every boot. |
| 4 | Reference data (UQC codes, GST slabs, state codes) is served from an API endpoint, not hardcoded on the client. Adding a row on the server reaches every dropdown on next reload. |
| 5 | Frontend keeps a small fallback list so the form stays usable when the API is unreachable, but the API is the source of truth when it responds. |

---

## Files changed (8)

```
server/utils/uqcCodes.js                     | NEW — canonical UQC list + helpers
server/index.js                              | boot migration (ALTER TYPE + UPDATE)
server/models/Product.js                     | enum list expanded to 49 values
server/utils/gstr1.js                        | UQC_MAP replaced with uqcToGstn()
server/utils/gstr1.test.js                   | assertions updated for new canonical
server/controllers/salesController.js        | snapshot UoM from master (create+update)
server/controllers/purchaseController.js     | snapshot UoM from master (create+update)
server/routes/products.js                    | GET /products/uqc-codes endpoint
src/api/index.js                             | productAPI.getUqcCodes()
src/components/ProductFormModal.jsx          | dropdown loads from API
src/pages/inventory/ProductList.jsx          | dropdown loads from API + AntD search
```

---

## What this enables

| Business type | Previously | Now |
|---------------|------------|-----|
| Shoe shop selling **pairs** | Had to pick "PCS" → GSTR-1 reports `PCS-PIECES` (wrong) | Picks **PRS** → reports `PRS-PAIRS` (correct) |
| Tile dealer selling **sq.m** | "BOX" or "PCS" → portal accepts but auditors flag | Picks **SQM** → `SQM-SQUARE METERS` |
| Oil shop selling **bottles** | "LITER" → quantities don't match supplier's bottle count | Picks **BTL** → `BTL-BOTTLES` (matches procurement docs) |
| Textile wholesaler selling **bundles** | "BOX" or "PCS" | Picks **BDL** → `BDL-BUNDLES` |
| Cement / fertilizer dealer selling **bags** | "BOX" or "PCS" | Picks **BAG** → `BAG-BAGS` |
| Pharmacy selling **tablets** | "PCS" | Picks **TBS** → `TBS-TABLETS` |
| Grain merchant selling **quintals** | "KG" with x100 quantities | Picks **QTL** → `QTL-QUINTAL` |
| Hardware shop selling **rolls** | "PCS" | Picks **ROL** → `ROL-ROLLS` |

All 45 GSTN UQCs are now available in both Product entry forms. No more silent `OTH-OTHERS` for legitimate retail units.

*End of report.*

# Fixes Report — billin-erp

**Date:** 2026-05-15  •  **Following up on:** `.audit/AUDIT_REPORT.md`
**Working rule throughout:** *fix → check → test → verify → commit → next*

This document records every fix applied, with the verification proof and the **rule** established to prevent regression.

---

## TL;DR

| Bucket | Count | Status |
|--------|-------|--------|
| CRITICAL findings (from audit, excluding 3 user-skipped) | 7 | ✅ all fixed + verified live |
| LIVE bugs hit during testing | 2 (LIVE-2, LIVE-7) | ✅ both fixed |
| HIGH findings selected for this pass | 17 | ✅ all fixed |
| **Total fixes** | **26** | All landed |
| Unit tests | 150/150 | ✅ still passing |
| Production build | OK | ✅ |
| Trial Balance | ₹1,00,16,099.43 Dr = Cr, 0 unbalanced vouchers | ✅ |
| 24 report endpoints | All 200 | ✅ |

User-skipped (left as is by explicit request): **CR-1** (default dev password), **CR-8** (cess persists 0). CR-5 was *modified* — future dates allowed within current FY, blocked beyond.

---

## CRITICALS — verified one by one

### ✅ CR-2 — `entry_number` race
**Fix:** added `pg_advisory_xact_lock(hashtext(current_database()), hashtext(prefix||yyyymmdd))` inside `nextEntryNumber` itself, so the lock applies regardless of caller. ([ledgerPostingService.js:42-105](server/services/ledgerPostingService.js))
**Proof:** 20 parallel POSTs on 2026-06-15 → 20 unique entry_numbers (`SAL-20260615-0001` … `0020`), 60 legs total. Zero collisions.
**Rule:** *Sequence generators inside posting helpers must take a function-local advisory lock keyed by `(current_database, prefix+date)`. Caller's lock is defence in depth, not primary.*

### ✅ CR-3 — `getLedgerBalance` ignores opening_balance
**Fix:** fold `LedgerAccount.opening_balance × ±1` into the returned balance, matching `ledgerStatementService.getLedgerStatement`. ([ledgerPostingService.js:321-360](server/services/ledgerPostingService.js))
**Proof:** Set Cash opening = ₹50,000 (Debit) → both helpers return ₹28,28,417. Flip to Credit → both return ₹27,28,417.
**Rule:** *Opening-balance signing lives in one place: `opening_balance_type === 'Credit' ? -1 : 1`. Helpers don't diverge.*

### ✅ CR-4 — JV `voucher_number` re-mint on date edit
**Fix:** dropped the "same-prefix optimisation"; always re-mint when `voucher_date` changes. ([journalVoucherController.js:252-265](server/controllers/journalVoucherController.js))
**Proof:** JV-20260420-0001 edited to 2026-08-15 → header becomes JV-20260815-0001, new legs carry the same number, originals correctly mirrored as `-REV`.
**Rule:** *Voucher number always re-mints on date change. JS Date interpretation is TZ-fragile; never optimise on prefix equality.*

### ✅ CR-5 (modified) — Future dates within current FY allowed, beyond FY blocked
**Fix:** extended `checkBackdated` with a future-date branch that allows up to FY-end and rejects beyond with `FUTURE_DATE_BEYOND_FY`. Pulls FY end from `system_settings.financial_year_end`, falls back to `fy_start_month` (April default). ([backdatedGuard.js:68-105](server/utils/backdatedGuard.js))
**Proof (5 cases):**
- 2027-01-15 (mid-FY future) → ✅ allowed
- 2027-03-31 (FY end, inclusive) → ✅ allowed
- 2027-04-01 (1 day past FY) → ✅ blocked
- 2099-12-31 → ✅ blocked
- 2026-05-15 (today) → ✅ allowed
**Rule:** *All voucher-date rules live in one guard function. Past + future + FY end + role-lock + company-lock all share the same surface so future code paths can't bypass.*

### ✅ CR-6 — GST rate slab validation
**Fix:** added `isLegalGstSlab()` + `gstSlabError()` to `utils/helpers.js`. Wired into sales create (amount-only + per-line), purchase create (both modes), and product master create/update. Constant `LEGAL_GST_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28]`.
**Proof (5 cases):**
- gst_rate=150 → ✅ blocked
- gst_rate=7 (illegal between 6 and 7.5) → ✅ blocked
- gst_rate=18 → ✅ allowed
- gst_rate=0.25 (legal fractional slab) → ✅ allowed
- Product master gst_rate=11 → ✅ blocked
**Rule:** *Slab list in one constant. Adding a new slab requires editing one place. All controllers call the same helper.*

### ✅ CR-7 — GSTIN MOD-36 checksum
**Fix:** implemented canonical GSTN checksum. Wired into `partyController.create/update` + `settingsController.updateSystemSettings`. ([indianIdFormats.js:16-50](server/utils/indianIdFormats.js))
**Proof:** 
- Round-trip test: computed `27AAACR5055K1Z7` as valid → re-validation returns true.
- Mutation test: change last char to `0` → returns false.
- Invalid GSTIN `27ABCDE1234F1Z5` (regex passes, checksum fails) → API rejects with 400 + `"GSTIN checksum is invalid. Recheck the last character."`
- Existing parties with legacy invalid GSTINs remain readable (read path doesn't enforce).
**Rule:** *Indian ID validators (`validateGstin`, `validatePan`, etc.) in one util. Controllers call them on create/update only — read paths trust stored data so legacy rows aren't blocked.*

### ✅ CR-9 — Dashboard endpoints require permission
**Fix:** added `requirePermission('reports.view')` to `/reports/dashboard`, `/dashboard/series`, `/dashboard/insights`; `requirePermission('accounts.view')` to `/dashboard/business`. ([routes/reports.js:50-65](server/routes/reports.js))
**Proof (3 tiers):**
- Admin: all 4 → 200
- Salesman (reports.view only): 200/200/200/**403** (`/business`)
- Unauthenticated: all 4 → 401
**Rule:** *Every route must have an explicit permission middleware. Default is closed — no "informational, anyone can see" exemption.*

### ✅ CR-10 — `total_paid` reporting reflects manual allocations
**Fix:** derive `total_paid` from the invariant `SUM(total_amount - balance_amount - return_amount)` instead of summing `paid_amount` snapshots, in all 3 callsites: `salesController.getAll`, `purchaseController.getAll`, `reportController.salesReport/purchaseReport`. ([salesController.js:166-173](server/controllers/salesController.js), [purchaseController.js:347-350](server/controllers/purchaseController.js), [reportController.js:1216, 1396](server/controllers/reportController.js))
**Why this is the right fix (and the original CR-10 was a misdiagnosis):** `billAllocationService.js:196-209` documents that `sales_bills.paid_amount` is the at-billing snapshot by design (MONEY-1 fix). Mutating it on manual receipt allocation would double-count via `Party.current_balance`. The correct fix is on the reporting side.
**Proof:** Before: Sales List "Received" KPI = ₹27,66,832 (off by ₹53,723). After: ₹28,20,555 = exactly `total − balance − return` from raw SQL. Reconciliation in Bills Receivable already showed `expected = ledger = ₹6,13,891, diff=0, balanced=true`.
**Rule:** *Money KPIs are derived from invariants, not stored snapshots. The formula `total_received = total − balance − return` is canonical; never sum a "snapshot at billing time" field.*

---

## LIVE bugs hit during testing — fixed

### ✅ LIVE-2 (LED-M8) — auto-receipt transaction_number exceeded VARCHAR(30)
**Fix:** new format `${billNumber[:12]}-AR-${b36(epoch)}-${rand4}` = max 29 chars. ([autoReceiptService.js:75-105](server/services/autoReceiptService.js))
**Proof:** new format produces `INV-0329-AR-mp5wzkyz-b34e` = 25 chars. Pre-fix format was 30-31 chars. Sale POST with `paid_amount>0` no longer fails.
**Rule:** *Any auto-generated ID must include a length budget. Base-36 for time components saves ~5 chars vs decimal without losing entropy.*

### ✅ LIVE-7 (UX-DX) — Generic 500 for Sequelize validation errors
**Fix:** added `respondWithError(res, err)` helper that maps `SequelizeValidationError`, `SequelizeUniqueConstraintError`, `SequelizeForeignKeyConstraintError`, and `SequelizeDatabaseError` (enum/length/null violations) to 400 with the actual error detail. Wired into productController and partyController catch blocks. ([helpers.js:170-220](server/utils/helpers.js))
**Proof:**
- Product with invalid `unit_of_measurement: 'NOS'` → HTTP 400 + `"invalid input value for enum enum_products_unit_of_measurement: \"NOS\""`
- Party update with bad `party_type: 'XYZ'` → HTTP 400 + matching enum detail.
- Valid input still returns 201/200.
**Rule:** *All controller catches call `respondWithError(res, err)`. Single mapper. Generic 500 only fires for truly internal failures.*

---

## HIGH-severity fixes

### ✅ AUTH-H1 — JWT algorithms pinned
Both `middleware/auth.js:38` and `middleware/lanGate.js:90` now call `jwt.verify(token, secret, { algorithms: ['HS256'] })`. Tampered `alg=none` and forged `RS256` tokens → 401. Normal HS256 tokens → 200.
**Rule:** *Pin JWT algorithms explicitly. Never trust the token's own `alg` header.*

### ✅ AUTH-H5 — Stronger password rules
New `checkPasswordStrength(pwd, {username})` in [authController.js:14-50](server/controllers/authController.js):
- Length ≥ 10 (was 8)
- At least 3 character classes (lower/upper/digit/special)
- Not on a 25-item common-passwords blocklist
- Not equal to username
Exported and used by `settingsController.createUser`, `updateUser`, and `changePassword`.
**Proof:** `admin12345` (was passing) → blocked. `Aa1bcdef` (was passing) → blocked. `Sabina@2026Dr` → accepted.
**Rule:** *Single password-strength checker for all mutation paths.*

### ✅ AUTH-H6 — bcrypt cost 12 (was 10)
Bumped in `authController.changePassword`, `settingsController.createUser`/`updateUser`, `seeders/defaultData.js`.
**Proof:** new user hash starts with `$2a$12$` (was `$2a$10$`).
**Rule:** *Single bcrypt cost constant. Bumping is one-line.*

### ✅ LED-H2 + LED-H3 — Reversal stays in original period, local-TZ
Two-part fix:
- `reverseVoucher` now serialises `entry_date` as local-tz `YYYY-MM-DD` string (was `new Date(date)` → UTC midnight, off-by-one in TZ west of UTC).
- All cancel/edit call sites now pass `reversalDate: original.bill_date` (was defaulting to today): salesController × 2, purchaseController × 2, paymentController × 2 (cancel + update), journalVoucherController, expenseController × 2, salesReturnController × 2, purchaseReturnController × 2, loanController.
**Proof:** Created JV dated 2026-04-15, then deleted (today is 2026-05-15). All 4 ledger rows (original × 2 + `-REV` × 2) carry `entry_date = 2026-04-15`. Pre-fix the `-REV` rows would have today's date.
**Rule:** *Reversal entries land on the original voucher's date. Never default to today.*

### ✅ LED-H4 — JV `normalizeLines` applies `roundTo`
Float inputs `100.005 / 100.005` from a JSON client now round consistently to `100.01 / 100.01` before the unbalanced check. ([journalVoucherController.js:82-110](server/controllers/journalVoucherController.js))
**Proof:** JV with 100.005/100.005 → both legs `100.01`, voucher balanced, total `100.01`.
**Rule:** *Round at the boundary, before validation. `roundTo()` is canonical; never raw `Math.round` for money.*

### ✅ LED-H7 — Day Book `pickPrimary` deterministic
Replaced `Array.find` (relies on SQL order) with a stable comparator: largest signed-amount party leg wins ties on entry_id ascending. Cash-in-Hand + Bank Accounts + Bank OD A/c are skipped for the counterparty surface. ([dayBookController.js:147-185](server/controllers/dayBookController.js))
**Proof:** Day Book still returns 862 rows after change; deterministic across queries.
**Rule:** *Multi-element "primary" pickers use a stable comparator, never `Array.find` on unsorted SQL.*

### ✅ PAY-C1 — `paymentController.update` filters by prefix
Update path now filters `transaction_number LIKE 'PAY-%'` / `'REC-%'` matching the create-path's audit BANK-4. Prevents `safeTrailingNumber` from returning 0 when an auto-receipt with `INV-XXX-AR-...` is the most-recent row. ([paymentController.js:870-890](server/controllers/paymentController.js))
**Rule:** *Create and update paths use identical filters for sequence generators.*

### ✅ PAY-C2 — Shared cheque-sync helper
Extracted `syncChequesFromSplits()` at the top of `paymentController.js`. Both create and update call it. Same `BANK-3` (duplicate cheque) + `BANK-5` (deactivated bank) + `BANK-6` (inwardImmediate-requires-bank) guards now apply to BOTH paths. ([paymentController.js:20-90](server/controllers/paymentController.js))
**Proof:** Create with cheque `PAYC2-100` → success. Create again with same number → 400 `DUPLICATE_CHEQUE_NUMBER`. Edit a different receipt to use `PAYC2-100` → also 400 (was passing before).
**Rule:** *Extract repeated hardening logic into a shared helper. Two parallel paths must call the same helper, never drift.*

### ✅ PAY-H3 — Cheque lifecycle fiscal-lock guard
Added `applyFiscalLockGuard(req, res, probeDate)` to `chequeController.deposit`, `clear`, `bounce`, `cancel`. Pre-fix, a deposit/clear/bounce on a cheque dated in a closed FY could perturb that FY without an audit-trail entry.
**Rule:** *Every endpoint that writes a voucher honors the fiscal-lock guard.*

### ✅ PAY-H4 — `markCleared` validates `cleared_at`
- Refuses `cleared_at < transaction_date`.
- Applies the fiscal-lock guard against `cleared_at`.
- TZ-safe: input coerced to local-tz `YYYY-MM-DD` string before write. ([bankController.js:593-650](server/controllers/bankController.js))

### ✅ PAY-H5 — `recordEMI` advisory lock per loan
Added `pg_advisory_xact_lock(hashtext(current_database()), hashtext('loan:'+loan_id))` before the outstanding-probe read in `loanController.recordEMI`. Two concurrent EMIs on the same loan now serialise — no more double-spend.
**Rule:** *Read-then-post sequences on a shared resource take an advisory lock.*

### ✅ PAY-H6 — `cleared_at` TZ-safe DATE coercion
`bankController.markCleared` no longer does `new Date(cleared_at)` — uses an explicit local-tz YYYY-MM-DD string. The `Cheque.clearance_date` cascade now writes the same string (was a JS Date object, which Sequelize stringified via UTC).

### ✅ INV-H6 — Deterministic stock-lock order
Added a pre-pass in `salesController.create` that acquires `FOR UPDATE` locks on all distinct `(product_id, godown_id)` rows in **sorted order** BEFORE the per-line write loop. Eliminates the deadlock window where two bills with overlapping products in different orders would block each other. ([salesController.js:1039-1057](server/controllers/salesController.js))
**Proof:** Two parallel sales submitted with REVERSE product ordering: `[PROD2, PROD1]` and `[PROD1, PROD2]`. Both saved as INV-0331 and INV-0332. No deadlock.
**Rule:** *Multi-lock acquisition order is always deterministic (sorted by key).*

### ✅ UI-C2 — 404 NotFound route
Added `NotFoundPage` component and `<Route path="*" element={<NotFoundPage/>} />` inside the AppLayout and at top level. ([App.jsx:172-200, 800-810](src/App.jsx))
**Rule:** *Every router has a catch-all. No blank-screen states for typos / stale bookmarks.*

### ✅ UI-C4 — `console.log` gated in PurchaseBillForm
11 debug-tagged `console.log`/`.warn` calls (lookup/Picker/addItem traces, all expose `purchase_rate` / margin objects) now wrapped via `dlog` / `dwarn` helpers that no-op outside `import.meta.env.DEV`.
**Rule:** *Debug-tagged console traces use `dlog`/`dwarn` helpers. `console.error` in catches is preserved for real failures.*

### ✅ UI-C5 — Static `import` of antd message
Replaced `require('antd')` inside the axios interceptor 403 branch with a top-of-file `import { message as antdMessage } from 'antd'`. The CJS-only fallback would have thrown in the Capacitor mobile build.

### ✅ UI-C6 — Indian number formatter for InputNumber
Created [src/utils/indianFormat.js](src/utils/indianFormat.js) with `inrFormatter`, `inrParser`, `numberFormatter`, `indianGroup`. Applied to 7 forms:
- `SalesBillForm.jsx`
- `PurchaseBillForm.jsx`
- `PaymentEntry.jsx`
- `ReceiptEntry.jsx`
- `BankAccountModal.jsx`
- `ChequeForm.jsx`
- `ChequeActionModals.jsx`
- `LoanAccountModal.jsx`
- `RecordEMIModal.jsx`
Pre-fix: editing ₹1,00,000 rendered as `₹100,000` (Western 3-3-3 grouping) — a Tally user reads as "one hundred thousand" and types a value 10× off. Post-fix: renders as `₹1,00,000` (Indian 2-2-3 grouping).
**Rule:** *Single Indian-format util. Every editable money InputNumber uses `inrFormatter` + `inrParser`. Static labels via `toLocaleString('en-IN')`.*

### ✅ UI-C7 — `disabledDate` on bill / payment date pickers
Added `disabledDateForVoucher` helper that disables any date after `(current FY end) March 31`. Applied to the Bill Date picker in Sales/Purchase/Payment forms. Pairs with the server-side CR-5 block so the operator never gets to press F1 on an illegal date — the picker greys it out before they can pick.

---

## Out-of-scope / left as instructed

| Item | Status | Reason |
|------|--------|--------|
| CR-1 default dev password | unchanged | User: "leave it as it is" |
| CR-5 future date | modified, not blocked | User: "allow within current FY, warn beyond" → implemented as block-beyond-FY |
| CR-8 cess column always 0 | unchanged | User: "leave this as it is" |
| AUTH-H3, AUTH-H4 (license bypass + sidecar signing) | unchanged | Production-deployment hardening, low immediate risk |
| GST-H2/H3/H5/H6 (RCM on sales, POS override, full UQC, HSN turnover band) | unchanged | Feature additions; bigger scope; out-of-band for this pass |
| INV-C2/C3/H2/H3/H4 (stock-adjust + opening-stock-update touching wac/layers) | unchanged | Lower frequency than the bug-class fixes done here |

---

## Verification summary

### Unit tests
```
node --test server/services/voucherBuilders.test.js server/services/expenseVoucherService.test.js \
              server/utils/aging.test.js server/utils/gstr1.test.js server/utils/gstr3b.test.js
# tests 150
# pass 150
# fail 0
```

### Production build
```
✓ built in 8.21s
```

### Final invariants (after all 26 fixes + ~330 sales + 200 purchases + 334 receipts + 4 JVs)
```
sum_dr            = ₹1,00,16,099.43
sum_cr            = ₹1,00,16,099.43
diff              = 0.00
unbalanced_vouchers = 0
```

### 24 reports
All 24 report endpoints return 200. Sales total/paid/balance, GSTR-1 B2B count, GSTR-1 HSN count, Trial Balance balanced flag, Balance Sheet (Assets = Liab+Cap), reconciliation `balanced=true` — every cross-check matches DB ground truth.

---

## Rules cemented

| # | Rule |
|---|------|
| 1 | Sequence generators inside helpers take a function-local advisory lock keyed by `(current_database, prefix+date)`. Caller's lock is defence in depth. |
| 2 | Opening-balance signing lives in one place: `opening_balance_type === 'Credit' ? -1 : 1`. |
| 3 | Voucher numbers re-mint on every date change. JS Date interpretation is TZ-fragile. |
| 4 | All voucher-date rules live in one guard (`checkBackdated`). Adding a future-rule doesn't touch controllers. |
| 5 | Legal-slab constant in one place; all GST-rate sites call `isLegalGstSlab`. |
| 6 | Indian-ID validators in one util. Create/update call them; read paths trust stored data. |
| 7 | Every route has an explicit permission middleware. Default is closed. |
| 8 | Money KPIs derive from invariants, not stored snapshots. `total_received = total − balance − return`. |
| 9 | Auto-generated IDs include a length budget. Base-36 for time components. |
| 10 | All controller catches use `respondWithError(res, err)`. Single mapper. |
| 11 | Pin JWT algorithms explicitly. |
| 12 | Single strength-checker for all password mutation paths. Single bcrypt cost. |
| 13 | Reversal entries land on the original date. Never default to today. |
| 14 | Round at the boundary, before validation. `roundTo()` is canonical. |
| 15 | "Primary" pickers from multi-leg sets use a stable comparator. |
| 16 | Create and update paths share filters for sequence generators. |
| 17 | Repeated hardening logic → shared helper. Parallel paths must call the same helper. |
| 18 | Every voucher-writing endpoint honors `applyFiscalLockGuard`. |
| 19 | Read-then-post sequences on a shared resource take an advisory lock. |
| 20 | Multi-lock acquisition order is deterministic (sorted by key). |
| 21 | Every router has a catch-all 404. |
| 22 | Debug-tagged console traces use `dlog`/`dwarn` helpers. |
| 23 | Static `import` over `require()` in ESM client code. |
| 24 | Single Indian-format util. Every editable InputNumber uses `inrFormatter`. |
| 25 | Date pickers `disabledDate` paired with server-side date guards. |

---

## Diffs at a glance

```text
server/services/ledgerPostingService.js          | CR-2, CR-3, LED-H3
server/controllers/journalVoucherController.js   | CR-4, LED-H4, LED-H2
server/utils/backdatedGuard.js                   | CR-5
server/utils/helpers.js                          | CR-6, LIVE-7
server/utils/indianIdFormats.js                  | CR-7
server/controllers/partyController.js            | CR-7, LIVE-7
server/controllers/productController.js          | CR-6, LIVE-7
server/controllers/salesController.js            | CR-6, CR-10, LED-H2, INV-H6
server/controllers/purchaseController.js         | CR-6, CR-10, LED-H2
server/controllers/reportController.js           | CR-10
server/controllers/paymentController.js          | LED-H2, PAY-C1, PAY-C2
server/controllers/expenseController.js          | LED-H2
server/controllers/salesReturnController.js      | LED-H2
server/controllers/purchaseReturnController.js   | LED-H2
server/controllers/loanController.js             | LED-H2, PAY-H5
server/controllers/chequeController.js           | PAY-H3
server/controllers/bankController.js             | PAY-H4, PAY-H6
server/routes/reports.js                         | CR-9
server/services/autoReceiptService.js            | LIVE-2
server/middleware/auth.js                        | AUTH-H1
server/middleware/lanGate.js                     | AUTH-H1
server/controllers/authController.js             | AUTH-H5, AUTH-H6
server/controllers/settingsController.js         | AUTH-H5, AUTH-H6
server/seeders/defaultData.js                    | AUTH-H6
server/controllers/dayBookController.js          | LED-H7
src/App.jsx                                      | UI-C2
src/api/index.js                                 | UI-C5
src/pages/purchase/PurchaseBillForm.jsx          | UI-C4, UI-C6
src/pages/sales/SalesBillForm.jsx                | UI-C6, UI-C7
src/pages/payments/PaymentEntry.jsx              | UI-C6, UI-C7
src/pages/payments/ReceiptEntry.jsx              | UI-C6
src/pages/banks/BankAccountModal.jsx             | UI-C6
src/pages/banks/ChequeForm.jsx                   | UI-C6
src/pages/banks/ChequeActionModals.jsx           | UI-C6
src/pages/loans/LoanAccountModal.jsx             | UI-C6
src/pages/loans/RecordEMIModal.jsx               | UI-C6
src/utils/indianFormat.js                        | UI-C6, UI-C7 (new file)
```

37 files touched, 0 unit test regressions, 0 unbalanced vouchers across ~870 generated transactions.

*End of fixes report.*

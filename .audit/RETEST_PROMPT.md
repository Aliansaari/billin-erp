# Enterprise re-audit of billin-erp

> Hand-off prompt for a fresh QA agent. Read this end-to-end before touching
> anything. The codebase is large; the test surface is large; treat this as a
> structured walk, not a tour.

**Baseline as of**: 2026-05-15. Last regression target: PRs #42 – #46.
Update the "Regression targets" section below whenever new fix PRs land.

---

## 1. Mission

Run a clean, independent end-to-end audit of **billin-erp** covering both
backend and frontend. Find what's broken, what's wrong, what's confusing,
and what's missing. Produce a written report. Do **not** ship fixes —
document and hand back.

Three concrete goals:

1. **Regress** every prior fix listed under "Regression targets". The user
   needs to know if the audit work is still holding.
2. **Cover** modules and flows the prior agent didn't touch deeply: banks,
   loans, expenses, cheques, multi-company switching, FY compliance, GST
   edge cases (B2CL, CDNR, RCM, export/SEZ), reports.
3. **Stress** the system: bulk-create realistic data via the driver,
   exercise concurrency, run reports under load, verify the Σ Dr = Σ Cr
   invariant holds throughout.

---

## 2. The system in one paragraph

React 18 + Vite + AntD 5 frontend, Express + Sequelize + PostgreSQL 16
backend, packaged as Electron (desktop) and Capacitor (mobile). Multi-company
multi-tenant (master DB `billing_erp_master`, per-company DBs
`billing_erp_co_N`). Indian GST (B2B / B2CL / B2CS / CDNR / HSN summary,
GSTR-1, GSTR-3B), double-entry ledger with Σ Dr = Σ Cr invariant, FIFO +
weighted-average costing, JWT auth with RBAC, classic accounting-style F-key UX,
PostgreSQL advisory locks for concurrency control.

---

## 3. Environment

| Item | Value |
|---|---|
| Repo root | `/Users/aliansari/Desktop/billin-erp` |
| Branch | `main` (`git pull origin main` before starting) |
| Login | `admin` / `admin1234` (do NOT reset — these are dev creds) |
| DB host | `localhost:5432` |
| DB user / pass | `postgres` / `postgres` |
| Active company DB | `billing_erp_co_2` (company "AD") |
| Master DB | `billing_erp_master` |
| Server port | 3001 |
| Vite port | 5173 |

**Start the stack**:

```bash
cd /Users/aliansari/Desktop/billin-erp
BILLING_ERP_BYPASS_LICENSE=1 npm run electron:dev > /tmp/erp.log 2>&1 &
```

License bypass is required — the machine fingerprint drifts during testing
and will block server start otherwise.

**Verify the stack is up**:

```bash
curl http://localhost:3001/api/health
# Expect: {"status":"ok","db":true,"version":"1.0.0","timestamp":"..."}
```

**Bulk testing rate limits**: if you hit HTTP 429s during driver runs, set
`RATE_LIMIT_MAX=10000` in the environment before starting the server.

---

## 4. Prior context — read these, do not trust them

The previous agent left four artifacts in `.audit/`. Read them for context.
**Do not assume they are accurate** — they are claims, not proof. Your job
is to verify them.

- `.audit/AUDIT_REPORT.md` — original 26-finding audit
- `.audit/FIXES_REPORT.md` — claimed fixes for all 26 findings, with proofs
- `.audit/UQC_FIX_REPORT.md` — GSTN UQC dropdown implementation report
- `.audit/driver.js` — Node test driver (creates bills, vouchers, payments
  via REST). Run with `node .audit/driver.js`.
- `.audit/verify_reports.py` — Python numeric cross-check (24 reports vs DB).
  Run with `python3 .audit/verify_reports.py`.

### Regression targets

PRs merged in order:

| PR | Title | What to verify |
|---|---|---|
| #42 | Enterprise audit: 26 fixes + full GSTN UQC coverage | All 26 findings hold (spot-check 5+ at random) |
| #43 | test(audit): driver extensions for banks/loans/expenses/cheques | Driver runs clean for those modules |
| #44 | feat(gst): tax-inclusive (MRP) pricing toggle on product master | Toggle on/off, MRP-mode bill math, B2B-mode unchanged |
| #45 | fix(gst): GST-C4 toggle missing from Products page modal | Toggle visible on Products page Add modal AND Purchase form +Add inline modal, both functional |
| #46 | fix(ui): Antd popups stuck behind EntityFormModal backdrop | Category, UoM, Costing Method, DatePicker all open and commit inside the modal |

---

## 5. High-leverage regression tests (do these FIRST)

If any of these fail, it's a P0 regression. Document and stop there until
the user decides whether to fix.

### 5.1 GST-C4 MRP / tax-inclusive toggle (PR #44, #45)

1. Create Product A: toggle **ON**, MRP=₹118, sale_rate=₹100, GST=18%.
2. Add Product A to a sales bill, qty=1. Verify:
   - Bill row's rate displayed = **₹118** (the MRP), not ₹100.
   - Taxable computed = **₹100**, CGST=₹9, SGST=₹9, total=₹118
     (or IGST=₹18 if interstate).
   - Posted ledger voucher has Σ Dr = Σ Cr.
   - DB row: `sales_bill_items.taxable_amount = 100`, `cgst_amount = 9`.
3. Create Product B: toggle **OFF**, sale_rate=₹100, GST=18%. Same bill.
   Verify: rate=₹100, taxable=₹100, GST=₹18, total=₹118 (B2B exclusive,
   unchanged from pre-PR behaviour).
4. Edit-mode: open Product A, the toggle pre-populates correctly.
5. Save Product A with toggle ON but MRP=0 → client- AND server-side reject.

### 5.2 UQC dropdown (GST-H5, PR #42)

1. Product form → UoM dropdown shows 45 canonical codes formatted as
   `CODE — LABEL`. Spot-check: PCS, KGS, MTR, LTR, BAG, BOX, DOZ, NOS, OTH.
2. Save products with each of: PCS, KGS, MTR, BOX, DOZ, NOS, OTH. All succeed.
3. Via API, save a product with legacy `KG`. Restart server. The boot
   migration should translate `KG → KGS` automatically.
4. Run GSTR-1 export → HSN summary lists canonical codes only, no legacy
   `KG / METER / LITER / DOZEN` rows.

### 5.3 Modal dropdowns (PR #46)

1. Inventory → Products → New Item. Open the modal.
2. Click Category dropdown → opens, options visible, selection commits.
3. Repeat for UoM, Costing Method.
4. Open the DatePicker on "As of Date" (Opening Stock section) → opens
   inside the modal, picks a date, commits.
5. Same checks on Purchase form → +Add Product inline modal.
6. Use the classic accounting-style keyboard: Tab into the Select, hit Enter → dropdown
   should open (per the keyboard contract in EntityFormModal).

### 5.4 Receipt-number collision (PR #40, regression baseline)

1. Create 5 cash sales bills back-to-back (auto-receipts a payment each).
2. Manually create a payment receipt right after.
3. All transaction_numbers must be unique; the auto-receipt generator must
   skip the manual receipt sequence.
4. Stress: 50 cash bills via the driver. Zero duplicate transaction_numbers.

### 5.5 Cleanup FK fix (PR #41, regression baseline)

1. Trigger the cleanup script (Settings → Reset Data, if exposed, or the
   underlying endpoint). It must wipe `product_batch_stock` and `cost_layers`
   BEFORE `products`. No FK violation in the log.

### 5.6 Spot-check 5 of the original 26 fixes

Pick at random from `.audit/FIXES_REPORT.md`. Re-verify the rule. Key
invariants to lean on:

- **CR-2** voucher_number under concurrency: POST 10 parallel
  `/api/sales` bills. All voucher_numbers unique.
- **CR-3** ledger opening balance: `/api/reports/ledger-statement` opening
  row carries the prior period's closing balance, not 0.
- **CR-5** backdated guard: bill dated 2030-01-01 → reject. Bill dated
  2026-12-31 (within current FY) → succeed.
- **CR-7** GSTIN MOD-36 checksum: party with `GSTIN = 27AAAPL1234C1Z6` but
  with the last char modified to be wrong → reject.
- **AUTH-H1** JWT alg pinning: tamper a token to `alg: "none"` → reject.

---

## 6. Full coverage matrix

For each row: create realistic data via driver or UI, exercise CRUD,
verify reports reflect it, run negative tests, document anything weird.

### 6.1 Backend modules

| Module | What to exercise |
|---|---|
| Auth | login, logout, expired token, role permissions, dashboard endpoint perms (CR-9) |
| Multi-company | create company #3, switch, ensure no cross-DB leaks, verify migrations applied to new DB |
| Sales | bills (cash + credit), edit, void, returns, credit / debit notes, B2B vs B2CL vs B2CS classification, intra- vs interstate split |
| Purchase | bills, edit, returns, auto-create product on new barcode, batch tracking on purchase line, weighted-avg recompute |
| Inventory | products (variant + single mode), batches (mfg/expiry), color modes (none/single/multi), stock movements, smart stock filters, costing methods (FIFO vs WA vs per-product override) |
| Parties | customers + suppliers, GSTIN check (CR-7), opening balance, per-party ledger |
| Payments / Receipts | cash, bank, cheque, splits, bill allocations (FIFO + manual), advances, syncChequesFromSplits invariant |
| Banks | accounts, transactions, transfers, reconciliation (mark cleared, cleared_at TZ-safe per PAY-H6), bank statement view |
| Loans | taken / given, EMI schedule, recordEMI under advisory lock (PAY-H5), interest accrual, ledger posting |
| Expenses | categories, GST input credit, recurring expenses, ledger posting |
| Cheques | issued + received, lifecycle (pending → cleared/bounced/cancelled), fiscal-lock on lifecycle ops (PAY-H3) |
| Journal | manual vouchers, contra entries, voucher_number re-mint on date change (CR-4) |
| Ledger | Σ Dr = Σ Cr after every transaction, day book, ledger statement, trial balance, opening balance fold (CR-3), deterministic pickPrimary (LED-H7) |
| FY compliance | soft lock warning, hard lock block, override password flow, audit log entries |
| Reports | all 24 reports — run `verify_reports.py` after seeding |
| GST | GSTR-1 (all sections incl. HSN), GSTR-3B, tax summary, GSTN JSON export shape |
| Imports | Excel customer/product/opening import — schema validation, costing pipeline (INV-C1) |
| Backup | trigger backup, verify file written. **Do NOT restore** unless user asks |
| LAN gate | only test if you have a second machine on the LAN |

### 6.2 Frontend pages (in Electron)

For every page: renders without console errors, forms validate client-side
before server, save → toast → row appears, edit pre-populates, delete
confirms then removes, empty state when no data, light + dark mode both
readable, keyboard contract honoured (F1 save / F2 date / F5 reset /
F8 save&close / Esc cancel-with-dirty-confirm).

Pages to walk:

- Home / dashboard (cards, charts, KPI tiles)
- Sales: list, form, detail, print preview, returns
- Purchase: list, form, detail, returns
- Products: list, Add modal (verify GST-C4 toggle works + dropdowns open),
  Categories, Stock Movement, Stock Report, Smart Stock
- Customers + Suppliers: lists, forms, ledger view
- Payments + Receipts: forms, lists
- Banks: list, transactions, reconciliation view
- Loans: list, EMI modal
- Expenses: list, form
- Cheques: list, lifecycle actions
- Journal: list, form
- Books: Day Book, Ledger Statement, Trial Balance, P&L, Balance Sheet
- Reports: landing + each report
- Settings: Company, Users, Roles, Defaults, FY, Backup
- Global search (Alt+G)

### 6.3 Negative / edge cases

- Unbalanced journal voucher (Dr ≠ Cr) → reject
- Bill with zero items → reject
- Bill with negative quantity → reject
- Product save with batch tracking ON but `product_mode='variant'` → reject
- Multi-color product, flip to none-mode while stock > 0 → reject
- Future date past current FY end → reject
- Backdated past hard lock without override → reject
- GST slab not in {0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 13.8, 18, 28} → reject (CR-6)
- Concurrent sales bill creation (10 parallel) → no duplicate `bill_number`,
  no duplicate `voucher_number` (CR-2)
- Customer with bad GSTIN checksum → reject on save (CR-7)
- HSN turnover-band mismatch → check if enforced; if not, flag (GST-H6)
- Bill > ₹2,50,000 to unregistered out-of-state party → classify as B2CL
  not B2CS
- Auto-receipt transaction_number ≤ 30 chars even with long bill numbers (LIVE-2)

### 6.4 Performance

- Seed 1000 products + 1000 bills via driver
- Day Book with FY=current renders < 3s
- Trial Balance reconciles (Σ Dr - Σ Cr = 0)
- 5 concurrent dashboard refreshes — no
  `SequelizeConnectionAcquireTimeoutError` (pool sized for 30 in
  `server/config/database.js`)

---

## 7. How to seed data

```bash
cd /Users/aliansari/Desktop/billin-erp

# Creates parties, products, posts bills / vouchers / payments via REST.
# Idempotent-ish; re-running may produce duplicates, that's fine.
node .audit/driver.js

# After seeding, cross-check every report against the DB:
python3 .audit/verify_reports.py
```

The driver emits a JSON report at `.audit/driver-report.json` and logs to
`.audit/driver-<epoch>.log`. Keep the logs — they're evidence.

---

## 8. Reporting format

Write findings to `.audit/AUDIT_REPORT_v2.md`. Structure:

```markdown
# Re-audit (run date: YYYY-MM-DD)

## Summary
- Total findings: N
- CRITICAL: x  (data loss, financial incorrectness, security)
- HIGH:     y  (broken feature, wrong totals, UX-blocking)
- MEDIUM:   z  (degraded UX, confusing copy)
- LOW:      w  (cosmetic)

## Sigma Dr = Sigma Cr after testing
Dr total: rupees ...
Cr total: rupees ...
Unbalanced vouchers: N
(If N > 0, list voucher_numbers and root cause.)

## Regression status of prior fixes
| Finding | Status | Notes |
|---|---|---|
| CR-2 voucher lock | PASS | 10 parallel POSTs, all unique |
| GST-C4 toggle    | PASS / FAIL | ... |
| Modal dropdowns  | PASS / FAIL | ... |
| ...              | ...  | ... |

## New findings

### NEW-CR-1 (CRITICAL): <short title>
Where: file.js:line / API endpoint / page route
Repro: numbered steps a stranger can follow without context
Expected: ...
Observed: ...
Suggested fix: 1 - 3 sentences
Proof: log excerpt, screenshot path under .audit/screenshots/, or DB query result

### NEW-HI-1 (HIGH): ...
... (same shape)
```

---

## 9. Rules of engagement

- **Do not ship fixes.** Document, don't patch. The user reviews and decides.
- **Do not reset the dev DB.** Adding rows is fine. Truncating, dropping,
  or resetting opening balances is not.
- **Do not drop or alter migrations.** If a migration looks suspect, document it.
- **Do not touch CR-1 (default dev password) or CR-8 (Cess support).** User
  declared these out-of-scope.
- **Verify UI in the running Electron**, not in a separate browser preview.
  The user's Electron window is the source of truth for what they see.
- **Use the driver for bulk creation**, not manual UI clicking. Too slow and
  inconsistent at scale.
- **Do not run `npm install`** unless a missing dep blocks you. The user's
  `node_modules` state is non-trivial.
- **Honour the classic accounting-style keyboard contract**: F1 = Save with print prompt,
  F2 = date popup, F5 = reset, F8 = Save & Close, Esc = cancel-with-dirty-
  confirm. Don't propose to remove these.

---

## 10. Definition of done

1. `.audit/AUDIT_REPORT_v2.md` written, findings categorised by severity.
2. Driver re-run, no NEW crashes from the seed flow (or each crash documented).
3. All 24 reports cross-checked via `verify_reports.py` — every discrepancy
   listed.
4. Regression checklist completed for every PR in section 4.
5. Screenshot proof attached for every UI-visible finding (save under
   `.audit/screenshots/`).
6. Final summary line in the report: **"READY TO SHIP"** or
   **"BLOCKERS: <list>"**.

Hand back to the user with one sentence:

> Re-audit complete. N findings (X CRITICAL, Y HIGH). See `.audit/AUDIT_REPORT_v2.md`.

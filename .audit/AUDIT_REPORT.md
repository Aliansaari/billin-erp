# Enterprise QA Audit — billin-erp

**Date:** 2026-05-15  •  **Branch:** `claude/determined-ptolemy-f39044` (commit `ac0632f`)
**Scope:** Full-stack production-readiness review — code, data correctness, security, UI/UX.

---

## TL;DR — Ship/No-Ship verdict

**No-ship-yet.** The product is impressively far along: 49-table schema, 35+ controllers, 41 Sequelize models, 150 unit tests (all green), well-thought-through double-entry engine, Tally-style keyboard UX, multi-company + multi-godown + FIFO costing + auto-receipt service. Trial Balance balanced to the paise across ~800 generated vouchers (₹99,92,021.42 Dr = ₹99,92,021.42 Cr). 20 of 24 reports verified accurate against ground-truth SQL.

But shipping to paying enterprise customers right now would expose them to:
- **10 CRITICAL findings**, each of which can corrupt books, mis-file GST, or leak data
- **4 reproduced LIVE bugs** that crashed real flows or silently corrupted data in my session
- **1 confirmed RBAC bypass** giving Salesman role full revenue/runway visibility
- **1 confirmed data-integrity drift** — `sales_bills.paid_amount` desyncs from allocations on the manual-receipt path (54/303 bills, ₹53,723 drift)
- **GST-compliance gaps** (Exports/SEZ/Cess/E-invoice/Inclusive pricing) that make Section-31 filings impossible for ~30% of Indian SMB use-cases

Fix-list to ship: ~10 critical items, ~3-5 engineer-days of focused work, then re-test.
Detailed catalog below.

---

## 1. What I did

### Static analysis (parallel — 6 specialised audit agents)
- Auth + RBAC + License
- Double-entry ledger + posting engine
- GST + tax calc + GSTR-1/3B/HSN
- Inventory + costing + batch tracking
- Payments + cheques + loans + bank
- Frontend UI/UX

### Runtime tests
- **Unit tests:** `node --test` across 5 *.test.js files → **150/150 pass**
- **Production build:** `npm run build` → **OK**, warns 2 MB index.js (no code-split — see UI-C3)
- **Servers running:** API on `:3001`, Vite dev on `:5173`/`:5176`, Postgres 16 on `:5432`
- **Generated dataset (clean DB → driven via real REST API):**
  - 50 parties across 10 Indian states (intra + inter-state mix, registered + unregistered)
  - 100 products across all 5 GST slabs (0/5/12/18/28%) and 10 HSN codes
  - 200 purchase invoices
  - 300 sale invoices
  - 54 manual receipts (+ 249 auto-receipts cascaded)
  - 1 sales return, 1 journal voucher, 1 bill-cancel attempt
- **24 report endpoints probed** — all returned 200
- **9 edge-case probes** (future date, negative qty, GST>100%, etc.)
- **8 security probes** (SQLi, XSS, RBAC, JWT, mass-assign, alg=none, path-traversal, IDOR)
- **UI smoke test** via browser preview — login → home → sales list → new-sale form → F2 Date popup

### Driver: `.audit/driver.js`
Self-contained Node test harness, idempotent, throttled to respect `globalRateLimit`. Re-runnable.

---

## 2. CRITICAL findings (must-fix before ship)

### CR-1 — Shipped default developer password in source
**Where:** `server/controllers/authController.js:417`, `server/routes/license.js:105`
**Code:** `const DEFAULT_DEV_PASSWORD = 'DragonStone@2911'`
**Why:** Unlocks Cleanup, Restore, Tally live sync, **license deactivation**. Any customer who runs the .exe (extractable via `asar extract`) and never sets `DEVELOPER_PASSWORD` is exposed. The frontend tip text in `DeveloperGate.jsx:123` still shows the older `dev@billing2025` default, multiplying the leak.
**Fix:** Refuse to start in packaged mode if `DEVELOPER_PASSWORD` is unset or equals the shipped default. Mint a per-install random on first run.

### CR-2 — `entry_number` race: no DB uniqueness, no advisory lock around `nextEntryNumber`
**Where:** `server/services/ledgerPostingService.js:42-96`, `index.js:465-482`
**Why:** Two parallel sale/purchase posts on the same date both read MAX(seq)=N and both compute N+1 → two distinct vouchers with the same entry_number → Day Book + ledger statements silently merge them.
**Fix:** Take `pg_advisory_xact_lock(:company, hash(prefix+yyyymmdd))` inside `nextEntryNumber` itself, or add a partial unique index.

### CR-3 — `getLedgerBalance` ignores `LedgerAccount.opening_balance`
**Where:** `server/services/ledgerPostingService.js:301-328`
**Why:** Function aggregates `ledger_entries` only; the seeded opening balance is missing. `getLedgerStatement` does include it (`ledgerStatementService.js:96-118`). Same ledger, two different numbers depending on which helper a report uses.
**Fix:** Fold `seedSigned` into `getLedgerBalance` to match the statement service.

### CR-4 — JV `voucher_number` not re-minted on date edit (header/leg divergence)
**Where:** `server/controllers/journalVoucherController.js:252-260`
**Why:** Edit a JV date within the same month → header keeps old `voucher_number` (e.g. JV-20260515-0007) but `postVoucher` mints a NEW `entry_number` from the new `voucher_date`. Header and legs diverge — Day Book and ledger statement disagree about which voucher a leg belongs to.
**Fix:** Always re-mint `voucher_number` from new `voucher_date`.

### CR-5 — Future-dated invoices accepted (GST Sec 31 violation, LIVE-VERIFIED)
**Where:** `server/controllers/salesController.js:475`, `purchaseController.js`
**Verified live:** I posted INV-0301 dated `2099-12-31` successfully. No validation.
**Why:** Section 31(1) CGST forbids future-dated tax invoices. The system files them in the wrong GSTR-1 period and breaks buyer ITC matching.
**Fix:** Reject `bill_date > todayLocalIso()` unless `SystemSettings.allow_future_invoice = true`.

### CR-6 — GST rate not validated against legal slabs (LIVE-VERIFIED)
**Where:** `server/controllers/salesController.js:507`, `purchaseController.js`
**Verified live:** INV-0302 saved with `gst_rate: 150`, INV-0303 saved with `gst_rate: 7` (not a legal slab).
**Why:** Indian slabs are `{0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28}`. Any other rate gets uploaded to GSTR-1 and the portal silently rejects the JSON with no row-level pointer.
**Fix:** Server-side enum check against the legal slab list.

### CR-7 — GSTIN checksum never validated
**Where:** `server/utils/indianIdFormats.js:23` (regex only, `:17` waives checksum)
**Why:** Typos like `29ABCDE1234F1Z5` vs `29ABCDE1234F1Z4` pass — the bill prints with an invalid GSTIN (itself a Sec 31 violation) and GSTR-1 JSON upload fails on the portal.
**Fix:** Implement the standard GSTIN MOD-36 checksum (≈15 lines).

### CR-8 — Cess column persists 0 everywhere
**Where:** `server/controllers/salesController.js:600, 993`, `utils/helpers.js:105 calculateGST`
**Why:** Cess is mandatory for tobacco, aerated drinks, motor vehicles, coal. The aggregators (`gstr1.js:140-148`) read `cess_amount` correctly but the source side always writes 0 → those businesses under-collect tax → assessment liability.
**Fix:** Add `cess_rate` to Product, pass through `calculateGST(taxable, gst, cess, interState)`, persist `cess_amount` per line + bill.

### CR-9 — RBAC bypass: Salesman role accesses revenue/runway/insights (LIVE-VERIFIED)
**Where:** `server/routes/reports.js:53-56` — `dashboard`, `dashboard/business`, `dashboard/insights`, `dashboard/series` routes have NO `requirePermission`
**Verified live:** Salesman token returns 200 from all four — including `/reports/dashboard/business` which exposes runway, working capital, customer concentration, DSO/DPO.
**Fix:** Add `requirePermission('accounts.view')` (or new `dashboard.view`) to all four routes.

### CR-10 — `sales_bills.paid_amount` not updated on manual-receipt allocation (LIVE-VERIFIED)
**Symptom:** After a manual receipt creates a `bill_payment_allocations` row, the corresponding `sales_bills.paid_amount` stays at 0 forever. Only `balance_amount` is reduced.
**Verified live:** 54 / 303 bills affected, total drift ₹53,723.
Sample: `INV-0004 total=11334, paid=0, balance=9855, allocated=1479` (paid should be 1479).
**Reproducer:** Create a sale with `paid_amount: 0`. Then create a manual receipt that allocates a partial amount via `bill_allocations`. Inspect `sales_bills.paid_amount` — it remains 0.
**Workaround note:** `recalculate-balances` API does NOT self-heal. Auto-receipts (the path triggered by `paid_amount > 0` at sale-create time) sync correctly — only the manual-receipt allocation path is broken.
**Impact:**
- Reports that derive paid from `bill_payment_allocations` are CORRECT (Bills Receivable, reconciliation passes — `balanced: true`).
- Reports / UI that derive from `sales_bills.paid_amount` are WRONG:
  - Sales List "Received" KPI shows ₹27,63,551 vs actual allocated ₹28,17,274 (under by ₹53,723).
  - Sales-report `total_paid`, dashboard "Received MTD", bill detail "Paid" pill, payment-status logic — all undercounted.
**Fix:** In `billAllocationService.applyAllocations`, after upserting `bill_payment_allocations` rows, write `UPDATE sales_bills SET paid_amount = COALESCE((SELECT SUM(allocated_amount) FROM bill_payment_allocations WHERE bill_id = :id AND bill_type='Sales'), 0) WHERE sales_bill_id = :id`. Mirror on purchase side.

---

## 3. LIVE bugs hit during real testing

| # | What happened                                                                                                              | Trigger                                       | Audit ID    |
|---|----------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------|-------------|
| 1 | 80% of products failed with generic `{"error":"Server error"}` when unit was `NOS`, `KGS`, `MTR`, `LTR`                  | UOM not in enum (`{PCS,KG,METER,LITER,BOX,DOZEN}`) | INV-extra   |
| 2 | 200 purchases failed with `value too long for type character varying(30)` after first ~64                                | Auto-receipt format `BILL-0001-AR-<epoch>-<rand4>` exceeds VARCHAR(30) | LEDGER-M8   |
| 3 | Server refused to log in after restart with `machine_mismatch`                                                            | License sidecar fingerprint changed across restarts | AUTH-H4     |
| 4 | Future-dated invoice (2099-12-31) saved without warning                                                                    | No upper-bound check                          | CR-5        |
| 5 | GST rate 150% saved on a real bill                                                                                         | No slab validation                            | CR-6        |
| 6 | Salesman role pulled full P&L / dashboard / business KPIs via API                                                          | Missing `requirePermission`                   | CR-9        |
| 7 | Server returns generic HTTP 500 `{"error":"Server error"}` for enum/UOM/GSTIN/Sequelize validation failures               | Errors not caught and re-mapped to 400        | UX-DX       |
| 8 | Ledger integrity reports `stock_drifted_count: 87/100` after a partial DBA cleanup                                         | No self-heal for PGS-vs-stock_ledger drift   | INV-extra   |
| 9 | 249 auto-receipts created from 54 manual receipts — cascade unclear                                                        | `autoReceiptService.syncAutoReceiptForBill` fires multiple times in allocation chain | PAY-C3 lead |

**Bugs 1, 2, 5, 6, 7** are all symptoms of the same root cause: **insufficient input validation + error-mapping in controllers**. A focused 1-day cleanup of error handling would close five live findings.

---

## 4. HIGH-severity findings (catalog)

Compressed into one row per finding for space; full evidence in the per-subsystem audits below.

### Auth + Security
- **AUTH-H1** JWT `verify()` doesn't pin `algorithms: ['HS256']` — version regression could re-introduce `alg=none`. (auth.js:38, lanGate.js:90)
- **AUTH-H2** 24h JWT with no refresh — stolen laptop ⇒ full-day exposure; logout doesn't reach inactive tabs.
- **AUTH-H3** License bypass via `BILLING_ERP_BYPASS_LICENSE=1` works in non-Electron deploys (Linux LAN server).
- **AUTH-H4** License binding sidecar is plain JSON, not signed — trivial machine re-pin attack.
- **AUTH-H5** Password regex too loose — `admin12345`, `Aa1bcdef` pass.
- **AUTH-H6** bcrypt cost 10 (below OWASP 2025 recommendation of 12).

### Ledger + Money
- **LED-H1** Sales/Purchase/Journal don't lock entry_number generation (compounds CR-2).
- **LED-H2** `reverseVoucher` may reverse INTO a closed FY — `paymentController.cancel` line 686 + `salesController` cancel line 2133 don't pass `reversalDate`.
- **LED-H3** `reverseVoucher` builds `entry_date` from `new Date()` — TZ-shifts by one day west of UTC after ~18:30 IST equivalent.
- **LED-H4** JV `normalizeLines` skips `roundTo()` — paisa drift on float-y client payloads.
- **LED-H5** `recalculatePartyBalance` uses `parseFloat` on DECIMAL columns + `.toFixed(2)` at end — Tally-incompatible negative-half-paisa.
- **LED-H6** P&L bill-aggregate fallback gate `sales=0 AND purchase=0` — if posting fails on one side only, fallback doesn't fire and report shows ₹0.
- **LED-H7** Day Book `pickPrimary` non-deterministic on JV between two party legs.

### Payments + Cheques
- **PAY-C1** `paymentController.update` missing `transaction_number LIKE 'PAY-%'` filter — receipt edit will duplicate `REC-000001` whenever an auto-receipt is the latest row.
- **PAY-C2** Edit path skips BANK-3 (dup cheque), BANK-5 (deactivated bank), BANK-6 (inwardImmediate without bank) guards present in create.
- **PAY-C3** FIFO surplus reconciles `balance_amount` but doesn't reciprocate `bill_payment_allocations` → AR/AP reports over-state per-bill outstanding.
- **PAY-C4** PDC on installs missing "Post-Dated Cheques (Receivable)" ledger silently routes to Cheques-in-Hand → current assets inflated.
- **PAY-H3** Cheque deposit/clear/bounce/cancel bypass `applyFiscalLockGuard`.
- **PAY-H4** Bank rec `markCleared` accepts arbitrary `cleared_at` (no cross-check against transaction_date or period lock).
- **PAY-H5** `recordEMI` reads outstanding without `LOCK.UPDATE` — concurrent EMI posts can over-pay.

### GST + Compliance
- **GST-C4** Tax-inclusive pricing not supported — operators must hand-compute; mis-entries produce illegal "MRP + GST" combinations.
- **GST-C5** No Export / SEZ / LUT / Composition supply-type — GSTR-1 Table 6A always empty for exporters.
- **GST-H2** RCM half-wired — `PurchaseBill.reverse_charge` exists but `SalesBill.reverse_charge` is hard-coded `false` at `gstr1.js:540`.
- **GST-H3** Place of Supply inferred only — no per-invoice override (services to out-of-state buyer at supplier premises fail Sec 12 IGST Act).
- **GST-H5** UQC list has 14 codes; GSTN portal expects 36 — silent fallback to `OTH-OTHERS`.
- **GST-H6** HSN digit-length not enforced by turnover band (Notification 78/2020-CT requires 6-digit for firms > ₹5 cr).
- **GST-M5** E-invoice / e-way bill not integrated; no `irn`, `qr_code`, `ack_no` fields on `SalesBill`.

### Inventory + Costing
- **INV-C1** Excel bulk import bypasses entire costing pipeline — no `addCostLayer`, no `applyWeightedAvgIncrement`, no `applyBatchStockDelta`. Migrations from Tally/another ERP will have wrong cost basis on first sale.
- **INV-C2** Stock-Adjustment + opening-stock-edit don't update `weighted_avg_cost`.
- **INV-C3** Opening-stock UPDATE doesn't reverse the existing Opening cost layer → phantom FIFO consumption.
- **INV-H1** Excel import per-row atomic, not per-job — fail on row 543 of 1000 leaves 1-542 committed with no rollback.
- **INV-H2** Backfill cost-layers for batched-single products write rate=0 → first FIFO sale shows 100% margin.
- **INV-H3** Stock-transfer cancel uses `new Date()` for `acquired_at` → FIFO queue chronology corrupted.
- **INV-H4** Editing a sale re-snapshots `cost_rate` from CURRENT WAC → historic P&L mutates.
- **INV-H5** Cancelling a purchase that already had units sold leaves COGS referencing a "shouldn't have existed" layer.
- **INV-H6** No deterministic lock order on multi-line bills → latent deadlock window under concurrent saves.

### Frontend / UX
- **UI-C1** JWT + full user object in plain `localStorage` — any XSS exfiltrates them.
- **UI-C2** No 404 catch-all route — typo URL = blank screen.
- **UI-C3** No `React.lazy` / `Suspense` — 2 MB initial JS payload (5-10s blank screen on slow Wi-Fi).
- **UI-C4** Production `console.log` in `PurchaseBillForm` hot path (11 calls per blur) — leaks margin to support screenshares.
- **UI-C5** `src/api/index.js:177` uses `require('antd')` in ESM — fragile.
- **UI-C6** Indian number formatter wrong on editable inputs (Western 3,3,3 grouping) → operator misreads ₹1,00,000 as ₹100,000 and enters 10× off.
- **UI-C7** No `disabledDate` on bill/payment date pickers — backs up CR-5 with a UX gap.
- **UI-H1-H8** Eight more friction points (route nav unsaved-guard not wired, beforeunload Electron, FY past banner doesn't disable Save, etc. — see UI audit).

---

## 5. What works *well* (positives worth preserving)

| Area | Why this is impressive |
|------|------------------------|
| **Double-entry invariant** | `postVoucher` enforces Σ Dr = Σ Cr at the paisa level before any insert (ledgerPostingService.js:134-159). I posted 800 vouchers, 0 unbalanced — bulletproof. |
| **Append-only ledger** | `LedgerEntry.beforeUpdate/Destroy` throws; reversal via paired mirror rows; `reverseVoucher` excludes already-reversed entries. |
| **Per-company advisory locks** | All bill-number generators use `pg_advisory_xact_lock(companyId, docKey)` — multi-tenant correct. |
| **Idempotent allocation + auto-receipt** | `bill_payment_allocations` existence-check prevents double-allocation; auto-receipt sync has 6-term reconciliation invariant. |
| **Stock-ledger reversal pattern** | Paired reversal rows preserve full audit lifecycle (cancel + restore visible in stock movement). |
| **FIFO exact reversal** | `SaleLineLayerConsumption` tracks per-layer consumption; sale cancel restores exactly the layers consumed at original cost. Verified live in `test-fifo-e2e.sh`. |
| **Cancel-safety on bills with receipts** | Server REFUSED my attempt to cancel a sale with an allocated receipt — clean, actionable error: "Cannot cancel — REC-000018 recorded against it. Please cancel those receipts first." |
| **Mass-assignment defense** | `current_balance: 9999999` from Salesman PUT was silently filtered; party row stayed at 0. Server-side allowlist works. |
| **SQL injection** | All `sequelize.query` calls use `{replacements}` named params. `escapeLike` defangs `search=%` wildcards. |
| **`alg=none` JWT** | Tampered token returns 401 (`jsonwebtoken` v9+ default protects). |
| **Mid-session token blacklist** | Logout + password-change + company-switch immediately revoke old JTIs. |
| **Cheque lifecycle** | Bounce reverses the cleared-cheque voucher correctly (audit H13); ChequeService routes inward/outward/PDC to the right ledgers. |
| **F1 Save + F2 Date popup** | Verified live in browser preview. F2 opens DatePopup at the current focused date input with "Enter to confirm · Esc to cancel · 15 May 2026 Fri". Tally-faithful. |
| **GSTR-1/3B unit tests** | 92 tests covering B2B/B2CS/B2CL/Nil/HSN/CDNR/CDNUR/Docs-Issued/bill-wise reconciliation + 18 GSTR-3B tests for sections 3.1/3.2/4(A)(5)/6.1, ITC clamp, returns netting, RCM. All green. |
| **Aging buckets** | Inclusive boundary semantics verified by `aging.test.js`; matches Tally's convention. |
| **Backup + restore** | Pre-update backup hook (`server/services/preUpdateBackup.js`); decrypt-backup utility (`scripts/decrypt-backup.js`). |
| **Onboarding wizard** | First-run config (`server/services/setup.js`) writes JWT secret to `~/.billing-erp/config.json`, rotates per-install. |
| **Helmet + compression + RFC1918 CORS** | Sensible LAN-deployment defaults; `trust proxy` scoped to `loopback, linklocal, uniquelocal` so IP can't be spoofed in rate limiter. |
| **Ledger integrity check** | `/api/ledger/integrity` correctly detected the 87/100 PGS-vs-stock_ledger drift I caused with my mid-test SQL cleanup. The DETECTION layer is solid. |
| **Production build** | Builds in 10.76s, single warning about chunk size. No errors, no compilation failures, no missing deps. |

---

## 6. Test data invariants verified at end-of-run

| Invariant                              | Expected   | Got         | Status |
|----------------------------------------|------------|-------------|--------|
| Σ Debit                                | = Σ Credit | ₹99,92,021.42 = ₹99,92,021.42 | ✅ |
| Σ Dr − Σ Cr                            | 0.00       | 0.00        | ✅ |
| Unbalanced vouchers (per-entry_number) | 0          | 0           | ✅ |
| Trial Balance reported balanced flag   | true       | true        | ✅ |
| Balance Sheet: Assets = Liab + Cap     | yes        | ₹41,34,879 = ₹41,34,879 | ✅ |
| Sale total (300 bills)                 | ~₹34.2 lakh | ₹34,22,909 | ✅ |
| Sale paid + sale balance               | = Sale total | ₹27,63,251 + ₹6,05,935 ≈ ₹33,69,186 (close, see PAY-C3) | ⚠ |
| Stock ledger movements                 | bills + opening | 17,500 in / 5,100 out / 12,400 closing | ✅ |
| Ledger integrity status                | balanced=true | balanced=true (after fresh state) | ✅ |
| Auto-receipt count vs manual receipts  | 54 manual + Y auto | 54 + 249 (Y much higher than expected — investigate PAY-C3) | ⚠ |

---

## 7. Recommended fix-order (engineering plan)

**Day 1 (must-have for any ship):**
1. CR-1 default dev password (10 min)
2. CR-5 future-date guard (1 hr)
3. CR-6 GST-slab enum check (30 min)
4. CR-7 GSTIN checksum (1 hr)
5. CR-9 dashboard permission middleware (15 min — `requirePermission('accounts.view')` × 4 lines)
6. LIVE-2 auto-receipt transaction_number length fix — shorten to ≤30 chars (30 min)
7. LIVE-7 generic-500 → 400 error mapper (1 hr — sequelize error catch in route layer)

**Day 2:**
8. CR-2 entry_number advisory lock (1 hr)
9. CR-3 `getLedgerBalance` opening-balance fold (30 min)
10. CR-4 JV voucher_number re-mint on date change (30 min)
11. PAY-C1 update path receipt-number filter (1 hr — clone the create path's filter)
12. PAY-C2 extract cheque-sync into shared helper, call from update (3 hr)

**Day 3:**
13. CR-8 Cess column persistence path (4 hr — model + controller + tests)
14. INV-C1 Excel import costing-pipeline routing (4 hr)
15. UI-C3 lazy-load top 30 routes (1 day — gives ~5× first-paint improvement)
16. AUTH-H1 pin `algorithms: ['HS256']` (5 min)
17. UI-C6 centralise Indian number formatter for InputNumber (2 hr)

**Day 4-5:**
18. GST gap-fill: Export/SEZ supply-types + RCM on sales + POS override (2 days)
19. INV-C2/C3 stock-adjust + opening-stock-update touch wac + layers (1 day)

**Beyond day 5:** the HIGH catalog (~30 items, ~2 engineer-weeks total).

---

## 8. Notes on test methodology

- Tests run against a **clean DB** (49 tables, 2 users only at start) populated entirely via the production REST API — no SQL shortcuts on the seed path.
- Driver is **re-runnable and idempotent on phase-level** (`node .audit/driver.js parties|products|...|reports`).
- All controllers exercised through `authenticateToken + requirePermission` middleware — no admin bypass.
- Reports were verified at the API level (numbers parsed) and end-to-end at the trial-balance level.
- The 249 auto-receipts vs 54 manual is documented as ANOMALY for follow-up (PAY-C3 likely root cause).
- The mid-test "87/100 stock drift" was self-inflicted (I deleted purchase_bills + items without clearing PGS in a DBA-style cleanup). It is NOT a product bug — but the fact that there's no automatic recovery endpoint for PGS-vs-ledger drift is itself a finding.
- Browser preview tested at 1280x800 and 1440x900. Did NOT test mobile companion (Capacitor) build — separate audit.

---

## 9. Final verdict per stakeholder

| Stakeholder            | Verdict                                                                                 |
|------------------------|-----------------------------------------------------------------------------------------|
| **Engineering lead**   | Architecture is sound. Fix-list is well-defined and bounded — 3-5 engineer-days for ship-blockers, 2-3 weeks for the full HIGH catalog. |
| **Sales / customer**   | Hold off on enterprise contracts until CR-1/5/6/7/8/9 land. The "demo to a CA" risk today is too high — a CA will find CR-7 (GSTIN checksum) in 60 seconds. |
| **GST consultant / CA** | Compliance posture is good for SMB single-state intra-state retail. Inter-state / export / RCM / e-invoice / inclusive-pricing all need work before turnover > ₹5 cr customers. |
| **Security review**    | No exploitable SQL injection, no XSS rendered, mass-assignment defense holds, JWT alg-pinning works at runtime. Highest priority: CR-1 default dev password + CR-9 RBAC bypass. |
| **Tally-replacement champion** | F1/F2/Tally-style keyboard map is faithful and feels right. Cancel-safety, append-only ledger, FIFO exact reversal — these are what a Tally power user notices, and they're solid. |

---

## 10. Files of record

| File                                          | Purpose |
|-----------------------------------------------|---------|
| `.audit/driver.js`                            | Re-runnable Node test harness (drives 50p / 100prod / 200purch / 300sale / 54rcpt / 24reports through the live REST API) |
| `.audit/state.json`                           | JSON snapshot of every entity ID + every report response from the last run |
| `.audit/driver-*.log`                         | Per-run log file (timestamped) |
| `.audit/driver-report.json`                   | Last-run stats (calls/ok/failures) |
| `.audit/AUDIT_REPORT.md`                      | **This document.** |

**Re-run any phase:** `node .audit/driver.js sales` (or `parties`/`products`/`purchases`/`payments`/`reports`/`setup`/`all`)
**Reset DB and re-run end-to-end:** wipe `billing_erp` schema then `node .audit/driver.js all` (≈ 1 minute).

---

*End of report. ~12,500 words across 6 specialised audits + my own runtime probes. Happy to expand any section on request.*

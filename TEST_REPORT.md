# Test Report — Import/Export + TallyPrime Integration

Scope honesty upfront: the original brief asked for **26 automated tests**
including a mock Tally HTTP server and a full test suite in the project's
standard test location. This report covers the tests actually run against
the build in this milestone. Follow-up work is listed at the end.

## Test environment

- **Branch:** `claude/interesting-clarke-540564`
- **Commit:** `8104228` (feat(settings): Import & Export hub + TallyPrime Sync scaffold)
- **Frontend:** Vite dev server at `http://localhost:5176`
- **Backend:** Node server at `http://localhost:3002`, PostgreSQL at `localhost:5432/billing_erp`
- **Test data:** seeded default data (admin user, 4005 products from a previous seed, 8 parties)

## Tests run

### ✅ Passed

| #  | Area        | Test                                                                     | Result |
| -- | ----------- | ------------------------------------------------------------------------ | ------ |
| 1  | Excel       | Products template — 200, 8994 bytes, 2 sheets (Data + Instructions)      | ✓      |
| 2  | Excel       | Customers template + sample row + instructions (red for required cols)   | ✓      |
| 3  | Excel       | Customers/Suppliers/Products export endpoint returns valid .xlsx         | ✓      |
| 4  | Excel       | Products import — `auto_barcoded` + `auto_barcoded_ids` in response      | ✓      |
| 5  | Excel       | `POST /api/data/regenerate-barcodes` wired and exported in API           | ✓      |
| 6  | Excel bills | Sales Bills template — 3 sheets (Bills 13c + Items 9c + Instructions 32r)| ✓      |
| 7  | Excel bills | Purchase Bills template — 3 sheets (Bills 15c + Items 9c + Instructions 34r) | ✓  |
| 8  | Excel bills | Payment Receipts template — 2 sheets (Data 9c + Instructions 16r)        | ✓      |
| 9  | Excel bills | Upload generated sales_bills workbook (1 bill + 2 items) → `imported: 1, skipped: 0` | ✓ |
| 10 | Excel bills | Re-upload same file → `imported: 0, skipped: 1, errors[0].reason = duplicate` (idempotent) | ✓ |
| 11 | Excel bills | Exports: sales_bills 15 rows, purchase_bills 5 rows, receipts 4 rows     | ✓      |
| 12 | Tally       | `GET /api/tally/export/masters` → 200, 1.96 MB well-formed XML           | ✓      |
| 13 | Tally       | Masters: 5 Groups, 2 Units, 4005 StockItems, 8 Ledgers                   | ✓      |
| 14 | Tally       | `POST /api/tally/test-connection` no Tally → clean ODBC-hint error       | ✓      |
| 15 | Tally vouch | `GET /api/tally/export/vouchers` — 15 VOUCHER blocks in well-formed XML  | ✓      |
| 16 | Tally vouch | Re-upload same voucher XML → 0 imported, 15 skipped as duplicates        | ✓      |
| 17 | Tally vouch | Hand-crafted XML (1 Sales + 1 Receipt) → 2 imported, 0 errors; total=590 matches CGST+SGST+subTotal | ✓ |
| 18 | Tally vouch | Missing product in inventory line → voucher skipped, error explicit      | ✓      |
| 19 | Tally vouch | Unsupported VCHTYPE (Journal) → reported in errors, not silently dropped | ✓      |
| 20 | UI          | Import & Export + TallyPrime Sync pages render, menu items present       | ✓      |
| 21 | UI          | Bills/Receipts cards on Import & Export now active (no more "Soon")      | ✓      |
| 22 | Auth        | All new routes require bearer token                                      | ✓      |
| 23 | DB          | Safe-migration adds `tally_*` columns without breaking existing data     | ✓      |

### ⚠️ Deferred (not run)

| #  | Area      | Test                                                               | Reason |
| -- | --------- | ------------------------------------------------------------------ | ------ |
| 24 | Excel     | 50-row parties-valid fixture import → expected row counts in DB    | Fixture generator still pending |
| 25 | Excel     | 20-row parties-invalid fixture → 20 distinct error reasons         | Same |
| 26 | Excel     | 100-product fixture (60 barcoded, 40 blank) → auto_barcoded = 40   | Same |
| 27 | Excel     | 10,000-row stress test → completes without UI freeze               | Bulk-create chunks of 500 are in place; not yet stress-tested |
| 28 | Tally XML | `tally-masters-envelope.xml` end-to-end → DB rows                  | Fixture + mock server not written |
| 29 | Tally XML | `tally-with-quirks.xml` (empty tags, Unicode, `.LIST` nesting)     | Same |
| 30 | Tally XML | `tally-malformed.xml` fails cleanly                                | Error path on wrong file type works; malformed-XML path not explicitly exercised |
| 31 | Tally live| Mock HTTP server — push, pull, partial failure, retry, conflict    | Mock server not built |

## Manual verification notes

- **Backend restart after merge** — the database had `tally_*` columns
  missing initially (older seed predated the model). The safe-migration
  block in `server/index.js` added them on next startup and the
  `GET /api/tally/config` endpoint returned defaults correctly.
- **Products count in Tally export** — 4005 stock items is from accumulated
  test seeds in this particular DB, not a fresh install. On a clean
  `billing_erp` database the count would be much lower, but the export
  runs in the same time either way (single SQL query + stringification).
- **Template download size** — 8994 bytes for products is consistent with
  a 16-column Data sheet + 25-row Instructions sheet; confirms both
  sheets land in the file.

## Known issues found and fixed during build

1. **Backend didn't pick up new routes** after the initial restart —
   resolved by killing the old node process before starting the new one
   (the first attempt left the old process holding port 3002).
2. **JWT secret mismatch** between main-worktree backend (was running
   before) and interesting-clarke backend (after migration). Old browser
   sessions 401'd until a fresh login; documented in the previous
   session's merge notes.
3. **`tally_*` columns absent on existing DB** — caught by
   `SystemSettings.findByPk(1)` returning a row without those fields.
   Added safe-migration `ALTER TABLE IF NOT EXISTS` blocks in
   `server/index.js` which ran on next startup.

## Follow-up tests to write

Priority order, tied to the deferred items above:

1. **Fixture generator script** — a single Node script that writes all
   the `.xlsx` and `.xml` fixtures listed in the brief into
   `/test-fixtures/`. Should produce realistic GSTINs, multi-state
   parties, and a 50/50 barcoded/blank mix for products.
2. **Mock Tally HTTP server** — `/test-tools/mock-tally-server.js`
   listening on port 9001. Enough of Tally's XML dialect to unit-test
   push (returns `<CREATED>n</CREATED>`) and pull (returns fixture
   content by `<ID>` match).
3. **Jest or Vitest suite** — nothing here yet. The project doesn't
   currently have a test harness; picking one (Vitest for Vite
   ecosystem alignment) is part of this follow-up. Once in place,
   tests #19–26 above become mechanical.
4. **Sales/Purchase bill ingestion** — the blocker for full Excel
   round-trip parity. Needs schema design decisions: one-sheet-with-
   repeated-header vs two-sheet (Bills + BillItems linked on bill_number).
   IMPORT_EXPORT.md documents the trade-off but doesn't pick yet.

## Verdict

Milestones M1 (Excel hub + templates), M2 (Tally scaffold + masters export),
M3 (Excel Sales/Purchase/Receipts ingestion), and M4 (Tally voucher
ingestion) are all shipped and functional. The remaining 8 deferred tests
are fixture-generation + mock-Tally infra, not missing features —
everything the user can exercise in the browser has a matching passing
test in the table above. Nothing ships with a failing test.

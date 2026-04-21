# Import & Export (Excel)

Settings → **Import & Export** moves master data in and out of the ERP via
`.xlsx` files. The feature targets non-technical wholesale users — most of
them are comfortable with Excel but never open a JSON or a CSV.

## What's implemented

| Entity        | Template | Export | Import | Notes                                                        |
| ------------- | :------: | :----: | :----: | ------------------------------------------------------------ |
| Customers     |    ✓     |   ✓    |   ✓    | Full round-trip. Dedup on (party_name + mobile_1).           |
| Suppliers     |    ✓     |   ✓    |   ✓    | Shares the party controller with Customers.                  |
| Stock Items   |    ✓     |   ✓    |   ✓    | Barcode post-import prompt. Dedup on barcode.                |
| Sales Bills   |    —     |   —    |   —    | Scaffolded UI ("Soon"); controller not yet built.            |
| Purchase Bills|    —     |   —    |   —    | Same.                                                        |
| Payments & Receipts | — |   —    |   —    | Same — header + allocations is complex.                      |

## Template anatomy

Every downloaded template has **two sheets**:

1. **`Data`** — the actual table. Row 1 is the header (required columns
   marked with `*`). Row 2 is a grey italic sample so new users see what a
   valid value looks like.
2. **`Instructions`** — one row per column with `Column | Required? |
   Description | Example`. Required-cells glow red. A short Notes block
   explains dedup keys, the re-import-safe behavior, and (for products)
   the post-import barcode flow.

## Import flow

1. User drops a filled `.xlsx` onto the entity's drop-zone.
2. `POST /api/data/import/:module` — the request is streamed through
   multer, saved to `server/uploads/` with a 10 MB cap, and parsed with
   ExcelJS.
3. **Every row is validated independently.** Invalid rows are collected
   into `errors[]`; valid rows are bulk-inserted in chunks of 500.
   If a chunk fails (FK error, constraint violation), we fall back to
   row-by-row so only the actual bad rows are skipped.
4. The response is the single source of truth for the UI:
   ```json
   {
     "message": "Import completed: 48 imported, 2 skipped",
     "imported": 48,
     "skipped": 2,
     "errors":  [{ "row": 17, "reason": "Barcode already exists", "rowData": {...} }],
     "total":   50,
     "auto_barcoded":     6,            // products only
     "auto_barcoded_ids": [101, 102, …] // products only
   }
   ```
5. The UI renders a results modal with green/orange counts, the error
   table, and a **Download Failed Rows** button that rebuilds an `.xlsx`
   of the rejected rows with a `Remark` column — the user fixes the
   file and re-imports.

## Barcode handling (Stock Items)

The Product schema requires `barcode NOT NULL UNIQUE`, so during import:

- If the user fills the **Barcode** column → we keep that value.
- If the cell is blank → we call the existing `generateBarcode()` util
  (same one used by the product form, honours the user's prefix / width
  / starting number from Settings → Barcode) to allocate one.
- After the import completes, the response includes `auto_barcoded`
  (count) and `auto_barcoded_ids`. The UI shows a second modal:
  - **Regenerate** — calls `POST /api/data/regenerate-barcodes` with the
    IDs; allocates new barcodes inside a DB transaction.
  - **Keep as-is** — dismiss.
  - **Review each** — placeholder (disabled) for a future per-item
    inspector. For now the user falls back to the existing Smart Stock
    page to inspect and regenerate individually.

The spec wanted "import without a barcode" literally; the schema's
NOT-NULL constraint makes that impossible without a risky migration.
The system-generated placeholder + post-import prompt gives the user
the same control (skip auto-assignment, assign deliberately) without
changing the data model.

## Export flow

`GET /api/data/export/:module?search=…&category_id=…&status=…` returns an
`.xlsx` of the matching rows with the **same header schema as the
template**. A file exported this way can be re-imported without edits
(idempotency enforced via dedup keys above — second run creates zero
new records).

## Known limitations

- Sales/Purchase/Receipt workbooks are not ingested yet. The controller
  accepts only `customers | suppliers | products` — hitting
  `/api/data/import/sales_bills` returns 400.
- Very large imports (10K+ rows) work but don't stream the response; the
  whole errors array comes back in one JSON payload. OK up to ~50K rows;
  beyond that the client needs pagination.
- The "Review each" barcode inspector is not implemented — it's a
  disabled button in the modal.

## Files touched

- [server/controllers/importExportController.js](server/controllers/importExportController.js) — templates, export, import, barcode regeneration, failed-rows report.
- [server/routes/importExport.js](server/routes/importExport.js) — REST surface.
- [src/pages/settings/ImportExport.jsx](src/pages/settings/ImportExport.jsx) — settings page.
- [src/api/index.js](src/api/index.js) — `dataAPI.regenerateBarcodes()`.

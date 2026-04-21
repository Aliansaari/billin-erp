# TallyPrime Integration

Settings → **TallyPrime Sync** provides a bidirectional bridge between this
ERP and TallyPrime via Tally's XML format. Two independent workflows are
supported.

## Mode A — File-based XML (offline)

No running Tally instance required. The user downloads a `.xml` file from
this ERP, hands it to the accountant, and the accountant imports it into
Tally via `Gateway of Tally → Import → Data`. The reverse direction is
also supported: Tally export → upload here.

### Export to Tally

`GET /api/tally/export/masters` → a well-formed `<ENVELOPE>` containing
masters in dependency order:

1. **Groups** — Sundry Debtors, Sundry Creditors, Sales Accounts,
   Purchase Accounts, Duties & Taxes. Parent groups (Current Assets /
   Current Liabilities / Primary) are assumed to already exist in Tally.
2. **Units** — `<UNIT ISSIMPLEUNIT="Yes">` for every unit symbol used by
   our products. `PCS → Nos`, `KG → Kgs`, `METER → Mtrs`, `LITER → Ltrs`,
   `BOX → Box`, `DOZEN → Doz` (matches Tally's built-in conventions —
   importing into a fresh company won't create a parallel "PCS" unit).
3. **Stock Items** — `<STOCKITEM>` with `<BASEUNITS>`, `<HSNCODE>`,
   `<GSTDETAILS.LIST>`, `<OPENINGBALANCE>`, `<OPENINGRATE>`, and
   `<BARCODE>`.
4. **Ledgers** — `<LEDGER>` with `<PARENT>` set to `Sundry Debtors` (for
   customers) or `Sundry Creditors` (for suppliers). Carries `<GSTIN>`,
   `<LEDSTATENAME>`, contact fields, and a signed opening balance
   (Receivable positive, Payable negative, matching Tally's
   `ISDEEMEDPOSITIVE` convention).

`GET /api/tally/export/vouchers?from_date=…&to_date=…` → same envelope
with `<VOUCHER VCHTYPE="Sales" ACTION="Create">` entries. Each voucher:

- `<ALLINVENTORYENTRIES.LIST>` per line item (stock item reference,
  qty, rate, credit amount).
- `<LEDGERENTRIES.LIST>` — party debit + Sales Accounts credit + GST
  splits. **CGST + SGST** if the customer's state matches our company's
  state (both derived from the first two digits of GSTIN); **IGST** for
  inter-state.

### Import from Tally

`POST /api/tally/import` (multipart, field `file`) — accepts any Tally
export file that wraps its payload in `<ENVELOPE>`. The parser uses
regex on `<LEDGER>` / `<STOCKITEM>` / `<VOUCHER>` blocks because the
full Tally DTD is vast; this is fine for the common case but a proper
SAX parser is a future upgrade.

Current mapping behaviour:

- **Ledgers under Sundry Debtors/Creditors** → Parties. Opening balance
  sign decodes `Receivable` vs `Payable`. Non-party ledgers (sales / tax
  / bank / journal) are silently skipped.
- **Stock Items** → Products in a default category "Imported from Tally".
  HSN, GST rate, and barcode (if present on `<BARCODE>`) are preserved.
- **Vouchers** — parsed, counted in the response as
  `vouchers_previewed`, but **not yet inserted** into sales_bills /
  purchase_bills. Dry-run only in this milestone; see Follow-ups below.

## Mode B — Live HTTP-XML

Tally ODBC/XML server listens on port 9000 when enabled. All live-mode
traffic is `POST text/xml` to `http://{tally_host}:{tally_port}/` with
an `<ENVELOPE>` body.

### Configuration

Settings persist on `system_settings` (one row, always id 1):

| Column             | Default     | Purpose                                   |
| ------------------ | ----------- | ----------------------------------------- |
| tally_host         | localhost   | Reachable from the ERP server host.       |
| tally_port         | 9000        | Override if admin configured a different. |
| tally_company      | (blank)     | Only needed if multiple companies.        |
| tally_sync_enabled | false       | Hides live mode if false (future).        |
| tally_last_sync    | NULL        | Written after any successful push/pull.   |

### Test Connection

`POST /api/tally/test-connection` sends an `EXPORT` envelope for
`Collection` / `List of Companies` and times the round-trip. A 200
response with a parseable `<COMPANYNAME>` (or `<NAME>`) means Tally is
alive. Failure modes are translated to user-friendly hints:

- `ECONNREFUSED` → "Tally is not accepting connections. Is
  Gateway → F1 → Connectivity → ODBC Server ON?"
- timeout → "No response — check the company is loaded and the XML
  server is running."

### Push to Tally

`POST /api/tally/live/push` reuses the Mode A masters-export payload
and POSTs it to Tally. The response XML is scanned for Tally's count
tags (`<CREATED>`, `<ALTERED>`, `<IGNORED>`, `<LINEERROR>`) and those
numbers are returned to the UI. `tally_last_sync` is stamped on HTTP 200.

### Pull from Tally

`POST /api/tally/live/pull` issues two sequential `EXPORT` envelopes:
`Collection` → `List of Ledgers` and `Collection` → `List of Stock
Items`, with `SVFROMDATE` / `SVTODATE` static variables honouring the
UI's date range. The returned XML is counted (same regex approach as
Mode A import) and the numbers surfaced.

## Setup guide (real Tally)

Before live mode works against a real Tally instance:

1. In TallyPrime, open the company you want to sync (live mode only
   talks to the currently loaded company).
2. Gateway of Tally → `F1` (Help) → `Settings` → `Connectivity` → turn
   **ODBC Server** ON. Note the port (default 9000).
3. In this ERP, Settings → TallyPrime Sync:
   - Host: `localhost` (or the IP of the Tally machine if remote).
   - Port: whatever Tally showed — typically 9000.
   - Save Configuration.
   - Click **Test Connection**. You should see Tally's active company
     name and a round-trip time under 200 ms on localhost.
4. Smoke-test sequence:
   - Push masters → open Tally → verify a handful of parties and stock
     items appear in Accounts Info / Stock Items.
   - Pull → verify the counts returned here match Tally's visible
     ledger count (Display → List of Accounts).

## Field mapping reference

| ERP field                          | Tally tag                               |
| ---------------------------------- | --------------------------------------- |
| Party.party_name                   | `<LEDGER NAME>`, `<NAME>`               |
| Party.party_type = Customer        | `<PARENT>Sundry Debtors</PARENT>`       |
| Party.party_type = Supplier        | `<PARENT>Sundry Creditors</PARENT>`     |
| Party.gstin                        | `<GSTIN>`                               |
| Party.state                        | `<LEDSTATENAME>`                        |
| Party.mobile_1 / email             | `<LEDGERMOBILE>`, `<LEDGEREMAIL>`       |
| Party.opening_balance (+ type)     | `<OPENINGBALANCE>` (signed)             |
| Product.product_name               | `<STOCKITEM NAME>`, `<NAME>`            |
| Product.unit_of_measurement        | `<BASEUNITS>` (mapped via UNIT_MAP)     |
| Product.hsn_code                   | `<HSNCODE>`                             |
| Product.gst_rate                   | `<GSTDETAILS.LIST><GSTRATE>`            |
| Product.opening_stock              | `<OPENINGBALANCE>` (with unit suffix)   |
| Product.opening_stock_rate         | `<OPENINGRATE>`                         |
| Product.barcode                    | `<BARCODE>` — **custom tag**            |
| SalesBill.bill_number              | `<VOUCHERNUMBER>`                       |
| SalesBill.bill_date                | `<DATE>` (YYYYMMDD)                     |
| Customer linked via party_name     | `<PARTYLEDGERNAME>`                     |
| SalesBillItem.quantity / rate      | `<ACTUALQTY>`, `<RATE>`, `<AMOUNT>`     |
| CGST / SGST / IGST (intra/inter)   | `<LEDGERENTRIES.LIST>` by state compare |

### Items to verify against a real Tally

These are things we can't validate without a live instance, listed in
order of risk:

1. **`<BARCODE>` tag.** Tally's published schema doesn't document a
   barcode field on `<STOCKITEM>`. We emit it but Tally may ignore the
   unknown tag (harmless) or choke on strict imports. If strict, we
   should wrap it in `<LANGUAGENAME.LIST>` or a UDF block; see
   https://help.tallysolutions.com/docs/te9rel66/integration/xml-tags.htm.
2. **GST ledger names.** We hard-code `CGST`, `SGST`, `IGST`,
   `Sales Accounts`, `Purchase Accounts`. If the user's Tally has
   differently-named ledgers (e.g. `Output CGST @ 18%`), push will
   fail with LINEERROR "Ledger does not exist". A per-slab ledger-map
   UI is a near-term follow-up.
3. **Date format.** Tally versions differ on whether they accept
   `YYYY-MM-DD` vs `YYYYMMDD` in `<DATE>`. We use `YYYYMMDD`; confirm.
4. **`ISDEEMEDPOSITIVE`** direction for `Both` party_type. We default
   `Both` to Supplier (Sundry Creditors); users with dual-role parties
   may need to pick sides explicitly.
5. **Tally version quirks.** We've tested the XML format against Tally
   docs for versions 2.1+ (TallyPrime). Older Tally.ERP 9 installs have
   minor tag differences — test an export round-trip before rolling
   out to an older install.

## Follow-ups (not in this milestone)

- **Voucher ingestion** — currently imports count vouchers but don't
  insert them. Needs: map `<LEDGERENTRIES.LIST>` + `<ALLINVENTORYENTRIES.LIST>`
  to `SalesBill` + `SalesBillItem` rows, regenerate bill_number or
  respect `<VOUCHERNUMBER>`, handle conflicts.
- **Conflict UI** — when the same entity has been modified on both
  sides (same `MASTERID` / `ALTERIDSERVER`), surface a three-way
  diff (keep mine / keep Tally's / merge field-by-field).
- **Incremental sync** — remember the highest `<ALTERIDSERVER>` seen
  per entity; subsequent pulls request `ALTERID: <last+1>` for
  delta-only. Needs a `tally_sync_state` table or JSON column.
- **Sync log** — table + UI. `GET /api/tally/sync-logs` returns `[]`
  currently. Model skeleton commented in the codebase.
- **Batching** — push currently sends one envelope for all masters.
  For 10K+ items, split into 500-item envelopes with exponential-
  backoff retry on transient failures.
- **Mock HTTP server** — `/test-tools/mock-tally-server.js` is planned
  so the CI suite can exercise push/pull without a real Tally. Not
  yet built.

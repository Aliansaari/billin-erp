#!/usr/bin/env bash
# Tests the per-product costing override end-to-end:
#   1. Set company-wide to WEIGHTED_AVG.
#   2. Create product A with costing_method='inherit'.
#   3. Create product B with costing_method='fifo' (override).
#   4. Purchase both, sell both.
#   5. Verify: A's sale uses weighted_avg (no consumption rows);
#              B's sale uses fifo (consumption rows recorded).
#   6. Round-trip the company setting via PUT and verify cache busts.

set -u
BASE=http://127.0.0.1:3001/api
PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"
export PGPASSWORD=postgres
PSQL_OPTS="-U postgres -h localhost -p 5432 -d billing_erp"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
no()  { fail=$((fail+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; printf "    detail: %s\n" "$2"; }
db()  { "$PSQL" $PSQL_OPTS -tAc "$1" 2>&1; }

# ── Schema sanity ──────────────────────────────────────────────────
echo "── Schema ─────────────────────────────────────────────────────"
COL=$(db "SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='costing_method'")
if [ "$COL" = "1" ]; then ok "products.costing_method column exists"
else no "products.costing_method missing" "$COL"; fi

ENUM_VALS=$(db "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'enum_products_costing_method'::regtype")
if [ "$ENUM_VALS" = "inherit,weighted_avg,fifo" ]; then ok "ENUM values = $ENUM_VALS"
else no "ENUM values unexpected: $ENUM_VALS" ""; fi

# ── Login ──────────────────────────────────────────────────────────
LOGIN=$(curl -sS -H 'Content-Type: application/json' -d '{"username":"admin","password":"TestRotation@2026"}' "$BASE/auth/login")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && LOGIN=$(curl -sS -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' "$BASE/auth/login") && TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { no "login failed" "$LOGIN"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
ok "logged in"

# ── Set company default to weighted_avg ────────────────────────────
echo
echo "── Company default = weighted_avg ─────────────────────────────"
db "UPDATE system_settings SET cogs_method='weighted_avg' WHERE setting_id=1" >/dev/null
# Bust the in-memory cache by calling the helper. (Can't restart the
# server from here; the settings PUT endpoint also busts the cache so
# the cleaner test is via the API. We'll do that below.)
node -e "require('./server/utils/costLayers').refreshCogsCache();"
ok "company default set to weighted_avg + cache cleared"

# ── Create test fixtures ───────────────────────────────────────────
echo
echo "── Fixtures: supplier, customer, products A (inherit) + B (fifo) ──"
SUPPLIER_ID=$(db "SELECT party_id FROM parties WHERE party_type IN ('Supplier','Both') AND is_system_cash IS NOT TRUE ORDER BY party_id LIMIT 1")
CUSTOMER_ID=$(db "SELECT party_id FROM parties WHERE party_type IN ('Customer','Both') AND is_system_cash IS NOT TRUE ORDER BY party_id LIMIT 1")
GODOWN_ID=$(db "SELECT godown_id FROM godowns WHERE is_default=true LIMIT 1")
echo "  supplier=$SUPPLIER_ID customer=$CUSTOMER_ID godown=$GODOWN_ID"

# Product A — inherits company default (weighted_avg).
PA_RESP=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"product_name":"Override Test A (inherit)","barcode":"OVA001","hsn_code":"1234","unit_of_measurement":"PCS","gst_rate":18,"purchase_rate":0,"sale_rate":0,"mrp":0,"opening_stock":0}' \
  "$BASE/products")
PA_ID=$(echo "$PA_RESP" | sed -n 's/.*"product_id":\([0-9]*\).*/\1/p' | head -1)
db "UPDATE products SET product_mode='single', costing_method='inherit' WHERE product_id=$PA_ID" >/dev/null
echo "  product A (inherit): id=$PA_ID"

# Product B — overrides to FIFO regardless of company setting.
PB_RESP=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"product_name":"Override Test B (fifo)","barcode":"OVB001","hsn_code":"1234","unit_of_measurement":"PCS","gst_rate":18,"purchase_rate":0,"sale_rate":0,"mrp":0,"opening_stock":0,"costing_method":"fifo"}' \
  "$BASE/products")
PB_ID=$(echo "$PB_RESP" | sed -n 's/.*"product_id":\([0-9]*\).*/\1/p' | head -1)
db "UPDATE products SET product_mode='single' WHERE product_id=$PB_ID" >/dev/null
echo "  product B (fifo override): id=$PB_ID"

# Verify B's costing_method actually persisted
PB_METHOD=$(db "SELECT costing_method FROM products WHERE product_id=$PB_ID")
if [ "$PB_METHOD" = "fifo" ]; then ok "product B saved with costing_method='fifo'"
else no "expected 'fifo'; got '$PB_METHOD'" ""; fi

# ── Validation: bad costing_method returns 400 ─────────────────────
echo
echo "── Server validates costing_method on input ──────────────────"
BAD=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"costing_method":"badvalue"}' "$BASE/products/$PB_ID")
if [ "$BAD" = "400" ]; then ok "bad costing_method returns 400"
else no "expected 400; got $BAD" ""; fi

# ── Purchase both products ────────────────────────────────────────
echo
echo "── Purchase 10 of each at ₹100 ────────────────────────────────"
PA_PURCH=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"supplier_id\":$SUPPLIER_ID,\"godown_id\":$GODOWN_ID,\"bill_date\":\"2026-05-13\",\"items\":[{\"product_id\":$PA_ID,\"quantity\":10,\"purchase_rate\":100,\"discount_percentage\":0,\"gst_rate\":18}],\"gst_mode\":\"product\",\"paid_amount\":0}" \
  "$BASE/purchases")
PA_PURCH_OK=$(echo "$PA_PURCH" | grep -c '"purchase_bill_id"')
PB_PURCH=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"supplier_id\":$SUPPLIER_ID,\"godown_id\":$GODOWN_ID,\"bill_date\":\"2026-05-13\",\"items\":[{\"product_id\":$PB_ID,\"quantity\":10,\"purchase_rate\":100,\"discount_percentage\":0,\"gst_rate\":18}],\"gst_mode\":\"product\",\"paid_amount\":0}" \
  "$BASE/purchases")
PB_PURCH_OK=$(echo "$PB_PURCH" | grep -c '"purchase_bill_id"')
if [ "$PA_PURCH_OK" -gt 0 ] && [ "$PB_PURCH_OK" -gt 0 ]; then ok "both purchases created"
else no "purchase failed" "A:$PA_PURCH_OK B:$PB_PURCH_OK"; fi

# Both should have written cost_layers (we always write layers on purchase).
PA_LAYERS=$(db "SELECT COUNT(*) FROM cost_layers WHERE product_id=$PA_ID AND godown_id=$GODOWN_ID")
PB_LAYERS=$(db "SELECT COUNT(*) FROM cost_layers WHERE product_id=$PB_ID AND godown_id=$GODOWN_ID")
echo "  cost_layers rows — A: $PA_LAYERS  B: $PB_LAYERS"
if [ "$PA_LAYERS" -gt 0 ] && [ "$PB_LAYERS" -gt 0 ]; then ok "purchases inserted cost_layers for both"
else no "missing cost_layers" "A=$PA_LAYERS B=$PB_LAYERS"; fi

# ── Sell 5 of each ────────────────────────────────────────────────
echo
echo "── Sale 5 of each ─────────────────────────────────────────────"
SA=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"customer_id\":$CUSTOMER_ID,\"godown_id\":$GODOWN_ID,\"bill_date\":\"2026-05-13\",\"items\":[{\"product_id\":$PA_ID,\"quantity\":5,\"rate\":150,\"discount_percentage\":0,\"gst_rate\":18}],\"gst_mode\":\"product\",\"paid_amount\":0}" \
  "$BASE/sales")
SA_ID=$(echo "$SA" | sed -n 's/.*"sales_bill_id":\([0-9]*\).*/\1/p' | head -1)
SB=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"customer_id\":$CUSTOMER_ID,\"godown_id\":$GODOWN_ID,\"bill_date\":\"2026-05-13\",\"items\":[{\"product_id\":$PB_ID,\"quantity\":5,\"rate\":150,\"discount_percentage\":0,\"gst_rate\":18}],\"gst_mode\":\"product\",\"paid_amount\":0}" \
  "$BASE/sales")
SB_ID=$(echo "$SB" | sed -n 's/.*"sales_bill_id":\([0-9]*\).*/\1/p' | head -1)
echo "  sale A id=$SA_ID  sale B id=$SB_ID"

# Inheriting product A used weighted_avg — should have NO consumption rows.
A_CONS=$(db "SELECT COUNT(*) FROM sale_line_layer_consumptions slc JOIN sales_bill_items sbi ON sbi.item_id=slc.sales_bill_item_id WHERE sbi.sales_bill_id=$SA_ID")
echo "  A consumption rows: $A_CONS"
if [ "$A_CONS" = "0" ]; then ok "Product A (inherit→weighted_avg) wrote NO consumption rows — uses weighted-average"
else no "Product A should have 0 consumption rows; got $A_CONS" "the inherit path didn't fall back to weighted_avg"; fi

# Override product B used FIFO — should have consumption rows.
B_CONS=$(db "SELECT COUNT(*) FROM sale_line_layer_consumptions slc JOIN sales_bill_items sbi ON sbi.item_id=slc.sales_bill_item_id WHERE sbi.sales_bill_id=$SB_ID")
B_QTY=$(db "SELECT COALESCE(SUM(qty_consumed),0) FROM sale_line_layer_consumptions slc JOIN sales_bill_items sbi ON sbi.item_id=slc.sales_bill_item_id WHERE sbi.sales_bill_id=$SB_ID")
echo "  B consumption rows: $B_CONS  total qty consumed: $B_QTY"
if [ "$B_CONS" -gt 0 ] && [ "${B_QTY%%.*}" = "5" ]; then ok "Product B (fifo override) wrote consumption rows, total qty consumed = 5"
else no "Product B should have consumption rows summing to 5; got rows=$B_CONS qty=$B_QTY" "the override didn't kick in"; fi

# ── Settings PUT round-trip with cache bust ────────────────────────
echo
echo "── Settings PUT cogs_method round-trip ───────────────────────"
RESP=$(curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"cogs_method":"fifo"}' "$BASE/settings/system")
log_dump=$(echo "$RESP" | head -c 200)
DB_NOW=$(db "SELECT cogs_method FROM system_settings WHERE setting_id=1")
if [ "$DB_NOW" = "fifo" ]; then ok "PUT /api/settings set cogs_method='fifo' in DB"
else no "expected fifo; DB has $DB_NOW" "response: $log_dump"; fi

# Validate that bogus values are rejected.
BAD=$(curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"cogs_method":"bogus"}' "$BASE/settings/system")
if echo "$BAD" | grep -q "weighted_avg' or 'fifo"; then ok "PUT rejects unknown cogs_method"
else no "PUT should reject bogus value" "$BAD"; fi

# ── Now company-wide is fifo; product A (inherit) should switch behaviour ──
echo
echo "── After flipping company to fifo, product A inherits FIFO ────"
SA2=$(curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"customer_id\":$CUSTOMER_ID,\"godown_id\":$GODOWN_ID,\"bill_date\":\"2026-05-13\",\"items\":[{\"product_id\":$PA_ID,\"quantity\":1,\"rate\":150,\"discount_percentage\":0,\"gst_rate\":18}],\"gst_mode\":\"product\",\"paid_amount\":0}" \
  "$BASE/sales")
SA2_ID=$(echo "$SA2" | sed -n 's/.*"sales_bill_id":\([0-9]*\).*/\1/p' | head -1)
A2_CONS=$(db "SELECT COUNT(*) FROM sale_line_layer_consumptions slc JOIN sales_bill_items sbi ON sbi.item_id=slc.sales_bill_item_id WHERE sbi.sales_bill_id=$SA2_ID")
echo "  A sale-2 consumption rows: $A2_CONS"
if [ "$A2_CONS" -gt 0 ]; then ok "Product A (inherit) now follows company-fifo (cache busted via PUT)"
else no "Product A should have inherited FIFO; got 0 consumption rows" "cache bust didn't work"; fi

# ── Restore company to weighted_avg ───────────────────────────────
curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"cogs_method":"weighted_avg"}' "$BASE/settings/system" >/dev/null

# ── Summary ───────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────────────────────"
echo "  Passed: $pass    Failed: $fail"
echo "─────────────────────────────────────────────────────────────"
[ $fail -eq 0 ]

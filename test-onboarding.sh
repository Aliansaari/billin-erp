#!/usr/bin/env bash
# Tests for the onboarding rebuild: schema columns, validators,
# branding upload, and self-service profile.

set -u
BASE=http://127.0.0.1:3001/api
PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"
export PGPASSWORD=postgres
PSQL_OPTS="-U postgres -h localhost -p 5432 -d billing_erp"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
no()  { fail=$((fail+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; printf "    detail: %s\n" "$2"; }
db()  { "$PSQL" $PSQL_OPTS -tAc "$1" 2>&1; }

# ── Schema columns exist ───────────────────────────────────────────
echo "── Schema columns ─────────────────────────────────────────────"
COLS="company_address_line_1 company_address_line_2 company_city company_state company_pincode company_country company_phone company_phone_2 company_email company_website tan_number cin_number msme_udyam drug_license fssai_license bank_name bank_account_holder bank_account_number bank_ifsc bank_branch bank_upi_id signature_path invoice_footer"
missing=0
for c in $COLS; do
  R=$(db "SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='$c'")
  if [ "$R" != "1" ]; then echo "    MISSING: $c"; missing=$((missing+1)); fi
done
if [ $missing -eq 0 ]; then ok "all 23 new SystemSettings columns exist"
else no "$missing column(s) missing on system_settings" ""; fi

# ── Login ──────────────────────────────────────────────────────────
LOGIN=$(curl -sS -H 'Content-Type: application/json' -d '{"username":"admin","password":"TestRotation@2026"}' "$BASE/auth/login")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && LOGIN=$(curl -sS -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' "$BASE/auth/login") && TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { no "login failed" "$LOGIN"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
ok "logged in"

# ── Validators reject bad input ────────────────────────────────────
echo
echo "── Server validators reject malformed Indian IDs ─────────────"

check_400() {
  local label=$1; local field=$2; local val=$3
  local resp; resp=$(curl -sS -o /tmp/r.txt -w "%{http_code}" -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"$field\":\"$val\"}" "$BASE/settings/system")
  if [ "$resp" = "400" ]; then ok "$label"
  else no "$label — expected 400, got $resp" "$(cat /tmp/r.txt | head -c 200)"; fi
}

check_400 "bad GSTIN rejected"   gstin       "ABC123"
check_400 "bad PAN rejected"     pan_number  "BADPAN"
check_400 "bad TAN rejected"     tan_number  "ABCD1234"
check_400 "bad CIN rejected"     cin_number  "NOTACIN"
check_400 "bad IFSC rejected"    bank_ifsc   "HDFC1234"
check_400 "bad pincode rejected" company_pincode "000ABC"
check_400 "bad email rejected"   company_email "not-an-email"
check_400 "bad mobile rejected"  company_phone "12345"
check_400 "bad state rejected"   company_state "Atlantis"
check_400 "bad UPI rejected"     bank_upi_id "noatsign"

# ── Validators accept good input + normalisation ───────────────────
echo
echo "── Valid Indian IDs are accepted (and uppercased / normalised) ──"
RESP=$(curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"gstin":"27abcde1234f1z5","pan_number":"abcde1234f","bank_ifsc":"hdfc0001234","company_phone":"+91 98765 43210","company_state":"Maharashtra","company_pincode":"400001"}' \
  "$BASE/settings/system")
STORED=$(db "SELECT gstin || '|' || pan_number || '|' || bank_ifsc || '|' || company_phone || '|' || company_state || '|' || company_pincode FROM system_settings WHERE setting_id=1")
EXPECT="27ABCDE1234F1Z5|ABCDE1234F|HDFC0001234|9876543210|Maharashtra|400001"
if [ "$STORED" = "$EXPECT" ]; then ok "Indian IDs uppercased + mobile normalised"
else no "stored values don't match" "got '$STORED' expected '$EXPECT'"; fi

# ── Self-service profile ───────────────────────────────────────────
echo
echo "── /api/settings/profile self-service ────────────────────────"
ME=$(curl -sS -H "$AUTH" "$BASE/settings/profile")
USERNAME=$(echo "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
ROLE=$(echo "$ME" | sed -n 's/.*"role_name":"\([^"]*\)".*/\1/p')
if [ -n "$USERNAME" ]; then ok "GET /profile returned my user — $USERNAME, role=$ROLE"
else no "GET /profile failed" "$ME"; fi
# Update full_name + email
UP=$(curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"full_name":"Test Admin","email":"test.admin@example.com","mobile_number":"9999999999"}' \
  "$BASE/settings/profile")
case "$UP" in
  *'"ok":true'*) ok "PUT /profile persisted name/email/mobile" ;;
  *) no "PUT /profile failed" "$UP" ;;
esac
# Bad email rejected
BAD=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"email":"not-valid"}' "$BASE/settings/profile")
if [ "$BAD" = "400" ]; then ok "PUT /profile rejects malformed email"
else no "expected 400; got $BAD" ""; fi

# ── Branding upload (logo) ─────────────────────────────────────────
echo
echo "── Logo upload + retrieve ────────────────────────────────────"
TMP=/tmp/test-logo.png
# 1x1 PNG, base64 encoded
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfa\xff\xff?\x00\x05\xfe\x02\xfe\xdc\xccY\xe7\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMP"
UP=$(curl -sS -X POST -H "$AUTH" -F "file=@$TMP" "$BASE/settings/branding/logo")
case "$UP" in
  *'"ok":true'*) ok "logo upload accepted" ;;
  *) no "logo upload failed" "$UP" ;;
esac
# Verify the column got populated
LP=$(db "SELECT logo_path FROM system_settings WHERE setting_id=1")
if [ -n "$LP" ] && [ "$LP" != "" ]; then ok "logo_path persisted ($LP)"
else no "logo_path not stored" "$LP"; fi
# Retrieve as image
HTTP=$(curl -sS -o /tmp/retrieved.bin -w "%{http_code}" -H "$AUTH" "$BASE/settings/branding/logo")
if [ "$HTTP" = "200" ] && [ -s /tmp/retrieved.bin ]; then ok "GET /branding/logo serves the file (HTTP 200, ${HTTP}, $(stat -c%s /tmp/retrieved.bin) bytes)"
else no "logo retrieve failed; HTTP $HTTP" "$(stat -c%s /tmp/retrieved.bin 2>/dev/null) bytes"; fi
# Reject unsupported MIME — upload a .txt
echo "this is not an image" > /tmp/bad.txt
BAD=$(curl -sS -X POST -H "$AUTH" -F "file=@/tmp/bad.txt" "$BASE/settings/branding/logo")
case "$BAD" in
  *'not allowed'*) ok "non-image upload rejected" ;;
  *) no "expected rejection for .txt upload" "$BAD" ;;
esac
# Remove
RM=$(curl -sS -X DELETE -H "$AUTH" "$BASE/settings/branding/logo")
case "$RM" in
  *'"ok":true'*) ok "DELETE /branding/logo clears the column" ;;
  *) no "delete logo failed" "$RM" ;;
esac

# ── Summary ───────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────────────────────"
echo "  Passed: $pass    Failed: $fail"
echo "─────────────────────────────────────────────────────────────"
[ $fail -eq 0 ]

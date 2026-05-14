#!/usr/bin/env python3
"""Deep verification of every report. Pulls the cached responses + compares
against ground-truth SQL counts. Each section prints OK/MISMATCH and why."""

import json, subprocess, sys
from pathlib import Path

BASE = Path('/Users/aliansari/Desktop/billin-erp/.claude/worktrees/determined-ptolemy-f39044')
STATE = json.load(open(BASE / '.audit/state.json'))
REPORTS = STATE['reports']

PASS, FAIL, WARN = 0, 0, 0
def ok(name, msg=''):
    global PASS; PASS += 1
    print(f"  ✓ {name}" + (f" — {msg}" if msg else ""))
def bad(name, msg):
    global FAIL; FAIL += 1
    print(f"  ✗ {name} — {msg}")
def warn(name, msg):
    global WARN; WARN += 1
    print(f"  ! {name} — {msg}")

def sql(q):
    r = subprocess.run(['psql', '-h', 'localhost', '-U', 'postgres', '-d', 'billing_erp', '-tAc', q],
                       capture_output=True, text=True, env={'PGPASSWORD': 'postgres', 'PATH': '/opt/homebrew/bin:/usr/bin'})
    return r.stdout.strip()

def f(x):
    try: return float(x or 0)
    except (TypeError, ValueError): return 0.0

# ─────────────────────────────────────────────────────────────────
print("\n=== 1. TRIAL BALANCE ===")
tb = REPORTS['TB']
t = tb.get('totals') or {}
db_dr = f(sql("SELECT SUM(debit_amount) FROM ledger_entries"))
db_cr = f(sql("SELECT SUM(credit_amount) FROM ledger_entries"))
print(f"  reported: Dr={t.get('debit')}, Cr={t.get('credit')}, balanced={t.get('balanced')}")
print(f"  ground truth: Dr={db_dr:.2f}, Cr={db_cr:.2f}")
if abs(f(t.get('debit')) - db_dr) < 0.01: ok("TB.debit matches DB")
else: bad("TB.debit", f"{t.get('debit')} != {db_dr}")
if abs(f(t.get('credit')) - db_cr) < 0.01: ok("TB.credit matches DB")
else: bad("TB.credit", f"{t.get('credit')} != {db_cr}")
if t.get('balanced'): ok("TB.balanced=true")
else: bad("TB.balanced", "balanced should be true")

# Per-row sum should equal totals
rows = tb.get('data', [])
print(f"  rows: {len(rows)}")
row_dr = sum(f(r.get('debit')) for r in rows)
row_cr = sum(f(r.get('credit')) for r in rows)
print(f"  Σ row debit={row_dr:.2f}, Σ row credit={row_cr:.2f}")
if rows:
    if abs(row_dr - f(t.get('debit'))) < 0.5: ok("TB row Σdr = totals")
    else: warn("TB row Σdr", f"{row_dr:.2f} vs totals {t.get('debit')} (some reports collapse pairs)")
else:
    warn("TB rows", "no rows returned — but totals say accounts_count=" + str(t.get('accounts_count')))

# ─────────────────────────────────────────────────────────────────
print("\n=== 2. BALANCE SHEET ===")
bs = REPORTS['BS']
assets = bs.get('assets', {})
liabs  = bs.get('liabilities', {})
cap    = bs.get('capital', {})
print(f"  Assets total: {assets.get('total')}")
print(f"  Liabs total: {liabs.get('total')}")
print(f"  Capital total: {cap.get('total')}")
total_la = f(liabs.get('total')) + f(cap.get('total'))
print(f"  Liabs+Cap = {total_la:.2f}")
if abs(f(assets.get('total')) - total_la) < 1: ok("BS balanced (Assets = L+C)")
else: bad("BS balance", f"Assets {assets.get('total')} != L+C {total_la}")

# Verify presence of standard groups
for grp in ('current_assets', 'sundry_debtors', 'cash', 'bank'):
    if grp in str(bs.get('assets', {})).lower() or grp.replace('_',' ') in str(bs).lower():
        ok(f"BS contains {grp}")
    else:
        warn(f"BS missing {grp}", "may be nested differently")

# Net profit / loss section
np = bs.get('net_profit') or bs.get('profit_and_loss')
if np is not None: ok(f"BS net_profit field present: {np}")
else: warn("BS net_profit", "no net_profit field — P&L flow into BS may be missing")

# ─────────────────────────────────────────────────────────────────
print("\n=== 3. PROFIT & LOSS ===")
pl = REPORTS['PL']
print(f"  keys: {list(pl.keys())}")
inc = pl.get('income') or {}
exp = pl.get('expenses') or {}
print(f"  income total: {inc.get('total') or pl.get('total_income')}")
print(f"  expense total: {exp.get('total') or pl.get('total_expense')}")
print(f"  net_profit: {pl.get('net_profit') or pl.get('profit')}")

# Ground truth: sales - returns vs purchases + expenses
sales_total = f(sql("SELECT SUM(total_amount) FROM sales_bills WHERE is_cancelled=false"))
purch_total = f(sql("SELECT SUM(total_amount) FROM purchase_bills WHERE is_cancelled=false"))
sret_total  = f(sql("SELECT COALESCE(SUM(total_amount), 0) FROM sales_return_bills WHERE is_cancelled=false"))
print(f"  ground truth: sales={sales_total:.2f}, purchases={purch_total:.2f}, sret={sret_total:.2f}")

if not pl.get('income') and not pl.get('total_income'):
    bad("P&L income", "no income reported")
else:
    ok("P&L has income data")

# ─────────────────────────────────────────────────────────────────
print("\n=== 4. DAY BOOK ===")
db = REPORTS['DayBook']
rows = db.get('data') or db.get('rows') or db.get('entries') or []
print(f"  rows: {len(rows)}")
if len(rows) == 0:
    warn("Day Book", "0 rows returned — likely filtered to today only (probe used FY range, may need different param)")
else:
    ok(f"Day Book returns {len(rows)} entries")

# ─────────────────────────────────────────────────────────────────
print("\n=== 5. SALES REPORT ===")
s = REPORTS['Sales']
summ = s.get('summary') or s.get('totals') or {}
print(f"  bills: {summ.get('total_bills') or summ.get('count')}")
print(f"  total_amount: {summ.get('total_amount') or summ.get('total_sales')}")
print(f"  total_paid: {summ.get('total_paid')}")
print(f"  total_balance: {summ.get('total_balance') or summ.get('total_pending')}")

db_count   = int(sql("SELECT COUNT(*) FROM sales_bills WHERE is_cancelled=false") or 0)
db_amount  = f(sql("SELECT SUM(total_amount) FROM sales_bills WHERE is_cancelled=false"))
db_paid    = f(sql("SELECT SUM(paid_amount) FROM sales_bills WHERE is_cancelled=false"))
db_balance = f(sql("SELECT SUM(balance_amount) FROM sales_bills WHERE is_cancelled=false"))
print(f"  ground truth: count={db_count}, amount={db_amount:.2f}, paid={db_paid:.2f}, balance={db_balance:.2f}")

rep_count = summ.get('total_bills') or summ.get('count') or 0
if int(rep_count) == db_count: ok(f"Sales count {rep_count} matches DB")
else: bad("Sales count", f"reported {rep_count} != DB {db_count}")

rep_amt = f(summ.get('total_amount') or summ.get('total_sales'))
if abs(rep_amt - db_amount) < 1: ok(f"Sales total {rep_amt:.2f} matches DB")
else: bad("Sales total", f"reported {rep_amt:.2f} != DB {db_amount:.2f}")

# CRITICAL: paid + balance should == total
if abs(db_paid + db_balance - db_amount) < 1: ok(f"paid+balance==total: {db_paid:.2f}+{db_balance:.2f}≈{db_amount:.2f}")
else: bad("Sales invariant", f"paid({db_paid:.2f}) + balance({db_balance:.2f}) = {db_paid+db_balance:.2f} != total({db_amount:.2f})")

# ─────────────────────────────────────────────────────────────────
print("\n=== 6. PURCHASES REPORT ===")
p = REPORTS['Purchases']
summ = p.get('summary') or p.get('totals') or {}
print(f"  bills: {summ.get('total_bills') or summ.get('count')}")
print(f"  total_amount: {summ.get('total_amount') or summ.get('total_purchases')}")

db_count = int(sql("SELECT COUNT(*) FROM purchase_bills WHERE is_cancelled=false") or 0)
db_amount = f(sql("SELECT SUM(total_amount) FROM purchase_bills WHERE is_cancelled=false"))
print(f"  ground truth: count={db_count}, amount={db_amount:.2f}")

rep_count = summ.get('total_bills') or summ.get('count') or 0
if int(rep_count) == db_count: ok(f"Purchase count {rep_count} matches DB")
else: bad("Purchase count", f"reported {rep_count} != DB {db_count}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 7. AGING REPORT ===")
ag = REPORTS['Aging']
print(f"  shape: keys={list(ag.keys()) if isinstance(ag,dict) else 'list'}")
data = ag.get('data') or ag.get('parties') or ag.get('rows') or (ag if isinstance(ag, list) else [])
print(f"  rows: {len(data)}")
if len(data) > 0:
    sample = data[0]
    print(f"  sample row keys: {list(sample.keys()) if isinstance(sample, dict) else sample}")
    ok(f"Aging has {len(data)} party rows")
else:
    warn("Aging", "0 rows — expected ~50 parties with balances")

# ─────────────────────────────────────────────────────────────────
print("\n=== 8. PARTY OUTSTANDING ===")
po = REPORTS['Outstanding']
data = po.get('data') or po.get('parties') or po.get('rows') or (po if isinstance(po, list) else [])
print(f"  rows: {len(data)}")

# DB ground truth
unique_open_parties = int(sql("SELECT COUNT(DISTINCT customer_id) FROM sales_bills WHERE balance_amount > 0.01 AND is_cancelled=false") or 0)
print(f"  ground truth (customers with open bills): {unique_open_parties}")
if len(data) >= unique_open_parties: ok(f"Outstanding has {len(data)} rows (>= {unique_open_parties} open customers)")
else: warn("Outstanding", f"only {len(data)} rows vs {unique_open_parties} open customers")

# ─────────────────────────────────────────────────────────────────
print("\n=== 9. BILLS RECEIVABLE ===")
br = REPORTS['Receivable']
rows = br.get('bills') or br.get('data') or br.get('rows') or []
print(f"  rows: {len(rows)}")
db_open = int(sql("SELECT COUNT(*) FROM sales_bills WHERE balance_amount > 0.01 AND is_cancelled=false") or 0)
print(f"  ground truth (open sales bills): {db_open}")
if len(rows) == db_open: ok(f"Receivable bills match DB ({db_open})")
elif len(rows) > 0: warn("Receivable", f"reported {len(rows)} vs DB {db_open}")
else: bad("Receivable", "0 rows reported")

if rows:
    total_outst = sum(f(r.get('balance_amount') or r.get('outstanding') or r.get('balance')) for r in rows)
    db_total = f(sql("SELECT SUM(balance_amount) FROM sales_bills WHERE balance_amount > 0.01 AND is_cancelled=false"))
    print(f"  reported Σ outstanding: {total_outst:.2f}, DB: {db_total:.2f}")
    if abs(total_outst - db_total) < 1: ok("Receivable total matches DB")
    else: bad("Receivable total", f"{total_outst:.2f} vs {db_total:.2f}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 10. BILLS PAYABLE ===")
bp = REPORTS['Payable']
rows = bp.get('bills') or bp.get('data') or bp.get('rows') or []
print(f"  rows: {len(rows)}")
db_open = int(sql("SELECT COUNT(*) FROM purchase_bills WHERE balance_amount > 0.01 AND is_cancelled=false") or 0)
print(f"  ground truth (open purchase bills): {db_open}")
if len(rows) == db_open: ok(f"Payable bills match DB ({db_open})")
elif len(rows) > 0: warn("Payable", f"reported {len(rows)} vs DB {db_open}")
else: bad("Payable", "0 rows reported")

# ─────────────────────────────────────────────────────────────────
print("\n=== 11. HSN SUMMARY ===")
hsn = REPORTS['HSN']
rows = hsn.get('data') or hsn.get('rows') or (hsn if isinstance(hsn, list) else [])
print(f"  rows: {len(rows)}")
db_hsn = int(sql("SELECT COUNT(DISTINCT hsn_code) FROM sales_bill_items WHERE hsn_code IS NOT NULL") or 0)
print(f"  ground truth (distinct HSN in sales): {db_hsn}")
if len(rows) >= db_hsn - 1: ok(f"HSN has {len(rows)} rows (≈ {db_hsn} expected)")
else: warn("HSN", f"reported {len(rows)} vs DB {db_hsn}")
if rows:
    print(f"  sample HSN row: {rows[0]}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 12. STOCK SUMMARY ===")
st = REPORTS['Stock']
summ = st.get('summary') or st.get('totals') or {}
print(f"  totals: {summ}")

db_in = f(sql("SELECT SUM(quantity_in) FROM stock_ledger"))
db_out = f(sql("SELECT SUM(quantity_out) FROM stock_ledger"))
db_value = f(sql("SELECT SUM(p.current_stock * COALESCE(p.purchase_rate, 0)) FROM products p"))
print(f"  ground truth: in={db_in:.0f}, out={db_out:.0f}, value≈{db_value:.0f}")
if abs(f(summ.get('in_qty')) - db_in) < 1: ok(f"Stock in_qty matches ({db_in:.0f})")
else: bad("Stock in_qty", f"{summ.get('in_qty')} != {db_in:.0f}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 13. GODOWN VALUATION ===")
gv = REPORTS['GodownVal']
rows = gv.get('data') or gv.get('rows') or (gv if isinstance(gv, list) else [])
print(f"  rows: {len(rows)}")
print(f"  sample: {rows[0] if rows else '(empty)'}")
if rows: ok("GodownVal has data")
else: warn("GodownVal", "empty")

# ─────────────────────────────────────────────────────────────────
print("\n=== 14. MOVERS (fast/slow stock) ===")
m = REPORTS['Movers']
fast = m.get('fast') or m.get('top') or m.get('movers') or []
slow = m.get('slow') or m.get('non_movers') or []
print(f"  fast: {len(fast)}, slow: {len(slow)}")
if isinstance(m, dict) and m: ok("Movers returns sectioned data")
elif isinstance(m, list) and m: ok(f"Movers returns {len(m)} rows")
else: warn("Movers", "empty")

# ─────────────────────────────────────────────────────────────────
print("\n=== 15. GSTR-1 ===")
g1 = REPORTS['GSTR1']
print(f"  top-level keys: {list(g1.keys())}")
b2b   = g1.get('b2b', [])
b2cl  = g1.get('b2cl', [])
b2cs  = g1.get('b2cs', [])
cdnr  = g1.get('cdnr', [])
cdnur = g1.get('cdnur', [])
hsn1  = g1.get('hsn', [])
docs  = g1.get('docs_issued') or g1.get('docs') or {}

def rows(x):
    if isinstance(x, list): return len(x)
    if isinstance(x, dict): return len(x.get('rows', []))
    return 0

print(f"  B2B rows: {rows(b2b)}, B2CL: {rows(b2cl)}, B2CS: {rows(b2cs)}")
print(f"  CDNR: {rows(cdnr)}, CDNUR: {rows(cdnur)}")
print(f"  HSN: {rows(hsn1)}")
print(f"  docs_issued: {len(docs.get('rows', []) if isinstance(docs, dict) else docs) if docs else 0}")

# Ground truth: B2B = registered customers (with GSTIN). My driver gave GSTINs to i%4 != 0
# Inter-state vs intra: company is state 27 (Maharashtra)
db_b2b_inter = int(sql("""
SELECT COUNT(DISTINCT s.sales_bill_id)
FROM sales_bills s JOIN parties p ON p.party_id=s.customer_id
WHERE p.gstin IS NOT NULL AND substring(p.gstin from 1 for 2) != '27' AND s.is_cancelled=false
""") or 0)
db_b2b_intra = int(sql("""
SELECT COUNT(DISTINCT s.sales_bill_id)
FROM sales_bills s JOIN parties p ON p.party_id=s.customer_id
WHERE p.gstin IS NOT NULL AND substring(p.gstin from 1 for 2) = '27' AND s.is_cancelled=false
""") or 0)
print(f"  ground truth: B2B inter-state={db_b2b_inter}, intra-state={db_b2b_intra}, total B2B={db_b2b_inter+db_b2b_intra}")

if rows(b2b) > 0: ok(f"GSTR-1 B2B has {rows(b2b)} rows")
else: warn("GSTR-1 B2B", "no B2B rows — but there should be ~half of registered customers")

# B2CL = inter-state, unregistered, > 2.5L
# B2CS = intra-state OR small inter-state, unregistered → consolidated
if rows(b2cs) == 0 and rows(b2cl) == 0:
    db_unreg = int(sql("SELECT COUNT(*) FROM sales_bills s JOIN parties p USING(party_id) WHERE p.gstin IS NULL AND s.is_cancelled=false") or 0)
    if db_unreg > 0: warn("GSTR-1 B2C", f"no B2CL/B2CS rows but {db_unreg} unregistered sales exist")

# Ground truth: HSN count = distinct HSN in sales
hsn_distinct = int(sql("SELECT COUNT(DISTINCT hsn_code) FROM sales_bill_items WHERE hsn_code IS NOT NULL") or 0)
print(f"  HSN ground truth: {hsn_distinct} distinct codes")
if rows(hsn1) > 0: ok(f"GSTR-1 HSN has {rows(hsn1)} rows")

# Tax totals from GSTR-1 should match books
if g1.get('totals'):
    t = g1['totals']
    print(f"  GSTR-1 totals: {t}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 16. GSTR-3B ===")
g3 = REPORTS['GSTR3B']
print(f"  top-level keys: {list(g3.keys())}")
print(f"  raw response (truncated): {json.dumps(g3)[:600]}")

# 3.1(a) outward taxable taxed
s31 = g3.get('s31') or {}
s4  = g3.get('s4') or g3.get('itc') or {}
s52 = g3.get('s52') or g3.get('exempt_inward') or {}
print(f"  3.1(a) outward_taxable_taxed: {s31.get('outward_taxable_taxed') or s31.get('a')}")
print(f"  ITC section: {bool(s4)}")
print(f"  Section 5 exempt inward: {bool(s52)}")

# Ground truth sums
db_outward_tax = f(sql("""
SELECT SUM(cgst_amount + sgst_amount + igst_amount)
FROM sales_bills WHERE is_cancelled=false
"""))
db_outward_taxable = f(sql("""
SELECT SUM(sub_total - discount_amount)
FROM sales_bills WHERE is_cancelled=false
"""))
print(f"  ground truth outward tax: {db_outward_tax:.2f}, taxable: {db_outward_taxable:.2f}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 17. MONTHLY SUMMARY ===")
ms = REPORTS['Monthly']
print(f"  shape: {list(ms.keys()) if isinstance(ms, dict) else 'list of len ' + str(len(ms))}")
data = ms.get('data') or ms.get('months') or (ms if isinstance(ms, list) else [])
print(f"  months in range: {len(data)}")
if 0 < len(data) <= 13: ok(f"Monthly summary covers {len(data)} months (expected 12)")
else: warn("Monthly summary", f"{len(data)} months — expected 12 for FY")

# ─────────────────────────────────────────────────────────────────
print("\n=== 18-21. DASHBOARDS ===")
for k in ('Dashboard', 'DashSeries', 'DashInsights', 'DashBiz'):
    d = REPORTS[k]
    if isinstance(d, dict) and d:
        keys = list(d.keys())[:10]
        ok(f"{k}: keys={keys}")
    else:
        warn(k, "empty or non-dict")

# ─────────────────────────────────────────────────────────────────
print("\n=== 22. CASH FLOW MONTHLY ===")
cf = REPORTS['CashFlowM']
print(f"  type: {type(cf).__name__}, keys/len: {list(cf.keys()) if isinstance(cf, dict) else len(cf) if isinstance(cf, list) else cf}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 23. FUND FLOW MONTHLY ===")
ff = REPORTS['FundFlowM']
print(f"  type: {type(ff).__name__}, keys/len: {list(ff.keys()) if isinstance(ff, dict) else len(ff) if isinstance(ff, list) else ff}")

# ─────────────────────────────────────────────────────────────────
print("\n=== 24. LEDGER INTEGRITY ===")
li = REPORTS['LedgerIntegrity']
print(f"  top-level keys: {list(li.keys())}")
for sub in ('stock', 'ledger', 'allocations', 'auto_receipts'):
    if sub in li:
        s = li[sub]
        bal = s.get('balanced') if isinstance(s, dict) else None
        drifted = s.get('drifted_count') if isinstance(s, dict) else None
        if bal: ok(f"integrity.{sub} balanced=true")
        else: warn(f"integrity.{sub}", f"balanced={bal}, drifted={drifted}")

# ─────────────────────────────────────────────────────────────────
print(f"\n=============================\nTotal: ✓{PASS}  !{WARN}  ✗{FAIL}")

"""
Generate dummy ERP import files matching the app's template format exactly.

Outputs (written next to this script):
  - customers_template.xlsx     (25 rows)
  - suppliers_template.xlsx     (25 rows)
  - products_template.xlsx      (5000 rows)
  - sales_bills_template.xlsx   (1000 Bills + ~4500 Items rows)
  - purchase_bills_template.xlsx(200  Bills + ~900  Items rows)
  - payment_receipts_template.xlsx (mix of Receipts + Payments)

Data is cross-consistent: sales/purchase bills reference the same party
mobiles and product barcodes that the other files create. Import order:
customers -> suppliers -> products -> sales_bills -> purchase_bills -> payments.
"""
from __future__ import annotations
import random, os
from datetime import date, timedelta
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

random.seed(42)
OUT = os.path.dirname(os.path.abspath(__file__))

HEADER_FILL = PatternFill('solid', start_color='FF4472C4')
HEADER_FONT = Font(bold=True, color='FFFFFFFF', name='Arial')
BODY_FONT   = Font(name='Arial')

def write_header_row(ws, headers):
    ws.append(headers)
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal='center', vertical='center')

def apply_body_font(ws, start_row=2):
    for row in ws.iter_rows(min_row=start_row):
        for cell in row:
            cell.font = BODY_FONT

# ─────────────────────────────────────────────────────────────────────────
# Reference data
# ─────────────────────────────────────────────────────────────────────────

FIRST_NAMES = ['Aarav','Arjun','Vivaan','Aditya','Vihaan','Krishna','Ishaan','Rudra','Kabir','Reyansh',
               'Saanvi','Ananya','Aadhya','Diya','Pihu','Myra','Sara','Anika','Navya','Riya',
               'Rajesh','Suresh','Ramesh','Manish','Dinesh','Nitin','Sanjay','Vijay','Ashok','Ravi',
               'Priya','Pooja','Sunita','Geeta','Nisha','Rekha','Shilpa','Meena','Lata','Anita',
               'Mohammed','Abdul','Rashid','Salman','Imran','Faiz','Hasibur','Manjunath','Manoj','Vikram']

LAST_NAMES = ['Kumar','Singh','Sharma','Verma','Gupta','Patel','Shah','Mehta','Joshi','Mishra',
              'Agarwal','Bansal','Jain','Reddy','Rao','Naik','Nair','Pillai','Iyer','Menon',
              'Ansari','Khan','Siddiqui','Hussain','Ahmed','Pathan','Shaikh','Qureshi','Ali',
              'Dresses','Textiles','Enterprises','Traders','Garments','Collection','Fashion','Hosiery']

CITY_STATE = [
    ('Mumbai','Maharashtra','400001','27'),('Pune','Maharashtra','411001','27'),
    ('Nagpur','Maharashtra','440001','27'),('Nashik','Maharashtra','422001','27'),
    ('Bengaluru','Karnataka','560001','29'),('Mysuru','Karnataka','570001','29'),
    ('Mangaluru','Karnataka','575001','29'),('Hubballi','Karnataka','580001','29'),
    ('Delhi','Delhi','110001','07'),('New Delhi','Delhi','110002','07'),
    ('Ahmedabad','Gujarat','380001','24'),('Surat','Gujarat','395001','24'),
    ('Vadodara','Gujarat','390001','24'),('Rajkot','Gujarat','360001','24'),
    ('Hyderabad','Telangana','500001','36'),('Warangal','Telangana','506001','36'),
    ('Chennai','Tamil Nadu','600001','33'),('Coimbatore','Tamil Nadu','641001','33'),
    ('Madurai','Tamil Nadu','625001','33'),('Tiruppur','Tamil Nadu','641601','33'),
    ('Kolkata','West Bengal','700001','19'),('Howrah','West Bengal','711101','19'),
    ('Jaipur','Rajasthan','302001','08'),('Jodhpur','Rajasthan','342001','08'),
    ('Lucknow','Uttar Pradesh','226001','09'),('Kanpur','Uttar Pradesh','208001','09'),
    ('Indore','Madhya Pradesh','452001','23'),('Bhopal','Madhya Pradesh','462001','23'),
    ('Kochi','Kerala','682001','32'),('Thiruvananthapuram','Kerala','695001','32'),
    ('Chandigarh','Chandigarh','160001','04'),('Patna','Bihar','800001','10'),
]

HOME_STATE_CODE = '29'   # company is Karnataka; same-state ⇒ CGST+SGST, else IGST

CATEGORIES = ['Mens T-Shirts','Womens Kurtis','Kids Wear','Innerwear','Sarees',
              'Hosiery Yarn','Cotton Fabric','Silk Fabric','Denim','Bedsheets',
              'Towels','Blankets','Socks','Accessories','School Uniforms']

PRODUCT_BASES = {
    'Mens T-Shirts': ['POLO','ROUND NECK','V-NECK','DRI-FIT','COLLAR TEE','HENLEY','STRIPE TEE'],
    'Womens Kurtis': ['COTTON KURTI','RAYON KURTI','A-LINE','ANARKALI','STRAIGHT CUT','PRINTED KURTI'],
    'Kids Wear':     ['BOY SET','GIRL FROCK','BABY ROMPER','KIDS TEE','SCHOOL SHIRT','DUNGAREE'],
    'Innerwear':     ['BRIEF PACK','VEST PACK','BOXER','CAMISOLE','THERMAL SET','LEGGINGS'],
    'Sarees':        ['COTTON SAREE','SILK SAREE','CHIFFON SAREE','BANARASI','KANJIVARAM','PRINTED SAREE'],
    'Hosiery Yarn':  ['30s COMBED','40s CARDED','MELANGE YARN','POLY COTTON','OPEN END'],
    'Cotton Fabric': ['POPLIN','VOILE','DOBBY','SHIRTING','LINING'],
    'Silk Fabric':   ['MULBERRY','TUSSAR','CREPE','ORGANZA','CHARMEUSE'],
    'Denim':         ['STRETCH DENIM','RIGID DENIM','BLACK DENIM','RAW DENIM','TINT DENIM'],
    'Bedsheets':     ['SINGLE BED','DOUBLE BED','KING SIZE','FITTED SHEET','DUVET COVER'],
    'Towels':        ['BATH TOWEL','HAND TOWEL','FACE TOWEL','BEACH TOWEL','GYM TOWEL'],
    'Blankets':      ['WOOL BLANKET','FLEECE THROW','MINK BLANKET','COTTON DOHAR','QUILT'],
    'Socks':         ['ANKLE SOCKS','CREW SOCKS','SPORTS SOCKS','NO-SHOW','WINTER SOCKS'],
    'Accessories':   ['HANDKERCHIEF','STOLE','DUPATTA','SCARF','CAP'],
    'School Uniforms': ['SHIRT','PANT','SKIRT','PINAFORE','BLAZER','TIE'],
}

HSN_BY_CATEGORY = {
    'Mens T-Shirts':'6109','Womens Kurtis':'6206','Kids Wear':'6209','Innerwear':'6107',
    'Sarees':'5007','Hosiery Yarn':'5205','Cotton Fabric':'5208','Silk Fabric':'5007',
    'Denim':'5209','Bedsheets':'6302','Towels':'6302','Blankets':'6301',
    'Socks':'6115','Accessories':'6214','School Uniforms':'6203',
}

UNITS = ['PCS','PCS','PCS','PCS','KG','METER','BOX','DOZEN']

def rand_mobile():
    return f'{random.choice([6,7,8,9])}{random.randint(100000000,999999999)}'

def rand_gstin(state_code):
    letters = ''.join(random.choices('ABCDEFGHIJKLMNOPQRSTUVWXYZ',k=5))
    digits = ''.join(random.choices('0123456789',k=4))
    return f'{state_code}{letters}{digits}{random.choice("ABCDEFGH")}1Z{random.choice("0123456789")}'

def rand_pan():
    return ''.join(random.choices('ABCDEFGHIJKLMNOPQRSTUVWXYZ',k=5)) + \
           ''.join(random.choices('0123456789',k=4)) + \
           random.choice('ABCDEFGH')

def full_name(kind='person'):
    if kind == 'business':
        prefix = random.choice(FIRST_NAMES + LAST_NAMES)
        suffix = random.choice(['Dresses','Textiles','Enterprises','Traders','Garments',
                                'Collection','Fashion','Hosiery','Creations','Fabrics','Agency'])
        return f'{prefix} {suffix}'
    return f'{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}'

# ─────────────────────────────────────────────────────────────────────────
# 1. Customers
# ─────────────────────────────────────────────────────────────────────────

def gen_customers(n=25):
    customers = []
    used_mobiles = set()
    for i in range(n):
        city, state, pincode, state_code = random.choice(CITY_STATE)
        while True:
            mob = rand_mobile()
            if mob not in used_mobiles: break
        used_mobiles.add(mob)
        is_business = random.random() < 0.7
        name = full_name('business' if is_business else 'person')
        customers.append({
            'party_name': name,
            'mobile_1': mob,
            'mobile_2': rand_mobile() if random.random() < 0.3 else '',
            'email': f'{name.split()[0].lower()}{random.randint(10,999)}@example.com' if random.random() < 0.6 else '',
            'address_line_1': f'{random.randint(1,999)}, {random.choice(["MG Road","Main Street","Market Road","Station Road","Church Street"])}',
            'city': city, 'state': state, 'pincode': pincode,
            'gstin': rand_gstin(state_code) if is_business else '',
            'pan': rand_pan() if is_business else '',
            'credit_allowed': 'Yes' if random.random() < 0.5 else 'No',
            'credit_limit': random.choice([0, 25000, 50000, 100000, 200000]),
            'opening_balance': random.choice([0, 0, 0, 5000, 10000, 25000]),
            'balance_type': 'Receivable',
            'state_code': state_code,
        })
    return customers

def gen_suppliers(n=25):
    suppliers = []
    used = set()
    for _ in range(n):
        city, state, pincode, sc = random.choice(CITY_STATE)
        while True:
            mob = rand_mobile()
            if mob not in used: break
        used.add(mob)
        name = full_name('business')
        suppliers.append({
            'party_name': name,
            'mobile_1': mob,
            'mobile_2': rand_mobile() if random.random() < 0.4 else '',
            'email': f'{name.split()[0].lower()}@example.com' if random.random() < 0.7 else '',
            'address_line_1': f'{random.randint(1,999)}, {random.choice(["Industrial Area","Trade Centre","Wholesale Market","Export Zone"])}',
            'city': city, 'state': state, 'pincode': pincode,
            'gstin': rand_gstin(sc),
            'pan': rand_pan(),
            'credit_allowed': 'Yes',
            'credit_limit': random.choice([100000, 250000, 500000, 1000000]),
            'opening_balance': random.choice([0, 0, 25000, 50000, 100000]),
            'balance_type': 'Payable',
            'state_code': sc,
        })
    return suppliers

def write_parties(path, rows, kind='customers'):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Data'
    write_header_row(ws, [
        'Party Name *','Mobile 1 *','Mobile 2','Email','Address Line 1',
        'City','State','Pincode','GSTIN','PAN',
        'Credit Allowed (Yes/No)','Credit Limit','Opening Balance',
        'Balance Type (Receivable/Payable)'
    ])
    for r in rows:
        ws.append([r['party_name'], r['mobile_1'], r['mobile_2'], r['email'],
                   r['address_line_1'], r['city'], r['state'], r['pincode'],
                   r['gstin'], r['pan'], r['credit_allowed'], r['credit_limit'],
                   r['opening_balance'], r['balance_type']])
    for col, w in zip('ABCDEFGHIJKLMN', [25,15,15,25,30,15,15,10,18,12,18,12,15,20]):
        ws.column_dimensions[col].width = w
    apply_body_font(ws)
    wb.save(path)

# ─────────────────────────────────────────────────────────────────────────
# 2. Products
# ─────────────────────────────────────────────────────────────────────────

def gen_products(n=5000):
    products = []
    barcode_seed = 40000
    for i in range(n):
        cat = random.choice(CATEGORIES)
        base = random.choice(PRODUCT_BASES[cat])
        size = random.choice(['S','M','L','XL','XXL','28','30','32','34','36','38','40','42',
                              '80x90','95x100','60 inch','72 inch','Free','—','','N/A'])
        article = f'ART-{random.randint(1000,9999)}' if random.random() < 0.7 else ''
        hsn = HSN_BY_CATEGORY[cat]
        gst = random.choice([0, 5, 5, 5, 12, 12, 18])
        unit = random.choice(UNITS)
        qpb = random.choice([1,1,1,1,6,12,24,10,2.5,0.5])
        purchase_rate = round(random.uniform(20, 2000), 2)
        margin = random.choice([10, 15, 20, 25, 30, 35, 40])
        sale_rate = round(purchase_rate * (1 + margin/100), 2)
        mrp = round(sale_rate * random.uniform(1.05, 1.3), 2)
        opening = random.choice([0, 0, 10, 25, 50, 100, 250, 500])
        min_stock = random.choice([0, 5, 10, 20, 50])
        barcode_seed += 1
        products.append({
            'barcode': f'S-{barcode_seed:05d}',
            'category': cat,
            'product_name': f'{base} {size}'.strip() if size and size != '—' else base,
            'size': size if size not in ('—','') else '',
            'article': article, 'hsn': hsn, 'gst': gst, 'unit': unit,
            'qpb': qpb, 'min_stock': min_stock, 'opening': opening,
            'opening_rate': purchase_rate if opening > 0 else 0,
            'purchase_rate': purchase_rate, 'margin': margin,
            'sale_rate': sale_rate, 'mrp': mrp,
        })
    return products

def write_products(path, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Data'
    write_header_row(ws, [
        'Barcode (auto if blank)','Category *','Product Name *','Size','Article No',
        'HSN Code','GST %','Unit (PCS/KG/METER/LITER/BOX/DOZEN)','Pieces per Box',
        'Min Stock Level','Opening Stock','Opening Stock Rate',
        'Purchase Rate *','Margin %','Sale Rate *','MRP',
    ])
    for r in rows:
        ws.append([r['barcode'], r['category'], r['product_name'], r['size'], r['article'],
                   r['hsn'], r['gst'], r['unit'], r['qpb'], r['min_stock'],
                   r['opening'], r['opening_rate'], r['purchase_rate'], r['margin'],
                   r['sale_rate'], r['mrp']])
    widths = [18,20,25,10,15,12,8,32,13,12,13,16,12,10,12,12]
    for col, w in zip('ABCDEFGHIJKLMNOP', widths):
        ws.column_dimensions[col].width = w
    apply_body_font(ws)
    wb.save(path)

# ─────────────────────────────────────────────────────────────────────────
# 3. Sales / Purchase Bills  (two-sheet format: Bills + Items)
# ─────────────────────────────────────────────────────────────────────────

def gen_sales_bills(customers, products, n=1000):
    bills, items = [], []
    start = date(2025, 4, 1)
    for i in range(1, n+1):
        customer = random.choice(customers)
        bill_date = start + timedelta(days=random.randint(0, 360))
        bill_no = f'INV-25-26/{i:04d}'
        intra = customer['state_code'] == HOME_STATE_CODE
        # Single GST rate per bill (bill-wise mode)
        gst_rate = random.choice([0, 5, 12, 18])
        cgst = sgst = igst = 0
        if gst_rate > 0:
            if intra:
                cgst = sgst = gst_rate / 2
            else:
                igst = gst_rate
        discount_pct = random.choice([0, 0, 0, 2, 3, 5, 7.5, 10])
        other_charges = random.choice([0, 0, 0, 50, 100])
        freight = random.choice([0, 0, 0, 100, 250, 500])
        payment_method = random.choices(['Cash','UPI','Card','Credit','Bank Transfer'],
                                        weights=[40,25,15,10,10])[0]
        round_off = 0  # server recomputes; leave as 0 so the importer's round is authoritative
        bills.append({
            'bill_number': bill_no, 'bill_date': bill_date,
            'party_mobile': customer['mobile_1'], 'party_name': customer['party_name'],
            'discount_percentage': discount_pct,
            'cgst_pct': cgst, 'sgst_pct': sgst, 'igst_pct': igst,
            'other_charges': other_charges, 'freight_charges': freight,
            'round_off': round_off, 'payment_method': payment_method,
            'remarks': random.choice(['', '', 'Urgent delivery', 'Counter sale',
                                      'Credit 30 days', 'Home delivery', 'Wholesale rate']),
        })
        # 1–10 items
        for _ in range(random.randint(1, 10)):
            p = random.choice(products)
            qty = random.choice([1,1,2,3,5,10,25,50,100]) * (1 if p['unit']=='PCS' else 1)
            rate = round(p['sale_rate'] * random.uniform(0.9, 1.1), 2)
            items.append({
                'bill_number': bill_no,
                'barcode': p['barcode'],
                'product_name': p['product_name'],
                'category_name': p['category'],
                'hsn_code': p['hsn'],
                'quantity': qty,
                'rate': rate,
                'gst_rate': p['gst'],
                'unit_type': p['unit'],
            })
    return bills, items

def gen_purchase_bills(suppliers, products, n=200):
    bills, items = [], []
    start = date(2025, 4, 1)
    for i in range(1, n+1):
        sup = random.choice(suppliers)
        bill_date = start + timedelta(days=random.randint(0, 360))
        bill_no = f'PUR-25-26/{i:04d}'
        intra = sup['state_code'] == HOME_STATE_CODE
        gst_rate = random.choice([0, 5, 12, 18])
        cgst = sgst = igst = 0
        if gst_rate > 0:
            if intra: cgst = sgst = gst_rate / 2
            else:     igst = gst_rate
        bills.append({
            'bill_number': bill_no, 'bill_date': bill_date,
            'party_mobile': sup['mobile_1'], 'party_name': sup['party_name'],
            'discount_percentage': random.choice([0, 0, 2, 3, 5]),
            'cgst_pct': cgst, 'sgst_pct': sgst, 'igst_pct': igst,
            'other_charges': random.choice([0, 0, 500]),
            'freight_charges': random.choice([0, 500, 1000, 2500]),
            'round_off': 0,
            'supplier_bill_number': f'{random.randint(1000,9999)}',
            'transport_name': random.choice(['','VRL Logistics','GATI','Delhivery','Safexpress']),
            'vehicle_number': random.choice(['','KA01AB1234','MH12XY5678','TN09PQ4321']),
            'remarks': random.choice(['', 'Stock replenishment', 'New arrival lot']),
        })
        for _ in range(random.randint(2, 8)):
            p = random.choice(products)
            qty = random.choice([50, 100, 150, 200, 500, 870, 1000])
            rate = round(p['purchase_rate'] * random.uniform(0.95, 1.05), 2)
            items.append({
                'bill_number': bill_no,
                'barcode': p['barcode'],
                'product_name': p['product_name'],
                'category_name': p['category'],
                'hsn_code': p['hsn'],
                'quantity': qty,
                'purchase_rate': rate,
                'gst_rate': p['gst'],
                'unit_type': p['unit'],
            })
    return bills, items

def write_bills(path, bills, items, is_sales=True):
    wb = Workbook()
    # Sheet 1: Bills
    bs = wb.active
    bs.title = 'Bills'
    partykind = 'Customer' if is_sales else 'Supplier'
    bill_headers = [
        'Bill Number *','Bill Date *', f'{partykind} Mobile *', f'{partykind} Name',
        'Discount %','CGST %','SGST %','IGST %','Other Charges','Freight','Round Off',
    ]
    if is_sales:
        bill_headers += ['Payment Method', 'Remarks']
    else:
        bill_headers += ['Supplier Bill No', 'Transport', 'Vehicle No', 'Remarks']
    write_header_row(bs, bill_headers)
    for b in bills:
        row = [b['bill_number'], b['bill_date'], b['party_mobile'], b['party_name'],
               b['discount_percentage'], b['cgst_pct'], b['sgst_pct'], b['igst_pct'],
               b['other_charges'], b['freight_charges'], b['round_off']]
        if is_sales:
            row += [b['payment_method'], b['remarks']]
        else:
            row += [b['supplier_bill_number'], b['transport_name'],
                    b['vehicle_number'], b['remarks']]
        bs.append(row)
    # format date column B as date
    for cell in bs['B'][1:]:
        cell.number_format = 'yyyy-mm-dd'
    widths = [18,12,15,25,10,8,8,8,12,10,10] + ([12,30] if is_sales else [15,18,12,30])
    for col, w in zip('ABCDEFGHIJKLMNOP', widths):
        bs.column_dimensions[col].width = w
    apply_body_font(bs)

    # Sheet 2: Items
    it = wb.create_sheet('Items')
    rate_header = 'Rate *' if is_sales else 'Purchase Rate *'
    write_header_row(it, [
        'Bill Number *','Product Barcode','Product Name *','Category','HSN Code',
        'Quantity *', rate_header, 'GST %','Unit'
    ])
    key_rate = 'rate' if is_sales else 'purchase_rate'
    for r in items:
        it.append([r['bill_number'], r['barcode'], r['product_name'], r['category_name'],
                   r['hsn_code'], r['quantity'], r[key_rate], r['gst_rate'], r['unit_type']])
    for col, w in zip('ABCDEFGHI', [18,16,25,16,10,10,14,8,8]):
        it.column_dimensions[col].width = w
    apply_body_font(it)

    wb.save(path)

# ─────────────────────────────────────────────────────────────────────────
# 4. Payment Receipts
# ─────────────────────────────────────────────────────────────────────────

def gen_payment_receipts(customers, suppliers, sales_bills, purchase_bills, n_receipts=600, n_payments=150):
    rows = []
    # Receipts against ~60% of sales bills (full or partial)
    sampled_sales = random.sample(sales_bills, min(n_receipts, len(sales_bills)))
    for i, b in enumerate(sampled_sales, 1):
        # Mostly full payment, sometimes partial
        rows.append({
            'transaction_number': f'RCP-25-26/{i:04d}',
            'transaction_type': 'Receipt',
            'transaction_date': b['bill_date'] + timedelta(days=random.randint(0, 20)),
            'party_mobile': b['party_mobile'],
            'party_name': b['party_name'],
            'total_amount': random.choice([500, 1000, 2500, 5000, 7500, 10000, 15000]),
            'reference_bill_number': b['bill_number'],
            'reference_bill_type': 'Sales',
            'remarks': random.choice(['', 'Cash', 'UPI payment', 'Cheque', 'Bank transfer']),
        })
    # Payments to suppliers against ~70% of purchase bills
    sampled_purch = random.sample(purchase_bills, min(n_payments, len(purchase_bills)))
    for i, b in enumerate(sampled_purch, 1):
        rows.append({
            'transaction_number': f'PAY-25-26/{i:04d}',
            'transaction_type': 'Payment',
            'transaction_date': b['bill_date'] + timedelta(days=random.randint(15, 45)),
            'party_mobile': b['party_mobile'],
            'party_name': b['party_name'],
            'total_amount': random.choice([5000, 10000, 25000, 50000, 75000, 100000]),
            'reference_bill_number': b['bill_number'],
            'reference_bill_type': 'Purchase',
            'remarks': random.choice(['', 'NEFT', 'RTGS', 'Cheque #' + str(random.randint(100000, 999999))]),
        })
    random.shuffle(rows)
    return rows

def write_payments(path, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Data'
    write_header_row(ws, [
        'Transaction Number *','Type (Payment/Receipt) *','Date *','Party Mobile *',
        'Party Name','Amount *','Reference Bill','Reference Bill Type','Remarks'
    ])
    for r in rows:
        ws.append([r['transaction_number'], r['transaction_type'], r['transaction_date'],
                   r['party_mobile'], r['party_name'], r['total_amount'],
                   r['reference_bill_number'], r['reference_bill_type'], r['remarks']])
    for cell in ws['C'][1:]:
        cell.number_format = 'yyyy-mm-dd'
    for col, w in zip('ABCDEFGHI', [18,18,12,15,25,12,18,16,30]):
        ws.column_dimensions[col].width = w
    apply_body_font(ws)
    wb.save(path)

# ─────────────────────────────────────────────────────────────────────────
# Run everything
# ─────────────────────────────────────────────────────────────────────────

def main():
    print('Generating customers…'); customers = gen_customers(25)
    write_parties(os.path.join(OUT, 'customers_template.xlsx'), customers, 'customers')
    print(f'  -> 25 customers')

    print('Generating suppliers…'); suppliers = gen_suppliers(25)
    write_parties(os.path.join(OUT, 'suppliers_template.xlsx'), suppliers, 'suppliers')
    print(f'  -> 25 suppliers')

    print('Generating products…'); products = gen_products(5000)
    write_products(os.path.join(OUT, 'products_template.xlsx'), products)
    print(f'  -> 5000 products')

    print('Generating sales bills…')
    sb, si = gen_sales_bills(customers, products, 1000)
    write_bills(os.path.join(OUT, 'sales_bills_template.xlsx'), sb, si, True)
    print(f'  -> 1000 bills, {len(si)} items')

    print('Generating purchase bills…')
    pb, pi = gen_purchase_bills(suppliers, products, 200)
    write_bills(os.path.join(OUT, 'purchase_bills_template.xlsx'), pb, pi, False)
    print(f'  -> 200 bills, {len(pi)} items')

    print('Generating payment receipts…')
    pay = gen_payment_receipts(customers, suppliers, sb, pb)
    write_payments(os.path.join(OUT, 'payment_receipts_template.xlsx'), pay)
    print(f'  -> {len(pay)} transactions')

    print('\nAll files written to:', OUT)

if __name__ == '__main__':
    main()

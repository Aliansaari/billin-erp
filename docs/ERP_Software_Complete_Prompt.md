# Complete ERP & Billing Software - Comprehensive Development Specification

## PROJECT OVERVIEW
Build a full-featured, industrial-grade ERP and Billing software designed primarily for wholesale business with multi-purpose capabilities. The software must handle 5-10 simultaneous users, support cross-platform operation (Windows, Mac, and web-based access), and manage large-scale data operations at industrial/practical levels with real-time multi-computer synchronization via LAN.

---

## CORE ARCHITECTURE & DATABASE

### Database Requirements
- **Database Engine**: Use PostgreSQL or MySQL for robust, industrial-level data handling
- **Performance**: Must handle millions of records without performance degradation
- **Concurrent Access**: Support 5-10 simultaneous users with proper transaction locking
- **Network Architecture**: 
  - LAN-based synchronization (primary requirement)
  - Real-time data sync across multiple computers via cable network
  - Optional: Explore peer-to-peer or client-server architecture for wireless access
- **Data Integrity**: 
  - ACID compliance for all transactions
  - Foreign key constraints
  - Proper indexing on frequently queried fields (barcode, party names, bill numbers, dates)
  - Transaction rollback capabilities
- **Backup System**:
  - User-configurable auto-backup frequency (hourly, daily, weekly)
  - Local backup storage with compression
  - One-click manual backup option
  - Backup restoration with version history
  - Backup before critical operations (year-end closing, data deletion)

### Database Schema - Core Tables

#### 1. Users & Authentication
```
users_table:
- user_id (Primary Key, Auto-increment)
- username (Unique, Not Null)
- password_hash (Encrypted)
- full_name
- email
- mobile_number
- role_id (Foreign Key to roles_table)
- is_active (Boolean)
- created_date
- last_login
- created_by
- modified_date
```

```
roles_table:
- role_id (Primary Key)
- role_name (Admin, Manager, Cashier, Inventory Staff, Accountant, Sales Staff)
- permissions_json (JSON field storing module-wise permissions)
- can_view_reports (Boolean)
- can_delete_bills (Boolean)
- can_edit_rates (Boolean)
- can_access_accounts (Boolean)
- can_manage_users (Boolean)
```

#### 2. Parties (Customers & Suppliers)
```
parties_table:
- party_id (Primary Key, Auto-increment)
- party_type (ENUM: 'Customer', 'Supplier', 'Both')
- party_name (Not Null, Indexed)
- display_name
- mobile_1 (Indexed)
- mobile_2
- email
- address_line_1
- address_line_2
- city
- state
- pincode
- country
- gstin
- pan_number
- aadhar_number
- credit_allowed (Boolean)
- credit_limit (Decimal 15,2)
- credit_days (Integer)
- opening_balance (Decimal 15,2)
- opening_balance_type (ENUM: 'Receivable', 'Payable')
- current_balance (Decimal 15,2)
- interest_rate (Decimal 5,2) - for overdue calculation
- party_status (ENUM: 'Regular', 'Priority', 'VIP', 'Blacklist')
- is_active (Boolean, Default: True)
- created_date
- modified_date
- created_by (Foreign Key to users_table)
```

#### 3. Product Master & Barcode System
```
products_master:
- product_id (Primary Key, Auto-increment)
- barcode (Unique, Not Null, Indexed) - Auto-generated
- category_id (Foreign Key to categories_table)
- product_name (Not Null, Indexed)
- product_description
- size_value
- size_unit (ENUM: 'S', 'M', 'L', 'XL', 'XXL', 'Numeric', 'Custom')
- article_number (Indexed)
- hsn_code
- gst_rate (Decimal 5,2)
- cess_rate (Decimal 5,2)
- unit_of_measurement (ENUM: 'PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN')
- quantity_per_box (Integer)
- minimum_stock_level (Decimal 10,2)
- maximum_stock_level (Decimal 10,2)
- reorder_level (Decimal 10,2)
- current_stock (Decimal 10,2) - Real-time calculated
- warehouse_id (Foreign Key - if multi-warehouse enabled)
- batch_tracking_enabled (Boolean)
- expiry_tracking_enabled (Boolean)
- serial_tracking_enabled (Boolean)
- purchase_rate (Decimal 15,2) - Last purchase rate
- margin_percentage (Decimal 5,2)
- sale_rate (Decimal 15,2)
- mrp (Decimal 15,2)
- is_active (Boolean)
- created_date
- modified_date
```

```
categories_table:
- category_id (Primary Key)
- category_name (Unique, Not Null)
- parent_category_id (Self-referencing for sub-categories)
- category_code
- is_active (Boolean)
```

```
barcode_settings:
- setting_id (Primary Key)
- prefix (String, e.g., "PROD", "INV")
- starting_number (Integer)
- current_number (Integer)
- total_digits (Integer, e.g., 10 for total barcode length)
- format_pattern (e.g., "PREFIX-NNNNNN")
```

#### 4. Purchase Bills
```
purchase_bills:
- purchase_bill_id (Primary Key, Auto-increment)
- bill_number (Auto-generated, Unique, Indexed)
- supplier_id (Foreign Key to parties_table)
- supplier_bill_number (Supplier's invoice number)
- bill_date (Date, Indexed)
- due_date (Date)
- transport_name
- vehicle_number
- lr_number (Lorry Receipt Number)
- total_items (Integer)
- total_quantity (Decimal 10,2)
- sub_total (Decimal 15,2)
- discount_amount (Decimal 15,2)
- discount_percentage (Decimal 5,2)
- cgst_amount (Decimal 15,2)
- sgst_amount (Decimal 15,2)
- igst_amount (Decimal 15,2)
- cess_amount (Decimal 15,2)
- round_off (Decimal 10,2)
- total_amount (Decimal 15,2)
- paid_amount (Decimal 15,2)
- balance_amount (Decimal 15,2)
- payment_status (ENUM: 'Paid', 'Partial', 'Unpaid')
- remarks
- warehouse_id (Foreign Key - if enabled)
- created_by (Foreign Key to users_table)
- created_date
- modified_date
- is_cancelled (Boolean)
- cancelled_by
- cancelled_date
```

```
purchase_bill_items:
- item_id (Primary Key, Auto-increment)
- purchase_bill_id (Foreign Key)
- product_id (Foreign Key)
- barcode (Indexed)
- category_name
- product_name
- size
- article_number
- hsn_code
- quantity (Decimal 10,2)
- quantity_per_box (Integer)
- free_quantity (Decimal 10,2)
- purchase_rate (Decimal 15,2)
- margin_percentage (Decimal 5,2)
- sale_rate (Decimal 15,2)
- mrp (Decimal 15,2)
- discount_percentage (Decimal 5,2)
- discount_amount (Decimal 15,2)
- taxable_amount (Decimal 15,2)
- gst_rate (Decimal 5,2)
- cgst_amount (Decimal 15,2)
- sgst_amount (Decimal 15,2)
- igst_amount (Decimal 15,2)
- cess_amount (Decimal 15,2)
- total_amount (Decimal 15,2)
- batch_number (if batch tracking enabled)
- expiry_date (if expiry tracking enabled)
- serial_numbers (JSON array - if serial tracking enabled)
```

#### 5. Sales Bills
```
sales_bills:
- sales_bill_id (Primary Key, Auto-increment)
- bill_number (Auto-generated, Unique, Indexed)
- customer_id (Foreign Key to parties_table)
- bill_date (Date, Indexed)
- due_date (Date)
- sales_person (Foreign Key to users_table)
- total_items (Integer)
- total_quantity (Decimal 10,2)
- sub_total (Decimal 15,2)
- discount_amount (Decimal 15,2)
- discount_percentage (Decimal 5,2)
- cgst_amount (Decimal 15,2)
- sgst_amount (Decimal 15,2)
- igst_amount (Decimal 15,2)
- cess_amount (Decimal 15,2)
- round_off (Decimal 10,2)
- total_amount (Decimal 15,2)
- paid_amount (Decimal 15,2)
- balance_amount (Decimal 15,2)
- payment_status (ENUM: 'Paid', 'Partial', 'Unpaid')
- remarks
- warehouse_id (Foreign Key - if enabled)
- created_by (Foreign Key to users_table)
- created_date
- modified_date
- is_cancelled (Boolean)
- cancelled_by
- cancelled_date
```

```
sales_bill_items:
- item_id (Primary Key, Auto-increment)
- sales_bill_id (Foreign Key)
- product_id (Foreign Key)
- barcode (Indexed)
- category_name
- product_name
- size
- article_number
- hsn_code
- quantity (Decimal 10,2)
- rate (Decimal 15,2)
- mrp (Decimal 15,2)
- discount_percentage (Decimal 5,2)
- discount_amount (Decimal 15,2)
- taxable_amount (Decimal 15,2)
- gst_rate (Decimal 5,2)
- cgst_amount (Decimal 15,2)
- sgst_amount (Decimal 15,2)
- igst_amount (Decimal 15,2)
- cess_amount (Decimal 15,2)
- total_amount (Decimal 15,2)
- batch_number (if batch tracking enabled)
- serial_numbers (JSON array - if serial tracking enabled)
```

#### 6. Payments & Receipts
```
payments_receipts:
- transaction_id (Primary Key, Auto-increment)
- transaction_number (Auto-generated, Unique)
- transaction_type (ENUM: 'Payment', 'Receipt')
- transaction_date (Date, Indexed)
- party_id (Foreign Key to parties_table)
- reference_bill_id (Foreign Key - optional, links to sales/purchase bill)
- reference_bill_number
- total_amount (Decimal 15,2)
- remarks
- created_by (Foreign Key to users_table)
- created_date
- modified_date
- is_cancelled (Boolean)
```

```
payment_splits:
- split_id (Primary Key, Auto-increment)
- transaction_id (Foreign Key to payments_receipts)
- payment_mode (ENUM: 'Cash', 'Card', 'UPI', 'Cheque', 'Bank Transfer', 'Credit')
- amount (Decimal 15,2)
- bank_name
- cheque_number
- cheque_date
- upi_transaction_id
- card_last_4_digits
- bank_account_id (Foreign Key to bank_accounts - if enabled)
```

#### 7. Stock Management
```
stock_ledger:
- ledger_id (Primary Key, Auto-increment)
- product_id (Foreign Key)
- barcode (Indexed)
- transaction_type (ENUM: 'Purchase', 'Sales', 'Purchase Return', 'Sales Return', 'Stock Adjustment', 'Stock Transfer', 'Opening Stock')
- transaction_date (Date, Indexed)
- reference_id (Foreign Key - bill_id based on transaction_type)
- reference_number
- batch_number
- warehouse_id (Foreign Key - if enabled)
- quantity_in (Decimal 10,2)
- quantity_out (Decimal 10,2)
- rate (Decimal 15,2)
- balance_quantity (Decimal 10,2)
- remarks
- created_by (Foreign Key to users_table)
- created_date
```

```
batch_details:
- batch_id (Primary Key, Auto-increment)
- product_id (Foreign Key)
- batch_number (Indexed)
- manufacturing_date (Date)
- expiry_date (Date)
- quantity (Decimal 10,2)
- purchase_rate (Decimal 15,2)
- mrp (Decimal 15,2)
- warehouse_id (Foreign Key - if enabled)
- is_expired (Boolean, Computed)
```

#### 8. Accounting Ledgers
```
ledger_accounts:
- ledger_id (Primary Key, Auto-increment)
- ledger_name (Unique, Not Null)
- ledger_group (ENUM: 'Assets', 'Liabilities', 'Income', 'Expenses', 'Capital')
- sub_group
- opening_balance (Decimal 15,2)
- opening_balance_type (ENUM: 'Debit', 'Credit')
- current_balance (Decimal 15,2)
- is_system_ledger (Boolean) - for built-in ledgers like Cash, Bank
- is_active (Boolean)
- created_date
```

```
ledger_entries:
- entry_id (Primary Key, Auto-increment)
- entry_number (Auto-generated, Unique)
- entry_date (Date, Indexed)
- ledger_id (Foreign Key to ledger_accounts)
- debit_amount (Decimal 15,2)
- credit_amount (Decimal 15,2)
- narration
- voucher_type (ENUM: 'Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra')
- reference_id (Foreign Key - links to bills/payments)
- reference_number
- created_by (Foreign Key to users_table)
- created_date
```

#### 9. Bank Accounts (Optional Setting)
```
bank_accounts:
- account_id (Primary Key, Auto-increment)
- account_name
- bank_name
- branch_name
- account_number
- ifsc_code
- account_type (ENUM: 'Savings', 'Current', 'OD')
- opening_balance (Decimal 15,2)
- current_balance (Decimal 15,2)
- is_active (Boolean)
```

```
bank_reconciliation:
- reconciliation_id (Primary Key, Auto-increment)
- account_id (Foreign Key)
- transaction_date (Date)
- cheque_number
- transaction_id (Foreign Key to payments_receipts)
- amount (Decimal 15,2)
- status (ENUM: 'Pending', 'Cleared', 'Bounced')
- cleared_date (Date)
- remarks
```

#### 10. Audit Trail (Optional Setting)
```
audit_log:
- log_id (Primary Key, Auto-increment)
- user_id (Foreign Key to users_table)
- action_type (ENUM: 'Create', 'Update', 'Delete', 'View')
- module_name (ENUM: 'Sales', 'Purchase', 'Payment', 'Product', 'Party', 'Settings')
- record_id (ID of affected record)
- old_value (JSON)
- new_value (JSON)
- ip_address
- timestamp
```

#### 11. System Settings
```
system_settings:
- setting_id (Primary Key)
- company_name
- company_address
- gstin
- pan_number
- logo_path
- financial_year_start (Date)
- financial_year_end (Date)
- gst_enabled (Boolean, Default: False)
- multi_warehouse_enabled (Boolean, Default: False)
- batch_tracking_enabled (Boolean, Default: False)
- expiry_tracking_enabled (Boolean, Default: False)
- serial_tracking_enabled (Boolean, Default: False)
- audit_trail_enabled (Boolean, Default: False)
- interest_calculation_enabled (Boolean, Default: False)
- bank_reconciliation_enabled (Boolean, Default: False)
- manufacturing_module_enabled (Boolean, Default: False)
- low_stock_alert_enabled (Boolean, Default: True)
- backup_frequency (ENUM: 'Hourly', 'Daily', 'Weekly', 'Manual')
- last_backup_date
```

---

## USER INTERFACE DESIGN

### 1. LOGIN SCREEN
**Layout:**
- Clean, modern centered login card with company logo at top
- Username field (text input with icon)
- Password field (password input with show/hide toggle icon)
- "Remember Me" checkbox
- "Login" button (full-width, primary color)
- Forgot Password link (if admin wants to enable)
- Software version number at bottom right

**Functionality:**
- Username/password validation
- Role-based authentication
- Session management (auto-logout after inactivity)
- Login attempt tracking (lock account after 5 failed attempts)
- Display last login date/time after successful login

**Security:**
- Password hashing (bcrypt or Argon2)
- SQL injection prevention
- Session token generation
- HTTPS enforcement (for web version)

---

### 2. MAIN DASHBOARD SCREEN

**Layout Structure:**
```
┌─────────────────────────────────────────────────────────────┐
│  [Logo] COMPANY NAME        [User: John] [Settings] [Logout]│
├───────────┬─────────────────────────────────────────────────┤
│           │                                                 │
│  SIDEBAR  │         MAIN CONTENT AREA                      │
│           │         (Customizable Widgets)                  │
│  (Modern  │                                                 │
│   Menu)   │  [Widget 1] [Widget 2] [Widget 3]              │
│           │  [Widget 4] [Widget 5] [Widget 6]              │
│           │                                                 │
│           │                                                 │
│ [< Hide]  │                                                 │
└───────────┴─────────────────────────────────────────────────┘
```

**Sidebar Menu (Collapsible/Expandable):**
- **Modern Design**: Icons + Text (collapses to icon-only when hidden)
- **Color Scheme**: Dark sidebar with accent colors for active items
- **Hover Effects**: Smooth transitions and highlights

**Menu Structure:**
```
├─ 📊 Dashboard (Home)
├─ 📝 Sales
│  ├─ New Sales Bill
│  ├─ Sales List
│  └─ Sales Returns
├─ 🛒 Purchase
│  ├─ New Purchase Bill
│  ├─ Purchase List
│  └─ Purchase Returns
├─ 👥 Parties
│  ├─ Customers
│  ├─ Suppliers
│  └─ Add New Party
├─ 📦 Inventory
│  ├─ Products List
│  ├─ Add Product
│  ├─ Categories
│  ├─ Stock Report
│  ├─ Low Stock Alert
│  └─ Stock Adjustment
├─ 💰 Payments
│  ├─ Payment Entry
│  ├─ Receipt Entry
│  ├─ Payment List
│  └─ Receipt List
├─ 📈 Reports
│  ├─ Sales Reports
│  ├─ Purchase Reports
│  ├─ Stock Reports
│  ├─ Party Ledgers
│  ├─ Profit & Loss
│  ├─ Balance Sheet
│  ├─ Cash Flow
│  ├─ GST Reports (if enabled)
│  └─ Custom Reports
├─ 📊 Accounts
│  ├─ Ledger Accounts
│  ├─ Voucher Entries
│  ├─ Bank Accounts (if enabled)
│  └─ Bank Reconciliation (if enabled)
├─ 🏭 Manufacturing (if enabled)
│  ├─ Bill of Materials
│  ├─ Work Orders
│  └─ Production Entry
├─ ⚙️ Settings
│  ├─ Company Profile
│  ├─ User Management
│  ├─ Barcode Settings
│  ├─ GST Settings
│  ├─ Dashboard Customization
│  ├─ Module Settings
│  ├─ Backup & Restore
│  └─ System Preferences
└─ 🔍 Search (Global search bar)
```

**Main Dashboard - Customizable Widgets:**

Users can add/remove/rearrange these widgets via Settings > Dashboard Customization:

1. **Today's Sales Summary Widget**
   - Total Sales Amount (₹)
   - Number of Bills
   - Cash Sales vs Credit Sales
   - Average Bill Value
   - Comparison with yesterday (↑/↓ percentage)

2. **Today's Purchase Summary Widget**
   - Total Purchase Amount (₹)
   - Number of Bills
   - Cash Purchase vs Credit Purchase

3. **Total Receivables Widget**
   - Total Amount Pending from Customers (₹)
   - Number of Customers with Pending
   - Overdue Amount (Red highlight)
   - Click to view detailed party-wise list

4. **Total Payables Widget**
   - Total Amount Pending to Suppliers (₹)
   - Number of Suppliers with Pending
   - Overdue Amount (Red highlight)
   - Click to view detailed party-wise list

5. **Low Stock Alert Widget**
   - Number of Products Below Minimum Level
   - List of top 5 low-stock items with current quantity
   - Color-coded urgency (Red: Critical, Yellow: Warning)
   - Click to view full low-stock report

6. **Quick Stats Widget**
   - This Month's Sales
   - This Month's Purchase
   - Current Month Profit
   - Stock Value (total inventory value)

7. **Recent Bills Widget**
   - Last 10 sales/purchase bills
   - Scrollable list with bill number, party name, amount, date

8. **Pending Payments Widget**
   - List of upcoming due dates
   - Today's collections pending
   - This week's due payments

9. **Top Customers/Products Widget**
   - Top 5 customers by sales value (this month)
   - Top 5 selling products (this month)

10. **Profit/Loss Overview Widget**
    - Current month P&L summary
    - Graphical representation (bar/line chart)

**Quick Action Buttons (Customizable):**
- Large, colorful action buttons positioned prominently
- Default buttons: [+ New Sale] [+ New Purchase] [+ Payment] [+ Receipt]
- Users can add custom buttons via settings (e.g., Stock Adjustment, Add Product)
- Each button opens respective form in a modal or new window

**Dashboard Customization Interface:**
- Drag-and-drop widget placement
- Widget size options (small, medium, large)
- Show/hide toggle for each widget
- Color theme selection (Light, Dark, Custom)
- Reset to default layout option

---

### 3. CUSTOMER / SUPPLIER MANAGEMENT

#### Customer Tab Screen

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  CUSTOMERS                                    [+ Add Customer]│
├─────────────────────────────────────────────────────────────┤
│  🔍 Search: [________________] [By: Name ▼] [Active ▼]       │
│      Options: Name | Mobile | Bill Number | Barcode          │
├──────────┬──────────┬─────────┬──────────┬─────────┬────────┤
│ Customer │ Mobile   │ Balance │  Status  │ Actions │ Active │
│   Name   │          │   (₹)   │          │         │        │
├──────────┼──────────┼─────────┼──────────┼─────────┼────────┤
│ ABC Ltd  │ 98765... │ 45,000  │ Priority │ 👁 ✏️ 💸│   ✓    │
│ XYZ Corp │ 98234... │ -2,000  │ VIP      │ 👁 ✏️ 💸│   ✓    │
│ ...      │ ...      │ ...     │ ...      │ ...     │   ...  │
└──────────┴──────────┴─────────┴──────────┴─────────┴────────┘
```

**Search Functionality:**
- Real-time search (updates as user types)
- Search by:
  - Customer Name (partial match)
  - Mobile Number
  - Bill Number (shows customer who has that bill)
  - Barcode (shows bills containing that product)
- Filter by:
  - Active/Inactive customers
  - Customer Status (All, Regular, Priority, VIP, Blacklist)
  - Balance status (All, Receivable, Payable, No Dues)
- Sort by: Name (A-Z/Z-A), Balance (High to Low/Low to High), Last Transaction Date

**Customer Row Actions:**
- 👁️ **View**: Opens customer detail popup showing:
  - Full customer information
  - All sales bills (scrollable list)
  - Payment history
  - Current balance
  - Credit utilization
  - Transaction timeline
- ✏️ **Edit**: Opens edit form (same as add form, pre-filled)
- 💸 **Quick Payment**: Opens receipt entry form with customer pre-selected
- Toggle **Active/Deactive** status

**Clicking on Customer Name:**
- Opens detailed view with tabs:
  - **Bills Tab**: All sales bills in table format
    - Columns: Bill No., Date, Total Amount, Paid, Balance, Status, Actions (View, Print, Edit)
    - Filter by date range, payment status
    - Export to Excel/PDF
  - **Payments Tab**: All receipts/payments
    - Columns: Receipt No., Date, Amount, Mode, Reference Bill, Actions
  - **Ledger Tab**: Complete account statement (classic accounting-style)
    - Date | Particulars | Debit | Credit | Balance
    - Opening balance at top
    - All sales bills as debits
    - All payments as credits
    - Running balance column
    - Closing balance at bottom
  - **Info Tab**: Customer details with edit option

#### Add/Edit Customer Form

**Form Layout (Modal or Side Panel):**
```
Add Customer
─────────────────────────────
* Customer Name:    [________________]
  Display Name:     [________________]
  
* Mobile 1:         [________________]
  Mobile 2:         [________________]
  Email:            [________________]
  
Address:
  Address Line 1:   [________________]
  Address Line 2:   [________________]
  City:             [________________]
  State:            [Select State ▼]
  Pincode:          [______]
  
Tax Information:
  GSTIN:            [________________]
  PAN Number:       [________________]
  Aadhar Number:    [________________]
  
Credit Settings:
  ☐ Credit Allowed
  Credit Limit (₹): [________________]
  Credit Days:      [___] days
  Interest Rate (%): [___] (for overdue)
  
Opening Balance:
  Amount (₹):       [________________]
  Type:             ⚪ Receivable  ⚪ Payable
  
Customer Status:   ⚪ Regular  ⚪ Priority  ⚪ VIP
Active Status:     ☑ Active  ☐ Inactive

[Cancel]  [Save]
─────────────────────────────
* = Required fields (only Name and Mobile 1)
```

**Form Validation:**
- Customer Name: Required, minimum 2 characters
- Mobile 1: Required, 10 digits, numeric only
- Email: Valid email format if entered
- GSTIN: Valid 15-character format if entered
- PAN: Valid 10-character format if entered
- Credit Limit: Numeric, positive value
- If "Credit Allowed" is unchecked, credit limit and days are disabled

**Form Behavior:**
- Auto-save draft every 30 seconds (optional)
- Warning before closing with unsaved changes
- Tab/Enter navigation between fields
- Auto-capitalize customer name
- Phone number formatting (add spaces for readability)

#### Supplier Tab Screen
- **Identical structure to Customer Tab** but for suppliers
- Search and filter options same as customer
- View shows **Purchase Bills** instead of Sales Bills
- Ledger shows purchases as credits, payments as debits

---

### 4. PURCHASE BILL WINDOW

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│  NEW PURCHASE BILL                        Bill No: PUR-000001  │
│  Date: [02-04-2026 ▼]                                          │
├────────────────────────────────────────────────────────────────┤
│  Supplier: [Search by name/mobile...      ] [+ Add Supplier]   │
│  Supplier Bill No: [________________]  Due Date: [________▼]   │
│  Transport: [________________]  Vehicle No: [________________] │
│  LR Number: [________________]                                 │
├────────────────────────────────────────────────────────────────┤
│                     ITEM ENTRY AREA (FIXED HEADER)             │
├───────┬─────────┬────────┬──────┬────────┬────┬─────┬────┬────┤
│Barcode│Category │Product │ Size │Article │Qty │ Qty │ MG │Rate│
│  No   │  Name   │  Name  │      │   No   │    │ Box │ %  │    │
├───────┼─────────┼────────┼──────┼────────┼────┼─────┼────┼────┤
│[_____]│[_______]│[______]│[____]│[______]│[__]│ [__]│[__]│[__]│ <- Entry Row
├───────┴─────────┴────────┴──────┴────────┴────┴─────┴────┴────┤
│                     ITEMS LIST (SCROLLABLE)                    │
├───────┬─────────┬────────┬──────┬────────┬────┬─────┬────┬────┤
│123456 │Textile  │Cotton  │ M    │ART-001 │ 50 │ 5   │ 20 │100 │
│123457 │Textile  │Cotton  │ L    │ART-001 │ 30 │ 3   │ 20 │120 │
│...    │...      │...     │...   │...     │... │ ... │... │... │
└───────┴─────────┴────────┴──────┴────────┴────┴─────┴────┴────┘
│                                                                │
│  Sub Total:           [___________]                           │
│  Discount (%):  [___] Discount (₹): [___________]             │
│  Taxable Amount:      [___________]                           │
│  CGST @ _%:           [___________]                           │
│  SGST @ _%:           [___________]                           │
│  IGST @ _%:           [___________]  (if interstate)          │
│  Round Off:           [___________]  (auto-calculated)        │
│  ─────────────────────────────────                            │
│  TOTAL AMOUNT:        [___________] (Read-only, Bold)         │
│                                                                │
│  Amount Entered:      [___________] (User input)              │
│  Balance:             [___________] (Auto: Total - Entered)   │
│                                                                │
│  [Save & Pay] [Save as Credit] [Print] [Cancel]               │
└────────────────────────────────────────────────────────────────┘
```

**Detailed Field Specifications:**

**Header Section:**
1. **Bill Number**: Auto-generated based on format (e.g., PUR-YYYYMMDD-001), displayed prominently
2. **Bill Date**: Date picker, defaults to today, allows back-dating (with permission)
3. **Supplier Field**: 
   - Autocomplete search (type-ahead)
   - Search by name OR mobile number
   - Shows dropdown with matching results
   - Displays: Supplier Name | Mobile | Current Balance
   - If no match: "+ Add New Supplier" option appears
   - Mandatory field validation
4. **Add Supplier Button**: Opens quick-add supplier form (minimal fields: Name, Mobile, Credit Allowed)
5. **Supplier Bill Number**: Text field for supplier's invoice reference
6. **Due Date**: 
   - Date picker
   - Auto-calculates based on supplier's credit days
   - If supplier is cash party: disabled or set to same date
7. **Transport Name**: Text field, optional
8. **Vehicle Number**: Text field, optional
9. **LR Number**: Text field, optional (Lorry Receipt for transport tracking)

**Item Entry Row (Fixed at Top):**

Entry flow: Barcode → Category → Product → Size → Article → Purchase Rate → Quantity → Qty per Box → Margin % → Sale Rate → [Enter to Add]

**Field-by-Field Behavior:**

1. **Barcode No Field**:
   - Primary entry point
   - Auto-focus when screen opens
   - On scan/type + Enter:
     - If barcode exists in database:
       - Auto-fill ALL fields (Category, Product, Size, Article, Last Purchase Rate, Sale Rate)
       - Cursor jumps to Quantity field
       - If Qty per Box is set: prompts "Enter boxes or pieces?"
     - If barcode doesn't exist:
       - Stays empty, allows manual entry in other fields
       - System will generate new barcode upon saving

2. **Category Name Field**:
   - Dropdown with autocomplete
   - Shows all existing categories
   - Type to filter
   - If new category typed: asks "Create new category?"
   - On select + Tab/Enter: moves to Product Name

3. **Product Name Field**:
   - Dropdown with autocomplete
   - Filters products by selected category
   - Type to filter
   - If new product typed: prepares to create new product entry
   - On select + Tab/Enter: moves to Size

4. **Size Field**:
   - Dropdown or text input
   - Predefined sizes: S, M, L, XL, XXL, or numeric
   - Custom size allowed
   - On select + Tab/Enter: moves to Article No

5. **Article Number Field**:
   - Text input
   - Auto-suggests existing article numbers
   - Can be left blank
   - On Tab/Enter: moves to Purchase Rate

6. **Purchase Rate Field**:
   - Numeric input (decimal allowed)
   - Mandatory field
   - If product exists: shows last purchase rate as placeholder
   - On Tab/Enter: moves to Quantity

7. **Quantity Field**:
   - Numeric input (decimal allowed for weight-based items)
   - Mandatory field
   - On Tab/Enter: moves to Qty per Box

8. **Quantity per Box Field**:
   - Numeric input (integer)
   - Optional field
   - If filled: system calculates total pieces from box quantity
   - Example: 5 boxes × 10 per box = 50 pieces
   - On Tab/Enter: moves to Margin %

9. **Margin % Field**:
   - Numeric input (decimal)
   - System auto-calculates Sale Rate = Purchase Rate × (1 + Margin%/100)
   - On change: updates Sale Rate field in real-time
   - On Tab/Enter: moves to Sale Rate (for manual override)

10. **Sale Rate Field** (in extended view, may scroll right):
    - Numeric input (decimal)
    - Auto-calculated from Margin %
    - Can be manually overridden
    - If manually changed: Margin % recalculates
    - On Enter: **Adds item to list below**

**Smart Barcode Detection Logic:**
When barcode is entered, system checks:
```
IF (Category + Product Name + Size + Article Number + Purchase Rate + Sale Rate) 
   matches existing product:
   → Use existing barcode
ELSE:
   → Generate new barcode
```

**Items List Section:**
- **Scrollable table** showing all added items
- **Columns**: Barcode | Category | Product | Size | Article | Quantity | Qty/Box | Margin | Purchase Rate | Sale Rate | GST% | Amount | [Delete 🗑️]
- **Row Actions**:
  - Click on row: Loads data back to entry row for editing
  - Delete icon: Removes item with confirmation
- **Real-time calculations**:
  - Amount = Quantity × Purchase Rate
  - If GST enabled: calculates tax on each item

**Totals Section (Bottom):**
- **Sub Total**: Sum of all item amounts (auto-calculated)
- **Discount %**: If entered, calculates Discount Amount
- **Discount Amount**: If entered directly, calculates Discount %
- **Taxable Amount**: Sub Total - Discount (auto-calculated)
- **CGST/SGST/IGST**: 
  - If GST enabled and supplier has GSTIN:
    - Intra-state (same state): Shows CGST + SGST (split equally)
    - Inter-state (different state): Shows IGST only
  - Tax rates pulled from product master
  - Auto-calculated on taxable amount
- **Round Off**: Auto-calculated (rounds total to nearest rupee)
  - Example: ₹1,234.67 → Round off: -0.67 → Total: ₹1,234.00
  - Can be manually adjusted
- **TOTAL AMOUNT**: 
  - Grand total (Taxable + Taxes + Round Off)
  - **Large, bold, highlighted**
  - Read-only field

**Payment Section:**
- **Amount Entered**: 
  - User input field
  - Defaults to Total Amount (full payment)
  - Can be partial or zero
- **Balance**: Auto-calculated (Total - Amount Entered)
  - If Balance > 0: Shows in red (credit purchase)
  - If Balance = 0: Shows in green (paid)
  - If Balance < 0: Shows as advance (if allowed)

**Action Buttons:**
1. **Save & Pay**: 
   - Validates Amount Entered = Total Amount
   - If matched: Saves bill with status "Paid"
   - If not matched: Shows error "Amount mismatch!"
   - Opens payment mode selection (Cash, Card, UPI, etc.)
2. **Save as Credit**: 
   - Saves bill with Payment Status = "Unpaid" or "Partial"
   - Updates supplier's balance
   - Validates credit limit (if set)
3. **Print**: 
   - After saving: Opens print preview
   - Options: A4 format, Thermal receipt, or both
4. **Cancel**: 
   - Confirms "Discard this bill?"
   - Clears all fields

**Validation & Error Handling:**
- Supplier must be selected
- At least 1 item must be added
- All mandatory fields in items must be filled
- Quantity must be > 0
- Rates must be > 0
- If credit purchase: Check credit limit not exceeded (warning, not block)
- Duplicate barcode with different specs: Alerts user, generates new barcode

**Keyboard Shortcuts:**
- **Ctrl + S**: Save
- **Ctrl + P**: Print
- **Ctrl + N**: New bill (after saving)
- **F2**: Focus on barcode field
- **F4**: Focus on supplier search
- **Esc**: Cancel

**Additional Features:**
- **Batch/Lot Entry** (if enabled): After quantity, prompt for batch number, mfg date, expiry date
- **Serial Number Entry** (if enabled): After quantity, prompt for individual serial numbers
- **Warehouse Selection** (if multi-warehouse enabled): Dropdown to select destination warehouse
- **Auto-save Draft**: Every 2 minutes, saves bill as draft (recoverable if system crashes)

---

### 5. SALES BILL WINDOW

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│  NEW SALES BILL                          Bill No: SAL-000001   │
│  Date: [02-04-2026 ▼]                                          │
├────────────────────────────────────────────────────────────────┤
│  Customer: [Search by name/mobile...      ] [+ Add Customer]   │
│  Salesperson: [Select User ▼]  Due Date: [________▼]          │
├────────────────────────────────────────────────────────────────┤
│                     ITEM ENTRY AREA (FIXED HEADER)             │
├───────┬─────────┬────────┬──────┬────────┬─────┬──────┬───┬───┤
│Barcode│Category │Product │ Size │Article │ QTY │ Rate │Dis│Amt│
│  No   │  Name   │  Name  │      │   No   │     │      │ % │   │
├───────┼─────────┼────────┼──────┼────────┼─────┼──────┼───┼───┤
│[_____]│[_______]│[______]│[____]│[______]│ [__]│ [___]│[_]│[_]│
├───────┴─────────┴────────┴──────┴────────┴─────┴──────┴───┴───┤
│                     ITEMS LIST (SCROLLABLE)                    │
├───────┬─────────┬────────┬──────┬────────┬─────┬──────┬───┬───┤
│123456 │Textile  │Cotton  │ M    │ART-001 │ 10  │ 150  │ 5 │142│
│123457 │Textile  │Cotton  │ L    │ART-001 │  5  │ 180  │ 0 │180│
│...    │...      │...     │...   │...     │ ... │ ...  │.. │.. │
└───────┴─────────┴────────┴──────┴────────┴─────┴──────┴───┴───┘
│                                                                │
│  Sub Total:           [___________]                           │
│  Discount (%):  [___] Discount (₹): [___________]             │
│  Taxable Amount:      [___________]                           │
│  CGST @ _%:           [___________]                           │
│  SGST @ _%:           [___________]                           │
│  IGST @ _%:           [___________]                           │
│  Round Off:           [___________]                           │
│  ─────────────────────────────────                            │
│  TOTAL AMOUNT:        [___________]                           │
│                                                                │
│  Amount Received:     [___________]                           │
│  Balance:             [___________]                           │
│                                                                │
│  [Save & Receive] [Save as Credit] [Print] [Cancel]           │
└────────────────────────────────────────────────────────────────┘
```

**Detailed Field Specifications:**

**Header Section:**
1. **Bill Number**: Auto-generated (SAL-YYYYMMDD-001 format)
2. **Date**: Date picker, defaults to today
3. **Customer Field**: 
   - Autocomplete search (name or mobile)
   - Optional field (walk-in customers allowed)
   - If blank: Bill saved to "Cash Sales" or "Walk-in Customer"
4. **Add Customer Button**: Quick add customer form
5. **Salesperson**: Dropdown of users with "Sales Staff" role, defaults to logged-in user
6. **Due Date**: Auto-calculates from customer's credit days

**Item Entry Row Behavior:**

**Two Entry Modes:**

**Mode 1: Barcode Entry (Preferred, Fastest)**
1. Scan/type barcode in Barcode field
2. On Enter:
   - System fetches product details
   - Auto-fills: Category, Product, Size, Article, Sale Rate
   - Shows available stock quantity (if stock < quantity: warning)
   - Cursor jumps to QTY field
3. Enter Quantity
4. Enter Discount % (optional, or Tab to skip)
5. Press Enter → Item added to list
6. Cursor returns to Barcode field for next item

**Mode 2: Manual Entry (Without Barcode)**
1. Skip Barcode field (Tab or click directly on Category)
2. Select Category from dropdown
3. Type/select Product Name (filters by category)
4. Select Size
5. Enter Article Number (optional)
6. System auto-fills Sale Rate from product master
7. Enter Quantity
8. Enter Rate (can override default sale rate)
9. Enter Discount % (optional)
10. Press Enter → Item added to list

**Field-by-Field Details:**

1. **Barcode Field**:
   - Auto-focus on screen open
   - Accepts scan input or manual typing
   - On valid barcode: Loads all product details instantly
   - On invalid barcode: Error message "Product not found"
   - After adding item: Clears and refocuses for next scan

2. **Category & Product Fields**:
   - Smart autocomplete with type-ahead
   - Product dropdown filters based on selected category
   - Displays: Product Name | Size | Article | Stock Qty | Rate
   - Highlights low-stock items in orange/red

3. **Size & Article Fields**:
   - Auto-populated if product selected
   - Can be manually changed (creates new variant if needed)

4. **Quantity Field**:
   - Numeric input
   - Mandatory field
   - **Stock Validation**:
     - If Qty > Available Stock: Warning popup
     - "Available: 20, You entered: 50. Continue anyway?"
     - Option to continue (negative stock) or adjust quantity
   - For batch-tracked items: Shows batch selection popup

5. **Rate Field**:
   - Auto-filled with default sale rate
   - Can be manually overridden (if user has permission)
   - If rate changed: Logs in audit trail (if enabled)

6. **Discount % Field**:
   - Optional
   - If entered: Reduces line total
   - Can be item-level or bill-level discount

7. **Amount Column**:
   - Auto-calculated: (Qty × Rate) - (Discount)
   - Read-only, displayed for each item

**Items List Section:**
- Same as Purchase bill
- Shows all added items
- Real-time stock deduction preview
- Click to edit, delete icon to remove

**Totals & Payment Section:**
- Same calculation logic as Purchase bill
- **Amount Received**: User input for payment received
- **Balance**: If > 0: Credit sale, If < 0: Excess (return change)

**Action Buttons:**
1. **Save & Receive**: 
   - If Amount Received = Total: Saves as "Paid"
   - Opens payment mode selection (Cash, Card, UPI, multiple modes)
   - If multiple modes: Opens payment split form
2. **Save as Credit**: Saves as unpaid/partial, updates customer balance
3. **Print**: Offers print format options (A4 invoice, thermal receipt)
4. **Cancel**: Discards bill with confirmation

**Stock Management Integration:**
- On save: Automatically creates stock ledger entries (quantity_out)
- If batch tracking: Deducts from selected batches (FIFO by default)
- If serial tracking: Marks serial numbers as sold
- Real-time stock update across all users/computers

**Additional Sales Features:**
- **Quick Sale Mode**: Minimal UI for fast billing (barcode → qty → save)
- **Return/Exchange**: Button to initiate sales return against this bill
- **Hold Bill**: Save as draft for later completion
- **Recall Draft**: List of held bills to resume

**Keyboard Shortcuts:**
- **F1**: Switch to barcode entry mode
- **F2**: Focus barcode field
- **F3**: Focus customer search
- **F5**: Hold bill (save draft)
- **F9**: Payment mode selection
- **Ctrl + P**: Print

---

### 6. PAYMENT & RECEIPT ENTRY

**Payment Entry Form (Money Out - To Suppliers)**

```
┌────────────────────────────────────────────────────────────────┐
│  PAYMENT ENTRY                          Receipt No: PAY-000001 │
│  Date: [02-04-2026 ▼]                                          │
├────────────────────────────────────────────────────────────────┤
│  Supplier: [Search supplier...                ] [View Ledger]  │
│  Current Balance: ₹ 45,000 (Payable)                           │
├────────────────────────────────────────────────────────────────┤
│  Reference Bill: [Select Bill ▼]  Bill Amount: ₹ _______      │
│    OR                                                          │
│  ☐ Payment without reference (Advance/On Account)             │
├────────────────────────────────────────────────────────────────┤
│  Total Payment Amount: [___________] ₹                         │
│                                                                │
│  ── Payment Mode Split ──                                      │
│  ☑ Cash:           [___________] ₹                             │
│  ☐ Card:           [___________] ₹  Last 4 digits: [____]     │
│  ☐ UPI:            [___________] ₹  Txn ID: [__________]      │
│  ☐ Cheque:         [___________] ₹  Cheque No: [_______]      │
│                                     Bank: [___________]        │
│                                     Date: [__________▼]        │
│  ☐ Bank Transfer:  [___________] ₹  Ref No: [__________]      │
│                                     Bank: [Select ▼]           │
│  ☐ Credit Note:    [___________] ₹  Note No: [________]       │
│                                                                │
│  Total Entered: ₹ _________ (Must match Payment Amount)       │
│                                                                │
│  Remarks: [_____________________________________________]      │
│                                                                │
│  [Save] [Print Receipt] [Cancel]                              │
└────────────────────────────────────────────────────────────────┘
```

**Receipt Entry Form (Money In - From Customers)**
- Same structure as Payment Entry
- Labeled as "RECEIPT ENTRY"
- Receipt No: REC-000001
- Customer selection instead of Supplier
- Reference: Sales bill selection
- Payment modes same

**Payment Mode Details:**

1. **Cash**:
   - Simple amount entry
   - No additional fields
   - Updates cash ledger account

2. **Card**:
   - Amount field
   - Last 4 digits of card (optional, for reference)
   - Card type dropdown: Credit/Debit/Others
   - Bank name (optional)

3. **UPI**:
   - Amount field
   - UPI Transaction ID (mandatory)
   - UPI App name: GPay/PhonePe/Paytm/Others

4. **Cheque**:
   - Amount field
   - Cheque Number (mandatory)
   - Cheque Date (date picker)
   - Bank Name (dropdown or text)
   - Status: Pending/Cleared/Bounced (initially Pending)
   - If Bank Reconciliation enabled: Links to bank account

5. **Bank Transfer**:
   - Amount field
   - Reference/UTR Number
   - Select bank account (from bank accounts list)
   - Transaction date

6. **Credit Note**:
   - For adjusting against credit notes/returns
   - Credit Note Number
   - Amount

**Multiple Payment Modes:**
- User can check multiple mode checkboxes
- Each checked mode shows its input fields
- System validates: Sum of all modes = Total Payment Amount
- If mismatch: Error message "Total entered doesn't match payment amount"

**Reference Bill Selection:**
- Dropdown lists all unpaid/partial bills for selected party
- Shows: Bill No. | Date | Total | Balance | Due Date
- Overdue bills highlighted in red
- On selection: Auto-fills bill amount in payment amount field
- Option to pay partial amount (less than bill balance)
- Option to pay multiple bills: Shows multi-select list with checkboxes

**Payment Without Reference:**
- Checkbox: "Payment without reference"
- Use cases: Advance payment, on-account payment
- No bill linked, but updates party ledger as advance
- Can be adjusted against future bills

**Validation & Save Logic:**
- Party selection mandatory
- Payment amount > 0
- If reference bill selected: Amount <= Bill balance (warning if exceed)
- Sum of payment modes = Total payment amount
- On save:
  - Creates payment_receipts record
  - Creates payment_splits records for each mode
  - Updates party balance
  - Updates bill payment status (if referenced)
  - Creates ledger entries (debit party, credit cash/bank)
  - If audit enabled: Logs user, timestamp, IP

**Post-Save Actions:**
- Success message: "Payment recorded successfully"
- Option to print payment receipt
- Option to send SMS/Email receipt (if configured)
- Clears form for next entry or returns to payment list

---

### 7. REPORTS MODULE

Inspired by legacy accounting tools' detailed, date-filtered, drill-down reports with export capabilities.

**Reports Main Screen:**
```
┌────────────────────────────────────────────────────────────────┐
│  REPORTS                                   [Export ▼] [Print]  │
├─────────────────┬──────────────────────────────────────────────┤
│  Report Categories│                                            │
│                 │  SELECT A REPORT TO VIEW                     │
│  📊 Sales       │                                              │
│  📦 Purchase    │  Or use Quick Filters:                       │
│  📈 Stock       │  Date Range: [01-04-2026] to [30-04-2026]  │
│  👥 Party       │  Party: [All ▼]                             │
│  💰 Accounts    │  Product: [All ▼]                           │
│  📑 GST         │  [Apply Filter]                             │
│  🏭 Production  │                                              │
│  📊 Financial   │                                              │
└─────────────────┴──────────────────────────────────────────────┘
```

#### 7.1 SALES REPORTS (Most Critical)

**Sales Report Types:**
1. Daily Sales Summary
2. Sales Register (Detailed)
3. Sales by Customer
4. Sales by Product
5. Sales by Category
6. Salesperson Performance
7. Hourly Sales Analysis
8. Sales Return Report

**Example: Sales Register (Detailed)**

**Filter Options:**
```
Date Range: [From: 01-04-2026] [To: 30-04-2026]
Customer: [All Customers ▼] or search specific
Payment Status: [All / Paid / Unpaid / Partial ▼]
Bill Status: [All / Active / Cancelled ▼]
Salesperson: [All ▼]
Amount Range: Min [____] Max [____]

[Apply Filter] [Reset] [Export to Excel] [Export to PDF] [Print]
```

**Report Display (Table Format):**
```
SALES REGISTER
Period: 01-Apr-2026 to 30-Apr-2026
─────────────────────────────────────────────────────────────────
Date      │ Bill No  │ Customer  │ Total  │ Paid   │ Balance │ Status
─────────────────────────────────────────────────────────────────
01-Apr-26 │ SAL-0001 │ ABC Ltd   │ 10,000 │ 10,000 │    0    │ Paid
01-Apr-26 │ SAL-0002 │ XYZ Corp  │ 25,000 │ 15,000 │ 10,000  │ Partial
02-Apr-26 │ SAL-0003 │ Cash Sale │  5,000 │  5,000 │    0    │ Paid
...
─────────────────────────────────────────────────────────────────
Total Sales (50 Bills): ₹ 5,45,000
Total Paid: ₹ 4,20,000
Total Pending: ₹ 1,25,000
─────────────────────────────────────────────────────────────────
```

**Drill-Down Functionality:**
- Click on Bill Number: Opens bill detail popup (view, print, edit options)
- Click on Customer: Opens customer ledger
- Click on Date: Filters all reports to that specific date
- Right-click menu: View Bill, Print Bill, Edit Bill, Customer Details

**Export Options:**
- **Excel**: Exports with formatting, formulas, filters
- **PDF**: Professional formatted report with company header/footer
- **CSV**: Raw data for further analysis
- **Print**: Opens print preview with page layout options

#### 7.2 PURCHASE REPORTS (Most Critical)

**Purchase Report Types:**
1. Purchase Register (Detailed)
2. Purchase by Supplier
3. Purchase by Product
4. Purchase by Category
5. Purchase Returns Report
6. Price Comparison Report (tracks price changes)

**Example: Purchase Register (Detailed)**
- Same structure as Sales Register
- Columns: Date | Bill No | Supplier | Supplier Bill No | Total | Paid | Balance | Status
- Filter by supplier, date range, payment status
- Shows transport details if available

#### 7.3 STOCK REPORTS (Needed)

**Stock Report Types:**
1. **Stock Summary** (Current stock of all products)
2. **Stock Valuation** (Stock value at purchase/sale rate)
3. **Low Stock Alert** (Below minimum level)
4. **Stock Movement** (Date-wise in/out)
5. **Stock Aging** (How long stock is sitting)
6. **Batch-wise Stock** (if batch tracking enabled)
7. **Fast Moving / Slow Moving Items**
8. **Stock Ledger** (Transaction-wise product history)

**Example: Stock Summary Report**

```
STOCK SUMMARY REPORT
As on: 02-Apr-2026
─────────────────────────────────────────────────────────────────────
Category  │ Product   │ Size │ Article │ Stock │ Pur.  │ Sale  │ Value
          │           │      │         │  Qty  │ Rate  │ Rate  │ (₹)
─────────────────────────────────────────────────────────────────────
Textile   │ Cotton    │  M   │ ART-001 │   50  │  100  │  150  │ 5,000
Textile   │ Cotton    │  L   │ ART-001 │   30  │  120  │  180  │ 3,600
Electronics│ LED Bulb │ 9W   │ LED-009 │  200  │   45  │   65  │ 9,000
...
─────────────────────────────────────────────────────────────────────
Total Stock Items: 150
Total Stock Value (Purchase): ₹ 2,45,000
Total Stock Value (Sale): ₹ 3,50,000
Potential Profit: ₹ 1,05,000
─────────────────────────────────────────────────────────────────────

COLOR CODES:
🔴 Red: Stock below minimum level (Critical)
🟡 Yellow: Stock below reorder level (Warning)
🟢 Green: Normal stock level
⚫ Black: Inactive/Zero stock
```

**Filters:**
- Category filter
- Stock status: All / Low Stock / Out of Stock / Overstocked
- Value range filter
- Date range (for stock as on specific date)

**Example: Stock Movement Report**

```
STOCK MOVEMENT REPORT
Product: Cotton Fabric - M (Barcode: 123456)
Period: 01-Apr-2026 to 30-Apr-2026
─────────────────────────────────────────────────────────────────────
Date      │ Transaction │ Bill No  │ Qty In │ Qty Out│ Rate  │ Balance
─────────────────────────────────────────────────────────────────────
01-Apr-26 │ Opening     │    -     │   -    │   -    │   -   │  100
02-Apr-26 │ Purchase    │ PUR-0001 │   50   │   -    │  100  │  150
03-Apr-26 │ Sales       │ SAL-0005 │   -    │   20   │  150  │  130
05-Apr-26 │ Sales       │ SAL-0012 │   -    │   30   │  150  │  100
...
─────────────────────────────────────────────────────────────────────
Closing Stock: 100 units
Total Purchases: 50 units @ ₹5,000
Total Sales: 50 units @ ₹7,500
Profit: ₹2,500
─────────────────────────────────────────────────────────────────────
```

#### 7.4 PARTY LEDGERS (Most Critical)

**Party Ledger Report (Classic Accounting-Style)**

**Selection:**
- Select Party: [Dropdown with search]
- Date Range: [From - To]
- Transaction Type: [All / Sales / Payments / Returns]

**Display Format:**
```
PARTY LEDGER
Party: ABC Ltd
Period: 01-Apr-2026 to 30-Apr-2026
─────────────────────────────────────────────────────────────────────
Date      │ Particulars         │ Bill/Ref No│ Debit   │ Credit  │ Balance
─────────────────────────────────────────────────────────────────────
01-Apr-26 │ Opening Balance     │     -      │ 10,000  │    -    │  10,000
05-Apr-26 │ Sales               │ SAL-0001   │ 25,000  │    -    │  35,000
07-Apr-26 │ Payment Received    │ REC-0001   │    -    │ 15,000  │  20,000
10-Apr-26 │ Sales               │ SAL-0010   │ 30,000  │    -    │  50,000
15-Apr-26 │ Sales Return        │ SRT-0001   │    -    │  5,000  │  45,000
20-Apr-26 │ Payment Received    │ REC-0010   │    -    │ 20,000  │  25,000
─────────────────────────────────────────────────────────────────────
                          TOTAL │ 65,000  │ 40,000  │
─────────────────────────────────────────────────────────────────────
Closing Balance: ₹ 25,000 (Receivable)
─────────────────────────────────────────────────────────────────────
```

**Additional Details:**
- Color coding: Debit (Sales) in black, Credit (Payments) in blue
- Overdue items highlighted in red
- Click on any row: Drills down to original transaction
- Summary box:
  - Total Sales to party
  - Total Payments from party
  - Average payment time (credit days utilization)
  - Credit limit utilization %

**Party-wise Summary Report:**
```
ALL PARTIES OUTSTANDING
As on: 02-Apr-2026
─────────────────────────────────────────────────────────────────────
Party Name     │ Type     │ Total Sales│ Payments │ Balance  │ Overdue
─────────────────────────────────────────────────────────────────────
ABC Ltd        │ Customer │  5,00,000  │ 4,50,000 │  50,000  │ 10,000
XYZ Corp       │ Customer │  3,00,000  │ 3,00,000 │      0   │      0
PQR Suppliers  │ Supplier │  2,00,000  │ 1,50,000 │  50,000  │      0
...
─────────────────────────────────────────────────────────────────────
Total Receivables (Customers): ₹ 2,50,000
Total Payables (Suppliers): ₹ 1,50,000
Net Position: ₹ 1,00,000 (Receivable)
─────────────────────────────────────────────────────────────────────
```

**Aging Analysis Report:**
```
RECEIVABLES AGING ANALYSIS
As on: 02-Apr-2026
─────────────────────────────────────────────────────────────────────
Party       │ Current │ 0-30  │ 31-60 │ 61-90 │ 90+   │ Total
            │ (Not Due)│ Days │ Days  │ Days  │ Days  │
─────────────────────────────────────────────────────────────────────
ABC Ltd     │  20,000 │ 15,000│ 10,000│  5,000│    0  │  50,000
XYZ Corp    │  10,000 │  5,000│     0 │     0 │    0  │  15,000
LMN Traders │      0  │     0 │     0 │  8,000│ 12,000│  20,000
...
─────────────────────────────────────────────────────────────────────
TOTAL       │  50,000 │ 30,000│ 20,000│ 18,000│ 32,000│ 1,50,000
─────────────────────────────────────────────────────────────────────
Overdue (90+ days): ₹ 32,000 (21%)
Action Required: Follow up with 5 parties
─────────────────────────────────────────────────────────────────────
```

#### 7.5 PROFIT & LOSS STATEMENT

```
PROFIT & LOSS STATEMENT
Period: 01-Apr-2026 to 30-Apr-2026
Financial Year: 2026-27
─────────────────────────────────────────────────────────────────────
REVENUE:
  Sales Revenue                                    ₹ 10,00,000
  Less: Sales Returns                              ₹    20,000
  ──────────────────────────────────────────────────────────────
  Net Sales                                        ₹  9,80,000

COST OF GOODS SOLD:
  Opening Stock (01-Apr-26)                        ₹  2,00,000
  Add: Purchases                                   ₹  6,00,000
  Less: Purchase Returns                           ₹    10,000
  ──────────────────────────────────────────────────────────────
  Goods Available for Sale                         ₹  7,90,000
  Less: Closing Stock (30-Apr-26)                  ₹  2,50,000
  ──────────────────────────────────────────────────────────────
  Cost of Goods Sold                               ₹  5,40,000

GROSS PROFIT                                       ₹  4,40,000
                                                   (44.9% margin)

OPERATING EXPENSES:
  Salaries & Wages                                 ₹   50,000
  Rent                                             ₹   20,000
  Electricity                                      ₹    5,000
  Transportation                                   ₹   10,000
  Office Expenses                                  ₹    8,000
  Depreciation                                     ₹   12,000
  Other Expenses                                   ₹    5,000
  ──────────────────────────────────────────────────────────────
  Total Operating Expenses                         ₹  1,10,000

OPERATING PROFIT (EBIT)                            ₹  3,30,000

OTHER INCOME:
  Interest Received                                ₹    2,000
  Miscellaneous Income                             ₹    1,000
  ──────────────────────────────────────────────────────────────
  Total Other Income                               ₹    3,000

OTHER EXPENSES:
  Interest Paid                                    ₹    5,000
  Bank Charges                                     ₹    1,000
  ──────────────────────────────────────────────────────────────
  Total Other Expenses                             ₹    6,000

NET PROFIT BEFORE TAX                              ₹  3,27,000

Less: Income Tax                                   ₹   32,700

NET PROFIT AFTER TAX                               ₹  2,94,300
                                                   (30% margin)
─────────────────────────────────────────────────────────────────────

Comparative Analysis:
This Month vs Last Month: +15% ↑
This Month vs Same Month Last Year: +22% ↑
```

**P&L Features:**
- Drill-down on each line item to see detailed transactions
- Comparison views: Month-on-month, Year-on-year, Budget vs Actual
- Export to Excel with formulas intact
- Graphical representation (bar chart, trend line)

#### 7.6 BALANCE SHEET

```
BALANCE SHEET
As on: 30-Apr-2026
─────────────────────────────────────────────────────────────────────
ASSETS:

Current Assets:
  Cash in Hand                                     ₹    50,000
  Bank Accounts                                    ₹  3,00,000
  Accounts Receivable (Debtors)                    ₹  2,50,000
  Stock/Inventory                                  ₹  2,50,000
  Prepaid Expenses                                 ₹   10,000
  ──────────────────────────────────────────────────────────────
  Total Current Assets                             ₹  8,60,000

Fixed Assets:
  Land & Building                                  ₹  5,00,000
  Plant & Machinery                                ₹  3,00,000
  Furniture & Fixtures                             ₹   50,000
  Vehicles                                         ₹  2,00,000
  Less: Accumulated Depreciation                   ₹  1,50,000
  ──────────────────────────────────────────────────────────────
  Total Fixed Assets                               ₹  9,00,000

TOTAL ASSETS                                       ₹ 17,60,000

─────────────────────────────────────────────────────────────────────
LIABILITIES:

Current Liabilities:
  Accounts Payable (Creditors)                     ₹  1,50,000
  Short-term Loans                                 ₹  1,00,000
  Outstanding Expenses                             ₹   20,000
  ──────────────────────────────────────────────────────────────
  Total Current Liabilities                        ₹  2,70,000

Long-term Liabilities:
  Long-term Loans                                  ₹  3,00,000
  ──────────────────────────────────────────────────────────────
  Total Long-term Liabilities                      ₹  3,00,000

TOTAL LIABILITIES                                  ₹  5,70,000

─────────────────────────────────────────────────────────────────────
EQUITY:

  Capital                                          ₹  8,00,000
  Add: Net Profit (Current Year)                   ₹  2,94,300
  Less: Drawings                                   ₹    4,300
  ──────────────────────────────────────────────────────────────
  Total Equity                                     ₹ 11,90,000

TOTAL LIABILITIES & EQUITY                         ₹ 17,60,000

─────────────────────────────────────────────────────────────────────
Verification: Total Assets = Total Liabilities + Equity ✓

Current Ratio: 3.19 (Healthy)
Debt-to-Equity Ratio: 0.48 (Healthy)
```

#### 7.7 CASH FLOW STATEMENT

```
CASH FLOW STATEMENT
Period: 01-Apr-2026 to 30-Apr-2026
─────────────────────────────────────────────────────────────────────
CASH FLOW FROM OPERATING ACTIVITIES:

  Net Profit                                       ₹  2,94,300
  
  Adjustments:
    Depreciation                                   ₹   12,000
    Interest Paid                                  ₹    5,000
    Changes in Working Capital:
      (Increase) in Accounts Receivable            ₹  (50,000)
      (Increase) in Inventory                      ₹  (30,000)
      Increase in Accounts Payable                 ₹   40,000
  ──────────────────────────────────────────────────────────────
  Net Cash from Operating Activities               ₹  2,71,300

CASH FLOW FROM INVESTING ACTIVITIES:

  Purchase of Fixed Assets                         ₹ (1,00,000)
  Sale of Old Assets                               ₹   20,000
  ──────────────────────────────────────────────────────────────
  Net Cash from Investing Activities               ₹  (80,000)

CASH FLOW FROM FINANCING ACTIVITIES:

  New Loan Received                                ₹  1,00,000
  Loan Repayment                                   ₹  (50,000)
  Drawings by Owner                                ₹   (4,300)
  ──────────────────────────────────────────────────────────────
  Net Cash from Financing Activities               ₹   45,700

─────────────────────────────────────────────────────────────────────
NET INCREASE IN CASH                               ₹  2,37,000

Opening Cash Balance (01-Apr-26)                   ₹  1,13,000
Closing Cash Balance (30-Apr-26)                   ₹  3,50,000
─────────────────────────────────────────────────────────────────────
```

#### 7.8 GST REPORTS (If GST Enabled)

**GST Report Types:**
1. GSTR-1 (Outward Supplies - Sales)
2. GSTR-3B (Summary Return)
3. GST Payable Report
4. Input Tax Credit (ITC) Report
5. HSN-wise Summary

**Example: GSTR-1 Report**

```
GSTR-1 REPORT (Outward Supplies)
Period: Apr-2026
GSTIN: 27XXXXX1234X1ZX
─────────────────────────────────────────────────────────────────────
B2B SUPPLIES (Sales to Registered Businesses):

Customer    │ GSTIN           │ Invoice  │ Date    │ Taxable │ CGST  │ SGST │ Total
            │                 │ No       │         │ Value   │       │      │ Tax
─────────────────────────────────────────────────────────────────────
ABC Ltd     │ 27XXXXX5678X1Z5 │ SAL-0001 │ 05-Apr  │ 20,000  │ 1,800 │1,800 │3,600
XYZ Corp    │ 29XXXXX9012X1Z9 │ SAL-0010 │ 10-Apr  │ 50,000  │     - │   -  │9,000
                                                       (IGST: 9,000)
...
─────────────────────────────────────────────────────────────────────
Total B2B: ₹ 5,00,000 (Taxable) | ₹ 90,000 (Tax)

B2C SUPPLIES (Sales to Unregistered):
Within State: ₹ 2,00,000 | CGST: ₹ 18,000 | SGST: ₹ 18,000
Other State: ₹ 1,00,000 | IGST: ₹ 18,000

TOTAL OUTWARD SUPPLIES: ₹ 8,00,000
TOTAL OUTPUT TAX: ₹ 1,44,000
─────────────────────────────────────────────────────────────────────
```

**Example: GST Payable Report**

```
GST PAYABLE REPORT
Period: Apr-2026
─────────────────────────────────────────────────────────────────────
OUTPUT TAX (Sales):
  CGST Collected                                   ₹   36,000
  SGST Collected                                   ₹   36,000
  IGST Collected                                   ₹   72,000
  ──────────────────────────────────────────────────────────────
  Total Output Tax                                 ₹  1,44,000

INPUT TAX CREDIT (Purchases):
  CGST Paid on Purchases                           ₹   24,000
  SGST Paid on Purchases                           ₹   24,000
  IGST Paid on Purchases                           ₹   48,000
  ──────────────────────────────────────────────────────────────
  Total Input Tax Credit                           ₹   96,000

─────────────────────────────────────────────────────────────────────
NET GST PAYABLE:                                   ₹   48,000

  CGST Payable: ₹ 12,000
  SGST Payable: ₹ 12,000
  IGST Payable: ₹ 24,000

Due Date: 20-May-2026
─────────────────────────────────────────────────────────────────────
```

**GST Report Features:**
- Export directly in GSTR-1/3B JSON format (upload-ready for GST portal)
- Date-wise breakup
- HSN/SAC code grouping
- Tax rate-wise summary
- Auto-filled challan for payment

---

### 8. ADDITIONAL MODULES & FEATURES

#### 8.1 Manufacturing Module (Optional Setting)

**Bill of Materials (BOM):**
```
Create BOM
───────────────────────────────────
Finished Product: [Select Product ▼]
BOM Code: [Auto-generated]

Raw Materials:
┌─────────────┬──────────┬────────┬────────┐
│ Material    │ Quantity │ Unit   │ Cost   │
├─────────────┼──────────┼────────┼────────┤
│ Cotton Yarn │    5     │  KG    │  500   │
│ Dye         │    1     │ LITER  │  100   │
│ ...         │   ...    │  ...   │  ...   │
└─────────────┴──────────┴────────┴────────┘
Total Cost: ₹ 600

[Save BOM] [Cancel]
```

**Work Order:**
```
Create Work Order
───────────────────────────────────
Work Order No: WO-000001
Date: [02-Apr-2026]

Product to Manufacture: [Select ▼]
Quantity: [____] Units
Expected Completion: [Date ▼]

BOM: [Auto-loaded]
Raw Material Requirements:
  - Cotton Yarn: 50 KG (Available: 60 KG) ✓
  - Dye: 10 Liters (Available: 8 Liters) ✗

Status: ⚪ Pending  ⚪ In Progress  ⚪ Completed

[Start Production] [Cancel]
```

**Production Entry:**
- Record actual material consumption
- Record finished goods produced
- Calculate wastage
- Update stock automatically

#### 8.2 Multi-Warehouse Management (Optional Setting)

**Warehouse Setup:**
- Add multiple warehouse locations
- Each warehouse has separate stock ledger
- Transfer stock between warehouses

**Stock Transfer:**
```
Stock Transfer
───────────────────────────────────
Transfer No: ST-000001
Date: [02-Apr-2026]

From Warehouse: [Main Warehouse ▼]
To Warehouse:   [Branch Store ▼]

Items:
┌──────────┬──────────┬─────────┐
│ Product  │ Quantity │ Avail.  │
├──────────┼──────────┼─────────┤
│ Cotton M │    20    │  50 ✓   │
│ ...      │   ...    │  ...    │
└──────────┴──────────┴─────────┘

[Transfer] [Cancel]
```

#### 8.3 Batch & Expiry Management (Optional Settings)

**When Enabled:**
- Purchase bill prompts for batch number, mfg date, expiry date
- Sales bill shows batch selection popup
- Reports: Batch-wise stock, Expiry alert report
- FIFO/FEFO/LIFO method selection

**Expiry Alert:**
- Dashboard widget: Items expiring in next 30 days
- Auto-alert email/notification to admin

#### 8.4 Low Stock Alerts

**Configuration:**
- Set minimum level per product
- Set reorder level
- Auto-generate purchase order suggestion

**Alert Display:**
```
LOW STOCK ALERT
─────────────────────────────────────────
Product         │ Current │ Min │ Status
─────────────────────────────────────────
Cotton Fabric M │   10    │ 20  │ 🔴 Critical
LED Bulb 9W     │   45    │ 40  │ 🟡 Warning
...
─────────────────────────────────────────
[Generate Purchase Order] [Update Levels]
```

#### 8.5 Interest Calculation (Optional Setting)

**Configuration:**
- Set interest rate % per customer/supplier
- Set grace period (days)
- Interest calculation method: Simple/Compound

**Auto-Calculation:**
- Calculates interest on overdue invoices
- Adds interest amount to party ledger
- Shows in aging report

#### 8.6 Bank Reconciliation (Optional Setting)

**Setup:**
- Add bank accounts
- Import bank statements (CSV/Excel)

**Reconciliation Screen:**
```
Bank Reconciliation
Bank: HDFC Current Account
─────────────────────────────────────────
Date       │ Cheque No │ Amount  │ Status
─────────────────────────────────────────
05-Apr-26  │ 123456    │ 10,000  │ ☐ Match
07-Apr-26  │ 123457    │ 15,000  │ ☑ Cleared
...
─────────────────────────────────────────
Bank Balance: ₹ 3,00,000
Book Balance: ₹ 3,05,000
Difference: ₹ 5,000 (Pending cheques)
```

---

### 9. BARCODE SYSTEM - DETAILED SPECIFICATIONS

**Critical: Barcode is the backbone of inventory. Must be handled with extreme care.**

#### Barcode Settings

```
BARCODE CONFIGURATION
─────────────────────────────────────────
Prefix: [PROD___] (4-6 characters)

Starting Number: [000001] (6 digits minimum)

Total Barcode Length: [12] digits

Format Preview: PROD-000001

Current Number: 000045 (Read-only)

Auto-Increment: ☑ Yes

Check Digit: ☐ Add MOD-10 check digit

Barcode Type: ⚪ CODE128  ⚪ CODE39  ⚪ EAN13

[Save Settings] [Reset Counter]
─────────────────────────────────────────
```

**Barcode Generation Rules:**

1. **Automatic Assignment:**
   - When new product is created without barcode: Auto-generate
   - Format: PREFIX + NUMBER (e.g., PROD-000001)
   - Increment counter by 1 for each new barcode

2. **Duplicate Detection:**
   - Before generating barcode, check if product variant exists:
     ```
     IF (Category + Product Name + Size + Article No + Purchase Rate + Sale Rate) 
        matches existing product:
        → Use existing barcode (same product, re-purchase)
     ELSE:
        → Generate new barcode (new variant)
     ```

3. **Manual Barcode Entry:**
   - Allow admin to manually assign barcode
   - Validate uniqueness before saving
   - Warning if similar product exists with different barcode

4. **Barcode Editing:**
   - Allow barcode editing (with admin permission only)
   - On edit: Update all historical records
   - Create barcode change log in audit trail

5. **Barcode Deletion:**
   - Do NOT allow barcode deletion
   - Instead: Mark product as inactive
   - Maintain historical integrity

**Barcode Validation:**
- Must be unique across entire database
- Length validation (min 6, max 20 characters)
- Alphanumeric only (no special characters except hyphen)
- Case-insensitive comparison

**Barcode Printing:**
- Generate barcode labels (print on sticker paper)
- Label format options:
  - Small (1" x 1"): Barcode + Product Name
  - Medium (2" x 1"): Barcode + Product Name + Price
  - Large (2" x 2"): Barcode + Full Details
- Print quantity selection
- Batch print for multiple products

**Barcode Search Everywhere:**
- Purchase bill: Scan to add item
- Sales bill: Scan to add item
- Stock report: Search by barcode
- Customer/Supplier tab: Search bills by barcode (shows which bills contain that product)
- Inventory: Quick search by barcode

**Barcode Scanner Integration:**
- Support USB barcode scanners (acts as keyboard input)
- Auto-detect scanner input (usually ends with Enter)
- Configure scanner settings (prefix/suffix to identify scanner input)

---

### 10. USER MANAGEMENT & PERMISSIONS

#### User Roles & Permissions Matrix

```
┌─────────────────────┬───────┬─────────┬─────────┬──────────┬────────────┐
│ Permission          │ Admin │ Manager │ Cashier │ Inventory│ Accountant │
├─────────────────────┼───────┼─────────┼─────────┼──────────┼────────────┤
│ View Dashboard      │   ✓   │    ✓    │    ✓    │    ✓     │     ✓      │
│ Create Sales Bill   │   ✓   │    ✓    │    ✓    │    ✗     │     ✗      │
│ Edit Sales Bill     │   ✓   │    ✓    │    ✗    │    ✗     │     ✗      │
│ Delete Sales Bill   │   ✓   │    ✓    │    ✗    │    ✗     │     ✗      │
│ Give Discount       │   ✓   │    ✓    │   <10%  │    ✗     │     ✗      │
│ Create Purchase     │   ✓   │    ✓    │    ✗    │    ✓     │     ✗      │
│ Edit Purchase       │   ✓   │    ✓    │    ✗    │    ✓     │     ✗      │
│ Add/Edit Customer   │   ✓   │    ✓    │    ✓    │    ✗     │     ✗      │
│ Add/Edit Supplier   │   ✓   │    ✓    │    ✗    │    ✓     │     ✗      │
│ View Party Ledger   │   ✓   │    ✓    │    ✗    │    ✗     │     ✓      │
│ Payment Entry       │   ✓   │    ✓    │    ✓    │    ✗     │     ✓      │
│ Receipt Entry       │   ✓   │    ✓    │    ✓    │    ✗     │     ✓      │
│ Add/Edit Products   │   ✓   │    ✓    │    ✗    │    ✓     │     ✗      │
│ Stock Adjustment    │   ✓   │    ✓    │    ✗    │    ✓     │     ✗      │
│ View Stock Reports  │   ✓   │    ✓    │    ✗    │    ✓     │     ✓      │
│ View Financial Rep. │   ✓   │    ✓    │    ✗    │    ✗     │     ✓      │
│ View P&L, Balance Sh│   ✓   │    ✓    │    ✗    │    ✗     │     ✓      │
│ Access Settings     │   ✓   │    ✗    │    ✗    │    ✗     │     ✗      │
│ Manage Users        │   ✓   │    ✗    │    ✗    │    ✗     │     ✗      │
│ Backup/Restore      │   ✓   │    ✗    │    ✗    │    ✗     │     ✗      │
│ View Audit Log      │   ✓   │    ✓    │    ✗    │    ✗     │     ✓      │
└─────────────────────┴───────┴─────────┴─────────┴──────────┴────────────┘
```

**User Management Screen:**
```
MANAGE USERS
─────────────────────────────────────────────────────────────
User Name    │ Role       │ Status  │ Last Login    │ Actions
─────────────────────────────────────────────────────────────
admin        │ Admin      │ Active  │ 02-Apr 10:30  │ ✏️ 🔒
john_doe     │ Manager    │ Active  │ 02-Apr 09:15  │ ✏️ 🔒 🗑️
jane_smith   │ Cashier    │ Inactive│ 28-Mar 14:20  │ ✏️ ✓ 🗑️
...
─────────────────────────────────────────────────────────────
[+ Add New User]
```

**Add/Edit User Form:**
```
User Details
─────────────────────────────────
* Username: [_______________]
* Full Name: [_______________]
* Email: [_______________]
* Mobile: [_______________]
* Role: [Select Role ▼]
* Password: [_______________]
  Confirm: [_______________]

Custom Permissions:
☐ Allow rate editing in bills
☐ Allow backdating of bills
☐ Allow bill cancellation
☐ Access to all reports
☐ Export data to Excel

Status: ☑ Active  ☐ Inactive

[Save] [Cancel]
```

---

### 11. SYSTEM SETTINGS

**Settings Categories:**

1. **Company Profile**
   - Company Name, Address, Logo
   - GSTIN, PAN, Contact Details
   - Financial Year Start/End
   - Currency Symbol, Decimal Places

2. **Module Settings**
   - ☑ GST Enabled
   - ☐ Multi-Warehouse Enabled
   - ☐ Batch Tracking Enabled
   - ☐ Expiry Tracking Enabled
   - ☐ Serial Number Tracking
   - ☐ Audit Trail Enabled
   - ☐ Interest Calculation
   - ☐ Bank Reconciliation
   - ☐ Manufacturing Module
   - ☑ Low Stock Alerts

3. **Barcode Settings**
   - (As detailed in Section 9)

4. **Invoice Settings**
   - Invoice prefix/suffix
   - Invoice numbering (continuous/year-wise reset)
   - Print format selection
   - Terms & conditions (default text)
   - Header/Footer customization

5. **Tax Settings** (if GST enabled)
   - Default tax rates
   - Tax categories
   - HSN codes management
   - Place of supply

6. **Payment Settings**
   - Available payment modes
   - Default payment terms
   - Credit days
   - Interest rates

7. **Backup Settings**
   - Auto-backup frequency
   - Backup location
   - Retention policy (keep last N backups)
   - Backup time (scheduled)

8. **Dashboard Customization**
   - Widget selection
   - Widget placement
   - Quick action buttons
   - Color theme

9. **Email/SMS Settings** (Optional)
   - SMTP configuration
   - SMS gateway API
   - Auto-send invoice on save
   - Payment reminder schedule

10. **Data Import/Export**
    - Import from Excel (customers, suppliers, products)
    - Export data templates
    - Data migration tools

---

### 12. TECHNICAL SPECIFICATIONS

#### 12.1 Technology Stack Recommendations

**Frontend (User Interface):**
- **Framework**: Electron (for Windows/Mac desktop apps) + React
- **Alternative**: .NET WPF (Windows-focused) or JavaFX (cross-platform)
- **Web Version**: React + Node.js (responsive design)
- **UI Library**: Material-UI or Ant Design for modern, clean components
- **Charting**: Chart.js or Recharts for graphs

**Backend (Business Logic):**
- **Server**: Node.js with Express OR Python with Flask/Django
- **Alternative**: ASP.NET Core (if using .NET stack)
- **API**: RESTful API for all operations

**Database:**
- **Primary**: PostgreSQL (preferred for robustness, ACID compliance)
- **Alternative**: MySQL (widely used, good performance)
- **ORM**: Sequelize (Node.js) or SQLAlchemy (Python)

**Network Sync:**
- **Architecture**: Client-Server model
- **Server**: Central database server on LAN
- **Clients**: Multiple computers connect to server via TCP/IP
- **Real-time Sync**: WebSockets or polling for live updates
- **Conflict Resolution**: Last-write-wins with timestamp validation

**Barcode Scanner:**
- **Integration**: USB HID (acts as keyboard)
- **Libraries**: `quagga2` for camera-based scanning (web), `node-hid` for USB scanners

**Reporting:**
- **PDF Generation**: `jsPDF` or `pdfkit` (Node.js), `ReportLab` (Python)
- **Excel Export**: `exceljs` or `xlsx` (Node.js), `openpyxl` (Python)
- **Print**: Browser print API or OS-specific print libraries

**Authentication & Security:**
- **Password Hashing**: bcrypt
- **Session Management**: JWT tokens or session cookies
- **Encryption**: HTTPS for web, TLS for database connections

#### 12.2 Database Connection & Multi-Computer Setup

**Server Setup:**
1. Install PostgreSQL on one computer (acts as server)
2. Configure PostgreSQL to accept network connections:
   - Edit `postgresql.conf`: `listen_addresses = '*'`
   - Edit `pg_hba.conf`: Add client IPs with password authentication
3. Ensure firewall allows port 5432

**Client Setup:**
1. Install application on each computer
2. Configure database connection settings:
   - Server IP: 192.168.1.100 (example)
   - Port: 5432
   - Database: erp_db
   - Username: erp_user
   - Password: [encrypted]
3. Test connection on application startup

**Connection Pooling:**
- Use connection pool (max 10 connections per client)
- Auto-reconnect on connection loss
- Queue requests if server is busy

**Data Sync Strategy:**
- All CRUD operations go to central database
- No local caching of critical data (always fetch fresh)
- Optional: Cache static data (categories, products) with TTL

#### 12.3 Performance Optimization

**Database Indexes:**
- Create indexes on frequently queried columns:
  - `barcode` (unique index)
  - `bill_number` (unique index)
  - `party_name`, `mobile_1` (for search)
  - `bill_date`, `created_date` (for date filters)
  - `party_id`, `product_id` (foreign keys)

**Query Optimization:**
- Use prepared statements (prevent SQL injection + faster)
- Avoid `SELECT *`, fetch only needed columns
- Use JOIN instead of multiple queries
- Implement pagination for large lists (50 records per page)
- Use database views for complex reports

**Caching:**
- Cache dropdown data (categories, units) in memory
- Cache user permissions on login
- Invalidate cache on data change

**Lazy Loading:**
- Load dashboard widgets on-demand
- Load reports only when requested
- Load images/logos asynchronously

**Transaction Management:**
- Use database transactions for multi-step operations
- Example: Sales bill save = Insert bill + Insert items + Update stock + Update ledger (all-or-nothing)

#### 12.4 Error Handling & Logging

**Error Types:**
1. **Database Errors**: Connection failure, query errors, constraint violations
2. **Validation Errors**: Invalid input, business rule violations
3. **Permission Errors**: Unauthorized access attempts
4. **Network Errors**: Server unreachable, timeout

**Error Display:**
- User-friendly messages (no technical jargon)
- Example: "Could not save bill. Please check your internet connection." (not "SQLState: 08001")
- Option to view details (for admins)
- Auto-retry for network errors

**Logging:**
- Log all errors to file: `logs/error_YYYYMMDD.log`
- Log format: `[2026-04-02 10:30:15] [ERROR] [User: john_doe] [Module: Sales] Connection timeout`
- Log levels: INFO, WARNING, ERROR, CRITICAL
- Rotate logs daily, keep last 30 days

**Audit Trail** (if enabled):
- Log every Create, Update, Delete operation
- Store in `audit_log` table
- Searchable by date, user, module
- Cannot be deleted (append-only)

#### 12.5 Backup & Recovery

**Auto-Backup:**
- Scheduled backup at configured frequency (hourly/daily/weekly)
- Backup process:
  1. Create database dump (SQL format)
  2. Compress (ZIP/GZIP)
  3. Save to backup folder with timestamp: `backup_20260402_103000.sql.gz`
  4. Delete old backups (keep last 30 days by default)

**Manual Backup:**
- Button in Settings > Backup
- Allows user to choose location
- Progress bar with status

**Restore:**
- Select backup file from list
- Confirm restoration (warning: current data will be replaced)
- Stop all active connections
- Restore database from backup
- Restart application

**Disaster Recovery:**
- Keep backups on external drive or network location
- Test restore process regularly
- Document recovery steps

---

### 13. INSTALLATION & DEPLOYMENT

#### Installation Package:
- **Windows**: .exe installer (NSIS or Electron Builder)
- **Mac**: .dmg or .pkg installer
- **Web**: Hosted on server, access via browser

#### Installation Steps:
1. Run installer
2. Choose installation directory
3. Install dependencies (Node.js, PostgreSQL - bundled or prompt user)
4. Create database (auto-setup script)
5. Configure admin account (first-time setup wizard)
6. Configure network settings (server IP for multi-computer)
7. Complete setup

#### First-Time Setup Wizard:
```
Welcome to ERP Software Setup
────────────────────────────────
Step 1: Company Information
  Company Name: [_______________]
  Address: [_______________]
  GSTIN: [_______________]
  [Next]

Step 2: Create Admin Account
  Username: [_______________]
  Password: [_______________]
  Confirm: [_______________]
  [Next]

Step 3: Financial Year
  Start Date: [01-Apr-2026]
  End Date: [31-Mar-2027]
  [Next]

Step 4: Module Selection
  ☑ Sales & Purchase (Mandatory)
  ☑ Inventory Management (Mandatory)
  ☐ GST Enabled
  ☐ Multi-Warehouse
  ☐ Manufacturing
  [Next]

Step 5: Network Configuration
  ⚪ Single Computer (Standalone)
  ⚪ Multiple Computers (LAN)
    Server IP: [_______________]
    Port: [5432]
    [Test Connection]
  [Finish]

Setup Complete! Click 'Launch' to start.
```

---

### 14. USER TRAINING & DOCUMENTATION

**Built-in Help System:**
- Context-sensitive help (? icon on each screen)
- Tooltip on hover for all fields
- Video tutorials (embedded or links)
- PDF user manual (downloadable)

**Help Topics:**
- Getting Started Guide
- How to create first sale bill
- How to add customers/suppliers
- How to manage stock
- How to view reports
- Troubleshooting common issues

---

### 15. FUTURE ENHANCEMENTS (Optional)

1. **Mobile App**: Android/iOS app for sales on-the-go
2. **Cloud Sync**: Optional cloud backup
3. **E-commerce Integration**: Sync with online store
4. **WhatsApp Integration**: Send invoices via WhatsApp
5. **Payment Gateway**: Accept online payments
6. **Advanced Analytics**: AI-powered insights, sales predictions
7. **Multi-Currency**: Support for foreign transactions
8. **Multi-Language**: Support for regional languages

---

## SUMMARY & FINAL CHECKLIST

This prompt provides a **complete, industrial-grade specification** for a full-featured ERP & Billing Software. Here's what's covered:

✅ **Database Design**: Complete schema with all tables, columns, relationships, and indexes
✅ **User Interface**: Detailed layouts for every screen with exact field specifications
✅ **Business Logic**: Step-by-step workflows for all operations
✅ **Barcode System**: Comprehensive barcode management with auto-generation and validation
✅ **Multi-User Support**: Role-based permissions, concurrent access, audit trails
✅ **Reports**: classic accounting-style detailed reports with drill-down and export capabilities
✅ **Payment Handling**: Multiple payment modes, split payments, credit management
✅ **GST Compliance**: Optional GST module with GSTR reports (if enabled)
✅ **Stock Management**: Real-time stock tracking, batch/expiry management (optional)
✅ **Network Sync**: LAN-based multi-computer architecture
✅ **Backup & Security**: Auto-backup, encryption, disaster recovery
✅ **Cross-Platform**: Windows, Mac, and web support
✅ **Scalability**: Designed to handle large volumes of data
✅ **Customization**: Configurable dashboard, optional modules, user preferences

**Development Priority:**
1. Core modules first (Sales, Purchase, Inventory, Parties)
2. Then Payments & Reports
3. Then Optional modules (GST, Manufacturing, Multi-Warehouse)
4. Finally Advanced features (Analytics, Mobile app)

**Estimated Development Time**: 6-12 months for full system with a team of 3-5 developers

This specification should enable Claude (or any development team) to build a production-ready, robust ERP software that handles all business needs efficiently.

---

**END OF PROMPT**

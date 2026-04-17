const ExcelJS = require('exceljs');
const { Op, col } = require('sequelize');
const { Party, Product, Category, StockLedger } = require('../models');

exports.exportToExcel = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    // Filter params passed from the list pages so the export matches what the
    // user is looking at. Without this, an Export click from a filtered list
    // dumps the entire table — confusing and useless when the user explicitly
    // filtered to "Low Stock" or "Category = Fabrics" on-screen.
    const { search, category_id, stock_status, party_type, status } = req.query;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(moduleName);

    let data = [];
    let columns = [];

    switch (moduleName) {
      case 'customers': {
        const where = { party_type: { [Op.in]: ['Customer', 'Both'] } };
        if (status) where.party_status = status;
        if (search) {
          where[Op.or] = [
            { party_name: { [Op.iLike]: `%${search}%` } },
            { mobile_1:   { [Op.like]:  `%${search}%` } },
            { gstin:      { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Party.findAll({ where, raw: true });
        columns = [
          { header: 'Party Name', key: 'party_name', width: 25 },
          { header: 'Mobile 1', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Limit', key: 'credit_limit', width: 15 },
          { header: 'Opening Balance', key: 'opening_balance', width: 15 },
          { header: 'Balance Type', key: 'opening_balance_type', width: 12 },
          { header: 'Current Balance', key: 'current_balance', width: 15 },
          { header: 'Status', key: 'party_status', width: 12 },
        ];
        break;
      }

      case 'suppliers': {
        const where = { party_type: { [Op.in]: ['Supplier', 'Both'] } };
        if (status) where.party_status = status;
        if (search) {
          where[Op.or] = [
            { party_name: { [Op.iLike]: `%${search}%` } },
            { mobile_1:   { [Op.like]:  `%${search}%` } },
            { gstin:      { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Party.findAll({ where, raw: true });
        columns = [
          { header: 'Party Name', key: 'party_name', width: 25 },
          { header: 'Mobile 1', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Limit', key: 'credit_limit', width: 15 },
          { header: 'Current Balance', key: 'current_balance', width: 15 },
        ];
        break;
      }

      case 'products': {
        const where = { is_active: true };
        if (category_id) where.category_id = category_id;
        if (stock_status === 'low') {
          where.minimum_stock_level = { [Op.gt]: 0 };
          where.current_stock = { [Op.lte]: col('minimum_stock_level') };
        }
        if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
        if (search) {
          where[Op.or] = [
            { product_name:    { [Op.iLike]: `%${search}%` } },
            { barcode:         { [Op.iLike]: `%${search}%` } },
            { article_number:  { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Product.findAll({
          where,
          include: [{ model: Category, attributes: ['category_name'] }],
          raw: true, nest: true,
        });
        data = data.map(p => ({ ...p, category_name: p.Category?.category_name || '' }));
        columns = [
          { header: 'Barcode', key: 'barcode', width: 15 },
          { header: 'Category', key: 'category_name', width: 20 },
          { header: 'Product Name', key: 'product_name', width: 25 },
          { header: 'Size', key: 'size_value', width: 10 },
          { header: 'Article No', key: 'article_number', width: 15 },
          { header: 'HSN Code', key: 'hsn_code', width: 12 },
          { header: 'GST %', key: 'gst_rate', width: 8 },
          { header: 'Unit', key: 'unit_of_measurement', width: 8 },
          { header: 'Pieces per Box', key: 'quantity_per_box', width: 13 },
          { header: 'Opening Stock', key: 'opening_stock', width: 13 },
          { header: 'Opening Stock Rate', key: 'opening_stock_rate', width: 16 },
          { header: 'Current Stock', key: 'current_stock', width: 12 },
          { header: 'Min Stock', key: 'minimum_stock_level', width: 10 },
          { header: 'Purchase Rate', key: 'purchase_rate', width: 12 },
          { header: 'Margin %', key: 'margin_percentage', width: 10 },
          { header: 'Sale Rate', key: 'sale_rate', width: 12 },
          { header: 'MRP', key: 'mrp', width: 12 },
        ];
        break;
      }

      default:
        return res.status(400).json({ error: 'Invalid module' });
    }

    sheet.columns = columns;

    // Style header row
    sheet.getRow(1).font = { bold: true, size: 12 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    data.forEach(row => sheet.addRow(row));

    // Auto-filter
    sheet.autoFilter = { from: 'A1', to: String.fromCharCode(64 + columns.length) + '1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_export.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.downloadTemplate = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Template');

    let columns = [];
    switch (moduleName) {
      case 'customers':
      case 'suppliers':
        columns = [
          { header: 'Party Name *', key: 'party_name', width: 25 },
          { header: 'Mobile 1 *', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address Line 1', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'Pincode', key: 'pincode', width: 10 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Allowed (Yes/No)', key: 'credit_allowed', width: 18 },
          { header: 'Credit Limit', key: 'credit_limit', width: 12 },
          { header: 'Opening Balance', key: 'opening_balance', width: 15 },
          { header: 'Balance Type (Receivable/Payable)', key: 'opening_balance_type', width: 20 },
        ];
        break;

      case 'products':
        columns = [
          { header: 'Barcode (auto if blank)', key: 'barcode', width: 18 },
          { header: 'Category *', key: 'category_name', width: 20 },
          { header: 'Product Name *', key: 'product_name', width: 25 },
          { header: 'Size', key: 'size_value', width: 10 },
          { header: 'Article No', key: 'article_number', width: 15 },
          { header: 'HSN Code', key: 'hsn_code', width: 12 },
          { header: 'GST %', key: 'gst_rate', width: 8 },
          { header: 'Unit (PCS/KG/METER/LITER/BOX/DOZEN)', key: 'unit_of_measurement', width: 15 },
          { header: 'Pieces per Box', key: 'quantity_per_box', width: 13 },
          { header: 'Min Stock Level', key: 'minimum_stock_level', width: 12 },
          { header: 'Opening Stock', key: 'opening_stock', width: 13 },
          { header: 'Opening Stock Rate', key: 'opening_stock_rate', width: 16 },
          { header: 'Purchase Rate *', key: 'purchase_rate', width: 12 },
          { header: 'Margin %', key: 'margin_percentage', width: 10 },
          { header: 'Sale Rate *', key: 'sale_rate', width: 12 },
          { header: 'MRP', key: 'mrp', width: 12 },
        ];
        break;

      default:
        return res.status(400).json({ error: 'Invalid module' });
    }

    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add sample row
    const sampleRow = moduleName === 'products'
      ? { barcode: '', category_name: 'Textiles', product_name: 'Cotton Fabric', size_value: 'M', article_number: 'ART-001', hsn_code: '5208', gst_rate: 5, unit_of_measurement: 'PCS', quantity_per_box: 12, minimum_stock_level: 10, opening_stock: 50, opening_stock_rate: 100, purchase_rate: 100, margin_percentage: 20, sale_rate: 120, mrp: 150 }
      : { party_name: 'ABC Trading Co', mobile_1: '9876543210', email: 'abc@example.com', city: 'Mumbai', state: 'Maharashtra', credit_allowed: 'Yes', credit_limit: 50000, opening_balance: 0, opening_balance_type: 'Receivable' };
    sheet.addRow(sampleRow);
    sheet.getRow(2).font = { italic: true, color: { argb: 'FF808080' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_template.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Template error:', error);
    res.status(500).json({ error: 'Template generation failed' });
  }
};

exports.importFromExcel = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];

    const headers = [];
    sheet.getRow(1).eachCell((cell) => headers.push(cell.value));

    const rows = [];
    const errors = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const data = {};
      row.eachCell((cell, colNumber) => {
        const key = headers[colNumber - 1];
        data[key] = cell.value;
      });
      rows.push({ rowNumber, data });
    });

    let imported = 0;
    let skipped = 0;

    if (moduleName === 'products') {
      // ── Bulk import for products (handles large files efficiently) ────────
      const { generateBarcode } = require('../utils/barcode');

      // 1. Build category map (name → id) — batch upsert all unique categories first
      const catNames = [...new Set(
        rows.map(r => (r.data['Category *'] || r.data['Category'] || '').trim()).filter(Boolean)
      )];
      const catMap = {};
      for (const name of catNames) {
        const [cat] = await Category.findOrCreate({
          where: { category_name: name },
          defaults: { category_name: name },
        });
        catMap[name] = cat.category_id;
      }

      // 2. Collect existing barcodes in one query
      const incomingBarcodes = rows
        .map(r => r.data['Barcode (auto if blank)'] || r.data['Barcode'])
        .filter(Boolean)
        .map(String);
      const existing = await Product.findAll({
        where: { barcode: incomingBarcodes },
        attributes: ['barcode'],
        raw: true,
      });
      const existingSet = new Set(existing.map(p => p.barcode));

      // 3. Build records to bulk-create
      // Safe parsers (defined once, used for every row)
      const unwrap = v => {
        if (v instanceof Date) return null;
        if (v !== null && typeof v === 'object' && 'result' in v) return v.result;
        if (v !== null && typeof v === 'object' && 'richText' in v) return v.richText.map(r => r.text).join('');
        return v;
      };
      // Clamp to max AND reject negatives so Excel sentinel values (9.22e16) don't
      // cause DECIMAL overflow, and a "-5" typo on GST %, rate, or quantity doesn't
      // silently become a tax refund or negative stock.
      const toNum = (v, def = 0, max = 9999999999999.99, min = 0) => {
        const n = parseFloat(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      const toInt = (v, def = 1, max = 2147483647, min = 0) => {
        const n = parseInt(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      // Signed variant — only for fields where negative is legitimate (e.g. round-off).
      const toNumSigned = (v, def = 0, max = 9999999999999.99, min = -9999999999999.99) => {
        const n = parseFloat(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      const toStr = v => {
        const u = unwrap(v);
        // Do NOT treat the literal "0" as empty — it's a legitimate size/article code.
        // Previously "0" (e.g. barcode "0123" → "0") was silently dropped.
        return (u != null && String(u).trim() !== '') ? String(u).trim() : null;
      };

      const toCreate = [];
      for (const { rowNumber, data } of rows) {
        const rawName = data['Product Name *'] ?? data['Product Name'];
        // Treat null, undefined, empty string, OR numeric 0 as missing product name
        const productName = (rawName != null && String(rawName).trim() !== '' && String(rawName).trim() !== '0')
          ? String(rawName).trim() : '';
        if (!productName) {
          errors.push({ row: rowNumber, reason: 'Missing Product Name', rowData: data });
          skipped++;
          continue;
        }

        const rawBarcode = data['Barcode (auto if blank)'] || data['Barcode'];
        const barcode = rawBarcode != null && String(rawBarcode).trim() !== ''
          ? String(rawBarcode).trim()
          : await generateBarcode();

        if (existingSet.has(barcode)) {
          errors.push({ row: rowNumber, reason: 'Barcode already exists (duplicate)', rowData: data });
          skipped++;
          continue;
        }
        existingSet.add(barcode);

        const catName = (data['Category *'] || data['Category'] || '').trim();
        const openingStock = toNum(data['Opening Stock'], 0, 99999999.99);

        toCreate.push({
          _rowNumber: rowNumber,   // preserved for accurate error reporting in fallback
          barcode,
          category_id: catMap[catName] || null,
          product_name: productName,
          size_value: toStr(data['Size']),
          article_number: toStr(data['Article No']),
          hsn_code: data['HSN Code'] ? String(data['HSN Code']).slice(0, 50) : null,
          gst_rate: toNum(data['GST %'], 0, 999999.99),
          // Validate against the ENUM defined on Product model — an invalid
          // value (e.g. "piece", "mtr") would cause the bulkCreate to fail.
          // Fall back to PCS so a typo doesn't block an entire import.
          unit_of_measurement: (() => {
            const allowed = ['PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'];
            const raw = (data['Unit (PCS/KG/METER/LITER/BOX/DOZEN)'] || data['Unit'] || 'PCS').toString().trim().toUpperCase();
            // Common synonyms/aliases
            const alias = { PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', MTR: 'METER', MT: 'METER', LTR: 'LITER', LT: 'LITER', DZ: 'DOZEN', DOZ: 'DOZEN' };
            const mapped = alias[raw] || raw;
            return allowed.includes(mapped) ? mapped : 'PCS';
          })(),
          // DECIMAL(10,2) in DB — preserve fractional box counts (e.g. 0.5 m fabric rolls). toInt silently truncated 2.5 → 2.
          quantity_per_box: toNum(data['Pieces per Box'], 1, 99999.99, 0.01),
          minimum_stock_level: toNum(data['Min Stock Level'], 0, 99999999.99),
          opening_stock: openingStock,
          opening_stock_rate: toNum(data['Opening Stock Rate'], 0),
          current_stock: openingStock,
          purchase_rate: toNum(data['Purchase Rate *'] || data['Purchase Rate'], 0),
          margin_percentage: toNum(data['Margin %'], 0, 999999.99),
          sale_rate: toNum(data['Sale Rate *'] || data['Sale Rate'], 0),
          mrp: toNum(data['MRP'], 0),
        });
      }

      // 4. Bulk insert in chunks of 500; fall back to row-by-row on chunk failure
      const CHUNK = 500;
      const today = new Date().toISOString().split('T')[0];
      const createdProducts = []; // collect newly inserted products for ledger entries

      for (let i = 0; i < toCreate.length; i += CHUNK) {
        const chunk = toCreate.slice(i, i + CHUNK);
        // Strip _rowNumber before DB insert
        const chunkData = chunk.map(({ _rowNumber, ...rest }) => rest);
        try {
          const results = await Product.bulkCreate(chunkData, { ignoreDuplicates: true, returning: true });
          results.forEach(p => createdProducts.push(p));
          imported += results.length;
        } catch (bulkErr) {
          // Chunk failed — retry each row individually so only bad rows are skipped
          for (let j = 0; j < chunk.length; j++) {
            try {
              const p = await Product.create(chunkData[j]);
              createdProducts.push(p);
              imported++;
            } catch (rowErr) {
              errors.push({ row: chunk[j]._rowNumber, reason: rowErr.message, rowData: chunkData[j] });
              skipped++;
            }
          }
        }
      }

      // 5. Create Opening Stock ledger entries for products that have opening_stock > 0
      const ledgerEntries = createdProducts
        .filter(p => parseFloat(p.opening_stock || 0) > 0)
        .map(p => ({
          product_id: p.product_id,
          transaction_type: 'Opening Stock',
          transaction_date: today,
          quantity_in: parseFloat(p.opening_stock),
          quantity_out: 0,
          rate: parseFloat(p.opening_stock_rate || p.purchase_rate || 0),
          balance_quantity: parseFloat(p.opening_stock),
          remarks: 'Opening Stock (Imported)',
        }));
      if (ledgerEntries.length > 0) {
        await StockLedger.bulkCreate(ledgerEntries, { ignoreDuplicates: true });
      }

    } else {
      // ── Row-by-row import for parties ─────────────────────────────────────

      // Case-insensitive parsers — users fill Excel by hand and type "yes",
      // "YES", "receivable", "PAYABLE" etc. Without these normalisers the
      // value would silently become false / default, corrupting opening
      // balances and credit policy.
      const parseYesNo = (v) => {
        if (v === true || v === 1) return true;
        if (v == null) return false;
        const s = String(v).trim().toLowerCase();
        return ['yes', 'y', 'true', '1'].includes(s);
      };
      const parseBalanceType = (v) => {
        const s = String(v ?? '').trim().toLowerCase();
        if (s === 'payable' || s === 'cr' || s === 'credit') return 'Payable';
        return 'Receivable'; // default + Receivable/Dr/Debit all fall through
      };
      // Non-negative number parser — opening balance and credit limit may
      // only be positive. Accounting convention is that the SIGN is carried
      // by the separate "Balance Type" column, so a negative in the number
      // column is always a typo.
      const toNonNegNum = (v) => {
        const n = parseFloat(v);
        if (!isFinite(n) || n < 0) return 0;
        return n;
      };

      for (const { rowNumber, data } of rows) {
        try {
          const partyName = data['Party Name *'] || data['Party Name'];
          const mobile = String(data['Mobile 1 *'] || data['Mobile 1'] || '');
          if (!partyName || !mobile) {
            errors.push({ row: rowNumber, reason: 'Missing required field (Name or Mobile)', rowData: data });
            skipped++;
            continue;
          }
          await Party.findOrCreate({
            where: { party_name: partyName, mobile_1: mobile },
            defaults: {
              party_type: moduleName === 'customers' ? 'Customer' : 'Supplier',
              party_name: partyName,
              mobile_1: mobile,
              mobile_2: data['Mobile 2'] ? String(data['Mobile 2']) : null,
              email: data['Email'] || null,
              address_line_1: data['Address Line 1'] || null,
              city: data['City'] || null,
              state: data['State'] || null,
              pincode: data['Pincode'] ? String(data['Pincode']) : null,
              gstin: data['GSTIN'] || null,
              pan_number: data['PAN'] || null,
              credit_allowed: parseYesNo(data['Credit Allowed (Yes/No)'] ?? data['Credit Allowed']),
              credit_limit: toNonNegNum(data['Credit Limit']),
              opening_balance: toNonNegNum(data['Opening Balance']),
              opening_balance_type: parseBalanceType(data['Balance Type (Receivable/Payable)'] ?? data['Balance Type']),
              created_by: req.user.user_id,
            },
          });
          imported++;
        } catch (err) {
          errors.push({ row: rowNumber, reason: err.message, rowData: data });
          skipped++;
        }
      }
    }

    res.json({
      message: `Import completed: ${imported} imported, ${skipped} skipped`,
      imported,
      skipped,
      errors,
      total: rows.length,
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Import failed: ' + error.message });
  }
};

/* ── Generate failed-rows Excel report ──────────────────────────────────── */
exports.generateFailedReport = async (req, res) => {
  try {
    const { errors = [], module: moduleName = 'products' } = req.body;
    if (!errors.length) return res.status(400).json({ error: 'No failed rows provided' });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Failed Rows');

    // Build columns from first rowData keys + prepend Row# and append Remark
    const sampleData = errors[0]?.rowData || {};
    const dataKeys = Object.keys(sampleData);

    sheet.columns = [
      { header: 'Row #', key: '_row', width: 8 },
      ...dataKeys.map(k => ({ header: k, key: k, width: 20 })),
      { header: 'Remark (Why Not Imported)', key: '_reason', width: 40 },
    ];

    // Style header
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };

    // Add rows
    errors.forEach(({ row, reason, rowData = {} }) => {
      const rowObj = { _row: row, _reason: reason };
      dataKeys.forEach(k => { rowObj[k] = rowData[k] ?? ''; });
      const addedRow = sheet.addRow(rowObj);
      addedRow.getCell('_reason').font = { color: { argb: 'FFDC2626' }, italic: true };
    });

    sheet.autoFilter = { from: 'A1', to: String.fromCharCode(64 + sheet.columns.length) + '1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=failed_import_report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Failed report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
};

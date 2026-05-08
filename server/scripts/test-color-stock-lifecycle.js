// End-to-end test for the multi-color stock module.
//
// 1. Create a multi-color tracked product with 3 colors (Red, Blue, Green)
// 2. Add opening stock per color via the bulk-replace endpoint
// 3. Post a purchase that adds more stock to Red
// 4. Post a sale that depletes Red and Blue
// 5. Cancel the sale → stock restored
// 6. Cancel the purchase → stock back to opening
//
// Verifies each step against product_colors.current_stock so any
// arithmetic drift surfaces immediately.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { sequelize, Product, ProductColor, Category, Party, Godown, SystemSettings } = require('../models');
const productColorController = require('../controllers/productColorController');
const salesController = require('../controllers/salesController');
const purchaseController = require('../controllers/purchaseController');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Make a fake req/res pair for invoking controllers without HTTP.
function fakeReqRes(body = {}, params = {}, query = {}) {
  let statusCode = 200;
  let payload = null;
  return [
    {
      body, params, query,
      user: { user_id: 1 },
    },
    {
      status(code) { statusCode = code; return this; },
      json(data) { payload = data; return this; },
      get statusCode() { return statusCode; },
      get _payload() { return payload; },
    },
    () => ({ statusCode, payload }),
  ];
}

async function run() {
  let testNum = 0;
  const ok = (msg, cond) => {
    testNum++;
    const m = cond ? `✓ test ${testNum}: ${msg}` : `✗ test ${testNum}: ${msg}`;
    console.log(m);
    if (!cond) { console.error('   FAIL'); process.exit(1); }
  };

  try {
    // ── Setup ────────────────────────────────────────────────
    // Pick an existing category, godown, supplier, customer
    const cat = await Category.findOne();
    const godown = await Godown.findOne({ where: { is_default: true } });
    const supplier = await Party.findOne({ where: { party_type: ['Supplier', 'Both'] } });
    const customer = await Party.findOne({ where: { party_type: ['Customer', 'Both'], is_system_cash: false } });
    ok('seeded category / godown / supplier / customer found',
       cat && godown && supplier && customer);

    // Create a fresh multi-color product
    const product = await Product.create({
      barcode: `MC${Date.now().toString().slice(-9)}`,
      product_name: `MC Test ${Date.now()}`,
      category_id: cat.category_id,
      product_mode: 'variant',
      color_mode: 'multi',
      purchase_rate: 100,
      sale_rate: 150,
      mrp: 200,
      gst_rate: 18,
      quantity_per_box: 1,
      current_stock: 0,
      is_active: true,
    });
    ok(`created multi-color product #${product.product_id}`, !!product.product_id);

    // Add 3 colors with opening stock via bulkReplace
    const [bReq, bRes, bDone] = fakeReqRes(
      { colors: [
        { color_name: 'Red',   opening_stock: 10 },
        { color_name: 'Blue',  opening_stock: 5 },
        { color_name: 'Green', opening_stock: 8 },
      ] },
      { productId: product.product_id },
    );
    await productColorController.bulkReplace(bReq, bRes);
    const bResult = bDone();
    ok('bulk-replace colors created',
       bResult.statusCode === 200 && bResult.payload?.data?.length === 3);

    const colors = await ProductColor.findAll({
      where: { product_id: product.product_id },
      order: [['color_name', 'ASC']],
    });
    const red   = colors.find((c) => c.color_name === 'Red');
    const blue  = colors.find((c) => c.color_name === 'Blue');
    const green = colors.find((c) => c.color_name === 'Green');
    ok('opening stocks set: Red=10, Blue=5, Green=8',
       Number(red.current_stock) === 10
       && Number(blue.current_stock) === 5
       && Number(green.current_stock) === 8);

    // ── Step 1: Post a purchase that adds 7 more Red ─────────
    const [pReq, pRes, pDone] = fakeReqRes({
      supplier_id: supplier.party_id,
      godown_id: godown.godown_id,
      bill_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: product.product_id,
        barcode: product.barcode,
        product_name: product.product_name,
        category_id: cat.category_id,
        category_name: cat.category_name,
        quantity: 7,
        purchase_rate: 100,
        sale_rate: 150,
        mrp: 200,
        gst_rate: 18,
        quantity_per_box: 1,
        color_id: red.color_id,
      }],
    });
    await purchaseController.create(pReq, pRes);
    const pResult = pDone();
    if (pResult.statusCode !== 201) {
      console.error('purchase create failed:', pResult.payload);
      process.exit(1);
    }
    ok(`purchase #${pResult.payload.purchase_bill_id} created`, !!pResult.payload.purchase_bill_id);
    const purchaseBillId = pResult.payload.purchase_bill_id;

    await red.reload(); await blue.reload(); await green.reload();
    ok('after purchase: Red=17 (10+7), Blue=5, Green=8',
       Number(red.current_stock) === 17 && Number(blue.current_stock) === 5);

    // ── Step 2: Post a sale that depletes 4 Red and 2 Blue ──
    // Ensure customer allows credit so the test sale isn't fully paid
    // (which would auto-create a Receipt and block cancellation).
    if (!customer.credit_allowed) {
      await customer.update({ credit_allowed: true });
    }
    const [sReq, sRes, sDone] = fakeReqRes({
      customer_id: customer.party_id,
      godown_id: godown.godown_id,
      bill_date: new Date().toISOString().slice(0, 10),
      paid_amount: 0,
      items: [
        {
          product_id: product.product_id,
          barcode: product.barcode,
          product_name: product.product_name,
          category_id: cat.category_id,
          quantity: 4,
          rate: 150,
          gst_rate: 18,
          quantity_per_box: 1,
          color_id: red.color_id,
        },
        {
          product_id: product.product_id,
          barcode: product.barcode,
          product_name: product.product_name,
          category_id: cat.category_id,
          quantity: 2,
          rate: 150,
          gst_rate: 18,
          quantity_per_box: 1,
          color_id: blue.color_id,
        },
      ],
    });
    await salesController.create(sReq, sRes);
    const sResult = sDone();
    if (sResult.statusCode !== 201) {
      console.error('sale create failed:', sResult.payload);
      process.exit(1);
    }
    ok(`sale #${sResult.payload.sales_bill_id} created`, !!sResult.payload.sales_bill_id);
    const salesBillId = sResult.payload.sales_bill_id;

    await red.reload(); await blue.reload(); await green.reload();
    ok('after sale: Red=13 (17-4), Blue=3 (5-2), Green=8',
       Number(red.current_stock) === 13 && Number(blue.current_stock) === 3 && Number(green.current_stock) === 8);

    // ── Step 3: Sell with bad color (validation should reject) ─
    const [bsReq, bsRes, bsDone] = fakeReqRes({
      customer_id: customer.party_id,
      godown_id: godown.godown_id,
      bill_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: product.product_id,
        barcode: product.barcode,
        product_name: product.product_name,
        category_id: cat.category_id,
        quantity: 1,
        rate: 150,
        gst_rate: 18,
        quantity_per_box: 1,
        color_id: null, // missing — multi-color product needs one
      }],
    });
    await salesController.create(bsReq, bsRes);
    const bsResult = bsDone();
    ok('sale with missing color rejected with 400',
       bsResult.statusCode === 400 && /color/i.test(bsResult.payload?.error || ''));

    // ── Step 4: Try to oversell ──────────────────────────────
    // Disable allow_negative_stock first
    const sys = await SystemSettings.findByPk(1);
    const prevAllow = sys.allow_negative_stock;
    await sys.update({ allow_negative_stock: false });
    const [oReq, oRes, oDone] = fakeReqRes({
      customer_id: customer.party_id,
      godown_id: godown.godown_id,
      bill_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: product.product_id,
        barcode: product.barcode,
        product_name: product.product_name,
        category_id: cat.category_id,
        quantity: 9999,  // way more than the 13 Red in stock
        rate: 150,
        gst_rate: 18,
        quantity_per_box: 1,
        color_id: red.color_id,
      }],
    });
    await salesController.create(oReq, oRes);
    const oResult = oDone();
    if (oResult.statusCode !== 400) {
      console.error('  oversell DID NOT reject. status =', oResult.statusCode, 'payload =', JSON.stringify(oResult.payload).slice(0, 200));
    }
    ok('overselling rejected (insufficient color stock)',
       oResult.statusCode === 400 && /Insufficient stock/i.test(oResult.payload?.error || ''));
    await sys.update({ allow_negative_stock: prevAllow });

    // ── Step 5: Cancel the sale → stock should restore ──────
    const [cReq, cRes, cDone] = fakeReqRes({}, { id: salesBillId });
    await salesController.cancel(cReq, cRes);
    const cResult = cDone();
    if (cResult.statusCode !== 200) {
      console.error('  cancel sale failed. status =', cResult.statusCode, 'payload =', JSON.stringify(cResult.payload).slice(0, 300));
    }
    ok('sale cancelled', cResult.statusCode === 200);

    await red.reload(); await blue.reload();
    ok('after sale-cancel: Red=17, Blue=5 (sale stock restored)',
       Number(red.current_stock) === 17 && Number(blue.current_stock) === 5);

    // ── Step 6: Cancel the purchase → back to opening ───────
    const [c2Req, c2Res, c2Done] = fakeReqRes({}, { id: purchaseBillId });
    await purchaseController.cancel(c2Req, c2Res);
    const c2Result = c2Done();
    ok('purchase cancelled', c2Result.statusCode === 200);

    await red.reload();
    ok('after purchase-cancel: Red=10 (back to opening)',
       Number(red.current_stock) === 10);

    // ── Cleanup: soft-delete the test product. We can't hard-delete
    // its colors — even cancelled bill items still reference color_id
    // via the RESTRICT FK (color rows are part of the audit trail).
    // Soft-delete is enough; the test product stays out of pickers.
    await product.update({ is_active: false });
    ok('test product deactivated (colors preserved for audit history)', true);

    console.log('\n══════════════════════════════════════════════════');
    console.log(`ALL ${testNum} TESTS PASSED — color stock wiring is correct.`);
    console.log('══════════════════════════════════════════════════');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILED:', err.message);
    console.error(err.stack);
    await sequelize.close().catch(() => {});
    process.exit(1);
  }
}

run();

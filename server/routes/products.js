const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const productColorController = require('../controllers/productColorController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Read endpoints are covered by inventory.view. Even a Salesman needs to
// be able to look products up to add them to a sales bill.
router.get('/',                   requirePermission('inventory.view'),   productController.getAll);
router.get('/low-stock',          requirePermission('inventory.view'),   productController.getLowStock);
router.get('/next-barcode',       requirePermission('inventory.create'), productController.getNextBarcode);
// Audit GST-H5 — UQC list endpoint. Returns the canonical 45-code GSTN
// list ({code,label,gstn}) so the Product form dropdown can render the
// full set without hard-coding it on the client (any future addition
// to uqcCodes.js shows up everywhere on next reload). No permission
// gate beyond the global authenticateToken — UQC codes are public
// reference data.
router.get('/uqc-codes', (req, res) => {
  const { UQC_CODES } = require('../utils/uqcCodes');
  res.json({ data: UQC_CODES });
});
router.get('/barcode/:barcode',   requirePermission('inventory.view'),   productController.getByBarcode);
router.get('/:id/batches',        requirePermission('inventory.view'),   productController.getBatches);

// ── Product colors (multi-color stock module) ─────────────────────
//
// Per-product color list with per-color stock. Routes nest under
// /api/products/:productId/colors so the parent FK is implicit and
// permissions cascade naturally from the inventory module.
//
// IMPORTANT: these route definitions MUST come before the general
// /:id route below — Express matches in declaration order, and a
// path like /api/products/12/colors would otherwise be swallowed by
// /:id (which would treat "12/colors" as the product id and fail).
router.get('/:productId/colors',         requirePermission('inventory.view'),   productColorController.list);
router.post('/:productId/colors',        requirePermission('inventory.edit'),   productColorController.create);
router.put('/:productId/colors/:id',     requirePermission('inventory.edit'),   productColorController.update);
router.delete('/:productId/colors/:id',  requirePermission('inventory.edit'),   productColorController.remove);
router.post('/:productId/colors/bulk',   requirePermission('inventory.edit'),   productColorController.bulkReplace);

router.get('/:id',                requirePermission('inventory.view'),   productController.getById);
router.get('/:id/stock-movement', requirePermission('inventory.view'),   productController.getStockMovement);
router.post('/',                  requirePermission('inventory.create'), productController.create);
router.put('/:id',                requirePermission('inventory.edit'),   productController.update);
router.post('/:id/adjust',        requirePermission('inventory.edit'),   productController.adjust);
router.delete('/:id',             requirePermission('inventory.delete'), productController.delete);

module.exports = router;

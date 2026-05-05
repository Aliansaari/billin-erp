// ── Cheques routes ─────────────────────────────────────────────────
//
// Cheque register + lifecycle actions. See controllers/chequeController.js
// for the lifecycle state machine and the per-event voucher posts.
//
// Route ordering: the lifecycle action paths sit under /:cheque_id/<action>
// so they're naturally distinct from the bare /:cheque_id detail GET.
// No conflict with the static / and the parametric routes because the
// register sits at /, not at /something/.

const express = require('express');
const router = express.Router();
const cheque = require('../controllers/chequeController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',                     requirePermission('cheques.view'),   cheque.list);
router.get('/:cheque_id',           requirePermission('cheques.view'),   cheque.getById);
router.post('/',                    requirePermission('cheques.create'), cheque.create);
router.put('/:cheque_id',           requirePermission('cheques.edit'),   cheque.update);

// Lifecycle actions all sit at cheques.edit — the underlying ledger
// posting is the same auditable / reversible voucher mechanism the
// rest of the app uses, so a Manager-tier user can drive the full
// cheque lifecycle without needing the destructive .delete grant.
router.post('/:cheque_id/deposit',  requirePermission('cheques.edit'),   cheque.deposit);
router.post('/:cheque_id/clear',    requirePermission('cheques.edit'),   cheque.clear);
router.post('/:cheque_id/bounce',   requirePermission('cheques.edit'),   cheque.bounce);
router.post('/:cheque_id/cancel',   requirePermission('cheques.delete'), cheque.cancel);
router.post('/:cheque_id/reopen',   requirePermission('cheques.edit'),   cheque.reopen);

module.exports = router;

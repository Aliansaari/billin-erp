const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/printController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/profiles',               ctrl.list);
router.get('/profiles/default/:doc_type', ctrl.getDefault);
router.get('/profiles/:id',           ctrl.getById);
router.post('/profiles',              ctrl.create);
router.put('/profiles/:id',           ctrl.update);
router.delete('/profiles/:id',        ctrl.remove);
router.post('/profiles/:id/duplicate', ctrl.duplicate);

module.exports = router;

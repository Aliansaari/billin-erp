const express = require('express');
const router = express.Router();
const membershipController = require('../controllers/membershipController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

/*
 * Membership (loyalty) routes.
 *
 * Reads are open to any authenticated user — the enrolment card, the members
 * list, and (from a later phase) the billing lookup all need them, and counter
 * staff don't hold settings.manage_company.
 *
 * Permission split (coherent with the parties module):
 *   · Plan setup (create/update/delete plans) is configuration → gated to
 *     company-settings managers (settings.manage_company).
 *   · Enrolling / managing an individual customer's membership is customer
 *     management → gated to parties.edit, so counter managers can enrol a
 *     walk-in from the customer card without full admin rights.
 * Nothing here touches any total/tax/ledger/balance — membership is loyalty
 * metadata.
 */

// ── Plans (setup — admin) ──
router.get('/plans',        membershipController.getAllPlans);
router.get('/plans/:id',    membershipController.getPlanById);
router.post('/plans',       requirePermission('settings.manage_company'), membershipController.createPlan);
router.put('/plans/:id',    requirePermission('settings.manage_company'), membershipController.updatePlan);
router.delete('/plans/:id', requirePermission('settings.manage_company'), membershipController.deletePlan);

// ── Report (read-only KPIs + reminder lists) ──
router.get('/report',                     membershipController.getReport);

// ── Memberships (customer management — parties.edit) ──
router.get('/memberships',                membershipController.getAllMemberships);
router.get('/memberships/by-party/:partyId', membershipController.getMembershipByParty);
router.get('/memberships/:id/points',        membershipController.getPointsLedger);
router.post('/memberships',               requirePermission('parties.edit'), membershipController.enroll);
router.post('/memberships/bulk-enroll',   requirePermission('parties.edit'), membershipController.bulkEnroll);
router.put('/memberships/:id',            requirePermission('parties.edit'), membershipController.updateMembership);
router.delete('/memberships/:id',         requirePermission('parties.edit'), membershipController.deleteMembership);

module.exports = router;

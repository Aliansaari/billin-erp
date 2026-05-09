// ── Inter-state resolver ────────────────────────────────────────────
//
// Returns true (inter-state) when both the company's state code and the
// counterparty's place-of-supply state code are known AND differ. In
// any ambiguous case (no party, missing GSTIN/state, missing settings)
// defaults to false (intra-state) so legacy behaviour is preserved —
// the safer default for cash-counter and walk-in flows.
//
// Mirrors the same logic GSTR-1's classifier (utils/gstr1.js
// `isInterState`/`placeOfSupply`) uses on the read side, so what gets
// STORED here is what the report will then SEE.
//
// Extracted from salesController so salesReturnController and
// purchaseReturnController can reuse it. Returns and forward bills
// MUST classify identically — otherwise an inter-state credit/debit
// note posts to the wrong GST head and GSTR-1's Credit Note section
// reports the wrong place-of-supply (audit H1).

'use strict';

const { Party, SystemSettings } = require('../models');
const { stateCodeFromGstin, stateCodeFromName } = require('./gstr1');

/**
 * Resolve whether a transaction is inter-state vs intra-state.
 *
 *   resolveInterState({ partyId, transaction })          → boolean
 *
 * Caller passes the customer/supplier party id (whichever side of the
 * trade applies) plus an optional Sequelize transaction.
 */
async function resolveInterState({ partyId, transaction } = {}) {
  if (!partyId) return false;
  const [party, settings] = await Promise.all([
    Party.findByPk(partyId, { transaction }),
    SystemSettings.findByPk(1, { transaction }),
  ]);
  if (!party) return false;
  const companyCode = settings ? stateCodeFromGstin(settings.gstin) : null;
  if (!companyCode) return false;
  // Counterparty place-of-supply: GSTIN prefix wins, fall back to state name.
  const partyCode = stateCodeFromGstin(party.gstin) || stateCodeFromName(party.state);
  if (!partyCode) return false;
  return partyCode !== companyCode;
}

module.exports = { resolveInterState };

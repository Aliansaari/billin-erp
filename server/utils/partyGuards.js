/*
 * Party-level guards invoked at bill-save time.
 *
 *   Blacklist:     hard-block every attempt to create or edit a bill for a
 *                  Blacklisted party. The shopkeeper can clear the status
 *                  from the customer record first and retry.
 *
 *   Credit limit:  hard-block on the sales side only (customers). When the
 *                  bill would push the customer's outstanding past their
 *                  credit_limit the save is refused with a message that
 *                  spells out the current exposure, the limit, and the
 *                  shortfall so the counter-person can decide whether to
 *                  ask for part-payment or call the owner.
 *                  credit_limit == 0 is treated as "no limit set" and the
 *                  check is skipped — matches existing behaviour on
 *                  credit_allowed=true customers without a configured cap.
 *
 * Returns null when the bill is allowed; returns { status, error } when
 * the caller must abort the transaction and reply to the client.
 */

function checkPartyForBillSave({ party, newBillOutstanding, oldBillOutstanding = 0, enforceCreditLimit = false }) {
  if (!party) return null;

  if (party.party_status === 'Blacklist') {
    return {
      status: 400,
      error: `"${party.party_name}" is Blacklisted. Remove the blacklist flag on the party record before transacting.`,
    };
  }

  if (!enforceCreditLimit) return null;

  const limit = parseFloat(party.credit_limit || 0);
  if (limit <= 0) return null;   // 0 = no cap set; treat as infinite.

  const currentBalance = parseFloat(party.current_balance || 0);
  // For an UPDATE, the party's current_balance already reflects the old
  // version of this bill. Subtracting the old outstanding gives us the
  // "balance excluding this bill"; adding the new outstanding produces
  // the projected balance after the save lands.
  const projected = +(currentBalance - oldBillOutstanding + newBillOutstanding).toFixed(2);

  if (projected > limit + 0.01) {
    const availableBeforeBill = +(limit - (currentBalance - oldBillOutstanding)).toFixed(2);
    return {
      status: 400,
      error:
        `Credit limit exceeded for "${party.party_name}". ` +
        `Outstanding ₹${currentBalance.toFixed(2)} of ₹${limit.toFixed(2)} limit ` +
        `(₹${Math.max(0, availableBeforeBill).toFixed(2)} available). ` +
        `This bill would take outstanding to ₹${projected.toFixed(2)}. ` +
        `Either take part-payment against the bill or raise the credit limit on the party record.`,
    };
  }

  return null;
}

module.exports = { checkPartyForBillSave };

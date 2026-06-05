/**
 * WhatsApp message templates — canonical defaults + a safe one-time upgrade.
 *
 * DEFAULT_TEMPLATES is the current wording (kept in sync with the model defaults
 * in models/WhatsappSettings.js so fresh installs get them).
 *
 * Placeholders: {name} {billno} {amount} {shop} {date} and the balance figures
 * {previous} {outstanding} (bills) / {balance} (receipts). The balance ones are
 * "optional" — their whole line is dropped when empty (see fillTemplate).
 *
 * OLD_TEMPLATES are previous default wordings (per field). upgradePatch(row)
 * upgrades a stored template ONLY when it still EXACTLY equals an old default
 * (i.e. never customised), so improvements roll out without clobbering edits.
 */
const DEFAULT_TEMPLATES = {
  msg_template_bill:    'Hello {name},\n\nThank you for shopping with *{shop}*. Your bill *{billno}* for *{amount}* is attached below.\nPrevious balance: {previous}\nTotal outstanding: *{outstanding}*\n\nWe truly value your business!',
  msg_template_ledger:  'Hello {name},\n\nHere is your account statement from *{shop}*. Current balance: *{amount}*.\n\nThank you for your continued trust.',
  msg_template_receipt: 'Hello {name},\n\nWe have received your payment of *{amount}* — thank you! Receipt *{billno}* from *{shop}* is attached.\nRemaining balance: *{balance}*',
};

const OLD_TEMPLATES = {
  msg_template_bill: [
    'Namaste {name}, here is your invoice {billno} for {amount} from {shop}. Thank you for your business!',
    'Namaste {name},\n\nThank you for shopping with *{shop}*. Your bill *{billno}* for *{amount}* is attached below.\n\nWe truly value your business. 🙏',
    'Namaste {name},\n\nThank you for shopping with *{shop}*. Your bill *{billno}* for *{amount}* is attached below.\nPrevious balance: {previous}\nTotal outstanding: *{outstanding}*\n\nWe truly value your business. 🙏',
  ],
  msg_template_ledger: [
    'Namaste {name}, please find your account statement from {shop} attached. Thank you.',
    'Namaste {name},\n\nHere is your account statement from *{shop}*. Current balance: *{amount}*.\n\nThank you for your continued trust. 🙏',
  ],
  msg_template_receipt: [
    'Namaste {name}, we have received {amount}. Receipt {billno} attached. Thank you — {shop}.',
    'Namaste {name},\n\nWe have received your payment of *{amount}* — thank you! Receipt *{billno}* from *{shop}* is attached. 🙏',
    'Namaste {name},\n\nWe have received your payment of *{amount}* — thank you! Receipt *{billno}* from *{shop}* is attached.\nRemaining balance: *{balance}*\n\n🙏',
  ],
};

function upgradePatch(row) {
  const patch = {};
  for (const field of Object.keys(DEFAULT_TEMPLATES)) {
    const cur = row[field];
    if (cur != null && OLD_TEMPLATES[field] && OLD_TEMPLATES[field].includes(cur)) {
      patch[field] = DEFAULT_TEMPLATES[field];
    }
  }
  return patch;
}

module.exports = { DEFAULT_TEMPLATES, OLD_TEMPLATES, upgradePatch };

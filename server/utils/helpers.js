const dayjs = require('dayjs');

// prefix = custom prefix from settings (e.g. "INV"), or empty string for plain 0001
function generateBillNumber(prefix, lastNumber) {
  const num = String((lastNumber || 0) + 1).padStart(4, '0');
  return prefix ? `${prefix}-${num}` : num;
}

function generateTransactionNumber(prefix, lastNumber) {
  const num = String((lastNumber || 0) + 1).padStart(6, '0');
  return `${prefix}-${num}`;
}

function roundOff(amount) {
  const rounded = Math.round(amount);
  return {
    roundedAmount: rounded,
    roundOffValue: +(rounded - amount).toFixed(2),
  };
}

function calculateGST(taxableAmount, gstRate, isInterState = false) {
  const totalTax = +(taxableAmount * gstRate / 100).toFixed(2);
  if (isInterState) {
    return { cgst: 0, sgst: 0, igst: totalTax };
  }
  const half = +(totalTax / 2).toFixed(2);
  return { cgst: half, sgst: totalTax - half, igst: 0 };
}

function paginateQuery(query, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  return { ...query, limit, offset };
}

module.exports = {
  generateBillNumber,
  generateTransactionNumber,
  roundOff,
  calculateGST,
  paginateQuery,
};

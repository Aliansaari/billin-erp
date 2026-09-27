import dayjs from 'dayjs';

/** ₹ with Indian grouping. `dp` = decimals shown (0 for whole rupees). */
export const inr = (n, dp = 0) => {
  const v = Number(n) || 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp === 0 ? 2 : dp })}`;
};
export const inr0 = (n) => inr(Math.round(Number(n) || 0));
export const monthLabel = (period) => dayjs(`${period}-01`).format('MMMM YYYY');
export const cap = (n) => String(n || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
export const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const errText = (e, fallback) => e?.response?.data?.error || fallback;

export const PAY_TYPES = {
  monthly: { label: 'Monthly salary', unit: '/ month', hint: 'Fixed pay; absences and unpaid leave are cut' },
  daily:   { label: 'Daily wage',     unit: '/ day',   hint: 'Paid for each day worked' },
  hourly:  { label: 'Hourly',         unit: '/ hour',  hint: 'Paid for hours on the clock' },
};

/** Status of one payslip line on the pay run. */
export function lineStatus(line, runStatus) {
  if (runStatus !== 'finalized') return { key: 'draft', label: 'Draft', tone: 'idle' };
  if (line.hold) return { key: 'hold', label: 'On hold', tone: 'late' };
  if (line.due <= 0) return { key: 'paid', label: 'Paid', tone: 'ok' };
  if (line.paid > 0) return { key: 'part', label: 'Part paid', tone: 'late' };
  return { key: 'due', label: 'To pay', tone: 'leave' };
}

/** 1st, 2nd, 3rd, 4th … 21st, 22nd. */
export const ordinal = (n) => {
  const v = Number(n) || 0; const t = v % 100;
  return `${v}${t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')}`;
};
/** "15th to 14th" for a cycle that starts on the 15th; "1st to month end" for day 1. */
export const cycleText = (day) => (Number(day) > 1 ? `${ordinal(day)} to ${ordinal(Number(day) - 1)}` : '1st to month end');

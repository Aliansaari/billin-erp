// Indian-style number grouping (matches desktop's billPdf.js convention).
// 9565636 → "95,65,636" (lakh-crore grouping, not Western thousand groups).
export function formatINR(value, { decimals = 0 } = {}) {
  const n = Number(value || 0);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatINRWithSymbol(value, opts = {}) {
  return `₹ ${formatINR(value, opts)}`;
}

// "22 Aug '25" — short Indian-style date label used in voucher lists.
export function formatShortDate(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const day = d.getDate();
  const month = d.toLocaleString('en-IN', { month: 'short' });
  const year = String(d.getFullYear()).slice(-2);
  return `${day} ${month} '${year}`;
}

// "9 MAY" — uppercase mono pill used on the dashboard hero.
export function formatPillDate(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${d.toLocaleString('en-IN', { month: 'short' }).toUpperCase()}`;
}

// "Sat · 9 May · Pune" — header greeting subtitle. City passed in by caller
// since it isn't available pre-login from the JWT payload.
export function formatGreetingDate(date = new Date(), city = '') {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.toLocaleString('en-IN', { weekday: 'short' });
  const dom = d.getDate();
  const mon = d.toLocaleString('en-IN', { month: 'short' });
  const parts = [`${day}`, `${dom} ${mon}`];
  if (city) parts.push(city);
  return parts.join(' · ');
}

export function greetingPrefix(date = new Date()) {
  const h = (date instanceof Date ? date : new Date(date)).getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

// "01 Apr 25 - 31 Mar 26" range label
export function formatDateRange(from, to) {
  return `${formatShortDate(from)} - ${formatShortDate(to)}`;
}

// Default range: Indian fiscal year (Apr 1 of current FY → Mar 31 next).
export function defaultFY() {
  const now = new Date();
  const year = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return {
    from: new Date(year, 3, 1),
    to:   new Date(year + 1, 2, 31),
  };
}

// "9:12 AM" — 12h time used on activity rows.
export function formatTime(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// "2026-05-10" — for date-input + day-book API params.
export function isoDate(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

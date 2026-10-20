import { tokenize, soundKey, similarity, numberWords, wordValue, spokenDigits } from './text.js';

/*
 * parseCommand(text) — what did the operator ask for?
 *
 * Input is whatever the speech engine heard, in English, Hindi
 * (Devanagari) or a mix. Output is a plain intent object; nothing here
 * touches the app. The voice layer (VoiceCommands.jsx) carries it out.
 *
 *   { intent: 'new_sale',     party }        "zehen create sales bill for ali"
 *   { intent: 'new_purchase', party }        "gupta ka purchase bill banao"
 *   { intent: 'show_ledger',  party }        "show me ali ledger", "ali ka statement"
 *   { intent: 'open_bill',    billNo|null }  "open that bill", "bill 1452 kholo"
 *   { intent: 'set_qty',      qty }          "make it 10", "quantity das karo"
 *   { intent: 'add_barcode',  code }         "add barcode 8 9 0 1 2 3"
 *   { intent: 'add_product',  query, qty }   "add frock 20 into 20"
 *   { intent: 'focus_scan' }                 "scan", "barcode"
 *   { intent: 'navigate',     query }        "open stock report", "customers dikhao"
 *   { intent: 'wake' }                       just "zehen"
 *   { intent: 'none' }                       nothing usable
 *
 * Every word list holds the English word, its Hindi equivalents, and the
 * way the Hindi model spells the English word in Devanagari once
 * transliterated ("लेजर" → "lejar").
 */

const WAKE      = ['zehen', 'zehan', 'zehn', 'zehin', 'jehen', 'zahen', 'zahan'];
const WAKE_LEAD = ['hey', 'he', 'hi', 'ok', 'okay', 'oke', 'hello', 'helo'];
const CREATE    = ['create', 'kriet', 'new', 'nyu', 'naya', 'nayi', 'naye', 'bana', 'banao', 'banado', 'banaao', 'start', 'make', 'mek', 'karo'];
const SALE      = ['sale', 'sales', 'sel', 'sels', 'sell', 'bikri', 'becho'];
const BILL      = ['bill', 'bil', 'invoice', 'invois', 'parchi'];
const PURCHASE  = ['purchase', 'parchej', 'parches', 'kharid', 'kharidi', 'khareed', 'kharido'];
const LEDGER    = ['ledger', 'lejar', 'lejer', 'statement', 'stetment', 'istetment', 'khata', 'khaata', 'hisab', 'hisaab', 'account', 'akaunt'];
const OPEN      = ['open', 'opan', 'kholo', 'khol', 'kholna', 'dikhao', 'dikha', 'dikhaao', 'show', 'sho', 'batao', 'dekho', 'go', 'jao', 'chalo'];
const QTY       = ['quantity', 'kvantiti', 'kwantiti', 'qty', 'matra', 'piece', 'pieces', 'pcs', 'nag'];
const QTY_VERB  = ['kar', 'karo', 'kardo', 'krdo', 'karde', 'set', 'change', 'chenj', 'make', 'mek'];
const BARCODE   = ['barcode', 'barkod', 'barkode'];
const SCAN      = ['scan', 'skain', 'sken', 'scanner', 'skainar'];
const ADD       = ['add', 'aid', 'ed', 'jodo', 'jod', 'dalo', 'daalo', 'dal', 'lagao', 'daal'];
const LAST      = ['last', 'lst', 'that', 'dat', 'pichhla', 'pichla', 'pichhle', 'wo', 'woh', 'vo', 'previous', 'recent', 'akhri', 'aakhri'];
const FILLER    = [
  'for', 'phor', 'far', 'ka', 'ke', 'ki', 'ko', 'liye', 'lie', 'se', 'the', 'a', 'an', 'of', 'to', 'me', 'mein', 'mai',
  'please', 'plz', 'customer', 'kastamar', 'party', 'parti', 'naam', 'name', 'mera', 'mujhe', 'hai', 'it', 'is', 'this',
  'its', 'and', 'aur', 'ek', 'number', 'nambar', 'no', 'wala', 'vala', 'wali', 'up', 'me', 'my', 'in', 'on', 'kya',
];

const precompute = (list) => list.map(soundKey);
// "20 into 20", "20 by 20", "20 x 20" → the size "20*20".
const TIMES = ['into', 'intu', 'inatu', 'by', 'bai', 'cross', 'kros', 'guna', 'x', 'eks', 'ex'].map(soundKey);
const SETS = Object.fromEntries(Object.entries({
  WAKE, WAKE_LEAD, CREATE, SALE, BILL, PURCHASE, LEDGER, OPEN, QTY, QTY_VERB, BARCODE, SCAN, ADD, LAST, FILLER,
}).map(([k, v]) => [k, precompute(v)]));

// Short words need an exact sound match ("do" must not look like "go");
// longer words tolerate one slip ("kwantity").
function isWord(token, set) {
  const key = soundKey(token);
  if (!key) return false;
  if (set.includes(key)) return true;
  if (key.length < 5) return false;
  return set.some((w) => w.length >= 5 && similarity(key, w) >= 0.8);
}

const KEYWORD_SETS = ['CREATE', 'SALE', 'BILL', 'PURCHASE', 'LEDGER', 'OPEN', 'QTY', 'QTY_VERB', 'BARCODE', 'SCAN', 'ADD', 'LAST', 'FILLER'];
const isKeyword = (t) => KEYWORD_SETS.some((s) => isWord(t, SETS[s]));
const isNumber = (t) => /^\d+(\.\d+)?$/.test(t);

// Words left once the command words are taken out — the party name.
const nameWords = (tokens) => tokens.filter((t) => !isNumber(t) && !isKeyword(t)).join(' ');

export function stripWake(tokens) {
  let i = 0;
  if (tokens.length > 1 && isWord(tokens[0], SETS.WAKE_LEAD) && isWord(tokens[1], SETS.WAKE)) i = 2;
  else if (tokens.length && isWord(tokens[0], SETS.WAKE)) i = 1;
  return { woke: i > 0, rest: tokens.slice(i) };
}

export function parseCommand(text, { requireWake = false } = {}) {
  const { woke, rest } = stripWake(tokenize(text));
  if (requireWake && !woke) return { intent: 'none' };
  if (!rest.length) return { intent: woke ? 'wake' : 'none' };

  const raw = rest;                 // words as heard (for barcodes)
  const tokens = numberWords(raw);  // number words → digits
  const has = (name) => tokens.some((t) => isWord(t, SETS[name]));
  const indexOf = (name) => tokens.findIndex((t) => isWord(t, SETS[name]));
  const numbers = tokens.filter(isNumber).map(Number);
  // "fourteen fifty two" is how people say bill 1452.
  const billNo = tokens.filter(isNumber).join('') || null;

  // 1. Barcode — "add barcode 8901…", or just "barcode" to go scan.
  const CODE = [soundKey('code'), soundKey('kod')];
  const splitBarcode = raw.some((t, i) => soundKey(t) === 'bar' && CODE.includes(soundKey(raw[i + 1] || '')));
  if (has('BARCODE') || splitBarcode) {
    const at = raw.findIndex((t) => isWord(t, SETS.BARCODE) || CODE.includes(soundKey(t)));
    const code = spokenDigits(raw.slice(at + 1));
    if (code.length >= 3) return { intent: 'add_barcode', code };
    return { intent: 'focus_scan' };
  }
  if (has('SCAN') && !has('ADD')) return { intent: 'focus_scan' };

  // 2. Open a bill by number — before "new bill", both say "bill".
  if (has('BILL') && has('OPEN') && numbers.length) {
    return { intent: 'open_bill', billNo };
  }

  // 3. Change the quantity of the last line — "make it 10", "quantity das karo".
  if (!has('BILL') && !has('ADD') && !has('LEDGER')) {
    const qAt = indexOf('QTY');
    let qty = null;
    if (qAt >= 0) {
      // "quantity do" — "do" only means two right after a quantity word.
      const next = raw[raw.findIndex((t) => isWord(t, SETS.QTY)) + 1];
      qty = numbers.length ? numbers[numbers.length - 1] : (next != null ? wordValue(next, { loose: true }) : null);
    } else if (numbers.length === 1 && (has('QTY_VERB') || tokens.length === 1)) {
      qty = numbers[0];
    }
    if (qty != null && qty > 0) return { intent: 'set_qty', qty };
  }

  // 4. New sales / purchase bill, optionally for a party.
  const billish = has('BILL') || has('SALE');
  if (has('PURCHASE') && (has('BILL') || has('CREATE'))) {
    return { intent: 'new_purchase', party: nameWords(tokens) || null };
  }
  if ((has('SALE') && (has('BILL') || has('CREATE'))) || (has('BILL') && has('CREATE'))) {
    return { intent: 'new_sale', party: nameWords(tokens) || null };
  }

  // 5. Party ledger / statement.
  if (has('LEDGER')) {
    const party = nameWords(tokens);
    return party ? { intent: 'show_ledger', party } : { intent: 'navigate', query: 'ledger' };
  }

  // 6. "open that bill", "pichhla bill dikhao".
  if (billish && (has('OPEN') || has('LAST'))) {
    return { intent: 'open_bill', billNo };
  }

  // 7. Add a product by name — "add frock 20 into 20", "frock 20*20 jodo".
  if (has('ADD')) {
    let words = tokens.filter((t) => !isWord(t, SETS.ADD));
    let qty = null;
    const qAt = words.findIndex((t) => isWord(t, SETS.QTY));
    if (qAt >= 0) {
      const n = words.slice(qAt + 1).find(isNumber);
      if (n) qty = Number(n);
      words = words.slice(0, qAt);
    }
    const query = words
      .map((t) => (TIMES.includes(soundKey(t)) ? 'x' : t))
      .filter((t) => isNumber(t) || t === 'x' || !isWord(t, SETS.FILLER))
      .join(' ')
      .trim();
    if (query) return { intent: 'add_product', query, qty };
  }

  // 8. Anything else is a screen to open — "stock report", "customers dikhao".
  const query = tokens.filter((t) => !isWord(t, SETS.OPEN) && !isWord(t, SETS.FILLER)).join(' ').trim();
  if (query) return { intent: 'navigate', query };
  return { intent: 'none' };
}

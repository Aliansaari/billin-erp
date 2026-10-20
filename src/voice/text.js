/*
 * Voice text helpers — pure functions, no React, no browser APIs, so the
 * whole command pipeline runs (and is tested) in plain Node.
 *
 *   toLatin(text)       Devanagari → rough Latin ("अली का बिल" → "ali ka bil").
 *                       The Hindi speech model writes everything in
 *                       Devanagari, even English words, so every command
 *                       is matched in Latin.
 *   soundKey(word)      A loose "sounds like" key, so "Ali", "alee" and
 *                       "अली" all compare equal.
 *   similarity(a, b)    0..1 closeness of two sound keys.
 *   numberWords(tokens) Turns spoken number words (English + Hindi) into
 *                       digits: ["twenty", "five"] → ["25"].
 */

// ── Devanagari → Latin ──────────────────────────────────────────────
const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
  // Precomposed nukta letters.
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};
// Base letter + nukta (U+093C) written as two code points.
const NUKTA_FORMS = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y' };
const VOWELS = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const MATRAS = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const VIRAMA = '्';
const NUKTA = '़';
const MARKS = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' };

function wordToLatin(word) {
  let out = '';
  const chars = Array.from(word);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (CONSONANTS[c] != null) {
      let latin = CONSONANTS[c];
      if (chars[i + 1] === NUKTA) { latin = NUKTA_FORMS[c] || latin; i++; }
      const next = chars[i + 1];
      if (next === VIRAMA) { out += latin; i++; continue; }
      if (MATRAS[next] != null) { out += latin + MATRAS[next]; i++; continue; }
      // Inherent "a" — dropped at the end of a word ("बिल" → "bil", not "bila").
      const atEnd = i + 1 >= chars.length || MARKS[next] != null && i + 2 >= chars.length;
      out += atEnd ? latin : latin + 'a';
      continue;
    }
    if (VOWELS[c] != null) { out += VOWELS[c]; continue; }
    if (MARKS[c] != null) { out += MARKS[c]; continue; }
    if (c >= '०' && c <= '९') { out += String(c.charCodeAt(0) - 0x966); continue; }
    if (c === NUKTA || c === VIRAMA) continue;
    out += c;
  }
  // Long final vowels read as people type them: "अली" → "ali", "का" → "ka".
  return out.replace(/ee$/, 'i').replace(/aa$/, 'a').replace(/oo$/, 'u');
}

export function toLatin(text) {
  return String(text || '')
    .split(/(\s+)/)
    .map((w) => (/[ऀ-ॿ]/.test(w) ? wordToLatin(w) : w))
    .join('')
    .toLowerCase();
}

// Lower-case, Devanagari → Latin, "20*20" / "20x20" → "20 x 20",
// punctuation out, split into words.
export function tokenize(text) {
  // Punctuation off first: "अली।" must end like "अली" for the vowel rules.
  return toLatin(text.replace(/[।॥,.!?;:"“”]/g, ' '))
    .replace(/['’]s\b/g, '')          // Whisper writes "Ali's ledger"
    .replace(/(\d),(\d{3})\b/g, '$1$2')  // and "1,452"
    .replace(/(\d)\s*[*×]\s*(\d)/g, '$1 x $2')
    .replace(/(\d)x(\d)/g, '$1 x $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ── "Sounds like" key ───────────────────────────────────────────────
export function soundKey(word) {
  let w = toLatin(word).replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(w)) return w;
  w = w
    .replace(/ph/g, 'f')
    .replace(/[wv]/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/c(?!h)/g, 'k')
    .replace(/([kgtdbjcs])h/g, '$1')   // kh→k, bh→b, sh→s, chh→c…
    .replace(/ee|ii|ie|ea|y$/g, 'i')
    .replace(/oo|uu|ou/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ai|ay/g, 'e')
    .replace(/au|aw/g, 'o')
    .replace(/(.)\1+/g, '$1');         // doubled letters
  return w;
}

// One reused row buffer: matching runs over thousands of names per command.
let row = new Uint16Array(64);
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (row.length <= b.length) row = new Uint16Array(b.length * 2);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(up + 1, row[j - 1] + 1, diag + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Numbers must match exactly — "20 x 20" is never "20 x 30".
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return 0;
  const max = Math.max(a.length, b.length);
  const gap = Math.abs(a.length - b.length) / max;
  // Very different lengths can't be close; skip the full comparison.
  if (gap > 0.6) return 1 - gap;
  return 1 - levenshtein(a, b) / max;
}

// ── Spoken numbers ──────────────────────────────────────────────────
const EN_UNITS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// Hindi 0–100, written the way the Hindi model writes them. Converted
// through toLatin + soundKey below, so spelling drift ("pachchees",
// "pachis") still lands on the same number.
const HI_NUMBERS = [
  'शून्य', 'एक', 'दो', 'तीन', 'चार', 'पांच', 'छह', 'सात', 'आठ', 'नौ', 'दस',
  'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस', 'बीस',
  'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस', 'तीस',
  'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस', 'चालीस',
  'इकतालीस', 'बयालीस', 'तैंतालीस', 'चवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास', 'पचास',
  'इक्यावन', 'बावन', 'तिरेपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ', 'साठ',
  'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर', 'सत्तर',
  'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उन्यासी', 'अस्सी',
  'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी', 'नब्बे',
  'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे', 'सौ',
];
// Common Latin spellings people (and the English model) produce.
const HI_LATIN = {
  shunya: 0, sunya: 0, ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  chhe: 6, che: 6, chah: 6, chhah: 6, saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, no: 9, das: 10, dus: 10, dos: 10,
  gyarah: 11, barah: 12, baarah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17,
  atharah: 18, unnis: 19, bees: 20, bis: 20, pachis: 25, pachchis: 25, tees: 30, chalis: 40,
  pachas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90, sau: 100,
};
const AMBIGUOUS_EN = new Set(['oh', 'one']);
const SOUND_TO_NUMBER = new Map();
HI_NUMBERS.forEach((w, n) => SOUND_TO_NUMBER.set(soundKey(w), n));
for (const [w, n] of Object.entries(HI_LATIN)) SOUND_TO_NUMBER.set(soundKey(w), n);
// English number words as the Hindi model spells them ("ट्वेंटी" → "tventi").
for (const [w, n] of [...Object.entries(EN_UNITS), ...Object.entries(EN_TENS)]) {
  if (!AMBIGUOUS_EN.has(w)) SOUND_TO_NUMBER.set(soundKey(w), n);
}

const MULTIPLIERS = { hundred: 100, sau: 100, thousand: 1000, hazaar: 1000, hazar: 1000, lakh: 100000, lac: 100000 };
// "do" (two) and "no" are ordinary words too, so they only count as
// numbers right after a quantity / barcode word — see wordValue's `loose`.
const AMBIGUOUS = new Set(['do', 'no', 'sat', 'ek', 'tin', 'bis', 'oh', 'dos']);

export function wordValue(token, { loose = false } = {}) {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  if (!loose && AMBIGUOUS.has(token)) return null;
  if (EN_UNITS[token] != null) return EN_UNITS[token];
  if (EN_TENS[token] != null) return EN_TENS[token];
  const key = soundKey(token);
  if (!key || key.length < 2) return null;
  if (SOUND_TO_NUMBER.has(key)) {
    const n = SOUND_TO_NUMBER.get(key);
    if (!loose && AMBIGUOUS.has(token)) return null;
    return n;
  }
  return null;
}

// Collapse runs of number words into one numeric token.
//   ["make", "it", "twenty", "five"]       → ["make", "it", "25"]
//   ["one", "hundred", "twenty"]           → ["120"]
//   ["paanch", "sau"]                      → ["500"]
export function numberWords(tokens, opts = {}) {
  const out = [];
  let total = null;
  let current = 0;
  const flush = () => {
    if (total != null) out.push(String(total + current));
    total = null; current = 0;
  };
  for (const t of tokens) {
    const mult = MULTIPLIERS[t] ?? (SOUND_TO_NUMBER.get(soundKey(t)) === 100 ? 100 : null);
    if (mult && total != null) {
      if (mult >= 1000) { total += (current || 1) * mult; current = 0; } else { current = (current || 1) * mult; }
      continue;
    }
    const v = wordValue(t, opts);
    if (v == null || /^\d+$/.test(t) && total != null) {
      flush();
      if (v != null) { total = 0; current = v; continue; }
      out.push(t);
      continue;
    }
    if (total == null) { total = 0; current = v; continue; }
    // "twenty five" → 25, "hundred twenty" → 120; "five five" is two numbers.
    const lastTwo = current % 100;
    if (current >= 100 && lastTwo === 0 && v < 100) current += v;
    else if (lastTwo >= 20 && lastTwo % 10 === 0 && v < 10) current += v;
    else { flush(); total = 0; current = v; }
  }
  flush();
  return out;
}

// Barcode digits as spoken: "8 9 0 1", "eight nine zero one",
// "double five", "aath nau shunya" → "89015…".
export function spokenDigits(tokens) {
  let digits = '';
  let repeat = 1;
  for (const t of tokens) {
    if (t === 'double') { repeat = 2; continue; }
    if (t === 'triple') { repeat = 3; continue; }
    if (/^\d+$/.test(t)) { digits += t.repeat(repeat); repeat = 1; continue; }
    const v = wordValue(t, { loose: true });
    if (v != null && v < 10) { digits += String(v).repeat(repeat); repeat = 1; continue; }
    if (v != null && v < 100) { digits += String(v); repeat = 1; continue; }
  }
  return digits;
}

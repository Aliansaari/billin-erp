import { tokenize, soundKey, similarity } from './text.js';

/*
 * Fuzzy "which party / product / screen did they say" matching. Works on
 * sound keys, so spoken "ali", Hindi-model "अली" and the stored "ALI
 * TRADERS" all line up. Pure and synchronous: matching a few thousand
 * names takes a few milliseconds.
 */

// Names repeat across commands (the same parties, the same catalogue),
// so their keys are worked out once and kept.
const keyCache = new Map();
function keysOf(text) {
  let k = keyCache.get(text);
  if (!k) {
    if (keyCache.size > 50000) keyCache.clear();
    k = tokenize(text).map(soundKey).filter(Boolean);
    k.joined = k.join('');
    keyCache.set(text, k);
  }
  return k;
}

// How well the spoken words cover a name: every spoken word should find
// a close word in the name; extra words in the name cost a little
// ("ali" → "Ali Traders" still scores high, "ali" → "Alisha" lower).
export function nameScore(spokenKeys, nameKeys) {
  if (!spokenKeys.length || !nameKeys.length) return 0;
  let sum = 0;
  const used = new Set();
  for (const s of spokenKeys) {
    let best = 0, bestIdx = -1;
    nameKeys.forEach((n, i) => {
      if (used.has(i)) return;
      const v = similarity(s, n);
      if (v > best) { best = v; bestIdx = i; }
    });
    if (bestIdx >= 0) used.add(bestIdx);
    sum += best;
  }
  const words = sum / spokenKeys.length;
  const coverage = Math.min(1, spokenKeys.length / nameKeys.length);
  const joined = similarity(spokenKeys.joined ?? spokenKeys.join(''), nameKeys.joined ?? nameKeys.join(''));
  return Math.max(words * (0.85 + 0.15 * coverage), joined);
}

/**
 * Rank `items` by how well `getText(item)` matches the spoken `query`.
 * Returns { best, matches, ambiguous }:
 *   best       the top item, or null when nothing scores at least `min`
 *   matches    up to 5 [{ item, score }] above `min`, best first
 *   ambiguous  true when the runner-up is too close to call
 */
export function findBest(query, items, getText, { min = 0.72, margin = 0.04 } = {}) {
  const q = keysOf(query);
  if (!q.length || !Array.isArray(items)) return { best: null, matches: [], ambiguous: false };
  const scored = [];
  for (const item of items) {
    const text = getText(item);
    if (!text) continue;
    const score = nameScore(q, keysOf(text));
    if (score >= min) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.slice(0, 5);
  const ambiguous = matches.length > 1 && matches[0].score - matches[1].score < margin && matches[0].score < 0.999;
  return { best: matches[0]?.item ?? null, matches, ambiguous };
}

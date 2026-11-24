/**
 * Fuzzy person-name matching for contacts ("call arun" → "Arun Kumar", "message priya s" →
 * "Priya Sharma", "amma" → "Amma ❤️", small typos and voice mis-hearings like "Aroon").
 * Returns 0..1; 1 = same name.
 */
export function normName(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function edit(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** One query word against one name word. */
function wordScore(q: string, w: string): number {
  if (q === w) return 1;
  if (w.startsWith(q) && q.length >= 2) return q.length === 1 ? 0.5 : 0.85; // "priya s" → "sharma"
  if (q.length >= 4 && w.length >= 4) {
    const d = edit(q, w);
    if (d === 1) return 0.8;
    if (d === 2 && q.length >= 5) return 0.62;
  }
  return 0;
}

export function scoreName(query: string, name: string): number {
  const q = normName(query).replace(/^@/, '');
  const n = normName(name).replace(/^@/, '');
  if (!q || !n) return 0;
  if (q === n) return 1;
  if (q.replace(/[ ._]/g, '') === n.replace(/[ ._]/g, '')) return 0.97; // "arun kumar" vs "arunkumar"
  const qw = q.split(' ');
  const nw = n.split(' ');
  // Every word Ray said must match some word of the name.
  let total = 0;
  for (const w of qw) {
    const best = Math.max(0, ...nw.map((x) => wordScore(w, x)));
    if (best === 0) {
      // single-letter initial ("priya s") is fine as long as other words matched
      if (w.length === 1 && nw.some((x) => x.startsWith(w))) {
        total += 0.6;
        continue;
      }
      return n.includes(q) && q.length >= 3 ? 0.55 : 0;
    }
    total += best;
  }
  let score = total / qw.length;
  // A first-name-only query matching the first word reads as that person ("arun" → "Arun Kumar").
  if (qw.length === 1 && wordScore(qw[0], nw[0]) === 1) score = Math.max(score, 0.92);
  // Fewer unmatched words in the name = closer.
  score -= Math.min(0.08, 0.02 * Math.max(0, nw.length - qw.length));
  return Math.max(0, Math.min(0.99, score));
}

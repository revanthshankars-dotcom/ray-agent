// Turns a wake phrase ("Hey Ray", "Jarvis") into the word pieces the keyword-spotting model knows,
// so the phrase can be changed in Settings and work at once — no training, no restart.
'use strict';
const fs = require('fs');

/** Load the model's vocabulary (tokens.txt: "<piece> <id>" per line). */
function loadVocab(tokensPath) {
  const vocab = new Set();
  for (const line of fs.readFileSync(tokensPath, 'utf8').split(/\r?\n/)) {
    const piece = line.split(/\s+/)[0];
    if (piece) vocab.add(piece);
  }
  return vocab;
}

/** Greedy longest-match BPE: "HEY RAY" -> "▁HE Y ▁RA Y" (pieces must exist in the vocab). */
function tokenizeWord(word, vocab) {
  const pieces = [];
  let rest = '▁' + word;
  while (rest.length) {
    let cut = rest.length;
    while (cut > 0 && !vocab.has(rest.slice(0, cut))) cut--;
    if (cut === 0) return null; // a letter the model can't spell
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return pieces;
}

/**
 * Build the keywords file content for one or more phrases.
 * Each line: "<pieces> :<boost> #<threshold> @<LABEL>".
 */
function buildKeywords(phrases, vocab, { boost = 3.0, threshold = 0.08 } = {}) {
  const lines = [];
  const skipped = [];
  for (const raw of phrases) {
    const words = String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z' ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) continue;
    const pieces = [];
    let ok = true;
    for (const w of words) {
      const t = tokenizeWord(w, vocab);
      if (!t) {
        ok = false;
        break;
      }
      pieces.push(...t);
    }
    if (!ok) {
      skipped.push(raw);
      continue;
    }
    lines.push(`${pieces.join(' ')} :${boost} #${threshold} @${words.join('_')}`);
  }
  return { text: lines.join('\n') + '\n', count: lines.length, skipped };
}

module.exports = { loadVocab, tokenizeWord, buildKeywords };

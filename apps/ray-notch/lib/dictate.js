// Dictation: clean what Ray said into the text he meant, then type it into whatever app he's in.
// Runs fully on the PC (rules, no AI needed); RAY's model can optionally polish it further.
'use strict';

const FILLERS = /\b(?:um+|uh+|erm+|er|ah+|hmm+|mm+|uh-huh|you know|i mean|like,)\s*,?\s*/gi;

/** Spoken commands that change what was said ("actually, make that…", "scratch that"). */
function applySpokenEdits(text) {
  let t = ` ${text} `;
  // "scratch that" / "delete that": drop the sentence (or clause) before it.
  t = t.replace(/[^.!?\n]*?(?:,\s*)?\b(?:scratch that|delete that|strike that)\b[.!,]?\s*/gi, ' ');
  // "at 5, actually make that 6" / "no wait, 6" -> keep only the correction for the last value.
  t = t.replace(/(\b[\w']+)\s*[,.]?\s*\b(?:actually|no wait|sorry|i mean)[,]?\s*(?:make (?:that|it)\s+)?([\w']+)/gi, (_m, _old, neu) => neu);
  return t.trim();
}

/** Punctuation and layout said out loud. */
function applySpokenFormatting(text) {
  let t = text;
  const rules = [
    [/\s*\b(?:new paragraph)\b\s*/gi, '\n\n'],
    [/\s*\b(?:new line|next line)\b\s*/gi, '\n'],
    [/\s*\b(?:full stop|period)\b/gi, '.'],
    [/\s*\bcomma\b/gi, ','],
    [/\s*\bquestion mark\b/gi, '?'],
    [/\s*\bexclamation (?:mark|point)\b/gi, '!'],
    [/\s*\bcolon\b/gi, ':'],
    [/\s*\bsemicolon\b/gi, ';'],
    [/\bopen (?:bracket|paren(?:thesis)?)\s*/gi, '('],
    [/\s*\bclose (?:bracket|paren(?:thesis)?)\b/gi, ')'],
    [/\s*\bdash\b\s*/gi, ' - '],
  ];
  for (const [re, rep] of rules) t = t.replace(re, rep);
  // "bullet point X bullet point Y" -> list
  if (/\bbullet(?: point)?\b/i.test(t)) {
    const parts = t.split(/\s*\bbullet(?: point)?\b[,:]?\s*/i);
    const head = parts.shift().trim();
    t = (head ? head.replace(/[:,]?$/, ':') + '\n' : '') + parts.filter((p) => p.trim()).map((p) => `• ${p.trim().replace(/[.,;]$/, '')}`).join('\n');
  }
  // "number one X number two Y" -> numbered list
  if (/\bnumber (?:one|1)\b/i.test(t)) {
    const parts = t.split(/\s*\bnumber (?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[,:]?\s*/i);
    const head = parts.shift().trim();
    t = (head ? head.replace(/[:,]?$/, ':') + '\n' : '') + parts.filter((p) => p.trim()).map((p, i) => `${i + 1}. ${p.trim().replace(/[.,;]$/, '')}`).join('\n');
  }
  return t;
}

function tidy(text) {
  let t = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.!?;:)])/g, '$1')
    .replace(/([,;:])(?=\S)/g, '$1 ')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/([.!?]){2,}/g, '$1')
    .replace(/\n /g, '\n')
    .trim();
  // Capitalise sentence starts and lines.
  t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  t = t.replace(/\bi\b/g, 'I');
  return t;
}

/** "um so I'll be there at 5 actually make that 6 comma okay" -> "So I'll be there at 6, okay" */
function cleanDictation(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  t = t.replace(FILLERS, ' ');
  t = applySpokenEdits(t);
  t = applySpokenFormatting(t);
  t = tidy(t);
  return t;
}

module.exports = { cleanDictation, applySpokenEdits, applySpokenFormatting };

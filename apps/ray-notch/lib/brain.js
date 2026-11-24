// Hybrid brain: quick everyday commands are understood right here on the PC (instant, offline);
// everything else goes to RAY (free cloud engines) — or, with no internet, to the PC bridge's offline
// answers and local Ollama model.
'use strict';

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
const num = (s) => (s in NUM ? NUM[s] : Number(s));
const UNIT = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600 };

/** Seconds from "10 minutes", "an hour and a half", "90 seconds", "1 hour 20 minutes". */
function parseDuration(text) {
  let total = 0;
  const re = /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half)\s*(?:an?\s+)?(second|sec|minute|min|hour|hr)s?/gi;
  let m;
  while ((m = re.exec(text))) total += num(m[1].toLowerCase()) * UNIT[m[2].toLowerCase()];
  if (/and a half/i.test(text)) {
    const u = text.match(/(second|minute|hour)/i);
    if (u) total += UNIT[u[1].toLowerCase()] / 2;
  }
  return total || null;
}

/**
 * Understand a quick command without any AI. Returns null when RAY should handle it.
 * Result: { kind, ... } — executed by the notch (widgets) or system.js.
 */
function parseIntent(raw) {
  const t = String(raw || '').trim().replace(/[.!?]+$/, '');
  const low = t.toLowerCase();
  let m;
  if (!low) return null;

  if (/\b(timer|countdown)\b/.test(low) && /\b(set|start|put|make)\b|^timer/.test(low)) {
    const secs = parseDuration(low);
    const lbl = (low.match(/\bfor (?:the )?([a-z ]+?)(?: for| in|$)/) || [])[1] || '';
    if (secs) return { kind: 'timer', seconds: secs, label: parseDuration(lbl) || /\b(half|hour|minute|second)\b/.test(lbl) ? '' : lbl };
  }
  if (/\b(cancel|stop|clear)\b.*\btimers?\b/.test(low)) return { kind: 'timer-cancel' };
  if (/\bstopwatch\b/.test(low)) return { kind: /\b(stop|end|reset)\b/.test(low) ? 'stopwatch-stop' : 'stopwatch' };
  if (/\b(focus|pomodoro)\b/.test(low) && !/\bon\b.*\bwindow\b/.test(low)) {
    if (/\b(stop|end|cancel)\b/.test(low)) return { kind: 'focus-stop' };
    return { kind: 'focus', minutes: (parseDuration(low) || 0) / 60 || null };
  }
  if ((m = low.match(/^(?:remind me|reminder)\s+(?:to\s+)?(.+?)\s+in\s+(.+)$/))) {
    const secs = parseDuration(m[2]);
    if (secs) return { kind: 'timer', seconds: secs, label: m[1] };
  }
  if (/\bkeep (?:my |the )?(?:pc|computer|laptop|screen|machine)? ?awake\b|\bdon'?t (?:let it )?sleep\b/.test(low)) {
    return { kind: 'awake', minutes: (parseDuration(low) || 3600) / 60 };
  }
  if (/\b(let it sleep|allow sleep|stop keeping (?:it )?awake)\b/.test(low)) return { kind: 'awake-off' };

  if ((m = low.match(/^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:to-?do|todo|shopping|grocery)?\s*list$/))) return { kind: 'todo-add', text: m[1] };
  if ((m = low.match(/^(?:mark|tick|check)\s+(.+?)\s+(?:as\s+)?(?:done|complete|off)$/))) return { kind: 'todo-done', text: m[1] };
  if (/^(?:show|open|what'?s on)\s+(?:me\s+)?(?:my\s+)?(?:to-?do|todo|shopping)?\s*list$/.test(low) || /^my list$/.test(low)) return { kind: 'todo-show' };

  if ((m = low.match(/\bvolume\b.*?\b(\d{1,3})\s*(?:%|percent)?/)) || (m = low.match(/\b(?:set|turn)\b.*\b(\d{1,3})\s*(?:%|percent)\b.*\bvolume\b/))) return { kind: 'volume', level: Number(m[1]) };
  if (/\b(volume up|louder|turn it up|turn up the volume)\b/.test(low)) return { kind: 'volume-step', dir: 1 };
  if (/\b(volume down|quieter|turn it down|turn down the volume)\b/.test(low)) return { kind: 'volume-step', dir: -1 };
  if (/^(mute|unmute)( the)?( (sound|volume|audio|pc))?$/.test(low)) return { kind: 'mute' };

  if (/^(pause|stop)( the)?( music| song| playback| it)?$/.test(low)) return { kind: 'media', action: 'pause' };
  if (/^(resume|unpause|continue|play)( the)?( music| song| playback)?$/.test(low)) return { kind: 'media', action: 'play' };
  if (/^(next|skip)( the)?( song| track)?$|^skip (this|it)$/.test(low)) return { kind: 'media', action: 'next' };
  if (/^(previous|go back|last)( the)?( song| track)$/.test(low)) return { kind: 'media', action: 'prev' };
  if (/\b(show|open)\b.*\blyrics\b|^lyrics$/.test(low)) return { kind: 'lyrics' };

  if (/^lock( my| the)?( pc| computer| screen| laptop)?$/.test(low)) return { kind: 'lock' };
  if (/\b(dark mode|dark theme)\b/.test(low)) return { kind: 'dark', on: !/\b(off|disable|turn off|light)\b/.test(low) };
  if (/\blight mode\b/.test(low)) return { kind: 'dark', on: false };
  if ((m = low.match(/\bbrightness\b.*?\b(\d{1,3})\b/))) return { kind: 'brightness', level: Number(m[1]) };
  if (/\bnight ?light\b/.test(low)) return { kind: 'settings', page: 'nightlight' };
  if (/\b(wi-?fi|wireless)\b/.test(low) && /\b(turn|switch|toggle|open|on|off)\b/.test(low)) return { kind: 'settings', page: 'wifi' };
  if (/\bbluetooth\b/.test(low) && /\b(turn|switch|toggle|open|on|off)\b/.test(low)) return { kind: 'settings', page: 'bluetooth' };

  if (/^what(?:'s| is) the time$|^what time is it$|^time$/.test(low)) return { kind: 'say', text: `It's ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` };
  if (/^what(?:'s| is) (?:the )?(?:date|day)(?: today)?$|^what day is it$/.test(low)) return { kind: 'say', text: `It's ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}.` };
  if (/\bbattery\b/.test(low) && !/\bphone\b/.test(low)) return { kind: 'battery' };
  if (/\b(log|drank|had)\b.*\b(water|glass)\b/.test(low)) return { kind: 'water' };

  if ((m = t.match(/^type\s+(.+)$/i))) return { kind: 'type', text: m[1] };
  if ((m = t.match(/^(?:write|draft)\s+(.+)$/i))) return { kind: 'write', what: m[1] };

  // "open spotify" / "launch calculator" — open apps on this PC instantly (websites go to RAY).
  if ((m = low.match(/^(?:open|launch|start|run)\s+(?:the\s+)?(?:app\s+)?([a-z0-9][a-z0-9 .+-]{1,40})$/)) && !/\b(doc|docs|sheet|website|site|page|tab|\.com|youtube|gmail|google|search|new)\b/.test(m[1]) && !/\bon (my )?(phone|mobile)\b/.test(low)) {
    return { kind: 'open-app', app: m[1].replace(/\s+(app|application)$/, '') };
  }

  // Screen shortcut: "what's on my screen", "read my screen", bare "screen"
  if (/^(?:what(?:'?s|\s+is)\s+on\s+(?:my\s+|the\s+)?screen|read\s+(?:my\s+)?screen|(?:show|describe|analyse|analyze)\s+(?:my\s+)?screen|^screen$)$/i.test(low)) {
    return { kind: 'screen', question: t || 'What is on the screen right now? Describe it briefly.' };
  }
  return null;
}

/** Does the request need a look at the screen? ("where's the Export button", "summarise this page") */
function wantsScreen(text) {
  return /\b(this (page|screen|window|tab|email|error|message|document|doc|chart|code)|on (my|the) screen|where'?s the|where is the|find the .* button|what am i looking at|read this|summari[sz]e this|explain this|what(?:'?s| is) on (my|the) screen|read (my )?screen|describe (my )?screen)\b/i.test(String(text || ''))
    || /^screen$/i.test(String(text || '').trim());
}

module.exports = { parseIntent, parseDuration, wantsScreen };

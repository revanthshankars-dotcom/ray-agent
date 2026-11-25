/* RAY Notch UI — states, cards, panel, widgets, microphone. Talks to the app only through window.notch. */
'use strict';
(() => {
  const N = window.notch;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const COLORS = { cyan: '#22d3ee', white: '#f8fafc', blue: '#3b82f6', green: '#22c55e', yellow: '#facc15', orange: '#fb923c', pink: '#f472b6', purple: '#a855f7' };

  const notch = $('#notch');
  const line = $('#line');
  const side = $('#side');
  const card = $('#card');
  const panel = $('#panel');

  let S = {}; // settings
  let todos = [];
  let shelf = [];
  let playing = null;
  let lyricLines = null;
  let showLyrics = false;
  let online = false;
  let water = { glasses: 0 };
  let awakeUntil = 0;
  let ctrlVol = 50;
  let ctrlBri = 70;
  let mode = 'command';
  let cardTimer = null;
  let hoverCard = false;
  const timers = []; // {id, label, end}
  let focus = null; // {phase:'focus'|'break', end, breakMin}
  let stopwatch = null; // {start}

  // ---------------- click-through: only the notch, cards and panel take the mouse ----------------
  document.addEventListener('mousemove', (e) => {
    const hit = e.target.closest && e.target.closest('#notch, #card, #panel');
    N.interactive(Boolean(hit));
  });
  document.addEventListener('mouseleave', () => N.interactive(false));

  // ---------------- look ----------------
  function applyLook() {
    document.documentElement.style.setProperty('--accent', COLORS[S.color] || COLORS.cyan);
    document.body.classList.remove('style-eyes', 'style-ring', 'style-bars');
    document.body.classList.add(`style-${S.style || 'eyes'}`);
  }

  // ---------------- the notch line ----------------
  function setNotch(phase, html = '', width = '') {
    notch.dataset.phase = phase;
    notch.classList.toggle('wide', width === 'wide');
    notch.classList.toggle('mid', width === 'mid');
    line.innerHTML = html;
  }
  function idle() {
    if (!card.classList.contains('hidden') && hoverCard) return;
    setNotch('idle');
    hideCard();
  }
  function hideCard() {
    card.classList.add('hidden');
    card.innerHTML = '';
    notch.classList.remove('card-open');
    clearTimeout(cardTimer);
  }
  function showCard(html, { autoHideMs = 0 } = {}) {
    card.innerHTML = `<div class="inner">${faceHtml()}<div style="flex:1;min-width:0">${html}</div></div>`;
    card.classList.remove('hidden');
    panel.classList.add('hidden');
    notch.classList.add('card-open');
    notch.classList.remove('panel-open');
    clearTimeout(cardTimer);
    if (autoHideMs) cardTimer = setTimeout(() => !hoverCard && idle(), autoHideMs);
  }
  card.addEventListener('mouseenter', () => (hoverCard = true));
  card.addEventListener('mouseleave', () => {
    hoverCard = false;
    if (card.dataset.auto) cardTimer = setTimeout(idle, 2500);
  });
  const faceHtml = () => `<div class="face card-face" aria-hidden="true"><span class="eye"></span><span class="eye"></span><span class="ring"></span><span class="bars"><i></i><i></i><i></i><i></i></span></div>`;

  // ---------------- states from the app ----------------
  N.on.state((st) => {
    switch (st.phase) {
      case 'idle':
        idle();
        if (st.note) toast('RAY', st.note);
        break;
      case 'setup':
        setNotch('working', `<span class="dim">${esc(st.text)}</span>`, 'wide');
        showCard(`<div class="msg">${esc(st.text)}</div><div class="progress"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></div>`);
        break;
      case 'listening':
        hideCard();
        panel.classList.add('hidden');
        setNotch('listening', st.text ? esc(st.text) : `<span class="dim">${st.mode === 'dictate' ? 'Dictating — talk, release to type' : 'Listening…'}</span>`, 'wide');
        break;
      case 'working':
        setNotch('working', `${esc(st.step || 'Working on it')}<span class="dim"> · ${esc(st.text || '')}</span>`, 'wide');
        break;
      case 'done':
        setNotch('done', esc(st.text || 'Done.'), st.text && st.text.length > 30 ? 'wide' : 'mid');
        hideCard();
        setTimeout(() => notch.dataset.phase === 'done' && idle(), 2600);
        break;
      case 'answer':
        setNotch('done', '', '');
        card.dataset.auto = '1';
        showCard(
          `${st.question ? `<div class="q">${esc(st.question)}</div>` : ''}<div class="msg">${esc(st.text)}</div>
           <div class="actions"><button class="pill" data-a="copy">Copy</button><button class="pill" data-a="close">Close</button></div>`,
          { autoHideMs: Math.min(45000, 6000 + String(st.text).length * 60) }
        );
        card.onclick = (e) => {
          const a = e.target.dataset && e.target.dataset.a;
          if (a === 'copy') navigator.clipboard.writeText(st.text);
          if (a === 'close') idle();
        };
        break;
      case 'approve':
        delete card.dataset.auto;
        setNotch('working', '<span class="dim">Waiting for you</span>', 'mid');
        showCard(
          `<div class="msg">${esc(st.text)}</div>
           ${st.secret ? `<input id="secret" type="password" placeholder="${esc(st.secret)}" style="width:100%;margin-top:10px" aria-label="${esc(st.secret)}" />` : ''}
           <div class="actions"><button class="pill" data-a="no">Not now</button><button class="pill yes" data-a="yes">Yes</button></div>`
        );
        card.onclick = (e) => {
          const a = e.target.dataset && e.target.dataset.a;
          if (a === 'yes' || a === 'no') {
            N.approve(st.id, a === 'yes');
            hideCard();
          }
        };
        break;
      case 'ask': {
        delete card.dataset.auto;
        setNotch('working', '<span class="dim">RAY has a question</span>', 'mid');
        const opts = (st.options || []).map((o) => `<button class="pill" data-o="${esc(o)}">${esc(o)}</button>`).join('');
        showCard(
          `${st.why ? `<div class="q">${esc(st.why)}</div>` : ''}<div class="msg">${esc(st.text)}</div>
           <div class="actions">${opts}</div>
           <form class="row" id="askReply" style="margin-top:10px"><input id="askReplyIn" placeholder="Or type your answer…" style="flex:1" aria-label="Your answer" /><button class="pill yes">Send</button></form>`
        );
        card.onclick = (e) => {
          const o = e.target.dataset && e.target.dataset.o;
          if (o) N.answerAsk(st.id, o);
        };
        $('#askReply', card).onsubmit = (e) => {
          e.preventDefault();
          const v = $('#askReplyIn', card).value.trim();
          if (v) N.answerAsk(st.id, v);
        };
        break;
      }
      case 'toast':
        toast(st.title, st.text);
        break;
      case 'water':
        card.dataset.auto = '1';
        showCard(`<div class="msg">Time for a glass of water.</div><div class="actions"><button class="pill yes" data-a="log">Log a glass</button><button class="pill" data-a="later">Later</button></div>`, { autoHideMs: 20000 });
        card.onclick = (e) => {
          const a = e.target.dataset && e.target.dataset.a;
          if (a === 'log') N.water();
          if (a) idle();
        };
        break;
    }
  });
  function toast(title, text) {
    // With the panel open, show it inside the panel instead of closing what Ray is using.
    if (!panel.classList.contains('hidden')) {
      let b = $('#banner');
      if (!b) {
        b = document.createElement('div');
        b.id = 'banner';
        b.className = 'banner';
        panel.insertBefore(b, panel.querySelector('.ask'));
      }
      b.innerHTML = `<b>${esc(title)}</b> ${esc(text)}`;
      clearTimeout(b._t);
      b._t = setTimeout(() => b.remove(), 6000);
      return;
    }
    card.dataset.auto = '1';
    showCard(`<div class="q">${esc(title)}</div><div class="msg">${esc(text)}</div>`, { autoHideMs: 6000 });
    chime(660);
  }

  // ---------------- open / close the panel ----------------
  notch.addEventListener('click', () => {
    if (notch.dataset.phase === 'listening') return N.stopListening();
    const open = panel.classList.contains('hidden');
    hideCard();
    panel.classList.toggle('hidden', !open);
    if (open) {
      notch.classList.add('panel-open');
      renderAll();
      $('#askInput').focus();
    } else {
      notch.classList.remove('panel-open');
    }
  });
  notch.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && notch.click());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      panel.classList.add('hidden');
      notch.classList.remove('panel-open');
      idle();
      N.cancel();
    }
  });
  notch.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    panel.classList.remove('hidden');
    notch.classList.add('panel-open');
    notch.classList.remove('card-open');
    openTab('settings');
  });

  $$('.tab').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  function openTab(t) {
    $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== t));
    renderAll();
  }
  $$('.mode').forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.mode;
        $$('.mode').forEach((x) => x.classList.toggle('on', x === b));
        $('#askInput').placeholder = mode === 'write' ? 'What should I write? (it goes into the app you were in)' : mode === 'dictate' ? 'Tap the mic and talk — RAY types it into your app' : 'Ask RAY, or say “Hey Ray”…';
        $('#askInput').focus();
      })
  );
  $('#ask').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#askInput').value.trim();
    if (!v) return;
    $('#askInput').value = '';
    panel.classList.add('hidden');
    N.command(mode === 'write' && !/^write\b/i.test(v) ? `write ${v}` : v);
  };
  $('#micBtn').onclick = () => {
    panel.classList.add('hidden');
    N.listen(mode === 'dictate' ? 'dictate' : 'command');
  };

  // drop files / pictures on the notch -> Shelf
  for (const el of [notch, panel, card]) {
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) {
        await N.dropFiles(e.dataTransfer.files);
        toast('Shelf', `${e.dataTransfer.files.length} file${e.dataTransfer.files.length > 1 ? 's' : ''} on your Shelf. For a picture, say “make it smaller” or “convert it to PNG”.`);
      }
    });
  }

  // ---------------- widgets: timers, focus, stopwatch ----------------
  N.on.widget((w) => {
    if (w.type === 'timer' && w.seconds > 0) timers.push({ id: Date.now(), label: w.label || '', end: Date.now() + w.seconds * 1000 });
    if (w.type === 'timer-cancel') timers.length = 0;
    if (w.type === 'stopwatch') stopwatch = { start: Date.now() };
    if (w.type === 'stopwatch-stop') {
      if (stopwatch) toast('Stopwatch', fmt((Date.now() - stopwatch.start) / 1000));
      stopwatch = null;
    }
    if (w.type === 'focus') focus = { phase: 'focus', end: Date.now() + w.minutes * 60000, breakMin: w.breakMin || 5 };
    if (w.type === 'focus-stop') focus = null;
    if (w.type === 'battery') batteryToast();
    if (w.type === 'show') {
      panel.classList.remove('hidden');
      notch.classList.add('panel-open');
      hideCard();
      openTab(w.panel === 'list' ? 'list' : 'home');
      if (w.lyrics) {
        showLyrics = true;
        loadLyrics();
      }
    }
    renderAll();
  });
  const fmt = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  function tick() {
    const now = Date.now();
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].end <= now) {
        const t = timers.splice(i, 1)[0];
        toast('Timer done', t.label ? `${t.label} — time’s up.` : 'Time’s up.');
        chime(880, 3);
      }
    }
    if (focus && focus.end <= now) {
      if (focus.phase === 'focus') {
        toast('Focus', `Nice work. Take a ${focus.breakMin}-minute break.`);
        focus = { phase: 'break', end: now + focus.breakMin * 60000, breakMin: focus.breakMin };
      } else {
        toast('Break over', 'Ready for the next round?');
        focus = null;
      }
      chime(740, 2);
    }
    // what the closed notch shows on its right
    let s = '';
    if (notch.dataset.phase === 'idle' || !notch.dataset.phase) {
      const next = timers.slice().sort((a, b) => a.end - b.end)[0];
      if (next) s = `<span class="t">${fmt((next.end - now) / 1000)}</span>`;
      else if (focus) s = `<span class="t">${focus.phase === 'focus' ? '◉' : '☕'} ${fmt((focus.end - now) / 1000)}</span>`;
      else if (stopwatch) s = `<span class="t">${fmt((now - stopwatch.start) / 1000)}</span>`;
      else if (playing && playing.playing) s = '<span class="eq"><i></i><i></i><i></i></span>';
      else if (!online) s = '<span title="Offline — quick commands and dictation still work">offline</span>';
      else if (notch.matches(':hover')) s = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    side.innerHTML = s;
    notch.dataset.offline = online ? '0' : '1';
    $('#clock').textContent = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    if (!panel.classList.contains('hidden')) {
      renderTimers();
      renderMusic(false);
    }
  }
  setInterval(tick, 500);

  // ---------------- panel rendering ----------------
  function renderAll() {
    renderTimers();
    renderMusic(true);
    renderControls();
    renderStatus();
    renderApps();
    renderTodos();
    renderShelf();
    renderSettings();
  }
  function renderTimers() {
    const now = Date.now();
    const rows = timers.map((t) => `<div class="row" style="justify-content:space-between"><span>${esc(t.label || 'Timer')}</span><span class="t" style="color:var(--accent)">${fmt((t.end - now) / 1000)}</span></div>`).join('');
    $('#timersTile').innerHTML = `<h4>Timers</h4>
      ${focus ? `<div class="big">${fmt((focus.end - now) / 1000)}</div><div class="small">${focus.phase === 'focus' ? 'Focus' : 'Break'}</div>` : stopwatch ? `<div class="big">${fmt((now - stopwatch.start) / 1000)}</div><div class="small">Stopwatch</div>` : ''}
      ${rows || (!focus && !stopwatch ? '<div class="small">Say “set a timer for 10 minutes”.</div>' : '')}
      <div class="chips"><button class="chip" data-w="t5">5 min</button><button class="chip" data-w="t10">10 min</button><button class="chip ${focus ? 'on' : ''}" data-w="focus">Focus ${S.focusMin || 25}</button><button class="chip ${stopwatch ? 'on' : ''}" data-w="sw">Stopwatch</button>${timers.length ? '<button class="chip" data-w="clear">Clear</button>' : ''}</div>`;
    $('#timersTile').onclick = (e) => {
      const w = e.target.dataset && e.target.dataset.w;
      if (w === 't5' || w === 't10') timers.push({ id: Date.now(), label: '', end: Date.now() + (w === 't5' ? 5 : 10) * 60000 });
      if (w === 'focus') focus = focus ? null : { phase: 'focus', end: Date.now() + (S.focusMin || 25) * 60000, breakMin: S.breakMin || 5 };
      if (w === 'sw') stopwatch = stopwatch ? null : { start: Date.now() };
      if (w === 'clear') timers.length = 0;
      if (w) renderTimers();
    };
  }
  function hashColor(s) {
    let h = 0;
    for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return [`hsl(${h % 360} 55% 30%)`, `hsl(${(h >> 8) % 360} 45% 14%)`];
  }
  function renderMusic(full) {
    const el = $('#musicTile');
    if (!playing) {
      if (full) el.innerHTML = '<h4>Now playing</h4><div class="small">Play something in Spotify, YouTube Music or your browser — it shows up here with synced lyrics.</div>';
      el.style.removeProperty('--mc1');
      return;
    }
    const pos = Math.min(playing.duration || 0, playing.position + (playing.playing ? (Date.now() - playing.at) / 1000 : 0));
    const pct = playing.duration ? (pos / playing.duration) * 100 : 0;
    const [c1, c2] = hashColor(playing.title + playing.artist);
    el.style.setProperty('--mc1', c1);
    el.style.setProperty('--mc2', c2);
    let ly = '';
    if (showLyrics && lyricLines) {
      let i = lyricLines.findIndex((l) => l.t > pos) - 1;
      if (i < 0) i = lyricLines[lyricLines.length - 1].t <= pos ? lyricLines.length - 1 : 0;
      ly = `<div class="lyric">${esc(lyricLines[i] ? lyricLines[i].line : '')}</div><div class="lyric next">${esc(lyricLines[i + 1] ? lyricLines[i + 1].line : '')}</div>`;
    } else if (showLyrics) ly = '<div class="small" style="margin-top:6px">No synced lyrics found.</div>';
    if (!full && el.querySelector('.seek i')) {
      el.querySelector('.seek i').style.width = pct + '%';
      const l = el.querySelector('.lyrics');
      if (l) l.innerHTML = ly;
      return;
    }
    el.innerHTML = `<h4>Now playing</h4><div class="title">${esc(playing.title)}</div><div class="small">${esc(playing.artist)}</div>
      <div class="seek" title="${fmt(pos)} / ${fmt(playing.duration)}"><i style="width:${pct}%"></i></div>
      <div class="row" style="justify-content:space-between"><div class="row"><button class="round" data-m="prev" aria-label="Previous">⏮</button><button class="round" data-m="playpause" aria-label="${playing.playing ? 'Pause' : 'Play'}">${playing.playing ? '⏸' : '▶'}</button><button class="round" data-m="next" aria-label="Next">⏭</button></div><button class="chip ${showLyrics ? 'on' : ''}" data-m="lyrics">Lyrics</button></div>
      <div class="lyrics">${ly}</div>`;
    el.onclick = async (e) => {
      const m = e.target.dataset && e.target.dataset.m;
      if (m === 'lyrics') {
        showLyrics = !showLyrics;
        if (showLyrics) await loadLyrics();
        renderMusic(true);
      } else if (m) N.media(m);
    };
  }
  async function loadLyrics() {
    lyricLines = await N.lyrics();
    renderMusic(true);
  }
  let ctrlMuted = false;
  let ctrlDark = matchMedia('(prefers-color-scheme: dark)').matches;
  async function ctrlFeedback(kind, value) {
    const msg = await N.control(kind, value);
    if (msg) toast('RAY', msg);
    return msg;
  }
  function renderControls() {
    const awake = awakeUntil > Date.now();
    $('#controlsTile').innerHTML = `<h4>Controls</h4>
      <div class="slider">🔊<input type="range" min="0" max="100" step="1" value="${ctrlVol}" id="vol" aria-label="Volume" /></div>
      <div class="slider">☀<input type="range" min="10" max="100" step="10" value="${ctrlBri}" id="bri" aria-label="Brightness" /></div>
      <div class="chips">
        <button class="chip ${ctrlMuted ? 'on' : ''}" data-c="mute">Mute</button>
        <button class="chip" data-c="wifi">Wi-Fi</button>
        <button class="chip" data-c="bluetooth">Bluetooth</button>
        <button class="chip" data-c="nightlight">Night light</button>
        <button class="chip ${ctrlDark ? 'on' : ''}" data-c="dark">Dark mode</button>
        <button class="chip ${awake ? 'on' : ''}" data-c="awake">Keep awake</button>
        <button class="chip" data-c="lock">Lock</button>
      </div>`;
    let volTimer, briTimer;
    $('#vol').oninput = (e) => {
      ctrlVol = Number(e.target.value);
      clearTimeout(volTimer);
      volTimer = setTimeout(() => void ctrlFeedback('volume', ctrlVol), 220);
    };
    $('#bri').oninput = (e) => {
      ctrlBri = Number(e.target.value);
      clearTimeout(briTimer);
      briTimer = setTimeout(() => void ctrlFeedback('brightness', ctrlBri), 220);
    };
    $('#controlsTile').onclick = async (e) => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (!c) return;
      e.target.closest('[data-c]').style.opacity = '0.6';
      if (c === 'awake') await ctrlFeedback('awake', awake ? 0 : 60);
      else if (c === 'dark') { ctrlDark = !ctrlDark; await ctrlFeedback('dark', ctrlDark); }
      else if (c === 'mute') { ctrlMuted = !ctrlMuted; await ctrlFeedback('mute'); }
      else await ctrlFeedback(c);
      renderControls();
    };
  }
  async function renderStatus() {
    let bat = '';
    try {
      const b = await navigator.getBattery();
      bat = `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}`;
    } catch {
      bat = '—';
    }
    $('#statusTile').innerHTML = `<h4>This PC</h4>
      <div class="row" style="justify-content:space-between"><span>Battery</span><b>${bat}</b></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>Water today</span><span><b>${water.glasses || 0}</b> <button class="chip" id="waterBtn">+1</button></span></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>RAY</span><span class="small">${online ? 'online' : 'offline — quick commands & dictation still work'}</span></div>
      ${awakeUntil > Date.now() ? `<div class="small" style="margin-top:6px">Staying awake until ${new Date(awakeUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>` : ''}`;
    $('#waterBtn').onclick = () => N.water();
  }
  async function batteryToast() {
    try {
      const b = await navigator.getBattery();
      toast('Battery', `${Math.round(b.level * 100)}%${b.charging ? ', charging' : ''}.`);
    } catch {
      toast('Battery', 'This PC doesn’t report a battery.');
    }
  }
  function renderApps() {
    $('#apps').innerHTML = (S.apps || []).slice(0, 8).map((a) => `<button data-app="${esc(a)}">${esc(a)}</button>`).join('');
    $('#apps').onclick = (e) => e.target.dataset.app && N.openApp(e.target.dataset.app);
  }
  function renderTodos() {
    const today = new Date().toDateString();
    const list = todos.filter((t) => !t.done || new Date(t.doneAt || 0).toDateString() === today);
    $('#todos').innerHTML = list.length
      ? list.map((t) => `<li class="${t.done ? 'done' : ''}"><input type="checkbox" ${t.done ? 'checked' : ''} data-id="${t.id}" aria-label="Done: ${esc(t.text)}" /><span>${esc(t.text)}</span><button class="x" data-del="${t.id}" aria-label="Remove">×</button></li>`).join('')
      : '<p class="hint">Nothing on your list. Say “add milk to my list”.</p>';
  }
  $('#todos').onclick = (e) => {
    const id = Number(e.target.dataset.id || e.target.dataset.del);
    if (!id) return;
    if (e.target.dataset.del) todos = todos.filter((t) => t.id !== id);
    else {
      const t = todos.find((x) => x.id === id);
      t.done = e.target.checked;
      t.doneAt = Date.now();
    }
    N.saveTodos(todos);
    renderTodos();
  };
  $('#todoForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#todoInput').value.trim();
    if (!v) return;
    todos.push({ id: Date.now(), text: v, done: false, at: Date.now() });
    $('#todoInput').value = '';
    N.saveTodos(todos);
    renderTodos();
  };
  function renderShelf() {
    $('#shelf').innerHTML = shelf.length
      ? shelf
          .map(
            (s, i) => `<li><span title="${esc(s.type === 'file' ? s.path : s.text)}">${s.type === 'file' ? '📄 ' + esc(s.name) : esc(s.text.slice(0, 140))}</span>
            ${s.type === 'file' && /\.(png|jpe?g|webp|bmp|gif)$/i.test(s.name) ? `<button class="chip" data-img="${i}" data-op="smaller">Smaller</button><button class="chip" data-img="${i}" data-op="png">PNG</button>` : ''}
            <button class="chip" data-open="${i}">${s.type === 'file' ? 'Open' : 'Copy'}</button><button class="x" data-rm="${i}" aria-label="Remove">×</button></li>`
          )
          .join('')
      : '<p class="hint">Empty.</p>';
  }
  $('#shelf').onclick = async (e) => {
    const d = e.target.dataset || {};
    if (d.open !== undefined) {
      await N.shelfOpen(shelf[Number(d.open)]);
      if (shelf[Number(d.open)].type === 'text') toast('Shelf', 'Copied.');
    }
    if (d.rm !== undefined) N.shelfRemove(Number(d.rm));
    if (d.img !== undefined) {
      const r = await N.imageOp(shelf[Number(d.img)].path, d.op);
      toast('Picture', r.message);
    }
  };

  // ---------------- settings ----------------
  function renderSettings() {
    const v = $('#settingsView');
    const sel = (key, opts) => `<select data-k="${key}" aria-label="${key}">${opts.map(([val, label]) => `<option value="${val}" ${String(S[key]) === String(val) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    const sw = (key) => `<button class="switch ${S[key] ? 'on' : ''}" data-sw="${key}" role="switch" aria-checked="${S[key] ? 'true' : 'false'}" aria-label="${key}"></button>`;
    const models = (S.models || []).map((m) => `<li><span>${esc(m.label)} · ${m.mb} MB</span>${m.installed ? '<span class="small">on this PC</span>' : `<button class="chip" data-dl="${m.id}">Download</button>`}</li>`).join('');
    v.innerHTML = `<div class="set">
      <label>Look</label><div class="chips">${['eyes', 'ring', 'bars'].map((s) => `<button class="chip ${S.style === s ? 'on' : ''}" data-style="${s}">${s === 'eyes' ? 'Eyes' : s === 'ring' ? 'Arc ring' : 'Sound bars'}</button>`).join('')}</div>
      <label>Colour</label><div class="swatches">${Object.entries(COLORS).map(([n, c]) => `<button class="swatch ${S.color === n ? 'on' : ''}" data-color="${n}" style="background:${c}" aria-label="${n}"></button>`).join('')}</div>
      <label>Wake phrase</label><div class="row"><input id="wake" value="${esc((S.wakePhrases || []).join(', '))}" style="flex:1" aria-label="Wake phrases, comma separated" />${sw('wakeEnabled')}</div>
      <label></label><div class="small">Comma-separate several (e.g. “hey ray, jarvis”). Works the moment you save. The wake phrase is heard on this PC only — nothing is uploaded.</div>
      <label>Speech-to-text</label>${sel('stt', [['stt-fast', 'Fast (English)'], ['stt-accurate', 'Accurate (English)'], ['stt-multilingual', '99 languages incl. Hindi & Tamil']])}
      <label>RAY's voice</label>${sel('voice', [['voice-alan', 'Alan — British, male'], ['voice-jenny', 'Jenny — British, female'], ['voice-amy', 'Amy — American, female']])}
      <label>Speak answers</label>${sw('speakAnswers')}
      <label>Hold to command</label>${sel('hotkeyCommand', [['RightCtrl', 'Right Ctrl'], ['RightShift', 'Right Shift'], ['F8', 'F8'], ['F9', 'F9']])}
      <label>Hold to dictate</label>${sel('hotkeyDictate', [['RightAlt', 'Right Alt'], ['RightShift', 'Right Shift'], ['F8', 'F8'], ['F9', 'F9']])}
      <label>Water reminder</label>${sel('waterEveryMin', [[0, 'Off'], [45, 'Every 45 min'], [60, 'Every hour'], [90, 'Every 90 min']])}
      <label>Focus / break</label><div class="row">${sel('focusMin', [[15, '15 min'], [25, '25 min'], [45, '45 min'], [50, '50 min']])}${sel('breakMin', [[5, '5 min'], [10, '10 min'], [15, '15 min']])}</div>
      <label>Apps in the notch</label><input id="appsIn" value="${esc((S.apps || []).join(', '))}" aria-label="Apps, comma separated" />
      <label>Start with my PC</label>${sw('startWithPc')}
      <label>Offline models</label><span class="small">${S.voiceError ? esc(S.voiceError) : 'Downloaded once, then everything runs on this PC.'}</span>
      <ul class="models">${models}</ul>
      <label></label><div class="row"><button class="pill" id="openRay">Open RAY</button><button class="pill" id="quit">Quit RAY Notch</button></div>
    </div>`;
    v.onclick = (e) => {
      const d = e.target.dataset || {};
      if (d.style) save({ style: d.style });
      if (d.color) save({ color: d.color });
      if (d.sw) save({ [d.sw]: !S[d.sw] });
      if (d.dl) N.downloadModel(d.dl);
      if (e.target.id === 'quit') N.quit();
      if (e.target.id === 'openRay') N.openRay();
    };
    v.onchange = (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (k) save({ [k]: /Min$/.test(k) ? Number(e.target.value) : e.target.value });
      if (e.target.id === 'wake') save({ wakePhrases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) });
      if (e.target.id === 'appsIn') save({ apps: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8) });
    };
  }
  function save(patch) {
    S = { ...S, ...patch };
    applyLook();
    N.saveSettings(patch);
    renderSettings();
  }

  // ---------------- data from the app ----------------
  N.on.settings((s) => {
    S = s;
    applyLook();
    if (!panel.classList.contains('hidden')) renderSettings();
  });
  N.on.todos((t) => {
    todos = t;
    renderTodos();
  });
  N.on.shelf((s) => {
    shelf = s;
    renderShelf();
  });
  N.on.playing((p) => {
    playing = p;
    lyricLines = null;
    if (showLyrics && p) loadLyrics();
    renderMusic(true);
  });
  N.on.online((v) => (online = v));
  N.on.water((w) => {
    water = w;
    renderStatus();
  });
  N.on.awake((t) => (awakeUntil = t));
  N.on.play(({ samples, sampleRate }) => {
    try {
      const ctx = new AudioContext();
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.copyToChannel(Float32Array.from(samples), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      notch.dataset.phase = 'speaking';
      src.onended = () => {
        ctx.close();
        if (notch.dataset.phase === 'speaking') idle();
      };
      src.start();
    } catch {
      // no audio device
    }
  });

  function chime(freq = 660, times = 1) {
    try {
      const ctx = new AudioContext();
      for (let i = 0; i < times; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.35);
        g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.35 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.35 + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.35);
        o.stop(ctx.currentTime + i * 0.35 + 0.32);
      }
      setTimeout(() => ctx.close(), times * 400 + 200);
    } catch {
      // no audio
    }
  }

  // ---------------- microphone -> 16 kHz chunks for the offline voice engine ----------------
  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const code = `class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1600);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===1600){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}registerProcessor('ray-mic',P)`;
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      const node = new AudioWorkletNode(ctx, 'ray-mic');
      node.port.onmessage = (e) => N.audio(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      // Microphone unplugged / changed: reconnect to the default one.
      stream.getAudioTracks()[0].onended = () => setTimeout(startMic, 1500);
    } catch (e) {
      toast('Microphone', `Could not open the microphone (${e.message}). RAY will retry; typing still works.`);
      setTimeout(startMic, 10000);
    }
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', () => {});

  // ---------------- boot ----------------
  N.init().then((d) => {
    S = d.settings;
    todos = d.todos || [];
    shelf = d.shelf || [];
    water = d.water || { glasses: 0 };
    online = d.online;
    playing = d.playing;
    applyLook();
    setNotch('idle');
    if (!d.linked) toast('RAY Notch', 'Not linked to RAY yet. Install it from RAY → JARVIS Core → RAY Notch.');
    startMic();
  });
})();

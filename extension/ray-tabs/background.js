// RAY Tabs — background service worker.
// Connects this browser to the RAY hub as a device with "browser-tabs" capability and
// executes tab commands (open / navigate / focus / close / reload / mute / read), page actions
// (read / click / type / scroll in Ray's real browser) and history/bookmark search on Ray's command.

const KEEPALIVE_MS = 20000;
let ws = null;
let reconnectTimer = null;
let attempt = 0;

async function getConfig() {
  const cfg = await chrome.storage.local.get(['roomId', 'token', 'wsBase', 'deviceId', 'deviceName']);
  if (!cfg.deviceId) {
    cfg.deviceId = 'tabs-' + crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ deviceId: cfg.deviceId });
  }
  return cfg;
}

function browserLabel() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const osName = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android' : 'Linux';
  return { name, osName };
}

async function snapshotTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.slice(0, 80).map((t) => ({ id: t.id, windowId: t.windowId, title: t.title || '', url: t.url || '', active: Boolean(t.active), audible: Boolean(t.audible), lastAccessed: t.lastAccessed || 0 }));
}

let tabsTimer = null;
function pushTabsSoon() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const cfg = await getConfig();
      ws.send(JSON.stringify({ event: 'tabs:update', data: { id: cfg.deviceId, tabs: await snapshotTabs() } }));
    }
  }, 700);
}

async function connect() {
  clearTimeout(reconnectTimer);
  const cfg = await getConfig();
  if (!cfg.token || !cfg.wsBase) return; // not paired yet – opening RAY once pairs automatically
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = cfg.wsBase + '?room=' + encodeURIComponent(cfg.roomId) + '&token=' + encodeURIComponent(cfg.token);
  ws = new WebSocket(url);
  ws.onopen = async () => {
    attempt = 0;
    const { name, osName } = browserLabel();
    ws.send(JSON.stringify({
      event: 'device:register',
      data: {
        id: cfg.deviceId,
        name: cfg.deviceName || `${name} on ${osName} (RAY Tabs)`,
        type: 'desktop',
        os: osName,
        browser: name + ' extension',
        capabilities: ['browser-tabs', 'open_url', 'notify', 'page-hands', 'browser-history'],
        telemetry: { openTabCount: (await snapshotTabs()).length },
      },
    }));
    pushTabsSoon();
  };
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.event === 'command:execute') void handleCommand(msg.data, cfg.deviceId);
  };
  ws.onclose = () => {
    ws = null;
    attempt++;
    reconnectTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
  };
  ws.onerror = () => {};
}

function ack(cmd, deviceId, status, message, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: 'command:ack', data: { commandId: cmd.id, deviceId, status, message, data } }));
  }
}

async function readTabText(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 20000),
  });
  return String(res?.result || '');
}

// ---------------------------------------------------------------------------
// Page hands in Ray's REAL browser (his logins): read the page as text + numbered elements,
// click, type, scroll. Passwords and pay/order buttons need RAY's approval flag from the hub.
// ---------------------------------------------------------------------------
function pageReadInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  // Never read back what's in secret fields (passwords, one-time codes, card numbers).
  const secret = (el) => el.type === 'password' || /one-time-code|cc-|password/i.test(String(el.getAttribute('autocomplete') || ''));
  const label = (el) =>
    (el.getAttribute('aria-label') || el.innerText || (secret(el) ? '' : el.value) || el.placeholder || el.title || el.alt || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const els = [];
  let n = 0;
  document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true]').forEach((el) => {
    if (n >= 150 || !vis(el)) return;
    n++;
    el.setAttribute('data-ray-id', String(n));
    const r = el.getBoundingClientRect();
    els.push({ i: n, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', label: label(el), href: el.href || undefined, inView: r.top < innerHeight && r.bottom > 0 });
  });
  const main = document.querySelector('main,[role=main],article') || document.body;
  return {
    title: document.title,
    url: location.href,
    selection: String(getSelection() || '').slice(0, 2000),
    text: (main ? main.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 9000),
    elements: els,
    scrollY: Math.round(scrollY),
    scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight),
  };
}

function pageActInPage(op, q) {
  const PAY = /\b(pay( now)?|place (your )?order|buy now|confirm (purchase|payment|order|booking)|complete (purchase|payment|order|booking)|submit payment|proceed to pay|make payment|book now|subscribe)\b/i;
  const find = () => {
    let el = q.i ? document.querySelector('[data-ray-id="' + q.i + '"]') : null;
    if (!el && q.text) {
      const want = String(q.text).toLowerCase();
      el = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')].find((e) =>
        ((e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || '') + '').toLowerCase().includes(want));
    }
    return el;
  };
  if (op === 'scroll') { scrollBy(0, Number(q.dy || 700)); return { ok: true, msg: 'Scrolled' }; }
  const el = find();
  if (!el) return { ok: false, msg: 'Element not found: ' + (q.i || q.text) };
  const name = (el.getAttribute('aria-label') || el.innerText || (el.type === 'password' ? '' : el.value) || el.placeholder || el.name || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
  el.scrollIntoView({ block: 'center' });
  if (op === 'click') {
    if (PAY.test(name) && !q.allowPay) return { ok: false, msg: 'NEEDS_APPROVAL_PAY: ' + name };
    el.click();
    return { ok: true, msg: 'Clicked "' + name + '"' };
  }
  if (op === 'type') {
    if (el.type === 'password' && !q.allowSecret) return { ok: false, msg: 'PASSWORD_FIELD: ' + name };
    el.focus();
    if (el.isContentEditable) { el.textContent = ''; document.execCommand('insertText', false, String(q.value || '')); }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, String(q.value || ''));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (q.submit) {
      const form = el.form;
      if (form && form.requestSubmit) form.requestSubmit();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    return { ok: true, msg: el.type === 'password' ? 'Entered the password' : 'Typed into "' + name + '"' };
  }
  return { ok: false, msg: 'Unknown page action ' + op };
}

async function runInTab(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
  return res ? res.result : null;
}

async function waitForLoad(tabId, ms) {
  const end = Date.now() + (ms || 8000);
  await new Promise((r) => setTimeout(r, 400));
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Reuse tabs like a person: switch to the page if it's open, load it in the open tab of the same
// site, use an empty new tab, and only otherwise open a new one. Calls, editors and playing media
// are never navigated away.
const BLANK_TAB = /^(chrome|edge|brave|opera|vivaldi):\/\/(newtab|new-tab-page|startpageshared)|^about:(blank|newtab|home)|^chrome-search:\/\/local-ntp/i;
const KEEP_SEPARATE = /^(meet\.google\.com|zoom\.us|.*\.zoom\.us|teams\.microsoft\.com|teams\.live\.com|docs\.google\.com|sheets\.google\.com|slides\.google\.com|colab\.research\.google\.com|notion\.so|.*\.notion\.site|figma\.com|canva\.com|web\.whatsapp\.com|discord\.com|app\.slack\.com|replit\.com|codepen\.io|stackblitz\.com|vscode\.dev|github\.dev|chat\.openai\.com|chatgpt\.com|claude\.ai|gemini\.google\.com)$/i;
function siteOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^(www|m|mobile)\./, ''); } catch { return ''; }
}
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|si$|feature$|ref$|ref_src$)/i.test(k)) x.searchParams.delete(k);
    return (siteOf(u) + x.pathname.replace(/\/+$/, '') + (x.searchParams.toString() ? '?' + x.searchParams.toString() : '')).toLowerCase();
  } catch { return String(u).trim().toLowerCase(); }
}
function isSiteRoot(u) {
  try { const x = new URL(u); return (x.pathname === '/' || x.pathname === '') && !x.search; } catch { return false; }
}
async function smartOpen(url, mode) {
  const [focusedWin] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((w) => w.filter((x) => x.focused));
  const tabs = (await chrome.tabs.query({})).sort((a, b) =>
    (b.active && focusedWin && b.windowId === focusedWin.id ? 1 : 0) - (a.active && focusedWin && a.windowId === focusedWin.id ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const show = async (t) => { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); };
  const go = async (t) => { await chrome.tabs.update(t.id, { url, active: true }); await chrome.windows.update(t.windowId, { focused: true }); };
  if (mode !== 'new' && tabs.length) {
    if (mode === 'current') { await go(tabs[0]); return 'Opened in the current tab'; }
    const want = normUrl(url);
    const exact = tabs.find((t) => normUrl(t.url || '') === want);
    if (exact) { await show(exact); return 'Switched to the tab that already has it'; }
    const site = siteOf(url);
    const same = site ? tabs.filter((t) => siteOf(t.url || '') === site) : [];
    if (same.length && isSiteRoot(url)) { await show(same[0]); return 'Switched to your ' + site + ' tab'; }
    const reusable = same.find((t) => !t.audible && !KEEP_SEPARATE.test(site));
    if (reusable) { await go(reusable); return 'Opened in your ' + site + ' tab'; }
    const blank = tabs.find((t) => !t.url || BLANK_TAB.test(t.url));
    if (blank) { await go(blank); return 'Opened in the empty tab'; }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return 'Opened in a new tab';
}

async function handleCommand(cmd, deviceId) {
  const p = cmd.payload || {};
  try {
    if (cmd.type === 'open_url' && p.url) {
      const r = await smartOpen(String(p.url), String(p.tabMode || 'auto'));
      return ack(cmd, deviceId, 'completed', r + ': ' + (p.title || p.url));
    }
    if (cmd.type === 'notify') {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: String(p.title || 'RAY'), message: String(p.message || '') });
      return ack(cmd, deviceId, 'completed', 'Shown browser notification');
    }
    if (cmd.type === 'wake') return ack(cmd, deviceId, 'completed', 'Browser is awake');
    if (cmd.type !== 'bridge_command') return ack(cmd, deviceId, 'acknowledged', 'Ignored ' + cmd.type);

    const action = String(p.action || '');
    let tabId = Number(p.tabId || 0);
    if (action === 'history_search') {
      const items = await chrome.history.search({ text: String(p.query || ''), startTime: Date.now() - Number(p.days || 30) * 86400000, maxResults: Math.min(50, Number(p.max || 20)) });
      return ack(cmd, deviceId, 'completed', 'Found ' + items.length + ' history items', { items: items.map((h) => ({ title: h.title, url: h.url, lastVisit: h.lastVisitTime, visits: h.visitCount })) });
    }
    if (action === 'bookmarks_search') {
      const items = await chrome.bookmarks.search(String(p.query || ''));
      return ack(cmd, deviceId, 'completed', 'Found ' + items.length + ' bookmarks', { items: items.filter((b) => b.url).slice(0, 30).map((b) => ({ title: b.title, url: b.url })) });
    }
    if (action.startsWith('page_') && !tabId) {
      const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = act ? act.id : 0;
    }
    if (action === 'page_read' && tabId) {
      const data = await runInTab(tabId, pageReadInPage);
      return ack(cmd, deviceId, 'completed', 'Read "' + (data && data.title) + '"', data);
    }
    if ((action === 'page_click' || action === 'page_type' || action === 'page_scroll') && tabId) {
      const op = action.slice(5);
      const out = await runInTab(tabId, pageActInPage, [op, { i: p.i, text: p.text, value: p.value, submit: p.submit, dy: p.dy, allowSecret: p.allowSecret === true, allowPay: p.allowPay === true }]);
      if (!out || !out.ok) return ack(cmd, deviceId, 'failed', (out && out.msg) || 'Page action failed');
      if (op !== 'scroll') await waitForLoad(tabId, 8000);
      const data = await runInTab(tabId, pageReadInPage).catch(() => null);
      return ack(cmd, deviceId, 'completed', out.msg, data);
    }
    if (action === 'tab_open') {
      const tab = await chrome.tabs.create({ url: String(p.url || 'about:blank'), active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return ack(cmd, deviceId, 'completed', 'Opened new tab');
    }
    if (!tabId) return ack(cmd, deviceId, 'failed', 'No tab id given');
    const tab = await chrome.tabs.get(tabId);
    if (action === 'tab_navigate' && p.url) {
      await chrome.tabs.update(tabId, { url: String(p.url), active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return ack(cmd, deviceId, 'completed', 'Opened ' + p.url + ' in your "' + (tab.title || 'current') + '" tab');
    }
    if (action === 'tab_focus') {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return ack(cmd, deviceId, 'completed', 'Switched to "' + tab.title + '"');
    }
    if (action === 'tab_close') {
      await chrome.tabs.remove(tabId);
      return ack(cmd, deviceId, 'completed', 'Closed "' + tab.title + '"');
    }
    if (action === 'tab_reload') {
      await chrome.tabs.reload(tabId);
      return ack(cmd, deviceId, 'completed', 'Reloaded "' + tab.title + '"');
    }
    if (action === 'tab_mute') {
      await chrome.tabs.update(tabId, { muted: !tab.mutedInfo?.muted });
      return ack(cmd, deviceId, 'completed', (tab.mutedInfo?.muted ? 'Unmuted' : 'Muted') + ' "' + tab.title + '"');
    }
    if (action === 'tab_read') {
      const text = await readTabText(tabId);
      return ack(cmd, deviceId, 'completed', 'Read ' + text.length + ' characters from "' + tab.title + '"', { text, title: tab.title, url: tab.url });
    }
    ack(cmd, deviceId, 'failed', 'Unknown tab action ' + action);
  } catch (err) {
    ack(cmd, deviceId, 'failed', String(err && err.message ? err.message : err));
  } finally {
    pushTabsSoon();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ray:pair' && msg.token) {
    chrome.storage.local.get(['token', 'wsBase']).then(async (cur) => {
      if (cur.token !== msg.token || cur.wsBase !== msg.wsBase) {
        await chrome.storage.local.set({ roomId: msg.roomId, token: msg.token, wsBase: msg.wsBase, origin: msg.origin });
        if (ws) try { ws.close(); } catch {}
        ws = null;
      }
      connect();
    });
  }
});

for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onUpdated]) {
  ev.addListener((...args) => {
    // onUpdated fires a lot; only care when title/url settle.
    if (ev === chrome.tabs.onUpdated && !(args[1] && (args[1].title || args[1].url || args[1].status === 'complete'))) return;
    pushTabsSoon();
  });
}

// Keep the MV3 worker alive and the socket fresh.
chrome.alarms.create('ray-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'device:ping', data: {} }));
  else connect();
});
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'device:ping', data: {} }));
}, KEEPALIVE_MS);

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

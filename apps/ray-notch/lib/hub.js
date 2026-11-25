// RAY Notch <-> RAY. Joins the room as a device (so RAY can show notifications, timers and questions
// in the notch), streams chat answers, resolves approvals, syncs settings. Falls back to the PC bridge
// (offline answers, local Ollama) when the internet or RAY's server is unreachable.
'use strict';
const os = require('os');
const { EventEmitter } = require('events');

class RayLink extends EventEmitter {
  constructor(link) {
    super();
    this.link = link;
    this.ws = null;
    this.online = false;
    this.deviceId = 'notch-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '');
    this.retry = 0;
  }

  headers() {
    return { 'Content-Type': 'application/json', 'X-Relay-Room-Token': this.link.token };
  }

  connect() {
    if (!this.link || typeof WebSocket === 'undefined') return;
    const url = this.link.hub.replace(/^http/, 'ws') + `/ws?room=${encodeURIComponent(this.link.roomId)}&token=${encodeURIComponent(this.link.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.later();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setOnline(true);
      this.send('device:register', {
        id: this.deviceId,
        name: `RAY Notch (${os.hostname()})`,
        type: 'desktop',
        os: `${os.type()} ${os.arch()}`,
        browser: 'RAY Notch',
        capabilities: ['notify', 'speak', 'timers', 'ask', 'notch'],
        telemetry: {},
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const d = msg.data || {};
      if (msg.event === 'command:execute') this.emit('command', d);
      else if (msg.event === 'ask:question') this.emit('ask', d);
      else if (msg.event === 'ask:answered') this.emit('ask-answered', d);
      else if (msg.event === 'confirmation:new') this.emit('confirmation', d);
      else if (msg.event === 'ui-prefs:updated') this.emit('prefs', d);
      else if (msg.event === 'jarvis:interrupted') this.emit('interrupted', d);
    };
    ws.onclose = () => {
      this.setOnline(false);
      this.later();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // closing anyway
      }
    };
  }

  later() {
    const wait = Math.min(30_000, 2000 * 2 ** Math.min(this.retry++, 4));
    setTimeout(() => this.connect(), wait).unref?.();
  }

  setOnline(v) {
    if (this.online !== v) {
      this.online = v;
      this.emit('online', v);
    }
  }

  send(event, data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ event, data }));
  }

  ack(cmd, status, message) {
    this.send('command:ack', { commandId: cmd.id, deviceId: this.deviceId, status, message });
  }

  /**
   * Ask RAY. Streams events: onEvent({type:'engine'|'tool_start'|'tool_end'|'text'|'confirmation_required'|'error'|'done', data}).
   * Returns the final answer text.
   */
  async chat(message, { attachments, history, onEvent, signal } = {}) {
    const r = await fetch(`${this.link.hub}/api/ai/chat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        roomId: this.link.roomId,
        sourceDeviceName: `RAY Notch (${os.hostname()})`,
        message,
        history: history || [],
        attachments: attachments || [],
        engine: { provider: 'auto' },
      }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`RAY answered ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let answer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(chunk.slice(6));
          if (ev.type === 'text') answer = String(ev.data || '');
          onEvent && onEvent(ev);
        } catch {
          // keep-alive or partial
        }
      }
    }
    return answer;
  }

  async resolveConfirmation(id, approved) {
    const r = await fetch(`${this.link.hub}/api/confirmations/resolve`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ roomId: this.link.roomId, confirmationId: id, approved, sourceDeviceName: `RAY Notch (${os.hostname()})` }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.summary || (approved ? 'Done.' : 'Cancelled.'));
  }

  async answerAsk(askId, answer) {
    await fetch(`${this.link.hub}/api/ask/answer`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ roomId: this.link.roomId, askId, answer, via: 'RAY Notch' }) }).catch(() => undefined);
  }

  async getPrefs() {
    const r = await fetch(`${this.link.hub}/api/ui-prefs?room=${encodeURIComponent(this.link.roomId)}`, { headers: this.headers() });
    return r.ok ? r.json() : null;
  }

  async savePrefs(notch) {
    await fetch(`${this.link.hub}/api/ui-prefs`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ roomId: this.link.roomId, notch }) }).catch(() => undefined);
  }

  // --- the PC bridge on this computer (works with no internet) -----------------------------------
  async bridge(pathname, body) {
    const r = await fetch(`http://127.0.0.1:${this.link.localPort}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body && pathname === '/ask' ? 90_000 : 20_000),
    });
    return r.json();
  }

  /** Run a device action on this PC through the bridge (open_app, volume, media keys, lock…). */
  async action(action, args = {}) {
    try {
      const j = await this.bridge('/command', { action, ...args });
      return { ok: Boolean(j.ok), message: j.data?.message || j.data || j.error || '' };
    } catch (e) {
      return { ok: false, message: `The RAY bridge on this PC isn't running (${e.message}).` };
    }
  }

  /** Offline answer: the bridge's own quick commands, LAN link to the phone, or local Ollama. */
  /** '' when the bridge isn't running, so the notch can say what it can still do offline. */
  async askOffline(text) {
    try {
      const j = await this.bridge('/ask', { text });
      return String(j.answer || '');
    } catch {
      return '';
    }
  }
}

module.exports = { RayLink };

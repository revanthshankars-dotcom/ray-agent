import type { NextFunction, Request, Response } from 'express';

const BLOCKED_HOTKEYS = new Set([
  'ctrl+alt+del',
  'ctrl+alt+delete',
  'control+alt+delete',
  'cmd+q',
  'command+q',
  'alt+f4',
  'win+r',
  'meta+r',
  'cmd+shift+q',
  'ctrl+shift+q',
  'ctrl+alt+backspace',
  'super+l',
]);

const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'cookie',
  'set-cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
]);

const SAFE_DEEP_LINK_SCHEMES = new Set([
  'https:',
  'http:',
  'whatsapp:',
  'notion:',
  'obsidian:',
  'vscode:',
  'spotify:',
  'slack:',
  'discord:',
  'tg:',
]);

export function sanitizeErrorMessage(err: unknown, fallback = 'Request failed'): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (!raw) return fallback;
  return raw
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 400);
}

export function isPrivateOrMetadataHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === 'metadata.google.internal' ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return true;
  }
  if (h.startsWith('169.254.') || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('127.')) {
    return true;
  }
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (h.startsWith('100.100.100.')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

export function assertSafeExternalUrl(
  rawUrl: string,
  options?: { allowLocalhost?: boolean; allowDeepLinks?: boolean }
): URL {
  const trimmed = (rawUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format.');
  }

  const proto = parsed.protocol.toLowerCase();
  if (options?.allowDeepLinks) {
    if (!SAFE_DEEP_LINK_SCHEMES.has(proto)) {
      throw new Error(`Blocked URI scheme "${proto}".`);
    }
    return parsed;
  }

  if (proto !== 'https:' && proto !== 'http:') {
    throw new Error(`Blocked URL protocol "${proto}". Only http/https allowed.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (options?.allowLocalhost && (host === '127.0.0.1' || host === 'localhost')) {
    return parsed;
  }

  if (isPrivateOrMetadataHost(host)) {
    throw new Error(`Blocked private or metadata destination "${host}".`);
  }

  return parsed;
}

export function sanitizeCustomHeaders(headersJson?: string): Record<string, string> {
  if (!headersJson || !headersJson.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    throw new Error('Connector headersJson must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector headers must be a JSON object.');
  }
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    const cleanKey = k.trim();
    const lowerKey = cleanKey.toLowerCase();
    if (!cleanKey || FORBIDDEN_HEADER_NAMES.has(lowerKey)) continue;
    if (/[\r\n]/.test(cleanKey) || /[\r\n]/.test(String(v))) continue;
    safe[cleanKey] = String(v).slice(0, 1000);
  }
  return safe;
}

export function validateScreenControlAction(
  action: string,
  payload: Record<string, unknown>
): { ok: true; sanitized: Record<string, unknown> } | { ok: false; reason: string } {
  const cleanAction = String(action || '').trim().toLowerCase();
  const allowedActions = new Set([
    'screenshot_screen',
    'mouse_move',
    'mouse_click',
    'mouse_double_click',
    'scroll_screen',
    'type_text',
    'press_hotkey',
    'focus_window',
  ]);

  if (!allowedActions.has(cleanAction)) {
    return { ok: false, reason: `Unsupported screen control action "${cleanAction}".` };
  }

  if (cleanAction === 'press_hotkey') {
    const rawCombo = String(payload.keys || payload.hotkey || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (!rawCombo || rawCombo.length > 40) {
      return { ok: false, reason: 'Hotkey combination is required and must be under 40 characters.' };
    }
    if (BLOCKED_HOTKEYS.has(rawCombo)) {
      return { ok: false, reason: `Hotkey "${rawCombo}" is blocked by the RAY GUI safety policy.` };
    }
    return { ok: true, sanitized: { action: cleanAction, keys: rawCombo } };
  }

  if (cleanAction === 'type_text') {
    const text = String(payload.text || '');
    if (!text) return { ok: false, reason: 'Text payload cannot be empty.' };
    const safeText = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 500);
    return { ok: true, sanitized: { action: cleanAction, text: safeText } };
  }

  if (cleanAction === 'mouse_move' || cleanAction === 'mouse_click' || cleanAction === 'mouse_double_click') {
    const x = Math.max(0, Math.min(7680, Math.round(Number(payload.x ?? 0))));
    const y = Math.max(0, Math.min(4320, Math.round(Number(payload.y ?? 0))));
    const button = payload.button === 'right' ? 'right' : 'left';
    return { ok: true, sanitized: { action: cleanAction, x, y, button } };
  }

  if (cleanAction === 'scroll_screen') {
    const deltaY = Math.max(-2000, Math.min(2000, Math.round(Number(payload.deltaY ?? -300))));
    return { ok: true, sanitized: { action: cleanAction, deltaY } };
  }

  if (cleanAction === 'focus_window') {
    const target = String(payload.target || payload.window || '').trim().slice(0, 80);
    if (!/^[a-zA-Z0-9 ._-]{1,80}$/.test(target)) {
      return { ok: false, reason: 'Window name contains invalid characters.' };
    }
    return { ok: true, sanitized: { action: cleanAction, target } };
  }

  return { ok: true, sanitized: { action: cleanAction } };
}

export function createRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'local';
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((ts) => now - ts < opts.windowMs);
    if (recent.length >= opts.max) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please pause briefly before sending more requests.',
      });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 2000) {
      for (const [key, list] of hits.entries()) {
        if (list.every((ts) => now - ts >= opts.windowMs)) {
          hits.delete(key);
        }
      }
    }
    next();
  };
}

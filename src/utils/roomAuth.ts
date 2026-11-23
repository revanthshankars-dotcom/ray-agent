export function normalizeClientRoomId(raw?: string): string {
  const cleaned = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 20) : 'RLY-HOME';
}

export function getStoredRoomToken(roomId: string): string {
  if (typeof window === 'undefined') return '';
  const norm = normalizeClientRoomId(roomId);
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get('token')?.trim();
  if (fromUrl) {
    localStorage.setItem(`relay_room_token_${norm}`, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(`relay_room_token_${norm}`) || '';
}

export function setStoredRoomToken(roomId: string, token: string): void {
  if (typeof window === 'undefined') return;
  const norm = normalizeClientRoomId(roomId);
  if (token.trim()) {
    localStorage.setItem(`relay_room_token_${norm}`, token.trim());
  }
}

export async function ensureRoomBootstrap(
  roomId: string,
  explicitToken?: string
): Promise<{ authorized: boolean; roomToken?: string; error?: string }> {
  const norm = normalizeClientRoomId(roomId);
  const candidate = (explicitToken ?? getStoredRoomToken(norm)).trim();

  const headers: Record<string, string> = {};
  if (candidate) {
    headers['X-Relay-Room-Token'] = candidate;
  }

  const res = await fetch(`/api/room/${encodeURIComponent(norm)}/bootstrap`, { headers });
  const data = (await res.json()) as { authorized?: boolean; roomToken?: string; error?: string };
  if (res.ok && data.authorized && data.roomToken) {
    setStoredRoomToken(norm, data.roomToken);
    return { authorized: true, roomToken: data.roomToken };
  }
  return {
    authorized: false,
    error: data.error || 'Room token required to join this workspace room.',
  };
}

export async function authFetch(
  url: string,
  roomId: string,
  init: RequestInit = {},
  extras?: {
    googleAccessToken?: string | null;
    notionToken?: string | null;
  }
): Promise<Response> {
  const norm = normalizeClientRoomId(roomId);
  let token = getStoredRoomToken(norm);
  if (!token) {
    const boot = await ensureRoomBootstrap(norm);
    token = boot.roomToken || '';
  }

  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set('X-Relay-Room-Token', token);
  }
  if (extras?.googleAccessToken) {
    headers.set('Authorization', `Bearer ${extras.googleAccessToken}`);
  }
  if (extras?.notionToken) {
    headers.set('X-Notion-Token', extras.notionToken);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(url, { ...init, headers });
}

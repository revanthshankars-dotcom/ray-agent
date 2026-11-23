// Runs on every page but only acts on the RAY web app (it carries <meta name="ray-hub">).
// Reads the room id + token RAY already stored, so the extension pairs itself — no copy/paste.
(() => {
  const marker = document.querySelector('meta[name="ray-hub"]');
  if (!marker) return;
  try {
    const roomId = localStorage.getItem('relay_room_id') || 'RLY-HOME';
    const token = localStorage.getItem('relay_room_token_' + roomId);
    if (!token) return;
    const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    chrome.runtime.sendMessage({ type: 'ray:pair', roomId, token, wsBase, origin: location.origin });
  } catch {
    // storage blocked – ignore
  }
})();

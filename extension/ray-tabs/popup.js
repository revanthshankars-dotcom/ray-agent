chrome.storage.local.get(['token', 'roomId', 'origin']).then((c) => {
  const paired = Boolean(c.token);
  document.getElementById('dot').className = 'd' + (paired ? ' on' : '');
  document.getElementById('state').textContent = paired ? `Paired with room ${c.roomId}` : 'Not paired yet';
  if (paired) document.getElementById('hint').textContent = `Hub: ${c.origin}. Try: "Hey Ray, switch to my Gmail tab".`;
});

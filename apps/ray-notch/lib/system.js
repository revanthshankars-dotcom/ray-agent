// Things the notch does on this PC directly (works offline): volume, media keys, lock, dark mode,
// brightness, settings pages, what's playing (+ synced lyrics), typing text into the current app.
'use strict';
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const P = process.platform;
const run = (cmd, args, timeout = 8000) =>
  new Promise((res) => execFile(cmd, args, { timeout, windowsHide: true }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || (e && e.message) || '') })));
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 15000);
const osa = (script) => run('osascript', ['-e', script]);

// Windows virtual-key media/volume keys, sent through WScript.Shell.
const VK = { mute: 173, down: 174, up: 175, next: 176, prev: 177, stop: 178, playpause: 179 };
const winKey = (code, times = 1) => ps(`$w=New-Object -ComObject WScript.Shell; 1..${times} | % { $w.SendKeys([char]${code}) }`);

async function setVolume(level) {
  const v = Math.max(0, Math.min(100, Math.round(level)));
  if (P === 'win32') {
    await winKey(VK.down, 50);
    if (v) await winKey(VK.up, Math.round(v / 2));
  } else if (P === 'darwin') await osa(`set volume output volume ${v}`);
  else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`]);
  return `Volume set to ${v}%.`;
}
async function volumeStep(dir) {
  if (P === 'win32') await winKey(dir > 0 ? VK.up : VK.down, 5);
  else if (P === 'darwin') await osa(`set volume output volume ((output volume of (get volume settings)) ${dir > 0 ? '+' : '-'} 10)`);
  else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${dir > 0 ? '+' : '-'}10%`]);
  return dir > 0 ? 'Volume up.' : 'Volume down.';
}
async function mute() {
  if (P === 'win32') await winKey(VK.mute);
  else if (P === 'darwin') await osa('set volume with output muted');
  else await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
  return 'Muted.';
}
async function media(action) {
  // action: playpause | next | prev | pause | play
  if (P === 'win32') await winKey(VK[action === 'pause' || action === 'play' ? 'playpause' : action]);
  else if (P === 'darwin') {
    const verb = { playpause: 'playpause', play: 'play', pause: 'pause', next: 'next track', prev: 'previous track' }[action];
    await osa(`if application "Spotify" is running then tell application "Spotify" to ${verb}\nif application "Music" is running then tell application "Music" to ${verb}`);
  } else await run('playerctl', [{ playpause: 'play-pause', play: 'play', pause: 'pause', next: 'next', prev: 'previous' }[action]]);
  return { playpause: 'Done.', play: 'Playing.', pause: 'Paused.', next: 'Next track.', prev: 'Previous track.' }[action];
}
async function lock() {
  if (P === 'win32') await run('rundll32.exe', ['user32.dll,LockWorkStation']);
  else if (P === 'darwin') await run('pmset', ['displaysleepnow']);
  else await run('loginctl', ['lock-session']);
  return 'Locked.';
}
async function darkMode(on) {
  if (P === 'win32') {
    const v = on ? 0 : 1;
    await ps(`$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; Set-ItemProperty $k AppsUseLightTheme ${v}; Set-ItemProperty $k SystemUsesLightTheme ${v}`);
  } else if (P === 'darwin') await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${on}`);
  else await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', on ? 'prefer-dark' : 'default']);
  return on ? 'Dark mode on.' : 'Light mode on.';
}
async function brightness(level) {
  const v = Math.max(5, Math.min(100, Math.round(level)));
  if (P === 'win32') {
    const r = await ps(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${v})`);
    return r.ok ? `Brightness ${v}%.` : 'This screen does not let apps change brightness (external monitors usually don’t).';
  }
  if (P === 'linux') {
    const r = await run('brightnessctl', ['set', `${v}%`]);
    return r.ok ? `Brightness ${v}%.` : 'Install brightnessctl to change brightness.';
  }
  return 'Use the brightness keys on a Mac.';
}
/** Settings pages for toggles Windows doesn't let apps flip silently. */
async function openSettings(page) {
  const win = { wifi: 'ms-settings:network-wifi', bluetooth: 'ms-settings:bluetooth', nightlight: 'ms-settings:nightlight', display: 'ms-settings:display', sound: 'ms-settings:sound' };
  const mac = { wifi: 'x-apple.systempreferences:com.apple.wifi-settings-extension', bluetooth: 'x-apple.systempreferences:com.apple.BluetoothSettings', nightlight: 'x-apple.systempreferences:com.apple.Displays-Settings.extension', display: 'x-apple.systempreferences:com.apple.Displays-Settings.extension', sound: 'x-apple.systempreferences:com.apple.Sound-Settings.extension' };
  if (P === 'win32') await run('cmd.exe', ['/c', 'start', '', win[page] || 'ms-settings:']);
  else if (P === 'darwin') await run('open', [mac[page] || 'x-apple.systempreferences:']);
  else await run('gnome-control-center', [page === 'nightlight' ? 'display' : page]);
  return `Opened ${page === 'nightlight' ? 'Night light' : page === 'wifi' ? 'Wi-Fi' : page} settings.`;
}

// --- Now playing ---------------------------------------------------------------------------------
// Windows: one long-running PowerShell reads the system media session (Spotify, browsers, apps) every
// 1.5 s. macOS: AppleScript for Spotify / Music. Linux: playerctl (MPRIS).
const WIN_MEDIA = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
Function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties(); $pb = $s.GetPlaybackInfo()
      @{ title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; app = $s.SourceAppUserModelId; status = [string]$pb.PlaybackStatus; position = $tl.Position.TotalSeconds; duration = $tl.EndTime.TotalSeconds } | ConvertTo-Json -Compress
    } else { '{}' }
  } catch { '{}' }
  Start-Sleep -Milliseconds 1500
}`;

class NowPlaying extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.proc = null;
    this.timer = null;
  }
  start() {
    if (P === 'win32') {
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_MEDIA], { windowsHide: true });
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith('{')) this.update(line);
        }
      });
      this.proc.on('exit', () => setTimeout(() => this.start(), 10_000).unref?.());
    } else {
      this.timer = setInterval(() => void this.poll(), 1500);
    }
  }
  async poll() {
    if (P === 'darwin') {
      const r = await osa(
        'set out to "{}"\nrepeat with a in {"Spotify", "Music"}\nif application a is running then\ntell application a\nif player state is playing or player state is paused then\nset out to "{\\"title\\":\\"" & name of current track & "\\",\\"artist\\":\\"" & artist of current track & "\\",\\"app\\":\\"" & a & "\\",\\"status\\":\\"" & (player state as string) & "\\",\\"position\\":" & (player position as integer) & ",\\"duration\\":" & ((duration of current track) as integer) & "}"\nend if\nend tell\nend if\nend repeat\nreturn out'
      );
      if (r.ok) this.update(r.out.trim(), true);
    } else {
      const r = await run('playerctl', ['metadata', '--format', '{{title}}\t{{artist}}\t{{status}}\t{{position}}\t{{mpris:length}}\t{{playerName}}']);
      if (!r.ok || !r.out.trim()) return this.update('{}');
      const [title, artist, status, pos, len, app] = r.out.trim().split('\t');
      this.update(JSON.stringify({ title, artist, status, position: Number(pos) / 1e6, duration: Number(len) / 1e6, app }));
    }
  }
  update(json, macMs) {
    let j = {};
    try {
      j = JSON.parse(json);
    } catch {
      return;
    }
    if (!j.title) {
      if (this.current) {
        this.current = null;
        this.emit('change', null);
      }
      return;
    }
    let duration = Number(j.duration || 0);
    if (macMs && duration > 10000) duration /= 1000; // Spotify reports ms
    const next = { title: String(j.title), artist: String(j.artist || ''), app: String(j.app || ''), playing: /play/i.test(String(j.status)), position: Number(j.position || 0), duration, at: Date.now() };
    const changed = !this.current || this.current.title !== next.title || this.current.playing !== next.playing || Math.abs(this.current.position - next.position) > 3;
    this.current = next;
    if (changed) this.emit('change', next);
  }
  stop() {
    if (this.proc) this.proc.kill();
    if (this.timer) clearInterval(this.timer);
  }
}

/** Synced lyrics from LRCLIB (free, no key). Returns [{t: seconds, line}] or null. */
async function fetchLyrics(title, artist, duration) {
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist || '' });
    if (duration) q.set('duration', String(Math.round(duration)));
    let r = await fetch(`https://lrclib.net/api/get?${q}`, { headers: { 'User-Agent': 'RAY-Notch/0.1' }, signal: AbortSignal.timeout(8000) });
    let j = r.ok ? await r.json() : null;
    if (!j || !j.syncedLyrics) {
      r = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${title} ${artist || ''}` })}`, { headers: { 'User-Agent': 'RAY-Notch/0.1' }, signal: AbortSignal.timeout(8000) });
      const list = r.ok ? await r.json() : [];
      j = Array.isArray(list) ? list.find((x) => x.syncedLyrics) : null;
    }
    if (!j || !j.syncedLyrics) return null;
    return parseLrc(j.syncedLyrics);
  } catch {
    return null;
  }
}
function parseLrc(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m) out.push({ t: Number(m[1]) * 60 + Number(m[2]), line: m[3] });
  }
  return out.length ? out : null;
}

module.exports = { setVolume, volumeStep, mute, media, lock, darkMode, brightness, openSettings, NowPlaying, fetchLyrics, parseLrc };

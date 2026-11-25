// Things the notch does on this PC directly (works offline): volume, media keys, lock, dark mode,
// brightness, settings pages, what's playing (+ synced lyrics), typing text into the current app.
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const P = process.platform;
const run = (cmd, args, timeout = 8000) =>
  new Promise((res) => execFile(cmd, args, { timeout, windowsHide: true }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || (e && e.message) || '') })));
const osa = (script) => run('osascript', ['-e', script]);

// Windows: one PowerShell started once and kept warm. A fresh powershell.exe per click costs 1-5 s
// (more while antivirus scans it); through the warm worker a command takes a few milliseconds.
const WIN_CS = String.raw`
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int a(); int b(); int c(); int d();
  int SetMasterVolumeLevelScalar(float level, Guid ctx); int e();
  int GetMasterVolumeLevelScalar(out float level); int f(); int g(); int h(); int i();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int a(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class RayPc {
  static IAudioEndpointVolume Ep() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator(); IMMDevice d;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out d));
    var iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o; }
  public static int GetVolume() { float v; Ep().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); }
  public static void SetVolume(int v) { var e = Ep(); e.SetMute(false, Guid.Empty); e.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, v)) / 100f, Guid.Empty); }
  public static bool ToggleMute() { var e = Ep(); bool m; e.GetMute(out m); e.SetMute(!m, Guid.Empty); return !m; }
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Key(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }
}`;
// Separate so a problem here can never take the volume and media controls down with it.
const WIN_DDC = String.raw`
using System; using System.Runtime.InteropServices;
public static class RayDdc {
  delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, IntPtr rc, IntPtr data);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string d; }
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr rc, MonitorEnumProc cb, IntPtr data);
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint n);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] a);
  [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr h, out uint mn, out uint cur, out uint mx);
  [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr h, uint v);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] a);
  // External monitors: DDC/CI (the monitor's own brightness, set over the video cable).
  public static int SetDdcBrightness(int pct) {
    int ok = 0;
    var mons = new System.Collections.Generic.List<IntPtr>();
    MonitorEnumProc cb = (h, dc, r, d) => { mons.Add(h); return true; };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
    foreach (var m in mons) {
      uint n;
      if (!GetNumberOfPhysicalMonitorsFromHMONITOR(m, out n) || n == 0) continue;
      var a = new PHYSICAL_MONITOR[n];
      if (!GetPhysicalMonitorsFromHMONITOR(m, n, a)) continue;
      foreach (var p in a) {
        uint mn, cur, mx;
        if (GetMonitorBrightness(p.h, out mn, out cur, out mx) && mx > mn && SetMonitorBrightness(p.h, (uint)(mn + (mx - mn) * Math.Max(0, Math.Min(100, pct)) / 100))) ok++;
      }
      DestroyPhysicalMonitors(n, a);
    }
    GC.KeepAlive(cb);
    return ok;
  }
}
`;
// The worker is a small script file that reads one command per line from stdin and answers with a
// marker. Media goes through Windows' media session (the same one that shows "now playing", so it
// reaches YouTube in a browser and Spotify alike), with real media keys as the fallback.
const WIN_WORKER = [
  "$ErrorActionPreference = 'Stop'",
  "$ready = 'ok'",
  "try {",
  "Add-Type -TypeDefinition @'",
  WIN_CS.trim(),
  "'@",
  "} catch { $ready = 'audio helper failed: ' + $_.Exception.Message }",
  "try {",
  "Add-Type -TypeDefinition @'",
  WIN_DDC.trim(),
  "'@",
  "} catch { }",
  "$script:mgr = $null",
  "$script:asTask = $null",
  "try {",
  "  Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]",
  "  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null",
  "} catch { $ready += ' | media session unavailable: ' + $_.Exception.Message }",
  "function Await($op, $type) { $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(1500) | Out-Null; $t.Result }",
  "function RayMedia([string]$a) {",
  "  try {",
  "    if (-not $script:mgr) { $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }",
  "    $s = $script:mgr.GetCurrentSession()",
  "    if ($s) {",
  "      $op = switch ($a) { 'play' { $s.TryPlayAsync() } 'pause' { $s.TryPauseAsync() } 'next' { $s.TrySkipNextAsync() } 'prev' { $s.TrySkipPreviousAsync() } default { $s.TryTogglePlayPauseAsync() } }",
  "      if (Await $op ([bool])) { return 'session' }",
  "    }",
  "  } catch { }",
  "  $vk = @{ next = 176; prev = 177; playpause = 179; play = 179; pause = 179 }[$a]",
  "  [RayPc]::Key([byte]$vk)",
  "  return 'key'",
  "}",
  "[Console]::Out.WriteLine('__RAY_READY__ ' + $ready); [Console]::Out.Flush()",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $i = $line.IndexOf(' ')",
  "  if ($i -lt 1) { continue }",
  "  $id = $line.Substring(0, $i)",
  "  try { $o = (Invoke-Expression $line.Substring($i + 1) | Out-String).Trim(); [Console]::Out.WriteLine($o + '__RAY_OK_' + $id + '__') }",
  "  catch { [Console]::Out.WriteLine('__RAY_ERR_' + $id + '__' + ($_.Exception.Message -replace '\\r?\\n', ' ')) }",
  "  [Console]::Out.Flush()",
  "}",
].join('\r\n');

class PsWorker {
  constructor(name) {
    this.name = name;
    this.proc = null;
    this.waiting = []; // not yet sent: one command at a time, so a stuck one can't pile up others
    this.current = null;
    this.seq = 0;
    this.buf = '';
    this.status = 'starting';
  }
  ensure() {
    if (this.proc) return;
    const file = path.join(os.tmpdir(), `ray-notch-${this.name}.ps1`);
    fs.writeFileSync(file, WIN_WORKER, 'utf8');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => console.warn(`[RAY Notch] PowerShell (${this.name}):`, String(d).trim().slice(0, 300)));
    proc.on('error', (e) => console.warn('[RAY Notch] PowerShell did not start:', e.message));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.status = `exited (${code})`;
      this.finish({ ok: false, out: '', err: 'PowerShell stopped' });
    });
  }
  onData(d) {
    this.buf += d;
    const r = this.buf.match(/__RAY_READY__ ([^\r\n]*)\r?\n/);
    if (r) {
      this.status = r[1];
      if (r[1] !== 'ok') console.warn('[RAY Notch] PC controls:', r[1]);
      this.buf = this.buf.slice(r.index + r[0].length);
    }
    const m = this.buf.match(/__RAY_(OK|ERR)_(\d+)__([^\r\n]*)\r?\n/);
    if (!m) return;
    const before = this.buf.slice(0, m.index);
    this.buf = this.buf.slice(m.index + m[0].length);
    if (this.current && this.current.id === Number(m[2])) this.finish({ ok: m[1] === 'OK', out: (before + m[3]).trim(), err: m[1] === 'ERR' ? m[3] : '' });
  }
  finish(result) {
    const c = this.current;
    this.current = null;
    if (c) {
      clearTimeout(c.timer);
      c.resolve(result);
    }
    this.pump();
  }
  pump() {
    if (this.current) return;
    while (this.waiting.length) {
      const job = this.waiting.shift();
      // A click that waited too long is dropped, so it can't fire a minute later.
      if (job.maxWait && Date.now() - job.at > job.maxWait) {
        job.resolve({ ok: false, out: '', err: 'skipped — the PC was busy' });
        continue;
      }
      this.ensure();
      job.id = ++this.seq;
      this.current = job;
      job.timer = setTimeout(() => {
        // Stuck: restart PowerShell rather than letting everything queue behind it.
        console.warn(`[RAY Notch] PowerShell (${this.name}) took over ${job.timeout} ms, restarting it`);
        const p = this.proc;
        this.proc = null;
        try {
          p && p.kill();
        } catch {
          /* gone */
        }
        this.finish({ ok: false, out: '', err: 'timeout' });
      }, job.timeout);
      try {
        this.proc.stdin.write(`${job.id} ${job.script.replace(/\r?\n/g, '; ')}\n`);
      } catch {
        this.finish({ ok: false, out: '', err: 'PowerShell not reachable' });
      }
      return;
    }
  }
  /** key: only the latest command with this key runs (volume slider). maxWait: drop if not started by then. */
  exec(script, timeout = 8000, { key, maxWait } = {}) {
    return new Promise((resolve) => {
      if (key) {
        for (const j of this.waiting.filter((x) => x.key === key)) j.resolve({ ok: true, out: '', err: '' });
        this.waiting = this.waiting.filter((x) => x.key !== key);
      }
      this.waiting.push({ script, timeout, key, maxWait, at: Date.now(), resolve });
      this.pump();
    });
  }
  stop() {
    if (this.proc) this.proc.kill();
  }
}
// Two helpers: "fast" only for clicks (volume, mute, media) so slow jobs never block a button,
// "slow" for app lists, closing apps, brightness and dark mode.
const fast = P === 'win32' ? new PsWorker('fast') : null;
const slow = P === 'win32' ? new PsWorker('slow') : null;
const CLICK = { maxWait: 3000 };
const ps = (script, timeout = 4000, opts = CLICK) => fast.exec(script, timeout, opts);
const psSlow = (script, timeout = 15000, opts) => slow.exec(script, timeout, opts);
/** Start both helpers early so the first click is instant too. */
function warmUp() {
  if (fast) void fast.exec('1', 30000);
  if (slow) void slow.exec('1', 30000);
}
/** For "why isn't it working": the worker's start-up result. */
const controlsStatus = () => (fast ? fast.status : 'ok');

// Windows virtual-key codes for media keys.
const VK = { next: 176, prev: 177, stop: 178, playpause: 179 };

async function getVolume() {
  if (P === 'win32') {
    const r = await ps('[RayPc]::GetVolume()');
    return r.ok ? Number(r.out) : null;
  }
  if (P === 'darwin') {
    const r = await osa('output volume of (get volume settings)');
    return r.ok ? Number(r.out.trim()) : null;
  }
  const r = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
  const m = r.out.match(/(\d+)%/);
  return m ? Number(m[1]) : null;
}
async function setVolume(level) {
  const v = Math.max(0, Math.min(100, Math.round(level)));
  if (P === 'win32') {
    const r = await ps(`[RayPc]::SetVolume(${v})`, 4000, { key: 'volume', maxWait: 3000 });
    if (!r.ok) return 'Could not change the volume.';
  } else if (P === 'darwin') await osa(`set volume output volume ${v}`);
  else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`]);
  return `Volume ${v}%.`;
}
async function volumeStep(dir) {
  if (P === 'win32') {
    const r = await ps(`$v=[RayPc]::GetVolume() + ${dir > 0 ? 10 : -10}; [RayPc]::SetVolume($v); [RayPc]::GetVolume()`);
    return r.ok ? `Volume ${r.out}%.` : 'Could not change the volume.';
  }
  if (P === 'darwin') await osa(`set volume output volume ((output volume of (get volume settings)) ${dir > 0 ? '+' : '-'} 10)`);
  else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${dir > 0 ? '+' : '-'}10%`]);
  return dir > 0 ? 'Volume up.' : 'Volume down.';
}
async function mute() {
  if (P === 'win32') {
    const r = await ps('[RayPc]::ToggleMute()');
    return r.ok ? (/true/i.test(r.out) ? 'Muted.' : 'Sound on.') : 'Could not mute.';
  }
  if (P === 'darwin') await osa('set volume output muted (not (output muted of (get volume settings)))');
  else await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
  return 'Mute toggled.';
}
async function media(action) {
  // action: playpause | next | prev | pause | play
  if (P === 'win32') {
    const r = await ps(`RayMedia '${['play', 'pause', 'next', 'prev'].includes(action) ? action : 'playpause'}'`);
    if (!r.ok) return `Couldn’t control the music (${r.err || 'no answer from Windows'}).`;
  }
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
    await psSlow(`$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; Set-ItemProperty $k AppsUseLightTheme ${v}; Set-ItemProperty $k SystemUsesLightTheme ${v}`);
  } else if (P === 'darwin') await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${on}`);
  else await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', on ? 'prefer-dark' : 'default']);
  return on ? 'Dark mode on.' : 'Light mode on.';
}
async function brightness(level) {
  const v = Math.max(5, Math.min(100, Math.round(level)));
  if (P === 'win32') {
    // Laptop screens: Windows' brightness (WMI). External monitors: DDC/CI. Both are tried.
    const r = await psSlow(
      `$n = 0; try { foreach ($i in @(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods -ErrorAction Stop)) { $i.WmiSetBrightness(1, [byte]${v}) | Out-Null; $n++ } } catch { }; try { $n += [RayDdc]::SetDdcBrightness(${v}) } catch { }; $n`,
      15000,
      { key: 'brightness' }
    );
    if (r.ok && Number(r.out) > 0) return `Brightness ${v}%.`;
    return 'Your monitor didn’t accept the change. Turn on “DDC/CI” in the monitor’s own menu (its buttons), then try again.';
  }
  if (P === 'linux') {
    const r = await run('brightnessctl', ['set', `${v}%`]);
    return r.ok ? `Brightness ${v}%.` : 'Install brightnessctl to change brightness.';
  }
  return 'Use the brightness keys on a Mac.';
}
/** Settings pages for toggles Windows doesn't let apps flip silently. */
async function openSettings(page) {
  const win = { wifi: 'ms-settings:network-wifi', bluetooth: 'ms-settings:bluetooth', nightlight: 'ms-settings:nightlight', display: 'ms-settings:display', sound: 'ms-settings:sound', power: 'ms-settings:powersleep' };
  const mac = { wifi: 'x-apple.systempreferences:com.apple.wifi-settings-extension', bluetooth: 'x-apple.systempreferences:com.apple.BluetoothSettings', nightlight: 'x-apple.systempreferences:com.apple.Displays-Settings.extension', display: 'x-apple.systempreferences:com.apple.Displays-Settings.extension', sound: 'x-apple.systempreferences:com.apple.Sound-Settings.extension', power: 'x-apple.systempreferences:com.apple.Battery-Settings.extension' };
  if (P === 'win32') await run('cmd.exe', ['/c', 'start', '', win[page] || 'ms-settings:']);
  else if (P === 'darwin') await run('open', [mac[page] || 'x-apple.systempreferences:']);
  else await run('gnome-control-center', [page === 'nightlight' ? 'display' : page]);
  return `Opened ${{ nightlight: 'Night light', wifi: 'Wi-Fi', power: 'power mode' }[page] || page} settings.`;
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

/** Closes an app's windows politely (like clicking X). Says "Closed" only when something closed. */
async function closeApp(name) {
  const q = String(name || '').replace(/['"`$]/g, '').trim();
  if (!q) return null;
  if (P === 'win32') {
    const r = await psSlow(`$q='${q}'; $ps = Get-Process | ? { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$($q -replace ' ','')*" -or $_.MainWindowTitle -like "*$q*") } | ? { $_.ProcessName -notin @('electron','explorer','powershell') }; $n=0; foreach ($p in $ps) { if ($p.CloseMainWindow()) { $n++ } }; $n`);
    return r.ok ? Number(r.out) || 0 : 0;
  }
  if (P === 'darwin') {
    const r = await osa(`tell application "${q}" to quit`);
    return r.ok ? 1 : 0;
  }
  const r = await run('pkill', ['-f', q]);
  return r.ok ? 1 : 0;
}

/** "play believer" -> a YouTube watch link for the top result (so it starts playing), or null. */
async function youtubeTop(query) {
  try {
    const r = await fetch(`https://www.youtube.com/results?${new URLSearchParams({ search_query: query })}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(4000),
    });
    const m = r.ok ? (await r.text()).match(/"videoId":"([\w-]{11})"/) : null;
    return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
  } catch {
    return null;
  }
}

function stopWorker() {
  if (fast) fast.stop();
  if (slow) slow.stop();
}

const runPs = (script, timeout) => (slow ? slow.exec(script, timeout) : Promise.resolve({ ok: false, out: '', err: 'not Windows' }));

module.exports = { warmUp, stopWorker, runPs, controlsStatus, closeApp, getVolume, setVolume, volumeStep, mute, media, lock, darkMode, brightness, openSettings, NowPlaying, fetchLyrics, parseLrc, youtubeTop };

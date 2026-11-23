import type { DeviceTelemetry, DeviceType } from '../types/relay';

export interface LocalDeviceIdentity {
  id: string;
  name: string;
  type: DeviceType;
  os: string;
  browser: string;
}

function detectOS(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Web OS';
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  return 'Browser';
}

function detectDeviceType(): DeviceType {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    return 'tablet';
  }
  if (/iPhone|iPod|Android.*Mobile|Mobile/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}

export function getOrCreateLocalDeviceIdentity(): LocalDeviceIdentity {
  let id = localStorage.getItem('relay_device_id');
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('relay_device_id', id);
  }

  const os = detectOS();
  const browser = detectBrowser();
  const type = detectDeviceType();

  let name = localStorage.getItem('relay_device_name');
  if (!name) {
    const label = type === 'mobile' ? 'Phone' : type === 'tablet' ? 'Tablet' : 'Workstation';
    name = `${os} ${label} (${browser})`;
    localStorage.setItem('relay_device_name', name);
  }

  return { id, name, type, os, browser };
}

export function setLocalDeviceName(name: string): void {
  localStorage.setItem('relay_device_name', name.trim());
}

export async function collectDeviceTelemetry(includeGeo = false): Promise<DeviceTelemetry> {
  const telemetry: DeviceTelemetry = {
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    platform: navigator.platform || detectOS(),
  };

  const nav = navigator as Navigator & {
    getBattery?: () => Promise<{ level: number; charging: boolean }>;
    connection?: { effectiveType?: string; downlink?: number };
  };

  if (typeof nav.getBattery === 'function') {
    try {
      const bat = await nav.getBattery();
      telemetry.batteryLevel = Math.round(bat.level * 100);
      telemetry.batteryCharging = bat.charging;
    } catch {
      // Battery API restricted
    }
  }

  if (nav.connection) {
    telemetry.networkType = nav.connection.effectiveType;
    telemetry.downlinkMbps = nav.connection.downlink;
  }

  if (includeGeo && 'geolocation' in navigator) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000 });
      });
      telemetry.latitude = Number(pos.coords.latitude.toFixed(4));
      telemetry.longitude = Number(pos.coords.longitude.toFixed(4));
    } catch {
      // Permission denied or unavailable
    }
  }

  return telemetry;
}

export function playChime(kind: 'alert' | 'timer' = 'alert'): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = kind === 'timer' ? [523.25, 659.25, 783.99, 1046.5] : [587.33, 880];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);
      gain.gain.setValueAtTime(0.001, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.38);
    });
  } catch {
    // Audio playback blocked before user gesture
  }
}

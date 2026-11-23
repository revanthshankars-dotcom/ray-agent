/**
 * One-click PC bridge installers: a single downloaded file that installs Node.js if needed,
 * fetches this room's bridge, and starts it as a background service that runs on boot.
 *   Windows: ray-connect.cmd  (double-click)
 *   macOS:   ray-connect.command (right-click → Open the first time)
 *   Linux:   ray-connect.sh  (bash ray-connect.sh)
 */
const NODE_VERSION = '22.12.0';

export function buildInstaller(os: 'win' | 'mac' | 'linux', bridgeUrl: string, roomId: string): { filename: string; body: string; type: string } {
  if (os === 'win') {
    const body = [
      '@echo off',
      'title RAY - connecting this PC',
      'echo.',
      'echo  RAY: connecting this PC to room ' + roomId + ' ...',
      'echo.',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo  Installing Node.js (one time, ~1 minute^)...',
      '  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements',
      '  set "PATH=%PATH%;%ProgramFiles%\\nodejs"',
      ')',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo  Could not install Node.js automatically. Install it from https://nodejs.org then run this file again.',
      '  start https://nodejs.org',
      '  pause',
      '  exit /b 1',
      ')',
      'set "RAYDIR=%APPDATA%\\RAY-Bridge-Setup"',
      'if not exist "%RAYDIR%" mkdir "%RAYDIR%"',
      'cd /d "%RAYDIR%"',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '${bridgeUrl}' -OutFile 'relay-bridge.mjs'"`,
      'call npm install --no-audit --no-fund --silent ws',
      'node relay-bridge.mjs',
      'echo.',
      'echo  Done! RAY is connected and will start automatically with Windows.',
      'echo  You can close this window.',
      'timeout /t 15',
      '',
    ].join('\r\n');
    return { filename: 'ray-connect.cmd', body, type: 'application/octet-stream' };
  }

  const sh = [
    '#!/usr/bin/env bash',
    'set -e',
    `echo "RAY: connecting this computer to room ${roomId} ..."`,
    'RAYDIR="$HOME/.ray-bridge/setup"; mkdir -p "$RAYDIR"; cd "$RAYDIR"',
    'if ! command -v node >/dev/null 2>&1; then',
    '  if command -v brew >/dev/null 2>&1; then brew install node; else',
    `    ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; arm64|aarch64) A=arm64;; *) A=$ARCH;; esac`,
    `    OS=$( [ "$(uname)" = "Darwin" ] && echo darwin || echo linux )`,
    `    echo "Installing Node.js ${NODE_VERSION} for $OS-$A (one time)..."`,
    `    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-$OS-$A.tar.gz" | tar -xz -C "$HOME/.ray-bridge"`,
    `    export PATH="$HOME/.ray-bridge/node-v${NODE_VERSION}-$OS-$A/bin:$PATH"`,
    '  fi',
    'fi',
    `curl -fsSL "${bridgeUrl}" -o relay-bridge.mjs`,
    'npm install --no-audit --no-fund --silent ws',
    'node relay-bridge.mjs',
    'echo "Done! RAY is connected and starts automatically when you log in."',
    '',
  ].join('\n');
  return os === 'mac'
    ? { filename: 'ray-connect.command', body: sh, type: 'application/octet-stream' }
    : { filename: 'ray-connect.sh', body: sh, type: 'application/x-sh' };
}

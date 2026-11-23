import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import http from 'http';
import { execSync } from 'child_process';
import path from 'path';
import { WebSocketServer } from 'ws';
import {
  CAPABILITIES_CATALOG,
  executeProtocol,
} from './server/capabilities.ts';
import {
  deleteRoomBrainNote,
  deleteRoomConnector,
  dispatchBridgeProxyCall,
  dispatchDeviceCommand,
  generateBridgeScript,
  getOrIssueRoomBootstrap,
  getRoomBrainNotes,
  getRoomConnectors,
  getRoomSnapshot,
  handleSocketConnection,
  getIncomingMessages,
  getPushSubscriptions,
  getRoomDevices,
  hasStableRoomSecret,
  listRoomIds,
  hydrateRoomsFromStorage,
  markMessagesRead,
  onIncomingMessage,
  recordIncomingMessage,
  savePushSubscription,
  isRoomScreenControlArmed,
  normalizeRoomId,
  setRoomInterrupted,
  setRoomScreenControlArmed,
  upsertRoomBrainNote,
  upsertRoomConnector,
  verifyRoomToken,
} from './server/hub.ts';
import {
  analyzeTaskGoal,
  buildJarvisSystemInstruction,
  createRoutinePlanFromGoal,
  executeDeviceTool,
  findSemanticBrainMatches,
  synthesizeSpeech,
  getOllamaToolDeclarations,
  resolvePendingConfirmation,
  runAssistantChatTurn,
  summarizeUrlWithGemini,
  transcribeAudioClip,
} from './server/gemini.ts';
import {
  analyzeTaskGoalWithGroq,
  fetchGroqModels,
  hasGroqConfigured,
  runGroqChatTurn,
} from './server/groq.ts';
import {
  analyzeTaskGoalWithHf,
  fetchHfModels,
  hasHfConfigured,
  runHfChatTurn,
} from './server/huggingface.ts';
import {
  analyzeTaskGoalWithOllama,
  fetchOllamaModels,
  runOllamaChatTurn,
} from './server/ollama.ts';
import {
  analyzeTaskGoalWithOpenRouter,
  fetchOpenRouterModels,
  hasOpenRouterConfigured,
  runOpenRouterChatTurn,
} from './server/openrouter.ts';
import { handleLiveJarvisSocket } from './server/liveBridge.ts';
import {
  assertSafeExternalUrl,
  createRateLimiter,
  sanitizeCustomHeaders,
  sanitizeErrorMessage,
  validateScreenControlAction,
} from './server/security.ts';
import { executeAppConnectorAction, executeGoogleWorkspaceAction } from './server/workspace.ts';
import { getEngineAssignments, runAutoChatTurn } from './server/engines/router.ts';
import { dailyBudget, getEngineStatus, getKeySources, loadUsage, normalizeProviderEnv } from './server/engines/providers.ts';
import { installShutdownFlush, persistenceBackend } from './server/persistence.ts';
import { getVapidPublicKey, initWakeServices, sendPush } from './server/wake.ts';
import { zipDirectory } from './server/zip.ts';
import { buildInstaller } from './server/installer.ts';
import { getIceServers, listScheduledCalls, cancelScheduledCall, startCallScheduler } from './server/calls.ts';
import { checkFishKey, fishUsable, getFishKey, getFishStatus } from './server/fishAudio.ts';
import { checkMetaSignature, handleMetaWebhook, metaStatus, verifyMetaWebhook } from './server/meta.ts';
import type { AppConnector, BrainNote, VoicePersona } from './src/types/relay.ts';

function extractRoomToken(req: Request): string {
  const headerToken = req.headers['x-relay-room-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  const qToken = req.query.token;
  if (typeof qToken === 'string' && qToken.trim()) return qToken.trim();
  return '';
}

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const gHeader = req.headers['x-google-access-token'];
  return typeof gHeader === 'string' ? gHeader.trim() : '';
}

function extractNotionToken(req: Request): string {
  const h = req.headers['x-notion-token'];
  return typeof h === 'string' ? h.trim() : '';
}

/** 503 when no bridge is online / it timed out (temporary), 400 for real request errors (#14). */
function bridgeErrorStatus(err?: string): number {
  return /no online|not open|timed out|unreachable|bridge/i.test(err || '') ? 503 : 400;
}

/** Strip API keys / tokens users paste into chat so they never reach an AI provider or storage (#23). */
const SECRET_PATTERNS: RegExp[] = [
  /\boc_sk_[A-Za-z0-9_-]{16,}/g, // OpenCode Zen
  /\bcfut_[A-Za-z0-9]{20,}/g, // Cloudflare user token
  /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / OpenRouter / Anthropic
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bcsk-[A-Za-z0-9]{20,}/g, // Cerebras
  /\b[0-9a-f]{48}\b/g, // RAY room tokens
];
function redactSecrets(text: string): { text: string; found: boolean } {
  let found = false;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      found = true;
      return '[REDACTED-SECRET]';
    });
  }
  return { text: out, found };
}

function requireRoomAuth(req: Request, res: Response, next: NextFunction): void {
  const rawRoom =
    (req.body && typeof req.body === 'object' ? (req.body as { roomId?: string }).roomId : undefined) ||
    req.params.roomId ||
    (req.query.room as string | undefined) ||
    'RLY-HOME';
  const roomId = normalizeRoomId(rawRoom);
  const token = extractRoomToken(req);
  if (!verifyRoomToken(roomId, token)) {
    res.status(401).json({ error: 'Unauthorized: valid X-Relay-Room-Token required for this room.' });
    return;
  }
  next();
}

const SERVER_BUILD_ID = (() => {
  const env = process.env.RENDER_GIT_COMMIT || process.env.RAY_BUILD_ID || '';
  if (env) return env.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

async function startServer() {
  const remapped = normalizeProviderEnv();
  if (remapped.length) console.log('[RAY] Engine keys found under other names:', remapped.join(', '));
  installShutdownFlush();
  const hydrated = await hydrateRoomsFromStorage().catch((err) => {
    console.warn('[RAY] Could not hydrate rooms from storage:', err);
    return 0;
  });
  const wake = await initWakeServices();
  startCallScheduler();
  if (getFishKey()) setInterval(() => void checkFishKey(), 6 * 3600_000).unref();
  if (getFishKey()) {
    const fish = await checkFishKey();
    console.log(
      `[RAY] Fish Audio key: ${fish.valid === true ? 'VALID' : fish.valid === false ? 'INVALID (rejected)' : 'could not verify'}` +
        ` usable=${fishUsable()} status=${fish.status ?? 'n/a'}${fish.credit !== undefined ? ` credit=${fish.credit}` : ''}${fish.error ? ` error=${fish.error.slice(0, 120)}` : ''}`
    );
  }
  console.log(
    `[RAY] storage=${persistenceBackend()} roomsRestored=${hydrated} push=${wake.pushReady} stableTokens=${hasStableRoomSecret()}`
  );
  if (!hasStableRoomSecret()) {
    console.warn(
      '[RAY] RELAY_MASTER_SECRET is not set. Room tokens are stored on local disk; on Cloud Run they reset on every restart and bridges must re-pair. Set RELAY_MASTER_SECRET (any long random string) to make pairing permanent.'
    );
  }

  const app = express();
  const server = http.createServer(app);
  const wssMesh = new WebSocketServer({ noServer: true });
  const wssLive = new WebSocketServer({ noServer: true });

  app.use(
    express.json({
      limit: '18mb',
      verify: (req, _res, buf) => {
        if ((req as Request).url?.startsWith('/api/meta/webhook')) (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );

  // Incoming WhatsApp/Instagram message -> wake & alert devices that are offline (online ones get a live event).
  onIncomingMessage((roomId, msg) => {
    const subs = getPushSubscriptions(roomId);
    const offline = getRoomDevices(roomId).filter((d) => !d.online && subs[d.id]);
    for (const d of offline) {
      void sendPush(subs[d.id], {
        title: `${msg.app[0].toUpperCase()}${msg.app.slice(1)} · ${msg.from}`,
        body: msg.text.slice(0, 180),
        url: '/?view=assistant',
        tag: `ray-msg-${msg.app}`,
      });
    }
  });

  const aiLimiter = createRateLimiter({ windowMs: 60_000, max: 45 });
  const deviceLimiter = createRateLimiter({ windowMs: 60_000, max: 90 });

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const roomId = normalizeRoomId(reqUrl.searchParams.get('room') || 'RLY-HOME');
    const token = reqUrl.searchParams.get('token') || '';

    if (reqUrl.pathname === '/ws') {
      if (!verifyRoomToken(roomId, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wssMesh.handleUpgrade(req, socket, head, (ws) => {
        handleSocketConnection(ws, roomId);
      });
    } else if (reqUrl.pathname === '/live-jarvis') {
      if (!verifyRoomToken(roomId, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wssLive.handleUpgrade(req, socket, head, (ws) => {
        const deviceName = (reqUrl.searchParams.get('device') || 'Web Console').slice(0, 80);
        const voiceRaw = reqUrl.searchParams.get('voice') || 'Fenrir';
        const validVoices: VoicePersona[] = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
        const voiceName: VoicePersona = validVoices.includes(voiceRaw as VoicePersona)
          ? (voiceRaw as VoicePersona)
          : 'Fenrir';
        void handleLiveJarvisSocket(ws, { roomId, deviceName, voiceName });
      });
    } else {
      socket.destroy();
    }
  });

  app.get('/api/health', async (_req, res) => {
    await loadUsage();
    const engines = getEngineStatus();
    const devicesOnline = listRoomIds().reduce((n, r) => n + getRoomDevices(r).filter((d) => d.online).length, 0);
    const bridgesOnline = listRoomIds().reduce((n, r) => n + getRoomDevices(r).filter((d) => d.online && d.type === 'bridge').length, 0);
    res.json({
      ok: true,
      buildId: SERVER_BUILD_ID,
      uptimeSec: Math.round(process.uptime()),
      enginesConfigured: engines.filter((e) => e.configured).map((e) => e.id),
      engineErrors: Object.fromEntries(engines.filter((e) => e.lastError).map((e) => [e.id, `${e.lastError!.status} ${e.lastError!.message}`])),
      enginesAvailable: engines.filter((e) => e.available).length,
      budget: dailyBudget(),
      devicesOnline,
      bridgesOnline,
      googleOAuthClient: Boolean(process.env.GOOGLE_CLIENT_ID),
      fishAudio: getFishStatus(),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasOpenRouterKey: hasOpenRouterConfigured(),
      storage: persistenceBackend(),
      stableTokens: hasStableRoomSecret(),
      pushReady: Boolean(getVapidPublicKey()),
    });
  });

  app.get('/api/engines/status', requireRoomAuth, async (_req, res) => {
    await loadUsage();
    res.json({
      engines: getEngineStatus(),
      budget: dailyBudget(),
      assignments: await getEngineAssignments(),
      keySources: getKeySources(),
    });
  });

  // Meta (WhatsApp Cloud API / Instagram Messaging) webhook
  app.get('/api/meta/webhook', (req, res) => {
    const challenge = verifyMetaWebhook(req.query as Record<string, unknown>);
    if (challenge === null) {
      res.sendStatus(403);
      return;
    }
    res.status(200).send(challenge);
  });

  app.post('/api/meta/webhook', async (req, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!checkMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200); // ack fast, Meta retries otherwise
    try {
      await handleMetaWebhook(req.body);
    } catch (err) {
      console.warn('[RAY meta] webhook processing failed:', sanitizeErrorMessage(err));
    }
  });

  app.get('/api/messages', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    res.json({ messages: getIncomingMessages(roomId, { limit: 100 }), meta: metaStatus() });
  });

  app.post('/api/messages/read', requireRoomAuth, (req, res) => {
    const { roomId, ids } = req.body as { roomId: string; ids?: string[] };
    res.json({ updated: markMessagesRead(normalizeRoomId(roomId), ids) });
  });

  // Manual/test injection (e.g. iOS Shortcuts automation forwarding a notification).
  app.post('/api/messages/incoming', deviceLimiter, requireRoomAuth, (req, res) => {
    const { roomId, app: chatApp, from, text } = req.body as { roomId: string; app: string; from: string; text: string };
    const saved = recordIncomingMessage(normalizeRoomId(roomId), {
      app: String(chatApp || 'unknown'),
      from: String(from || 'Unknown'),
      text: String(text || ''),
      receivedAt: Date.now(),
      viaDevice: 'API',
    });
    res.json({ ok: Boolean(saved), message: saved });
  });

  app.get('/api/extension/ray-tabs.zip', (_req, res) => {
    try {
      // manifest.json at the zip root: Windows "Extract All" → folder you can pick directly in Load unpacked.
      const buf = zipDirectory(path.resolve(process.cwd(), 'extension', 'ray-tabs'), '');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="ray-tabs-extension.zip"');
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Extension package unavailable') });
    }
  });

  app.get('/api/call/ice', requireRoomAuth, async (_req, res) => {
    res.json({ iceServers: await getIceServers() });
  });

  app.get('/api/calls/scheduled', requireRoomAuth, async (req, res) => {
    res.json({ calls: await listScheduledCalls(normalizeRoomId(String(req.query.room || 'RLY-HOME'))) });
  });

  app.post('/api/calls/scheduled/cancel', requireRoomAuth, async (req, res) => {
    const { roomId, id } = req.body as { roomId: string; id: string };
    res.json({ cancelled: await cancelScheduledCall(normalizeRoomId(roomId), String(id || '')) });
  });

  app.get('/api/voice/capabilities', (_req, res) => {
    res.json({ live: Boolean(process.env.GEMINI_API_KEY), serverTts: Boolean(process.env.GEMINI_API_KEY || fishUsable()), fishAudio: getFishStatus() });
  });

  app.get('/api/push/vapid', (_req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  app.post('/api/push/subscribe', deviceLimiter, requireRoomAuth, (req, res) => {
    const { roomId, deviceId, subscription } = req.body as { roomId: string; deviceId: string; subscription: unknown };
    if (!deviceId || !subscription || typeof subscription !== 'object') {
      res.status(400).json({ error: 'deviceId and subscription are required.' });
      return;
    }
    savePushSubscription(normalizeRoomId(roomId), String(deviceId).slice(0, 120), subscription);
    res.json({ ok: true });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json({ capabilities: CAPABILITIES_CATALOG });
  });

  app.get('/api/room/:roomId/bootstrap', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const provided = extractRoomToken(req);
    const boot = getOrIssueRoomBootstrap(roomId, provided);
    if (!boot.authorized) {
      res.status(403).json({ authorized: false, error: boot.error });
      return;
    }
    res.json(boot);
  });

  app.get('/api/room/:roomId', requireRoomAuth, (req, res) => {
    const snapshot = getRoomSnapshot(req.params.roomId);
    res.json(snapshot);
  });

  app.get('/api/bridge-script', (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const provided = extractRoomToken(req);
    const boot = getOrIssueRoomBootstrap(roomId, provided);
    if (!boot.authorized || !boot.roomToken) {
      res.status(401).json({ error: boot.error || 'Valid room token required to download Bridge script.' });
      return;
    }
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const wsUrl = `${proto}://${host}/ws`;
    const script = generateBridgeScript(wsUrl, roomId, boot.roomToken);
    const filename = `relay-bridge-${roomId.toLowerCase()}.mjs`;
    if (req.query.format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ filename, script });
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(script);
  });

  // One-click PC connection: a double-clickable installer for this room (Windows/macOS/Linux).
  app.get('/api/bridge-installer', (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const boot = getOrIssueRoomBootstrap(roomId, extractRoomToken(req));
    if (!boot.authorized || !boot.roomToken) {
      res.status(401).json({ error: boot.error || 'Valid room token required.' });
      return;
    }
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0];
    const bridgeUrl = `${proto}://${host}/api/bridge-script?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(boot.roomToken)}`;
    const osParam = String(req.query.os || 'win');
    const os = osParam === 'mac' ? 'mac' : osParam === 'linux' ? 'linux' : 'win';
    const out = buildInstaller(os, bridgeUrl, roomId);
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.body);
  });

  app.post('/api/protocols/run', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, protocolName, confirmed } = req.body as {
        roomId: string;
        protocolName: string;
        confirmed?: boolean;
      };
      const result = await executeProtocol(normalizeRoomId(roomId), protocolName || 'house_party', Boolean(confirmed));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Protocol execution failed') });
    }
  });

  app.post('/api/confirmations/resolve', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, confirmationId, approved, sourceDeviceName, preferredVoice, customConnectors } = req.body as {
        roomId: string;
        confirmationId: string;
        approved: boolean;
        sourceDeviceName?: string;
        preferredVoice?: VoicePersona;
        customConnectors?: AppConnector[];
      };
      const out = await resolvePendingConfirmation(
        normalizeRoomId(roomId),
        confirmationId,
        Boolean(approved),
        sourceDeviceName || 'Web Console',
        preferredVoice || 'Fenrir',
        {
          googleAccessToken: extractBearerToken(req),
          notionToken: extractNotionToken(req),
          customConnectors,
        }
      );
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Confirmation resolution failed') });
    }
  });

  app.post('/api/jarvis/interrupt', requireRoomAuth, (req, res) => {
    const { roomId } = req.body as { roomId?: string };
    const normalized = normalizeRoomId(roomId);
    setRoomInterrupted(normalized, true);
    res.json({ ok: true, roomId: normalized, interrupted: true, screenControlArmed: false });
  });

  app.post('/api/screen/arm', deviceLimiter, requireRoomAuth, (req, res) => {
    const { roomId, armed } = req.body as { roomId: string; armed: boolean };
    const normalized = normalizeRoomId(roomId);
    setRoomScreenControlArmed(normalized, Boolean(armed));
    res.json({ ok: true, roomId: normalized, screenControlArmed: isRoomScreenControlArmed(normalized) });
  });

  app.post('/api/screen/capture', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId } = req.body as { roomId: string };
      const out = await dispatchBridgeProxyCall(normalizeRoomId(roomId), { action: 'screen_capture' }, 12000);
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'Screen capture failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Screen capture failed') });
    }
  });

  app.post('/api/screen/control', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, action, payload } = req.body as {
        roomId: string;
        action: string;
        payload?: Record<string, unknown>;
      };
      const normalized = normalizeRoomId(roomId);
      if (!isRoomScreenControlArmed(normalized)) {
        res.status(403).json({ error: 'Screen control is disarmed. Toggle Screen Control Armed in the HUD first.' });
        return;
      }
      const validation = validateScreenControlAction(action, payload || {});
      if (!validation.ok) {
        res.status(400).json({ error: validation.reason });
        return;
      }
      const out = await dispatchBridgeProxyCall(
        normalized,
        { action: 'screen_control', payload: validation.sanitized },
        8000
      );
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'Screen control execution failed' });
        return;
      }
      res.json({ ok: true, result: out.data });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Screen control failed') });
    }
  });

  app.post('/api/system/window', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId } = req.body as { roomId: string };
      const out = await dispatchBridgeProxyCall(normalizeRoomId(roomId), { action: 'active_window' }, 6000);
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'Active window inspection failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Active window inspection failed') });
    }
  });

  app.post('/api/files/roots', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId } = req.body as { roomId: string };
      const out = await dispatchBridgeProxyCall(normalizeRoomId(roomId), { action: 'fs_list_roots' }, 6000);
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'Desktop OS Bridge unreachable' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Failed to read filesystem roots') });
    }
  });

  app.post('/api/files/list', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, dirPath, limit } = req.body as { roomId: string; dirPath?: string; limit?: number };
      const out = await dispatchBridgeProxyCall(
        normalizeRoomId(roomId),
        { action: 'fs_list_dir', dirPath: dirPath || '', limit: limit || 150 },
        7000
      );
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'Directory listing failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Directory listing failed') });
    }
  });

  app.post('/api/files/read', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, filePath, startLine, endLine } = req.body as {
        roomId: string;
        filePath: string;
        startLine?: number;
        endLine?: number;
      };
      const out = await dispatchBridgeProxyCall(
        normalizeRoomId(roomId),
        { action: 'fs_read_file', filePath, startLine, endLine },
        7000
      );
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'File read failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'File read failed') });
    }
  });

  app.post('/api/files/search', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, query, dirPath } = req.body as { roomId: string; query: string; dirPath?: string };
      const out = await dispatchBridgeProxyCall(
        normalizeRoomId(roomId),
        { action: 'fs_search_files', query, dirPath },
        10000
      );
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'File search failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'File search failed') });
    }
  });

  app.post('/api/files/write', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, filePath, content, confirmed } = req.body as {
        roomId: string;
        filePath: string;
        content: string;
        confirmed?: boolean;
      };
      if (!confirmed) {
        res.status(403).json({ error: 'Explicit user confirmation required to write local files.' });
        return;
      }
      const out = await dispatchBridgeProxyCall(
        normalizeRoomId(roomId),
        { action: 'fs_write_file', filePath, content },
        7000
      );
      if (!out.ok) {
        res.status(bridgeErrorStatus(out.error)).json({ error: out.error || 'File write failed' });
        return;
      }
      res.json(out.data);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'File write failed') });
    }
  });

  app.post('/api/device/command', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, type, targetDevice, payload } = req.body as {
        roomId: string;
        type: 'notify' | 'speak' | 'clipboard' | 'open_url' | 'set_timer' | 'request_snapshot' | 'refresh_telemetry' | 'bridge_command';
        targetDevice: string;
        payload: Record<string, unknown>;
      };

      const enrichedPayload = { ...payload };
      if (type === 'open_url' && typeof payload?.url === 'string') {
        assertSafeExternalUrl(payload.url, { allowDeepLinks: true });
      }
      if (type === 'speak' && typeof payload?.text === 'string' && !payload.audioBase64) {
        try {
          const sp = await synthesizeSpeech(payload.text, (payload.voiceName as VoicePersona) || 'Fenrir');
          enrichedPayload.audioBase64 = sp.audioBase64;
          enrichedPayload.audioMime = sp.mimeType;
        } catch {
          // Text fallback
        }
      }

      const result = await dispatchDeviceCommand({
        roomId: normalizeRoomId(roomId),
        type,
        targetQuery: targetDevice || 'all',
        source: 'user',
        payload: enrichedPayload,
        waitForAckMs: 2500,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Failed to dispatch device command') });
    }
  });

  app.get('/api/ollama/tags', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
      const ollamaUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
      const useBridgeProxy = req.query.bridge === 'true';
      const out = await fetchOllamaModels({ roomId, ollamaUrl, useBridgeProxy });
      res.json(out);
    } catch (err) {
      res.status(400).json({ ok: false, models: [], error: sanitizeErrorMessage(err) });
    }
  });

  app.get('/api/openrouter/models', aiLimiter, requireRoomAuth, async (_req, res) => {
    try {
      const out = await fetchOpenRouterModels();
      res.json(out);
    } catch (err) {
      res.status(400).json({ ok: false, hasKey: hasOpenRouterConfigured(), models: [], error: sanitizeErrorMessage(err) });
    }
  });

  app.get('/api/groq/models', aiLimiter, requireRoomAuth, async (_req, res) => {
    try {
      const out = await fetchGroqModels();
      res.json(out);
    } catch (err) {
      res.status(400).json({ ok: false, hasKey: hasGroqConfigured(), models: [], error: sanitizeErrorMessage(err) });
    }
  });

  app.get('/api/huggingface/models', aiLimiter, requireRoomAuth, async (_req, res) => {
    try {
      const out = await fetchHfModels();
      res.json(out);
    } catch (err) {
      res.status(400).json({ ok: false, hasKey: hasHfConfigured(), models: [], error: sanitizeErrorMessage(err) });
    }
  });

  app.get('/api/brain/notes', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    res.json({ notes: getRoomBrainNotes(roomId) });
  });

  app.post('/api/brain/notes', requireRoomAuth, (req, res) => {
    try {
      const { roomId, note } = req.body as {
        roomId: string;
        note: Partial<BrainNote> & { title: string; content: string };
      };
      if (!note?.title?.trim()) {
        res.status(400).json({ error: 'Note title is required.' });
        return;
      }
      const saved = upsertRoomBrainNote(normalizeRoomId(roomId), note);
      res.json({ note: saved });
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Failed to save note') });
    }
  });

  app.delete('/api/brain/notes/:noteId', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const deleted = deleteRoomBrainNote(roomId, req.params.noteId);
    res.json({ ok: deleted });
  });

  app.post('/api/brain/sync-local', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, direction } = req.body as { roomId: string; direction?: 'pull' | 'push' };
      const normalized = normalizeRoomId(roomId);
      if (direction === 'push') {
        const notes = getRoomBrainNotes(normalized);
        let pushed = 0;
        for (const n of notes.slice(0, 40)) {
          const r = await dispatchBridgeProxyCall(
            normalized,
            { action: 'vault_write', path: `${n.folder || 'Notes'}/${n.slug}.md`, content: n.content },
            5000
          );
          if (r.ok) pushed++;
        }
        res.json({ ok: true, pushed });
        return;
      }

      const pullRes = await dispatchBridgeProxyCall(normalized, { action: 'vault_list' }, 10000);
      if (!pullRes.ok) {
        res.status(400).json({ error: pullRes.error || 'Failed to read local Obsidian folder' });
        return;
      }
      const payload = pullRes.data as { vaultDir?: string; notes?: Array<{ path: string; content: string }> };
      const imported: BrainNote[] = [];
      for (const item of payload.notes || []) {
        const parts = item.path.split('/');
        const filename = parts.pop() || 'Untitled.md';
        const folder = parts.join('/') || 'Obsidian';
        const title = filename.replace(/\.md$/i, '');
        imported.push(
          upsertRoomBrainNote(normalized, {
            title,
            folder,
            content: item.content,
            source: 'obsidian_local',
          })
        );
      }
      res.json({ ok: true, vaultDir: payload.vaultDir, importedCount: imported.length, notes: imported });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Obsidian vault sync failed') });
    }
  });

  app.post('/api/brain/semantic-search', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, query, notes } = req.body as {
        roomId: string;
        query: string;
        notes?: Array<{ id: string; title: string; folder: string; content: string; tags?: string[] }>;
      };
      const cleanQuery = (query || '').trim();
      if (!cleanQuery) {
        res.status(400).json({ error: 'Search query is required.' });
        return;
      }
      const normalized = normalizeRoomId(roomId);
      const sourceNotes = Array.isArray(notes) && notes.length > 0 ? notes : getRoomBrainNotes(normalized);
      const matches = await findSemanticBrainMatches(cleanQuery, sourceNotes);
      res.json({ ok: true, matches });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Semantic search failed') });
    }
  });

  app.post('/api/ai/read-url', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, url, question, saveToBrain } = req.body as {
        roomId: string;
        url: string;
        question?: string;
        saveToBrain?: boolean;
      };
      if (!url?.trim()) {
        res.status(400).json({ error: 'Web URL is required.' });
        return;
      }
      const result = await summarizeUrlWithGemini(url.trim(), question);
      let savedNote: BrainNote | undefined;
      if (saveToBrain) {
        savedNote = upsertRoomBrainNote(normalizeRoomId(roomId), {
          title: result.title,
          folder: 'Web Captures',
          content: `# ${result.title}\n\nSource: ${result.url}\nCaptured into [[RAY Second Brain]]\n\n${result.summary}\n\n#web #capture`,
          source: 'jarvis',
        });
      }
      res.json({ ok: true, ...result, savedNote });
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Failed to read URL') });
    }
  });

  app.get('/api/connectors', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    res.json({ connectors: getRoomConnectors(roomId) });
  });

  app.post('/api/connectors', requireRoomAuth, (req, res) => {
    try {
      const { roomId, connector } = req.body as { roomId: string; connector: AppConnector };
      if (!connector?.name?.trim() || !connector?.endpointOrTarget?.trim()) {
        res.status(400).json({ error: 'Connector name and endpoint/target are required.' });
        return;
      }
      if (connector.connectorType === 'webhook') {
        assertSafeExternalUrl(connector.endpointOrTarget, { allowLocalhost: false });
        sanitizeCustomHeaders(connector.headersJson);
      } else if (connector.connectorType === 'url_template') {
        const sample = connector.endpointOrTarget.replace(/\{\{(query|text|phone)\}\}/gi, 'test');
        assertSafeExternalUrl(sample, { allowDeepLinks: true });
      }
      const saved = upsertRoomConnector(normalizeRoomId(roomId), connector);
      res.json({ connector: saved });
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Invalid connector configuration') });
    }
  });

  app.delete('/api/connectors/:connectorId', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const deleted = deleteRoomConnector(roomId, req.params.connectorId);
    res.json({ ok: deleted });
  });

  app.post('/api/connectors/test', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, connector, args, confirmed } = req.body as {
        roomId: string;
        connector: AppConnector;
        args?: Record<string, unknown>;
        confirmed?: boolean;
      };
      const out = await executeAppConnectorAction({
        roomId: normalizeRoomId(roomId),
        connector,
        args: args || {},
        notionToken: extractNotionToken(req),
        confirmed: Boolean(confirmed),
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Connector test failed') });
    }
  });

  app.post('/api/workspace/execute', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, action, args, confirmed } = req.body as {
        roomId: string;
        action: string;
        args?: Record<string, unknown>;
        confirmed?: boolean;
      };
      const out = await executeGoogleWorkspaceAction({
        roomId: normalizeRoomId(roomId),
        action,
        args: args || {},
        googleAccessToken: extractBearerToken(req),
        confirmed: Boolean(confirmed),
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage(err, 'Google Workspace action failed') });
    }
  });

  app.post('/api/ai/chat', aiLimiter, requireRoomAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (event: { type: string; data: unknown }) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      // eslint-disable-next-line prefer-const
      let {
        roomId,
        sourceDeviceName,
        targetDeviceHint,
        message,
        history,
        attachments,
        deepThinking,
        enableSearch,
        groundingMode,
        userLocation,
        preferredVoice,
        engine,
        customConnectors,
      } = req.body as {
        roomId: string;
        sourceDeviceName?: string;
        targetDeviceHint?: string;
        message: string;
        history?: Array<{ role: 'user' | 'assistant'; text: string }>;
        attachments?: Array<{ mimeType: string; dataBase64: string }>;
        deepThinking?: boolean;
        enableSearch?: boolean;
        groundingMode?: 'auto' | 'search' | 'maps' | 'url';
        userLocation?: { latitude: number; longitude: number };
        preferredVoice?: VoicePersona;
        engine?: {
          provider?: 'auto' | 'gemini' | 'openrouter' | 'ollama' | 'groq' | 'anthropic' | 'openai' | 'huggingface' | 'opencode' | 'cerebras' | 'mistral';
          routerMode?: string;
          ollamaUrl?: string;
          ollamaModel?: string;
          openrouterModel?: string;
          groqModel?: string;
          hfModel?: string;
          useBridgeProxy?: boolean;
        };
        customConnectors?: AppConnector[];
      };

      const normalizedRoom = normalizeRoomId(roomId);
      const googleAccessToken = extractBearerToken(req);
      const notionToken = extractNotionToken(req);

      const redacted = redactSecrets(message || '');
      if (redacted.found) {
        message = redacted.text;
        sendEvent({
          type: 'engine',
          data: { phase: 'security', reason: 'A secret key was removed from your message before it reached any AI. Rotate that key and add it as a server environment variable instead.' },
        });
      }
      history = (history || []).map((h) => ({ ...h, text: redactSecrets(h.text || '').text }));

      const toolExecutor = (toolName: string, toolArgs: Record<string, unknown>) =>
        executeDeviceTool(normalizedRoom, sourceDeviceName || 'Web Client', toolName, toolArgs, preferredVoice || 'Fenrir', {
          googleAccessToken,
          notionToken,
          customConnectors,
          userCommand: message || '',
        });

      const runGeminiNative = () =>
        runAssistantChatTurn({
          roomId: normalizedRoom,
          sourceDeviceName: sourceDeviceName || 'Web Client',
          targetDeviceHint,
          message: message || '',
          history: history || [],
          attachments: attachments || [],
          deepThinking: Boolean(deepThinking),
          enableSearch: enableSearch !== false,
          groundingMode: groundingMode || 'auto',
          userLocation,
          preferredVoice: preferredVoice || 'Fenrir',
          googleAccessToken,
          notionToken,
          customConnectors,
          onEvent: sendEvent,
        });

      // Explicit Groq / OpenRouter / Hugging Face / OpenCode choices go through the router pinned to
      // that provider: same output caps, 30s timeouts and automatic fallback instead of raw 429s.
      const pinnable = ['groq', 'openrouter', 'huggingface', 'opencode', 'cerebras', 'mistral', 'deepseek', 'zhipu', 'siliconflow', 'dashscope', 'novita'];
      const routerMode =
        engine?.provider && pinnable.includes(engine.provider) ? engine.provider : engine?.routerMode || 'auto';
      if (!engine?.provider || engine.provider === 'auto' || pinnable.includes(engine.provider)) {
        const sysPrompt = buildJarvisSystemInstruction(normalizedRoom, sourceDeviceName || 'Web Client', targetDeviceHint, false, {
          hasGoogleToken: Boolean(googleAccessToken),
          customConnectors,
        });
        let routed: { handled: boolean; needsGeminiNative?: boolean } = { handled: false };
        try {
          routed = await runAutoChatTurn({
            roomId: normalizedRoom,
            message: message || '',
            history: history || [],
            attachments: attachments || [],
            systemInstruction: sysPrompt,
            tools: getOllamaToolDeclarations(),
            executeTool: toolExecutor,
            onEvent: sendEvent,
            mode: routerMode,
            pinnedModel:
              routerMode === 'groq'
                ? engine?.groqModel
                : routerMode === 'openrouter' && engine?.openrouterModel !== 'openrouter/free'
                ? engine?.openrouterModel
                : routerMode === 'huggingface'
                ? engine?.hfModel
                : undefined,
            deepThinking: Boolean(deepThinking),
          });
        } catch (routerErr) {
          sendEvent({ type: 'engine', data: { phase: 'router-failed', reason: sanitizeErrorMessage(routerErr) } });
        }
        if (!routed.handled) {
          if (process.env.GEMINI_API_KEY) {
            await runGeminiNative();
          } else {
            // Last resort: the user's own local Ollama through the desktop bridge.
            const ollama = await fetchOllamaModels({ roomId: normalizedRoom, useBridgeProxy: true }).catch(() => null);
            if (ollama?.ok && ollama.models.length > 0) {
              sendEvent({ type: 'engine', data: { provider: 'Local Ollama', model: ollama.models[0], reason: 'cloud engines unavailable' } });
              await runOllamaChatTurn({
                roomId: normalizedRoom,
                sourceDeviceName: sourceDeviceName || 'Web Client',
                targetDeviceHint,
                message: message || '',
                history: history || [],
                attachments: attachments || [],
                ollamaModel: ollama.models[0],
                useBridgeProxy: true,
                systemInstruction: sysPrompt,
                ollamaTools: getOllamaToolDeclarations(),
                executeTool: toolExecutor,
                onEvent: sendEvent,
              });
            } else {
              sendEvent({
                type: 'error',
                data: 'No AI engine is reachable. Add a free key (GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY…) or start Ollama on a PC running the RAY bridge.',
              });
            }
          }
        }
      } else if (engine?.provider === 'openrouter') {
        const sysPrompt = buildJarvisSystemInstruction(
          normalizedRoom,
          sourceDeviceName || 'Web Client',
          targetDeviceHint,
          false,
          {
            hasGoogleToken: Boolean(googleAccessToken),
            customConnectors,
          }
        );
        await runOpenRouterChatTurn({
          roomId: normalizedRoom,
          sourceDeviceName: sourceDeviceName || 'Web Client',
          targetDeviceHint,
          message: message || '',
          history: history || [],
          attachments: attachments || [],
          openrouterModel: engine.openrouterModel && engine.openrouterModel !== 'openrouter/free' ? engine.openrouterModel : 'nvidia/nemotron-3.5-lightning:free',
          systemInstruction: sysPrompt,
          tools: getOllamaToolDeclarations(),
          executeTool: toolExecutor,
          onEvent: sendEvent,
        });
      } else if (engine?.provider === 'groq') {
        const sysPrompt = buildJarvisSystemInstruction(
          normalizedRoom,
          sourceDeviceName || 'Web Client',
          targetDeviceHint,
          false,
          {
            hasGoogleToken: Boolean(googleAccessToken),
            customConnectors,
          }
        );
        await runGroqChatTurn({
          roomId: normalizedRoom,
          sourceDeviceName: sourceDeviceName || 'Web Client',
          targetDeviceHint,
          message: message || '',
          history: history || [],
          attachments: attachments || [],
          groqModel: engine.groqModel || 'openai/gpt-oss-120b',
          systemInstruction: sysPrompt,
          tools: getOllamaToolDeclarations(),
          executeTool: toolExecutor,
          onEvent: sendEvent,
        });
      } else if (engine?.provider === 'huggingface') {
        const sysPrompt = buildJarvisSystemInstruction(
          normalizedRoom,
          sourceDeviceName || 'Web Client',
          targetDeviceHint,
          false,
          {
            hasGoogleToken: Boolean(googleAccessToken),
            customConnectors,
          }
        );
        await runHfChatTurn({
          roomId: normalizedRoom,
          sourceDeviceName: sourceDeviceName || 'Web Client',
          targetDeviceHint,
          message: message || '',
          history: history || [],
          hfModel: engine.hfModel || 'meta-llama/Meta-Llama-3-8B-Instruct',
          systemInstruction: sysPrompt,
          onEvent: sendEvent,
        });
      } else if (engine?.provider === 'ollama') {
        const sysPrompt = buildJarvisSystemInstruction(
          normalizedRoom,
          sourceDeviceName || 'Web Client',
          targetDeviceHint,
          false,
          {
            hasGoogleToken: Boolean(googleAccessToken),
            customConnectors,
          }
        );
        await runOllamaChatTurn({
          roomId: normalizedRoom,
          sourceDeviceName: sourceDeviceName || 'Web Client',
          targetDeviceHint,
          message: message || '',
          history: history || [],
          attachments: attachments || [],
          ollamaUrl: engine.ollamaUrl,
          ollamaModel: engine.ollamaModel || 'llama3.2',
          useBridgeProxy: Boolean(engine.useBridgeProxy),
          autoBridgeFallback: true,
          systemInstruction: sysPrompt,
          ollamaTools: getOllamaToolDeclarations(),
          executeTool: toolExecutor,
          onEvent: sendEvent,
        });
      } else {
        await runGeminiNative();
      }
    } catch (err) {
      sendEvent({ type: 'error', data: sanitizeErrorMessage(err, 'AI engine request failed') });
    } finally {
      res.end();
    }
  });

  app.post('/api/ai/analyze-task', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, goal, task, engine } = req.body as {
        roomId: string;
        goal?: string;
        task?: string;
        engine?: {
          provider?: 'gemini' | 'openrouter' | 'ollama' | 'groq' | 'anthropic' | 'openai' | 'huggingface';
          ollamaUrl?: string;
          ollamaModel?: string;
          openrouterModel?: string;
          groqModel?: string;
          hfModel?: string;
          useBridgeProxy?: boolean;
        };
      };
      const cleanGoal = (goal || task || '').trim();
      if (!cleanGoal) {
        res.status(400).json({ error: 'Task goal is required for analysis.' });
        return;
      }
      const normalized = normalizeRoomId(roomId);
      const analysis =
        engine?.provider === 'openrouter'
          ? await analyzeTaskGoalWithOpenRouter({
              roomId: normalized,
              goal: cleanGoal,
              openrouterModel: engine.openrouterModel && engine.openrouterModel !== 'openrouter/free' ? engine.openrouterModel : 'nvidia/nemotron-3.5-lightning:free',
            })
          : engine?.provider === 'groq'
          ? await analyzeTaskGoalWithGroq({
              roomId: normalized,
              goal: cleanGoal,
              groqModel: engine.groqModel || 'openai/gpt-oss-120b',
            })
          : engine?.provider === 'huggingface'
          ? await analyzeTaskGoalWithHf({
              roomId: normalized,
              goal: cleanGoal,
              hfModel: engine.hfModel || 'meta-llama/Meta-Llama-3-8B-Instruct',
            })
          : engine?.provider === 'ollama'
          ? await analyzeTaskGoalWithOllama({
              roomId: normalized,
              goal: cleanGoal,
              ollamaUrl: engine.ollamaUrl,
              ollamaModel: engine.ollamaModel || 'llama3.2',
              useBridgeProxy: Boolean(engine.useBridgeProxy),
            })
          : await analyzeTaskGoal(normalized, cleanGoal);
      res.json({ analysis, ...analysis });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Task analysis failed') });
    }
  });

  app.post('/api/ai/transcribe', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { audioBase64, mimeType } = req.body as { audioBase64: string; mimeType: string };
      if (!audioBase64) {
        res.status(400).json({ error: 'Missing audioBase64 payload' });
        return;
      }
      const transcript = await transcribeAudioClip(audioBase64, mimeType || 'audio/webm');
      res.json({ transcript });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Audio transcription failed') });
    }
  });

  app.post('/api/ai/tts', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { text, voiceName, style } = req.body as { text: string; voiceName?: VoicePersona; style?: string };
      if (!text?.trim()) {
        res.status(400).json({ error: 'Missing text for TTS' });
        return;
      }
      const sp = await synthesizeSpeech(text, voiceName || 'Fenrir', style);
      res.json({ audioBase64: sp.audioBase64, mimeType: sp.mimeType, engine: sp.engine });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Speech generation failed') });
    }
  });

  app.post('/api/ai/plan-routine', aiLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, goal } = req.body as { roomId: string; goal: string };
      if (!goal?.trim()) {
        res.status(400).json({ error: 'Routine goal is required' });
        return;
      }
      const plan = await createRoutinePlanFromGoal(normalizeRoomId(roomId), goal);
      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Failed to plan routine') });
    }
  });

  app.post('/api/routines/run', deviceLimiter, requireRoomAuth, async (req, res) => {
    try {
      const { roomId, sourceDeviceName, steps, customConnectors } = req.body as {
        roomId: string;
        sourceDeviceName?: string;
        steps: Array<{ toolName: string; targetDevice: string; args: Record<string, unknown> }>;
        customConnectors?: AppConnector[];
      };
      const results: string[] = [];
      for (const step of steps || []) {
        const mergedArgs = { ...(step.args || {}), targetDevice: step.args?.targetDevice || step.targetDevice || 'all' };
        const resOut = await executeDeviceTool(
          normalizeRoomId(roomId),
          sourceDeviceName || 'Routine Runner',
          step.toolName,
          mergedArgs,
          'Fenrir',
          {
            confirmed: true,
            googleAccessToken: extractBearerToken(req),
            notionToken: extractNotionToken(req),
            customConnectors,
          }
        );
        results.push(`${step.toolName}: ${resOut.result}`);
      }
      res.json({ ok: true, results });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err, 'Routine execution failed') });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Render's free plan sleeps after ~15 min without traffic: ping our own public URL every
  // 10 min so "Hey Ray" never hits a cold start (#26). Disable with RAY_KEEPALIVE=false.
  const publicUrl = (process.env.RENDER_EXTERNAL_URL || process.env.RAY_PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl && !/^(0|false|off)$/i.test(process.env.RAY_KEEPALIVE || '')) {
    setInterval(() => {
      fetch(`${publicUrl}/api/health`, { signal: AbortSignal.timeout(15000) }).catch(() => {});
    }, 10 * 60_000).unref();
    console.log(`[RAY] keep-alive pinging ${publicUrl}/api/health every 10 min`);
  }

  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`J.A.R.V.I.S. Relay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start J.A.R.V.I.S. Relay server:', err);
  process.exit(1);
});

import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import http from 'http';
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
  generateSpeechAudio,
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

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wssMesh = new WebSocketServer({ noServer: true });
  const wssLive = new WebSocketServer({ noServer: true });

  app.use(express.json({ limit: '18mb' }));

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

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasOpenRouterKey: hasOpenRouterConfigured(),
    });
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
        res.status(400).json({ error: out.error || 'Screen capture failed' });
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
        res.status(400).json({ error: out.error || 'Screen control execution failed' });
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
        res.status(400).json({ error: out.error || 'Active window inspection failed' });
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
        res.status(400).json({ error: out.error || 'Desktop OS Bridge unreachable' });
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
        res.status(400).json({ error: out.error || 'Directory listing failed' });
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
        res.status(400).json({ error: out.error || 'File read failed' });
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
        res.status(400).json({ error: out.error || 'File search failed' });
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
        res.status(400).json({ error: out.error || 'File write failed' });
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
          enrichedPayload.audioBase64 = await generateSpeechAudio(
            payload.text,
            (payload.voiceName as VoicePersona) || 'Fenrir'
          );
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
      const {
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
          provider?: 'gemini' | 'openrouter' | 'ollama' | 'groq' | 'anthropic' | 'openai' | 'huggingface';
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

      if (engine?.provider === 'openrouter') {
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
          openrouterModel: engine.openrouterModel || 'openrouter/free',
          systemInstruction: sysPrompt,
          tools: getOllamaToolDeclarations(),
          executeTool: (toolName, toolArgs) =>
            executeDeviceTool(
              normalizedRoom,
              sourceDeviceName || 'Web Client',
              toolName,
              toolArgs,
              preferredVoice || 'Fenrir',
              {
                googleAccessToken,
                notionToken,
                customConnectors,
              }
            ),
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
          groqModel: engine.groqModel || 'llama-3.3-70b-versatile',
          systemInstruction: sysPrompt,
          tools: getOllamaToolDeclarations(),
          executeTool: (toolName, toolArgs) =>
            executeDeviceTool(
              normalizedRoom,
              sourceDeviceName || 'Web Client',
              toolName,
              toolArgs,
              preferredVoice || 'Fenrir',
              {
                googleAccessToken,
                notionToken,
                customConnectors,
              }
            ),
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
          systemInstruction: sysPrompt,
          ollamaTools: getOllamaToolDeclarations(),
          executeTool: (toolName, toolArgs) =>
            executeDeviceTool(normalizedRoom, sourceDeviceName || 'Web Client', toolName, toolArgs, preferredVoice || 'Fenrir', {
              googleAccessToken,
              notionToken,
              customConnectors,
            }),
          onEvent: sendEvent,
        });
      } else {
        await runAssistantChatTurn({
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
              openrouterModel: engine.openrouterModel || 'openrouter/free',
            })
          : engine?.provider === 'groq'
          ? await analyzeTaskGoalWithGroq({
              roomId: normalized,
              goal: cleanGoal,
              groqModel: engine.groqModel || 'llama-3.3-70b-versatile',
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
      const audioBase64 = await generateSpeechAudio(text, voiceName || 'Fenrir', style);
      res.json({ audioBase64, mimeType: 'audio/wav' });
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

  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`J.A.R.V.I.S. Relay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start J.A.R.V.I.S. Relay server:', err);
  process.exit(1);
});

import type { AppConnector, ConfirmationRequest } from '../src/types/relay.ts';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, dispatchDeviceCommand } from './hub.ts';
import { assertSafeExternalUrl, sanitizeCustomHeaders, sanitizeErrorMessage } from './security.ts';

const MUTATING_WORKSPACE_ACTIONS = new Set([
  'gmail_send_email',
  'calendar_create_event',
  'calendar_delete_event',
  'drive_create_doc',
  'sheets_append_row',
  'tasks_create_task',
  'tasks_complete_task',
]);

async function googleFetch(
  url: string,
  accessToken: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const errMsg =
      (parsed.error as { message?: string } | undefined)?.message ||
      `Google API error HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed;
}

export async function executeGoogleWorkspaceAction(params: {
  roomId: string;
  action: string;
  args: Record<string, unknown>;
  googleAccessToken?: string;
  confirmed?: boolean;
}): Promise<{ result: string; confirmation?: ConfirmationRequest }> {
  const action = (params.action || '').trim().toLowerCase();
  const token = (params.googleAccessToken || '').trim();

  if (!token) {
    return {
      result:
        'Google Workspace is not authorized yet for this session. Ask Ray to click "Connect Google Workspace" in the Apps tab or top bar to grant in-memory OAuth access.',
    };
  }

  if (MUTATING_WORKSPACE_ACTIONS.has(action) && !params.confirmed) {
    const summaryMap: Record<string, string> = {
      gmail_send_email: `Send email via Gmail to "${String(params.args.to || '')}" with subject "${String(params.args.subject || '')}".`,
      calendar_create_event: `Create Google Calendar event "${String(params.args.summary || 'New Event')}" starting ${String(params.args.start || '')}.`,
      calendar_delete_event: `Delete Google Calendar event ID "${String(params.args.eventId || '')}".`,
      drive_create_doc: `Create Google Doc "${String(params.args.title || 'Untitled Document')}" in Google Drive.`,
      sheets_append_row: `Append row to Google Sheet "${String(params.args.spreadsheetId || '')}" range "${String(params.args.range || 'Sheet1!A1')}".`,
      tasks_create_task: `Create Google Task "${String(params.args.title || '')}".`,
      tasks_complete_task: `Mark Google Task "${String(params.args.taskId || '')}" as completed.`,
    };
    const req = createConfirmationRequest({
      roomId: params.roomId,
      toolName: 'google_workspace_action',
      safetyLevel: action === 'gmail_send_email' || action === 'calendar_delete_event' ? 'sensitive' : 'moderate',
      summary: summaryMap[action] || `Execute mutating Google Workspace action "${action}".`,
      targetDevice: 'Google Workspace',
      args: { action, ...params.args },
    });
    broadcastHudSound(params.roomId, 'alert');
    return {
      result: `REQUIRES_CONFIRMATION: ${req.summary} (confirmationId=${req.id})`,
      confirmation: req,
    };
  }

  switch (action) {
    case 'gmail_list_messages': {
      const q = encodeURIComponent(String(params.args.query || 'in:inbox'));
      const maxResults = Math.max(1, Math.min(15, Number(params.args.maxResults || 8)));
      const list = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`,
        token
      );
      const msgs = (list.messages as Array<{ id: string }> | undefined) || [];
      const summaries = await Promise.all(
        msgs.slice(0, 8).map(async (m) => {
          const detail = await googleFetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            token
          );
          const headers = ((detail.payload as { headers?: Array<{ name: string; value: string }> } | undefined)?.headers || []);
          const getH = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value || '';
          return {
            id: m.id,
            subject: getH('subject'),
            from: getH('from'),
            date: getH('date'),
            snippet: detail.snippet,
          };
        })
      );
      return { result: JSON.stringify({ count: summaries.length, messages: summaries }) };
    }

    case 'gmail_read_message': {
      const id = encodeURIComponent(String(params.args.messageId || ''));
      const detail = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        token
      );
      return { result: JSON.stringify({ id: detail.id, snippet: detail.snippet, payload: detail.payload }).slice(0, 4000) };
    }

    case 'gmail_send_email': {
      const to = String(params.args.to || '').replace(/[\r\n]/g, '').trim();
      const subject = String(params.args.subject || '').replace(/[\r\n]/g, '').trim();
      const bodyText = String(params.args.body || '');
      if (!to || !subject) throw new Error('Recipient "to" and "subject" are required.');
      const rawMime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${bodyText}`;
      const encoded = Buffer.from(rawMime, 'utf8').toString('base64url');
      const sent = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, {
        method: 'POST',
        body: JSON.stringify({ raw: encoded }),
      });
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Email sent via Gmail to ${to} (messageId=${String(sent.id || 'ok')}).` };
    }

    case 'calendar_list_events': {
      const timeMin = encodeURIComponent(String(params.args.timeMin || new Date().toISOString()));
      const maxResults = Math.max(1, Math.min(20, Number(params.args.maxResults || 10)));
      const data = await googleFetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
        token
      );
      const items = ((data.items as Array<Record<string, unknown>>) || []).map((ev) => ({
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        location: ev.location,
        htmlLink: ev.htmlLink,
      }));
      return { result: JSON.stringify({ count: items.length, events: items }) };
    }

    case 'calendar_create_event': {
      const summary = String(params.args.summary || 'RAY Scheduled Event').slice(0, 200);
      const start = String(params.args.start || new Date(Date.now() + 3600_000).toISOString());
      const end = String(params.args.end || new Date(new Date(start).getTime() + 3600_000).toISOString());
      const created = await googleFetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            summary,
            description: String(params.args.description || '').slice(0, 1000),
            start: { dateTime: start },
            end: { dateTime: end },
          }),
        }
      );
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Created Calendar event "${summary}" (${String(created.htmlLink || created.id || '')}).` };
    }

    case 'calendar_delete_event': {
      const eventId = encodeURIComponent(String(params.args.eventId || ''));
      if (!eventId) throw new Error('eventId is required.');
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Deleted Calendar event ${eventId}.` };
    }

    case 'drive_search_files': {
      const queryText = String(params.args.query || '').replace(/'/g, '');
      const qParam = queryText
        ? `trashed = false and name contains '${queryText}'`
        : 'trashed = false';
      const data = await googleFetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParam)}&pageSize=12&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
        token
      );
      return { result: JSON.stringify(data.files || []) };
    }

    case 'drive_read_doc': {
      const docId = encodeURIComponent(String(params.args.documentId || params.args.fileId || ''));
      if (!docId) throw new Error('documentId is required.');
      const doc = await googleFetch(`https://docs.googleapis.com/v1/documents/${docId}`, token);
      return { result: JSON.stringify({ title: doc.title, documentId: doc.documentId, body: doc.body }).slice(0, 4500) };
    }

    case 'drive_create_doc': {
      const title = String(params.args.title || 'RAY Note').slice(0, 180);
      const created = await googleFetch('https://docs.googleapis.com/v1/documents', token, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      const documentId = String(created.documentId || '');
      const content = String(params.args.content || '');
      if (documentId && content) {
        await googleFetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, token, {
          method: 'POST',
          body: JSON.stringify({
            requests: [{ insertText: { location: { index: 1 }, text: content } }],
          }),
        });
      }
      broadcastHudSound(params.roomId, 'affirmative');
      return {
        result: `Created Google Doc "${title}" (https://docs.google.com/document/d/${documentId}/edit).`,
      };
    }

    case 'sheets_read_range': {
      const spreadsheetId = encodeURIComponent(String(params.args.spreadsheetId || ''));
      const range = encodeURIComponent(String(params.args.range || 'Sheet1!A1:Z30'));
      if (!spreadsheetId) throw new Error('spreadsheetId is required.');
      const data = await googleFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
        token
      );
      return { result: JSON.stringify(data) };
    }

    case 'sheets_append_row': {
      const spreadsheetId = encodeURIComponent(String(params.args.spreadsheetId || ''));
      const range = encodeURIComponent(String(params.args.range || 'Sheet1!A1'));
      const values = Array.isArray(params.args.values) ? params.args.values : [String(params.args.values || '')];
      if (!spreadsheetId) throw new Error('spreadsheetId is required.');
      const res = await googleFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ values: [values] }),
        }
      );
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Appended row to Google Sheet ${spreadsheetId}: ${JSON.stringify(res.updates || {})}` };
    }

    case 'tasks_list_tasks': {
      const data = await googleFetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?maxResults=25', token);
      const items = ((data.items as Array<Record<string, unknown>>) || []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due: t.due,
        notes: t.notes,
      }));
      return { result: JSON.stringify(items) };
    }

    case 'tasks_create_task': {
      const title = String(params.args.title || 'New Task').slice(0, 200);
      const created = await googleFetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', token, {
        method: 'POST',
        body: JSON.stringify({
          title,
          notes: String(params.args.notes || ''),
        }),
      });
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Created Google Task "${String(created.title || title)}".` };
    }

    case 'tasks_complete_task': {
      const taskId = encodeURIComponent(String(params.args.taskId || ''));
      if (!taskId) throw new Error('taskId is required.');
      await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ id: params.args.taskId, status: 'completed' }),
      });
      broadcastHudSound(params.roomId, 'affirmative');
      return { result: `Completed Google Task ${taskId}.` };
    }

    case 'contacts_search': {
      const q = encodeURIComponent(String(params.args.query || ''));
      const data = await googleFetch(
        `https://people.googleapis.com/v1/people:searchContacts?query=${q}&readMask=names,emailAddresses,phoneNumbers`,
        token
      );
      return { result: JSON.stringify(data.results || []) };
    }

    default:
      throw new Error(`Unsupported Google Workspace action "${action}".`);
  }
}

export async function executeAppConnectorAction(params: {
  roomId: string;
  connector: AppConnector;
  args: Record<string, unknown>;
  notionToken?: string;
  confirmed?: boolean;
}): Promise<{ result: string; confirmation?: ConfirmationRequest }> {
  const { connector } = params;
  if (!connector.enabled) {
    return { result: `Connector "${connector.name}" is currently disabled in Apps settings.` };
  }

  if (connector.requiresConfirmation && !params.confirmed) {
    const req = createConfirmationRequest({
      roomId: params.roomId,
      toolName: 'invoke_app_connector',
      safetyLevel: 'moderate',
      summary: `Invoke external app connector "${connector.name}" (${connector.connectorType}) -> ${connector.endpointOrTarget}`,
      targetDevice: connector.name,
      args: { connectorId: connector.id, ...params.args },
    });
    broadcastHudSound(params.roomId, 'alert');
    return {
      result: `REQUIRES_CONFIRMATION: Waiting for Ray's approval to run connector "${connector.name}" (confirmationId=${req.id}).`,
      confirmation: req,
    };
  }

  try {
    if (connector.connectorType === 'bridge_app') {
      const target = connector.endpointOrTarget;
      if (/^(https?|whatsapp|notion|obsidian|vscode|spotify):/i.test(target)) {
        const safe = assertSafeExternalUrl(target, { allowDeepLinks: true }).toString();
        const { summary } = await dispatchDeviceCommand({
          roomId: params.roomId,
          type: 'open_url',
          targetQuery: String(params.args.targetDevice || 'all'),
          source: 'assistant',
          payload: { url: safe, title: connector.name },
          waitForAckMs: 2200,
        });
        return { result: `${connector.name}: ${summary}` };
      }
      const { summary } = await dispatchDeviceCommand({
        roomId: params.roomId,
        type: 'bridge_command',
        targetQuery: String(params.args.targetDevice || 'bridge'),
        source: 'assistant',
        payload: { action: 'open_application', target },
        waitForAckMs: 2500,
      });
      return { result: `${connector.name}: ${summary}` };
    }

    if (connector.connectorType === 'url_template') {
      const queryVal = encodeURIComponent(String(params.args.query || params.args.text || ''));
      const phoneVal = String(params.args.phone || '').replace(/[^0-9]/g, '');
      const hydrated = connector.endpointOrTarget
        .replace(/\{\{query\}\}/gi, queryVal)
        .replace(/\{\{text\}\}/gi, queryVal)
        .replace(/\{\{phone\}\}/gi, phoneVal);
      const safe = assertSafeExternalUrl(hydrated, { allowDeepLinks: true }).toString();
      const { summary } = await dispatchDeviceCommand({
        roomId: params.roomId,
        type: 'open_url',
        targetQuery: String(params.args.targetDevice || 'all'),
        source: 'assistant',
        payload: { url: safe, title: connector.name },
        waitForAckMs: 2200,
      });
      return { result: `Launched ${connector.name}: ${safe} (${summary})` };
    }

    if (connector.connectorType === 'notion') {
      const token = (params.notionToken || '').trim();
      if (!token) {
        return {
          result:
            'Notion Internal Integration token is missing. Ask Ray to enter his free Notion token in the Apps tab (stored in session memory).',
        };
      }
      const q = String(params.args.query || '');
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: q, page_size: 10 }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(String(json.message || `Notion API HTTP ${res.status}`));
      }
      return { result: JSON.stringify(json.results || []).slice(0, 4000) };
    }

    // webhook / REST
    const parsedUrl = assertSafeExternalUrl(connector.endpointOrTarget, { allowLocalhost: false });
    const safeHeaders = sanitizeCustomHeaders(connector.headersJson);
    const method = connector.method === 'LAUNCH' ? 'POST' : connector.method || 'POST';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(parsedUrl.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...safeHeaders,
      },
      body: method === 'GET' ? undefined : JSON.stringify(params.args.payload || params.args || { message: 'Triggered by RAY.' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return { result: `${connector.name} responded HTTP ${resp.status}: ${text.slice(0, 500) || 'OK'}` };
  } catch (err) {
    return { result: `Connector "${connector.name}" failed: ${sanitizeErrorMessage(err)}` };
  }
}

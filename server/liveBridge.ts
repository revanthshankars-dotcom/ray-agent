import {
  FunctionResponseScheduling,
  InteractionStatus,
  Modality,
  ThinkingLevel,
  type LiveServerMessage,
} from '@google/genai';
import { WebSocket } from 'ws';
import {
  buildJarvisSystemInstruction,
  executeDeviceTool,
  getAiClient,
  liveToolDeclarations,
} from './gemini.ts';
import { broadcastHudSound, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { sanitizeErrorMessage } from './security.ts';
import type { VoicePersona } from '../src/types/relay.ts';

export async function handleLiveJarvisSocket(
  clientWs: WebSocket,
  params: {
    roomId: string;
    deviceName: string;
    voiceName: VoicePersona;
  }
): Promise<void> {
  let ai: ReturnType<typeof getAiClient>;
  try {
    ai = getAiClient();
  } catch {
    clientWs.send(JSON.stringify({ type: 'error', code: 'LIVE_UNAVAILABLE', message: 'Gemini Live needs GEMINI_API_KEY; using the free voice pipeline instead.' }));
    clientWs.close();
    return;
  }
  let closed = false;
  let sessionGoogleToken = '';
  let sessionNotionToken = '';
  // Rolling transcript of what Ray actually said — tools that change things need his command.
  let recentUserSpeech = '';
  setRoomInterrupted(params.roomId, false);

  const sendJson = (payload: Record<string, unknown>) => {
    if (!closed && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  // Live model names change often: try the configured one, then known fallbacks.
  const liveModels = Array.from(
    new Set(
      [
        process.env.GEMINI_LIVE_MODEL,
        'gemini-3.8-live-extended-thinking',
        'gemini-live-2.5-flash-preview',
        'gemini-2.5-flash-native-audio-preview-09-2025',
        'gemini-2.0-flash-live-001',
      ].filter((m): m is string => Boolean(m && m.trim()))
    )
  );
  let lastConnectError: unknown = null;

  for (const liveModel of liveModels) {
  try {
    session = await ai.live.connect({
      model: liveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        ...(/thinking/.test(liveModel) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } } : {}),
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: params.voiceName || 'Fenrir',
            },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: liveToolDeclarations }],
        systemInstruction: buildJarvisSystemInstruction(
          params.roomId,
          params.deviceName,
          undefined,
          true
        ),
      },
      callbacks: {
        onopen: () => {
          sendJson({ type: 'connected', roomId: params.roomId });
        },
        onmessage: (message: LiveServerMessage) => {
          const content = message.serverContent;

          if (content?.inputTranscription?.text) {
            const text = content.inputTranscription.text;
            recentUserSpeech = `${recentUserSpeech} ${text}`.slice(-600);
            sendJson({ type: 'inputTranscript', text });
            if (/\b(jarvis\s*,?\s*stop|stop\s*,?\s*jarvis|abort|stand down)\b/i.test(text)) {
              setRoomInterrupted(params.roomId, true);
              broadcastHudSound(params.roomId, 'blip');
              sendJson({ type: 'interrupted', interrupted: true, reason: 'Voice stop phrase detected' });
            }
          }

          if (content?.outputTranscription?.text) {
            sendJson({ type: 'outputTranscript', text: content.outputTranscription.text });
          }

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              sendJson({ type: 'audio', data: part.inlineData.data });
            }
          }

          if (content?.interrupted) {
            sendJson({ type: 'interrupted', interrupted: true });
          }

          const status = content?.interactionStatus;
          if (status === InteractionStatus.IN_PROGRESS) {
            sendJson({ type: 'status', status: 'in_progress' });
          } else if (status === InteractionStatus.IDLE) {
            sendJson({ type: 'status', status: 'idle' });
          }

          const functionCalls = message.toolCall?.functionCalls ?? [];
          for (const call of functionCalls) {
            void (async () => {
              if (isRoomInterrupted(params.roomId)) {
                session?.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name ?? '',
                      response: { result: 'Aborted by emergency stop command.' },
                      scheduling: FunctionResponseScheduling.SILENT,
                    },
                  ],
                });
                return;
              }

              const args = (call.args as Record<string, unknown>) ?? {};
              sendJson({
                type: 'tool',
                status: 'running',
                name: call.name,
                args,
              });

              try {
                const execOut = await executeDeviceTool(
                  params.roomId,
                  params.deviceName,
                  call.name ?? '',
                  args,
                  params.voiceName,
                  {
                    googleAccessToken: sessionGoogleToken || undefined,
                    notionToken: sessionNotionToken || undefined,
                    userCommand: recentUserSpeech,
                  }
                );

                if (execOut.confirmation) {
                  sendJson({
                    type: 'confirmation_required',
                    data: execOut.confirmation,
                  });
                }

                sendJson({
                  type: 'tool',
                  status: execOut.confirmation ? 'awaiting_confirmation' : 'completed',
                  name: call.name,
                  result: execOut.result,
                });

                session?.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name ?? '',
                      response: { result: execOut.result },
                      scheduling: FunctionResponseScheduling.WHEN_IDLE,
                    },
                  ],
                });
              } catch (err) {
                const errText = sanitizeErrorMessage(err);
                sendJson({
                  type: 'tool',
                  status: 'error',
                  name: call.name,
                  result: errText,
                });
                session?.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name ?? '',
                      response: { error: errText },
                      scheduling: FunctionResponseScheduling.WHEN_IDLE,
                    },
                  ],
                });
              }
            })();
          }
        },
        onerror: (err) => {
          sendJson({
            type: 'error',
            message: sanitizeErrorMessage(err, 'Gemini Live session error'),
          });
        },
        onclose: () => {
          if (!closed) {
            sendJson({ type: 'closed' });
            clientWs.close();
          }
        },
      },
    });
    break;
  } catch (err) {
    lastConnectError = err;
    session = null;
  }
  }

  if (!session) {
    sendJson({
      type: 'error',
      code: 'LIVE_UNAVAILABLE',
      message: sanitizeErrorMessage(lastConnectError, 'Failed to connect Gemini Live voice session'),
    });
    clientWs.close();
    return;
  }

  clientWs.on('message', (raw) => {
    if (!session || closed) return;
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        data?: string;
        text?: string;
        googleAccessToken?: string;
        notionToken?: string;
      };
      if (msg.type === 'context') {
        if (typeof msg.googleAccessToken === 'string') {
          sessionGoogleToken = msg.googleAccessToken.slice(0, 4096);
        }
        if (typeof msg.notionToken === 'string') {
          sessionNotionToken = msg.notionToken.slice(0, 512);
        }
      } else if (msg.type === 'audio' && msg.data) {
        session.sendRealtimeInput({
          audio: {
            data: msg.data,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } else if (msg.type === 'text' && msg.text) {
        setRoomInterrupted(params.roomId, false);
        recentUserSpeech = `${recentUserSpeech} ${msg.text}`.slice(-600);
        session.sendRealtimeInput({
          text: msg.text,
        });
      } else if (msg.type === 'interrupt') {
        setRoomInterrupted(params.roomId, true);
        sendJson({ type: 'interrupted', interrupted: true });
      }
    } catch {
      // Ignore malformed client audio frame
    }
  });

  clientWs.on('close', () => {
    closed = true;
    sessionGoogleToken = '';
    sessionNotionToken = '';
    try {
      session?.close();
    } catch {
      // Ignore close error
    }
  });
}

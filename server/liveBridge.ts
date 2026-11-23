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
  const ai = getAiClient();
  let closed = false;
  let sessionGoogleToken = '';
  let sessionNotionToken = '';
  setRoomInterrupted(params.roomId, false);

  const sendJson = (payload: Record<string, unknown>) => {
    if (!closed && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  try {
    session = await ai.live.connect({
      model: 'gemini-3.8-live-extended-thinking',
      config: {
        responseModalities: [Modality.AUDIO],
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.HIGH,
        },
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
  } catch (err) {
    sendJson({
      type: 'error',
      message: sanitizeErrorMessage(err, 'Failed to connect Gemini Live voice session'),
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

/**
 * WHATSAPP / INSTAGRAM CALLS — "video call Priya on WhatsApp", "call Arun on Instagram".
 *
 * Instagram: RAY's browser on the PC (Ray is logged in there) opens the DM and presses the audio /
 * video call button; the call runs in that window with the PC's mic and camera.
 * WhatsApp: the number comes from the linked WhatsApp, the phone's contacts, or Ray's words. RAY
 * opens the chat in WhatsApp on the phone (or WhatsApp Desktop on the PC) and, when Screen Control is
 * available, presses the call button itself; otherwise it leaves the chat open and says to tap call.
 * (WhatsApp offers no free way to place calls from a server — the linked device can only message.)
 * Always asks Ray once before calling anyone.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, dispatchBridgeProxyCall, dispatchDeviceCommand, getRoomDevices, isRoomScreenControlArmed } from './hub.ts';
import { browserBridge, executeBrowserTool } from './browserAgent.ts';
import { instagramTarget } from './instagramWeb.ts';
import { executeComputerUseTool } from './computerUse.ts';
import { whatsappNumberFor } from './whatsappLink.ts';
import { rememberContact, resolveContact } from './contactFinder.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

export const socialCallToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'social_call',
    description:
      'Start a WhatsApp or Instagram voice/video call to someone ("video call Priya on WhatsApp", "call Arun on Instagram"). app: whatsapp | instagram. to: contact name, @username or phone number. video: true for video. device: phone | pc | auto (WhatsApp prefers the phone; Instagram runs in RAY’s browser on the PC). Asks Ray once before calling.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        app: { type: Type.STRING },
        to: { type: Type.STRING },
        video: { type: Type.BOOLEAN },
        device: { type: Type.STRING },
      },
      required: ['app', 'to'],
    },
  },
];

const online = (roomId: string) => getRoomDevices(roomId).filter((d) => d.online && d.type === 'bridge');
const phoneBridge = (roomId: string) => online(roomId).find((d) => /android/i.test(d.os || ''));
const pcBridge = (roomId: string) => online(roomId).find((d) => !/android/i.test(d.os || ''));

async function resolveWhatsAppNumber(roomId: string, to: string): Promise<{ digits: string; name: string } | { error: string }> {
  // Remembered people, the linked WhatsApp's contacts and the phone's contacts, fuzzy — asks Ray if two fit.
  const r = await resolveContact(roomId, to, 'whatsapp', { ask: true, why: `WhatsApp call to "${to}"` });
  if (r.status === 'found' && r.hit.digits) return { digits: r.hit.digits, name: r.hit.name };
  const fromWa = whatsappNumberFor(roomId, to);
  if (fromWa) return fromWa;
  if (r.status === 'ambiguous') return { error: `${r.note}. Tell me which one (or answer the question RAY sent you).` };
  if (r.status === 'found') return { error: `${r.hit.name} has no phone number RAY can see (WhatsApp hides it). Say the number once and I'll remember it.` };
  return { error: `I couldn't find "${to}" in your WhatsApp or phone contacts${phoneBridge(roomId) ? '' : ' (the phone bridge is offline, so phone contacts weren’t searched)'}. Say the full name as saved, or the number once — I'll remember it.` };
}

export async function executeSocialCallTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name !== 'social_call') return null;
  const app = /insta|ig/i.test(String(args.app || '')) ? 'instagram' : 'whatsapp';
  const to = String(args.to || '').trim().replace(/^@/, '');
  const video = args.video === true || /^(true|yes|1)$/i.test(String(args.video || ''));
  if (!to) return { result: 'Who should I call?' };
  const kind = video ? 'video' : 'voice';

  if (app === 'instagram') {
    if (!browserBridge(roomId)) return { result: 'Instagram calls run in RAY’s browser on your PC, and the PC bridge is offline.' };
    if (!opts.confirmed) {
      const req = createConfirmationRequest({ roomId, toolName: name, safetyLevel: 'sensitive', summary: `Start an Instagram ${kind} call with ${to} (in RAY’s browser on your PC).`, targetDevice: 'RAY’s browser on the PC', args: { ...args, app: 'instagram' } });
      broadcastHudSound(roomId, 'alert');
      return { result: `REQUIRES_CONFIRMATION: Instagram ${kind} call to ${to} — waiting for Ray (confirmationId=${req.id}).`, confirmation: req };
    }
    const who = await instagramTarget(roomId, to);
    if ('error' in who) return { result: who.error };
    const goal = `${who.open} Then click the ${video ? 'video call (camera icon)' : 'audio call (phone icon)'} button at the top of the conversation. When the call window opens and starts ringing, stop and report that it is ringing. If Instagram asks for camera/microphone permission, report that Ray must click Allow in the browser window once. If a login page appears, report that Ray needs to log into Instagram once in RAY’s browser.`;
    return executeBrowserTool(roomId, 'browse_web', { goal, mode: 'do', startUrl: who.startUrl, useLogin: true }, opts);
  }

  // WhatsApp
  // After approval the resolved number is in args, so Ray isn't asked twice.
  const target = args.__digits ? { digits: String(args.__digits), name: String(args.__name || to) } : await resolveWhatsAppNumber(roomId, to);
  if ('error' in target) return { result: target.error };
  const pref = String(args.device || 'auto').toLowerCase();
  const phone = phoneBridge(roomId);
  const pc = pcBridge(roomId);
  const usePhone = pref === 'phone' || (pref !== 'pc' && Boolean(phone));
  const device = usePhone ? phone : pc;
  if (!device) return { result: `No ${usePhone ? 'phone' : 'PC'} bridge is online to place the WhatsApp call. Turn it on, or link WhatsApp and I can message ${target.name} instead.` };

  if (!opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: name,
      safetyLevel: 'sensitive',
      summary: `Start a WhatsApp ${kind} call with ${target.name} (+${target.digits}) from your ${usePhone ? 'phone' : 'PC'}.`,
      targetDevice: device.name,
      args: { ...args, app: 'whatsapp', device: usePhone ? 'phone' : 'pc', __digits: target.digits, __name: target.name },
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: WhatsApp ${kind} call to ${target.name} — waiting for Ray (confirmationId=${req.id}).`, confirmation: req };
  }

  if (!/^\+?[\d\s()-]+$/.test(to)) void rememberContact(roomId, to, { name: target.name, digits: target.digits });
  // 1) open the chat in the WhatsApp app
  // whatsapp:// opens the WhatsApp app straight on the chat (no "continue to chat" web page).
  await dispatchDeviceCommand({ roomId, type: 'open_url', targetQuery: device.id, source: 'assistant', payload: { url: `whatsapp://send?phone=${target.digits}`, title: `WhatsApp · ${target.name}` }, waitForAckMs: 6000 });

  // 2) press the call button with Screen Control (PC screen, or the phone through ADB from the PC)
  const canTap = Boolean(pc) && isRoomScreenControlArmed(roomId);
  if (canTap) {
    await new Promise((r) => setTimeout(r, 3500));
    const tap = await executeComputerUseTool(
      roomId,
      'operate_computer',
      {
        task: `WhatsApp is open on the chat with ${target.name}. Press the ${video ? 'video call (camera) icon' : 'voice call (phone) icon'} at the top right of the chat to start the call, then stop. Do not type or send anything.`,
        device: usePhone ? 'phone' : 'pc',
        mode: 'do',
      },
      { confirmed: true }
    );
    return { result: `Opened WhatsApp with ${target.name} on your ${usePhone ? 'phone' : 'PC'} and I'm pressing the ${kind} call button now. ${tap?.result || ''}`.trim() };
  }
  return {
    result: `Opened your WhatsApp chat with ${target.name} on your ${usePhone ? 'phone' : 'PC'} — tap the ${video ? 'video' : 'call'} button at the top to start. (To have RAY press it too: turn on Screen Control in the Assistant toolbar${usePhone ? ' and connect the phone to the PC with USB debugging' : ''}.)`,
  };
}

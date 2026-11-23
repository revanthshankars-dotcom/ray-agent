/** In-page event bus for calls: the socket hook publishes, the call hook/screen subscribes. */
export const callBus = new EventTarget();

export function emitCallEvent(type: 'ring' | 'signal', detail: Record<string, unknown>): void {
  callBus.dispatchEvent(new CustomEvent(type, { detail }));
}

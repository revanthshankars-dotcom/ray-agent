/** In-page event bus for calls: the socket hook publishes, the call hook/screen subscribes. */
export const callBus = new EventTarget();

export function emitCallEvent(type: 'ring' | 'signal', detail: Record<string, unknown>): void {
  callBus.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Live computer-use agent updates ('agent:update' from the hub). */
export const agentBus = new EventTarget();
export function emitAgentEvent(detail: Record<string, unknown>): void {
  agentBus.dispatchEvent(new CustomEvent('update', { detail }));
}

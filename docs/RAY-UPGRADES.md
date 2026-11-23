# RAY — Upgrade research & roadmap

What the best real assistants (2026) and the movie AIs do that RAY should, and where RAY stands.

## What the market converged on (2026)

1. **Persistent memory that's used proactively** — not only "remember when asked", but surfacing a deadline mentioned weeks ago. ChatGPT and Gemini both shipped long-term memory + "proactive assistance"; users must be able to view / edit / delete memory.
2. **Execution, not just answers** — assistants are judged on actually *doing* things across apps (Lindy, Operator-style agents).
3. **Ambient, not noisy** — proactive help works when it is ambient; interrupting assistants get turned off.
4. **Fully-local voice stacks** — open-source JARVIS projects pair **openWakeWord** ("hey_jarvis"), **faster-whisper** (STT), **Kokoro-82M** (TTS — Piper was archived Oct 2025) and **Ollama**, giving offline, private, zero-cost voice.

## What the movie AIs teach

| Inspiration | Idea | RAY status |
|---|---|---|
| JARVIS (Iron Man) | Runs the whole house, always listening, knows every device | ✅ always-on cloud hub, bridges on every device, "Hey Ray" |
| JARVIS | "Sir, you have a call" — proactive interruption with context | ✅ incoming WhatsApp/Instagram relayed to every device · 🔜 priority filter |
| FRIDAY | Hands-free multi-device action ("open it on the big screen") | ✅ `search_and_open`, executor routing PC ↔ phone ↔ browser |
| Samantha (Her) | Reads & triages your inbox, remembers everything | ✅ read-only inbox access + Second Brain · 🔜 daily digest note |
| TARS (Interstellar) | Adjustable honesty / humour settings | 🔜 persona sliders in settings |
| KITT | Works even when the "car" is off — wakes the machine | ✅ Web Push wake + Wake-on-LAN + offline command queue |
| Ultron/Vision lesson | Hard limits on what the AI may do alone | ✅ read-alone / act-on-command policy + approvals |

## Shipped in this update

- Always-on hub (Cloud Run `min-instances=1`) with durable state in Google Cloud Storage and permanent pairing (`RELAY_MASTER_SECRET`).
- Offline device wake: queued commands, Web Push, Wake-on-LAN.
- Bridge v3 (Windows/macOS/Linux/**Android-Termux**): auto-installs as a boot service, installed-app discovery + fuzzy launch, real tab opening, native notify/speak/clipboard, real Windows clicks & hotkeys, notification relay.
- RAY Tabs extension: list/switch/read/close tabs, auto-pairs.
- Free engine router over 13 providers, per-task routing, 429/limit-aware failover, parallel "swarm" of small agents near daily limits.
- Voice: Gemini Live when available, otherwise a free STT → router → TTS loop.
- Obsidian-style 3D knowledge graph.

## Next upgrades (ranked by value / effort)

1. **Local wake word + local STT/TTS in the bridge** — openWakeWord + faster-whisper + Kokoro so "Hey Ray" works with the browser closed and fully offline (the bridge already runs on boot).
2. **Proactive daily brief** — every morning write a Daily note (calendar, unread messages, open tasks, weather) and speak a 30-second summary on the first device that wakes.
3. **Memory controls** — "RAY, what do you remember about X / forget X", auto-capture of facts into `Memory/` notes, visible in the 3D graph.
4. **Priority filter for messages** — only interrupt for VIP contacts/keywords; everything else waits for the brief.
5. **Screen-aware help** — periodic low-res screenshot (opt-in) so "what's this error?" works without sharing.
6. **MCP client** — let RAY use any MCP server (GitHub, Notion, Home Assistant) as tools through the same policy layer.
7. **Persona sliders** (TARS): humour %, verbosity, formality.
8. **Home Assistant bridge** for lights/AC/TV ("House Party Protocol" for real).

### Sources
- Vellum, *Best personal AI assistants with memory (2026)* — https://www.vellum.ai/blog/best-personal-ai-assistants-with-memory
- Mastra, *The Best AI Personal Assistants of 2026* — https://mastra.ai/blog/best-personal-ai-assistants-in-2026
- Tech Advisor, *Gemini proactive assistance* — https://www.techadvisor.com/article/3127352/google-gemini-proactive-assistance-upgrade-leaks.html
- YourStory, *ChatGPT long-term memory* — https://yourstory.com/ai-story/openai-turns-chatgpt-smart-personal-assista
- DEV, *Local AI voice assistant stack 2026: Whisper + Piper + Ollama* — https://dev.to/kunal_d6a8fea2309e1571ee7/local-ai-voice-assistant-stack-2026-whisper-piper-ollama-wired-together-572l
- PanPenek/JarvisAi (openWakeWord + faster-whisper + Kokoro + Ollama) — https://github.com/PanPenek/JarvisAi

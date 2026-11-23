# RAY — always-on personal AI across all your devices

RAY runs in the cloud 24/7, listens for **"Hey Ray"** on any connected device, and acts on your PC, Android phone and browser tabs through small bridges that start on boot.

## Quick start (local)

```bash
npm install --legacy-peer-deps
cp .env.example .env    # add at least one free engine key (Groq or Cerebras recommended)
npm run dev             # http://localhost:3000
```

## Always-on in Google Cloud

```bash
PROJECT_ID=my-project REGION=asia-south1 ./deploy/cloudrun.sh
```

Deploys with `min-instances=1` (never sleeps), stores the Second Brain + device state in a GCS bucket, and creates a permanent `RELAY_MASTER_SECRET` so devices never need re-pairing. Put your API keys in Secret Manager afterwards.

## Cloudflare Pages (front door, auto-deploys from GitHub)

Pages builds the web app from `main` (`npm ci --legacy-peer-deps && npx vite build`, output `dist`). The Pages Functions in `functions/` forward `/api/*`, `/ws` and `/live-jarvis` (WebSockets included) to the RAY hub, because Pages can't run the Node server itself. Set `RAY_BACKEND_URL` in the Pages project to your hub URL (for example your Render URL).

## Cloudflare edge (live)

- Worker **`ray-hub`** → https://ray-hub.revanthshankar-s.workers.dev forwards the whole app (web, API, WebSockets) to the RAY hub once `RAY_BACKEND_URL` is set on it, and pings the hub every 10 minutes so Render's free plan never sleeps. Source: `cloudflare/worker.js`.
- KV namespace **`ray-state`** stores RAY's Second Brain, devices and queued commands (used by the hub when `CLOUDFLARE_API_TOKEN` is set).

## Connect your devices (RAY → **Connections**)

| Device | How | What RAY can do |
|---|---|---|
| PC (Win/Mac/Linux) | Download bridge → `npm install ws && node relay-bridge-*.mjs` (installs itself as a boot service) | Open real tabs & any installed app, read files, screen capture + guarded mouse/keyboard, local Ollama, notifications, speech, Wake-on-LAN |
| Android | Termux + Termux:API + Termux:Boot, paste the one-line command | Open apps & links, relay WhatsApp/Instagram/SMS notifications, notifications, speech |
| Browser | RAY Tabs extension (`/api/extension/ray-tabs.zip`, load unpacked) — pairs itself | List / switch / read / close tabs |
| Any device | Open RAY, enable "Wake this device" | Woken by push when another device sends it a command |

## Engine assignment clause

RAY assigns every request to an engine automatically — you never have to choose:

1. Each request is classified (quick reply, chat, device action, code, deep reasoning, image, live web) and sent to the best **free** engine for that job.
2. Every key you add on Render is used, whatever variable name you saved it under (keys are also recognised by format: `gsk_` Groq, `sk-or-` OpenRouter, `oc_sk_` OpenCode, `cfut_` Cloudflare, `AIza` Gemini, `hf_` Hugging Face, `csk-` Cerebras, `nvapi-` NVIDIA).
3. If an engine errors, times out, runs out of credit or hits a limit, the same request moves to the next engine in that job's chain within the same reply.
4. Near the big models' daily limits, large questions are split across several small models in parallel and merged.
5. A server-side daily token budget (`RAY_DAILY_TOKEN_CAP`) is respected, and free engines always come before paid ones such as DeepSeek.
6. Every reply shows which engine answered. **Connections → Who handles what** shows the live chains.

## Calls

- **RAY calls you** — "Hey Ray, call me in 20 minutes", "wake me up at 6:30 on weekdays", "call my phone and remind me to take the charger". Your phone rings with a full-screen call; answering starts a voice conversation with RAY. Scheduled calls survive restarts.
- **Device ↔ device** — "call my phone" (or the phone icon next to a device) rings the other device; answering connects a live two-way audio call (WebRTC, with Cloudflare TURN relay for mobile data).
- **Call someone** — "call Mom": the Android bridge dials the contact from your phone (always asks you to approve first); on a PC the dialer opens through Windows Phone Link.

## Offline mode (no internet)

When the phone and PC are close but have **no internet**, they still talk over any local link: the same Wi-Fi, the phone's **hotspot**, **Bluetooth tethering** (Android: Settings → Hotspot & tethering → Bluetooth tethering, then pair the PC) or **USB tethering**. The PC bridge hosts a token-protected local hub and the phone bridge finds it automatically (or set `RAY_LAN_HOST` to the PC's IP for Bluetooth/USB).

Everything cross-device works offline, in both directions: open apps/links on the other device, **ring my phone**, **call a number** from the phone, **send text to the phone/PC** (clipboard), **tell my PC/phone…** (notification), **any new messages** (WhatsApp/Instagram/SMS relayed from the phone to the PC), **battery**, **what's in my Downloads on my phone**, and free-form questions answered by the PC's local Ollama (`ollama pull llama3.2`). Use the phone's **Ask RAY** button (Termux:Widget) or the RAY app on the PC — it switches to offline mode automatically. When far apart with no internet, nothing can link two devices; commands wait and run when they reconnect.

## File map clause

RAY keeps a map of the files on every connected device (PC bridges and the Android bridge) — **names, folders, sizes and dates only, never file contents, never credential files** — refreshed when a device connects and every 30 minutes, and stored with RAY's durable state. The **3D Brain** shows it alongside your Second Brain notes and Google Drive files: devices and the cloud are hubs, folders branch off them, files are coloured by type, and notes that mention a file are linked to it. RAY searches the map on its own ("where's my passport scan?") — even for devices that are offline right now — and opens or reads a file only when you ask. Turn it off with `RAY_FILE_INDEX=off`.

## Highlights

- **Engine router** (`server/engines/`): 13 free providers, per-task model choice, automatic failover on 429/limits, parallel small-agent "swarm" near daily quotas.
- **Access policy** (`server/deviceTools.ts`): RAY reads on its own; it only writes / sends / closes / clicks when your command asks for it (plus Approve for sensitive actions).
- **Voice**: Gemini Live when available, otherwise a free browser STT → router → TTS loop.
- **Second Brain**: Obsidian-style notes, plus a full-page **3D Brain** (sidebar → *3D Brain Graph*, phone → *3D Brain*).
- **Build id** in the sidebar footer and `/api/health` → `buildId` shows which commit is live.
- **Meta apps**: WhatsApp Cloud API / Instagram Messaging (official) + phone notification relay; personal accounts get pre-filled chats you send with one tap.

See [`docs/RAY-UPGRADES.md`](docs/RAY-UPGRADES.md) for the research and roadmap.

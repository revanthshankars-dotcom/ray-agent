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

## Connect your devices (RAY → **Connections**)

| Device | How | What RAY can do |
|---|---|---|
| PC (Win/Mac/Linux) | Download bridge → `npm install ws && node relay-bridge-*.mjs` (installs itself as a boot service) | Open real tabs & any installed app, read files, screen capture + guarded mouse/keyboard, local Ollama, notifications, speech, Wake-on-LAN |
| Android | Termux + Termux:API + Termux:Boot, paste the one-line command | Open apps & links, relay WhatsApp/Instagram/SMS notifications, notifications, speech |
| Browser | RAY Tabs extension (`/api/extension/ray-tabs.zip`, load unpacked) — pairs itself | List / switch / read / close tabs |
| Any device | Open RAY, enable "Wake this device" | Woken by push when another device sends it a command |

## Highlights

- **Engine router** (`server/engines/`): 13 free providers, per-task model choice, automatic failover on 429/limits, parallel small-agent "swarm" near daily quotas.
- **Access policy** (`server/deviceTools.ts`): RAY reads on its own; it only writes / sends / closes / clicks when your command asks for it (plus Approve for sensitive actions).
- **Voice**: Gemini Live when available, otherwise a free browser STT → router → TTS loop.
- **Second Brain**: Obsidian-style notes with a 3D knowledge graph.
- **Meta apps**: WhatsApp Cloud API / Instagram Messaging (official) + phone notification relay; personal accounts get pre-filled chats you send with one tap.

See [`docs/RAY-UPGRADES.md`](docs/RAY-UPGRADES.md) for the research and roadmap.

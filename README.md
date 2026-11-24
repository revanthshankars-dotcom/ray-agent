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

## Computer use (RAY gets a mouse)

"Hey Ray, turn on dark mode in Windows settings" / "show me how to add a printer" / "on my phone, open Instagram and like my latest post". RAY looks at the screen, a free vision model decides one step at a time, and the PC bridge clicks, types and scrolls — on the **PC**, and on your **Android phone through ADB** (Developer options → Wireless debugging → pair with the PC, or USB debugging). **Teach mode** glides the pointer to each target and explains every step aloud. Requires **Screen Control armed** + one Approve per task; the RAY Agent panel shows what RAY sees, each step and a **Stop** button. Finished tasks become *Skills* notes RAY reuses next time. It never types passwords/OTPs or confirms payments.

## Coding agents

RAY runs the coding agents installed on your PC — **Claude Code, Codex CLI, Gemini CLI, Aider** — as background jobs in your project folders, several **in parallel** with one approval ("have Claude Code add tests in Documents/app and Codex fix lint in Documents/api"), and notifies every device when each finishes.

## Autonomy clause (self-thinking, self-learning, self-healing)

- **Autopilot** (Connections → Autopilot: Off / Observe / Assist, interval, quiet hours): RAY checks in on its own, notices things (low battery, unread messages, morning brief, failures) and — in Assist — does safe things itself (alerts, spoken reminders outside quiet hours, tasks, notes, waking devices). It **never** messages people, calls, writes/deletes files, uses the mouse or runs coding agents without you. Everything is logged in *System → Autopilot Journal*.
- **Self-learning**: durable facts from your chats go to *Memory → About Ray* (edit it any time) and are used in every answer; computer-use runs become *Skills*.
- **Self-healing**: a watchdog re-wakes offline bridges and devices with stuck commands, notices failing engines (RAY already routes around them) and writes *System → System Health*, alerting you only on new problems.
- **Self-building**: ask RAY to improve itself and it runs a coding agent in your local `ray-agent` folder; you review and push.

## Accounts (Google, Instagram/Meta) — one command, the whole app

RAY talks to your accounts **from the server**, so it works from any device, by voice, and in Autopilot — no browser tab needed.

**Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts, YouTube)** — one-time setup:
1. console.cloud.google.com → create/pick a project → *APIs & Services → Library*: enable Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, People and YouTube Data APIs.
2. *OAuth consent screen*: External, add your Gmail as a **test user** (no Google review needed for your own use).
3. *Credentials → Create credentials → OAuth client ID → Web application*, authorised redirect URI `https://ray-hub.onrender.com/api/accounts/google/callback`.
4. Render → ray-hub → Environment: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (and set `RELAY_MASTER_SECRET` if not set — it encrypts the stored token).
5. RAY → JARVIS Core → Accounts → **Connect Google**.

RAY then uses `google_api_request` (any Google REST endpoint, chained until the job is done): "clean my inbox — archive newsletters and label bills", "find the PDF Arun sent and put the totals into my Budget sheet", "move tomorrow's 3 pm to Friday and email everyone". Reads are free, writes need your command, deleting and sending email need one Approve.

**Instagram / Facebook / WhatsApp (Meta)** — Meta only offers APIs for professional accounts:
- Instagram **Business/Creator** account linked to a Facebook Page → developers.facebook.com app with *Instagram Graph API* → long-lived token → Render `INSTAGRAM_ACCESS_TOKEN` (and `META_PAGE_TOKEN` for the Page). RAY can then publish posts/reels/carousels, read and reply to comments, read insights and answer DMs within Meta's 24-hour rule (`meta_api_request`). Switching a personal Instagram to *Creator* is free in the app's settings.
- WhatsApp Business: `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`.
- **Personal** Instagram/WhatsApp: no API exists. RAY reads incoming messages from the phone's notifications and does things through the logged-in browser on your PC (`browse_web` "do", with your approval) or the app on your phone (`operate_computer`, via ADB). Heavy automation of personal accounts can get them rate-limited by Meta, so RAY works at a human pace and asks before posting or sending.

## Connectors (MCP servers) — plug in any agent toolkit

JARVIS Core → **Connectors** adds any remote MCP server (Streamable HTTP, `https://…`). RAY lists its tools (`mcp_servers`) and calls them (`mcp_call`) from chat, voice and Autopilot; tools that send, call, buy, post or delete ask you once. URLs and keys are stored encrypted (`RELAY_MASTER_SECRET`).

Presets:
- **AgentPhone** — `https://mcp.agentphone.ai/mcp`, API key from agentphone.ai → Settings: buy a number, SMS/WhatsApp, AI voice calls (US/Canada numbers).
- **CallForMe** — `https://callforme.tel/mcp`: RAY phones businesses for you.
- **n8n** — your instance → Settings → Instance-level MCP → copy the URL + token; every exposed workflow becomes a RAY tool.
- **Course / challenge servers** — paste the MCP link the course gives you. If you paste the course web page instead, RAY also tries `/mcp` and `/api/mcp` on that site. Tokens in links are personal: don't share or commit them.

Skill catalogs (e.g. agentskillexchange) that ship hosted MCP servers plug in the same way; plain SKILL.md skills are instructions, not servers.

## Phone line — RAY rings your real number

Like `call-me`: `phone_call_me` dials your phone, says the message, listens, answers, and returns what you said so a mission can continue with your decision ("call me when the build is done", "call me if anything is urgent"). Works with no RAY app open. Add in Render:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (a Twilio number; trial accounts can call verified numbers only)
- `RAY_USER_PHONE` — your number in `+91…` form
- `PUBLIC_BASE_URL` — optional on Render (uses `RENDER_EXTERNAL_URL`)
- optional `RAY_PHONE_VOICE` (default `Polly.Matthew-Neural`), `RAY_PHONE_LANG` (default `en-IN`)

Webhooks (`/api/phone/voice`, `/api/phone/status`) are verified with Twilio's signature. Cost is roughly Twilio's per-minute rate; speech recognition is included in `<Gather>`.

## Always-on JARVIS (free)

- **Pop-ups and calls in front of everything** — the PC bridge opens RAY as its own window and forces it above other apps (Windows focus rules, macOS activate, Linux wmctrl); calls ring with a sound even when no browser is open. On Android, give Termux **Display over other apps**; a heads-up notification is the backup.
- **Phone assistant, always running** — Termux keeps a wake lock and starts on boot (Termux:Boot). Tap **Talk** on the RAY notification or the *Talk to RAY* widget from any app: a spoken back-and-forth until you say "stop". Phones on bridge v3.1 update to v3.2 automatically.
- **Meaning-based memory** — facts, notes, Knowledge and skills are embedded with free Gemini embeddings (or Cloudflare Workers AI) and recalled by meaning on every request; keyword recall is the fallback.
- **Stronger on free models** — long goals get a written plan that is re-shown every round, old tool output is trimmed, struggling missions move to the strongest free models (gpt-oss-120b, Qwen3-235B, DeepSeek, Gemini Flash…), and a final check catches unfinished steps before RAY says "done".
- **Smart home** — JARVIS Core → *Home & always on*: connect Home Assistant (free) with a long-lived token; on your home Wi-Fi it is reached through the PC bridge. Locks, garage doors and alarms ask first.
- **Hard stops, with your OK** — in browser tasks RAY pauses at password/OTP fields (you type it into a secure box on the approval card: used once, never saved, never shown to the AI; OTPs from your phone's notifications are pre-filled), at Pay / Place-order buttons (shows the amount), and at CAPTCHAs (brings the browser in front of you and continues once you solve it).
- **Awareness (opt-in)** — RAY knows the app/window you're in and your recent windows (memory only).
- **Tabs like a person** — before opening anything RAY checks your open tabs (RAY Tabs extension 1.1): if the page is already open it switches to it, if the site is open it loads the page in that tab, an empty new tab is reused, and only otherwise a new tab opens. Calls, documents and playing media are never navigated away; say "in a new tab" or "here" to choose. On Android, links to the same site reuse one Chrome tab.
- **RAY in your own browser** — RAY Tabs 1.2 lets RAY read the page you're on (text + numbered elements), click, type and scroll with your logins, and search your history/bookmarks ("summarise this page", "reply here", "that article I read yesterday"). Passwords and pay buttons wait for your approval; secret fields are never read back. With Awareness on, RAY also knows the tab you're looking at.
- **Accurate voice** — each utterance is recorded with voice-activity detection (no cut-offs on pauses) and transcribed by free Whisper large-v3-turbo (Groq if `GROQ_API_KEY`, otherwise Cloudflare Workers AI) with a vocabulary of your people, devices and apps, so names come out right. Hindi/Tamil/mixed speech works. The browser recogniser stays as live captions and fallback.
- **Shared mic** — in the assistant toolbar choose **Runs on** (speak on the phone, act on the PC, or the other way) or **Use mic on…** to make another device listen for this one (a phone runs its Talk loop; a PC pops up RAY listening). "on my PC / phone" in a command always wins.
- **Free 24/7 server** — Oracle Cloud Always Free: [`deploy/oracle/README.md`](deploy/oracle/README.md), one command (`deploy/oracle/setup.sh`).

## Skills from Orbit

JARVIS Core → **Skills** installs playbooks from [Orbit](https://orbitskills.app) (skills taken from AI creators' posts, credited to them). Installed skills are Second Brain notes under *Skills*; on every request RAY adds the 1–2 that fit (e.g. "my app keeps crashing" → *Investigate*). RAY can also `skill_search` / `skill_install` by chat. The **Recommended for RAY** pack is hand-picked and every pick is rated "nothing risky" by Orbit; skills Orbit flags "use with care" need your approval. Skill text is treated as reference only — it never overrides your instructions or the approval flow.

## From Luke's 3-Day AI Agent Build

- **Learn me** (Day 1): Google card → *Learn me from my email* reads your recent sent mail, saves facts to *Memory/About Ray* and your writing style to *Memory/Email Style*, then asks clarifying questions (no codes, numbers or passwords are stored).
- **Inbox routine** (Day 1): *Check twice a day* (08:00 & 16:00 local by default, max 4/day). RAY writes reply drafts in Gmail in your style and messages you a summary; nothing is sent until you say "send it". Your corrections become Lessons.
- **"Interview me"** (Day 1): for new workflows RAY asks the gap-closing questions one at a time before building.
- **Small memory, recalled on demand** (Day 2): the prompt carries only the core of *About Ray*; older facts, Knowledge and playbooks are pulled in only when they match the request. Plug an external memory (Supermemory, Honcho) in through Connectors → *Memory* if you use one.
- **Watch videos**: `watch_video` watches YouTube links with Gemini (picture + sound, timestamps); other hosts fall back to the page text. Needs `GEMINI_API_KEY`.

## JARVIS layer (bridge 3.1)

- **Browser hands** — RAY drives a real Chrome/Edge on your PC (its own "RAY" profile — sign in there once). `browse_web` reads pages as text + numbered buttons/fields and a free model picks one step at a time (open, click, type, scroll, note, done). *Research* mode runs hidden and returns an answer with sources; *Do* mode (forms, bookings, settings) needs one Approve. It never types into password fields and never pays or posts on its own. With the PC offline, research falls back to the cloud.
- **Real self-learning** — every morning (05:30 local, change in JARVIS Core) RAY researches its *Learning Topics* plus questions it couldn't answer, writes dated `Knowledge/<topic>` notes with sources and a *Daily Briefing*, and pulls the relevant notes into later answers. Its failed actions and your corrections ("no, I meant…") are distilled into *Memory → Lessons*, rules it follows from then on. "Learn about X" / "keep up with X" adds a topic.
- **Mission mode** — one command, whole job: up to 12 tool rounds; when a step fails RAY reflects and tries alternatives (another device, wake it first, the browser, the mouse) before reporting exactly what is blocked.
- **Self-healing** — "fix my PC / my internet is broken / Chrome keeps freezing / free up space": RAY diagnoses (disk, memory, internet, frozen apps, crash log, temp, battery), plans fixes from a safe catalogue (clear old temp files, flush DNS, renew IP, close frozen apps, restart Explorer/an app, update an app via winget/brew/pkg, restart Ollama/the bridge, restore a file), asks once, runs them, re-checks and logs *System → Repairs*. Every file RAY overwrites is versioned (last 10) so `restore_file` can undo it. Bridges update themselves when the server has a newer version.
- **Always there** — the bridge starts on boot; on the PC **Ctrl+Alt+R** (Start-menu shortcut "RAY") pops up a compact RAY window that starts listening, and RAY opens itself once after boot so "Hey Ray" works (`RAY_POPUP_ON_BOOT=0` to disable). On Android a permanent "RAY is running" notification has *Open RAY* / *Ask RAY* buttons. "Open RAY on my phone" pops it up on another device.
- **JARVIS Core** page — abilities, learning topics & knowledge, lessons & memory, per-device health (Diagnose / Fix), repair journal, Autopilot.

## Highlights

- **Engine router** (`server/engines/`): 13 free providers, per-task model choice, automatic failover on 429/limits, parallel small-agent "swarm" near daily quotas.
- **Access policy** (`server/deviceTools.ts`): RAY reads on its own; it only writes / sends / closes / clicks when your command asks for it (plus Approve for sensitive actions).
- **Voice**: Gemini Live when available, otherwise a free browser STT → router → TTS loop.
- **Second Brain**: Obsidian-style notes, plus a full-page **3D Brain** (sidebar → *3D Brain Graph*, phone → *3D Brain*).
- **Build id** in the sidebar footer and `/api/health` → `buildId` shows which commit is live.
- **Meta apps**: WhatsApp Cloud API / Instagram Messaging (official) + phone notification relay; personal accounts get pre-filled chats you send with one tap.

See [`docs/RAY-UPGRADES.md`](docs/RAY-UPGRADES.md) for the research and roadmap.

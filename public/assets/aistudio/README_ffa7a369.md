# J.A.R.V.I.S. 2.0 — Hybrid AI Operating System

> *"At your service, sir."*

A fully autonomous, multi-agent AI desktop operating system with a cloud backend, mission control dashboard, and a voice-activated local assistant — built on Google Gemini, Groq LPU, and Cloudflare Workers AI.

---

## 🏗 Architecture

```
jarvis-assistant/
├── main.py               ← Local hybrid desktop assistant (voice/text)
├── tray.py               ← System tray app (runs cloud server silently)
├── start_server.bat      ← Launches cloud backend in a terminal
├── start_tray.bat        ← Launches system tray app (background mode)
├── run.bat               ← Launches local assistant only
│
├── cloud_server/         ← FastAPI Cloud Brain & Multi-Agent System
│   ├── server.py         ← FastAPI app with all REST endpoints
│   ├── agents/
│   │   ├── base.py       ← Abstract BaseAgent + AgentTask state machine
│   │   ├── specialists.py← 8 specialist agents (Reasoning, Research, Coding…)
│   │   └── commander.py  ← CommanderAgent: routes & orchestrates all agents
│   ├── providers/
│   │   ├── base.py       ← BaseAIProvider interface (vendor-agnostic)
│   │   ├── gemini_provider.py
│   │   ├── groq_provider.py
│   │   └── cloudflare_ai_provider.py
│   ├── orchestrator/
│   │   └── router.py     ← IntelligenceRouter: smart multi-provider routing
│   └── database/
│       ├── schema.sql    ← SQLite / Cloudflare D1 schema
│       └── db.py         ← CloudDatabase: devices, tasks, memory, audit logs
│
├── core/                 ← Local assistant modules
│   ├── brain.py          ← Hybrid routing brain (cloud + local fallback)
│   ├── audio.py          ← TTS (Edge TTS) & STT (SpeechRecognition)
│   ├── memory.py         ← Local vector key-value memory
│   ├── tools.py          ← System tools (web search, app launch, volume, etc.)
│   ├── vision.py         ← Screen capture & visual analysis
│   ├── sync.py           ← Local ↔ Cloud sync service
│   └── network.py        ← Network connectivity & latency monitoring
│
├── dashboard/
│   └── index.html        ← Mission Control glassmorphism web dashboard
│
└── storage/              ← SQLite database files (auto-created)
```

### Dashboard AI routing

The dashboard reports the provider that actually answered each chat request. If the
selected Ollama model stalls, J.A.R.V.I.S. waits up to
`OLLAMA_GENERATE_TIMEOUT_SECONDS` (8 seconds by default) and then tries configured
cloud providers. A successful fallback is identified in the response metadata rather
than appended to the assistant's reply.

---

## ⚡ Multi-Agent System

| Agent | Role |
|---|---|
| 🧠 Commander | Intent routing & response synthesis |
| 🔍 Reasoning | Deep logic, planning, analysis |
| 📡 Research | Live web search + fact synthesis |
| 💻 Coding | Code generation, architecture, debugging |
| 🗄️ Memory | Semantic vector recall & cloud storage |
| 🖥️ Computer Operator | Windows action dispatcher |
| ⚡ Task Execution | Multi-step workflow graphs |
| ✅ Verification | Independent audit & fact-checking |
| 🛡️ Security | 3-tier risk classification & access guard |

---

## 🚀 Quick Start

### 1. Configure API Keys
```bash
# Copy and edit the example env
copy .env.example .env
# Then add your GEMINI_API_KEY (required), GROQ_API_KEY (optional), Cloudflare (optional)
```

### 2. Install Dependencies
```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### 3A. Start Cloud Server (terminal mode)
```bash
start_server.bat
# Dashboard: http://localhost:8000/dashboard
# API Docs:  http://localhost:8000/docs
```

### 3B. Start System Tray (background mode — recommended)
```bash
start_tray.bat
# Right-click the arc-reactor tray icon for controls
```

### 3C. Launch Local Voice/Text Assistant
```bash
run.bat
```

---

## 🌐 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | System health + provider status |
| POST | `/api/chat` | Send a message to the Commander agent |
| GET | `/api/agents` | List all specialist agents |
| GET | `/api/tasks` | View agent task log |
| GET/POST | `/api/memory` | Retrieve or store personal memories |
| DELETE | `/api/memory/{id}` | Delete a memory |
| GET/POST | `/api/routing` | View or change the intelligence routing policy |
| GET | `/api/devices` | List registered device bridges |
| GET | `/api/audit` | View security audit log |

---

## 📱 PWA, Remote Tunnel, and Startup

- The dashboard is installable as a PWA from `/dashboard/` over HTTPS (or localhost). Its touch-to-talk control uses the browser's speech-recognition support; enable microphone permission on the phone.
- To access the local assistant remotely without router port forwarding, install Cloudflare Tunnel (`winget install Cloudflare.cloudflared`), generate a strong token with `python -c "import secrets; print(secrets.token_urlsafe(32))"`, and put it in `.env` as `JARVIS_API_TOKEN`. Start the local server, then run `start_tunnel.bat`. The dashboard asks for that token and keeps it only for the current browser session. Without the token, the tunnel will not start, and API calls arriving through a Quick Tunnel are rejected.
- `install_startup.bat` installs the stealth launcher shortcut in the current Windows user's Startup folder. Run `uninstall_startup.bat` to remove it.
- The standalone Cloudflare Worker is a separate cloud chat/memory service; setup and deployment steps are in [`cloud/README.md`](cloud/README.md). Cloud deployment requires a Cloudflare account and cannot be performed from this local project without that account's authorization.

---

## 🔑 API Keys

| Provider | Required | Get Free Key |
|---|---|---|
| Google Gemini | ✅ Yes | [aistudio.google.com](https://aistudio.google.com) |
| Groq LPU | ⬜ Optional | [console.groq.com](https://console.groq.com) |
| Cloudflare Workers AI | ⬜ Optional | [dash.cloudflare.com](https://dash.cloudflare.com) |

---

## 🧠 Shared J.A.R.V.I.S. Brain

The shared brain is an additive service in `jarvis_brain/`; it does not replace the existing `storage/memory.db` or `storage/jarvis_cloud.db`. Its SQLite database is stored under `storage/jarvis_brain/`, uses SQLite FTS5 for full-text search, and supports optional local vector embeddings through Ollama. It requires no paid API or embedding provider. Without an embedding model, the REST and MCP tools continue to work with full-text retrieval.

```text
JARVIS voice/chat ───┐
Coding agents ─ MCP stdio ─ authenticated REST API ─ SQLite + FTS5
Dashboard ──────────┘                               └ optional Ollama embeddings
                                                     └ verified local backups
```

JARVIS reads only a few matching notes for context and saves only when the user explicitly asks it to remember something. Those explicit notes stay private by default; say “remember this for coding agents” to make a note shared. Coding agents can explicitly save shared notes or use project namespaces with registered membership.

### Setup and API

1. Generate a long random key:
   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```
2. Add it to the project `.env` as `JARVIS_BRAIN_API_KEY=<generated-value>`. Keep `.env` private and never commit it.
3. Start J.A.R.V.I.S. with `launch_jarvis.bat` (or `start_server.bat`).
4. Open `http://127.0.0.1:8000/brain`. The browser asks for the API key and keeps it in session storage only.

REST endpoints are rooted at `/api/v1` and require `X-API-Key` or `Authorization: Bearer ...`, except the minimal `/health` endpoint:

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/memory/save` | Save validated, deduplicated memory |
| POST | `/api/v1/memory/search?query=...` | Hybrid full-text/local-vector search |
| GET/PUT/DELETE | `/api/v1/memory/{memory_id}` | Get, update, or delete memory |
| GET | `/api/v1/memory` | Paginated memory listing |
| POST/GET | `/api/v1/projects` | Create/list project namespaces |
| GET | `/api/v1/projects/{project_id}/context` | Retrieve project context |
| PUT | `/api/v1/projects/{project_id}` | Update project metadata/access list (admin only) |
| GET | `/api/v1/projects/{project_id}/search?query=...` | Search within one project |
| POST | `/api/v1/knowledge/import` | Import safe text/Markdown/JSON/code content |
| POST | `/api/v1/agents/register` | Issue an agent-specific API key (admin only) |
| GET | `/api/v1/stats` | Memory, project, and local database stats |
| POST | `/api/v1/backup/create` | Create and verify a local SQLite backup |
| POST | `/api/v1/backup/restore` | Restore a named backup (admin only) |

Only the process running J.A.R.V.I.S. should expose the brain. Keep it on localhost; do not expose its SQLite file or API directly to the internet. Admin keys can read/manage all projects. Agents should use individual keys returned once by `/api/v1/agents/register`; project memories are filtered by owner and `allowed_agents`. Imported content is stored as data and is never executed. Content matching common credential patterns is rejected.

### Local semantic embeddings

For vector retrieval without a paid service, install Ollama and pull an embedding model:

```powershell
ollama pull nomic-embed-text
```

Set `JARVIS_BRAIN_EMBEDDING_MODEL=nomic-embed-text` (the default) in `.env`. Indexing happens in a background worker; search uses FTS5 immediately and combines vector results once local embeddings are available. Embedding model files consume local disk space; the SQLite database and backups remain under `storage/jarvis_brain/`.

### MCP connections

Install the requirements after updating the project:

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The MCP server uses stdio and forwards tools to the authenticated local REST API. Register one agent key per client using the admin key, then configure each client with that agent key and the project root as its working directory.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "jarvis-brain": {
      "command": "C:\\Users\\AMBIKA\\Desktop\\jarvis-assistant\\.venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\AMBIKA\\Desktop\\jarvis-assistant\\jarvis_brain\\mcp_server.py"],
      "env": {
        "JARVIS_BRAIN_API_KEY": "use-the-registered-claude-agent-key",
        "JARVIS_BRAIN_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

Codex CLI:

```powershell
codex mcp add jarvis-brain --env JARVIS_BRAIN_API_KEY=use-your-registered-codex-agent-key --env JARVIS_BRAIN_URL=http://127.0.0.1:8000 -- C:\Users\AMBIKA\Desktop\jarvis-assistant\.venv\Scripts\python.exe C:\Users\AMBIKA\Desktop\jarvis-assistant\jarvis_brain\mcp_server.py
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jarvis-brain": {
      "command": "C:\\Users\\AMBIKA\\Desktop\\jarvis-assistant\\.venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\AMBIKA\\Desktop\\jarvis-assistant\\jarvis_brain\\mcp_server.py"],
      "env": {
        "JARVIS_BRAIN_API_KEY": "use-the-registered-cursor-agent-key",
        "JARVIS_BRAIN_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

The MCP tools include `memory_save`, `memory_search`, `memory_get`, `memory_update`, `memory_delete`, `memory_list`, `project_create`, `project_context`, `project_search`, `project_update`, `decision_save`, `decision_search`, `agent_register`, `agent_list`, `memory_stats`, and `knowledge_import`. These configurations are examples; each client installation should be tested using its MCP inspector/logs before relying on it. Do not copy the admin key into coding-agent configuration.

### Python client, backups, and import

```python
from jarvis_brain.client import BrainClient

brain = BrainClient()  # Reads JARVIS_BRAIN_API_KEY and JARVIS_BRAIN_URL
brain.save("The Jarvis backend uses FastAPI and SQLite.", memory_type="documentation")
matches = brain.search("What database does Jarvis use?")
print(matches)
brain.import_file(r"C:\path\to\project\ARCHITECTURE.md")
```

Backups are verified SQLite snapshots in `storage/jarvis_brain/backups/`. Create and restore them through the admin-only endpoints or dashboard. Restoring replaces the brain database with the selected verified backup; make a fresh backup before restoring. PDF import through `BrainClient.import_file` uses the open-source `pypdf` package to extract text; scanned/image-only PDFs need OCR, which is not included.

Automatic verified backups run every 24 hours while the J.A.R.V.I.S. FastAPI server is running; backup interval and retention are configurable with `JARVIS_BRAIN_BACKUP_INTERVAL_HOURS` and `JARVIS_BRAIN_BACKUP_RETENTION_DAYS`. Older generated backups are pruned only after a new backup passes SQLite integrity verification. To run the shared brain independently, install `jarvis_brain/requirements.txt`, set `JARVIS_BRAIN_API_KEY`, then run `python -m jarvis_brain.app` (localhost port 8765). Its dashboard is `http://127.0.0.1:8765/brain`; point clients at that URL with `JARVIS_BRAIN_URL`.

Optional container deployment (loopback-bound, with persistent local storage):

```powershell
docker compose -f docker-compose.brain.yml up --build -d
```

The compose service requires `JARVIS_BRAIN_API_KEY` in `.env`, binds only to `127.0.0.1:8765`, and stores data under `storage/jarvis_brain/`. Docker is optional free software; it does not eliminate hardware, electricity, or disk costs.

To measure local full-text query speed (without external services):

```powershell
.venv\Scripts\python.exe scripts\benchmark_jarvis_brain.py
```

### Current implementation boundaries

- SQLite, FTS5, the REST API, project scopes, agent-specific API tokens, audit records, backup/restore, text/code import, and MCP tools are local and free.
- Semantic matching requires Ollama plus a downloaded embedding model; otherwise retrieval is full-text only.
- Project access is enforced by registered agent keys and project membership. The administrator key is intentionally all-powerful.
- There is no React build pipeline or external service. The included responsive page at `/brain` is a compact operational dashboard for stats, search, memory save/delete, and backups.
- Automatic conversation capture is intentionally not enabled; save only durable facts/decisions rather than every chat.

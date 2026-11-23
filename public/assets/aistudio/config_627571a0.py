import os
from pathlib import Path
from dotenv import load_dotenv

# Base paths
BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(exist_ok=True)

# Load .env file
load_dotenv(BASE_DIR / ".env")

# API Keys & Settings
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
JARVIS_VOICE = os.getenv("JARVIS_VOICE", "en-GB-RyanNeural")
JARVIS_MODEL = os.getenv("JARVIS_MODEL", "gemini-3.5-flash-lite")

# Supported Gemini Models with descriptions
AVAILABLE_MODELS = {
    "1": {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash Lite", "desc": "Ultra-fast response, lowest latency (Recommended Default)"},
    "2": {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash", "desc": "Newest high-intelligence multimodal model"},
    "3": {"id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash", "desc": "Advanced reasoning & agentic tasks"},
    "4": {"id": "gemini-flash-latest", "name": "Gemini Flash (Latest)", "desc": "Auto-updated latest stable flash model"},
    "5": {"id": "gemini-pro-latest", "name": "Gemini Pro (Latest)", "desc": "Deep analytical queries, research & coding"},
}

# Voice & text matching aliases
MODEL_ALIASES = {
    "lite": "gemini-3.5-flash-lite",
    "fast": "gemini-3.5-flash-lite",
    "flash-lite": "gemini-3.5-flash-lite",
    "3.5-flash-lite": "gemini-3.5-flash-lite",
    "3.8": "gemini-3.8-flash",
    "3.8-flash": "gemini-3.8-flash",
    "3.7": "gemini-3.7-flash",
    "3.7-flash": "gemini-3.7-flash",
    "smart": "gemini-3.7-flash",
    "flash": "gemini-flash-latest",
    "latest": "gemini-flash-latest",
    "pro": "gemini-pro-latest",
}

# System Prompt
SYSTEM_INSTRUCTION = """You are J.A.R.V.I.S., a sophisticated, loyal, and witty AI assistant inspired by Tony Stark's J.A.R.V.I.S.
Key behavioral guidelines:
1. Speak concisely, clearly, and naturally, with mild British wit and unwavering loyalty.
2. Because your responses will be spoken aloud via Text-to-Speech, avoid markdown tables or complex symbols. Keep spoken answers typically within 1 to 3 crisp sentences unless the user explicitly requests an in-depth breakdown.
3. You have native tools to control the user's Windows computer, check system telemetry (CPU, RAM, battery), launch applications, search the live web, and analyze their screen visually.
4. Execute tools whenever the user's command requires real-time knowledge, system actions, or visual inspection. Confirm completed actions smoothly (e.g., 'Right away, sir. Launching Chrome now.').
"""

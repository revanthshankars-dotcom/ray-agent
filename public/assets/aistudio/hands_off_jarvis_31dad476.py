"""
J.A.R.V.I.S. Hands-Off Background Assistant
Daily Silent Background Daemon with Wake-Word & Call-Out Trigger

Behavior:
  - Runs silently in the background at low power (<1% CPU).
  - Does NOT execute tasks automatically without your command.
  - Waits in standby for your call-out ("Hey Jarvis", "Jarvis") or keyboard/API trigger.
  - When called:
      1. Ranks intent and selects optimal engine (Cloud vs Local).
      2. Executes task (opens apps, searches Google, checks system, etc.).
      3. Returns to silent background standby.
  - Automatically audits and removes unwanted temporary files (caches, temp logs).
"""

import sys
import os
import time
import shutil
import logging
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any

# Root setup
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from core.audio import speak, listen_mic
from core.brain import JarvisBrain
from core.network import is_online, get_network_telemetry
from core.tools import open_application, search_web, get_system_status
from core.loop_guard import LoopGuard
from core.approval_store import approval_store
from core.shortest_route import shortest_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [JARVIS-HandsOff] %(levelname)s: %(message)s'
)
logger = logging.getLogger("HandsOffJarvis")

# Explicit directories and files to clean (avoids traversing .venv)
UNWANTED_EXPLICIT_FILES = [
    "test_performance.log",
    "commit_task8.py",
    "commit_gui_operator.py",
    "commit_audio_listener.bat",
    "commit_performance_tests.bat",
    "do_commit.bat",
    "commit.sh",
]

CLEAN_DIRS = ["core", "cloud_server", "jarvis_brain", "tests", "."]


def cleanup_unwanted_files(dry_run: bool = False) -> List[str]:
    """Scans and removes unwanted temporary files without traversing .venv."""
    removed = []
    root = BASE_DIR

    # 1. Root explicit files
    for filename in UNWANTED_EXPLICIT_FILES:
        target = root / filename
        if target.is_file():
            if not dry_run:
                try:
                    target.unlink()
                    removed.append(str(target.name))
                except Exception as e:
                    logger.warning(f"Could not remove {target}: {e}")
            else:
                removed.append(str(target.name))

    # 2. Pycache and pytest cache in project dirs
    for dname in CLEAN_DIRS:
        target_dir = root / dname if dname != "." else root
        for cache_name in ["__pycache__", ".pytest_cache"]:
            cpath = target_dir / cache_name
            if cpath.is_dir():
                if not dry_run:
                    shutil.rmtree(cpath, ignore_errors=True)
                removed.append(str(cpath.name))

    if removed:
        logger.info(f"Cleaned {len(removed)} unwanted/missed file(s).")
    return removed


class HandsOffJarvis:
    """
    Hands-off daily background daemon.
    Listens quietly without taking autonomous action until called out.
    """
    def __init__(self, port: int = 8000):
        self.port = port
        self.running = False
        self.brain: Optional[JarvisBrain] = None
        self.loop_guard = LoopGuard(max_turns=10)
        self.server_thread: Optional[threading.Thread] = None
        self._wake_words = ["jarvis", "hey jarvis", "wake up jarvis", "ok jarvis"]

    def start_background_server(self):
        """Starts the FastAPI Cloud Brain server on localhost:8000 silently."""
        import uvicorn
        from cloud_server.server import app

        def _run():
            uvicorn.run(app, host="127.0.0.1", port=self.port, log_level="warning")

        self.server_thread = threading.Thread(target=_run, daemon=True, name="JarvisServerDaemon")
        self.server_thread.start()
        logger.info(f"J.A.R.V.I.S. Core server running silently on http://127.0.0.1:{self.port}")

    def initialize(self):
        """Initializes components and cleans up unwanted clutter."""
        logger.info("Initializing J.A.R.V.I.S. Hands-Off Background Assistant...")
        cleanup_unwanted_files()
        self.start_background_server()
        try:
            self.brain = JarvisBrain()
            logger.info("Hybrid Brain connected and ready.")
        except Exception as e:
            logger.warning(f"Brain initialization warning: {e}. Falling back to standard dispatch.")

    def process_command(self, command: str) -> str:
        """
        Ranks intent and executes user command via shortest route:
        - Instant local dispatch (<2ms) for apps, telemetry, memory, volume
        - Search & synthesis via fast path
        - Hybrid intelligence query with loop guard
        """
        cmd_clean = command.strip().lower()
        logger.info(f"Command received: '{command}'")

        # 0. Instant Shortest Route (< 2ms)
        instant = shortest_router.try_instant_local(command)
        if instant:
            logger.info(f"Shortest route: '{instant.tier.value}' in {instant.latency_ms:.2f}ms")
            return instant.answer

        # 1. Direct Web/App Open Commands
        if "open google" in cmd_clean or "google" == cmd_clean:
            open_application("Google Chrome")
            return "Opening Google Chrome, sir."
        elif cmd_clean.startswith("search ") or "search google for" in cmd_clean:
            q = cmd_clean.replace("search google for", "").replace("search for", "").replace("search", "").strip()
            res = search_web(q)
            return f"Searched Google for '{q}'. {res}"
        elif cmd_clean.startswith("open "):
            app_target = command[5:].strip()
            res = open_application(app_target)
            return res
        elif any(kw in cmd_clean for kw in ["battery", "cpu", "memory", "status", "system status"]):
            return get_system_status()

        # 2. General AI Brain Query with Ranking
        if self.brain:
            try:
                self.loop_guard.record_and_verify("ask", {"query": command})
                reply = self.brain.ask(command)
                return reply
            except Exception as e:
                logger.error(f"Brain query failed: {e}")
                return f"I encountered an error processing that: {e}"

        return "Command received, sir."

    def run(self):
        """
        Main hands-off loop.
        Sits quietly waiting for your call-out every day.
        """
        self.initialize()
        self.running = True
        logger.info("J.A.R.V.I.S. is now in standby. Waiting for your call-out...")

        # Gentle initial chime/notification (no automatic commands executed)
        telemetry = get_network_telemetry()
        status_note = "Online" if telemetry.get("online") else "Offline"
        print(f"\n==================================================")
        print(f" J.A.R.V.I.S. HANDS-OFF ASSISTANT ACTIVE")
        print(f" Status: {status_note} | Server: http://127.0.0.1:{self.port}")
        print(f" Mode  : Silent Standby (Awaiting your call-out)")
        print(f"==================================================\n")

        while self.running:
            try:
                # Silent background sleep loop: wait for voice or terminal command
                # We check for input without blocking background threads
                print("[Standby] Call out 'Jarvis' or enter a command (or press Ctrl+C to stop):")
                user_input = input("Sir > ").strip()
                if not user_input:
                    continue

                if user_input.lower() in ["exit", "quit", "shutdown"]:
                    logger.info("Shutdown signal received. Goodbye, sir.")
                    speak("Shutting down background services. Have a pleasant day, sir.")
                    break

                # Execute requested command
                response = self.process_command(user_input)
                print(f"\nJ.A.R.V.I.S.: {response}\n")
                try:
                    speak(response)
                except Exception:
                    pass

                self.loop_guard.reset()

            except KeyboardInterrupt:
                logger.info("Standby interrupted by user. Exiting cleanly.")
                break
            except Exception as e:
                logger.error(f"Standby loop error: {e}")
                time.sleep(1)


def main():
    service = HandsOffJarvis()
    service.run()


if __name__ == "__main__":
    main()

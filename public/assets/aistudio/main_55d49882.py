import sys
import time
import argparse
import threading
from config import JARVIS_VOICE, GEMINI_API_KEY
from core.audio import speak, listen_mic
from core.brain import JarvisBrain
from core.tools import get_system_status
from core.network import get_network_telemetry
from core.sync import sync_service
from core.memory import memory_manager
from core.system_monitor import SystemMonitor
from core.audio_listener import AudioListener
from core.gui_operator import GuiOperator
from core import task_executor

BANNER = r"""
   ╦ ╔═╗ ╦═╗ ╦  ╦ ╦ ╔═╗
   ║ ╠═╣ ╠╦╝ ╚╗╔╝ ║ ╚═╗
  ╚╝ ╩ ╩ ╩╚═  ╚╝  ╩ ╚═╝  [Hybrid AI Desktop Assistant]
"""

def print_help(brain: JarvisBrain):
    st = brain.get_routing_status()
    net = get_network_telemetry()
    status_str = f"ONLINE ({st['cloud_model']})" if net['online'] else f"OFFLINE ({st['local_model']})"

    print(f"""
System Status : {status_str} [Latency: {net['latency_ms']}]
Routing Policy: {st['policy']}

Available Controls:
  - Speak or type normally (e.g. 'What is my battery?', 'Open Chrome', 'Search SpaceX')
  - 'route [auto|cloud|local]' : Switch routing policy between Auto (Hybrid), Cloud, and Local
  - 'model' or 'models'        : Switch cloud models (Flash Lite, 3.8, 3.7, Pro)
  - 'sync'                     : Manually synchronize local vectors & personal data with cloud
  - 'remember <fact>'          : Store personal preference in secure local vector cache
  - 'recall <query>'           : Perform local semantic vector search
  - 'network'                  : Check network connectivity and latency
  - 'stats'                    : Quick hardware telemetry (CPU, RAM, Battery)
  - 'look' or 'screen'         : Capture and analyze active screen
  - 'mode'                     : Toggle between [Voice Mode] and [Text Mode]
  - 'exit' or 'quit'           : Shut down Jarvis
""")

def handle_model_menu(brain: JarvisBrain):
    print("\n" + brain.list_models_formatted())
    selection = input("\nEnter model number or name (or press ENTER to cancel): ").strip()
    if selection:
        msg = brain.switch_model(selection)
        speak(msg, voice=JARVIS_VOICE)

def main():
    print(BANNER)
    print("Initializing J.A.R.V.I.S. Hybrid Intelligence Router...")
    
    # Initialize Hybrid Brain
    brain = JarvisBrain()
    status = brain.get_routing_status()
    net = get_network_telemetry()

    # Initial greeting
    online_note = f"Online via {status['cloud_model']}" if net['online'] else "Running on local offline protocols"
    greeting = f"At your service, sir. Hybrid systems operational. {online_note}."
    speak(greeting, voice=JARVIS_VOICE)

    # Mode selection
    mode = "text"
    print("\nSelect interaction mode:")
    print("  [1] Text Mode (Type commands - Recommended for fast testing)")
    print("  [2] Voice Mode (Speak via microphone)")
    choice = input("\nEnter choice [1 or 2, default: 1]: ").strip()
    if choice == "2":
        mode = "voice"

    print(f"\n[Mode active: {mode.upper()}]")
    print_help(brain)

    while True:
        try:
            curr_target = brain.get_current_model()
            user_input = ""

            if mode == "voice":
                print(f"\n[{curr_target}] Press ENTER to speak (or type command / 'mode'): ", end="")
                user_trigger = input().strip()
                if user_trigger.lower() in ["mode", "switch"]:
                    mode = "text"
                    print("[Switched to TEXT mode]")
                    continue
                elif user_trigger.lower() in ["exit", "quit", "q"]:
                    break
                elif user_trigger:
                    user_input = user_trigger
                else:
                    user_input = listen_mic()
                    if not user_input:
                        continue
            else:
                user_input = input(f"\nYou [{curr_target}] > ").strip()

            if not user_input:
                continue

            cmd_lower = user_input.lower().strip()

            # Global commands
            if cmd_lower in ["exit", "quit", "bye", "shutdown"]:
                speak("Shutting down core protocols. Have a pleasant day, sir.", voice=JARVIS_VOICE)
                break

            elif cmd_lower in ["mode", "switch mode"]:
                mode = "voice" if mode == "text" else "text"
                print(f"[Switched to {mode.upper()} mode]")
                speak(f"Switched to {mode} mode, sir.", voice=JARVIS_VOICE)
                continue

            elif cmd_lower in ["network", "net", "ping"]:
                net_info = get_network_telemetry()
                res = f"Network telemetry: Status is {net_info['status']}, Latency: {net_info['latency_ms']}."
                speak(res, voice=JARVIS_VOICE)
                continue

            elif cmd_lower.startswith("route "):
                policy = cmd_lower.replace("route ", "").strip()
                msg = brain.set_routing_policy(policy)
                speak(msg, voice=JARVIS_VOICE)
                continue

            elif cmd_lower in ["sync", "sync cloud", "synchronize"]:
                print("[Sync] Synchronizing memory cache with cloud backend...")
                res = sync_service.sync_now()
                msg = res.get("message") or res.get("reason", "Sync finished.")
                speak(msg, voice=JARVIS_VOICE)
                continue

            elif cmd_lower.startswith("remember "):
                fact = user_input[9:].strip()
                parts = fact.split(" is ", 1) if " is " in fact else fact.split(":", 1)
                if len(parts) == 2:
                    k, v = parts[0].strip(), parts[1].strip()
                else:
                    k, v = "general_note", fact
                msg = memory_manager.remember(k, v)
                speak(msg, voice=JARVIS_VOICE)
                continue

            elif cmd_lower.startswith("recall "):
                query = user_input[7:].strip()
                msg = memory_manager.recall(query)
                speak(msg, voice=JARVIS_VOICE)
                continue

            elif cmd_lower in ["model", "models", "select model"]:
                handle_model_menu(brain)
                continue

            elif cmd_lower in ["stats", "system stats", "telemetry"]:
                stats = get_system_status()
                response = (
                    f"System diagnostic: CPU is at {stats['cpu_usage_percent']}, "
                    f"Memory usage is {stats['memory_percent']}, and battery is {stats['battery']}."
                )
                speak(response, voice=JARVIS_VOICE)
                continue

            # Query the Hybrid Brain Router
            print(f"[Routing query via {brain.get_current_model()}...]")
            response = brain.ask(user_input)

            # Verbalize response
            speak(response, voice=JARVIS_VOICE)

        except KeyboardInterrupt:
            print("\n[Exiting...]")
            speak("Goodbye, sir.", voice=JARVIS_VOICE)
            break
        except Exception as e:
            print(f"[Runtime Error]: {e}")
            time.sleep(1)

def run_daemon_mode():
    """
    Daemon mode: Initializes J.A.R.V.I.S. background services.
    - JarvisBrain: NLU and command routing
    - SystemMonitor: Tracks CPU, memory, battery (background thread)
    - AudioListener: Monitors for wake words (ready to start)
    - GuiOperator: GUI automation capabilities (singleton)
    - TaskExecutor: Emergency stop and task execution framework
    
    All services initialized and running in background threads with graceful shutdown.
    """
    print(BANNER)
    print("Initializing J.A.R.V.I.S. in DAEMON MODE (Background Services)...")
    
    startup_time = time.time()
    
    try:
        # 1. Initialize Hybrid Brain once for daemon
        print("[Daemon] Initializing Hybrid Brain...")
        brain = JarvisBrain()
        print("[Daemon] ✓ Brain initialized (routing policy: auto)")
        
        # 2. Initialize SystemMonitor in background thread
        print("[Daemon] Initializing System Monitor...")
        monitor = SystemMonitor(check_interval=5.0)
        monitor.start_monitoring()
        print("[Daemon] ✓ System Monitor started (background thread)")
        
        # 3. Initialize and START AudioListener for voice commands
        print("[Daemon] Initializing Audio Listener...")
        listener = AudioListener(brain=brain, sensitivity=0.5)
        listener.start_listening()  # START listening for wake-word!
        print("[Daemon] ✓ Audio Listener started (listening for 'Jarvis' wake-word)")
        
        # 4. Initialize GuiOperator (singleton for GUI automation)
        print("[Daemon] Initializing GUI Operator...")
        gui = GuiOperator.get_instance()
        print("[Daemon] ✓ GUI Operator initialized (screenshot, mouse, keyboard, browser)")
        
        # 5. Verify TaskExecutor interrupt mechanism
        print("[Daemon] Verifying Emergency Stop mechanism...")
        task_executor.clear_interrupt()
        if not task_executor.is_interrupted():
            print("[Daemon] ✓ Emergency stop mechanism ready")
        
        startup_elapsed = time.time() - startup_time
        print(f"\n[Daemon] ✓ All modules initialized in {startup_elapsed:.2f}s")
        print("[Daemon] Module Status:")
        print(f"  - Brain: {brain.get_current_model()}")
        print(f"  - Monitor: running (background)")
        print(f"  - Listener: {listener.get_config().status}")
        print(f"  - GuiOperator: singleton ready")
        print(f"  - TaskExecutor: interrupt mechanism active")
        
        greeting = "Daemon protocols activated, sir. Standing by for system events and voice commands."
        speak(greeting, voice=JARVIS_VOICE)
        print("[Daemon] All background services are active. Press Ctrl+C to stop.\n")
        
        # Keep daemon alive indefinitely
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[Daemon] Shutting down background services...")
            
            # Graceful shutdown sequence
            shutdown_start = time.time()
            task_executor.set_interrupt()
            monitor.stop_monitoring()
            listener.stop_listening()
            task_executor.clear_interrupt()
            
            shutdown_elapsed = time.time() - shutdown_start
            
            speak("Shutting down daemon protocols. Goodbye, sir.", voice=JARVIS_VOICE)
            print(f"[Daemon] ✓ Shutdown completed in {shutdown_elapsed:.3f}s")
            sys.exit(0)
    except Exception as e:
        print(f"[Daemon Error]: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="J.A.R.V.I.S. Hybrid AI Desktop Assistant",
        prog="jarvis"
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Run in daemon mode (background services with system monitoring)"
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Run in interactive mode (default if no --daemon flag)"
    )
    
    args = parser.parse_args()
    
    # Default to interactive if no flags specified
    if args.daemon:
        run_daemon_mode()
    else:
        main()

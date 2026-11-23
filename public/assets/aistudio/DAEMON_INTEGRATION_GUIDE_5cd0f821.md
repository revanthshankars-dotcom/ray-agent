# J.A.R.V.I.S. Daemon Mode Integration Guide

## Overview

This document describes the integration of all autonomous executor modules in daemon mode, including the initialization sequence, thread safety guarantees, and module interaction flow.

## Daemon Mode Startup

### Command

```bash
python main.py --daemon
```

### Initialization Sequence (Target: <2 seconds)

1. **JarvisBrain** - Hybrid NLU and command router
   - Initializes cloud/local model routing policy
   - Sets up cloud API client (Gemini)
   - Starts background sync daemon
   - **Result:** Callable `brain.parse_capabilities(command)` available

2. **SystemMonitor** - Hardware telemetry collector
   - Starts in background daemon thread
   - Collects metrics every 5 seconds (configurable)
   - Monitors CPU, memory, disk, battery, GPU, network
   - Detects resource hogs (>50% CPU for 10+ seconds)
   - **Thread:** `SystemMonitorThread` (daemon=True)

3. **AudioListener** - Voice command listener
   - Initializes Porcupine wake word engine (if available)
   - Falls back to string matching for wake words: ["jarvis", "hey jarvis"]
   - Configures sensitivity (0.0-1.0, default 0.5)
   - **Status:** Ready but not started (awaiting manual trigger or tray button)

4. **GuiOperator** - GUI automation controller
   - Singleton initialization with graceful fallbacks
   - Screenshot: mss → PIL.ImageGrab → placeholder
   - Mouse/keyboard: PyAutoGUI
   - Browser automation: Playwright
   - **Thread Safety:** All operations protected by RLock

5. **TaskExecutor** - Task execution framework
   - Verifies emergency stop mechanism (`is_interrupted()`)
   - Thread-safe interrupt flag initialized and cleared
   - Ready for multi-step capability execution

### Startup Output Example

```
J.A.R.V.I.S. DAEMON MODE Initialization
[Daemon] Initializing Hybrid Brain...
[Daemon] ✓ Brain initialized (routing policy: auto)
[Daemon] Initializing System Monitor...
[Daemon] ✓ System Monitor started (background thread)
[Daemon] Initializing Audio Listener...
[Daemon] ✓ Audio Listener initialized (ready, not started)
[Daemon] Initializing GUI Operator...
[Daemon] ✓ GUI Operator initialized (screenshot, mouse, keyboard, browser)
[Daemon] Verifying Emergency Stop mechanism...
[Daemon] ✓ Emergency stop mechanism ready

[Daemon] ✓ All modules initialized in 1.23s
[Daemon] Module Status:
  - Brain: Gemini-2.0-Flash (auto-routing)
  - Monitor: running (background)
  - Listener: idle
  - GuiOperator: singleton ready
  - TaskExecutor: interrupt mechanism active
[Daemon] All background services are active. Press Ctrl+C to stop.
```

## Module Interaction Flow

### 1. Voice Command Execution Flow

```
┌─────────────────────────────────────────────────────┐
│ User speaks: "Open Chrome and search SpaceX"        │
└─────────────────────────────────────────────────────┘
                      ↓
        ┌─────────────────────────────┐
        │ AudioListener detects wake  │
        │ word "Jarvis"               │
        └─────────────────────────────┘
                      ↓
        ┌─────────────────────────────┐
        │ listen_mic() captures full  │
        │ command text                │
        └─────────────────────────────┘
                      ↓
        ┌─────────────────────────────────────────┐
        │ brain.parse_capabilities(command)       │
        │ Returns: [                              │
        │   {"capability_name": "open_app",       │
        │    "input_data": {"app_name": "Chrome"}},│
        │   {"capability_name": "search_web",     │
        │    "input_data": {"query": "SpaceX"}}   │
        │ ]                                       │
        └─────────────────────────────────────────┘
                      ↓
        ┌──────────────────────────────────────────┐
        │ TaskExecutor.execute_task_with_interrupt │
        │ For each capability:                      │
        │  - Check is_interrupted()                │
        │  - Execute (open_app, search_web, etc)  │
        │  - Capture pre/post metrics             │
        │  - Assess performance impact            │
        └──────────────────────────────────────────┘
                      ↓
        ┌─────────────────────────────────────────┐
        │ For GUI operations:                      │
        │  - GuiOperator methods called            │
        │  - Click, type, navigate, screenshot     │
        │  - All thread-safe (RLock protected)     │
        └─────────────────────────────────────────┘
                      ↓
        ┌──────────────────────────────────────────┐
        │ SystemMonitor collects post-task metrics │
        │ Compare CPU/RAM before/after             │
        │ Report impact: "improved", "neutral",    │
        │ "degraded"                               │
        └──────────────────────────────────────────┘
                      ↓
        ┌─────────────────────────────────────────┐
        │ Result returned to user via speak()      │
        │ Listening resumes                        │
        └─────────────────────────────────────────┘
```

### 2. Emergency Stop Flow (Interrupt Mechanism)

```
Tray Button "⏹️ Stop Current Task"
            ↓
task_executor.set_interrupt()  ← Sets threading.Event
            ↓
All running loops check: is_interrupted()
            ↓
┌─────────────────────────────────────────┐
│ Each capability execution loop:         │
│  for capability in capabilities:        │
│    if is_interrupted():                 │
│      return ExecutionResult(             │
│        status='cancelled',              │
│        reason='User interrupted'        │
│      )                                  │
│    # execute capability...              │
└─────────────────────────────────────────┘
            ↓
task_executor.clear_interrupt()  ← Reset flag
            ↓
Return to idle, listening resumes
```

### 3. Background Monitoring Flow

```
SystemMonitor Background Thread (every 5 seconds):
            ↓
get_current_metrics() ──┬→ CPU usage
                       ├→ Memory usage
                       ├→ Disk usage
                       ├→ Battery level
                       ├→ Temperature
                       ├→ GPU usage
                       └→ Network stats
            ↓
analyze_resource_hogs()
  ├→ Detect CPU > 50% for 10+ seconds
  ├→ Detect Memory > 30% for 10+ seconds
  └→ Generate ResourceHogAlert
            ↓
get_battery_status()
  ├→ Current charge %
  ├→ Drain rate (% per hour)
  ├→ Time to empty
  ├→ Health assessment
  └→ User recommendations
            ↓
Store in metrics_history and alerts deques
(kept in memory, max 720 metrics, 100 alerts)
```

## Thread Safety Guarantees

### 1. SystemMonitor

**Protected:** All metric access, alert storage, hog tracking

```python
with self._lock:  # RLock
    self._metrics_history.append(metrics)
    self._alerts.append(alert)
```

**Concurrent Access:** Safe
- Multiple threads calling `get_current_metrics()` simultaneously: ✓
- Multiple threads reading alerts: ✓
- Main thread + monitoring thread: ✓

### 2. AudioListener

**Protected:** Listening state, command count, configuration

```python
with self._lock:  # RLock
    self._command_count += 1
    self._last_command = command
    self._listening = True/False
```

**Concurrent Access:** Safe
- Multiple calls to `get_config()`: ✓
- Concurrent config updates: ✓
- Wake word detection + audio capture: ✓

### 3. GuiOperator

**Protected:** Screenshot backend, mouse/keyboard operations, browser sessions

```python
with self._lock:  # RLock
    # screenshot, click, type, browser operations
```

**Concurrent Access:** Safe
- Multiple threads taking screenshots: ✓
- Concurrent mouse and keyboard operations: ✓
- Multiple browser sessions: ✓ (up to MAX_BROWSER_SESSIONS=5)

### 4. TaskExecutor

**Protected:** Interrupt flag state

```python
with _executor_lock:  # Lock
    _execution_interrupt_event.set()  # or .clear()
```

**Concurrent Access:** Safe
- Multiple checks to `is_interrupted()`: ✓
- Multiple calls to `set_interrupt()`: ✓ (idempotent)
- Multiple task executions: ✓ (each calls clear_interrupt())

## Backward Compatibility

### Interactive Mode (Existing)

```bash
python main.py
# or
python main.py --interactive
```

**Verification:**
- Existing `main()` function unchanged
- All interactive commands work as before
- User prompts, model selection, manual sync all functional
- Can still be imported and called from other scripts

### Daemon Mode (New)

```bash
python main.py --daemon
```

**Features:**
- All 4 modules initialized and ready
- No interactive prompts
- Background monitoring and listening
- Graceful shutdown on Ctrl+C

## Error Recovery (Graceful Degradation)

If a module fails during initialization, daemon continues with degraded capability:

### Scenario 1: AudioListener Initialization Fails

```
[Daemon] Initializing Audio Listener...
[ERROR] Porcupine initialization failed: API key missing
[RECOVERY] Falling back to string matching for wake words
[Daemon] ✓ Audio Listener initialized (string matching mode)
[RESULT] Daemon continues, voice commands have lower accuracy
```

### Scenario 2: GuiOperator Screenshot Backend Unavailable

```
[GuiOperator] Initializing screenshot backend...
[ERROR] MSS not available
[RECOVERY] Trying PIL.ImageGrab...
[ERROR] PIL not available
[FALLBACK] Using placeholder screenshots
[RESULT] GUI automation available but screenshots are placeholders
```

### Scenario 3: SystemMonitor Temperature Sensor Unavailable

```
[SystemMonitor] Getting CPU temperature...
[ERROR] sensors_temperatures() not available
[RECOVERY] Graceful fallback to None
[RESULT] Metrics collected without temperature
```

## Graceful Shutdown Sequence

### On Ctrl+C:

```
User presses Ctrl+C
            ↓
KeyboardInterrupt caught in main loop
            ↓
Set interrupt signal: task_executor.set_interrupt()
            ↓
Stop monitoring: monitor.stop_monitoring()
            ├─ Waits for background thread to finish (timeout 2s)
            └─ Cleanup complete
            ↓
Stop listening: listener.stop_listening()
            └─ Cleanup Porcupine resources
            ↓
Clear interrupt: task_executor.clear_interrupt()
            ↓
Speak goodbye message
            ↓
sys.exit(0) ← Clean exit
```

**Target:** Shutdown completes in < 1 second

## Testing

### Unit Tests

Run module-specific tests:

```bash
python test_imports_daemon.py       # Module imports and basic init
python test_system_monitor.py       # Monitor-specific tests
python test_audio_listener.py       # Listener-specific tests
python test_gui_operator.py         # GUI-specific tests
python test_backward_compat.py      # Interactive mode tests
```

### Integration Test

Run full integration suite:

```bash
python test_integration.py
```

**Coverage:**
- Module imports (all 5 modules)
- Brain.parse_capabilities() method
- SystemMonitor thread safety and background operation
- AudioListener configuration and state
- GuiOperator initialization and fallbacks
- TaskExecutor emergency stop mechanism
- Daemon mode startup performance (<2s)
- Error recovery and graceful degradation
- Graceful shutdown (<1s)
- Backward compatibility with interactive mode
- Concurrent module operations
- Module interaction flow

## Deployment Checklist

- [ ] All modules import without errors
- [ ] Daemon startup completes in < 2 seconds
- [ ] All modules report "ready" status
- [ ] SystemMonitor runs in background thread
- [ ] AudioListener ready (not started)
- [ ] GuiOperator singleton initialized
- [ ] TaskExecutor interrupt mechanism verified
- [ ] Brain.parse_capabilities() works
- [ ] Graceful shutdown on Ctrl+C completes in < 1 second
- [ ] Interactive mode still works (`python main.py`)
- [ ] Thread safety verified under concurrent load
- [ ] Error recovery tested (disable one module at a time)

## Configuration

### Environment Variables

```bash
# Audio
export PORCUPINE_ACCESS_KEY=<your_api_key>
export JARVIS_VOICE=en-US-AriaNeural

# Brain
export GEMINI_API_KEY=<your_api_key>

# Google Cloud STT
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service_account.json

# GUI
export JARVIS_GUI_DEBUG=true  # Enable debug logging
```

### Code Configuration

In `main.py`, modify `run_daemon_mode()`:

```python
# SystemMonitor check interval (seconds)
monitor = SystemMonitor(check_interval=5.0)  # default 5s

# AudioListener sensitivity (0.0-1.0)
listener = AudioListener(brain=brain, sensitivity=0.5)  # default 0.5
```

## Future Enhancements

- [ ] Tray icon with menu buttons for manual control
- [ ] Configuration file for environment variables
- [ ] Web dashboard for monitoring
- [ ] Task scheduling and automation
- [ ] Multi-user support with profile switching
- [ ] Advanced analytics and reporting
- [ ] Integration with calendar and notification systems

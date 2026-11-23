# ProcessManager Module - Usage Guide

## Overview

The `ProcessManager` module provides safe, controlled termination of resource-hogging processes with built-in protection for critical Windows system processes.

## Installation

No additional installation required - uses `psutil` which is already in `requirements.txt`.

## Basic Usage

### Import

```python
from core.process_manager import ProcessManager, TerminationStrategy
```

### Initialize

```python
# Default: 5-second graceful termination timeout
pm = ProcessManager()

# Custom timeout (in seconds)
pm = ProcessManager(graceful_timeout_seconds=10.0)
```

## Core Methods

### Get Running Processes

```python
# Get all processes, sorted by CPU usage (default)
processes = pm.get_running_processes(sort_by="cpu")

# Sort by memory instead
processes = pm.get_running_processes(sort_by="memory")

# Sort by name
processes = pm.get_running_processes(sort_by="name")

for proc in processes[:5]:  # Top 5 processes
    print(f"{proc.name} (PID {proc.pid}): CPU {proc.cpu_percent:.1f}%, Mem {proc.memory_percent:.1f}%")
```

### Get Process Info

```python
# By PID
info = pm.get_process_info(1234)

# By name
info = pm.get_process_info("python.exe")

if info:
    print(f"Process: {info.name}")
    print(f"CPU: {info.cpu_percent:.1f}%")
    print(f"Memory: {info.memory_mb:.1f} MB")
    print(f"Status: {info.status}")
```

### Check if Process is Protected

```python
# Protected processes cannot be terminated (safelist)
if pm.is_process_protected("explorer.exe"):
    print("Cannot terminate - process is protected")

if pm.is_process_protected(1234):
    print("Cannot terminate - PID is protected")
```

### Terminate Processes

```python
from core.process_manager import TerminationStrategy

# Graceful termination (SIGTERM + 5-second timeout, then SIGKILL if needed)
result = pm.terminate_process("notepad.exe", TerminationStrategy.GRACEFUL)

# Force kill (immediate SIGKILL)
result = pm.terminate_process(1234, TerminationStrategy.FORCE)

# Request admin escalation (for permission-denied scenarios)
result = pm.terminate_process("myapp.exe", TerminationStrategy.ESCALATE)

# Check result
if result.success:
    print(f"✓ Successfully terminated {result.process_name}")
else:
    print(f"✗ Failed: {result.reason}")
    if result.admin_needed:
        print("  Admin escalation required")
```

### Get Termination Recommendations

```python
# Get recommendations for resource-hogging processes
recommendations = pm.recommend_terminations(
    cpu_threshold_percent=80.0,      # Flag processes using >80% CPU
    memory_threshold_percent=80.0,   # Flag processes using >80% memory
    sustained_seconds=30.0           # How long usage must be sustained
)

for rec in recommendations:
    print(f"{rec.priority.upper()}: {rec.name} (PID {rec.pid})")
    print(f"  {rec.reason}")
```

### Check Termination History

```python
# Get last 20 termination operations
history = pm.get_termination_history(limit=20)

for op in history:
    print(f"{op.timestamp}: {op.process_name} - {op.reason}")
```

## Protected Processes (Safelist)

The following processes are protected and cannot be terminated:

- **System**: system, csrss.exe, smss.exe, services.exe, svchost.exe, lsass.exe
- **Core**: explorer.exe (Windows Explorer), dwm.exe (Desktop Window Manager)
- **Jarvis**: python.exe, jarvis.exe, tray.py
- **Task Management**: taskmgr.exe
- **Browsers**: chrome.exe, firefox.exe, msedge.exe
- **Applications**: notepad.exe, code.exe
- **Office**: winword.exe, excel.exe, powerpnt.exe, outlook.exe

## Integration Examples

### With SystemMonitor

```python
# In system_monitor.py or task_executor.py
from core.process_manager import ProcessManager

pm = ProcessManager()

# When SystemMonitor detects resource hogs
recommendations = pm.recommend_terminations(
    cpu_threshold_percent=90.0,
    memory_threshold_percent=85.0
)

for rec in recommendations:
    if rec.priority == "high":
        # Attempt graceful termination
        result = pm.terminate_process(rec.pid, TerminationStrategy.GRACEFUL)
        if result.success:
            print(f"Terminated resource hog: {rec.name}")
```

### With TaskExecutor

```python
# In task_executor.py for autonomous task management
from core.process_manager import ProcessManager, TerminationStrategy

def cleanup_resources():
    pm = ProcessManager()
    
    # Get all processes using significant resources
    procs = pm.get_running_processes(sort_by="cpu")
    
    for proc in procs:
        if proc.cpu_percent > 85 and not pm.is_process_protected(proc.pid):
            # This is a resource hog and not protected
            result = pm.terminate_process(proc.pid)
            if result.admin_needed:
                # Log for admin action
                print(f"Admin escalation needed for {proc.name}")
```

## Data Structures

### ProcessInfo
```python
@dataclass
class ProcessInfo:
    pid: int                    # Process ID
    name: str                   # Process name
    cpu_percent: float          # CPU usage (0-100%)
    memory_percent: float       # Memory usage (0-100%)
    memory_mb: float            # Memory in MB
    status: str                 # Process status
    create_time: float          # Unix timestamp of creation
```

### TerminationResult
```python
@dataclass
class TerminationResult:
    success: bool               # Whether termination succeeded
    process_name: str           # Name of the process
    pid: int                    # Process ID
    reason: str                 # Why it succeeded/failed
    admin_needed: bool          # Whether admin escalation is needed
    timestamp: str              # ISO 8601 timestamp
```

### RecommendedTermination
```python
@dataclass
class RecommendedTermination:
    pid: int                    # Process ID to terminate
    name: str                   # Process name
    cpu_percent: float          # CPU usage %
    memory_percent: float       # Memory usage %
    reason: str                 # Why it's recommended
    priority: str               # "low", "medium", or "high"
```

## Error Handling

The module handles errors gracefully:

```python
# Non-existent process - returns result with success=False
result = pm.terminate_process("nonexistent_app_xyz.exe")
assert not result.success
assert "not found" in result.reason.lower()

# Protected process - blocks termination
result = pm.terminate_process("explorer.exe")
assert not result.success
assert "protected" in result.reason.lower()

# Permission denied - marks admin escalation needed
# (typically happens when low-privilege process tries to terminate high-privilege process)
# result.admin_needed would be True
```

## Logging

All operations are logged to the Python logger:

```
[ProcessManager] Initialized with 21 protected processes
[ProcessManager] Sent SIGTERM to myapp.exe (PID 1234)
[ProcessManager] Successfully terminated myapp.exe (PID 1234)
[ProcessManager] Generated 3 termination recommendations
```

## Thread Safety

The module is thread-safe for concurrent operations:

```python
import threading

pm = ProcessManager()

def worker():
    pm.get_running_processes()
    pm.recommend_terminations()

# Safe to call from multiple threads
threads = [threading.Thread(target=worker) for _ in range(10)]
for t in threads:
    t.start()
for t in threads:
    t.join()
```

## Performance

- Minimal overhead on system resources
- Process enumeration takes ~100-200ms
- Recommendation generation takes ~200-300ms
- Graceful termination timeout default: 5 seconds (configurable)

## Limitations

- Admin escalation is flagged but not automatically performed
- Force kill on Windows uses SIGKILL (TerminateProcess)
- Some system processes cannot be terminated even with admin privileges
- Protected list is hardcoded (use case-insensitive matching)

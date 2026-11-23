# J.A.R.V.I.S. Capability Registry Documentation

## Overview

The **Capability Registry** (`core/capabilities.py`) provides a comprehensive, extensible framework for managing all of Jarvis's actions and tasks. It defines 15+ core capabilities organized by category, with built-in safety levels, input validation, and execution control.

## Architecture

### Core Components

1. **Capability**: Data structure defining a single capability with metadata
2. **CapabilityStatus**: Enum for execution outcomes (success, error, validation_error, requires_confirmation, not_available)
3. **SafetyLevel**: Risk classification (safe, moderate, sensitive)
4. **InputSchema**: Defines valid parameters for a capability
5. **InputValidator**: Validates inputs against schemas
6. **CapabilityRegistry**: Central manager for capabilities
7. **CapabilityHandlers**: Implementation of all 15 core capabilities

## Core Capabilities (15+)

### Application Control

#### 1. `open_application`
Launch an application by name.

**Parameters:**
- `app_name` (string, required): Application name
  - Allowed: `chrome`, `firefox`, `notepad`, `vscode`, `explorer`, `cmd`, `powershell`, `calc`

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("open_application", {"app_name": "chrome"})
```

**Response:**
```json
{
  "success": true,
  "message": "Launched chrome",
  "executable": "chrome.exe"
}
```

---

#### 2. `close_application`
Gracefully close an application by name.

**Parameters:**
- `app_name` (string, required): Application name
  - Allowed: `chrome`, `firefox`, `notepad`, `vscode`, `explorer`, `cmd`, `powershell`, `calc`

**Safety Level:** MODERATE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("close_application", {"app_name": "notepad"})
```

---

#### 3. `kill_process`
Forcefully terminate a process by name or PID.

**Parameters:**
- `process_identifier` (string, required): Process name (e.g., `chrome.exe`) or PID (e.g., `1234`)

**Safety Level:** SENSITIVE
**Confirmation Required:** Yes

**Example:**
```python
result = registry.execute(
    "kill_process",
    {"process_identifier": "chrome.exe"},
    skip_confirmation=True  # Only if user approved
)
```

---

### System Control

#### 4. `adjust_volume`
Adjust system volume level.

**Parameters:**
- `level` (number, required): Volume level (0-100)

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("adjust_volume", {"level": 75})
```

---

#### 5. `adjust_brightness`
Adjust screen brightness level (Windows).

**Parameters:**
- `level` (number, required): Brightness level (0-100)

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("adjust_brightness", {"level": 50})
```

---

#### 6. `check_battery_status`
Check battery percentage, charging status, and estimated time remaining.

**Parameters:** None

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("check_battery_status", {})
```

**Response:**
```json
{
  "success": true,
  "percent": 72,
  "plugged": false,
  "seconds_left": 3600,
  "time_remaining": "1h 0m"
}
```

---

#### 7. `check_cpu_status`
Check CPU usage, memory usage, and identify top resource-consuming processes.

**Parameters:** None

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("check_cpu_status", {})
```

**Response:**
```json
{
  "success": true,
  "cpu_percent": 45.2,
  "memory_percent": 62.1,
  "memory_available_mb": 4096.5,
  "memory_used_mb": 7168.3,
  "top_processes": [
    {
      "pid": 1234,
      "name": "chrome.exe",
      "cpu_percent": 35.0,
      "memory_percent": 18.5
    }
  ]
}
```

---

#### 8. `optimize_system`
Optimize system by identifying resource hogs and clearing temporary files.

**Parameters:** None

**Safety Level:** MODERATE
**Confirmation Required:** Yes

**Example:**
```python
result = registry.execute(
    "optimize_system",
    {},
    skip_confirmation=True
)
```

**Response:**
```json
{
  "success": true,
  "actions": [
    "Detected 3 resource-heavy processes",
    "Cleared 157 temp files"
  ],
  "resource_hogs": [
    {"pid": 1234, "name": "chrome.exe", "cpu_percent": 50.0}
  ]
}
```

---

### GUI Automation

#### 9. `take_screenshot`
Capture a screenshot of the current screen.

**Parameters:** None

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("take_screenshot", {})
```

**Response:**
```json
{
  "success": true,
  "message": "Screenshot captured",
  "filepath": "C:\\Users\\User\\AppData\\Local\\Temp\\jarvis_screenshot_20231115_143022.png",
  "width": 1920,
  "height": 1080
}
```

---

#### 10. `click_at`
Click at specific screen coordinates.

**Parameters:**
- `x` (number, required): X coordinate (must be ≥ 0)
- `y` (number, required): Y coordinate (must be ≥ 0)

**Safety Level:** MODERATE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("click_at", {"x": 500, "y": 300})
```

---

#### 11. `type_text`
Type text using keyboard.

**Parameters:**
- `text` (string, required): Text to type (max 1000 chars)

**Safety Level:** MODERATE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("type_text", {"text": "Hello, World!"})
```

---

### Browser Automation

#### 12. `search_web`
Search the web using DuckDuckGo and return top results.

**Parameters:**
- `query` (string, required): Search query (max 500 chars)

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("search_web", {"query": "python asyncio tutorial"})
```

**Response:**
```json
{
  "success": true,
  "message": "Found 5 results for: python asyncio tutorial",
  "query": "python asyncio tutorial",
  "result_count": 5,
  "results": [
    {
      "title": "Python asyncio Documentation",
      "href": "https://docs.python.org/3/library/asyncio.html",
      "body": "The asyncio module provides infrastructure for writing single-threaded concurrent code..."
    }
  ]
}
```

---

#### 13. `navigate_to_url`
Open a URL in the default web browser.

**Parameters:**
- `url` (string, required): URL to navigate to

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute("navigate_to_url", {"url": "https://www.google.com"})
```

---

#### 14. `play_media`
Play audio or video from a URL or file path.

**Parameters:**
- `url_or_path` (string, required): URL or file system path to media

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
# From URL
result = registry.execute("play_media", {"url_or_path": "https://www.youtube.com/watch?v=..."})

# From file
result = registry.execute("play_media", {"url_or_path": "C:\\Music\\song.mp3"})
```

---

### User Notifications

#### 15. `send_notification`
Send a system notification to the user.

**Parameters:**
- `title` (string, required): Notification title (max 100 chars)
- `message` (string, required): Notification message (max 500 chars)

**Safety Level:** SAFE
**Confirmation Required:** No

**Example:**
```python
result = registry.execute(
    "send_notification",
    {
        "title": "System Update",
        "message": "Your system is running optimally"
    }
)
```

---

## Usage Guide

### Basic Usage

```python
from core.capabilities import get_capability_registry

# Get the global registry
registry = get_capability_registry()

# Execute a capability
result = registry.execute("check_cpu_status", {})

# Check result
print(result.status)  # CapabilityStatus.SUCCESS
print(result.result)  # Dict with CPU/memory data
print(result.error)   # None if successful
```

### Integration with TaskExecutor

```python
from core.task_executor import execute_capability

# Execute via task executor
result = execute_capability("adjust_volume", {"level": 75})
print(result["status"])  # "success" or "error"
```

### Listing Capabilities

```python
registry = get_capability_registry()

# List all capabilities
all_caps = registry.list_all()

# List by category
system_caps = registry.list_by_category("system")

# List available capabilities
available = registry.list_available()

# Get all categories
categories = registry.list_categories()  # ["application", "system", "gui", "browser", "notification"]
```

### Getting Capability Metadata

```python
registry = get_capability_registry()

# Get specific capability
cap = registry.get("adjust_volume")

print(cap.name)                    # "adjust_volume"
print(cap.description)              # "Adjust system volume level"
print(cap.category)                # "system"
print(cap.safety_level.value)       # "safe"
print(cap.requires_confirmation)   # False
print(cap.input_schema)            # Dict of InputSchema objects
```

### Input Validation

```python
from core.capabilities import InputValidator

registry = get_capability_registry()
cap = registry.get("adjust_volume")

# Validate inputs
inputs = {"level": 50}
valid, error = InputValidator.validate(inputs, cap.input_schema)

if valid:
    result = registry.execute("adjust_volume", inputs)
else:
    print(f"Validation error: {error}")
```

### Handling Confirmations

```python
# Try without confirmation (will return REQUIRES_CONFIRMATION)
result = registry.execute("kill_process", {"process_identifier": "test.exe"})
if result.status == CapabilityStatus.REQUIRES_CONFIRMATION:
    # Ask user for confirmation...
    user_approved = input("Confirm killing process? (y/n): ").lower() == 'y'
    
    if user_approved:
        # Execute with confirmation skipped
        result = registry.execute(
            "kill_process",
            {"process_identifier": "test.exe"},
            skip_confirmation=True
        )
```

### Error Handling

```python
from core.capabilities import CapabilityStatus

result = registry.execute("open_application", {"app_name": "chrome"})

match result.status:
    case CapabilityStatus.SUCCESS:
        print(f"Success: {result.result}")
    case CapabilityStatus.VALIDATION_ERROR:
        print(f"Invalid input: {result.error}")
    case CapabilityStatus.NOT_AVAILABLE:
        print(f"Not available: {result.error}")
    case CapabilityStatus.REQUIRES_CONFIRMATION:
        print(f"Needs approval: {result.error}")
    case CapabilityStatus.ERROR:
        print(f"Failed: {result.error}")
```

### Serialization to JSON

```python
import json

registry = get_capability_registry()

# Export all capabilities as JSON
registry_json = json.dumps(registry.to_dict(), indent=2)

# Also available per capability
cap = registry.get("check_cpu_status")
cap_json = json.dumps(cap.to_dict(), indent=2)
```

## Extending the Registry

### Adding Custom Capabilities

```python
from core.capabilities import (
    get_capability_registry,
    Capability,
    InputSchema,
    SafetyLevel,
)

def my_custom_handler(param1: str, param2: int) -> dict:
    """Custom capability implementation."""
    return {
        "success": True,
        "message": f"Processed {param1} with {param2}"
    }

# Create capability
custom_cap = Capability(
    name="my_custom_capability",
    description="A custom capability that does something special",
    category="custom",
    input_schema={
        "param1": InputSchema(
            type="string",
            required=True,
            description="First parameter",
        ),
        "param2": InputSchema(
            type="number",
            required=True,
            description="Second parameter",
            validation_rules={"min_value": 0, "max_value": 100},
        ),
    },
    requires_confirmation=False,
    safety_level=SafetyLevel.SAFE,
    handler=my_custom_handler,
)

# Register it
registry = get_capability_registry()
registry.register(custom_cap)

# Now you can use it
result = registry.execute("my_custom_capability", {"param1": "hello", "param2": 42})
```

## Safety Levels

### SAFE
- No impact on system state
- Can execute without user confirmation
- Examples: `check_cpu_status`, `take_screenshot`, `search_web`

### MODERATE
- May affect system state (volume, brightness)
- User should be aware but doesn't require confirmation
- Examples: `adjust_volume`, `adjust_brightness`, `click_at`, `type_text`

### SENSITIVE
- Significant system impact (process termination)
- Requires explicit user confirmation before execution
- Examples: `kill_process`, `optimize_system`

## Thread Safety

All operations are thread-safe via internal locking:

```python
import threading

registry = get_capability_registry()

def worker():
    result = registry.execute("check_cpu_status", {})
    print(result.status)

# Safe to call from multiple threads
threads = [threading.Thread(target=worker) for _ in range(10)]
for t in threads:
    t.start()
for t in threads:
    t.join()
```

## Testing

### Running Tests

```bash
# Run comprehensive test suite (15 test categories)
python test_capabilities.py

# Quick verification
python verify_capabilities.py
```

### Test Coverage

1. Registry initialization with all 15 capabilities
2. Capability metadata completeness
3. Input schema validation
4. Capability categorization
5. Safe capability execution
6. Validation error handling
7. Confirmation requirements
8. Safety level enforcement
9. JSON serialization
10. Extensibility (custom capabilities)
11. Execution timing tracking
12. Handler error handling
13. Callable verification
14. Thread safety (concurrent execution)
15. Documentation completeness

## Error Handling

The registry provides graceful error handling for:

- **Invalid inputs**: Returns `VALIDATION_ERROR` with descriptive message
- **Missing capabilities**: Returns `ERROR` with "not found" message
- **Unavailable capabilities**: Returns `NOT_AVAILABLE` with reason
- **Confirmation required**: Returns `REQUIRES_CONFIRMATION` - user must approve
- **Handler exceptions**: Caught and logged, returns `ERROR` with exception message
- **Missing handlers**: Returns `ERROR` with "no handler defined"

## Performance

- Registry initialization: < 10ms
- Input validation: < 1ms per capability
- Safe operations (read-only): < 10ms
- Moderate operations (system control): 10-100ms
- Sensitive operations (optimization): 100ms-1s

## Future Enhancements

Possible additions to the capability registry:

1. **File System Operations**: read_file, write_file, delete_file, list_directory
2. **Email/Communication**: send_email, read_emails, send_sms
3. **API Integration**: make_http_request, call_webhook, interact_with_cloud_services
4. **Advanced GUI**: object_detection, element_finder, multi_step_workflows
5. **Data Processing**: parse_csv, convert_format, analyze_data
6. **Scheduling**: create_scheduled_task, list_scheduled_tasks, cancel_task
7. **System Maintenance**: update_software, run_disk_cleanup, optimize_performance
8. **Recording/Playback**: record_screen, play_recording, create_macro

## Configuration

To customize capability behavior, modify environment variables:

```bash
# Enable debug logging
set JARVIS_GUI_DEBUG=true

# Disable specific capabilities (future)
set JARVIS_DISABLED_CAPABILITIES=kill_process,optimize_system
```

## Troubleshooting

### Capability Not Found
- Verify capability name is spelled correctly
- Check `registry.list_all()` for available capabilities
- Ensure custom capability is registered before use

### Validation Error
- Check parameter types match schema (string vs number)
- Verify numeric values are within allowed ranges
- Ensure all required parameters are provided

### Requires Confirmation
- Some capabilities are marked sensitive and require `skip_confirmation=True`
- Verify user approval is obtained before setting flag
- Check capability's `requires_confirmation` property

### Handler Error
- Check system requirements (e.g., Chrome installed for `open_application`)
- Verify permissions (e.g., admin rights for `kill_process`)
- Review logs for specific error messages

## License

Part of J.A.R.V.I.S. Assistant project.

---

**Last Updated:** November 2024
**Version:** 1.0.0
**Status:** Production Ready

# J.A.R.V.I.S. Capability Registry

## Quick Start

```python
from core.capabilities import get_capability_registry

# Get registry
registry = get_capability_registry()

# Execute a capability
result = registry.execute("check_cpu_status", {})
print(result.status)  # SUCCESS, ERROR, etc.
print(result.result)  # Capability output
```

## The 15 Capabilities at a Glance

| # | Capability | Category | Safety | Confirm |
|---|---|---|---|---|
| 1 | open_application | Application | SAFE | ❌ |
| 2 | close_application | Application | MODERATE | ❌ |
| 3 | kill_process | Application | SENSITIVE | ✅ |
| 4 | adjust_volume | System | SAFE | ❌ |
| 5 | adjust_brightness | System | SAFE | ❌ |
| 6 | check_battery_status | System | SAFE | ❌ |
| 7 | check_cpu_status | System | SAFE | ❌ |
| 8 | optimize_system | System | SENSITIVE | ✅ |
| 9 | take_screenshot | GUI | SAFE | ❌ |
| 10 | click_at | GUI | MODERATE | ❌ |
| 11 | type_text | GUI | MODERATE | ❌ |
| 12 | search_web | Browser | SAFE | ❌ |
| 13 | navigate_to_url | Browser | SAFE | ❌ |
| 14 | play_media | Browser | SAFE | ❌ |
| 15 | send_notification | Notification | SAFE | ❌ |

## Documentation

- **[CAPABILITIES_DOCUMENTATION.md](CAPABILITIES_DOCUMENTATION.md)** - Complete guide (800+ lines)
- **[CAPABILITY_IMPLEMENTATION_INDEX.md](CAPABILITY_IMPLEMENTATION_INDEX.md)** - Navigation index
- **[CAPABILITY_REGISTRY_SUMMARY.md](CAPABILITY_REGISTRY_SUMMARY.md)** - Implementation summary

## Examples

```python
# List all capabilities
registry = get_capability_registry()
all_caps = registry.list_all()
print(f"Available: {len(all_caps)}")

# List by category
system_caps = registry.list_by_category("system")

# Get capability metadata
cap = registry.get("adjust_volume")
print(cap.description)
print(cap.input_schema)

# Execute with validation
result = registry.execute("adjust_volume", {"level": 50})
if result.status.value == "success":
    print("Volume adjusted!")
else:
    print(f"Error: {result.error}")

# Handle confirmations
result = registry.execute("kill_process", {"process_identifier": "test.exe"})
if result.status.value == "requires_confirmation":
    # Ask user...
    result = registry.execute(
        "kill_process",
        {"process_identifier": "test.exe"},
        skip_confirmation=True
    )
```

## Via TaskExecutor

```python
from core.task_executor import execute_capability

result = execute_capability("adjust_volume", {"level": 75})
print(result["status"])
```

## Testing

```bash
# Full test suite
python test_capabilities.py

# Quick verification
python verify_capabilities.py

# Examples
python CAPABILITY_REGISTRY_EXAMPLE.py
```

## Features

✅ Type-safe input validation
✅ Safety level enforcement
✅ Confirmation requirements
✅ Thread-safe execution
✅ Error handling
✅ JSON serialization
✅ Extensible architecture
✅ Full documentation

## File Reference

| File | Purpose |
|------|---------|
| core/capabilities.py | Main implementation (1200 lines) |
| core/task_executor.py | Integration point |
| test_capabilities.py | Comprehensive tests |
| verify_capabilities.py | Quick check |
| CAPABILITIES_DOCUMENTATION.md | User guide |
| CAPABILITY_REGISTRY_EXAMPLE.py | 10 examples |
| CAPABILITY_IMPLEMENTATION_INDEX.md | Navigation |

## API Overview

### Get Registry
```python
from core.capabilities import get_capability_registry
registry = get_capability_registry()  # Singleton
```

### Execute Capability
```python
result = registry.execute(
    "capability_name",
    {"param1": value1, "param2": value2},
    skip_confirmation=False  # Only for confirmed ops
)
```

### Result Structure
```python
result.status          # CapabilityStatus enum
result.result          # Capability output (dict or None)
result.error           # Error message (if failed)
result.execution_time_ms  # Milliseconds taken
```

### List Operations
```python
registry.list_all()              # All 15 capabilities
registry.list_by_category("system")  # By category
registry.list_available()        # Available on system
registry.list_categories()       # All categories
```

### Get Metadata
```python
cap = registry.get("capability_name")
cap.name                 # Capability name
cap.description         # Human description
cap.category           # Category (system, application, gui, etc)
cap.safety_level       # SafetyLevel.SAFE/MODERATE/SENSITIVE
cap.requires_confirmation  # Boolean
cap.input_schema       # Dict of InputSchema objects
```

## Safety Levels

### 🟢 SAFE
Execute without confirmation. Examples:
- check_cpu_status
- take_screenshot
- search_web

### 🟡 MODERATE
Execute but inform user. Examples:
- adjust_volume
- click_at
- type_text

### 🔴 SENSITIVE
Requires explicit user confirmation. Examples:
- kill_process
- optimize_system

## Integration Points

1. **TaskExecutor**: `execute_capability()` function
2. **APIs**: Full JSON serialization support
3. **CLI**: Command-line tool ready
4. **Dashboard**: UI integration ready
5. **Custom**: Extensible with new capabilities

## Common Patterns

### Read System Status
```python
result = registry.execute("check_cpu_status", {})
if result.status.value == "success":
    print(f"CPU: {result.result['cpu_percent']}%")
    print(f"Memory: {result.result['memory_percent']}%")
```

### Control System
```python
registry.execute("adjust_volume", {"level": 80})
registry.execute("adjust_brightness", {"level": 50})
registry.execute("take_screenshot", {})
```

### Browser Operations
```python
registry.execute("search_web", {"query": "python tutorial"})
registry.execute("navigate_to_url", {"url": "https://example.com"})
registry.execute("play_media", {"url_or_path": "https://youtube.com/watch?v=..."})
```

### Process Management (with confirmation)
```python
# Without confirmation (returns requires_confirmation)
result = registry.execute("kill_process", {"process_identifier": "app.exe"})

# With confirmation
result = registry.execute(
    "kill_process",
    {"process_identifier": "app.exe"},
    skip_confirmation=True
)
```

## Error Handling

```python
from core.capabilities import CapabilityStatus

result = registry.execute("some_capability", {})

if result.status == CapabilityStatus.SUCCESS:
    print("Success:", result.result)
elif result.status == CapabilityStatus.VALIDATION_ERROR:
    print("Invalid input:", result.error)
elif result.status == CapabilityStatus.REQUIRES_CONFIRMATION:
    print("Need approval:", result.error)
elif result.status == CapabilityStatus.NOT_AVAILABLE:
    print("Not available:", result.error)
elif result.status == CapabilityStatus.ERROR:
    print("Failed:", result.error)
```

## Performance

| Operation | Time |
|-----------|------|
| Registry init | < 10ms |
| Input validation | < 1ms |
| Safe execution | < 10ms |
| Moderate execution | 10-100ms |
| Sensitive execution | 100ms-1s |

## Troubleshooting

**Q: Capability not found?**
A: Run `registry.list_all()` to see available capabilities

**Q: Validation error?**
A: Check parameter types match schema. Run verify_capabilities.py

**Q: Requires confirmation?**
A: Pass `skip_confirmation=True` after user approves

**Q: Handler failed?**
A: Check system requirements (e.g., Chrome for open_application)

## Next Steps

1. Read **CAPABILITIES_DOCUMENTATION.md** for detailed guide
2. Run **test_capabilities.py** to verify
3. Review **CAPABILITY_REGISTRY_EXAMPLE.py** for patterns
4. Integrate into your dashboard or CLI

## Support

- **Full Documentation**: CAPABILITIES_DOCUMENTATION.md
- **Examples**: CAPABILITY_REGISTRY_EXAMPLE.py
- **Tests**: test_capabilities.py
- **Quick Check**: verify_capabilities.py
- **Index**: CAPABILITY_IMPLEMENTATION_INDEX.md

---

**Status**: ✅ Production Ready
**Version**: 1.0.0
**Capabilities**: 15 implemented and tested

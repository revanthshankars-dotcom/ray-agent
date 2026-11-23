#!/usr/bin/env python
"""
Example usage of the Capability Registry.

Demonstrates common patterns for using J.A.R.V.I.S. capabilities.
"""

from core.capabilities import (
    get_capability_registry,
    SafetyLevel,
    CapabilityStatus,
)


def example_1_basic_usage():
    """Example 1: Basic capability execution."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 1: Basic Usage")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    # Check system status
    result = registry.execute("check_cpu_status", {})
    
    if result.status == CapabilityStatus.SUCCESS:
        print(f"CPU Usage: {result.result['cpu_percent']}%")
        print(f"Memory Usage: {result.result['memory_percent']}%")
        print(f"Top Process: {result.result['top_processes'][0]['name']}")
    else:
        print(f"Error: {result.error}")


def example_2_list_capabilities():
    """Example 2: List and explore capabilities."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 2: List and Explore")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    # List all categories
    categories = registry.list_categories()
    print(f"\nAvailable categories: {', '.join(categories)}")
    
    # Show system capabilities
    print("\nSystem Capabilities:")
    for cap in registry.list_by_category("system"):
        safety = cap.safety_level.value.upper()
        confirm = "⚠ Requires Confirmation" if cap.requires_confirmation else "✓ Auto-execute"
        print(f"  • {cap.name}")
        print(f"    {cap.description}")
        print(f"    Safety: {safety} | {confirm}\n")


def example_3_input_validation():
    """Example 3: Input validation and error handling."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 3: Input Validation")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    # Valid input
    print("\nValid input (level=50):")
    result = registry.execute("adjust_volume", {"level": 50})
    print(f"  Status: {result.status.value}")
    print(f"  Result: {result.result}")
    
    # Invalid input - out of range
    print("\nInvalid input (level=150):")
    result = registry.execute("adjust_volume", {"level": 150})
    print(f"  Status: {result.status.value}")
    print(f"  Error: {result.error}")
    
    # Invalid input - missing required parameter
    print("\nMissing parameter:")
    result = registry.execute("adjust_volume", {})
    print(f"  Status: {result.status.value}")
    print(f"  Error: {result.error}")


def example_4_confirmation_workflow():
    """Example 4: Handling capabilities that need confirmation."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 4: Confirmation Workflow")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    # Try without confirmation
    print("\nAttempting 'kill_process' without confirmation...")
    result = registry.execute("kill_process", {"process_identifier": "test.exe"})
    
    if result.status == CapabilityStatus.REQUIRES_CONFIRMATION:
        print(f"  Result: {result.status.value}")
        print(f"  Message: {result.error}")
        
        # In a real application, you would ask user here
        user_approved = True  # Simulated user approval
        
        if user_approved:
            print("\n  User approved. Executing with confirmation skipped...")
            result = registry.execute(
                "kill_process",
                {"process_identifier": "test.exe"},
                skip_confirmation=True
            )
            print(f"  Status: {result.status.value}")
    else:
        print(f"  Status: {result.status.value}")


def example_5_capability_metadata():
    """Example 5: Access capability metadata."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 5: Capability Metadata")
    print("=" * 70)
    
    registry = get_capability_registry()
    cap = registry.get("search_web")
    
    print(f"\nCapability: {cap.name}")
    print(f"Description: {cap.description}")
    print(f"Category: {cap.category}")
    print(f"Safety Level: {cap.safety_level.value}")
    print(f"Requires Confirmation: {cap.requires_confirmation}")
    print(f"Available: {cap.available}")
    
    print(f"\nInput Parameters:")
    for param_name, schema in cap.input_schema.items():
        print(f"  • {param_name}")
        print(f"    Type: {schema.type}")
        print(f"    Required: {schema.required}")
        print(f"    Description: {schema.description}")
        if schema.validation_rules:
            print(f"    Validation: {schema.validation_rules}")


def example_6_web_search():
    """Example 6: Web search capability."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 6: Web Search")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    print("\nSearching for 'Python asyncio tutorial'...")
    result = registry.execute("search_web", {"query": "Python asyncio tutorial"})
    
    if result.status == CapabilityStatus.SUCCESS:
        print(f"Found {result.result['result_count']} results\n")
        for i, res in enumerate(result.result['results'][:3], 1):
            print(f"{i}. {res.get('title', 'Untitled')}")
            print(f"   {res.get('href', 'No URL')}")
            print()
    else:
        print(f"Error: {result.error}")


def example_7_system_optimization():
    """Example 7: System optimization with confirmation."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 7: System Optimization")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    cap = registry.get("optimize_system")
    print(f"\nCapability: {cap.name}")
    print(f"Description: {cap.description}")
    print(f"Safety Level: {cap.safety_level.value}")
    print(f"Requires Confirmation: {cap.requires_confirmation}")
    
    print("\nThis capability will:")
    print("  1. Identify resource-heavy processes")
    print("  2. Clear temporary files")
    print("  3. Report findings (without auto-killing)")
    
    print("\nAttempting without confirmation...")
    result = registry.execute("optimize_system", {})
    print(f"Status: {result.status.value}")
    print(f"(Expected: requires_confirmation)")


def example_8_error_handling():
    """Example 8: Comprehensive error handling."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 8: Error Handling")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    test_cases = [
        ("unknown_capability", {}, "Unknown capability"),
        ("adjust_volume", {}, "Missing parameter"),
        ("adjust_volume", {"level": "invalid"}, "Wrong type"),
        ("adjust_volume", {"level": 150}, "Out of range"),
    ]
    
    for cap_name, inputs, description in test_cases:
        print(f"\nTest: {description}")
        result = registry.execute(cap_name, inputs)
        print(f"  Status: {result.status.value}")
        if result.error:
            print(f"  Error: {result.error}")


def example_9_execution_metrics():
    """Example 9: Execution metrics and timing."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 9: Execution Metrics")
    print("=" * 70)
    
    registry = get_capability_registry()
    
    capabilities = ["check_cpu_status", "check_battery_status", "take_screenshot"]
    
    for cap_name in capabilities:
        result = registry.execute(cap_name, {})
        print(f"\n{cap_name}:")
        print(f"  Status: {result.status.value}")
        print(f"  Execution Time: {result.execution_time_ms:.2f}ms")
        if result.result:
            result_str = str(result.result)[:60]
            print(f"  Result: {result_str}...")


def example_10_json_export():
    """Example 10: Export capabilities as JSON."""
    print("\n" + "=" * 70)
    print("  EXAMPLE 10: JSON Export")
    print("=" * 70)
    
    import json
    
    registry = get_capability_registry()
    
    # Get single capability as JSON
    cap = registry.get("adjust_volume")
    cap_json = json.dumps(cap.to_dict(), indent=2)
    
    print("\nCapability as JSON:")
    print(cap_json)
    
    # Export all capabilities
    all_caps = registry.to_dict()
    print(f"\nTotal capabilities exported: {len(all_caps)}")
    
    # Example: Save to file
    filepath = "capabilities_export.json"
    with open(filepath, "w") as f:
        json.dump(all_caps, f, indent=2)
    print(f"✓ Exported to {filepath}")


def main():
    """Run all examples."""
    print("\n" + "=" * 70)
    print("  J.A.R.V.I.S. Capability Registry - Usage Examples")
    print("=" * 70)
    
    examples = [
        example_1_basic_usage,
        example_2_list_capabilities,
        example_3_input_validation,
        example_4_confirmation_workflow,
        example_5_capability_metadata,
        example_6_web_search,
        example_7_system_optimization,
        example_8_error_handling,
        example_9_execution_metrics,
        example_10_json_export,
    ]
    
    for example_func in examples:
        try:
            example_func()
        except Exception as e:
            print(f"\n⚠ Error in {example_func.__name__}: {e}")
    
    print("\n" + "=" * 70)
    print("  Examples Complete")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    main()

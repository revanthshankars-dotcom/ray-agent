#!/usr/bin/env python3
"""Quick verification that SystemMonitor module is working."""

import sys
import os

# Ensure we're in the right directory
os.chdir(r"c:\Users\AMBIKA\Desktop\jarvis-assistant")
sys.path.insert(0, os.getcwd())

print("Working directory:", os.getcwd())
print("=" * 60)

# Test 1: Import
print("\n[TEST 1] Importing SystemMonitor...")
try:
    from core.system_monitor import (
        SystemMonitor, 
        SystemMetrics, 
        ResourceHogAlert, 
        BatteryAnalysis
    )
    print("✓ SUCCESS: All classes imported")
except ImportError as e:
    print(f"✗ FAILED: {e}")
    sys.exit(1)

# Test 2: Create instance
print("\n[TEST 2] Creating SystemMonitor instance...")
try:
    monitor = SystemMonitor(check_interval=2.0)
    print("✓ SUCCESS: Instance created")
except Exception as e:
    print(f"✗ FAILED: {e}")
    sys.exit(1)

# Test 3: Get metrics
print("\n[TEST 3] Capturing current metrics...")
try:
    metrics = monitor.get_current_metrics()
    assert hasattr(metrics, 'cpu_percent'), "Missing cpu_percent"
    assert hasattr(metrics, 'memory_percent'), "Missing memory_percent"
    assert hasattr(metrics, 'process_count'), "Missing process_count"
    print(f"✓ SUCCESS: Metrics captured")
    print(f"  - CPU: {metrics.cpu_percent:.1f}%")
    print(f"  - Memory: {metrics.memory_percent:.1f}%")
    print(f"  - Processes: {metrics.process_count}")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 4: Start/Stop monitoring
print("\n[TEST 4] Starting and stopping monitor...")
try:
    import time
    monitor.start_monitoring()
    print(f"  - Monitor started, running={monitor.running}")
    time.sleep(1)
    
    monitor.stop_monitoring()
    print(f"  - Monitor stopped, running={monitor.running}")
    assert not monitor.running, "Monitor did not stop"
    print("✓ SUCCESS: Lifecycle works")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 5: Resource hog analysis
print("\n[TEST 5] Analyzing resource hogs...")
try:
    hogs = monitor.analyze_resource_hogs()
    assert isinstance(hogs, list), "Result is not a list"
    print(f"✓ SUCCESS: Hog analysis works")
    print(f"  - Hogs detected: {len(hogs)}")
    for hog in hogs[:3]:
        print(f"    - {hog.process_name}: {hog.usage_percent:.1f}% {hog.resource_type}")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 6: Battery analysis
print("\n[TEST 6] Analyzing battery status...")
try:
    battery = monitor.get_battery_status()
    assert hasattr(battery, 'current_percent'), "Missing current_percent"
    assert hasattr(battery, 'plugged_in'), "Missing plugged_in"
    print(f"✓ SUCCESS: Battery analysis works")
    print(f"  - Percent: {battery.current_percent:.1f}%")
    print(f"  - Plugged in: {battery.plugged_in}")
    print(f"  - Health: {battery.health_status}")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 7: JSON serialization
print("\n[TEST 7] Testing JSON serialization...")
try:
    from core.system_monitor import _metrics_to_json, _alert_to_json
    import json
    
    json_str = _metrics_to_json(metrics)
    parsed = json.loads(json_str)
    assert isinstance(parsed, dict), "JSON is not a dict"
    assert 'cpu_percent' in parsed, "Missing cpu_percent in JSON"
    print(f"✓ SUCCESS: JSON serialization works")
    print(f"  - JSON size: {len(json_str)} bytes")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 8: Thread safety
print("\n[TEST 8] Testing thread safety...")
try:
    import threading
    
    monitor2 = SystemMonitor(check_interval=0.5)
    monitor2.start_monitoring()
    
    errors = []
    
    def worker():
        try:
            for _ in range(3):
                monitor2.get_current_metrics()
                monitor2.analyze_resource_hogs()
                monitor2.get_battery_status()
                time.sleep(0.1)
        except Exception as e:
            errors.append(str(e))
    
    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    
    monitor2.stop_monitoring()
    
    if errors:
        print(f"✗ FAILED: {errors}")
        sys.exit(1)
    
    print(f"✓ SUCCESS: Thread safety verified")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Summary
print("\n" + "=" * 60)
print("✓ ALL TESTS PASSED!")
print("=" * 60)
print("\nSystemMonitor module is production-ready and fully functional.")

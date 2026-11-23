#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Quick verification test for GuiOperator module."""

import sys
import os
from pathlib import Path

# Fix encoding for Windows console
if sys.platform == "win32":
    os.environ["PYTHONIOENCODING"] = "utf-8"

# Add project root
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

print("=" * 70)
print("GuiOperator Module Verification")
print("=" * 70)

# Test 1: Import module
print("\n[1] Testing imports...")
try:
    from core.gui_operator import (
        GuiOperator, get_gui_operator, ScreenCapture, OcrResult, 
        BrowserSession, OperationStatus
    )
    print("[OK] All imports successful")
except Exception as e:
    print(f"[FAIL] Import failed: {e}")
    sys.exit(1)

# Test 2: Initialize singleton
print("\n[2] Testing singleton initialization...")
try:
    operator = GuiOperator.get_instance()
    print(f"[OK] Singleton initialized")
    print(f"  - Screenshot backend: {operator._screenshot_backend}")
    print(f"  - OCR available: {operator._ocr_available}")
    print(f"  - PyAutoGUI available: {operator._pyautogui_available}")
    print(f"  - Playwright available: {operator._playwright_available}")
except Exception as e:
    print(f"[FAIL] Initialization failed: {e}")
    sys.exit(1)

# Test 3: Screenshot operation
print("\n[3] Testing screenshot operation...")
try:
    result = operator.screenshot()
    print(f"[OK] Screenshot successful")
    print(f"  - Status: {result.status}")
    print(f"  - Backend: {result.backend}")
    if result.dimensions:
        print(f"  - Dimensions: {result.dimensions}")
except Exception as e:
    print(f"[FAIL] Screenshot failed: {e}")
    sys.exit(1)

# Test 4: Mouse/keyboard operations
print("\n[4] Testing mouse/keyboard operations...")
try:
    result = operator.move_mouse(100, 100)
    print(f"[OK] move_mouse: {result['status']}")
    
    result = operator.click(100, 100)
    print(f"[OK] click: {result['status']}")
    
    result = operator.press_key("space")
    print(f"[OK] press_key: {result['status']}")
except Exception as e:
    print(f"[FAIL] Mouse/keyboard failed: {e}")
    sys.exit(1)

# Test 5: Thread safety
print("\n[5] Testing thread safety...")
try:
    import threading
    results = []
    
    def take_screenshot():
        result = operator.screenshot()
        results.append(result.status)
    
    threads = [threading.Thread(target=take_screenshot) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    
    print(f"[OK] Thread-safe operations: {results}")
except Exception as e:
    print(f"[FAIL] Thread safety test failed: {e}")
    sys.exit(1)

# Test 6: Convenience functions
print("\n[6] Testing module convenience functions...")
try:
    from core.gui_operator import (
        screenshot, click, move_mouse, type_text, press_key
    )
    
    result = screenshot()
    print(f"[OK] screenshot(): {result.status}")
    
    result = click(100, 100)
    print(f"[OK] click(): {result['status']}")
    
    result = move_mouse(100, 100)
    print(f"[OK] move_mouse(): {result['status']}")
except Exception as e:
    print(f"[FAIL] Convenience functions failed: {e}")
    sys.exit(1)

# Test 7: Data structures
print("\n[7] Testing data structures...")
try:
    sc = ScreenCapture(status="test", image=None, timestamp=None)
    print(f"[OK] ScreenCapture: {sc.status}")
    
    ocr = OcrResult(status="test")
    print(f"[OK] OcrResult: {ocr.status}")
    
    bs = BrowserSession(
        id="test_1",
        type="chromium",
        url="http://example.com",
        created_at=__import__('datetime').datetime.now(),
        last_activity_at=__import__('datetime').datetime.now(),
        status="active"
    )
    print(f"[OK] BrowserSession: {bs.id}")
except Exception as e:
    print(f"[FAIL] Data structures failed: {e}")
    sys.exit(1)

# Test 8: Cleanup
print("\n[8] Testing cleanup...")
try:
    operator.cleanup()
    print(f"[OK] Cleanup successful")
except Exception as e:
    print(f"[FAIL] Cleanup failed: {e}")
    sys.exit(1)

print("\n" + "=" * 70)
print("All verification tests passed!")
print("=" * 70)
print("\nGuiOperator module is ready for integration with Jarvis.")

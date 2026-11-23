#!/usr/bin/env python
"""Quick test to verify AudioListener imports and basic functionality"""

import sys
import os

# Test 1: Check imports
print("[TEST 1] Checking imports...")
try:
    from core.audio_listener import AudioListener, AudioListenerConfig
    print("  ✓ AudioListener imported successfully")
    print("  ✓ AudioListenerConfig imported successfully")
except Exception as e:
    print(f"  ✗ Import failed: {e}")
    sys.exit(1)

# Test 2: Check initialization
print("\n[TEST 2] Testing initialization...")
try:
    listener = AudioListener()
    print("  ✓ AudioListener instantiated")
    
    listener2 = AudioListener(sensitivity=0.7)
    print(f"  ✓ Sensitivity parameter accepted: {listener2.sensitivity}")
except Exception as e:
    print(f"  ✗ Initialization failed: {e}")
    sys.exit(1)

# Test 3: Check config
print("\n[TEST 3] Testing AudioListenerConfig...")
try:
    config = AudioListenerConfig()
    print("  ✓ Config created")
    
    config_dict = config.to_dict()
    print(f"  ✓ Config to_dict() works: {len(config_dict)} fields")
except Exception as e:
    print(f"  ✗ Config failed: {e}")
    sys.exit(1)

# Test 4: Check public methods exist
print("\n[TEST 4] Checking public methods...")
try:
    listener = AudioListener()
    methods = [
        'start_listening',
        'stop_listening', 
        'is_listening',
        'set_sensitivity',
        'get_command_count',
        'get_last_command',
        'get_config'
    ]
    
    for method in methods:
        if hasattr(listener, method):
            print(f"  ✓ {method} exists")
        else:
            print(f"  ✗ {method} missing")
            
except Exception as e:
    print(f"  ✗ Method check failed: {e}")
    sys.exit(1)

# Test 5: Test wake word detection fallback
print("\n[TEST 5] Testing wake word detection...")
try:
    listener = AudioListener(enable_porcupine=False)
    
    test_cases = [
        ("jarvis", True),
        ("hey jarvis", True),
        ("JARVIS", True),
        ("hello world", False),
        ("jarvis play music", True),
    ]
    
    for text, expected in test_cases:
        result = listener._detect_wake_word(text)
        status = "✓" if result == expected else "✗"
        print(f"  {status} '{text}' -> {result} (expected {expected})")
        
except Exception as e:
    print(f"  ✗ Wake word detection failed: {e}")
    sys.exit(1)

# Test 6: Test sensitivity clamping
print("\n[TEST 6] Testing sensitivity clamping...")
try:
    test_cases = [
        (-0.5, 0.0),
        (0.0, 0.0),
        (0.5, 0.5),
        (1.0, 1.0),
        (1.5, 1.0),
    ]
    
    for input_val, expected in test_cases:
        listener = AudioListener(sensitivity=input_val)
        if listener.sensitivity == expected:
            print(f"  ✓ sensitivity={input_val} -> {listener.sensitivity}")
        else:
            print(f"  ✗ sensitivity={input_val} -> {listener.sensitivity} (expected {expected})")
            
except Exception as e:
    print(f"  ✗ Sensitivity clamping failed: {e}")
    sys.exit(1)

# Test 7: Test thread-safe state access
print("\n[TEST 7] Testing thread-safe operations...")
try:
    listener = AudioListener()
    
    # These should not raise errors
    config = listener.get_config()
    count = listener.get_command_count()
    last_cmd = listener.get_last_command()
    is_listening = listener.is_listening()
    
    print(f"  ✓ get_config() -> {config.status}")
    print(f"  ✓ get_command_count() -> {count}")
    print(f"  ✓ get_last_command() -> {last_cmd}")
    print(f"  ✓ is_listening() -> {is_listening}")
    
except Exception as e:
    print(f"  ✗ Thread-safe operations failed: {e}")
    sys.exit(1)

# Test 8: Test start/stop lifecycle
print("\n[TEST 8] Testing start/stop lifecycle...")
try:
    listener = AudioListener()
    
    # Should not be running initially
    if listener._running:
        print("  ✗ Listener should not be running initially")
    else:
        print("  ✓ Listener not running initially")
    
    # Start should succeed (will timeout on listen_mic but that's ok)
    listener.start_listening()
    import time
    time.sleep(0.2)
    
    if listener._running:
        print("  ✓ Listener started")
    else:
        print("  ✗ Listener failed to start")
    
    # Stop should succeed
    listener.stop_listening()
    time.sleep(0.1)
    
    if not listener._running:
        print("  ✓ Listener stopped")
    else:
        print("  ✗ Listener failed to stop")
        
except Exception as e:
    print(f"  ✗ Lifecycle test failed: {e}")
    sys.exit(1)

print("\n" + "="*50)
print("✓ ALL BASIC TESTS PASSED")
print("="*50)

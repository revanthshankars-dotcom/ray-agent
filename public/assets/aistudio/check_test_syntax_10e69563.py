#!/usr/bin/env python
"""Quick syntax check for test_voice_commands.py"""
import sys
import py_compile

try:
    py_compile.compile('test_voice_commands.py', doraise=True)
    print("✓ Syntax check passed: test_voice_commands.py is valid Python")
    sys.exit(0)
except py_compile.PyCompileError as e:
    print(f"✗ Syntax error in test_voice_commands.py:")
    print(e)
    sys.exit(1)

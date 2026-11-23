import py_compile
import sys

try:
    py_compile.compile('core/system_monitor.py', doraise=True)
    print("✓ Syntax check passed: core/system_monitor.py")
    sys.exit(0)
except py_compile.PyCompileError as e:
    print(f"✗ Syntax error: {e}")
    sys.exit(1)

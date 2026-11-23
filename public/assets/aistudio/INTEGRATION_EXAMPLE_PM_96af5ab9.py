"""
Integration Example: ProcessManager with SystemMonitor and TaskExecutor

This example shows how to integrate the ProcessManager module with the existing
SystemMonitor and TaskExecutor modules for autonomous resource management.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.process_manager import ProcessManager, TerminationStrategy
from core.task_executor import is_interrupted, set_interrupt


def example_1_resource_hog_detection():
    """Example 1: Detect and recommend termination of resource hogs."""
    print("\n" + "=" * 80)
    print("EXAMPLE 1: Resource Hog Detection")
    print("=" * 80)
    
    pm = ProcessManager()
    
    # Find processes using high resources
    recommendations = pm.recommend_terminations(
        cpu_threshold_percent=80.0,
        memory_threshold_percent=80.0,
        sustained_seconds=30.0
    )
    
    print(f"\nFound {len(recommendations)} resource hogs:")
    
    for i, rec in enumerate(recommendations[:5], 1):  # Show top 5
        print(f"\n{i}. {rec.name} (PID {rec.pid})")
        print(f"   Priority: {rec.priority}")
        print(f"   CPU: {rec.cpu_percent:.1f}%")
        print(f"   Memory: {rec.memory_percent:.1f}%")
        print(f"   Reason: {rec.reason}")


def example_2_graceful_termination():
    """Example 2: Gracefully terminate a non-critical process."""
    print("\n" + "=" * 80)
    print("EXAMPLE 2: Graceful Termination")
    print("=" * 80)
    
    pm = ProcessManager()
    
    # Try to terminate a process gracefully (with SIGTERM)
    # Using explorer.exe as example - it's protected so will fail gracefully
    result = pm.terminate_process("explorer.exe", TerminationStrategy.GRACEFUL)
    
    print(f"\nTermination Attempt:")
    print(f"  Process: {result.process_name}")
    print(f"  PID: {result.pid}")
    print(f"  Success: {result.success}")
    print(f"  Reason: {result.reason}")
    print(f"  Admin Needed: {result.admin_needed}")
    print(f"  Timestamp: {result.timestamp}")


def example_3_process_info():
    """Example 3: Get information about running processes."""
    print("\n" + "=" * 80)
    print("EXAMPLE 3: Process Information")
    print("=" * 80)
    
    pm = ProcessManager()
    
    # Get top 10 processes by CPU usage
    processes = pm.get_running_processes(sort_by="cpu")
    
    print(f"\nTop 10 Processes by CPU Usage:")
    print(f"{'Name':<30} {'PID':>8} {'CPU%':>8} {'Mem%':>8} {'Status':<12}")
    print("-" * 80)
    
    for proc in processes[:10]:
        is_protected = pm.is_process_protected(proc.pid)
        protected_marker = "🔒" if is_protected else "  "
        
        print(
            f"{proc.name:<28} {protected_marker} {proc.pid:>6} "
            f"{proc.cpu_percent:>7.1f} {proc.memory_percent:>7.1f} {proc.status:<12}"
        )


def example_4_termination_history():
    """Example 4: Track termination history."""
    print("\n" + "=" * 80)
    print("EXAMPLE 4: Termination History")
    print("=" * 80)
    
    pm = ProcessManager()
    
    # Make some termination attempts
    pm.terminate_process("explorer.exe")
    pm.terminate_process("system")
    pm.terminate_process("nonexistent_process_xyz.exe")
    
    # Get history
    history = pm.get_termination_history(limit=10)
    
    print(f"\nTermination History ({len(history)} operations):")
    print(f"{'Timestamp':<25} {'Process':<20} {'Success':<8} {'Reason':<30}")
    print("-" * 80)
    
    for op in history:
        success_str = "✓" if op.success else "✗"
        reason_short = op.reason[:25] + "..." if len(op.reason) > 25 else op.reason
        print(
            f"{op.timestamp:<25} {op.process_name:<20} {success_str:<8} {reason_short:<30}"
        )


def example_5_integration_with_system_monitor():
    """Example 5: Integration scenario with SystemMonitor."""
    print("\n" + "=" * 80)
    print("EXAMPLE 5: SystemMonitor Integration")
    print("=" * 80)
    
    print("""
Pseudocode for integration in system_monitor.py:

    from core.process_manager import ProcessManager, TerminationStrategy
    
    class SystemMonitor:
        def __init__(self):
            self.pm = ProcessManager()
            # ... other initialization
        
        def analyze_resource_hogs(self):
            '''Detect high-resource processes and recommend termination.'''
            recommendations = self.pm.recommend_terminations(
                cpu_threshold_percent=90.0,
                memory_threshold_percent=85.0,
                sustained_seconds=30.0
            )
            
            for rec in recommendations:
                if rec.priority == "high":
                    # Log alert for high priority hogs
                    alert = ResourceHogAlert(
                        process_name=rec.name,
                        process_id=rec.pid,
                        resource_type="cpu" if rec.cpu_percent > rec.memory_percent else "memory",
                        usage_percent=max(rec.cpu_percent, rec.memory_percent),
                        severity="critical"
                    )
                    self._alerts.append(alert)
    """)


def example_6_integration_with_task_executor():
    """Example 6: Integration scenario with TaskExecutor."""
    print("\n" + "=" * 80)
    print("EXAMPLE 6: TaskExecutor Integration")
    print("=" * 80)
    
    print("""
Pseudocode for integration in task_executor.py:

    from core.process_manager import ProcessManager, TerminationStrategy
    from core.task_executor import is_interrupted
    
    def cleanup_resource_hogs():
        '''Autonomous task: terminate resource-hogging processes.'''
        pm = ProcessManager()
        
        while not is_interrupted():
            # Get recommendations
            recommendations = pm.recommend_terminations(
                cpu_threshold_percent=85.0,
                memory_threshold_percent=80.0
            )
            
            for rec in recommendations:
                if is_interrupted():
                    break
                
                # Gracefully terminate
                result = pm.terminate_process(
                    rec.pid,
                    TerminationStrategy.GRACEFUL
                )
                
                if result.success:
                    print(f"✓ Terminated resource hog: {rec.name}")
                elif result.admin_needed:
                    print(f"⚠ Admin escalation needed: {rec.name}")
                else:
                    print(f"✗ Failed to terminate: {result.reason}")
            
            time.sleep(5)  # Check every 5 seconds
    """)


def example_7_protected_processes():
    """Example 7: Understanding protected processes."""
    print("\n" + "=" * 80)
    print("EXAMPLE 7: Protected Processes")
    print("=" * 80)
    
    pm = ProcessManager()
    
    print("\nProtected Processes (Cannot be terminated):")
    print(f"Total: {len(pm.PROTECTED_PROCESSES)}")
    print()
    
    # Group by category
    categories = {
        "System": ["system", "csrss.exe", "smss.exe", "svchost.exe", "services.exe", "lsass.exe"],
        "Core": ["explorer.exe", "dwm.exe"],
        "Jarvis": ["python.exe", "jarvis.exe", "tray.py"],
        "Browsers": ["chrome.exe", "firefox.exe", "msedge.exe"],
        "Applications": ["notepad.exe", "code.exe"],
        "Office": ["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe"],
        "Task Management": ["taskmgr.exe"],
    }
    
    for category, processes in categories.items():
        matching = [p for p in processes if p in pm.PROTECTED_PROCESSES]
        if matching:
            print(f"  {category}:")
            for p in matching:
                print(f"    - {p}")


def example_8_error_scenarios():
    """Example 8: Handling error scenarios."""
    print("\n" + "=" * 80)
    print("EXAMPLE 8: Error Handling")
    print("=" * 80)
    
    pm = ProcessManager()
    
    # Scenario 1: Non-existent process
    print("\n1. Non-existent process:")
    result = pm.terminate_process("process_that_does_not_exist_xyz.exe")
    print(f"   Success: {result.success}")
    print(f"   Reason: {result.reason}")
    
    # Scenario 2: Protected process
    print("\n2. Protected process:")
    result = pm.terminate_process("explorer.exe")
    print(f"   Success: {result.success}")
    print(f"   Reason: {result.reason}")
    print(f"   Admin Needed: {result.admin_needed}")
    
    # Scenario 3: Current process (Python)
    print("\n3. Get info about current process:")
    current_pid = os.getpid()
    info = pm.get_process_info(current_pid)
    if info:
        print(f"   Name: {info.name}")
        print(f"   CPU: {info.cpu_percent:.1f}%")
        print(f"   Memory: {info.memory_percent:.1f}%")
        print(f"   Status: {info.status}")


def example_9_thread_safety():
    """Example 9: Thread-safe concurrent operations."""
    print("\n" + "=" * 80)
    print("EXAMPLE 9: Thread Safety")
    print("=" * 80)
    
    import threading
    import time
    
    pm = ProcessManager()
    results = []
    
    def worker(worker_id):
        """Worker thread that uses ProcessManager."""
        for i in range(3):
            procs = pm.get_running_processes()
            results.append((worker_id, len(procs)))
            time.sleep(0.1)
    
    # Create multiple threads
    threads = []
    for i in range(5):
        t = threading.Thread(target=worker, args=(i,))
        threads.append(t)
        t.start()
    
    # Wait for all threads
    for t in threads:
        t.join()
    
    print(f"\nConcurrent Operations Test:")
    print(f"  Total threads: 5")
    print(f"  Operations per thread: 3")
    print(f"  Total operations: {len(results)}")
    print(f"  All succeeded: {len(results) == 15}")
    
    # Show sample results
    print(f"\nSample results:")
    for worker_id, proc_count in results[:5]:
        print(f"  Worker {worker_id}: Found {proc_count} processes")


def main():
    """Run all examples."""
    print("\n" + "=" * 80)
    print("ProcessManager Integration Examples")
    print("=" * 80)
    
    examples = [
        ("Resource Hog Detection", example_1_resource_hog_detection),
        ("Graceful Termination", example_2_graceful_termination),
        ("Process Information", example_3_process_info),
        ("Termination History", example_4_termination_history),
        ("SystemMonitor Integration", example_5_integration_with_system_monitor),
        ("TaskExecutor Integration", example_6_integration_with_task_executor),
        ("Protected Processes", example_7_protected_processes),
        ("Error Scenarios", example_8_error_scenarios),
        ("Thread Safety", example_9_thread_safety),
    ]
    
    for i, (name, func) in enumerate(examples, 1):
        try:
            func()
        except Exception as e:
            print(f"\n✗ Error in example {i} ({name}): {e}")
    
    print("\n" + "=" * 80)
    print("All Examples Complete")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()

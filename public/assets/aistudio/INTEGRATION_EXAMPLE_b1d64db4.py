"""
Integration Example: Adding GuiOperator to Jarvis Brain

This file shows how to integrate GuiOperator with the Jarvis brain
to enable GUI automation commands like:
  - "Jarvis, take a screenshot"
  - "Jarvis, look at the screen"
  - "Jarvis, click at 500 300"
  - "Jarvis, type hello"
"""

# ============================================================================
# EXAMPLE 1: Add to Brain Tools (core/brain.py)
# ============================================================================

def example_brain_integration():
    """Add these imports and functions to core/brain.py"""
    
    # Add to imports section:
    # from core.gui_operator import GuiOperator, screenshot, click, type_text
    
    # Add these tool functions to the JarvisBrain class:
    
    def look_at_screen() -> str:
        """Capture and analyze the current screen."""
        from core.gui_operator import screenshot
        from core.vision import analyze_screenshot
        
        screen = screenshot()
        if screen.status != "success" or screen.image is None:
            return f"Unable to capture screen: {screen.error or 'unknown error'}"
        
        # Use vision module to analyze
        analysis = analyze_screenshot(screen.image)
        return analysis
    
    def click_on_screen(x: int, y: int, button: str = "left") -> str:
        """Click at specified coordinates."""
        from core.gui_operator import click
        
        result = click(x, y, button)
        if result["status"] == "success":
            return f"Clicked at ({x}, {y}) with {button} button"
        return f"Click failed: {result.get('message', 'unknown error')}"
    
    def type_on_screen(text: str) -> str:
        """Type text on screen."""
        from core.gui_operator import type_text
        
        result = type_text(text)
        if result["status"] == "success":
            return f"Typed: {text}"
        return f"Typing failed: {result.get('message', 'unknown error')}"
    
    def move_mouse_cmd(x: int, y: int) -> str:
        """Move mouse to coordinates."""
        from core.gui_operator import move_mouse
        
        result = move_mouse(x, y)
        if result["status"] == "success":
            return f"Mouse moved to ({result['x']}, {result['y']})"
        return f"Mouse move failed: {result.get('message', 'unknown error')}"
    
    def press_key_cmd(key: str) -> str:
        """Press a keyboard key."""
        from core.gui_operator import press_key
        
        result = press_key(key)
        if result["status"] == "success":
            return f"Pressed key: {key}"
        return f"Key press failed: {result.get('message', 'unknown error')}"
    
    def read_screen_text() -> str:
        """Extract text from screen using OCR."""
        from core.gui_operator import screenshot, get_gui_operator
        
        screen = screenshot()
        if screen.status != "success" or screen.image is None:
            return "Unable to capture screen for OCR"
        
        operator = get_gui_operator()
        ocr_result = operator.ocr_image(screen.image)
        
        if ocr_result.status == "success":
            return f"Screen text:\n{ocr_result.text}"
        elif ocr_result.status == "not_available":
            return "OCR not available (Tesseract not installed)"
        else:
            return f"OCR failed: {ocr_result.error}"


# ============================================================================
# EXAMPLE 2: Add to Tools Dict (in JarvisBrain.__init__)
# ============================================================================

def example_tools_dict():
    """Add these to the tools dictionary in JarvisBrain"""
    
    tools = {
        # Existing tools...
        
        # GUI Operations
        "look": look_at_screen,
        "screenshot": look_at_screen,
        "click": click_on_screen,
        "type": type_on_screen,
        "move_mouse": move_mouse_cmd,
        "press_key": press_key_cmd,
        "read_text": read_screen_text,
    }
    
    return tools


# ============================================================================
# EXAMPLE 3: Standalone Usage
# ============================================================================

def example_standalone_usage():
    """Use GuiOperator directly without Jarvis brain"""
    
    from core.gui_operator import GuiOperator
    
    # Get singleton instance
    operator = GuiOperator.get_instance()
    
    # Take screenshot
    print("Taking screenshot...")
    screen = operator.screenshot()
    if screen.status == "success":
        print(f"Screenshot captured: {screen.dimensions}")
        print(f"Backend used: {screen.backend}")
    
    # Move mouse and click
    print("\nMoving mouse and clicking...")
    operator.move_mouse(100, 100)
    operator.click(100, 100)
    
    # Type text
    print("Typing text...")
    operator.type_text("Hello Jarvis")
    
    # Press key
    print("Pressing Enter...")
    operator.press_key("enter")
    
    # Cleanup
    print("Cleaning up...")
    operator.cleanup()
    print("Done!")


# ============================================================================
# EXAMPLE 4: Browser Automation
# ============================================================================

def example_browser_automation():
    """Use Playwright browser automation"""
    
    from core.gui_operator import GuiOperator
    
    operator = GuiOperator.get_instance()
    
    # Open browser
    result = operator.browser_open("chromium")
    if result["status"] == "success":
        session_id = result["session_id"]
        print(f"Browser opened: {session_id}")
        
        # Navigate
        operator.browser_navigate("https://www.google.com", session_id)
        print("Navigated to Google")
        
        # Type in search
        operator.browser_type("input[name='q']", "jarvis ai assistant")
        print("Typed search query")
        
        # Click search button
        operator.browser_click("button[name='btnK']", session_id)
        print("Clicked search")
        
        # Take screenshot of results
        screen = operator.browser_screenshot(session_id)
        if screen.status == "success":
            print(f"Screenshot captured: {screen.dimensions}")
        
        # Close browser
        operator.browser_close(session_id)
        print("Browser closed")


# ============================================================================
# EXAMPLE 5: OCR and Text Detection
# ============================================================================

def example_ocr_usage():
    """Use OCR to extract text from screen"""
    
    from core.gui_operator import screenshot, get_gui_operator
    
    # Take screenshot
    screen = screenshot()
    if screen.status != "success" or screen.image is None:
        print("Failed to capture screen")
        return
    
    # Perform OCR
    operator = get_gui_operator()
    ocr_result = operator.ocr_image(screen.image)
    
    if ocr_result.status == "success":
        print("Extracted text:")
        print(ocr_result.text)
        
        # Print text regions
        if ocr_result.regions:
            print("\nText regions found:")
            for region in ocr_result.regions[:5]:  # First 5
                print(f"  - '{region['text']}' at {region['bbox']}")
    else:
        print(f"OCR failed: {ocr_result.error}")


# ============================================================================
# EXAMPLE 6: UI Element Detection
# ============================================================================

def example_element_detection():
    """Find and click UI elements by text"""
    
    from core.gui_operator import get_gui_operator
    
    operator = get_gui_operator()
    
    # Find button by text
    element = operator.find_element_by_text("Click Me")
    if element:
        print(f"Found element: {element['text']}")
        print(f"Position: ({element['x']}, {element['y']})")
        
        # Click it
        operator.click_element(element)
        print("Element clicked!")
    else:
        print("Element not found")


# ============================================================================
# EXAMPLE 7: Application Control
# ============================================================================

def example_app_control():
    """Open and focus applications"""
    
    from core.gui_operator import get_gui_operator
    
    operator = get_gui_operator()
    
    # Open application
    result = operator.open_application("notepad.exe")
    if result["status"] == "success":
        print("Notepad opened")
    
    # Focus window (Windows-specific)
    result = operator.focus_window("Untitled - Notepad")
    if result["status"] == "success":
        print("Notepad window focused")


# ============================================================================
# EXAMPLE 8: Integration with Voice Commands
# ============================================================================

def example_voice_integration():
    """Integration with audio listener for voice commands"""
    
    from core.gui_operator import click, type_text, move_mouse
    
    # In AudioListener or voice command handler:
    
    def handle_gui_command(command: str):
        """Handle GUI-related voice commands"""
        
        if "click" in command.lower():
            # Parse coordinates from command
            # Example: "Click at 500 300"
            try:
                parts = command.lower().split("at")
                coords = parts[1].strip().split()
                x, y = int(coords[0]), int(coords[1])
                result = click(x, y)
                return f"Clicked at {x}, {y}"
            except:
                return "Invalid coordinates for click"
        
        elif "type" in command.lower():
            # Parse text to type
            # Example: "Type hello world"
            try:
                text = command.lower().replace("type", "").strip()
                result = type_text(text)
                return f"Typed: {text}"
            except:
                return "Failed to type text"
        
        elif "move" in command.lower() or "mouse" in command.lower():
            # Example: "Move mouse to 800 600"
            try:
                parts = command.lower().split("to")
                coords = parts[1].strip().split()
                x, y = int(coords[0]), int(coords[1])
                result = move_mouse(x, y)
                return f"Mouse moved to {x}, {y}"
            except:
                return "Invalid coordinates for mouse movement"
        
        return "GUI command not recognized"


# ============================================================================
# EXAMPLE 9: Error Handling Pattern
# ============================================================================

def example_error_handling():
    """Proper error handling pattern"""
    
    from core.gui_operator import screenshot, get_gui_operator
    
    try:
        # Get operator
        operator = get_gui_operator()
        
        # Try screenshot
        screen = screenshot()
        if screen.status == "error":
            print(f"Screenshot error: {screen.error}")
            return
        
        if screen.status == "fallback":
            print(f"Using fallback backend: {screen.backend}")
        
        # Check image
        if screen.image is None:
            print("No image data available")
            return
        
        # Process successfully
        print(f"Success! Image size: {screen.dimensions}")
        
    except Exception as e:
        print(f"Unexpected error: {e}")
    finally:
        # Cleanup
        operator.cleanup()


# ============================================================================
# EXAMPLE 10: Threading and Concurrency
# ============================================================================

def example_threading():
    """Use GuiOperator in multi-threaded context"""
    
    import threading
    from core.gui_operator import screenshot
    
    results = []
    
    def capture_in_thread():
        """Capture screenshot in thread"""
        screen = screenshot()
        results.append(screen.status)
    
    # Create threads
    threads = [
        threading.Thread(target=capture_in_thread)
        for _ in range(5)
    ]
    
    # Start threads
    for thread in threads:
        thread.start()
    
    # Wait for completion
    for thread in threads:
        thread.join()
    
    print(f"Thread results: {results}")


# ============================================================================
# MAIN: Run Examples
# ============================================================================

if __name__ == "__main__":
    print("=" * 70)
    print("GuiOperator Integration Examples")
    print("=" * 70)
    
    print("\n[1] Brain Integration Example (shows code structure)")
    print("    See example_brain_integration()")
    
    print("\n[2] Standalone Usage Example")
    print("    Uncomment to run: example_standalone_usage()")
    
    print("\n[3] Browser Automation Example")
    print("    Uncomment to run: example_browser_automation()")
    
    print("\n[4] OCR Example")
    print("    Uncomment to run: example_ocr_usage()")
    
    print("\n[5] Application Control Example")
    print("    Uncomment to run: example_app_control()")
    
    print("\n[6] Threading Example")
    print("    Uncomment to run: example_threading()")
    
    print("\n" + "=" * 70)
    print("To use these examples, uncomment the function calls below:")
    print("=" * 70)
    
    # Uncomment to run examples:
    # example_standalone_usage()
    # example_browser_automation()
    # example_ocr_usage()
    # example_app_control()
    # example_threading()

"""Quick verification: import all services and count registered tools."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from app.services.browser_automation import browser_automation
from app.services.mcp_service import mcp_service

print(f"Total tools registered: {len(mcp_service.tools)}")
print()

# List all tools
for i, t in enumerate(mcp_service.tools, 1):
    print(f"  {i:2d}. {t['name']}")

# Count new browser tools specifically
new_tools = [
    'extract_text', 'extract_structured_data', 'type_text', 'press_key',
    'go_back', 'go_forward', 'get_page_info', 'open_new_tab', 'switch_tab',
    'close_tab', 'execute_javascript', 'drag_and_drop', 'upload_file',
    'wait_for_navigation', 'scroll_to_element', 'switch_to_frame',
    'switch_to_main', 'handle_dialog'
]

registered_names = [t['name'] for t in mcp_service.tools]
found = [n for n in new_tools if n in registered_names]
missing = [n for n in new_tools if n not in registered_names]

print(f"\nNew BrowserOS tools registered: {len(found)}/{len(new_tools)}")
if missing:
    print(f"MISSING: {missing}")
else:
    print("All new tools registered successfully!")

# Verify methods exist on browser_automation
for tool_name in new_tools:
    if hasattr(browser_automation, tool_name):
        print(f"  ✅ browser_automation.{tool_name}")
    else:
        print(f"  ❌ browser_automation.{tool_name} - METHOD MISSING")

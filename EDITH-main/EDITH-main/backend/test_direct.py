"""
Direct test of browser_automation module as it runs in FastAPI
"""
import asyncio
import sys
import os

# Apply same event loop policy as main.py - ProactorEventLoop for subprocess support
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

async def test():
    # Import the actual browser_automation module
    from app.services.browser_automation import browser_automation
    
    print("Testing browser_automation.open_browser()...")
    result = await browser_automation.open_browser("https://example.com")
    print(f"\nResult:\n{result}")

if __name__ == "__main__":
    asyncio.run(test())

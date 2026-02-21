"""
Quick test: can nodriver open Chrome at all?
Run: python test_nodriver.py
"""
import asyncio
import sys

# MUST use ProactorEventLoop on Windows — nodriver spawns Chrome as subprocess
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    loop = asyncio.ProactorEventLoop()
    asyncio.set_event_loop(loop)

async def test():
    print("[Test] Importing nodriver...")
    try:
        import nodriver as uc
        print("[Test] ✓ nodriver imported")
    except ImportError as e:
        print(f"[Test] ✗ nodriver import failed: {e}")
        print("       Run: pip install nodriver")
        return

    print("[Test] Launching Chrome...")
    try:
        browser = await uc.start(
            headless=False,
            browser_args=[
                '--start-maximized',
                '--no-first-run',
                '--no-default-browser-check',
            ]
        )
        print("[Test] ✓ Browser launched!")
        page = browser.main_tab
        print("[Test] Navigating to example.com...")
        await page.get("https://example.com")
        await asyncio.sleep(2)
        title = await page.evaluate("document.title")
        print(f"[Test] ✓ Page title: {title}")
        print("[Test] ✓ ALL GOOD — nodriver is working")
        await asyncio.sleep(3)
        browser.stop()
    except Exception as e:
        import traceback
        print(f"[Test] ✗ Browser launch failed:")
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test())

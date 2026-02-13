"""
Test browser automation with proper Windows event loop handling
"""
import asyncio
import sys
import traceback

# Fix for Windows event loop issue
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

async def test_browser():
    print(f"Python executable: {sys.executable}")
    print(f"Python version: {sys.version}")
    print(f"Event loop policy: {asyncio.get_event_loop_policy()}")
    
    playwright = None
    browser = None
    
    try:
        # Test 1: Import playwright
        print("\n[TEST 1] Importing playwright...")
        from playwright.async_api import async_playwright
        print("✅ Playwright imported successfully")
        
        # Test 2: Start playwright
        print("\n[TEST 2] Starting Playwright...")
        playwright = await async_playwright().start()
        print("✅ Playwright started")
        
        # Test 3: Launch browser
        print("\n[TEST 3] Launching Chromium (headless=True for testing)...")
        browser = await playwright.chromium.launch(headless=True)
        print("✅ Browser launched")
        
        # Test 4: Create context
        print("\n[TEST 4] Creating browser context...")
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 900}
        )
        print("✅ Context created")
        
        # Test 5: Create page
        print("\n[TEST 5] Creating page...")
        page = await context.new_page()
        print("✅ Page created")
        
        # Test 6: Navigate
        print("\n[TEST 6] Navigating to https://example.com/ ...")
        await page.goto("https://example.com/", wait_until='domcontentloaded', timeout=30000)
        print("✅ Navigation successful")
        
        # Get info
        title = await page.title()
        url = page.url
        print(f"\n📄 Title: {title}")
        print(f"📍 URL: {url}")
        
        print("\n" + "="*50)
        print("SUCCESS! All tests passed!")
        print("="*50)
        
    except Exception as e:
        print(f"\n❌ ERROR: {type(e).__name__}: {str(e)}")
        print("\nFull traceback:")
        traceback.print_exc()
    finally:
        # Cleanup
        if browser:
            try:
                await browser.close()
                print("Browser closed")
            except:
                pass
        if playwright:
            try:
                await playwright.stop()
                print("Playwright stopped")
            except:
                pass

if __name__ == "__main__":
    # Run with proper event loop handling
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(test_browser())
    finally:
        loop.close()

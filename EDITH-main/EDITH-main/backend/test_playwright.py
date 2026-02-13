"""Quick test for Playwright browser automation"""
import asyncio
from playwright.async_api import async_playwright

async def test_browser():
    print("Starting Playwright test...")
    try:
        p = await async_playwright().start()
        print("Playwright started")
        
        b = await p.chromium.launch(headless=False)
        print("Browser launched")
        
        page = await b.new_page()
        print("Page created")
        
        await page.goto("https://example.com", timeout=30000)
        print("Navigated to example.com")
        
        title = await page.title()
        print(f"Title: {title}")
        
        await b.close()
        await p.stop()
        print("SUCCESS! Playwright works correctly.")
        
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")

if __name__ == "__main__":
    asyncio.run(test_browser())

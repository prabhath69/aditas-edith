"""
Browser Automation Service for EDITH
Provides tools for intelligent web interaction: form filling, hover menus,
multi-page navigation, and visible cursor tracking.
Uses sync Playwright in ThreadPoolExecutor to avoid event loop conflicts with FastAPI/uvicorn
"""

import asyncio
import os
import re
import random
import time
import concurrent.futures
from typing import Dict, Any, List, Optional
from playwright.sync_api import sync_playwright, Browser, Page, BrowserContext

# Thread pool for running Playwright sync operations
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

# JavaScript to inject a visible cursor overlay on the page
CURSOR_INJECTION_JS = """
() => {
    if (document.getElementById('edith-cursor')) return; // Already injected
    
    const cursor = document.createElement('div');
    cursor.id = 'edith-cursor';
    cursor.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,100,50,0.9) 0%, rgba(255,60,20,0.6) 60%, transparent 100%);
        box-shadow: 0 0 10px rgba(255,80,30,0.7), 0 0 20px rgba(255,80,30,0.3);
        position: fixed;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 999999;
        transition: top 0.08s ease-out, left 0.08s ease-out;
        transform: translate(-50%, -50%);
    `;
    document.body.appendChild(cursor);
    
    // Track mouse movements to update cursor position
    document.addEventListener('mousemove', (e) => {
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
    });
}
"""

# JavaScript to get ALL interactive elements on the page (comprehensive)
GET_ALL_ELEMENTS_JS = """
() => {
    const elements = [];
    const seen = new Set(); // Avoid duplicates
    
    function getUniqueSelector(el) {
        if (el.id) return '#' + el.id;
        if (el.name) return '[name="' + el.name + '"]';
        if (el.getAttribute('aria-label')) return '[aria-label="' + el.getAttribute('aria-label') + '"]';
        // Build a path-based selector
        let path = '';
        let current = el;
        while (current && current !== document.body) {
            let tag = current.tagName.toLowerCase();
            if (current.id) { path = '#' + current.id + (path ? ' > ' + path : ''); break; }
            let idx = 1;
            let sib = current.previousElementSibling;
            while (sib) { if (sib.tagName === current.tagName) idx++; sib = sib.previousElementSibling; }
            tag += ':nth-of-type(' + idx + ')';
            path = tag + (path ? ' > ' + path : '');
            current = current.parentElement;
        }
        return path;
    }
    
    function addElement(el, type, extra = {}) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // Skip hidden
        
        const selector = getUniqueSelector(el);
        if (seen.has(selector)) return;
        seen.add(selector);
        
        let label = '';
        // Try label[for]
        if (el.id) {
            const labelEl = document.querySelector('label[for="' + el.id + '"]');
            if (labelEl) label = labelEl.innerText.trim();
        }
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) label = el.getAttribute('title') || '';
        if (!label) label = el.placeholder || '';
        if (!label) label = (el.innerText || '').trim().substring(0, 100);
        if (!label && el.parentElement) {
            const pt = el.parentElement.innerText;
            if (pt && pt.length < 80) label = pt.trim();
        }
        
        elements.push({
            type: type,
            label: label.substring(0, 100),
            selector: selector,
            ...extra
        });
    }
    
    // === 1. FORM INPUTS ===
    document.querySelectorAll('input, textarea').forEach(el => {
        const type = el.type || 'text';
        addElement(el, type, {
            value: el.value || '',
            required: el.required || false
        });
    });
    
    // === 2. SELECT DROPDOWNS (native) ===
    document.querySelectorAll('select').forEach(el => {
        const options = Array.from(el.options).map(o => o.text);
        addElement(el, 'dropdown', {
            value: el.value,
            options: options.slice(0, 15),
            required: el.required || false
        });
    });
    
    // === 3. BUTTONS ===
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
        const text = el.innerText?.trim() || el.value || el.getAttribute('aria-label') || 'Button';
        addElement(el, 'button', { label: text.substring(0, 50) });
    });
    
    // === 4. LINKS (navigation) ===
    document.querySelectorAll('a[href]').forEach(el => {
        const href = el.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return;
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!text) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        addElement(el, 'link', {
            href: href.substring(0, 200),
            label: text.substring(0, 80)
        });
    });
    
    // === 5. RADIO BUTTONS & CHECKBOXES ===
    document.querySelectorAll('[role="radio"], [role="checkbox"]').forEach(el => {
        const text = el.innerText?.trim() || el.getAttribute('data-value') || '';
        if (!text) return;
        addElement(el, el.getAttribute('role'), {
            checked: el.getAttribute('aria-checked') === 'true'
        });
    });
    
    // === 6. HOVER DROPDOWNS & MENUS ===
    document.querySelectorAll('[aria-haspopup], [data-toggle="dropdown"], .dropdown-toggle, [data-bs-toggle="dropdown"]').forEach(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!text) return;
        addElement(el, 'hover-dropdown', {
            label: text.substring(0, 80)
        });
    });
    
    // === 7. CUSTOM DROPDOWNS / COMBOBOXES ===
    document.querySelectorAll('[role="listbox"], [role="combobox"], [role="menu"], [role="menubar"]').forEach(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        addElement(el, 'custom-dropdown', {
            label: text.substring(0, 80)
        });
    });
    
    // === 8. TABS ===
    document.querySelectorAll('[role="tab"]').forEach(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!text) return;
        addElement(el, 'tab', {
            selected: el.getAttribute('aria-selected') === 'true',
            label: text.substring(0, 80)
        });
    });
    
    // === 9. EXPANDABLE / ACCORDION ELEMENTS ===
    document.querySelectorAll('[aria-expanded], details > summary, .accordion-button, .collapsible').forEach(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!text) return;
        addElement(el, 'expandable', {
            expanded: el.getAttribute('aria-expanded') === 'true',
            label: text.substring(0, 80)
        });
    });
    
    // === 10. NAVIGATION ITEMS (top-level nav links) ===
    document.querySelectorAll('nav a, [role="navigation"] a, .navbar a, .nav-item a, .nav-link').forEach(el => {
        const href = el.getAttribute('href');
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!text) return;
        addElement(el, 'nav-link', {
            href: href ? href.substring(0, 200) : '',
            label: text.substring(0, 80)
        });
    });
    
    return elements;
}
"""


class BrowserAutomation:
    """
    Manages a persistent browser session for multi-step automation tasks.
    Uses sync Playwright in a separate thread to avoid event loop issues.
    Includes visible cursor tracking and comprehensive element detection.
    """
    
    def __init__(self):
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.playwright = None
    
    # ─── CURSOR HELPERS ──────────────────────────────────────────────
    
    def _inject_cursor(self):
        """Injects the visible cursor overlay into the current page."""
        if self.page is None:
            return
        try:
            self.page.evaluate(CURSOR_INJECTION_JS)
        except Exception:
            pass  # Non-critical, don't break automation
    
    def _resolve_selector(self, selector: str) -> str:
        """
        Resolves a selector that might be plain text into a proper Playwright selector.
        If selector doesn't look like a CSS/Playwright selector, treat it as text matching.
        """
        # Already a proper selector
        if selector.startswith('#') or selector.startswith('.') or selector.startswith('['):
            return selector
        if selector.startswith('//') or selector.startswith('xpath='):
            return selector
        if ':has-text(' in selector or 'text=' in selector or ':nth' in selector:
            return selector
        if selector.startswith('button') or selector.startswith('input') or selector.startswith('a'):
            return selector
        # It's plain text — convert to a text-based locator
        # Use exact match first, then partial
        return f'text="{selector}"'
    
    def _move_cursor_to_element(self, selector: str):
        """
        Moves the mouse cursor smoothly to the center of an element.
        Adds slight random offset and delay for human-like behavior.
        """
        if self.page is None:
            return
        try:
            resolved = self._resolve_selector(selector)
            element = self.page.locator(resolved).first
            box = element.bounding_box()
            if not box:
                return
            
            # Target center with small random offset
            target_x = box['x'] + box['width'] / 2 + random.uniform(-3, 3)
            target_y = box['y'] + box['height'] / 2 + random.uniform(-3, 3)
            
            # Move in steps for human-like motion
            self.page.mouse.move(target_x, target_y, steps=random.randint(5, 12))
            
            # Small delay after moving
            self.page.wait_for_timeout(random.randint(50, 150))
        except Exception:
            pass  # Non-critical
    
    def _human_delay(self, min_ms=80, max_ms=250):
        """Adds a small human-like delay."""
        if self.page:
            self.page.wait_for_timeout(random.randint(min_ms, max_ms))
    
    # ─── OPEN BROWSER ────────────────────────────────────────────────
    
    def _sync_open_browser(self, url: str) -> str:
        """Sync implementation of open_browser - runs in thread pool."""
        try:
            print(f"[EDITH Browser] Starting browser for URL: {url}")
            
            # Close any existing browser session first
            if self.browser is not None:
                try:
                    self.browser.close()
                except:
                    pass
                self.browser = None
                self.page = None
                self.context = None
            
            if self.playwright is not None:
                try:
                    self.playwright.stop()
                except:
                    pass
                self.playwright = None
            
            # Start fresh Playwright instance
            print("[EDITH Browser] Starting Playwright...")
            self.playwright = sync_playwright().start()
            
            print("[EDITH Browser] Launching Chromium...")
            self.browser = self.playwright.chromium.launch(
                headless=False,
                args=[
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                ]
            )
            
            print("[EDITH Browser] Creating context (maximized)...")
            self.context = self.browser.new_context(
                no_viewport=True,  # Allows --start-maximized to work properly
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            
            # Remove webdriver flag to reduce bot detection
            self.context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            """)
            
            print("[EDITH Browser] Creating page...")
            self.page = self.context.new_page()
            
            print(f"[EDITH Browser] Navigating to: {url}")
            self.page.goto(url, wait_until='domcontentloaded', timeout=30000)
            
            # Wait for page to settle
            self.page.wait_for_timeout(2000)
            
            # Inject visible cursor
            self._inject_cursor()
            
            title = self.page.title()
            current_url = self.page.url
            
            print(f"[EDITH Browser] Success! Title: {title}")
            return (
                f"Browser opened successfully!\n"
                f"URL: {current_url}\nTitle: {title}\n\n"
                f"Visible cursor is active on the page.\n"
                f"Use 'get_page_elements' to discover ALL interactive elements "
                f"(form fields, links, nav menus, dropdowns, tabs, etc.)."
            )
            
        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            print(f"[EDITH Browser] ERROR: {type(e).__name__}: {str(e)}")
            print(f"[EDITH Browser] TRACEBACK:\n{error_details}")
            return f"Failed to open browser: {type(e).__name__}: {str(e)}"
    
    async def open_browser(self, url: str) -> str:
        """Opens browser and navigates to the specified URL."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_open_browser, url)
    
    # ─── GET PAGE ELEMENTS (COMPREHENSIVE) ───────────────────────────
    
    def _sync_get_page_elements(self) -> str:
        """Sync implementation of get_page_elements - detects ALL interactive elements."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            # Re-inject cursor in case of page navigation
            self._inject_cursor()
            
            elements = self.page.evaluate(GET_ALL_ELEMENTS_JS)
            
            if not elements:
                text_content = self.page.evaluate('document.body.innerText')
                return f"No interactive elements found on this page.\n\nPage content preview:\n{text_content[:1000]}..."
            
            # Format output GROUPED by category for easy LLM parsing
            categories = {
                'nav': {'title': '🧭 NAVIGATION MENU ITEMS', 'items': []},
                'hover': {'title': '📂 HOVER DROPDOWN MENUS (hover to reveal sub-items)', 'items': []},
                'form': {'title': '📝 FORM FIELDS', 'items': []},
                'button': {'title': '🔘 BUTTONS', 'items': []},
                'link': {'title': '🔗 OTHER LINKS', 'items': []},
                'dropdown': {'title': '📋 DROPDOWNS', 'items': []},
                'tab': {'title': '📑 TABS', 'items': []},
                'other': {'title': '📦 OTHER INTERACTIVE ELEMENTS', 'items': []},
            }
            
            form_types = {'text', 'email', 'number', 'tel', 'password', 'textarea', 'search', 'url', 'date'}
            
            for el in elements:
                el_type = el.get('type', 'unknown')
                label = el.get('label', 'No label')
                selector = el.get('selector', '')
                
                entry = f"  \"{label}\""
                if el.get('href'):
                    entry += f"  →  {el['href']}"
                entry += f"\n    selector: {selector}"
                if el.get('options'):
                    entry += f"\n    options: {', '.join(el['options'][:6])}"
                if el.get('required'):
                    entry += " [required]"
                if el.get('value'):
                    entry += f"  (current: {el['value']})"
                
                if el_type == 'nav-link':
                    categories['nav']['items'].append(entry)
                elif el_type in ('hover-dropdown',):
                    categories['hover']['items'].append(entry)
                elif el_type in form_types:
                    categories['form']['items'].append(entry)
                elif el_type == 'button':
                    categories['button']['items'].append(entry)
                elif el_type in ('dropdown', 'custom-dropdown'):
                    categories['dropdown']['items'].append(entry)
                elif el_type == 'tab':
                    categories['tab']['items'].append(entry)
                elif el_type == 'link':
                    categories['link']['items'].append(entry)
                else:
                    categories['other']['items'].append(entry)
            
            output = f"Page: {self.page.title()} ({self.page.url})\n"
            output += f"Found {len(elements)} interactive elements:\n\n"
            
            for cat in categories.values():
                if cat['items']:
                    output += f"{'='*50}\n{cat['title']}\n{'='*50}\n"
                    for item in cat['items']:
                        output += item + "\n"
                    output += "\n"
            
            output += (
                "─── HOW TO INTERACT ───\n"
                "• To hover on a menu: hover_element(selector=\"Menu Text\")\n"
                "• To click any item: click_element(selector=\"Item Text\") or use CSS selector\n"
                "• For navigation menus with dropdowns: HOVER first, then click the sub-item\n"
                "• ALWAYS use the EXACT text the user mentioned to find the right element!\n"
            )
            
            return output
            
        except Exception as e:
            return f"Error getting page elements: {str(e)}"
    
    async def get_page_elements(self) -> str:
        """Gets all interactive elements on the current page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_get_page_elements)
    
    # ─── FILL INPUT ──────────────────────────────────────────────────
    
    def _sync_fill_input(self, selector: str, value: str) -> str:
        """Sync implementation of fill_input."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            # Move cursor to element first (visible + anti-bot)
            self._move_cursor_to_element(selector)
            self._human_delay()
            
            # Handle different selector types
            if selector.startswith('[aria-label='):
                element = self.page.locator(selector)
            elif selector.startswith('button:has-text') or selector.startswith('[role='):
                element = self.page.locator(selector)
            else:
                element = self.page.locator(selector).first
            
            # Wait for element and interact
            element.wait_for(state='visible', timeout=5000)
            element.click()
            self._human_delay(30, 80)
            element.fill(value)
            
            return f"Filled field '{selector}' with: {value}"
            
        except Exception as e:
            # Try alternate approach for Google Forms
            try:
                self.page.click(f'text="{selector.replace("[aria-label=", "").replace("]", "").replace(chr(34), "")}"')
                self.page.keyboard.type(value, delay=random.randint(30, 80))
                return f"Filled field with: {value} (alternate method)"
            except:
                return f"Could not fill field '{selector}': {str(e)}"
    
    async def fill_input(self, selector: str, value: str) -> str:
        """Fills a text input field with the specified value."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_fill_input, selector, value)
    
    # ─── CLICK ELEMENT ───────────────────────────────────────────────
    
    def _sync_click_element(self, selector: str) -> str:
        """Sync implementation of click_element."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            resolved = self._resolve_selector(selector)
            
            # Move cursor to element first
            self._move_cursor_to_element(resolved)
            self._human_delay()
            
            # Get the element
            element = self.page.locator(resolved).first
            
            element.wait_for(state='visible', timeout=5000)
            element.click()
            
            # Wait for any navigation or updates
            self.page.wait_for_timeout(1500)
            
            # Re-inject cursor in case page changed
            self._inject_cursor()
            
            new_url = self.page.url
            title = self.page.title()
            return (
                f"Clicked element: {selector}\n"
                f"Current URL: {new_url}\n"
                f"Page Title: {title}\n\n"
                f"Use 'get_page_elements' to see what's on this page now."
            )
            
        except Exception as e:
            # Try text-based fallback
            try:
                self.page.click(f'text="{selector}"', timeout=3000)
                self.page.wait_for_timeout(1500)
                self._inject_cursor()
                return f"Clicked element: {selector}\nCurrent URL: {self.page.url}"
            except:
                return f"Could not click '{selector}': {str(e)}"
    
    async def click_element(self, selector: str) -> str:
        """Clicks an element on the current page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_click_element, selector)
    
    # ─── HOVER ELEMENT (NEW) ─────────────────────────────────────────
    
    def _sync_hover_element(self, selector: str) -> str:
        """Hovers over an element to trigger dropdowns, popups, tooltips."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            resolved = self._resolve_selector(selector)
            
            # Move cursor smoothly to element
            self._move_cursor_to_element(resolved)
            
            # Get the element
            element = self.page.locator(resolved).first
            
            element.wait_for(state='visible', timeout=5000)
            element.hover()
            
            # Wait for dropdown/popup to appear (some CSS transitions take time)
            self.page.wait_for_timeout(1200)
            
            # Comprehensive check for dropdown items that appeared after hovering.
            # This checks the hovered element's parent/siblings for CSS-triggered menus,
            # plus global selectors for JS-triggered menus.
            new_elements = self.page.evaluate("""
                (hoveredSelector) => {
                    const items = [];
                    const seen = new Set();
                    
                    function collectItems(container) {
                        if (!container) return;
                        container.querySelectorAll('a, button, [role="menuitem"], li > a').forEach(child => {
                            const rect = child.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) return;
                            
                            const text = (child.innerText || child.textContent || '').trim();
                            if (!text || text.length > 100 || seen.has(text)) return;
                            seen.add(text);
                            
                            let href = child.getAttribute('href') || '';
                            let selector = '';
                            if (child.id) selector = '#' + child.id;
                            else if (href && href !== '#' && !href.startsWith('javascript:'))
                                selector = 'a[href="' + href + '"]';
                            else selector = 'text="' + text.substring(0, 50) + '"';
                            
                            items.push({ text: text, selector: selector, href: href });
                        });
                    }
                    
                    // 1. Check the hovered element's parent for sub-menus
                    try {
                        let hovered = document.querySelector(hoveredSelector);
                        if (hovered) {
                            // Check parent li/div for nested ul/div menus
                            let parent = hovered.closest('li') || hovered.parentElement;
                            if (parent) {
                                // Look for sub-menus within the parent
                                parent.querySelectorAll('ul, .dropdown-menu, .sub-menu, .submenu, .mega-menu, [class*="dropdown"], [class*="submenu"], div > a').forEach(sub => {
                                    collectItems(sub);
                                });
                                // Direct children links
                                collectItems(parent);
                            }
                        }
                    } catch(e) {}
                    
                    // 2. Also check global dropdown containers that became visible
                    document.querySelectorAll(
                        '[role="menu"], .dropdown-menu, .show, .visible, .open, ' +
                        '[style*="display: block"], [role="listbox"], .submenu, ' +
                        '.dropdown-content, .mega-menu, [class*="dropdown"][class*="show"], ' +
                        'ul.sub-menu, .nav-dropdown, [aria-expanded="true"] ~ *, ' +
                        '[aria-expanded="true"] + *'
                    ).forEach(el => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            collectItems(el);
                        }
                    });
                    
                    return items;
                }
            """, resolved)
            
            result = f"Hovered over: {selector}\n"
            if new_elements:
                result += f"\nDropdown revealed {len(new_elements)} items:\n"
                for item in new_elements:
                    result += f"  - \"{item['text']}\"\n"
                    result += f"    Click with: click_element(selector=\"{item['selector']}\")\n"
                    if item.get('href') and item['href'] != '#':
                        result += f"    URL: {item['href']}\n"
                result += "\nUse click_element with the selector shown above to click any item."
            else:
                # Fallback: try to get any newly visible content near the element
                result += "No dropdown/popup detected via standard methods.\n"
                result += "Try: click_element on the element instead, or use get_page_elements to see current state."
            
            return result
            
        except Exception as e:
            return f"Could not hover over '{selector}': {str(e)}"
    
    async def hover_element(self, selector: str) -> str:
        """Hovers over an element to trigger dropdowns/popups."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_hover_element, selector)
    
    # ─── SELECT OPTION ───────────────────────────────────────────────
    
    def _sync_select_option(self, selector: str, option_text: str) -> str:
        """Sync implementation of select_option."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            self._move_cursor_to_element(selector)
            self._human_delay()
            
            # Try standard select first
            element = self.page.locator(selector).first
            element.select_option(label=option_text)
            return f"Selected option: {option_text}"
        except:
            try:
                # Try clicking the dropdown trigger, then the option
                self.page.locator(selector).first.click()
                self.page.wait_for_timeout(500)
                self.page.click(f'text="{option_text}"')
                return f"Selected option: {option_text} (click method)"
            except Exception as e:
                return f"Could not select '{option_text}': {str(e)}"
    
    async def select_option(self, selector: str, option_text: str) -> str:
        """Selects an option from a dropdown or radio group."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_select_option, selector, option_text)
    
    # ─── NAVIGATE TO (NEW — multi-page) ──────────────────────────────
    
    def _sync_navigate_to(self, url: str) -> str:
        """Navigates to a new URL within the existing browser session."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            print(f"[EDITH Browser] Navigating to: {url}")
            self.page.goto(url, wait_until='domcontentloaded', timeout=30000)
            self.page.wait_for_timeout(2000)
            
            # Re-inject cursor on new page
            self._inject_cursor()
            
            title = self.page.title()
            current_url = self.page.url
            
            return (
                f"Navigated successfully!\n"
                f"URL: {current_url}\nTitle: {title}\n\n"
                f"Use 'get_page_elements' to discover elements on this page."
            )
        except Exception as e:
            return f"Navigation failed: {str(e)}"
    
    async def navigate_to(self, url: str) -> str:
        """Navigates to a new URL within the existing browser session."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_navigate_to, url)
    
    # ─── WAIT FOR ELEMENT (NEW) ──────────────────────────────────────
    
    def _sync_wait_for_element(self, selector: str, timeout: int = 5000) -> str:
        """Waits for an element to appear on the page."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            element = self.page.locator(selector).first
            element.wait_for(state='visible', timeout=timeout)
            
            # Get info about the appeared element
            text = element.inner_text()[:100] if element.inner_text() else ''
            tag = element.evaluate('el => el.tagName')
            
            return (
                f"Element appeared: {selector}\n"
                f"Tag: {tag}\nText: {text}\n\n"
                f"You can now interact with it using click_element, fill_input, etc."
            )
        except Exception as e:
            return f"Element '{selector}' did not appear within {timeout}ms: {str(e)}"
    
    async def wait_for_element(self, selector: str, timeout: int = 5000) -> str:
        """Waits for an element to appear on the page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_wait_for_element, selector, timeout)
    
    # ─── SCROLL PAGE (NEW) ───────────────────────────────────────────
    
    def _sync_scroll_page(self, direction: str = "down") -> str:
        """Scrolls the page in the given direction."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            scroll_map = {
                "down": "window.scrollBy(0, 500)",
                "up": "window.scrollBy(0, -500)",
                "bottom": "window.scrollTo(0, document.body.scrollHeight)",
                "top": "window.scrollTo(0, 0)",
            }
            
            js = scroll_map.get(direction.lower(), scroll_map["down"])
            self.page.evaluate(js)
            self.page.wait_for_timeout(500)
            
            # Re-inject cursor after scroll
            self._inject_cursor()
            
            scroll_y = self.page.evaluate("window.scrollY")
            page_height = self.page.evaluate("document.body.scrollHeight")
            
            return (
                f"Scrolled {direction}.\n"
                f"Current scroll position: {scroll_y}px / {page_height}px total.\n\n"
                f"Use 'get_page_elements' to detect newly visible elements."
            )
        except Exception as e:
            return f"Scroll error: {str(e)}"
    
    async def scroll_page(self, direction: str = "down") -> str:
        """Scrolls the page in a given direction."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_scroll_page, direction)
    
    # ─── TAKE PAGE SCREENSHOT (NEW) ──────────────────────────────────
    
    def _sync_take_page_screenshot(self) -> str:
        """Takes a screenshot of the current browser page."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            screenshot_dir = os.path.join(os.getcwd(), "agent_files")
            os.makedirs(screenshot_dir, exist_ok=True)
            
            filename = f"page_screenshot_{int(time.time())}.png"
            path = os.path.join(screenshot_dir, filename)
            
            self.page.screenshot(path=path)
            
            return (
                f"Screenshot saved: {filename}\n"
                f"URL: {self.page.url}\n"
                f"Title: {self.page.title()}"
            )
        except Exception as e:
            return f"Screenshot error: {str(e)}"
    
    async def take_page_screenshot(self) -> str:
        """Takes a screenshot of the current browser page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_take_page_screenshot)
    
    # ─── SUBMIT FORM ─────────────────────────────────────────────────
    
    def _sync_submit_form(self) -> str:
        """Sync implementation of submit_form."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            # Common submit button patterns
            submit_selectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Submit")',
                'button:has-text("Send")',
                '[role="button"]:has-text("Submit")',
                '[role="button"]:has-text("Next")',
                'div[role="button"]:has-text("Submit")'
            ]
            
            clicked = False
            for sel in submit_selectors:
                try:
                    element = self.page.locator(sel).first
                    if element.is_visible():
                        self._move_cursor_to_element(sel)
                        self._human_delay()
                        element.click()
                        clicked = True
                        break
                except:
                    continue
            
            if not clicked:
                return "Could not find a submit button. Use 'get_page_elements' to find the correct button."
            
            # Wait for page update
            self.page.wait_for_timeout(3000)
            
            # Re-inject cursor
            self._inject_cursor()
            
            # Check for success indicators
            new_url = self.page.url
            title = self.page.title()
            content = self.page.evaluate('document.body.innerText')
            
            success_indicators = ['thank', 'success', 'submitted', 'recorded', 'received', 'confirmation']
            is_success = any(ind in content.lower() for ind in success_indicators)
            
            if is_success:
                return (
                    f"Form submitted successfully!\n"
                    f"New URL: {new_url}\nPage Title: {title}\n\n"
                    f"The form appears to have been submitted based on the confirmation message."
                )
            else:
                return (
                    f"Form submit button was clicked.\n"
                    f"URL: {new_url}\nTitle: {title}\n\n"
                    f"Page content preview:\n{content[:500]}..."
                )
            
        except Exception as e:
            return f"Error submitting form: {str(e)}"
    
    async def submit_form(self) -> str:
        """Submits the current form by clicking a submit button."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_submit_form)
    
    # ─── GET CURRENT STATE ───────────────────────────────────────────
    
    def _sync_get_current_state(self) -> str:
        """Sync implementation of get_current_state."""
        if self.page is None:
            return "No active browser session."
        
        try:
            url = self.page.url
            title = self.page.title()
            scroll_y = self.page.evaluate("window.scrollY")
            page_height = self.page.evaluate("document.body.scrollHeight")
            return (
                f"Current URL: {url}\n"
                f"Title: {title}\n"
                f"Scroll: {scroll_y}px / {page_height}px"
            )
        except:
            return "Browser session exists but state could not be retrieved."
    
    async def get_current_state(self) -> str:
        """Returns the current state of the browser session."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_get_current_state)
    
    # ─── CLOSE BROWSER ───────────────────────────────────────────────
    
    def _sync_close_browser(self) -> str:
        """Sync implementation of close_browser."""
        try:
            if self.browser:
                self.browser.close()
            if self.playwright:
                self.playwright.stop()
            
            self.browser = None
            self.context = None
            self.page = None
            self.playwright = None
            
            return "Browser closed successfully."
        except Exception as e:
            return f"Error closing browser: {str(e)}"
    
    async def close_browser(self) -> str:
        """Closes the browser and cleans up."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_close_browser)


# Global instance for persistent sessions
browser_automation = BrowserAutomation()

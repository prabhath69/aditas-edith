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
            
            # Move cursor (fewer steps = faster)
            self.page.mouse.move(target_x, target_y, steps=random.randint(5, 12))
            
            # Minimal delay
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
            self.page.wait_for_timeout(1000)
            
            # Inject visible cursor
            self._inject_cursor()
            
            title = self.page.title()
            current_url = self.page.url
            
            print(f"[EDITH Browser] Success! Title: {title}")
            return f"Browser opened. URL: {current_url} | Title: {title}"
            
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
            
            output = f"Page: {self.page.title()} | {self.page.url}\n"
            output += f"{len(elements)} elements:\n\n"
            
            for cat in categories.values():
                if cat['items']:
                    # Cap links at 20 to save tokens on link-heavy pages
                    items = cat['items'][:20] if cat['title'].startswith('🔗') else cat['items']
                    output += f"--- {cat['title']} ---\n"
                    for item in items:
                        output += item + "\n"
                    if len(cat['items']) > 20 and cat['title'].startswith('🔗'):
                        output += f"  ... and {len(cat['items']) - 20} more links\n"
                    output += "\n"
            
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
            self.page.wait_for_timeout(800)
            
            # Re-inject cursor in case page changed
            self._inject_cursor()
            
            new_url = self.page.url
            title = self.page.title()
            return f"Clicked: {selector} | URL: {new_url} | Title: {title}"
            
        except Exception as e:
            # Try text-based fallback
            try:
                self.page.click(f'text="{selector}"', timeout=3000)
                self.page.wait_for_timeout(800)
                self._inject_cursor()
                return f"Clicked: {selector} | URL: {self.page.url}"
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
            
            # Wait for dropdown/popup to appear
            self.page.wait_for_timeout(300)
            
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
            
            result = f"Hovered: {selector}\n"
            if new_elements:
                result += f"Dropdown: {len(new_elements)} items:\n"
                for item in new_elements:
                    result += f"  - \"{item['text']}\" → {item['selector']}\n"
            else:
                result += "No dropdown detected. Try click_element or get_page_elements."
            
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
            self.page.wait_for_timeout(1000)
            
            # Re-inject cursor on new page
            self._inject_cursor()
            
            title = self.page.title()
            current_url = self.page.url
            
            return f"Navigated to: {current_url} | Title: {title}"
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
            
            return f"Element found: {selector} ({tag}) - {text}"
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
            
            return f"Scrolled {direction}. Position: {scroll_y}px / {page_height}px"
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
            self.page.wait_for_timeout(1500)
            
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
    
    # ═══════════════════════════════════════════════════════════════════
    # NEW BROWSEROS-LEVEL TOOLS
    # ═══════════════════════════════════════════════════════════════════
    
    # ─── EXTRACT TEXT (Content Extraction) ────────────────────────────
    
    def _sync_extract_text(self) -> str:
        """Extracts visible text content from the current page."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            # Get page metadata
            title = self.page.title()
            url = self.page.url
            
            # Extract main content text, cleaned
            text = self.page.evaluate("""
                () => {
                    // Try to get main content area first
                    const main = document.querySelector('main, article, [role="main"], .content, #content');
                    const target = main || document.body;
                    
                    // Remove script, style, nav, footer, header noise
                    const clone = target.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript, nav, footer, header, .nav, .footer, .header, [role="navigation"]').forEach(el => el.remove());
                    
                    return clone.innerText;
                }
            """)
            
            # Clean whitespace
            cleaned = re.sub(r'\n{3,}', '\n\n', text).strip()
            
            # Truncate to save tokens (3000 chars ≈ 750 tokens)
            if len(cleaned) > 3000:
                cleaned = cleaned[:3000] + "\n... [truncated, use scroll_page('down') for more]"
            
            return f"Page: {title} | {url}\n{cleaned}"
            
        except Exception as e:
            return f"Error extracting text: {str(e)}"
    
    async def extract_text(self) -> str:
        """Extracts visible text content from the current page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_extract_text)
    
    # ─── EXTRACT STRUCTURED DATA ─────────────────────────────────────
    
    def _sync_extract_structured_data(self, data_type: str = "auto") -> str:
        """Extracts structured data (tables, lists, headings) from the page as JSON."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            import json as json_mod
            
            result = self.page.evaluate("""
                (dataType) => {
                    const data = {};
                    
                    // Extract tables
                    if (dataType === 'auto' || dataType === 'tables') {
                        const tables = [];
                        document.querySelectorAll('table').forEach((table, idx) => {
                            const rows = [];
                            const headers = [];
                            table.querySelectorAll('thead th, thead td').forEach(th => {
                                headers.push(th.innerText.trim());
                            });
                            table.querySelectorAll('tbody tr, tr').forEach(tr => {
                                const cells = [];
                                tr.querySelectorAll('td, th').forEach(td => {
                                    cells.push(td.innerText.trim());
                                });
                                if (cells.length > 0) rows.push(cells);
                            });
                            if (rows.length > 0) {
                                tables.push({ headers: headers, rows: rows.slice(0, 50) });
                            }
                        });
                        if (tables.length > 0) data.tables = tables;
                    }
                    
                    // Extract lists
                    if (dataType === 'auto' || dataType === 'lists') {
                        const lists = [];
                        document.querySelectorAll('ul, ol').forEach(list => {
                            const items = [];
                            list.querySelectorAll(':scope > li').forEach(li => {
                                const text = li.innerText.trim();
                                if (text && text.length < 300) items.push(text);
                            });
                            if (items.length > 1 && items.length < 100) lists.push(items);
                        });
                        if (lists.length > 0) data.lists = lists.slice(0, 10);
                    }
                    
                    // Extract headings structure
                    if (dataType === 'auto' || dataType === 'headings') {
                        const headings = [];
                        document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
                            const text = h.innerText.trim();
                            if (text) headings.push({ level: parseInt(h.tagName[1]), text: text });
                        });
                        if (headings.length > 0) data.headings = headings;
                    }
                    
                    // Extract links
                    if (dataType === 'links') {
                        const links = [];
                        document.querySelectorAll('a[href]').forEach(a => {
                            const text = a.innerText.trim();
                            const href = a.getAttribute('href');
                            if (text && href && !href.startsWith('javascript:') && href !== '#') {
                                links.push({ text: text.substring(0, 100), url: href.substring(0, 300) });
                            }
                        });
                        data.links = links.slice(0, 50);
                    }
                    
                    return data;
                }
            """, data_type)
            
            if not result or all(len(v) == 0 for v in result.values()):
                return "No structured data found on this page. Try extract_text() for plain text content."
            
            json_output = json_mod.dumps(result, indent=2, ensure_ascii=False)
            if len(json_output) > 3000:
                json_output = json_output[:3000] + "\n... [JSON truncated]"
            return f"Data from {self.page.url}:\n{json_output}"
            
        except Exception as e:
            return f"Error extracting structured data: {str(e)}"
    
    async def extract_structured_data(self, data_type: str = "auto") -> str:
        """Extracts structured data from the page."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_extract_structured_data, data_type)
    
    # ─── TYPE TEXT (Keyboard Input) ──────────────────────────────────
    
    def _sync_type_text(self, text: str, selector: str = None) -> str:
        """Types text character-by-character with human-like delays."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            if selector:
                resolved = self._resolve_selector(selector)
                self._move_cursor_to_element(resolved)
                self._human_delay()
                element = self.page.locator(resolved).first
                element.wait_for(state='visible', timeout=5000)
                element.click()
                self._human_delay(50, 120)
            
            # Type with human-like delays
            self.page.keyboard.type(text, delay=random.randint(30, 80))
            
            target = f" into '{selector}'" if selector else " (focused element)"
            return f"Typed: \"{text}\"{target}"
            
        except Exception as e:
            return f"Error typing text: {str(e)}"
    
    async def type_text(self, text: str, selector: str = None) -> str:
        """Types text character-by-character with human-like delays."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_type_text, text, selector)
    
    # ─── PRESS KEY ───────────────────────────────────────────────────
    
    def _sync_press_key(self, key: str, modifiers: str = None) -> str:
        """Presses a keyboard key or key combination."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            # Build key combo string like "Control+A" or just "Enter"
            if modifiers:
                key_combo = f"{modifiers}+{key}"
            else:
                key_combo = key
            
            self.page.keyboard.press(key_combo)
            self._human_delay(100, 300)
            
            # Wait a bit for any navigation triggered by keypress
            self.page.wait_for_timeout(500)
            
            return (
                f"Pressed key: {key_combo}\n"
                f"Current URL: {self.page.url}\n"
                f"Page Title: {self.page.title()}"
            )
            
        except Exception as e:
            return f"Error pressing key '{key}': {str(e)}"
    
    async def press_key(self, key: str, modifiers: str = None) -> str:
        """Presses a keyboard key or combination."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_press_key, key, modifiers)
    
    # ─── GO BACK / GO FORWARD ────────────────────────────────────────
    
    def _sync_go_back(self) -> str:
        """Navigates back in browser history."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            self.page.go_back(wait_until='domcontentloaded', timeout=15000)
            self.page.wait_for_timeout(1500)
            self._inject_cursor()
            
            return (
                f"Navigated back.\n"
                f"URL: {self.page.url}\n"
                f"Title: {self.page.title()}\n\n"
                f"Use 'get_page_elements' or 'extract_text' to see current page."
            )
        except Exception as e:
            return f"Error going back: {str(e)}"
    
    async def go_back(self) -> str:
        """Navigates back in browser history."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_go_back)
    
    def _sync_go_forward(self) -> str:
        """Navigates forward in browser history."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            self.page.go_forward(wait_until='domcontentloaded', timeout=15000)
            self.page.wait_for_timeout(1500)
            self._inject_cursor()
            
            return (
                f"Navigated forward.\n"
                f"URL: {self.page.url}\n"
                f"Title: {self.page.title()}"
            )
        except Exception as e:
            return f"Error going forward: {str(e)}"
    
    async def go_forward(self) -> str:
        """Navigates forward in browser history."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_go_forward)
    
    # ─── GET PAGE INFO ───────────────────────────────────────────────
    
    def _sync_get_page_info(self) -> str:
        """Gets current page URL, title, and tab count."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            url = self.page.url
            title = self.page.title()
            tab_count = len(self.context.pages) if self.context else 1
            scroll_y = self.page.evaluate("window.scrollY")
            page_height = self.page.evaluate("document.body.scrollHeight")
            viewport_height = self.page.evaluate("window.innerHeight")
            
            return (
                f"🔗 URL: {url}\n"
                f"📄 Title: {title}\n"
                f"📑 Open Tabs: {tab_count}\n"
                f"📜 Scroll Position: {scroll_y}px / {page_height}px (viewport: {viewport_height}px)\n"
                f"{'📍 At top of page' if scroll_y == 0 else '📍 Scrolled down'}"
            )
        except Exception as e:
            return f"Error getting page info: {str(e)}"
    
    async def get_page_info(self) -> str:
        """Gets current page URL, title, and tab count."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_get_page_info)
    
    # ─── TAB MANAGEMENT ──────────────────────────────────────────────
    
    def _sync_open_new_tab(self, url: str) -> str:
        """Opens a URL in a new tab."""
        if self.context is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            new_page = self.context.new_page()
            new_page.goto(url, wait_until='domcontentloaded', timeout=30000)
            new_page.wait_for_timeout(2000)
            
            # Switch to the new tab
            self.page = new_page
            self._inject_cursor()
            
            tab_count = len(self.context.pages)
            return (
                f"Opened new tab (Tab #{tab_count}).\n"
                f"URL: {new_page.url}\n"
                f"Title: {new_page.title()}\n"
                f"Total tabs open: {tab_count}\n\n"
                f"Use switch_tab(index) to switch between tabs (0-indexed)."
            )
        except Exception as e:
            return f"Error opening new tab: {str(e)}"
    
    async def open_new_tab(self, url: str) -> str:
        """Opens a URL in a new tab."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_open_new_tab, url)
    
    def _sync_switch_tab(self, index: int) -> str:
        """Switches to a tab by index."""
        if self.context is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            pages = self.context.pages
            if index < 0 or index >= len(pages):
                return f"Invalid tab index {index}. Open tabs: {len(pages)} (use 0 to {len(pages)-1})."
            
            self.page = pages[index]
            self.page.bring_to_front()
            self._inject_cursor()
            
            return (
                f"Switched to Tab #{index + 1}.\n"
                f"URL: {self.page.url}\n"
                f"Title: {self.page.title()}\n"
                f"Total tabs: {len(pages)}"
            )
        except Exception as e:
            return f"Error switching tab: {str(e)}"
    
    async def switch_tab(self, index: int) -> str:
        """Switches to a tab by index."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_switch_tab, index)
    
    def _sync_close_tab(self) -> str:
        """Closes the current tab and switches to the previous one."""
        if self.context is None:
            return "No browser session active."
        
        try:
            pages = self.context.pages
            if len(pages) <= 1:
                return "Cannot close the last tab. Use 'close_browser' instead."
            
            current_url = self.page.url
            self.page.close()
            
            # Switch to the last remaining tab
            remaining = self.context.pages
            self.page = remaining[-1]
            self.page.bring_to_front()
            self._inject_cursor()
            
            return (
                f"Closed tab ({current_url}).\n"
                f"Switched to: {self.page.url}\n"
                f"Remaining tabs: {len(remaining)}"
            )
        except Exception as e:
            return f"Error closing tab: {str(e)}"
    
    async def close_tab(self) -> str:
        """Closes the current tab."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_close_tab)
    
    # ─── EXECUTE JAVASCRIPT ──────────────────────────────────────────
    
    def _sync_execute_javascript(self, code: str) -> str:
        """Executes arbitrary JavaScript on the page."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            result = self.page.evaluate(code)
            
            import json as json_mod
            if result is None:
                return "JavaScript executed successfully (no return value)."
            
            try:
                formatted = json_mod.dumps(result, indent=2, ensure_ascii=False)
            except (TypeError, ValueError):
                formatted = str(result)
            
            # Truncate long results
            if len(formatted) > 3000:
                formatted = formatted[:3000] + "\n... [result truncated]"
            
            return f"JavaScript result:\n{formatted}"
            
        except Exception as e:
            return f"JavaScript error: {str(e)}"
    
    async def execute_javascript(self, code: str) -> str:
        """Executes JavaScript on the page and returns the result."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_execute_javascript, code)
    
    # ─── DRAG AND DROP ───────────────────────────────────────────────
    
    def _sync_drag_and_drop(self, source_selector: str, target_selector: str) -> str:
        """Drags an element and drops it on another element."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            source = self._resolve_selector(source_selector)
            target = self._resolve_selector(target_selector)
            
            source_el = self.page.locator(source).first
            target_el = self.page.locator(target).first
            
            source_el.drag_to(target_el)
            self._human_delay(200, 500)
            
            return f"Dragged '{source_selector}' to '{target_selector}'."
            
        except Exception as e:
            return f"Error with drag and drop: {str(e)}"
    
    async def drag_and_drop(self, source_selector: str, target_selector: str) -> str:
        """Drags an element to a target."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_drag_and_drop, source_selector, target_selector)
    
    # ─── UPLOAD FILE ─────────────────────────────────────────────────
    
    def _sync_upload_file(self, selector: str, file_path: str) -> str:
        """Handles file upload via <input type='file'>."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            resolved = self._resolve_selector(selector)
            element = self.page.locator(resolved).first
            
            # Resolve file path
            full_path = file_path
            if not os.path.isabs(file_path):
                full_path = os.path.join(os.getcwd(), "agent_files", file_path)
            
            if not os.path.exists(full_path):
                return f"File not found: {full_path}"
            
            element.set_input_files(full_path)
            self._human_delay(200, 400)
            
            return f"Uploaded file: {os.path.basename(full_path)} to '{selector}'"
            
        except Exception as e:
            return f"Error uploading file: {str(e)}"
    
    async def upload_file(self, selector: str, file_path: str) -> str:
        """Uploads a file to a file input element."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_upload_file, selector, file_path)
    
    # ─── WAIT FOR NAVIGATION ─────────────────────────────────────────
    
    def _sync_wait_for_navigation(self, timeout: int = 10000) -> str:
        """Waits for the page URL to change (navigation event)."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            old_url = self.page.url
            self.page.wait_for_url(f"**", timeout=timeout)
            self.page.wait_for_timeout(1000)
            self._inject_cursor()
            
            new_url = self.page.url
            title = self.page.title()
            
            navigated = old_url != new_url
            return (
                f"{'Navigation detected!' if navigated else 'Page loaded (same URL).'}\n"
                f"URL: {new_url}\n"
                f"Title: {title}\n"
                f"{'Previous: ' + old_url if navigated else ''}"
            )
        except Exception as e:
            return f"Navigation wait timed out ({timeout}ms): {str(e)}"
    
    async def wait_for_navigation(self, timeout: int = 10000) -> str:
        """Waits for page navigation to complete."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_wait_for_navigation, timeout)
    
    # ─── SCROLL TO ELEMENT ───────────────────────────────────────────
    
    def _sync_scroll_to_element(self, selector: str) -> str:
        """Scrolls the page until a specific element is visible."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            resolved = self._resolve_selector(selector)
            element = self.page.locator(resolved).first
            element.scroll_into_view_if_needed(timeout=5000)
            self._human_delay(200, 400)
            self._inject_cursor()
            
            text = ""
            try:
                text = element.inner_text()[:80]
            except:
                pass
            
            return (
                f"Scrolled to element: {selector}\n"
                f"Element text: {text}\n"
                f"Element is now visible on screen."
            )
        except Exception as e:
            return f"Error scrolling to element '{selector}': {str(e)}"
    
    async def scroll_to_element(self, selector: str) -> str:
        """Scrolls to make a specific element visible."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_scroll_to_element, selector)
    
    # ─── IFRAME HANDLING ─────────────────────────────────────────────
    
    def _sync_switch_to_frame(self, selector: str) -> str:
        """Switches context into an iframe."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            resolved = self._resolve_selector(selector)
            frame_element = self.page.locator(resolved).first
            frame = frame_element.content_frame()
            
            if frame is None:
                return f"Element '{selector}' is not an iframe or frame not accessible."
            
            # Store the main page reference
            if not hasattr(self, '_main_page'):
                self._main_page = self.page
            
            # Switch to frame's page-like interface
            self._frame = frame
            
            return (
                f"Switched to iframe: {selector}\n"
                f"Frame URL: {frame.url}\n\n"
                f"You can now interact with elements inside the iframe.\n"
                f"Use 'switch_to_main' to go back to the main page."
            )
        except Exception as e:
            return f"Error switching to iframe: {str(e)}"
    
    async def switch_to_frame(self, selector: str) -> str:
        """Switches into an iframe."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_switch_to_frame, selector)
    
    def _sync_switch_to_main(self) -> str:
        """Switches back to the main page from an iframe."""
        if not hasattr(self, '_main_page') or self._main_page is None:
            return "Already on the main page."
        
        try:
            self._frame = None
            return (
                f"Switched back to main page.\n"
                f"URL: {self.page.url}\n"
                f"Title: {self.page.title()}"
            )
        except Exception as e:
            return f"Error switching to main page: {str(e)}"
    
    async def switch_to_main(self) -> str:
        """Switches back to the main page from an iframe."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_switch_to_main)
    
    # ─── HANDLE DIALOG (Alert/Confirm/Prompt) ────────────────────────
    
    def _sync_handle_dialog(self, action: str = "accept", prompt_text: str = None) -> str:
        """Sets up a handler for browser dialogs (alert, confirm, prompt)."""
        if self.page is None:
            return "No browser session active. Use 'open_browser' first."
        
        try:
            dialog_info = {"handled": False, "message": "", "type": ""}
            
            def on_dialog(dialog):
                dialog_info["message"] = dialog.message
                dialog_info["type"] = dialog.type
                dialog_info["handled"] = True
                if action == "accept":
                    if prompt_text and dialog.type == "prompt":
                        dialog.accept(prompt_text)
                    else:
                        dialog.accept()
                else:
                    dialog.dismiss()
            
            self.page.on("dialog", on_dialog)
            
            return (
                f"Dialog handler set to '{action}'.\n"
                f"The next browser dialog (alert/confirm/prompt) will be automatically {action}ed."
                + (f"\nPrompt text: {prompt_text}" if prompt_text else "")
            )
            
        except Exception as e:
            return f"Error setting dialog handler: {str(e)}"
    
    async def handle_dialog(self, action: str = "accept", prompt_text: str = None) -> str:
        """Sets up a handler for browser dialogs."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_handle_dialog, action, prompt_text)
    
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
            self._main_page = None
            self._frame = None
            
            return "Browser closed successfully."
        except Exception as e:
            return f"Error closing browser: {str(e)}"
    
    async def close_browser(self) -> str:
        """Closes the browser and cleans up."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._sync_close_browser)


# Global instance for persistent sessions
browser_automation = BrowserAutomation()

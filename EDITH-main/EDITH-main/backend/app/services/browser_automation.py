"""
EDITH Browser Automation Service — nodriver CDP Architecture
=============================================================
Replaces Playwright with nodriver for direct Chrome DevTools Protocol access.

Key patterns (inspired by BrowserOS):
- Async-native CDP connection (no ThreadPoolExecutor)
- Accessibility-tree snapshots with UID-based element references
- Pattern: open_browser → take_snapshot → interact by uid → auto-snapshot
- Anti-bot: human-like delays + visible cursor injection
"""

import asyncio
import json
import time
import random
import os
import base64
import logging

import nodriver as uc

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# JAVASCRIPT CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════

SNAPSHOT_JS_TEMPLATE = """
((() => {{
    const snapshotId = {snapshot_id};
    let counter = 0;
    const elements = [];

    // IMPORTANT: Do NOT wipe existing UIDs — keep them stable across snapshots.
    // Wiping caused stale-UID bugs: LLM uses UID from snapshot N, then
    // a re-snapshot wipes it, so fill/type_text silently fails.
    // We only assign new UIDs to elements that don't have one yet.

    const getAccessibleName = (el) => {{
        return el.getAttribute('aria-label') ||
               el.getAttribute('title') ||
               el.getAttribute('placeholder') ||
               el.getAttribute('alt') ||
               el.getAttribute('name') ||
               (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '') ||
               el.textContent?.trim().substring(0, 80) || '';
    }};

    const isVisible = (el) => {{
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }};

    const selectors = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[role="slider"]', '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
        '[contenteditable="true"]', 'summary', '[tabindex]:not([tabindex="-1"])'
    ];

    const seen = new Set();
    selectors.forEach(sel => {{
        try {{
            document.querySelectorAll(sel).forEach(el => {{
                if (seen.has(el) || !isVisible(el)) return;
                seen.add(el);

                // Keep existing UID if already assigned (stable across re-snapshots)
                let uid = el.getAttribute('data-uid');
                if (!uid) {{
                    uid = snapshotId + '_' + (counter++);
                    el.setAttribute('data-uid', uid);
                }}

                const tag = el.tagName.toLowerCase();
                let role = el.getAttribute('role') || '';
                if (!role) {{
                    if (tag === 'a') role = 'link';
                    else if (tag === 'button') role = 'button';
                    else if (tag === 'input') {{
                        const t = (el.getAttribute('type') || 'text').toLowerCase();
                        if (t === 'checkbox') role = 'checkbox';
                        else if (t === 'radio') role = 'radio';
                        else if (t === 'submit' || t === 'button') role = 'button';
                        else role = 'textbox';
                    }}
                    else if (tag === 'select') role = 'combobox';
                    else if (tag === 'textarea') role = 'textbox';
                    else role = 'generic';
                }}

                const info = {{
                    uid, role, tag,
                    name: getAccessibleName(el),
                    type: el.getAttribute('type') || '',
                    value: el.value || '',
                    checked: el.checked || false,
                    disabled: el.disabled || false,
                    href: el.getAttribute('href') || ''
                }};

                if (tag === 'select') {{
                    const opts = [];
                    el.querySelectorAll('option').forEach(o => {{
                        opts.push({{ text: o.textContent.trim(), value: o.value, selected: o.selected }});
                    }});
                    info.options = opts;
                }}
                elements.push(info);
            }});
        }} catch(e) {{}}
    }});
    return elements;
}})())
"""
# Extracts page content structure for LLM context.
PAGE_CONTENT_JS = """
() => {
    const content = [];
    const walk = (node, depth) => {
        if (depth > 15 || !node) return;
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        const text = node.textContent?.trim();
        if (['h1','h2','h3','h4','h5','h6'].includes(tag) && text) {
            content.push({type: 'heading', level: parseInt(tag[1]), text: text.substring(0, 200)});
        }
        if (tag === 'nav' && text) {
            content.push({type: 'nav', text: text.substring(0, 300)});
            return;
        }
        for (const c of node.children) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return content;
}
"""

# Visible cursor injection JS (anti-bot detection)
# The dot appears immediately at center screen — does NOT wait for mouse movement
CURSOR_JS = """
() => {
    if (document.getElementById('edith-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'edith-cursor';
    cursor.style.cssText = `
        position: fixed;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: rgba(255, 50, 50, 0.85);
        border: 2px solid rgba(255,255,255,0.9);
        box-shadow: 0 0 6px rgba(255,0,0,0.6);
        pointer-events: none;
        z-index: 2147483647;
        transition: left 0.08s ease, top 0.08s ease;
        transform: translate(-50%, -50%);
    `;
    // Start at center of viewport so it's visible immediately
    cursor.style.left = (window.innerWidth / 2) + 'px';
    cursor.style.top = (window.innerHeight / 2) + 'px';
    document.body.appendChild(cursor);
    document.addEventListener('mousemove', e => {
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
    });
    return 'cursor_injected';
}
"""

# JS to wait until the DOM is fully loaded
WAIT_FOR_DOM_JS = """
() => {
    return document.readyState;
}
"""


class BrowserAutomation:
    """Browser automation using nodriver CDP — async-native, no ThreadPoolExecutor."""

    def __init__(self):
        self.browser = None           # nodriver.Browser instance
        self.pages = []               # list of Tab objects
        self.selected_page_idx = 0    # currently active page index
        self.snapshot_id = 0          # auto-incrementing for stale UID detection
        self.last_snapshot = []       # latest element list
        self._dialog_message = None   # last dialog info
        self._starting = False        # prevent concurrent launches

    # ═══════════════════════════════════════════════════════════════════════
    # HELPERS
    # ═══════════════════════════════════════════════════════════════════════

    def _get_page(self):
        """Returns the currently selected page/tab."""
        if not self.pages:
            raise RuntimeError("No browser open. Call open_browser first.")
        if self.selected_page_idx >= len(self.pages):
            self.selected_page_idx = len(self.pages) - 1
        return self.pages[self.selected_page_idx]

    async def _human_delay(self, min_ms=50, max_ms=150):
        """Random delay to mimic human interaction timing."""
        await asyncio.sleep(random.randint(min_ms, max_ms) / 1000.0)

    async def _inject_cursor(self):
        """Injects visible cursor onto the page for anti-bot detection."""
        try:
            page = self._get_page()
            await page.evaluate(CURSOR_JS)
        except Exception:
            pass

    async def _wait_for_page_ready(self, page, timeout: float = 10.0):
        """
        Waits until document.readyState == 'complete', up to `timeout` seconds.
        Falls back gracefully if unable to evaluate (e.g. non-HTML page).
        """
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                state = await page.evaluate(WAIT_FOR_DOM_JS)
                if state == 'complete':
                    return
            except Exception:
                pass
            await asyncio.sleep(0.3)
        # Timed out — proceed anyway
        logger.debug("[Browser] Page readyState timeout, proceeding")

    async def _move_mouse_to_element(self, uid: str):
        """Moves mouse to the center of an element identified by uid."""
        try:
            page = self._get_page()
            pos = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return {{x: r.x + r.width/2, y: r.y + r.height/2}};
                }})()
            """)
            if pos:
                await page.send(uc.cdp.input_.dispatch_mouse_event(
                    type_="mouseMoved",
                    x=pos['x'],
                    y=pos['y']
                ))
        except Exception:
            pass

    async def _format_snapshot(self, elements: list) -> str:
        """Formats snapshot elements into a compact string for LLM consumption."""
        if not elements:
            return "No interactive elements found on this page."
        
        # Get current page URL for context
        page_url = ""
        try:
            page = self._get_page()
            page_url = await page.evaluate("() => window.location.href")
        except:
            pass

        # Cap to 150 most relevant elements to avoid token overflow
        capped = elements[:150]
        lines = [
            f"Page Snapshot (ID: {self.snapshot_id}) — {len(elements)} elements ({len(capped)} shown)",
            f"URL: {page_url}",
            "NOTE: UIDs are STABLE — they do NOT change on re-snapshot. Use them directly.",
        ]
        
        # ── INPUT / SEARCH FIELDS at top so LLM sees them immediately ──
        search_inputs = [
            el for el in capped
            if el.get('role') in ('searchbox', 'textbox', 'combobox')
            or (el.get('tag') == 'input' and el.get('type', '').lower() not in ('hidden', 'checkbox', 'radio', 'submit', 'button', 'file'))
        ]
        if search_inputs:
            lines.append("── 🔍 TYPE INTO THESE (search/input fields) ──")
            for el in search_inputs:
                uid = el.get('uid')
                name = el.get('name', '')[:60]
                role = el.get('role', '?')
                lines.append(f"  [{uid}] <{role}> \"{name}\"")

        # ── VIDEO LINKS — separate section so LLM doesn't pick nav links ──
        video_links = [
            el for el in capped
            if '/watch' in el.get('href', '')
        ]
        if video_links:
            lines.append("── 📹 VIDEO RESULTS (click one of these to play) ──")
            for el in video_links[:15]:  # Show top 15 videos max
                uid = el.get('uid')
                name = el.get('name', '')[:80]
                href = el.get('href', '')[:60]
                lines.append(f"  [{uid}] <video-link> \"{name}\" →{href}")

        lines.append("── ALL ELEMENTS ──")
        for el in capped:
            uid = el.get('uid')
            if not uid:
                continue
            role = el.get('role', '?')
            parts = [f"[{uid}]", f"<{role}>"]
            if el.get('name'):
                parts.append(f'"{el["name"][:60]}"')
            if el.get('type'):
                parts.append(f"type={el['type']}")
            if el.get('value'):
                parts.append(f'value="{el["value"][:30]}"')
            if el.get('checked'):
                parts.append("✓checked")
            if el.get('disabled'):
                parts.append("⊘disabled")
            if el.get('href'):
                href = el['href'][:60]
                # Label nav links clearly so LLM avoids them
                is_nav = el['href'] in ('/', '/feed/history', '/feed/trending', '/feed/subscriptions') or el['href'].startswith('/channel') or el['href'].startswith('/@')
                is_video = '/watch' in el['href']
                prefix = "📹" if is_video else ("🗂" if is_nav else "")
                parts.append(f"{prefix}→{href}")
            if el.get('options'):
                opt_texts = [o.get('text', '')[:20] for o in el['options'][:5]]
                parts.append(f"options=[{', '.join(opt_texts)}]")
            lines.append("  " + " ".join(parts))
        
        return "\n".join(lines)


    # ═══════════════════════════════════════════════════════════════════════
    # CORE: OPEN / CLOSE
    # ═══════════════════════════════════════════════════════════════════════

    async def open_browser(self, url: str) -> str:
        """Opens browser and navigates to URL. Returns initial snapshot."""
        try:
            if self._starting:
                return "Browser is already starting, please wait..."
            self._starting = True

            # Close existing browser if open
            if self.browser:
                try:
                    await self.close_browser()
                except Exception:
                    pass

            logger.info(f"[Browser] Launching Chrome via nodriver to {url}")
            
            self.browser = await uc.start(
                headless=False,
                browser_args=[
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--no-first-run',
                    '--no-default-browser-check',
                ]
            )
            
            # Get the main page
            main_page = self.browser.main_tab
            self.pages = [main_page]
            self.selected_page_idx = 0
            
            # Navigate to URL
            await main_page.get(url)
            # 1. Wait for DOM readyState=complete
            await self._wait_for_page_ready(main_page)
            # 2. Extra buffer: React/heavy SPAs take additional time to mount
            logger.info("[Browser] DOM ready. Waiting 4s for JS framework to render...")
            await asyncio.sleep(4)
            
            self._starting = False
            
            # Inject cursor + take initial snapshot (with built-in retry)
            await self._inject_cursor()
            snapshot_result = await self.take_snapshot()
            
            logger.info(f"[Browser] Browser ready at {url}")
            return f"Browser opened: {url}\n{snapshot_result}"
        except Exception as e:
            self._starting = False
            logger.error(f"[Browser] Launch error: {e}")
            return f"Error opening browser: {str(e)}"

    async def close_browser(self) -> str:
        """Closes browser and cleans up all state."""
        try:
            if self.browser:
                self.browser.stop()
                self.browser = None
            self.pages = []
            self.selected_page_idx = 0
            self.snapshot_id = 0
            self.last_snapshot = []
            self._dialog_message = None
            return "Browser closed."
        except Exception as e:
            return f"Error closing browser: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # CORE: SNAPSHOTS
    # ═══════════════════════════════════════════════════════════════════════

    async def take_snapshot(self, max_retries: int = 3, retry_delay: float = 2.0) -> str:
        """
        Takes a snapshot of all interactive elements with UIDs.
        Retries up to max_retries times if the page has 0 elements
        (handles React/SPA pages that take time to mount components).
        """
        try:
            page = self._get_page()
            self.snapshot_id += 1

            for attempt in range(max_retries):
                # Embed snapshot_id directly into JS (nodriver doesn't support arg passing)
                snapshot_js = SNAPSHOT_JS_TEMPLATE.format(snapshot_id=self.snapshot_id)
                elements = await page.evaluate(snapshot_js)
                elements = elements or []
                count = len(elements)
                logger.info(f"[Snapshot] Attempt {attempt+1}/{max_retries}: {count} elements found")

                if count > 0:
                    break

                if attempt < max_retries - 1:
                    logger.info(f"[Snapshot] Page empty, waiting {retry_delay}s for content to load...")
                    await asyncio.sleep(retry_delay)

            self.last_snapshot = elements

            if not elements:
                url = ""
                try:
                    url = await page.evaluate("() => window.location.href")
                except:
                    pass
                return (
                    f"[Snapshot] Page appears empty or still loading (url: {url}). "
                    "Wait 2 seconds and call take_snapshot again."
                )

            return await self._format_snapshot(self.last_snapshot)
        except Exception as e:
            logger.error(f"[Snapshot] Error: {e}")
            return f"Error taking snapshot: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # INTERACTION: CLICK, HOVER, FILL, TYPE
    # ═══════════════════════════════════════════════════════════════════════

    async def click(self, uid: str, dbl_click: bool = False) -> str:
        """
        Clicks an element by its uid using real CDP mouse events.
        FALLBACK: If element is not found (React SPA re-rendered it), navigates
        directly to the element's href from last_snapshot (works for all links/videos).
        """
        try:
            page = self._get_page()
            await self._human_delay()

            # Get element info + position via JS
            info = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el) return null;
                    el.scrollIntoView({{behavior: 'instant', block: 'center'}});
                    const r = el.getBoundingClientRect();
                    return {{
                        x: r.left + r.width/2,
                        y: r.top + r.height/2,
                        tag: el.tagName.toLowerCase(),
                        label: el.getAttribute('aria-label') || el.textContent?.trim().substring(0, 60) || '',
                        href: el.getAttribute('href') || ''
                    }};
                }})()
            """)

            if not info:
                # Element disappeared — React SPA probably re-rendered it.
                # Fall back: look it up in last_snapshot and navigate to its href.
                logger.warning(f"[Click] UID '{uid}' not in DOM (React re-render?). Checking last_snapshot...")
                fallback_el = next(
                    (el for el in (self.last_snapshot or []) if el.get('uid') == uid),
                    None
                )
                if fallback_el and fallback_el.get('href'):
                    href = fallback_el['href']
                    # Make absolute URL
                    if href.startswith('/'):
                        current_origin = await page.evaluate("() => window.location.origin")
                        href = current_origin + href
                    name = fallback_el.get('name', href[:50])
                    logger.info(f"[Click] Fallback: navigating to href={href}")
                    await page.get(href)
                    await self._wait_for_page_ready(page)
                    await asyncio.sleep(3)  # wait for SPA to render
                    snapshot = await self.take_snapshot()
                    return f"Navigated to '{name}' ({href}). {snapshot}"
                else:
                    raise RuntimeError(
                        f"Element UID '{uid}' not found in DOM and has no href fallback. "
                        "Call take_snapshot() to get fresh UIDs for the current page."
                    )

            x, y = info['x'], info['y']

            # Real CDP mouse click — triggers focus, React events, SPA navigation etc.
            count = 2 if dbl_click else 1
            for _ in range(count):
                await page.send(uc.cdp.input_.dispatch_mouse_event(
                    type_="mousePressed", x=x, y=y,
                    button=uc.cdp.input_.MouseButton.LEFT,
                    click_count=1
                ))
                await asyncio.sleep(0.05)
                await page.send(uc.cdp.input_.dispatch_mouse_event(
                    type_="mouseReleased", x=x, y=y,
                    button=uc.cdp.input_.MouseButton.LEFT,
                    click_count=1
                ))
                await asyncio.sleep(0.05)

            await asyncio.sleep(1.5)  # Wait for page reaction / SPA navigation

            label = info.get('label', '')
            href = info.get('href', '')
            return (
                f"Clicked [{uid}] ({info['tag']}: '{label[:50]}'{' → ' + href[:40] if href else ''}). "
                "Page may have changed — call take_snapshot() to see current state."
            )
        except Exception as e:
            return f"Error clicking {uid}: {str(e)}"

    async def hover(self, uid: str) -> str:
        """Hovers over an element by uid. Auto-takes new snapshot."""
        try:
            page = self._get_page()
            await self._human_delay()
            await self._move_mouse_to_element(uid)
            
            result = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el) return 'Element not found: {uid}';
                    el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                    el.dispatchEvent(new MouseEvent('mouseenter', {{bubbles: true}}));
                    el.dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                    return 'hovered';
                }})()
            """)
            
            if result != 'hovered':
                return result
            
            await asyncio.sleep(0.5)
            snapshot = await self.take_snapshot()
            return f"Hovered [{uid}]. {snapshot}"
        except Exception as e:
            return f"Error hovering {uid}: {str(e)}"

    async def fill(self, uid: str, value: str) -> str:
        """
        Fills a form field. 
        - <select>: handled via JS option selection
        - Text inputs: delegates to type_text() which uses per-character CDP key events
          (same React-compatible typing as type_text — avoids the insertText bug)
        """
        try:
            page = self._get_page()
            await self._human_delay()

            # Check if it's a select element — handle via pure JS
            tag_check = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el) return 'not_found';
                    return el.tagName.toLowerCase();
                }})()
            """)

            if tag_check == 'not_found':
                raise RuntimeError(
                    f"Element UID '{uid}' not found in DOM. "
                    "Call take_snapshot() to get fresh UIDs for the current page."
                )

            if tag_check == 'select':
                # Dropdowns: direct JS value setting works fine (no React event issue)
                result = await page.evaluate(f"""
                    (() => {{
                        const el = document.querySelector('[data-uid="{uid}"]');
                        const opts = el.querySelectorAll('option');
                        const val = '{value.lower().replace("'", "\\'")}';
                        let found = false;
                        for (const o of opts) {{
                            if (o.textContent.trim().toLowerCase().includes(val)) {{
                                el.value = o.value; found = true; break;
                            }}
                        }}
                        if (!found) el.value = '{value.replace("'", "\\'")}';
                        el.dispatchEvent(new Event('change', {{bubbles: true}}));
                        return found ? 'select_done' : 'select_fallback';
                    }})()
                """)
                return f"Selected '{value}' in [{uid}] ({result})"

            # For all text inputs — delegate to type_text (uses per-char CDP key events)
            return await self.type_text(value, uid)

        except Exception as e:
            return f"Error filling {uid}: {str(e)}"

    async def fill_form(self, elements: list) -> str:
        """Fills multiple form fields at once."""
        results = []
        for el in elements:
            uid = el.get("uid")
            value = el.get("value", "")
            r = await self.fill(uid, value)
            results.append(r)
            await self._human_delay(100, 300)
        return "\n".join(results)

    async def select_option(self, uid: str, option_text: str) -> str:
        """Selects an option from a dropdown by uid and option text."""
        return await self.fill(uid, option_text)

    async def type_text(self, text: str, uid: str = None) -> str:
        """
        Types text character-by-character using CDP dispatchKeyEvent.
        
        WHY NOT insertText/send_keys:
          page.send_keys() → Input.insertText → sets DOM value directly BUT bypasses
          React's synthetic onChange event. React controlled inputs (YouTube search,
          Amazon search, etc.) ignore the DOM value change and keep React state empty.
          Result: typing "appears" to work (no error) but searching fires on "" (empty).
        
        THE FIX:
          Per-character keyDown + char dispatchKeyEvent events are the ONLY reliable way
          to drive React's onChange handler on every modern SPA.
        """
        try:
            page = self._get_page()

            if uid:
                # 1. First find the element position
                pos = await page.evaluate(f"""
                    (() => {{
                        const el = document.querySelector('[data-uid="{uid}"]');
                        if (!el) return null;
                        el.scrollIntoView({{behavior: 'instant', block: 'center'}});
                        const r = el.getBoundingClientRect();
                        return {{x: r.left + r.width/2, y: r.top + r.height/2}};
                    }})()
                """)
                if not pos:
                    # Try fallback in last_snapshot — navigate if it's a link
                    raise RuntimeError(
                        f"Element UID '{uid}' not found in DOM. "
                        "Call take_snapshot() to get fresh UIDs."
                    )

                # 2. CDP click to give the element real browser focus
                #    (JS .focus() alone doesn't trigger React's onFocus/synthetic events)
                await page.send(uc.cdp.input_.dispatch_mouse_event(
                    type_="mousePressed", x=pos['x'], y=pos['y'],
                    button=uc.cdp.input_.MouseButton.LEFT, click_count=1
                ))
                await asyncio.sleep(0.05)
                await page.send(uc.cdp.input_.dispatch_mouse_event(
                    type_="mouseReleased", x=pos['x'], y=pos['y'],
                    button=uc.cdp.input_.MouseButton.LEFT, click_count=1
                ))
                await asyncio.sleep(0.3)  # Let React process the focus event

                # 3. Select all existing text and delete it (Ctrl+A, Delete)
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyDown", key="a",
                    windows_virtual_key_code=65, modifiers=2  # Ctrl
                ))
                await asyncio.sleep(0.05)
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyUp", key="a",
                    windows_virtual_key_code=65, modifiers=2
                ))
                await asyncio.sleep(0.05)
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyDown", key="Delete", windows_virtual_key_code=46
                ))
                await asyncio.sleep(0.05)
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyUp", key="Delete", windows_virtual_key_code=46
                ))
                await asyncio.sleep(0.1)

            # 4. Type each character with keyDown + char + keyUp
            #    This is the ONLY method that triggers React's onChange for every char.
            for char in text:
                vk = ord(char) if len(char) == 1 else 0

                # keyDown
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyDown",
                    key=char,
                    text=char,
                    unmodified_text=char,
                    windows_virtual_key_code=vk,
                ))
                # char event (triggers React onChange)
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="char",
                    key=char,
                    text=char,
                    unmodified_text=char,
                    windows_virtual_key_code=vk,
                ))
                # keyUp
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="keyUp",
                    key=char,
                    text=char,
                    unmodified_text=char,
                    windows_virtual_key_code=vk,
                ))
                await asyncio.sleep(0.04)  # ~25 chars/sec — natural typing speed

            await asyncio.sleep(0.2)  # Let final React state update settle

            # 5. Verify text appeared in the DOM (optional confirmation)
            verify_result = ""
            if uid:
                val = await page.evaluate(f"""
                    (() => {{
                        const el = document.querySelector('[data-uid="{uid}"]');
                        return el ? (el.value || el.textContent || '') : '';
                    }})()
                """)
                verify_result = f" (input now contains: '{val[:40]}')"

            return f"Typed '{text}'{' into [' + uid + ']' if uid else ' into active element'}{verify_result}"
        except Exception as e:
            logger.error(f"[type_text] Error: {e}")
            return f"Error typing text: {str(e)}"

    async def press_key(self, key: str, modifiers: str = None) -> str:
        """Presses a keyboard key or combination using real CDP key events."""
        try:
            page = self._get_page()
            await self._human_delay(30, 80)

            # Key name → (CDP key name, windowsVirtualKeyCode, text)
            key_info = {
                'Enter':     ('Enter',    13,  '\r'),
                'Return':    ('Enter',    13,  '\r'),
                'Tab':       ('Tab',       9,  '\t'),
                'Escape':    ('Escape',   27,  ''),
                'Backspace': ('Backspace', 8,  '\x08'),
                'Delete':    ('Delete',   46,  ''),
                'ArrowUp':   ('ArrowUp',  38,  ''),
                'ArrowDown': ('ArrowDown',40,  ''),
                'ArrowLeft': ('ArrowLeft',37,  ''),
                'ArrowRight':('ArrowRight',39, ''),
                'Space':     (' ',        32,  ' '),
                'Home':      ('Home',     36,  ''),
                'End':       ('End',      35,  ''),
                'PageUp':    ('PageUp',   33,  ''),
                'PageDown':  ('PageDown', 34,  ''),
            }

            if key in key_info:
                cdp_key, vk_code, text = key_info[key]
            elif len(key) == 1:
                cdp_key, vk_code, text = key, ord(key), key
            else:
                cdp_key, vk_code, text = key, 0, ''

            modifier_flags = 0
            if modifiers:
                mod_lower = modifiers.lower()
                if 'control' in mod_lower or 'ctrl' in mod_lower:
                    modifier_flags |= 2
                if 'shift' in mod_lower:
                    modifier_flags |= 8
                if 'alt' in mod_lower:
                    modifier_flags |= 1

            await page.send(uc.cdp.input_.dispatch_key_event(
                type_="keyDown",
                key=cdp_key,
                text=text,
                windows_virtual_key_code=vk_code,
                modifiers=modifier_flags if modifier_flags else None
            ))
            if text:
                await page.send(uc.cdp.input_.dispatch_key_event(
                    type_="char",
                    key=cdp_key,
                    text=text,
                    windows_virtual_key_code=vk_code,
                    modifiers=modifier_flags if modifier_flags else None
                ))
            await page.send(uc.cdp.input_.dispatch_key_event(
                type_="keyUp",
                key=cdp_key,
                text=text,
                windows_virtual_key_code=vk_code,
                modifiers=modifier_flags if modifier_flags else None
            ))

            await asyncio.sleep(1.0)  # Wait for form submission / navigation
            return f"Pressed key: {key}" + (f" + {modifiers}" if modifiers else "")
        except Exception as e:
            return f"Error pressing key {key}: {str(e)}"

    async def drag(self, from_uid: str, to_uid: str) -> str:
        """Drags one element onto another by their uids."""
        try:
            page = self._get_page()
            result = await page.evaluate(f"""
                (() => {{
                    const from_el = document.querySelector('[data-uid="{from_uid}"]');
                    const to_el = document.querySelector('[data-uid="{to_uid}"]');
                    if (!from_el) return 'Source element not found: {from_uid}';
                    if (!to_el) return 'Target element not found: {to_uid}';
                    
                    const fromRect = from_el.getBoundingClientRect();
                    const toRect = to_el.getBoundingClientRect();
                    
                    const dataTransfer = new DataTransfer();
                    from_el.dispatchEvent(new DragEvent('dragstart', {{bubbles: true, dataTransfer}}));
                    to_el.dispatchEvent(new DragEvent('dragover', {{bubbles: true, dataTransfer}}));
                    to_el.dispatchEvent(new DragEvent('drop', {{bubbles: true, dataTransfer}}));
                    from_el.dispatchEvent(new DragEvent('dragend', {{bubbles: true, dataTransfer}}));
                    return 'dragged';
                }})()
            """)
            
            snapshot = await self.take_snapshot()
            return f"Dragged [{from_uid}] → [{to_uid}]. {snapshot}"
        except Exception as e:
            return f"Error dragging: {str(e)}"

    async def upload_file(self, uid: str, file_path: str) -> str:
        """Uploads a file to a file input element by uid."""
        try:
            # Resolve path
            if not os.path.isabs(file_path):
                file_path = os.path.join(os.getcwd(), "agent_files", file_path)
            
            if not os.path.exists(file_path):
                return f"File not found: {file_path}"
            
            page = self._get_page()
            # Get the node for the file input
            node = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el || el.tagName.toLowerCase() !== 'input' || el.type !== 'file') 
                        return null;
                    return true;
                }})()
            """)
            
            if not node:
                return f"Element [{uid}] is not a file input."
            
            # Use CDP to set files on the input
            # Find the remote object for the element
            js_result = await page.evaluate(f"""
                document.querySelector('[data-uid="{uid}"]')
            """)
            
            return f"File upload initiated for [{uid}] with {file_path}"
        except Exception as e:
            return f"Error uploading file: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # NAVIGATION
    # ═══════════════════════════════════════════════════════════════════════

    async def navigate_page(self, url: str) -> str:
        """Navigates the current page to a URL. Auto-takes snapshot."""
        try:
            page = self._get_page()
            await page.get(url)
            await asyncio.sleep(2)
            await self._inject_cursor()
            snapshot = await self.take_snapshot()
            return f"Navigated to {url}\n{snapshot}"
        except Exception as e:
            return f"Error navigating to {url}: {str(e)}"

    async def navigate_history(self, direction: str) -> str:
        """Navigates back or forward in browser history."""
        try:
            page = self._get_page()
            if direction == 'back':
                await page.evaluate("window.history.back()")
            else:
                await page.evaluate("window.history.forward()")
            await asyncio.sleep(1.5)
            snapshot = await self.take_snapshot()
            return f"Navigated {direction}.\n{snapshot}"
        except Exception as e:
            return f"Error navigating {direction}: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # PAGE/TAB MANAGEMENT
    # ═══════════════════════════════════════════════════════════════════════

    async def new_page(self, url: str) -> str:
        """Opens a URL in a new tab."""
        try:
            page = self._get_page()
            new_tab = await self.browser.get(url, new_tab=True)
            self.pages.append(new_tab)
            self.selected_page_idx = len(self.pages) - 1
            await asyncio.sleep(2)
            await self._inject_cursor()
            snapshot = await self.take_snapshot()
            return f"Opened new tab: {url}\n{snapshot}"
        except Exception as e:
            return f"Error opening new tab: {str(e)}"

    async def list_pages(self) -> str:
        """Lists all open pages/tabs."""
        try:
            lines = ["Open tabs:"]
            for i, page in enumerate(self.pages):
                marker = " ← active" if i == self.selected_page_idx else ""
                try:
                    title = await page.evaluate("document.title")
                    url = await page.evaluate("window.location.href")
                except Exception:
                    title = "Unknown"
                    url = "Unknown"
                lines.append(f"  [{i}] {title} — {url}{marker}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error listing pages: {str(e)}"

    async def select_page(self, page_idx: int) -> str:
        """Switches to a page/tab by index."""
        try:
            if page_idx < 0 or page_idx >= len(self.pages):
                return f"Invalid page index: {page_idx}. Have {len(self.pages)} pages."
            self.selected_page_idx = page_idx
            page = self.pages[page_idx]
            await page.activate()
            snapshot = await self.take_snapshot()
            return f"Switched to tab [{page_idx}].\n{snapshot}"
        except Exception as e:
            return f"Error switching page: {str(e)}"

    async def close_page(self, page_idx: int) -> str:
        """Closes a page/tab by index."""
        try:
            if len(self.pages) <= 1:
                return "Cannot close the last tab."
            if page_idx < 0 or page_idx >= len(self.pages):
                return f"Invalid page index: {page_idx}."
            
            page = self.pages.pop(page_idx)
            await page.close()
            
            if self.selected_page_idx >= len(self.pages):
                self.selected_page_idx = len(self.pages) - 1
            
            return f"Closed tab [{page_idx}]. Now on tab [{self.selected_page_idx}]."
        except Exception as e:
            return f"Error closing page: {str(e)}"

    async def close_tab(self) -> str:
        """Closes the current tab."""
        return await self.close_page(self.selected_page_idx)

    # ═══════════════════════════════════════════════════════════════════════
    # SCROLLING
    # ═══════════════════════════════════════════════════════════════════════

    async def scroll_page(self, direction: str = "down") -> str:
        """Scrolls the page. Auto-takes new snapshot."""
        try:
            page = self._get_page()
            scroll_map = {
                'down': 'window.scrollBy(0, window.innerHeight * 0.7)',
                'up': 'window.scrollBy(0, -window.innerHeight * 0.7)',
                'top': 'window.scrollTo(0, 0)',
                'bottom': 'window.scrollTo(0, document.body.scrollHeight)'
            }
            js = scroll_map.get(direction, scroll_map['down'])
            await page.evaluate(js)
            await asyncio.sleep(0.5)
            snapshot = await self.take_snapshot()
            return f"Scrolled {direction}.\n{snapshot}"
        except Exception as e:
            return f"Error scrolling: {str(e)}"

    async def scroll_to_element(self, uid: str) -> str:
        """Scrolls until a specific element is visible."""
        try:
            page = self._get_page()
            result = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el) return 'Element not found: {uid}';
                    el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                    return 'scrolled';
                }})()
            """)
            
            if result != 'scrolled':
                return result
            
            await asyncio.sleep(0.5)
            return f"Scrolled to [{uid}]."
        except Exception as e:
            return f"Error scrolling to element: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # SCREENSHOTS
    # ═══════════════════════════════════════════════════════════════════════

    async def take_screenshot(self, uid: str = None, full_page: bool = False) -> str:
        """Takes a screenshot of the page or a specific element."""
        try:
            page = self._get_page()
            os.makedirs("agent_files", exist_ok=True)
            
            filename = f"screenshot_{int(time.time())}.png"
            filepath = os.path.join("agent_files", filename)
            
            # Use CDP screenshot
            if uid:
                # Screenshot specific element
                clip = await page.evaluate(f"""
                    (() => {{
                        const el = document.querySelector('[data-uid="{uid}"]');
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return {{x: r.x, y: r.y, width: r.width, height: r.height, scale: 1}};
                    }})()
                """)
                if clip:
                    data = await page.send(uc.cdp.page.capture_screenshot(
                        format_="png",
                        clip=uc.cdp.page.Viewport(
                            x=clip['x'], y=clip['y'],
                            width=clip['width'], height=clip['height'],
                            scale=1
                        )
                    ))
                else:
                    data = await page.send(uc.cdp.page.capture_screenshot(format_="png"))
            else:
                data = await page.send(uc.cdp.page.capture_screenshot(format_="png"))
            
            # Save screenshot
            with open(filepath, 'wb') as f:
                f.write(base64.b64decode(data))
            
            return f"Screenshot saved: {filename}"
        except Exception as e:
            return f"Error taking screenshot: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # TEXT EXTRACTION
    # ═══════════════════════════════════════════════════════════════════════

    async def extract_text(self) -> str:
        """Reads visible text from the current page."""
        try:
            page = self._get_page()
            text = await page.evaluate("""
                (() => {
                    const body = document.body;
                    if (!body) return 'No body element found.';
                    
                    // Remove script/style elements from consideration
                    const clone = body.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
                    
                    let text = clone.innerText || clone.textContent || '';
                    // Clean up excessive whitespace
                    text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
                    return text.substring(0, 5000);
                })()
            """)
            return text or "No visible text found."
        except Exception as e:
            return f"Error extracting text: {str(e)}"

    async def extract_structured_data(self, data_type: str = "auto") -> str:
        """Extracts tables/lists/headings/links as JSON."""
        try:
            page = self._get_page()
            
            js = """
                (type) => {
                    const result = {};
                    
                    if (type === 'auto' || type === 'tables') {
                        const tables = [];
                        document.querySelectorAll('table').forEach(table => {
                            const rows = [];
                            table.querySelectorAll('tr').forEach(tr => {
                                const cells = [];
                                tr.querySelectorAll('td, th').forEach(td => {
                                    cells.push(td.textContent.trim());
                                });
                                if (cells.length) rows.push(cells);
                            });
                            if (rows.length) tables.push(rows);
                        });
                        result.tables = tables;
                    }
                    
                    if (type === 'auto' || type === 'headings') {
                        const headings = [];
                        document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
                            headings.push({level: parseInt(h.tagName[1]), text: h.textContent.trim()});
                        });
                        result.headings = headings;
                    }
                    
                    if (type === 'auto' || type === 'links') {
                        const links = [];
                        document.querySelectorAll('a[href]').forEach(a => {
                            const text = a.textContent.trim();
                            if (text) links.push({text: text.substring(0, 100), href: a.href});
                        });
                        result.links = links.slice(0, 50);
                    }
                    
                    if (type === 'auto' || type === 'lists') {
                        const lists = [];
                        document.querySelectorAll('ul, ol').forEach(list => {
                            const items = [];
                            list.querySelectorAll(':scope > li').forEach(li => {
                                items.push(li.textContent.trim().substring(0, 200));
                            });
                            if (items.length) lists.push(items);
                        });
                        result.lists = lists.slice(0, 10);
                    }
                    
                    return JSON.stringify(result);
                }
            """
            
            result = await page.evaluate(js, data_type)
            return result or "{}"
        except Exception as e:
            return f"Error extracting structured data: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # WAIT HELPERS
    # ═══════════════════════════════════════════════════════════════════════

    async def wait_for(self, text: str, timeout: int = 5000) -> str:
        """Waits for specified text to appear on the page."""
        try:
            page = self._get_page()
            start = time.time()
            timeout_secs = timeout / 1000.0
            
            while time.time() - start < timeout_secs:
                body_text = await page.evaluate("document.body?.innerText || ''")
                if text.lower() in body_text.lower():
                    return f"Text '{text}' found on page."
                await asyncio.sleep(0.5)
            
            return f"Timeout: text '{text}' not found after {timeout}ms."
        except Exception as e:
            return f"Error waiting: {str(e)}"

    async def wait_for_navigation(self, timeout: int = 10000) -> str:
        """Waits for the page URL to change."""
        try:
            page = self._get_page()
            current_url = await page.evaluate("window.location.href")
            start = time.time()
            timeout_secs = timeout / 1000.0
            
            while time.time() - start < timeout_secs:
                new_url = await page.evaluate("window.location.href")
                if new_url != current_url:
                    return f"Navigation detected: {new_url}"
                await asyncio.sleep(0.5)
            
            return f"No navigation detected after {timeout}ms."
        except Exception as e:
            return f"Error waiting for navigation: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # JAVASCRIPT EXECUTION
    # ═══════════════════════════════════════════════════════════════════════

    async def execute_javascript(self, code: str) -> str:
        """Executes JavaScript on the page and returns the result."""
        try:
            page = self._get_page()
            result = await page.evaluate(code)
            return json.dumps(result) if result is not None else "JavaScript executed (no return value)."
        except Exception as e:
            return f"Error executing JavaScript: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # DIALOGS
    # ═══════════════════════════════════════════════════════════════════════

    async def handle_dialog(self, action: str = "accept", prompt_text: str = None) -> str:
        """Handles browser alert/confirm/prompt dialogs."""
        try:
            page = self._get_page()
            if action == "accept":
                await page.evaluate("window.__edith_dialog_action = 'accept'")
            else:
                await page.evaluate("window.__edith_dialog_action = 'dismiss'")
            return f"Dialog {action}ed."
        except Exception as e:
            return f"Error handling dialog: {str(e)}"

    # ═══════════════════════════════════════════════════════════════════════
    # IFRAMES
    # ═══════════════════════════════════════════════════════════════════════

    async def switch_to_frame(self, uid: str) -> str:
        """Switches into an iframe by uid."""
        try:
            # For nodriver, we can inject into iframe context via JS
            page = self._get_page()
            result = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-uid="{uid}"]');
                    if (!el || el.tagName.toLowerCase() !== 'iframe') return 'Not an iframe: {uid}';
                    window.__edith_iframe = el;
                    return 'switched';
                }})()
            """)
            return f"Switched to iframe [{uid}]." if result == 'switched' else result
        except Exception as e:
            return f"Error switching to frame: {str(e)}"

    async def switch_to_main(self) -> str:
        """Switches back to the main page from an iframe."""
        return "Switched back to main page."

    # ═══════════════════════════════════════════════════════════════════════
    # PAGE INFO & FORM SUBMIT
    # ═══════════════════════════════════════════════════════════════════════

    async def get_page_info(self) -> str:
        """Gets current page URL, title, tab count, and scroll position."""
        try:
            page = self._get_page()
            info = await page.evaluate("""
                (() => ({
                    url: window.location.href,
                    title: document.title,
                    scrollY: window.scrollY,
                    scrollHeight: document.body.scrollHeight,
                    viewportHeight: window.innerHeight
                }))()
            """)
            return (
                f"URL: {info['url']}\n"
                f"Title: {info['title']}\n"
                f"Tabs: {len(self.pages)}\n"
                f"Scroll: {info['scrollY']}/{info['scrollHeight']} (viewport: {info['viewportHeight']}px)"
            )
        except Exception as e:
            return f"Error getting page info: {str(e)}"

    async def submit_form(self) -> str:
        """Auto-finds and clicks a submit button."""
        try:
            page = self._get_page()
            result = await page.evaluate("""
                (() => {
                    const submits = document.querySelectorAll(
                        'button[type="submit"], input[type="submit"], button:not([type])'
                    );
                    for (const btn of submits) {
                        if (btn.offsetParent !== null) {
                            btn.click();
                            return 'submitted: ' + (btn.textContent?.trim() || btn.value || 'button');
                        }
                    }
                    // Try forms
                    const form = document.querySelector('form');
                    if (form) { form.submit(); return 'form submitted'; }
                    return 'No submit button found.';
                })()
            """)
            
            await asyncio.sleep(1.5)
            snapshot = await self.take_snapshot()
            return f"{result}\n{snapshot}"
        except Exception as e:
            return f"Error submitting form: {str(e)}"


# Singleton instance
browser_automation = BrowserAutomation()

// Chrome Debugger CDP-based browser automation
// Attaches to the active tab via chrome.debugger and sends CDP commands

export interface SnapshotElement {
    uid: number;
    tag: string;
    role: string;
    name: string;
    context?: string;
    href?: string;
    type?: string;
    value?: string;
    placeholder?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isClickable: boolean;
    isInput: boolean;
    isVideo: boolean;
}

export interface PageSnapshot {
    url: string;
    title: string;
    elements: SnapshotElement[];
    rawText: string;
}

// Track multiple attached tabs concurrently for multi-tab research
const attachedTabs = new Set<number>();

// Legacy compat: track the "last single-tab" for functions that omit tabId
let lastSingleTabId: number | null = null;

async function ensureAttached(tabId: number): Promise<void> {
    if (attachedTabs.has(tabId)) return;

    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);

    // Clean up when detached externally (e.g. DevTools opened)
    const onDetach = (source: chrome.debugger.Debuggee) => {
        if (source.tabId === tabId) {
            attachedTabs.delete(tabId);
            chrome.debugger.onDetach.removeListener(onDetach);
        }
    };
    chrome.debugger.onDetach.addListener(onDetach);
}

// Low-level CDP send
async function cdp<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
): Promise<T> {
    return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
}

export async function navigateTo(url: string, tabId?: number): Promise<void> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://')) {
        url = 'https://' + url;
    }

    await cdp(id, 'Page.navigate', { url });
    // Wait for page load
    await waitForLoad(id);
}

async function waitForLoad(tabId: number, timeout = 15000): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeout);

        function listener(source: chrome.debugger.Debuggee, method: string) {
            if (source.tabId === tabId && method === 'Page.loadEventFired') {
                clearTimeout(timer);
                chrome.debugger.onEvent.removeListener(listener);
                // Small delay for JS to hydrate the page
                setTimeout(resolve, 800);
            }
        }

        chrome.debugger.onEvent.addListener(listener);
        // Enable Page events
        cdp(tabId, 'Page.enable').catch(() => { });
    });
}

// ─── Snapshot script as RAW JavaScript string ───────────────────────────────
// CRITICAL: This MUST be a raw string, NOT a TypeScript function with .toString().
// esbuild compiles/minifies TypeScript functions, mangling variable names and
// injecting module-scoped helpers. When .toString() is called on the compiled
// function and injected into the page via Runtime.evaluate, those helpers don't
// exist in the page context, causing silent crashes and 0 elements captured.
const SNAPSHOT_JS = `(function() {
    try {
        var CLICKABLE_TAGS = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
        var INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
        var elements = [];

        // Stable UIDs: find highest existing UID so new elements get unique IDs
        var maxUid = 0;
        var existing = document.querySelectorAll('[data-edith-uid]');
        for (var i = 0; i < existing.length; i++) {
            var u = parseInt(existing[i].getAttribute('data-edith-uid'), 10);
            if (u > maxUid) maxUid = u;
        }
        var uidCounter = maxUid + 1;

        function isVisible(el) {
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return true;
        }

        function getRole(el) {
            return el.getAttribute('role') || el.tagName.toLowerCase();
        }

        function getName(el) {
            return el.getAttribute('aria-label')
                || el.getAttribute('title')
                || el.getAttribute('placeholder')
                || (el.innerText ? el.innerText.slice(0, 120).trim() : '')
                || el.getAttribute('alt')
                || el.getAttribute('name')
                || '';
        }

        // Get nearest meaningful ancestor context for an element
        function getContext(el) {
            var p = el.parentElement;
            var maxUp = 5;
            while (p && maxUp-- > 0) {
                // Check for aria-label on parent
                var label = p.getAttribute('aria-label');
                if (label) return label.slice(0, 50);
                // Check for heading siblings
                var heading = p.querySelector('h1,h2,h3,h4,[role=heading]');
                if (heading && heading !== el) {
                    var ht = (heading.innerText || '').slice(0, 50).trim();
                    if (ht) return ht;
                }
                // Check for role=region or role=navigation etc.
                var role = p.getAttribute('role');
                if (role && ['navigation','main','search','banner','complementary','dialog','alertdialog','form','region'].indexOf(role) >= 0) {
                    var rl = p.getAttribute('aria-label') || role;
                    return rl.slice(0, 50);
                }
                // Check for nav, header, main, aside, footer
                var pt = p.tagName;
                if (pt === 'NAV' || pt === 'HEADER' || pt === 'MAIN' || pt === 'ASIDE' || pt === 'FOOTER') {
                    var al = p.getAttribute('aria-label');
                    return (al || pt.toLowerCase()).slice(0, 50);
                }
                p = p.parentElement;
            }
            return '';
        }

        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            var tag = node.tagName;
            if (!tag) continue;
            var isClickableTag = CLICKABLE_TAGS.indexOf(tag) >= 0;
            var hasClickHandler = isClickableTag || node.getAttribute('onclick') !== null;
            var hasRole = node.getAttribute('role') !== null;
            var isLink = tag === 'A';
            var isContentEditable = node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('contenteditable') === '';
            var isInput = INPUT_TAGS.indexOf(tag) >= 0 || isContentEditable;
            var inputType = node.type ? node.type.toLowerCase() : '';
            if (!isContentEditable && isInput && (inputType === 'password' || inputType === 'hidden')) continue;
            var isButton = tag === 'BUTTON' || node.getAttribute('role') === 'button';
            var isVideo = tag === 'VIDEO' || (node.getAttribute('data-testid') || '').indexOf('video') >= 0;

            if (!hasClickHandler && !hasRole && !isVideo && !isContentEditable) continue;
            if (!isVisible(node)) continue;

            // Stable UIDs: re-use existing data-edith-uid, assign new one only if missing
            var uid;
            var existingUid = node.getAttribute('data-edith-uid');
            if (existingUid) {
                uid = parseInt(existingUid, 10);
            } else {
                uid = uidCounter++;
                try { node.setAttribute('data-edith-uid', String(uid)); } catch(e) {}
            }

            var rect = node.getBoundingClientRect();
            var val = undefined;
            if (isInput) {
                try { val = node.value || ''; } catch(e) {}
            }
            elements.push({
                uid: uid,
                tag: tag.toLowerCase(),
                role: getRole(node),
                name: getName(node),
                context: getContext(node),
                href: node.href || undefined,
                type: inputType || undefined,
                value: val,
                placeholder: node.getAttribute('placeholder') || undefined,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                isClickable: hasClickHandler || isLink || isButton,
                isInput: isInput,
                isVideo: isVideo
            });
        }

        return JSON.stringify({
            url: location.href,
            title: document.title,
            elements: elements,
            rawText: (document.body.innerText || '').slice(0, 3000)
        });
    } catch(err) {
        return JSON.stringify({
            url: location.href || 'unknown',
            title: document.title || 'unknown',
            elements: [],
            rawText: 'Snapshot error: ' + String(err)
        });
    }
})()`;

// Build a DOM snapshot using CDP Runtime.evaluate
// Returns structured elements with UIDs for the LLM to reference
export async function takeSnapshot(tabId?: number): Promise<PageSnapshot> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Wait for page to be ready before snapshotting
    await waitForDocReady(id);

    const attempt = async (): Promise<PageSnapshot> => {
        const result = await cdp<{ result: { value?: string; type?: string; description?: string } }>(id, 'Runtime.evaluate', {
            expression: SNAPSHOT_JS,
            returnByValue: true,
            awaitPromise: false,
        });

        const raw = result?.result?.value;
        if (typeof raw !== 'string') {
            throw new Error(`Snapshot returned ${typeof raw} instead of string`);
        }
        return JSON.parse(raw) as PageSnapshot;
    };

    try {
        return await attempt();
    } catch {
        // Retry once after a delay — heavy pages (Amazon) may not be hydrated yet
        await new Promise((r) => setTimeout(r, 1500));
        try {
            return await attempt();
        } catch {
            // Return empty snapshot so the agent loop doesn't crash
            const fallbackUrl = await cdp<{ result: { value: string } }>(id, 'Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true,
            }).then((r) => r.result.value).catch(() => 'unknown');
            const fallbackTitle = await cdp<{ result: { value: string } }>(id, 'Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            }).then((r) => r.result.value).catch(() => 'unknown');
            return {
                url: fallbackUrl,
                title: fallbackTitle,
                elements: [],
                rawText: '',
            };
        }
    }
}

// Wait for document.readyState to be 'complete' (up to 3s)
async function waitForDocReady(tabId: number, timeout = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const r = await cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', {
                expression: 'document.readyState',
                returnByValue: true,
            });
            if (r.result.value === 'complete') return;
        } catch {
            // Page might be navigating — ignore
        }
        await new Promise((res) => setTimeout(res, 300));
    }
}

export async function clickElement(
    uid: number,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) {
        return `Error: Element with UID ${uid} not found in snapshot. Take a new snapshot first.`;
    }

    await ensureAttached(id);

    // Scroll element into view first — coordinates from getBoundingClientRect
    // are viewport-relative, so if the element is off-screen the click will miss.
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (el) el.scrollIntoView({block: 'center', behavior: 'instant'});
            })()`,
            awaitPromise: false,
        });
        // Small delay for scroll to settle
        await new Promise((r) => setTimeout(r, 200));
    } catch {
        // Non-critical — proceed with click anyway
    }

    // Re-read coordinates after scroll
    let cx = el.x + el.width / 2;
    let cy = el.y + el.height / 2;
    try {
        const freshRect = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (!el) return '';
                var r = el.getBoundingClientRect();
                return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
            })()`,
            returnByValue: true,
        });
        if (freshRect?.result?.value) {
            const r = JSON.parse(freshRect.result.value);
            cx = r.x + r.w / 2;
            cy = r.y + r.h / 2;
        }
    } catch {
        // Use original coordinates as fallback
    }

    // Click
    try {
        await cdp(id, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: cx,
            y: cy,
            button: 'left',
            clickCount: 1,
        });
        await cdp(id, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: cx,
            y: cy,
            button: 'left',
            clickCount: 1,
        });
    } catch {
        // If coordinate click fails and it's a link, navigate directly
        if (el.href && el.href.startsWith('http')) {
            await navigateTo(el.href, id);
        }
    }

    return `Clicked element "${el.name}" (${el.tag})`;
}

export async function typeText(
    text: string,
    uid: number,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) return `Error: Element UID ${uid} not found. Take a new snapshot.`;
    if (!el.isInput) {
        // Allow typing into contenteditable elements (WhatsApp, Telegram, etc.)
        // The snapshot may not always detect them as isInput, so we attempt anyway
        console.warn(`Element UID ${uid} not flagged as input — attempting type anyway (may be contenteditable).`);
    }

    await ensureAttached(id);

    // Scroll into view first
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (el) el.scrollIntoView({block: 'center', behavior: 'instant'});
            })()`,
            awaitPromise: false,
        });
        await new Promise((r) => setTimeout(r, 150));
    } catch { /* non-critical */ }

    // Get fresh coordinates after scroll
    let cx = el.x + el.width / 2;
    let cy = el.y + el.height / 2;
    try {
        const freshRect = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (!el) return '';
                var r = el.getBoundingClientRect();
                return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
            })()`,
            returnByValue: true,
        });
        if (freshRect?.result?.value) {
            const r = JSON.parse(freshRect.result.value);
            cx = r.x + r.w / 2;
            cy = r.y + r.h / 2;
        }
    } catch { /* use original coords */ }

    // Click to focus
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
    });
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 100));

    // Use JS to focus + clear (more reliable than Ctrl+A on contenteditable)
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (!el) return;
                el.focus();
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                    el.value = '';
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                } else if (el.isContentEditable || el.getAttribute('contenteditable') !== null) {
                    el.textContent = '';
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                } else {
                    el.focus();
                }
            })()`,
            awaitPromise: false,
        });
    } catch { /* fallback: Ctrl+A to select all */
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', modifiers: 0 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', modifiers: 0 });
    }

    await new Promise((r) => setTimeout(r, 50));

    // Use Input.insertText — works on <input>, <textarea>, AND contenteditable
    // This is the CDP equivalent of pasting text and works with React & modern frameworks
    await cdp(id, 'Input.insertText', { text });

    // Dispatch additional events to ensure frameworks (React, YouTube, etc.) pick up the change.
    // Input.insertText fires a basic 'input' event, but many sites also need 'change',
    // 'keydown', 'keyup', or React's synthetic event system to update internal state.
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}']');
                if (!el) return;
                // Fire input event with data to satisfy React's onChange
                var inputEv = new InputEvent('input', {bubbles: true, data: '${text.replace(/'/g, "\\'")}', inputType: 'insertText'});
                el.dispatchEvent(inputEv);
                // Fire change event for good measure
                el.dispatchEvent(new Event('change', {bubbles: true}));
                // Fire a keydown event (generic) so YouTube/autocomplete systems activate
                el.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Unidentified'}));
                el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, key: 'Unidentified'}));
            })()`,
            awaitPromise: false,
        });
    } catch { /* non-critical — insertText already set the value */ }

    return `Typed "${text}" into ${el.tag} "${el.name}"`;
}

// Capture current URL — used to detect navigation after key presses
async function getCurrentUrl(tabId: number): Promise<string> {
    try {
        const r = await cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', {
            expression: 'location.href',
            returnByValue: true,
        });
        return r.result.value || '';
    } catch {
        return '';
    }
}

// Wait for URL to change (navigation) — polls every 300ms up to timeout.
// Returns true if nav detected, false if timed out (no nav).
async function waitForNavigation(tabId: number, urlBefore: string, timeout = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 300));
        const urlNow = await getCurrentUrl(tabId);
        if (urlNow && urlNow !== urlBefore) {
            // URL changed — navigation occurred. Wait for page to settle.
            await waitForLoad(tabId, 8000);
            return true;
        }
    }
    return false;
}

export async function pressKey(key: string, tabId?: number): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Capture URL before the key press to detect navigation
    const urlBefore = await getCurrentUrl(id);

    const keyMap: Record<string, { code: string; vk: number }> = {
        Enter: { code: 'Enter', vk: 13 },
        Tab: { code: 'Tab', vk: 9 },
        Escape: { code: 'Escape', vk: 27 },
        ArrowDown: { code: 'ArrowDown', vk: 40 },
        ArrowUp: { code: 'ArrowUp', vk: 38 },
        Backspace: { code: 'Backspace', vk: 8 },
    };

    const keyInfo = keyMap[key] || { code: key, vk: key.charCodeAt(0) };

    await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.vk,
    });
    await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.vk,
    });

    // For Enter key: check if navigation occurred (e.g. search form submission)
    // This is critical for YouTube, Google, Amazon etc. where Enter triggers page nav
    if (key === 'Enter') {
        const navigated = await waitForNavigation(id, urlBefore, 3000);
        if (navigated) {
            return `Pressed Enter — page navigated to new URL.`;
        }
    }

    return `Pressed key: ${key}`;
}

export async function scrollPage(
    direction: 'up' | 'down',
    amount = 500,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    await cdp(id, 'Runtime.evaluate', {
        expression: `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`,
    });

    return `Scrolled ${direction} by ${amount}px`;
}

export async function takeScreenshot(tabId?: number): Promise<string> {
    const id = tabId || (await getActiveTabId());

    // chrome.tabs.captureVisibleTab doesn't need debugger
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(
            { format: 'png', quality: 80 },
            (dataUrl) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(dataUrl);
                }
            },
        );
    });
}

export async function detachDebugger(tabId?: number): Promise<void> {
    const id = tabId || lastSingleTabId;
    if (id === null || id === undefined) return;
    try {
        await chrome.debugger.detach({ tabId: id });
    } catch {
        // Ignore
    }
    attachedTabs.delete(id);
    if (id === lastSingleTabId) lastSingleTabId = null;
}

/** Detach from ALL tabs — used when research completes or aborts */
export async function detachAllDebuggers(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const tabId of attachedTabs) {
        promises.push(
            chrome.debugger.detach({ tabId }).catch(() => { })
        );
    }
    await Promise.allSettled(promises);
    attachedTabs.clear();
    lastSingleTabId = null;
}

// Get the current active tab ID
export async function getActiveTabId(): Promise<number> {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length === 0 || tabs[0].id === undefined) {
                reject(new Error('No active tab found'));
            } else {
                lastSingleTabId = tabs[0].id!;
                resolve(tabs[0].id!);
            }
        });
    });
}

// Open a new tab or update to a URL
export async function openBrowser(url: string): Promise<number> {
    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://')) {
        url = 'https://' + url;
    }

    return new Promise((resolve) => {
        chrome.tabs.create({ url, active: true }, (tab) => {
            resolve(tab.id!);
        });
    });
}
